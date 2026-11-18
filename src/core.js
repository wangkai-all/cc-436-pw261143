import { CATEGORY_META, DEFAULT_POLICY, VERSION_POLICIES, ACTION_META, enforceDetection, normalizePolicy } from './policies.js';
import { detectPayload, signatureFor, summarizeCategories } from './detect.js';
import { buildMockPayload, CATALOG, VARIANT_META } from './catalog.js';
import { diffContracts, normalizeContractFields, validateVersionString } from './contracts.js';
import { all, get, nowIso, run } from './db.js';

export class ApiError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.extra = extra;
  }
}

export const CATALOG_SLUGS = new Set(CATALOG.map((s) => s.slug));

function parseJson(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function sourceRow(db, slugOrId) {
  const row = Number.isInteger(slugOrId)
    ? get(db, 'SELECT * FROM sources WHERE id = ?', [slugOrId])
    : get(db, 'SELECT * FROM sources WHERE slug = ?', [String(slugOrId)]);
  return row;
}

export function presentSource(db, row) {
  const policy = normalizePolicy(parseJson(row.policy_json, DEFAULT_POLICY));
  const current = row.current_contract_id ? get(db, 'SELECT * FROM contracts WHERE id = ?', [row.current_contract_id]) : null;
  const stats = get(
    db,
    `SELECT
       (SELECT COUNT(*) FROM batches WHERE source_id = ?) AS batches,
       (SELECT COUNT(*) FROM quarantine WHERE source_id = ? AND status = 'pending') AS pending_quarantine,
       (SELECT COUNT(*) FROM exceptions WHERE source_id = ? AND active = 1) AS active_exceptions`,
    [row.id, row.id, row.id],
  );
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    domain: row.domain,
    description: row.description,
    owner: row.owner,
    versionPolicy: row.version_policy,
    versionPolicyLabel: VERSION_POLICIES[row.version_policy]?.label ?? row.version_policy,
    policy,
    currentContract: current ? presentContract(current) : null,
    stats: {
      batches: Number(stats?.batches ?? 0),
      pendingQuarantine: Number(stats?.pending_quarantine ?? 0),
      activeExceptions: Number(stats?.active_exceptions ?? 0),
    },
    createdAt: row.created_at,
  };
}

export function presentContract(row, { includeFields = true } = {}) {
  if (!row) return null;
  const fields = parseJson(row.fields_json, []);
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    compatibility: row.compatibility,
    changelog: row.changelog,
    proposal: parseJson(row.proposal_json, null),
    basedOn: row.based_on,
    createdBy: row.created_by,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    approvedNote: row.approved_note,
    fieldCount: fields.length,
    ...(includeFields ? { fields } : {}),
  };
}

function presentFinding(finding) {
  return {
    category: finding.category,
    categoryLabel: CATEGORY_META[finding.category]?.label ?? finding.category,
    fieldPath: finding.fieldPath,
    severity: finding.severity,
    signature: finding.signature,
    message: finding.message,
    expected: finding.expected,
    observed: finding.observed,
    occurrences: finding.occurrences,
    action: finding.action,
    actionLabel: ACTION_META[finding.action]?.label ?? finding.action,
    actionReason: finding.actionReason,
    recommendedAction: finding.recommendedAction ?? null,
    suppressed: Boolean(finding.suppressed),
    exceptionId: finding.exceptionId ?? null,
    notes: finding.notes ?? [],
    samples: finding.samples,
  };
}

function presentBatch(row, { includeFindings = true } = {}) {
  if (!row) return null;
  const findings = parseJson(row.findings_json, []);
  return {
    id: row.id,
    sourceId: row.source_id,
    contractId: row.contract_id,
    contractVersion: row.contract_version,
    variant: row.variant,
    variantLabel: VARIANT_META[row.variant]?.label ?? row.variant,
    label: row.label,
    mode: row.mode,
    origin: row.origin,
    decision: row.decision,
    decisionLabel: ACTION_META[row.decision]?.label ?? row.decision,
    counts: parseJson(row.counts_json, {}),
    recordCount: row.record_count,
    durationMs: row.duration_ms,
    normalization: parseJson(row.normalization_json, { coerced: 0, details: [] }),
    meta: parseJson(row.meta_json, {}),
    findingCount: findings.length,
    recordedFindingCount: findings.length,
    enforcedFindingCount: findings.filter((f) => !(f.action === 'accept' && f.suppressed)).length,
    suppressedCount: findings.filter((f) => f.suppressed).length,
    categories: summarizeCategories(findings),
    createdAt: row.created_at,
    ...(includeFindings ? { findings: findings.map(presentFinding) } : {}),
  };
}

export function presentQuarantine(row) {
  return {
    id: row.id,
    batchId: row.batch_id,
    sourceId: row.source_id,
    rowIndex: row.row_index,
    record: parseJson(row.record_json, null),
    reasons: parseJson(row.reasons_json, []),
    decision: row.decision,
    status: row.status,
    replayResult: parseJson(row.replay_result_json, null),
    replayedAt: row.replayed_at,
    createdAt: row.created_at,
  };
}

