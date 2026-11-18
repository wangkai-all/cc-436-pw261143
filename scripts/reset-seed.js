import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, get, nowIso, run } from '../src/db.js';
import { CATALOG, catalogContract, buildMockPayload } from '../src/catalog.js';
import { normalizeContractFields } from '../src/contracts.js';
import { DEFAULT_POLICY, normalizePolicy } from '../src/policies.js';
import { ingest, createException } from '../src/core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dbPath = process.env.DB_PATH ?? path.join(root, 'data', 'sentinel.db');

if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
for (const suffix of ['-wal', '-shm']) {
  if (fs.existsSync(`${dbPath}${suffix}`)) fs.rmSync(`${dbPath}${suffix}`);
}

const db = openDatabase(dbPath);
const now = nowIso();

function insertSource(catalog, { versionPolicy, policy, contractVersion, fields, status = 'active', compatibility = 'baseline', changelog }) {
  const result = run(
    db,
    `INSERT INTO sources (slug, name, domain, description, owner, version_policy, policy_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [catalog.slug, catalog.name, catalog.domain, catalog.description, catalog.owner, versionPolicy, JSON.stringify(normalizePolicy(policy)), now],
  );
  const sourceId = Number(result.lastInsertRowid);
  const contractResult = run(
    db,
    `INSERT INTO contracts (source_id, version, fields_json, status, compatibility, changelog, proposal_json, created_by, created_at, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sourceId,
      contractVersion,
      JSON.stringify(normalizeContractFields(fields)),
      status,
      compatibility,
      changelog ?? null,
      JSON.stringify({ changes: [], summary: '基线版本' }),
      '初始化',
      now,
      now,
    ],
  );
  run(db, 'UPDATE sources SET current_contract_id = ? WHERE id = ?', [Number(contractResult.lastInsertRowid), sourceId]);
  return sourceId;
}

// 零售订单：基线契约 → 已有一次枚举扩展的兼容升级
const retail = CATALOG.find((s) => s.slug === 'retail-orders');
const retailId = insertSource(retail, {
  versionPolicy: 'additive_compatible',
  policy: DEFAULT_POLICY,
  contractVersion: '1.1.0',
  fields: catalogContract(retail).fields,
  changelog: '初始接入订单中台',
});
{
  // 1.2.0：源端已宣布 returned，候选兼容版本等待批准（不要在初始化时直接生效）
  const fields = catalogContract(retail).fields.map((f) => {
    if (f.name === 'status') return { ...f, enum: [...f.enum, 'returned'] };
    return f;
  });
  run(
    db,
    `INSERT INTO contracts (source_id, version, fields_json, status, compatibility, changelog, proposal_json, based_on, created_by, created_at)
     VALUES (?, '1.2.0', ?, 'proposed', 'forward_compatible', ?, ?, ?, '数据治理组', ?)`,
    [
      retailId,
      JSON.stringify(normalizeContractFields(fields)),
      '支持退货状态 returned；历史批次不受影响',
      JSON.stringify({
        changes: [
          { kind: 'enum', fieldPath: 'status', breaking: false, detail: '枚举扩展：新增 "returned"', from: [...retail.fields.find((f) => f.name === 'status').enum], to: [...retail.fields.find((f) => f.name === 'status').enum, 'returned'] },
        ],
        summary: '1 项前向兼容变化',
      }),
      1,
      now,
    ],
  );
}

const payment = CATALOG.find((s) => s.slug === 'payment-settlements');
const paymentId = insertSource(payment, {
  versionPolicy: 'strict',
  policy: DEFAULT_POLICY,
  contractVersion: '2.0.0',
  fields: catalogContract(payment).fields,
  changelog: '清算合作方接入，费率与金额单位强约束',
});

const iot = CATALOG.find((s) => s.slug === 'iot-telemetry');
const iotId = insertSource(iot, {
  versionPolicy: 'pinned',
  policy: DEFAULT_POLICY,
  contractVersion: '3.1.4',
  fields: catalogContract(iot).fields,
  changelog: '固件白名单版本，任何漂移均阻断',
});

