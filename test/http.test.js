import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { CATALOG, catalogContract } from '../src/catalog.js';
import { normalizeContractFields } from '../src/contracts.js';
import { DEFAULT_POLICY, normalizePolicy } from '../src/policies.js';
import { run, nowIso } from '../src/db.js';

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-http-'));
  const { server, db } = createApp({ databasePath: path.join(dir, 'http.db') });
  const now = nowIso();
  for (const source of CATALOG) {
    const result = run(
      db,
      `INSERT INTO sources (slug, name, domain, description, owner, version_policy, policy_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [source.slug, source.name, source.domain, source.description, source.owner, source.versionPolicy, JSON.stringify(normalizePolicy(DEFAULT_POLICY)), now],
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function call(base, method, path, body) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { status: response.status, data };
}

test('HTTP：全链路 —— 采集 → 隔离 → 例外 → 回放 → 批准', async () => {
  const { base, close } = await startServer();
  try {
    const meta = await call(base, 'GET', '/meta');
    assert.equal(meta.status, 200);
    assert.ok(meta.data.categories.new_field);

    const sources = await call(base, 'GET', '/sources');
    assert.equal(sources.data.sources.length, 3);

    const mock = await call(base, 'GET', '/sources/retail-orders/mock?variant=enum_typo');
    assert.equal(mock.status, 200);
    assert.ok(mock.data.payload.records.length > 0);

    const ingest = await call(base, 'POST', '/sources/payment-settlements/ingest', { variant: 'vendor_extra' });
    assert.equal(ingest.status, 201);
    assert.equal(ingest.data.batch.decision, 'quarantine', '严格策略下新增字段至少隔离');
    const batchId = ingest.data.batch.id;

    const detail = await call(base, 'GET', `/batches/${batchId}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.data.quarantineRows.length > 0);
    const finding = detail.data.findings.find((f) => f.category === 'new_field');
    assert.ok(finding.samples.length > 0, '差异样本必须保留');

    const preview = await call(base, 'POST', '/sources/payment-settlements/exceptions/preview', {
      category: finding.category,
      fieldPath: finding.fieldPath,
      signature: finding.signature,
    });
    assert.equal(preview.status, 200);
    assert.ok(preview.data.matchCount >= 1);

    const created = await call(base, 'POST', '/sources/payment-settlements/exceptions', {
      batchId,
      category: finding.category,
      fieldPath: finding.fieldPath,
      signature: finding.signature,
      note: '测试',
    });
    assert.equal(created.status, 201);

    const afterException = await call(base, 'POST', '/sources/payment-settlements/ingest', { variant: 'vendor_extra' });
    assert.equal(afterException.data.batch.decision, 'accept');

    // 同名字段的真实变形仍被隔离
    const regression = await call(base, 'POST', '/sources/payment-settlements/ingest', { variant: 'vendor_extra_regression' });
    assert.notEqual(regression.data.batch.decision, 'accept');
    const regressionFinding = regression.data.batch.findings.find((f) => f.category === 'new_field');
    assert.equal(regressionFinding.suppressed, false);

    const quarantine = await call(base, 'GET', '/sources/payment-settlements/quarantine?status=pending');
    assert.ok(quarantine.data.rows.length > 0);
    const qid = quarantine.data.rows.find((r) => r.batchId === batchId).id;
    const replay = await call(base, 'POST', `/quarantine/${qid}/replay`, {});
    assert.equal(replay.status, 200);
    assert.equal(replay.data.newDecision, 'accepted', '例外登记后回放应放行同签名记录');

    const verify = await call(base, 'GET', '/sources/retail-orders/verify');
    assert.equal(verify.status, 200);
    assert.equal(verify.data.verdict, 'ok');

    const proposals = await call(base, 'GET', '/sources/retail-orders/field-proposals');
    assert.equal(proposals.status, 200);

    const playground = await call(base, 'POST', '/playground', {
      slug: 'retail-orders',
      payload: mock.data.payload,
    });
    assert.equal(playground.status, 200);
    assert.ok(playground.data.findings.length > 0);
  } finally {
    await close();
  }
});

test('HTTP：错误路径返回结构化错误', async () => {
  const { base, close } = await startServer();
  try {
    const missing = await call(base, 'GET', '/sources/nope');
    assert.equal(missing.status, 404);
    assert.match(missing.data.error, /未找到/);

    const badVariant = await call(base, 'POST', '/sources/retail-orders/ingest', { variant: 'nope' });
    assert.equal(badVariant.status, 400);

    const badContract = await call(base, 'POST', '/sources/retail-orders/contracts', {
      fields: [{ name: 'Bad Name', type: 'string' }],
    });
    assert.equal(badContract.status, 400);

    const source = await call(base, 'GET', '/sources/retail-orders');
    const breaking = source.data.currentContract.fields.map((f) => (f.name === 'status' ? { ...f, enum: ['paid'] } : f));
    const draft = await call(base, 'POST', '/sources/retail-orders/contracts', { fields: breaking });
    assert.equal(draft.status, 201);
    assert.equal(draft.data.compatibility, 'breaking');
    const approve = await call(base, 'POST', `/sources/retail-orders/contracts/${draft.data.version}/approve`, {});
    assert.equal(approve.status, 409);
    assert.ok(approve.data.changes.length >= 1);

    const unknown = await call(base, 'GET', '/nope');
    assert.equal(unknown.status, 404);
  } finally {
    await close();
  }
});

test('HTTP：静态页面可访问，且页面不泄露服务端文件', async () => {
  const { base, close } = await startServer();
  try {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /契约哨站/);
    const traversal = await fetch(`${base}/../package.json`);
    assert.equal(traversal.status, 200, '路径穿越会回退到 index.html 而不是泄露文件');
    assert.match(await traversal.text(), /<html/);
  } finally {
    await close();
  }
});
