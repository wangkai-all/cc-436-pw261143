import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.js';
import { CATALOG, buildMockPayload, catalogContract } from '../src/catalog.js';
import { normalizeContractFields } from '../src/contracts.js';
import { DEFAULT_POLICY, normalizePolicy } from '../src/policies.js';
import {
  approveContract,
  compareContracts,
  createContract,
  createException,
  exceptionImpact,
  getBatch,
  getSource,
  ingest,
  listExceptions,
  listQuarantine,
  overview,
  previewExceptionImpact,
  replayQuarantine,
  updateSource,
  verifySource,
  playgroundDetect,
} from '../src/core.js';
import { run, get } from '../src/db.js';

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-test-'));
  const dbPath = path.join(dir, 'test.db');
  const db = openDatabase(dbPath);
  const now = new Date().toISOString();
  for (const source of CATALOG) {
    const result = run(
      db,
      `INSERT INTO sources (slug, name, domain, description, owner, version_policy, policy_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        source.slug,
        source.name,
        source.domain,
        source.description,
        source.owner,
        source.versionPolicy,
        JSON.stringify(normalizePolicy(DEFAULT_POLICY)),
        now,
      ],
    );
    const sourceId = Number(result.lastInsertRowid);
    const contract = run(
      db,
      `INSERT INTO contracts (source_id, version, fields_json, status, compatibility, proposal_json, created_by, created_at, approved_at)
       VALUES (?, ?, ?, 'active', 'baseline', '{}', 'test', ?, ?)`,
      [sourceId, source.contractVersion, JSON.stringify(normalizeContractFields(catalogContract(source).fields)), now, now],
    );
    run(db, 'UPDATE sources SET current_contract_id = ? WHERE id = ?', [Number(contract.lastInsertRowid), sourceId]);
  }
  return { db, dir };
}

test('采集：新增字段按策略放行但保留差异样本', () => {
  const { db } = freshDb();
  const batch = ingest(db, 'retail-orders', { variant: 'new_field' });
  assert.equal(batch.decision, 'accept');
  assert.ok(batch.findings.some((f) => f.category === 'new_field' && f.samples.length > 0));
  const detail = getBatch(db, batch.id);
  assert.ok(detail.findings[0].samples[0].record);
});

test('采集：必填缺失阻断并落隔离（blocked 状态）', () => {
  const { db } = freshDb();
  const batch = ingest(db, 'retail-orders', { variant: 'missing_required' });
  assert.equal(batch.decision, 'block');
  assert.ok(batch.counts.blocked >= 1);
  const { rows } = listQuarantine(db, 'retail-orders', { status: 'blocked' });
  assert.ok(rows.length >= 1);
  assert.ok(rows[0].record);
});

test('语义冲突阻断整批，并说明单位与精度', () => {
  const { db } = freshDb();
  const batch = ingest(db, 'payment-settlements', { variant: 'semantic_conflict' });
  assert.equal(batch.decision, 'block');
  assert.equal(batch.counts.blocked, batch.recordCount);
  const finding = batch.findings.find((f) => f.category === 'semantic_conflict');
  assert.ok(finding.observed.semantics.unit);
});

test('观察模式不产生隔离，但记录建议处置', () => {
  const { db } = freshDb();
  const batch = ingest(db, 'retail-orders', { variant: 'missing_required', mode: 'shadow' });
  assert.equal(batch.decision, 'accept');
  assert.equal(batch.counts.quarantined, 0);
  assert.equal(batch.quarantineRows.length, 0);
  const finding = batch.findings.find((f) => f.category === 'missing_required');
  assert.equal(finding.action, 'accept');
  assert.equal(finding.recommendedAction, 'block');
});

test('回放：把隔离记录按新契约重放，可转为通过', () => {
  const { db } = freshDb();
  // 让源端先发一个未声明的枚举值 → 隔离
  const batch = ingest(db, 'retail-orders', {
    payload: {
      records: [
        {
          order_id: '11111111-2222-4333-a444-555555555555',
          customer_id: 'CUS-123456',
          status: 'returned',
          amount: 12.5,
          quantity: 1,
          currency: 'CNY',
          created_at: '2026-11-10T08:00:00Z',
        },
      ],
    },
    variant: 'manual-one',
  });
  assert.equal(batch.decision, 'quarantine');
  const { rows } = listQuarantine(db, 'retail-orders', { status: 'pending' });
  const row = rows[0];
  const replayFail = replayQuarantine(db, row.id, {});
  assert.equal(replayFail.newDecision, 'quarantined');

  const source = getSource(db, 'retail-orders');
  const nextFields = source.currentContract.fields.map((f) =>
    f.name === 'status' ? { ...f, enum: [...f.enum, 'returned'] } : f,
  );
  const draft = createContract(db, 'retail-orders', { fields: nextFields, changelog: '采纳 returned' });
  assert.equal(draft.compatibility, 'forward_compatible');
  approveContract(db, 'retail-orders', draft.version, { note: '枚举扩展' });
  const replayOk = replayQuarantine(db, row.id, {});
  assert.equal(replayOk.newDecision, 'accepted');
});

test('破坏性契约不能按兼容流程批准，需显式确认', () => {
  const { db } = freshDb();
  const source = getSource(db, 'retail-orders');
  const breaking = source.currentContract.fields.map((f) => (f.name === 'amount' ? { ...f, type: 'string' } : f));
  const draft = createContract(db, 'retail-orders', { fields: breaking, changelog: '金额改为字符串' });
  assert.equal(draft.compatibility, 'breaking');
  assert.throws(() => approveContract(db, 'retail-orders', draft.version, {}), /破坏性/);
  const approved = approveContract(db, 'retail-orders', draft.version, { confirmBreaking: true, note: '迁移完成' });
  assert.equal(approved.status, 'active');
});

test('批准前旧契约保持生效，对比接口能列出受影响批次', () => {
  const { db } = freshDb();
  ingest(db, 'retail-orders', { variant: 'type_change' });
  const source = getSource(db, 'retail-orders');
  const next = source.currentContract.fields.map((f) => (f.name === 'quantity' ? { ...f, type: 'string' } : f));
  const draft = createContract(db, 'retail-orders', { fields: next });
  const after = getSource(db, 'retail-orders');
  assert.equal(after.currentContract.version, source.currentContract.version, '草案不应自动生效');
  const cmp = compareContracts(db, 'retail-orders', { from: source.currentContract.version, to: draft.version });
  assert.ok(cmp.diff.changes.some((c) => c.fieldPath === 'quantity' && c.breaking));
  assert.ok(cmp.impactedBatches.length >= 1, '应能找到命中 quantity 的历史批次');
});

test('例外：登记后同签名被豁免，但同字段其他变形仍被隔离', () => {
  const { db } = freshDb();
  const first = ingest(db, 'payment-settlements', { variant: 'vendor_extra' });
  const finding = first.findings.find((f) => f.category === 'new_field');
  createException(db, 'payment-settlements', {
    batchId: first.id,
    category: finding.category,
    fieldPath: finding.fieldPath,
    signature: finding.signature,
    note: '供应商文档已声明',
  });
  const second = ingest(db, 'payment-settlements', { variant: 'vendor_extra' });
  assert.equal(second.decision, 'accept');
  assert.equal(second.findings[0].suppressed, true);

  const regression = ingest(db, 'payment-settlements', { variant: 'vendor_extra_regression' });
  assert.notEqual(regression.decision, 'accept', '同字段对象变形不能被字符串例外豁免');
  const objectFinding = regression.findings.find((f) => f.category === 'new_field');
  assert.equal(objectFinding.suppressed, false);
});

test('例外停用后重新生效检测', () => {
  const { db } = freshDb();
  const first = ingest(db, 'payment-settlements', { variant: 'vendor_extra' });
  const finding = first.findings.find((f) => f.category === 'new_field');
  const created = createException(db, 'payment-settlements', {
    batchId: first.id,
    category: finding.category,
    fieldPath: finding.fieldPath,
    signature: finding.signature,
  });
  run(db, 'UPDATE exceptions SET active = 0 WHERE id = ?', [created.id]);
  const again = ingest(db, 'payment-settlements', { variant: 'vendor_extra' });
  assert.notEqual(again.decision, 'accept');
});

test('例外影响面预演区分签名的匹配与不匹配', () => {
  const { db } = freshDb();
  ingest(db, 'payment-settlements', { variant: 'vendor_extra' });
  ingest(db, 'payment-settlements', { variant: 'vendor_extra_regression' });
  const stringSignature = getBatch(db, ingest(db, 'payment-settlements', { variant: 'vendor_extra' }).id).findings.find(
    (f) => f.category === 'new_field',
  ).signature;
  const preview = previewExceptionImpact(db, 'payment-settlements', {
    category: 'new_field',
    fieldPath: 'bank_trace_id',
    signature: stringSignature,
  });
  assert.ok(preview.matchCount >= 1);
  assert.ok(preview.otherSignatureCount >= 1);
  assert.match(preview.warning, /签名不同/);
});

test('自检：所有数据源在当前契约下通过，且承认已登记例外', () => {
  const { db } = freshDb();
  const first = ingest(db, 'payment-settlements', { variant: 'vendor_extra' });
  const finding = first.findings.find((f) => f.category === 'new_field');
  createException(db, 'payment-settlements', {
    batchId: first.id,
    category: finding.category,
    fieldPath: finding.fieldPath,
    signature: finding.signature,
  });
  for (const source of CATALOG) {
    const result = verifySource(db, source.slug);
    assert.equal(result.verdict, 'ok', `${source.slug}: ${JSON.stringify(result.checks.filter((c) => !c.pass))}`);
  }
});

test('自检能发现被例外错误吞掉的真实漂移', () => {
  const { db } = freshDb();
  // 用一个“过宽”的例外：直接把回归场景的对象签名登记成误报
  const regression = ingest(db, 'payment-settlements', { variant: 'vendor_extra_regression' });
  const finding = regression.findings.find((f) => f.category === 'new_field');
  createException(db, 'payment-settlements', {
    batchId: regression.id,
    category: finding.category,
    fieldPath: finding.fieldPath,
    signature: finding.signature,
  });
  const result = verifySource(db, 'payment-settlements');
  const failed = result.checks.filter((c) => !c.pass);
  assert.ok(failed.length >= 1, '把真实漂移登记为例外后，自检必须报错');
  assert.ok(failed.some((c) => c.swallowed.length > 0));
});

test('策略更新：版本锁定后新增字段也阻断', () => {
  const { db } = freshDb();
  const accepted = ingest(db, 'iot-telemetry', { variant: 'new_field' });
  assert.equal(accepted.decision, 'block', '设备遥测本身就是锁定策略');
  updateSource(db, 'retail-orders', { versionPolicy: 'pinned' });
  const blocked = ingest(db, 'retail-orders', { variant: 'new_field' });
  assert.equal(blocked.decision, 'block');
});

test('总览汇总的隔离行数与批次计数一致', () => {
  const { db } = freshDb();
  ingest(db, 'retail-orders', { variant: 'mixed' });
  ingest(db, 'payment-settlements', { variant: 'semantic_conflict' });
  const data = overview(db);
  assert.equal(data.totals.batches, 2);
  assert.ok(data.totals.pendingQuarantine + data.totals.blockedRows >= 1);
  assert.equal(data.rowTotals.blocked, data.totals.blockedRows);
});

test('演练台：按当前契约与例外试算，不改动数据库', () => {
  const { db } = freshDb();
  const payload = buildMockPayload('retail-orders', 'new_field');
  const before = overview(db).totals.batches;
  const result = playgroundDetect(db, { slug: 'retail-orders', payload });
  assert.equal(result.decision, 'accept');
  assert.ok(result.findings.some((f) => f.category === 'new_field'));
  assert.equal(overview(db).totals.batches, before);
});

test('非法输入给出明确错误', () => {
  const { db } = freshDb();
  assert.throws(() => ingest(db, 'retail-orders', { variant: 'nope' }), /场景/);
  assert.throws(() => ingest(db, 'nope', { variant: 'clean' }), /未找到数据源/);
  const source = getSource(db, 'retail-orders');
  assert.throws(() => createContract(db, 'retail-orders', { fields: source.currentContract.fields }), /没有差异/);
});

test('异常样本：坏记录被标记而不是抛错', () => {
  const { db } = freshDb();
  const batch = ingest(db, 'retail-orders', {
    payload: { records: ['not-an-object', null] },
    variant: 'garbage',
  });
  assert.ok(batch.findings.filter((f) => f.category === 'malformed_record').length >= 1);
  assert.equal(batch.decision, 'block');
});