const scenarioPlan = [
  { slug: 'retail-orders', variant: 'clean', label: '夜间增量同步' },
  { slug: 'retail-orders', variant: 'new_field', label: '营销系统回写 loyalty_tier' },
  { slug: 'retail-orders', variant: 'enum_extension', label: '源端宣布支持 returned' },
  { slug: 'retail-orders', variant: 'benign_lookalike', label: '金额序列化为字符串' },
  { slug: 'retail-orders', variant: 'mixed', label: '月末大促混合漂移' },
  { slug: 'payment-settlements', variant: 'clean', label: '每日清算对账' },
  { slug: 'payment-settlements', variant: 'vendor_extra', label: '合作方附加 bank_trace_id' },
  { slug: 'payment-settlements', variant: 'semantic_conflict', label: '合作方将金额改为分' },
  { slug: 'payment-settlements', variant: 'type_change', label: '费率混入字符串' },
  { slug: 'iot-telemetry', variant: 'clean', label: '厂区 A 分钟上报' },
  { slug: 'iot-telemetry', variant: 'new_field', label: '固件新增 signal_dbm' },
  { slug: 'iot-telemetry', variant: 'benign_lookalike', label: '可选电量缺省' },
];

const batchIds = {};
for (const step of scenarioPlan) {
  const payload = buildMockPayload(step.slug, step.variant);
  const batch = ingest(db, step.slug, { variant: step.variant, label: step.label });
  batchIds[`${step.slug}:${step.variant}`] = batch.id;
}

// 一个包含真实漏检风险的失败样本：先按旧契约隔离，再回放
{
  const payload = buildMockPayload('retail-orders', 'type_change');
  const batch = ingest(db, 'retail-orders', { variant: 'type_change', label: '上游把 quantity 改为对象' });
  batchIds['retail-orders:type_change'] = batch.id;
}

// 登记一条精确签名的误报例外（金额字符串归一化不是漂移，它本就在检测层被归一化，这里演示枚举拼写真实漂移不被吞掉）
{
  const batch = buildMockPayload('retail-orders', 'enum_typo');
  const created = ingest(db, 'retail-orders', { variant: 'enum_typo', label: '上游拼写 RETURNED/retruned' });
  batchIds['retail-orders:enum_typo'] = created.id;
}

// 供应商附加字段：登记为“已知良性”例外
const vendorBatchId = batchIds['payment-settlements:vendor_extra'];
const vendorBatch = get(db, 'SELECT * FROM batches WHERE id = ?', [vendorBatchId]);
const vendorFinding = JSON.parse(vendorBatch.findings_json)[0];
createException(db, 'payment-settlements', {
  category: vendorFinding.category,
  fieldPath: vendorFinding.fieldPath,
  signature: vendorFinding.signature,
  batchId: vendorBatchId,
  note: '合作方接口文档 v5 明确声明该附加字段，已与资金组确认可忽略',
});

// 用当前策略再跑一次供应商附加字段，验证例外生效但同字段的变体升级仍被拦下
{
  const batch = buildMockPayload('payment-settlements', 'vendor_extra');
  ingest(db, 'payment-settlements', { payload: batch, variant: 'vendor_extra', label: '附加字段（已有例外）' });
  const regression = buildMockPayload('payment-settlements', 'vendor_extra_regression');
  ingest(db, 'payment-settlements', { payload: regression, variant: 'vendor_extra_regression', label: '同名字段变为对象（例外不应吞掉）' });
}

// 观察模式批次：不改变数据流，但记录“若按策略会如何处置”
{
  ingest(db, 'payment-settlements', {
    variant: 'vendor_extra_regression',
    label: '观察模式：上游预发布同名字段改为对象',
    mode: 'shadow',
  });
}

// 模拟接口：把模拟载荷也落盘，便于人工核对
const fixturesDir = path.join(root, 'data', 'fixtures');
fs.mkdirSync(fixturesDir, { recursive: true });
for (const source of CATALOG) {
  for (const variant of source.variants) {
    const payload = buildMockPayload(source.slug, variant);
    fs.writeFileSync(path.join(fixturesDir, `${source.slug}.${variant}.json`), JSON.stringify(payload, null, 2));
  }
}

run(db, 'INSERT INTO events (source_id, type, message, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [
  null,
  'seed',
  '演示数据源与初始批次已就绪',
  JSON.stringify({ sources: 3, batches: Object.keys(batchIds).length }),
  nowIso(),
]);

console.log(`Seeded ${dbPath}`);
console.log(`Sources: retail-orders(${retailId}), payment-settlements(${paymentId}), iot-telemetry(${iotId})`);
