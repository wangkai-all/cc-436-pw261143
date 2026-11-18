import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPayload, signatureFor, jsonType } from '../src/detect.js';
import { enforceDetection, normalizePolicy, DEFAULT_POLICY } from '../src/policies.js';

const fields = [
  { name: 'id', type: 'string', required: true, nullable: false, enum: [] },
  { name: 'amount', type: 'number', required: true, nullable: false, semantics: { unit: 'CNY', scale: 1 } },
  { name: 'status', type: 'string', required: true, nullable: false, enum: ['created', 'paid'] },
  { name: 'count', type: 'integer', required: false, nullable: true },
  { name: 'note', type: 'string', required: false, nullable: true, maxLength: 4 },
];

const contract = { fields };
const base = () => ({ id: 'a', amount: 10.5, status: 'paid' });

test('合规载荷不产生任何发现', () => {
  const result = detectPayload(contract, { records: [base(), { ...base(), count: 2, note: 'OK' }] });
  assert.equal(result.findings.length, 0);
  assert.equal(result.recordIssues.flat().length, 0);
});

test('新增字段记录为 info，且不改写原始样本', () => {
  const record = { ...base(), extra: 'x' };
  const result = detectPayload(contract, { records: [record] });
  const finding = result.findings.find((f) => f.category === 'new_field');
  assert.ok(finding);
  assert.equal(finding.fieldPath, 'extra');
  assert.equal(finding.samples[0].record.extra, 'x');
  assert.equal(finding.observed.type, 'string');
});

test('数值字符串被无损归一化，不计为类型变更', () => {
  const result = detectPayload(contract, { records: [{ ...base(), amount: '10.50', count: '3' }] });
  assert.equal(result.findings.length, 0);
  assert.equal(result.normalization.coerced, 2);
});

test('数值字符串但整数类型收到小数 → 类型变更（不静默截断）', () => {
  const result = detectPayload(contract, { records: [{ ...base(), count: '3.5' }] });
  const finding = result.findings.find((f) => f.category === 'type_change');
  assert.ok(finding, '必须报告类型变更');
  assert.equal(finding.fieldPath, 'count');
});

test('类型变更的对象形状进入签名，键名不同的对象得到不同签名', () => {
  const a = detectPayload(contract, { records: [{ ...base(), count: { value: 1 } }] });
  const b = detectPayload(contract, { records: [{ ...base(), count: { cents: 1 } }] });
  const sigA = a.findings.find((f) => f.category === 'type_change').signature;
  const sigB = b.findings.find((f) => f.category === 'type_change').signature;
  assert.notEqual(sigA, sigB);
});

test('必填字段缺失与非空字段为 null 是不同类别', () => {
  const missing = detectPayload(contract, { records: [{ amount: 1, status: 'paid' }] });
  assert.ok(missing.findings.some((f) => f.category === 'missing_required' && f.fieldPath === 'id'));
  const empty = detectPayload(contract, { records: [{ ...base(), id: null }] });
  assert.ok(empty.findings.some((f) => f.category === 'null_violation' && f.fieldPath === 'id'));
});

test('声明过的枚举扩展是 enum_extension，未声明的是 enum_violation', () => {
  const declared = detectPayload(contract, {
    records: [{ ...base(), status: 'refunded' }],
    meta: { declaredEnums: { status: ['refunded'] } },
  });
  assert.equal(declared.findings[0].category, 'enum_extension');
  const undeclared = detectPayload(contract, { records: [{ ...base(), status: 'refunded' }] });
  assert.equal(undeclared.findings[0].category, 'enum_violation');
});

test('拼写相近但未声明的枚举值不会被误当成枚举扩展', () => {
  const declared = detectPayload(contract, {
    records: [{ ...base(), status: 'Refunded' }, { ...base(), status: 'refunded' }],
    meta: { declaredEnums: { status: ['refunded'] } },
  });
  const categories = declared.findings.map((f) => f.category).sort();
  assert.deepEqual(categories, ['enum_extension', 'enum_violation']);
});

test('语义冲突同时给出该字段全部维度，并跳过值级校验', () => {
  const result = detectPayload(contract, {
    records: [{ ...base(), amount: 1050 }],
    meta: { units: { amount: 'CNY-cent' }, scales: { amount: 100 } },
  });
  const conflicts = result.findings.filter((f) => f.category === 'semantic_conflict');
  assert.equal(conflicts.length, 1);
  assert.deepEqual(Object.keys(conflicts[0].observed.semantics).sort(), ['scale', 'unit']);
  assert.equal(result.findings.filter((f) => f.fieldPath === 'amount').length, 1, '不应对同一字段重复报告值级问题');
});

test('约束违反与格式问题分别归类', () => {
  const result = detectPayload(contract, { records: [{ ...base(), note: 'toolong' }] });
  assert.ok(result.findings.some((f) => f.category === 'constraint_violation' && f.fieldPath === 'note'));
});

