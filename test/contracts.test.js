import test from 'node:test';
import assert from 'node:assert/strict';
import { diffContracts, normalizeContractFields, bumpVersion } from '../src/contracts.js';

const base = [
  { name: 'id', type: 'string', required: true, nullable: false },
  { name: 'status', type: 'string', required: true, enum: ['a', 'b'] },
  { name: 'amount', type: 'number', required: false, min: 0, max: 100, semantics: { unit: 'CNY' } },
];

test('字段规范化保留约束与语义，并拒绝非法字段名', () => {
  const fields = normalizeContractFields(base);
  assert.equal(fields.length, 3);
  assert.equal(fields[2].semantics.unit, 'CNY');
  assert.throws(() => normalizeContractFields([{ name: 'Bad Name', type: 'string' }]), /字段名/);
  assert.throws(() => normalizeContractFields([{ name: 'x', type: 'string' }, { name: 'x', type: 'string' }]), /重复/);
});

test('扩展枚举与前向兼容新增字段不改变版本大号', () => {
  const next = base.map((f) => (f.name === 'status' ? { ...f, enum: ['a', 'b', 'c'] } : f));
  next.push({ name: 'note', type: 'string', required: false });
  const diff = diffContracts(normalizeContractFields(base), normalizeContractFields(next));
  assert.equal(diff.compatibility, 'forward_compatible');
  assert.equal(bumpVersion('1.2.3', diff.compatibility), '1.3.0');
});

test('收缩枚举、收紧范围、语义改变均为破坏性', () => {
  const variants = [
    base.map((f) => (f.name === 'status' ? { ...f, enum: ['a'] } : f)),
    base.map((f) => (f.name === 'amount' ? { ...f, min: 10 } : f)),
    base.map((f) => (f.name === 'amount' ? { ...f, semantics: { unit: 'CNY-cent' } } : f)),
    base.map((f) => (f.name === 'amount' ? { ...f, type: 'integer' } : f)).filter(
      (f) => f.name !== 'amount' || f.type === 'integer',
    ),
  ];
  for (const variant of variants) {
    const diff = diffContracts(normalizeContractFields(base), normalizeContractFields(variant));
    assert.equal(diff.compatibility, 'breaking', JSON.stringify(diff.changes));
    assert.equal(bumpVersion('1.2.3', diff.compatibility), '2.0.0');
  }
});

test('把可选字段改为必填是破坏性，反之是兼容', () => {
  const required = base.map((f) => (f.name === 'amount' ? { ...f, required: true } : f));
  assert.equal(diffContracts(normalizeContractFields(base), normalizeContractFields(required)).compatibility, 'breaking');
  const requiredBase = base.map((f) => (f.name === 'amount' ? { ...f, required: true } : f));
  const optional = base.map((f) => (f.name === 'amount' ? { ...f, required: false } : f));
  assert.equal(diffContracts(normalizeContractFields(requiredBase), normalizeContractFields(optional)).compatibility, 'forward_compatible');
});

test('新增可选字段兼容，新增必填字段与移除字段是破坏性', () => {
  const optional = [...base, { name: 'region', type: 'string', required: false }];
  assert.equal(diffContracts(normalizeContractFields(base), normalizeContractFields(optional)).compatibility, 'forward_compatible');
  const required = [...base, { name: 'region', type: 'string', required: true }];
  assert.equal(diffContracts(normalizeContractFields(base), normalizeContractFields(required)).compatibility, 'breaking');
  const removed = base.filter((f) => f.name !== 'amount');
  assert.equal(diffContracts(normalizeContractFields(base), normalizeContractFields(removed)).compatibility, 'breaking');
});

test('只改标签/描述不产生兼容性变化', () => {
  const next = base.map((f) => ({ ...f, label: `${f.name}-x` }));
  const diff = diffContracts(normalizeContractFields(base), normalizeContractFields(next));
  assert.equal(diff.compatibility, 'identical');
  assert.equal(diff.changes.length, 0);
});

test('新增格式约束是破坏性，移除是兼容', () => {
  const withFormat = base.map((f) => (f.name === 'id' ? { ...f, format: 'uuid' } : f));
  const diff = diffContracts(normalizeContractFields(base), normalizeContractFields(withFormat));
  assert.equal(diff.compatibility, 'breaking');
  const reverse = diffContracts(normalizeContractFields(withFormat), normalizeContractFields(base));
  assert.equal(reverse.compatibility, 'forward_compatible');
});