export function presentException(row) {
  return {
    id: row.id,
    sourceId: row.source_id,
    category: row.category,
    categoryLabel: CATEGORY_META[row.category]?.label ?? row.category,
    fieldPath: row.field_path,
    signature: row.signature,
    observed: parseJson(row.observed_json, null),
    sample: parseJson(row.record_json, null),
    meta: parseJson(row.meta_json, null),
    note: row.note,
    active: Boolean(row.active),
    scope: row.scope,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function logEvent(db, sourceId, type, message, detail = null) {
  run(db, 'INSERT INTO events (source_id, type, message, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [
    sourceId,
    type,
    message,
    detail ? JSON.stringify(detail) : null,
    nowIso(),
  ]);
}

export function listSources(db) {
  return all(db, 'SELECT * FROM sources ORDER BY id').map((row) => presentSource(db, row));
}

export function getSource(db, slug) {
  const row = sourceRow(db, slug);
  if (!row) throw new ApiError(`未找到数据源 ${slug}`, 404);
  const source = presentSource(db, row);
  const contracts = all(db, 'SELECT * FROM contracts WHERE source_id = ? ORDER BY id DESC', [row.id]).map((c) => presentContract(c));
  const recent = all(db, 'SELECT * FROM batches WHERE source_id = ? ORDER BY id DESC LIMIT 8', [row.id]).map((b) => presentBatch(b, { includeFindings: false }));
  const categories = all(db, 'SELECT findings_json FROM batches WHERE source_id = ?', [row.id]).flatMap((b) => summarizeCategories(parseJson(b.findings_json, [])));
  const categoryTotals = {};
  for (const c of categories) for (const [k, v] of Object.entries(c)) categoryTotals[k] = (categoryTotals[k] ?? 0) + v;
  const pending = get(db, "SELECT COUNT(*) AS n FROM quarantine WHERE source_id = ? AND status = 'pending'", [row.id]);
  return {
    ...source,
    contracts,
    recentBatches: recent,
    categoryTotals,
    pendingQuarantine: Number(pending?.n ?? 0),
    catalogSlug: CATALOG_SLUGS.has(row.slug) ? row.slug : null,
    variantMeta: CATALOG_SLUGS.has(row.slug) ? VARIANT_META : null,
  };
}

export function updateSource(db, slug, patch) {
  const row = sourceRow(db, slug);
  if (!row) throw new ApiError(`未找到数据源 ${slug}`, 404);
  const fields = [];
  const params = [];
  if (patch.name !== undefined) {
    if (!String(patch.name).trim()) throw new ApiError('名称不能为空');
    fields.push('name = ?');
    params.push(String(patch.name).trim().slice(0, 80));
  }
  if (patch.description !== undefined) {
    fields.push('description = ?');
    params.push(String(patch.description).slice(0, 500));
  }
  if (patch.owner !== undefined) {
    fields.push('owner = ?');
    params.push(String(patch.owner).slice(0, 80));
  }
  if (patch.versionPolicy !== undefined) {
    if (!VERSION_POLICIES[patch.versionPolicy]) throw new ApiError(`未知版本兼容策略 ${patch.versionPolicy}`);
    fields.push('version_policy = ?');
    params.push(patch.versionPolicy);
  }
  if (patch.policy !== undefined) {
    if (patch.policy.categories) {
      for (const [cat, val] of Object.entries(patch.policy.categories)) {
        if (!CATEGORY_META[cat]) throw new ApiError(`未知漂移类别 ${cat}`);
        const action = val?.action ?? val;
        if (!['accept', 'quarantine', 'block'].includes(action)) throw new ApiError(`类别 ${cat} 的处置必须是 accept/quarantine/block`);
      }
    }
    const normalized = normalizePolicy(patch.policy);
    fields.push('policy_json = ?');
    params.push(JSON.stringify(normalized));
  }
  if (fields.length) {
    params.push(row.id);
    run(db, `UPDATE sources SET ${fields.join(', ')} WHERE id = ?`, params);
    logEvent(db, row.id, 'source_updated', `更新数据源 ${row.slug} 的配置`, { patch });
  }
  return presentSource(db, sourceRow(db, row.id));
}

function activeContract(db, sourceId) {
  const row = get(
    db,
    `SELECT c.* FROM sources s JOIN contracts c ON c.id = s.current_contract_id WHERE s.id = ?`,
    [sourceId],
  );
  if (!row) throw new ApiError('数据源还没有生效的契约', 409);
  return row;
}

function contractByVersion(db, sourceId, version) {
  if (!version) return activeContract(db, sourceId);
  const row = get(db, 'SELECT * FROM contracts WHERE source_id = ? AND version = ?', [sourceId, String(version)]);
  if (!row) throw new ApiError(`未找到契约版本 ${version}`, 404);
  return row;
}

export function createContract(db, slug, input) {
  const row = sourceRow(db, slug);
  if (!row) throw new ApiError(`未找到数据源 ${slug}`, 404);
  let fields;
  try {
    fields = normalizeContractFields(input.fields);
  } catch (error) {
    throw new ApiError(`字段定义不合法：${error.message}`, 400);
  }
  const current = row.current_contract_id ? get(db, 'SELECT * FROM contracts WHERE id = ?', [row.current_contract_id]) : null;
  const oldFields = current ? parseJson(current.fields_json, []) : [];
  const diff = current ? diffContracts(oldFields, fields) : { changes: [], compatibility: 'baseline', breakingCount: 0 };

  if (input.version !== undefined && !validateVersionString(input.version)) {
    throw new ApiError('版本号必须形如 1.2.0');
  }
  let version = input.version;
  if (!version) {
    version = current ? bumpFromVersion(current.version, diff.compatibility) : '1.0.0';
  }
  if (get(db, 'SELECT id FROM contracts WHERE source_id = ? AND version = ?', [row.id, version])) {
    throw new ApiError(`版本 ${version} 已存在`, 409);
  }
  if (current && diff.compatibility === 'identical') {
    throw new ApiError('字段定义与当前版本没有差异，无需新建版本', 409);
  }
  const status = current ? 'proposed' : 'active';
  const now = nowIso();
  const result = run(
    db,
    `INSERT INTO contracts (source_id, version, fields_json, status, compatibility, changelog, proposal_json, based_on, created_by, created_at, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      version,
      JSON.stringify(fields),
      status,
      current ? diff.compatibility : 'baseline',
      String(input.changelog ?? '').slice(0, 600) || null,
      JSON.stringify({ changes: diff.changes, summary: diff.summary ?? '基线版本' }),
      current?.id ?? null,
      '本地控制台',
      now,
      status === 'active' ? now : null,
    ],
  );
  if (status === 'active') {
    run(db, 'UPDATE sources SET current_contract_id = ? WHERE id = ?', [result.lastInsertRowid, row.id]);
  }
  logEvent(db, row.id, 'contract_created', `创建契约 ${version}（${status === 'active' ? '已生效' : '待批准'}，${diff.compatibility}）`, {
    version,
    compatibility: diff.compatibility,
    changes: diff.changes.length,
  });
  return presentContract(get(db, 'SELECT * FROM contracts WHERE id = ?', [result.lastInsertRowid]));
}

function bumpFromVersion(version, compatibility) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!match) return '1.0.0';
  const [major, minor, patch] = match.slice(1).map(Number);
  if (compatibility === 'breaking') return `${major + 1}.0.0`;
  if (compatibility === 'forward_compatible') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function approveContract(db, slug, version, { note, confirmBreaking = false } = {}) {
  const row = sourceRow(db, slug);
  if (!row) throw new ApiError(`未找到数据源 ${slug}`, 404);
  const contract = get(db, 'SELECT * FROM contracts WHERE source_id = ? AND version = ?', [row.id, version]);
  if (!contract) throw new ApiError(`未找到契约版本 ${version}`, 404);
  if (contract.status === 'active') throw new ApiError('该版本已经是当前生效契约', 409);
  if (contract.compatibility === 'breaking' && !confirmBreaking) {
    throw new ApiError(
      '该版本包含破坏性变更，不能按兼容版本直接批准。请确认迁移影响，或先提交兼容版本。',
      409,
      { compatibility: 'breaking', changes: parseJson(contract.proposal_json, {}).changes ?? [] },
    );
  }
  const current = row.current_contract_id ? get(db, 'SELECT * FROM contracts WHERE id = ?', [row.current_contract_id]) : null;
  const now = nowIso();
  run(db, "UPDATE contracts SET status = 'superseded', approved_at = COALESCE(approved_at, ?) WHERE source_id = ? AND status = 'active'", [now, row.id]);
  run(db, "UPDATE contracts SET status = 'active', approved_at = ?, approved_note = ? WHERE id = ?", [
    now,
    String(note ?? '').slice(0, 300) || null,
    contract.id,
  ]);
  run(db, 'UPDATE sources SET current_contract_id = ? WHERE id = ?', [contract.id, row.id]);
  logEvent(db, row.id, 'contract_approved', `契约 ${current?.version ?? '—'} → ${version} 已批准生效`, {
    from: current?.version ?? null,
    to: version,
    compatibility: contract.compatibility,
  });
  return presentContract(get(db, 'SELECT * FROM contracts WHERE id = ?', [contract.id]));
}

export function compareContracts(db, slug, { from, to }) {
  const row = sourceRow(db, slug);
  if (!row) throw new ApiError(`未找到数据源 ${slug}`, 404);
  const fromRow = contractByVersion(db, row.id, from);
  const toRow = contractByVersion(db, row.id, to);
  const fromFields = parseJson(fromRow.fields_json, []);
  const toFields = parseJson(toRow.fields_json, []);
  const diff = diffContracts(fromFields, toFields);
  const fromBatches = all(db, 'SELECT * FROM batches WHERE source_id = ? AND contract_version = ? ORDER BY id DESC LIMIT 20', [row.id, fromRow.version]);
  const toBatches = all(db, 'SELECT * FROM batches WHERE source_id = ? AND contract_version = ? ORDER BY id DESC LIMIT 20', [row.id, toRow.version]);
  const impact = affectedBatchesForFields(db, row.id, diff.changes.map((c) => c.fieldPath));
  return {
    source: presentSource(db, row),
    from: presentContract(fromRow),
    to: presentContract(toRow),
    diff,
    batches: {
      from: fromBatches.map((b) => presentBatch(b, { includeFindings: false })),
      to: toBatches.map((b) => presentBatch(b, { includeFindings: false })),
    },
    impactedBatches: impact,
  };
}

function affectedBatchesForFields(db, sourceId, fieldPaths) {
  const names = new Set(fieldPaths);
  const batches = all(db, 'SELECT * FROM batches WHERE source_id = ? ORDER BY id DESC', [sourceId]);
  const impacted = [];
  for (const batch of batches) {
    const findings = parseJson(batch.findings_json, []);
    const hits = findings.filter((f) => names.has(f.fieldPath) || names.has('$'));
    const related = findings.filter((f) => names.has(f.fieldPath));
    if (!related.length && !hits.length) continue;
    impacted.push({
      batch: presentBatch(batch, { includeFindings: false }),
      findings: related.map((f) => ({
        category: f.category,
        fieldPath: f.fieldPath,
        message: f.message,
        action: f.action,
        occurrences: f.occurrences,
        suppressed: f.suppressed,
      })),
    });
  }
  return impacted.slice(0, 30);
}

function loadExceptions(db, sourceId) {
  return all(db, 'SELECT * FROM exceptions WHERE source_id = ? AND active = 1', [sourceId]).map((r) => ({
    id: r.id,
    category: r.category,
    fieldPath: r.field_path,
    signature: r.signature,
    active: Boolean(r.active),
  }));
}

function persistBatch(db, source, { contract, payload, variant, label, mode, origin }) {
  const started = Date.now();
  const policy = normalizePolicy(parseJson(source.policy_json, DEFAULT_POLICY));
  const exceptions = loadExceptions(db, source.id);
  const contractFields = parseJson(contract.fields_json, []);

  let detection;
  try {
    detection = detectPayload({ fields: contractFields }, payload);
  } catch (error) {
    throw new ApiError(`载荷解析失败：${error.message}`, 400);
  }
  const enforced = enforceDetection(detection, {
    policy,
    versionPolicy: source.version_policy,
    contract: { fields: contractFields },
    exceptions,
  });

  if (mode === 'shadow') {
    // 观察模式只采集差异，不改变任何数据流可见状态；
    // recommendedAction 保留“若按当前策略会怎么处置”，避免观察数据被误读为合规。
    enforced.decision = 'accept';
    for (const finding of enforced.findings) {
      finding.recommendedAction = finding.action;
      finding.recommendedReason = finding.actionReason;
      finding.action = 'accept';
      finding.actionReason = '观察模式：仅记录差异，不执行处置';
    }
    for (const rec of enforced.records) {
      rec.recommendedAction = rec.action;
      rec.status = 'accepted';
      rec.action = 'accept';
    }
    enforced.counts = { accepted: detection.recordCount, quarantined: 0, blocked: 0 };
  }

  const findings = enforced.findings.map((f) => ({
    category: f.category,
    fieldPath: f.fieldPath,
    severity: f.severity,
    signature: f.signature,
    message: f.message,
    expected: f.expected,
    observed: f.observed,
    occurrences: f.occurrences,
    action: f.action,
    actionLabel: ACTION_META[f.action]?.label ?? f.action,
    actionReason: f.actionReason,
    recommendedAction: f.recommendedAction ?? null,
    recommendedReason: f.recommendedReason ?? null,
    suppressed: f.suppressed,
    exceptionId: f.exceptionId,
    notes: f.notes,
    samples: f.samples.slice(0, policy.sample_limit),
  }));

  const now = nowIso();
  const inserted = run(
    db,
    `INSERT INTO batches (source_id, contract_id, contract_version, variant, label, mode, origin, decision, counts_json, findings_json,
      normalization_json, meta_json, record_count, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      source.id,
      contract.id,
      contract.version,
      variant,
      String(label ?? '').slice(0, 120) || null,
      mode,
      origin,
      enforced.decision,
      JSON.stringify(enforced.counts),
      JSON.stringify(findings),
      JSON.stringify(detection.normalization),
      JSON.stringify(detection.metaDeclarations ?? {}),
      detection.recordCount,
      Date.now() - started,
      now,
    ],
  );
  const batchId = Number(inserted.lastInsertRowid);
  const records = Array.isArray(payload) ? payload : payload.records;
  let quarantined = 0;
  enforced.records.forEach((rec) => {
    if (rec.status === 'accepted') return;
    const record = records[rec.rowIndex];
    run(
      db,
      `INSERT INTO quarantine (batch_id, source_id, row_index, record_json, reasons_json, decision, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        batchId,
        source.id,
        rec.rowIndex,
        JSON.stringify(record),
        JSON.stringify(rec.reasons),
        rec.action,
        rec.status === 'blocked' ? 'blocked' : 'pending',
        now,
      ],
    );
    quarantined += 1;
  });

  if (enforced.decision !== 'accept' || findings.length) {
    logEvent(
      db,
      source.id,
      'batch_ingested',
      `${variant} 批次判定为${ACTION_META[enforced.decision]?.label ?? enforced.decision}（记录 ${detection.recordCount} 行，差异 ${findings.length} 类）`,
      { batchId, decision: enforced.decision, counts: enforced.counts },
    );
  }

  return getBatch(db, batchId);
}

export function ingest(db, slug, input = {}) {
  const row = sourceRow(db, slug);
  if (!row) throw new ApiError(`未找到数据源 ${slug}`, 404);
  const contract = contractByVersion(db, row.id, input.contractVersion);
  let payload = input.payload;
  let variant = input.variant ?? 'custom';
  let label = input.label;
  if (!payload) {
    if (!variant || variant === 'custom') throw new ApiError('要么提供 payload，要么提供模拟场景 variant');
    const catalogSource = CATALOG.find((s) => s.slug === row.slug);
    if (!catalogSource) throw new ApiError('该数据源没有本地模拟接口，请直接提供 payload');
    if (!catalogSource.variants.includes(variant)) throw new ApiError(`场景 ${variant} 不可用于该数据源`);
    payload = buildMockPayload(row.slug, variant, { seed: input.seed });
    label = label ?? `${VARIANT_META[variant]?.label ?? variant} · 模拟接口`;
  }
  if (!payload || typeof payload !== 'object') throw new ApiError('payload 必须是对象');
  const mode = input.mode === 'shadow' ? 'shadow' : 'live';
  return persistBatch(db, row, {
    contract,
    payload,
    variant,
    label,
    mode,
    origin: input.payload ? 'manual' : 'mock',
  });
}

export function listBatches(db, slug, { limit = 40 } = {}) {
  const row = sourceRow(db, slug);
  if (!row) throw new ApiError(`未找到数据源 ${slug}`, 404);
  return all(db, 'SELECT * FROM batches WHERE source_id = ? ORDER BY id DESC LIMIT ?', [row.id, Math.min(Number(limit) || 40, 200)]).map(
    (b) => presentBatch(b, { includeFindings: false }),
  );
}

export function getBatch(db, id) {
  const row = get(db, 'SELECT * FROM batches WHERE id = ?', [Number(id)]);
  if (!row) throw new ApiError(`未找到批次 ${id}`, 404);
  const survey = presentBatch(row);
  const source = get(db, 'SELECT * FROM sources WHERE id = ?', [row.source_id]);
  const quarantines = all(db, 'SELECT * FROM quarantine WHERE batch_id = ? ORDER BY row_index', [row.id]).map(presentQuarantine);
  return { ...survey, source: source ? presentSource(db, source) : null, quarantineRows: quarantines };
}

export function listQuarantine(db, slug, { status = 'all', limit = 100 } = {}) {
  const row = sourceRow(db, slug);
  if (!row) throw new ApiError(`未找到数据源 ${slug}`, 404);
  const where = ["source_id = ?"];
  const params = [row.id];
  if (status && status !== 'all') {
    where.push('status = ?');
    params.push(status);
  }
  params.push(Math.min(Number(limit) || 100, 500));
  const rows = all(db, `SELECT * FROM quarantine WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, params).map(presentQuarantine);
  const batchIds = [...new Set(rows.map((r) => r.batchId))];
  const batches = batchIds.length
    ? all(db, `SELECT * FROM batches WHERE id IN (${batchIds.map(() => '?').join(',')})`, batchIds).map((b) => presentBatch(b, { includeFindings: false }))
    : [];
  return { rows, batches };
}

function replayOne(db, qRow, contract, source) {
  const record = parseJson(qRow.record_json, null);
  const fields = parseJson(contract.fields_json, []);
  const payload = { records: [record], meta: {} };
  const detection = detectPayload({ fields }, payload);
  const policy = normalizePolicy(parseJson(source.policy_json, DEFAULT_POLICY));
  const enforced = enforceDetection(detection, {
    policy,
    versionPolicy: source.version_policy,
    contract: { fields },
    exceptions: loadExceptions(db, source.id),
  });
  const recordResult = enforced.records[0];
  const reasons = recordResult?.reasons ?? [];
  const decision = recordResult?.status === 'accepted' ? 'accepted' : recordResult?.status === 'quarantined' ? 'quarantined' : 'blocked';
  const status = decision === 'accepted' ? 'replayed_ok' : 'replayed_failed';
  const result = {
    contractVersion: contract.version,
    decision,
    actionLabel: ACTION_META[decision === 'accepted' ? 'accept' : decision === 'quarantined' ? 'quarantine' : 'block']?.label ?? decision,
    reasons,
    findings: enforced.findings.map((f) => ({
      category: f.category,
      categoryLabel: CATEGORY_META[f.category]?.label ?? f.category,
      fieldPath: f.fieldPath,
      message: f.message,
      action: f.action,
      suppressed: f.suppressed,
      samples: f.samples,
    })),
  };
  const now = nowIso();
  run(db, `INSERT INTO replays (quarantine_id, source_id, contract_id, decision, reasons_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
    qRow.id,
    source.id,
    contract.id,
    decision,
    JSON.stringify(reasons),
    now,
  ]);
  run(db, 'UPDATE quarantine SET status = ?, replay_result_json = ?, replayed_at = ? WHERE id = ?', [status, JSON.stringify(result), now, qRow.id]);
  logEvent(db, source.id, 'quarantine_replayed', `隔离记录 #${qRow.id} 回放：${result.actionLabel}（契约 ${contract.version}）`, {
    quarantineId: qRow.id,
    decision,
  });
  return { ...presentQuarantine(get(db, 'SELECT * FROM quarantine WHERE id = ?', [qRow.id])), newDecision: decision };
}

export function replayQuarantine(db, id, { contractVersion } = {}) {
  const qRow = get(db, 'SELECT * FROM quarantine WHERE id = ?', [Number(id)]);
  if (!qRow) throw new ApiError(`未找到隔离记录 ${id}`, 404);
  const source = get(db, 'SELECT * FROM sources WHERE id = ?', [qRow.source_id]);
  const contract = contractByVersion(db, source.id, contractVersion);
  return replayOne(db, qRow, contract, source);
}

export function replayAllQuarantine(db, slug, { contractVersion, status = 'pending', limit = 200 } = {}) {
  const row = sourceRow(db, slug);
  if (!row) throw new ApiError(`未找到数据源 ${slug}`, 404);
  const contract = contractByVersion(db, row.id, contractVersion);
  const params = [row.id];
  let where = 'source_id = ?';
  if (status && status !== 'all') {
    where += ' AND status = ?';
    params.push(status);
  }
  params.push(Math.min(Number(limit) || 200, 1000));
  const rows = all(db, `SELECT * FROM quarantine WHERE ${where} ORDER BY id LIMIT ?`, params);
  const results = rows.map((q) => replayOne(db, q, contract, row));
  return {
    contractVersion: contract.version,
    total: results.length,
    accepted: results.filter((r) => r.newDecision === 'accepted').length,
    quarantined: results.filter((r) => r.newDecision === 'quarantined').length,
    blocked: results.filter((r) => r.newDecision === 'blocked').length,
    results,
  };
}

export function createException(db, slug, input) {
  const row = sourceRow(db, slug);
  if (!row) throw new ApiError(`未找到数据源 ${slug}`, 404);
  if (!CATEGORY_META[input.category]) throw new ApiError(`未知漂移类别 ${input.category}`);
  if (!input.category || !input.fieldPath) throw new ApiError('例外需要指定类别与字段');
  let signature = input.signature;
  let sample = input.sample ?? null;
  let meta = null;
  if (input.batchId) {
    const batch = get(db, 'SELECT * FROM batches WHERE id = ? AND source_id = ?', [Number(input.batchId), row.id]);
    if (!batch) throw new ApiError('未找到指定的批次', 404);
    const finding = parseJson(batch.findings_json, []).find((f) => f.signature === signature || (f.category === input.category && f.fieldPath === input.fieldPath));
    if (!finding) throw new ApiError('批次中没有匹配的差异，无法登记例外', 404);
    signature = finding.signature;
    sample = finding.samples?.[0] ?? null;
    meta = { message: finding.message, expected: finding.expected, observed: finding.observed, batchId: batch.id, contractVersion: batch.contract_version };
  }
  if (!signature) {
    signature = signatureFor({ category: input.category, fieldPath: input.fieldPath, observed: input.observed ?? { type: 'unknown' } });
  }
  const existing = get(
    db,
    'SELECT * FROM exceptions WHERE source_id = ? AND category = ? AND field_path = ? AND signature = ?',
    [row.id, input.category, input.fieldPath, signature],
  );
  if (existing) throw new ApiError('相同类别、字段与签名的例外已存在', 409, { exceptionId: existing.id });
  const result = run(
    db,
    `INSERT INTO exceptions (source_id, category, field_path, signature, observed_json, record_json, meta_json, note, scope, active, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'entity', 1, ?, ?)`,
    [
      row.id,
      input.category,
      String(input.fieldPath).slice(0, 120),
      signature,
      JSON.stringify(meta?.observed ?? input.observed ?? null),
      JSON.stringify(sample),
      JSON.stringify(meta),
      String(input.note ?? '').slice(0, 400) || null,
      '本地控制台',
      nowIso(),
    ],
  );
  const created = get(db, 'SELECT * FROM exceptions WHERE id = ?', [result.lastInsertRowid]);
  logEvent(db, row.id, 'exception_created', `登记误报例外：${CATEGORY_META[input.category].label} · ${input.fieldPath}`, {
    exceptionId: created.id,
    signature,
  });
  return presentException(created);
}

export function previewExceptionImpact(db, slug, input) {
  const row = sourceRow(db, slug);
  if (!row) throw new ApiError(`未找到数据源 ${slug}`, 404);
  const category = input.category;
  const fieldPath = input.fieldPath;
  const signature = input.signature;
  if (!category || !fieldPath) throw new ApiError('需要 category 与 fieldPath');
  const batches = all(db, 'SELECT * FROM batches WHERE source_id = ? ORDER BY id DESC', [row.id]);
  const matches = [];
  let otherSignatureCount = 0;
  for (const batch of batches) {
    for (const finding of parseJson(batch.findings_json, [])) {
      if (finding.category !== category || finding.fieldPath !== fieldPath) continue;
      if (signature && finding.signature !== signature) {
        otherSignatureCount += 1;
        continue;
      }
      matches.push({
        batchId: batch.id,
        variant: batch.variant,
        label: batch.label,
        contractVersion: batch.contract_version,
        decision: batch.decision,
        createdAt: batch.created_at,
        signature: finding.signature,
        message: finding.message,
        observed: finding.observed,
        samples: finding.samples?.slice(0, 2) ?? [],
      });
    }
  }
  return {
    category,
    fieldPath,
    signature: signature ?? null,
    matchCount: matches.length,
    otherSignatureCount,
    matches,
    warning:
      matches.length && otherSignatureCount
        ? `该字段还有 ${otherSignatureCount} 处签名不同的同类漂移不受此例外影响，仍会被检测与处置。`
        : null,
  };
}

export function listExceptions(db, slug) {
  const row = sourceRow(db, slug);
  if (!row) throw new ApiError(`未找到数据源 ${slug}`, 404);
  const rows = all(db, 'SELECT * FROM exceptions WHERE source_id = ? ORDER BY id DESC', [row.id]);
  return rows.map((r) => {
    const exception = presentException(r);
    const batches = all(db, 'SELECT * FROM batches WHERE source_id = ?', [row.id]);
    let suppressed = 0;
    const affected = [];
    for (const batch of batches) {
      const hits = parseJson(batch.findings_json, []).filter(
        (f) => f.exceptionId === r.id || (f.category === r.category && f.fieldPath === r.field_path && f.signature === r.signature),
      );
      if (!hits.length) continue;
      suppressed += hits.reduce((sum, h) => sum + (h.occurrences ?? 0), 0);
      affected.push({
        batchId: batch.id,
        variant: batch.variant,
        decision: batch.decision,
        createdAt: batch.created_at,
        suppressed: hits.some((h) => h.suppressed),
      });
    }
    return { ...exception, suppressedOccurrences: suppressed, affectedBatches: affected.slice(0, 20), affectedBatchCount: affected.length };
  });
}

export function toggleException(db, id, active) {
  const row = get(db, 'SELECT * FROM exceptions WHERE id = ?', [Number(id)]);
  if (!row) throw new ApiError('未找到该例外', 404);
  run(db, 'UPDATE exceptions SET active = ? WHERE id = ?', [active ? 1 : 0, row.id]);
  const source = get(db, 'SELECT * FROM sources WHERE id = ?', [row.source_id]);
  logEvent(db, row.source_id, 'exception_toggled', `例外 #${row.id} ${active ? '启用' : '停用'}`, { exceptionId: row.id, active: Boolean(active) });
  return { exception: presentException(get(db, 'SELECT * FROM exceptions WHERE id = ?', [row.id])), source: source ? presentSource(db, source) : null };
}

export function exceptionImpact(db, id) {
  const row = get(db, 'SELECT * FROM exceptions WHERE id = ?', [Number(id)]);
  if (!row) throw new ApiError('未找到该例外', 404);
  const source = get(db, 'SELECT * FROM sources WHERE id = ?', [row.source_id]);
  return previewExceptionImpact(db, source.slug, { category: row.category, fieldPath: row.field_path, signature: row.signature });
}

export function overview(db) {
  const sources = listSources(db);
  const batches = all(db, 'SELECT * FROM batches ORDER BY id DESC LIMIT 40').map((b) => {
    const source = sources.find((s) => s.id === b.source_id);
    return { ...presentBatch(b, { includeFindings: false }), sourceName: source?.name, sourceSlug: source?.slug };
  });
  const allBatches = all(db, 'SELECT findings_json, counts_json FROM batches');
  const categoryTotals = {};
  let recorded = 0;
  let suppressed = 0;
  const rowTotals = { accepted: 0, quarantined: 0, blocked: 0 };
  for (const batch of allBatches) {
    for (const f of parseJson(batch.findings_json, [])) {
      categoryTotals[f.category] = (categoryTotals[f.category] ?? 0) + (f.occurrences ?? 1);
      recorded += f.occurrences ?? 1;
      if (f.suppressed) suppressed += f.occurrences ?? 1;
    }
    const counts = parseJson(batch.counts_json, {});
    for (const key of Object.keys(rowTotals)) rowTotals[key] += Number(counts[key] ?? 0);
  }
  const replayedOk = get(db, "SELECT COUNT(*) AS n FROM quarantine WHERE status = 'replayed_ok'");
  const replayedFailed = get(db, "SELECT COUNT(*) AS n FROM quarantine WHERE status = 'replayed_failed'");
  const pending = get(db, "SELECT COUNT(*) AS n FROM quarantine WHERE status = 'pending'");
  const total = get(db, 'SELECT COUNT(*) AS n FROM quarantine');
  const blocked = get(db, "SELECT COUNT(*) AS n FROM quarantine WHERE decision = 'block'");
  const events = all(db, 'SELECT * FROM events ORDER BY id DESC LIMIT 12').map((e) => ({
    ...e,
    detail: parseJson(e.detail_json, null),
    sourceName: sources.find((s) => s.id === e.source_id)?.name ?? null,
  }));
  return {
    sources,
    recentBatches: batches,
    categoryTotals,
    rowTotals: {
      ...rowTotals,
      pendingQuarantine: Number(pending?.n ?? 0),
      replayedOk: Number(replayedOk?.n ?? 0),
      replayedFailed: Number(replayedFailed?.n ?? 0),
    },
    totals: {
      batches: allBatches.length,
      recordedFindings: recorded,
      suppressedFindings: suppressed,
      pendingQuarantine: Number(pending?.n ?? 0),
      totalQuarantine: Number(total?.n ?? 0),
      blockedRows: Number(blocked?.n ?? 0),
      sources: sources.length,
    },
    events,
  };
}

export function sourceTimeline(db, slug) {
  const row = sourceRow(db, slug);
  if (!row) throw new ApiError(`未找到数据源 ${slug}`, 404);
  const batches = all(db, 'SELECT * FROM batches WHERE source_id = ? ORDER BY id ASC', [row.id]);
  return batches.map((b) => ({
    ...presentBatch(b, { includeFindings: false }),
  }));
}

/**
 * 自检：对每个模拟场景运行当前契约、策略与例外，回答两个问题：
 * 1) 良性形似样本是否被误判（误报）；
 * 2) 真实漂移是否漏检或被例外吞掉（漏报）。
 * 期望矩阵来自场景定义，不来自检测器自身，避免“自己验自己”。
 */
/**
 * 把历史观测到的“未声明字段”聚合成可选采纳的字段提案。
 * 类型取众数，并保留样本，避免盲目按单条记录定类型。
 */
export function fieldProposals(db, slug) {
  const row = sourceRow(db, slug);
  if (!row) throw new ApiError(`未找到数据源 ${slug}`, 404);
  const contract = activeContract(db, row.id);
  const fields = parseJson(contract.fields_json, []);
  const known = new Set(fields.map((f) => f.name));
  const proposals = new Map();
  for (const batch of all(db, 'SELECT * FROM batches WHERE source_id = ? ORDER BY id DESC', [row.id])) {
    for (const finding of parseJson(batch.findings_json, [])) {
      if (finding.category !== 'new_field' || known.has(finding.fieldPath)) continue;
      const entry = proposals.get(finding.fieldPath) ?? {
        name: finding.fieldPath,
        types: {},
        occurrences: 0,
        firstSeen: batch.created_at,
        batches: [],
        samples: [],
      };
      const type = finding.observed?.type ?? 'unknown';
      entry.types[type] = (entry.types[type] ?? 0) + 1;
      entry.occurrences += finding.occurrences ?? 1;
      entry.firstSeen = batch.created_at;
      if (entry.batches.length < 6) entry.batches.push({ id: batch.id, variant: batch.variant, decision: batch.decision, createdAt: batch.created_at });
      for (const sample of finding.samples ?? []) {
        if (entry.samples.length >= 4) break;
        const value = sample.record?.[finding.fieldPath];
        if (sameValue(entry.samples, value)) continue;
        entry.samples.push({ rowIndex: sample.rowIndex, value, batchId: batch.id });
      }
      proposals.set(finding.fieldPath, entry);
    }
  }
  return {
    contractVersion: contract.version,
    proposals: [...proposals.values()].map((p) => {
      const type = Object.entries(p.types).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'string';
      return {
        ...p,
        suggestedType: type,
        hasTypeDisagreement: Object.keys(p.types).length > 1,
        typeBreakdown: p.types,
        suggestedField: {
          name: p.name,
          type,
          required: false,
          nullable: true,
          label: p.name,
          description: '由漂移观测聚合生成，请复核语义与类型',
        },
      };
    }),
  };
}

function sameValue(list, value) {
  const key = JSON.stringify(value ?? null);
  return list.some((item) => JSON.stringify(item.value ?? null) === key);
}

export function verifySource(db, slug) {
  const row = sourceRow(db, slug);
  if (!row) throw new ApiError(`未找到数据源 ${slug}`, 404);
  const catalogSource = CATALOG.find((s) => s.slug === row.slug);
  if (!catalogSource) throw new ApiError('该数据源没有本地模拟接口，无法自检', 400);
  const contract = activeContract(db, row.id);
  const fields = parseJson(contract.fields_json, []);
  const policy = normalizePolicy(parseJson(row.policy_json, DEFAULT_POLICY));
  const exceptions = loadExceptions(db, row.id);
  const checks = [];

  for (const variant of catalogSource.variants) {
    const payload = buildMockPayload(row.slug, variant);
    const detection = detectPayload({ fields }, payload);
    const enforced = enforceDetection(detection, {
      policy,
      versionPolicy: row.version_policy,
      contract: { fields },
      exceptions,
    });
    // 契约一旦吸收了某个枚举扩展，该场景就不再应被期望为漂移；
    // 这样批准兼容版本后重跑自检仍然有效，而不是靠写死期望蒙混过关。
    let expected = [...(catalogSource.expectations?.[variant] ?? [])];
    const extension = catalogSource.enumExtension;
    if (extension && expected.includes('enum_extension')) {
      const field = fields.find((f) => f.name === extension.field);
      if (field?.enum?.includes(extension.value)) expected = expected.filter((c) => c !== 'enum_extension');
    }
    const allowedSuppressed = new Set(catalogSource.suppressible?.[variant] ?? []);
    const present = new Set(enforced.findings.map((f) => f.category));
    const missing = expected.filter((c) => !present.has(c));
    const suppressed = enforced.findings.filter((f) => f.suppressed);
    // 被例外压制但该类别不在本场景的“可豁免”清单中 → 真实漂移被吞
    const swallowed = suppressed.filter((f) => !allowedSuppressed.has(f.category));
    const brief = enforced.findings.map((f) => ({
      category: f.category,
      categoryLabel: CATEGORY_META[f.category]?.label ?? f.category,
      fieldPath: f.fieldPath,
      action: f.action,
      suppressed: f.suppressed,
      severity: f.severity,
      message: f.message,
      signature: f.signature,
    }));
    const benign = expected.length === 0;
    checks.push({
      variant,
      variantLabel: VARIANT_META[variant]?.label ?? variant,
      kind: benign ? 'no_false_positive' : 'drift_detected',
      pass: missing.length === 0 && swallowed.length === 0,
      expected: benign ? '不应产生任何漂移' : expected.map((c) => CATEGORY_META[c]?.label ?? c).join('、'),
      observed: [...present].map((c) => CATEGORY_META[c]?.label ?? c).join('、') || '无漂移',
      decision: enforced.decision,
      missing: missing.map((c) => CATEGORY_META[c]?.label ?? c),
      swallowed: swallowed.map((f) => `${CATEGORY_META[f.category]?.label ?? f.category} ${f.fieldPath}`),
      suppressed: suppressed.map((f) => `${CATEGORY_META[f.category]?.label ?? f.category} ${f.fieldPath}`),
      findings: brief,
    });
  }

  const passed = checks.filter((c) => c.pass).length;
  return {
    source: presentSource(db, row),
    contractVersion: contract.version,
    versionPolicy: row.version_policy,
    passed,
    total: checks.length,
    checks,
    verdict: passed === checks.length ? 'ok' : 'attention',
  };
}

/**
 * 演练台：对任意 JSON 载荷（不必落库）按某个数据源的契约与策略试算判定。
 * 用于排查“这条数据为什么被放行/阻断”，也方便验证例外是否只豁免了预期签名。
 */
export function playgroundDetect(db, input) {
  const slug = input.slug;
  const row = sourceRow(db, slug);
  if (!row) throw new ApiError(`未找到数据源 ${slug}`, 404);
  const contract = contractByVersion(db, row.id, input.contractVersion);
  const fields = parseJson(contract.fields_json, []);
  let records = input.payload;
  if (!records) throw new ApiError('请提供 payload（记录数组或 { records, meta }）');
  if (!Array.isArray(records) && typeof records === 'object' && Array.isArray(records.records)) {
    // 原样使用
  } else if (Array.isArray(records)) {
    records = { records, meta: input.meta ?? {} };
  } else {
    throw new ApiError('payload 必须是记录数组或 { records, meta }');
  }
  const detection = detectPayload({ fields }, records);
  const policy = normalizePolicy(parseJson(row.policy_json, DEFAULT_POLICY));
  const enforced = enforceDetection(detection, {
    policy,
    versionPolicy: row.version_policy,
    contract: { fields },
    exceptions: loadExceptions(db, row.id),
  });
  return {
    source: presentSource(db, row),
    contractVersion: contract.version,
    decision: enforced.decision,
    counts: enforced.counts,
    normalization: detection.normalization,
    findings: enforced.findings.map(presentFinding),
    records: enforced.records,
  };
}