test('每组记录问题可追溯到行号', () => {
  const result = detectPayload(contract, { records: [base(), { amount: 1, status: 'paid' }] });
  assert.equal(result.recordIssues[0].length, 0);
  assert.ok(result.recordIssues[1].some((i) => i.category === 'missing_required'));
});

test('策略：新增字段放行，类型变更隔离，缺失阻断', () => {
  const detection = detectPayload(contract, {
    records: [{ amount: 1, status: 'paid', extra: 1 }, { ...base(), count: 'many' }],
  });
  const enforced = enforceDetection(detection, { policy: DEFAULT_POLICY, versionPolicy: 'additive_compatible', contract });
  const byCategory = Object.fromEntries(enforced.findings.map((f) => [f.category, f.action]));
  assert.equal(byCategory.new_field, 'accept');
  assert.equal(byCategory.missing_required, 'block');
  assert.equal(byCategory.type_change, 'quarantine');
  assert.equal(enforced.counts.blocked, 1);
  assert.equal(enforced.counts.quarantined, 1);
  assert.equal(enforced.decision, 'block');
});

test('版本锁定策略把一切漂移升级为阻断', () => {
  const detection = detectPayload(contract, { records: [{ ...base(), extra: 1 }] });
  const enforced = enforceDetection(detection, { policy: DEFAULT_POLICY, versionPolicy: 'pinned', contract });
  assert.equal(enforced.findings[0].action, 'block');
  assert.match(enforced.findings[0].actionReason, /版本锁定/);
});

test('严格策略把增量变化至少升级为隔离', () => {
  const detection = detectPayload(contract, { records: [{ ...base(), extra: 1 }] });
  const enforced = enforceDetection(detection, { policy: DEFAULT_POLICY, versionPolicy: 'strict', contract });
  assert.equal(enforced.findings[0].action, 'quarantine');
});

test('字段级策略覆盖优先于全局', () => {
  const customFields = fields.map((f) => (f.name === 'status' ? { ...f, policy: { enum_violation: 'block' } } : f));
  const detection = detectPayload({ fields: customFields }, { records: [{ ...base(), status: 'weird' }] });
  const enforced = enforceDetection(detection, {
    policy: DEFAULT_POLICY,
    versionPolicy: 'additive_compatible',
    contract: { fields: customFields },
  });
  assert.equal(enforced.findings[0].action, 'block');
  assert.match(enforced.findings[0].actionReason, /字段级/);
});

test('例外只压制完全匹配的签名：同字段其他变形仍被处置', () => {
  const detection = detectPayload(contract, {
    records: [
      { ...base(), count: { value: 1 } },
      { ...base(), count: { cents: 1 } },
    ],
  });
  const suppression = detection.findings.find((f) => f.category === 'type_change' && f.signature === signatureFor({ category: 'type_change', fieldPath: 'count', observed: { target: 'integer', observed: { type: 'object', keys: ['value'] } } }));
  assert.ok(suppression, '需要能按已知签名找到发现');
  const enforced = enforceDetection(detection, {
    policy: DEFAULT_POLICY,
    versionPolicy: 'additive_compatible',
    contract,
    exceptions: [{ id: 1, category: 'type_change', fieldPath: 'count', signature: suppression.signature, active: true }],
  });
  assert.equal(enforced.findings.length, 2);
  const [first, second] = enforced.findings;
  assert.equal(first.suppressed, true);
  assert.equal(second.suppressed, false);
  assert.equal(second.action, 'quarantine');
  assert.equal(enforced.decision, 'quarantine', '被吞掉的签名不能把整批判定降为放行');
});

test('例外不会压制同字段的其他类别（如新增字段例外不影响类型变更）', () => {
  const detection = detectPayload(contract, { records: [{ ...base(), extra: 'x', status: 3 }] });
  const extra = detection.findings.find((f) => f.category === 'new_field');
  const enforced = enforceDetection(detection, {
    policy: DEFAULT_POLICY,
    versionPolicy: 'additive_compatible',
    contract,
    exceptions: [{ id: 2, category: 'new_field', fieldPath: 'extra', signature: extra.signature, active: true }],
  });
  const typeChange = enforced.findings.find((f) => f.category === 'type_change');
  assert.equal(typeChange.suppressed, false);
  assert.equal(typeChange.action, 'quarantine');
});

test('样本数量受策略限制，但发现本身不被截断', () => {
  const records = Array.from({ length: 10 }, () => ({ ...base(), extra: 1 }));
  const detection = detectPayload(contract, { records });
  const enforced = enforceDetection(detection, {
    policy: normalizePolicy({ sample_limit: 2 }),
    versionPolicy: 'additive_compatible',
    contract,
  });
  assert.equal(enforced.findings[0].occurrences, 10);
  assert.equal(enforced.findings[0].samples.length, 2);
});

test('jsonType 区分 integer/number/object/array/null', () => {
  assert.equal(jsonType(1), 'integer');
  assert.equal(jsonType(1.5), 'number');
  assert.equal(jsonType([]), 'array');
  assert.equal(jsonType(null), 'null');
});
