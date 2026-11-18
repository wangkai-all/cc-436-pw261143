import crypto from 'node:crypto';
import { CATEGORY_META } from './policies.js';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const NUMERIC_STRING_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

/** 类型形状，用于签名分桶：同类变形归为一类，不同变形不共用例外。 */
function shapeOf(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return depth > 1 ? 'array' : `array<${value.map((v) => shapeOf(v, depth + 1)).sort().join('|')}>`;
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') {
    return value
      .replace(/[0-9]/g, '9')
      .replace(/[a-z]/g, 'a')
      .replace(/[A-Z]/g, 'A')
      .slice(0, 80);
  }
  return typeof value;
}

/**
 * 例外签名使用的形状指纹。
 * 目标是“同类误报可一次豁免，真实漂移不共用签名”：
 * - 字符串只记类型，数值字符串与对象/数组/布尔则天然分开；
 * - 对象记键名，{cents} 与 {value,unit} 不共用；
 * - 枚举越界精确到值；
 * - 格式/约束精确到规则与阈值，而非具体取值。
 */
export function signatureShape(value, { keys = false } = {}) {
  const type = jsonType(value);
  if (keys && type === 'object') return { type, keys: Object.keys(value).sort() };
  if (keys && type === 'array') return { type, keys: value.length ? [shapeOf(value[0])] : [] };
  return { type };
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function signatureFor({ category, fieldPath, observed }) {
  return crypto.createHash('sha1').update(stableStringify({ category, fieldPath, observed })).digest('hex').slice(0, 16);
}

export function truncateValue(value, max = 180) {
  let text;
  try {
    text = typeof value === 'string' ? value : stableStringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function collectSamples(target, owner, limit) {
  if (target.length >= limit) return;
  const key = stableStringify(owner);
  if (target.some((s) => s._key === key)) return;
  target.push({ ...owner, _key: key });
}

function addFinding(ctx, { category, fieldPath, severity, message, expected, observed, signatureBasis, sample, note }) {
  const signature = signatureFor({ category, fieldPath, observed: signatureBasis ?? observed });
  const key = `${category}|${fieldPath}|${signature}`;
  let finding = ctx.findings.get(key);
  if (!finding) {
    finding = {
      category,
      fieldPath,
      severity: severity ?? CATEGORY_META[category]?.defaultSeverity ?? 'warning',
      signature,
      message,
      expected: expected ?? null,
      observed: observed ?? null,
      occurrences: 0,
      samples: [],
      notes: [],
    };
    ctx.findings.set(key, finding);
  }
  finding.occurrences += 1;
  if (note && !finding.notes.includes(note)) finding.notes.push(note);
  if (sample) {
    collectSamples(finding.samples, { rowIndex: sample.rowIndex, record: sample.record, observed: observed ?? null, note: note ?? null }, 10);
  }
  if (ctx.currentRow !== null && ctx.currentRow !== undefined) {
    const rowIssues = ctx.recordIssues.get(ctx.currentRow) ?? [];
    rowIssues.push({ category, fieldPath, signature, severity: finding.severity, message, expected: expected ?? null, observed: observed ?? null });
    ctx.recordIssues.set(ctx.currentRow, rowIssues);
  }
  return finding;
}

function coerceNumeric(value, expectedType) {
  if (typeof value !== 'string') return { ok: false };
  const text = value.trim();
  if (!NUMERIC_STRING_RE.test(text)) return { ok: false };
  const number = Number(text);
  if (!Number.isFinite(number)) return { ok: false };
  if (expectedType === 'integer' && !Number.isInteger(number)) return { ok: false };
  return { ok: true, value: number };
}

function validDate(value) {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validDateTime(value) {
  if (!DATETIME_RE.test(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
}

function checkFormat(field, value) {
  const format = field.format ?? (field.type === 'date' ? 'date' : field.type === 'date-time' ? 'date-time' : null);
  if (!format) return null;
  if (format === 'uuid' && !UUID_RE.test(value)) return { format, rule: 'uuid' };
  if (format === 'email' && !EMAIL_RE.test(value)) return { format, rule: 'email' };
  if (format === 'date' && !validDate(value)) return { format, rule: 'date' };
  if (format === 'date-time' && !validDateTime(value)) return { format, rule: 'date-time' };
  return null;
}

function semanticConflictsForField(field, meta) {
  const conflicts = [];
  const semantics = field.semantics ?? {};
  const unit = meta.units?.[field.name];
  if (unit !== undefined && semantics.unit !== undefined && unit !== semantics.unit) {
    conflicts.push({ aspect: 'unit', expected: semantics.unit, observed: unit, label: '单位' });
  }
  const scale = meta.scales?.[field.name];
  if (scale !== undefined && semantics.scale !== undefined && Number(scale) !== Number(semantics.scale)) {
    conflicts.push({ aspect: 'scale', expected: semantics.scale, observed: scale, label: '量纲/精度' });
  }
  const dateFormat = meta.dateFormats?.[field.name];
  if (dateFormat !== undefined && semantics.dateFormat !== undefined && dateFormat !== semantics.dateFormat) {
    conflicts.push({ aspect: 'dateFormat', expected: semantics.dateFormat, observed: dateFormat, label: '日期格式' });
  }
  const namespace = meta.namespaces?.[field.name];
  if (namespace !== undefined && semantics.namespace !== undefined && namespace !== semantics.namespace) {
    conflicts.push({ aspect: 'namespace', expected: semantics.namespace, observed: namespace, label: '命名空间' });
  }
  return conflicts;
}

/**
 * 纯检测：只报告“数据与契约的差异”，不决定放行/隔离/阻断。
 * 处置策略在 policies.enforceDetection() 中叠加。
 */
export function detectPayload(contract, payload) {
  if (!contract?.fields) throw new Error('缺少契约字段定义');
  const records = Array.isArray(payload) ? payload : payload?.records;
  if (!Array.isArray(records)) throw new Error('模拟载荷缺少 records 数组');
  const meta = (!Array.isArray(payload) && payload?.meta) || {};

  const ctx = { findings: new Map(), recordIssues: new Map(), currentRow: null };
  const normalization = { coerced: 0, details: [] };
  const semanticByField = new Map();
  const fields = contract.fields;

  for (const field of fields) {
    const conflicts = semanticConflictsForField(field, meta);
    if (!conflicts.length) continue;
    semanticByField.set(field.name, conflicts);
    // 同一字段的多个语义维度（如单位+精度）合并为一条差异，避免同一根因刷屏；
    // 签名仍包含全部维度与取值，例外的精确匹配不受影响。
    const aspects = conflicts.map((c) => ({
      aspect: c.aspect,
      label: c.label,
      expected: c.expected,
      observed: c.observed,
    }));
    addFinding(ctx, {
      category: 'semantic_conflict',
      fieldPath: field.name,
      severity: 'breaking',
      message: `${field.name} 的语义与契约不一致：${conflicts
        .map((c) => `${c.label} 契约要求 ${truncateValue(c.expected)}，源端声明 ${truncateValue(c.observed)}`)
        .join('；')}`,
      expected: { semantics: Object.fromEntries(conflicts.map((c) => [c.aspect, c.expected])) },
      observed: { semantics: Object.fromEntries(conflicts.map((c) => [c.aspect, c.observed])) },
      signatureBasis: { aspects: aspects.map((a) => [a.aspect, a.observed]) },
      sample: { rowIndex: null, record: { meta: `${field.name}`, conflicts: aspects } },
      note: '语义不一致，已跳过该字段的值级校验',
    });
  }

  records.forEach((record, rowIndex) => {
    ctx.currentRow = rowIndex;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      addFinding(ctx, {
        category: 'malformed_record',
        fieldPath: '$',
        severity: 'breaking',
        message: `第 ${rowIndex + 1} 行不是 JSON 对象`,
        expected: { type: 'object' },
        observed: { type: jsonType(record) },
        sample: { rowIndex, record: { raw: truncateValue(record) } },
      });
      ctx.currentRow = null;
      return;
    }

    const declared = new Set(fields.map((f) => f.name));
    for (const key of Object.keys(record)) {
      if (declared.has(key)) continue;
      const actualType = jsonType(record[key]);
      addFinding(ctx, {
        category: 'new_field',
        fieldPath: key,
        severity: 'info',
        message: `出现契约未声明的新字段 ${key}（${actualType}）`,
        expected: { declared: false },
        observed: { type: actualType },
        signatureBasis: { type: actualType, shape: signatureShape(record[key], { keys: true }) },
        sample: { rowIndex, record },
        note: '增量变化：检测层始终记录，处置由策略决定',
      });
    }

    for (const field of fields) {
      const present = Object.prototype.hasOwnProperty.call(record, field.name);
      if (!present) {
        if (field.required) {
          addFinding(ctx, {
            category: 'missing_required',
            fieldPath: field.name,
            severity: 'breaking',
            message: `必填字段 ${field.name} 缺失`,
            expected: { required: true, type: field.type },
            observed: { missing: true },
            sample: { rowIndex, record },
          });
        }
        continue;
      }

      const rawValue = record[field.name];
      if (rawValue === null) {
        if (!field.nullable) {
          addFinding(ctx, {
            category: 'null_violation',
            fieldPath: field.name,
            severity: 'breaking',
            message: `非空字段 ${field.name} 出现 null`,
            expected: { nullable: false },
            observed: { null: true },
            sample: { rowIndex, record },
          });
        }
        continue;
      }

      if (semanticByField.has(field.name)) continue;

      let value = rawValue;
      const actualType = jsonType(rawValue);
      let typeMismatch = null;

      if (field.type === 'number' || field.type === 'integer') {
        if (actualType === 'integer' || actualType === 'number') {
          if (field.type === 'integer' && actualType === 'number') typeMismatch = actualType;
          else value = rawValue;
        } else if (actualType === 'string') {
          const coerced = coerceNumeric(rawValue, field.type);
          if (coerced.ok) {
            value = coerced.value;
            normalization.coerced += 1;
            if (normalization.details.length < 12) {
              normalization.details.push({ fieldPath: field.name, rowIndex, from: actualType, to: field.type, raw: truncateValue(rawValue, 40) });
            }
          } else {
            typeMismatch = actualType;
          }
        } else {
          typeMismatch = actualType;
        }
      } else if (field.type === 'string') {
        if (actualType !== 'string') typeMismatch = actualType;
      } else if (field.type === 'boolean') {
        if (actualType !== 'boolean') typeMismatch = actualType;
      } else if (field.type === 'object') {
        if (actualType !== 'object') typeMismatch = actualType;
      } else if (field.type === 'array') {
        if (actualType !== 'array') typeMismatch = actualType;
      } else if (field.type === 'date' || field.type === 'date-time') {
        if (actualType !== 'string') typeMismatch = actualType;
      }

      if (typeMismatch) {
        addFinding(ctx, {
          category: 'type_change',
          fieldPath: field.name,
          severity: 'breaking',
          message: `${field.name} 期望 ${field.type}，实际 ${typeMismatch}`,
          expected: { type: field.type },
          observed: { type: typeMismatch, shape: shapeOf(rawValue) },
          signatureBasis: { target: field.type, observed: signatureShape(rawValue, { keys: true }) },
          sample: { rowIndex, record },
        });
        continue;
      }

      if (Array.isArray(field.enum) && field.enum.length) {
        if (!field.enum.includes(value)) {
          const declared = Array.isArray(meta.declaredEnums?.[field.name]) ? meta.declaredEnums[field.name] : [];
          const extension = declared.includes(value);
          addFinding(ctx, {
            category: extension ? 'enum_extension' : 'enum_violation',
            fieldPath: field.name,
            severity: extension ? 'info' : 'warning',
            message: extension
              ? `源端已声明并发送新枚举值 ${field.name}=${truncateValue(value, 60)}`
              : `枚举值越界：${field.name}=${truncateValue(value, 60)} 既不在契约中，也未由源端声明`,
            expected: { enum: field.enum },
            observed: { value },
            signatureBasis: { value },
            sample: { rowIndex, record },
            note: extension ? '增量变化：已记录声明来源 meta.declaredEnums' : '未声明的枚举值可能是拼写错误或语义变更',
          });
          continue;
        }
      }

      if (typeof value === 'string') {
        const formatIssue = checkFormat(field, value);
        if (formatIssue) {
          addFinding(ctx, {
            category: 'format_violation',
            fieldPath: field.name,
            severity: 'warning',
            message: `${field.name} 不符合 ${formatIssue.rule} 格式：${truncateValue(value, 60)}`,
            expected: { format: formatIssue.rule },
            observed: { shape: shapeOf(value) },
            signatureBasis: { rule: formatIssue.format },
            sample: { rowIndex, record },
          });
          continue;
        }
      }

      const violations = [];
      if (typeof value === 'number') {
        if (field.min !== null && field.min !== undefined && value < field.min) violations.push({ rule: 'min', expected: field.min, observed: value });
        if (field.max !== null && field.max !== undefined && value > field.max) violations.push({ rule: 'max', expected: field.max, observed: value });
      }
      if (typeof value === 'string') {
        if (field.minLength !== null && field.minLength !== undefined && value.length < field.minLength) violations.push({ rule: 'minLength', expected: field.minLength, observed: value.length });
        if (field.maxLength !== null && field.maxLength !== undefined && value.length > field.maxLength) violations.push({ rule: 'maxLength', expected: field.maxLength, observed: value.length });
        if (field.pattern) {
          let ok = true;
          try {
            ok = new RegExp(field.pattern).test(value);
          } catch {
            ok = true;
          }
          if (!ok) violations.push({ rule: 'pattern', expected: field.pattern, observed: shapeOf(value) });
        }
      }
      for (const violation of violations) {
        addFinding(ctx, {
          category: 'constraint_violation',
          fieldPath: field.name,
          severity: 'warning',
          message: `${field.name} 违反 ${violation.rule} 约束：期望 ${truncateValue(violation.expected)}，实际 ${truncateValue(violation.observed)}`,
          expected: { [violation.rule]: violation.expected },
          observed: { [violation.rule]: violation.observed },
          signatureBasis: { rule: violation.rule, expected: violation.expected },
          sample: { rowIndex, record },
        });
      }
    }
    ctx.currentRow = null;
  });

  // 语义冲突是载荷级问题：单位/量纲不可信时，整批记录都不能当作已校验数据。
  for (const finding of ctx.findings.values()) {
    if (finding.category !== 'semantic_conflict') continue;
    let affected = 0;
    records.forEach((_, rowIndex) => {
      if (!records[rowIndex] || typeof records[rowIndex] !== 'object' || Array.isArray(records[rowIndex])) return;
      const issues = ctx.recordIssues.get(rowIndex) ?? [];
      if (!issues.some((i) => i.category === 'semantic_conflict' && i.fieldPath === finding.fieldPath)) {
        issues.push({
          category: 'semantic_conflict',
          fieldPath: finding.fieldPath,
          signature: finding.signature,
          severity: finding.severity,
          message: finding.message,
          expected: finding.expected ?? null,
          observed: finding.observed ?? null,
        });
        ctx.recordIssues.set(rowIndex, issues);
      }
      affected += 1;
    });
    // 载荷级问题按“受影响记录数”计数，而不是 1 条载荷 + N 条记录重复计数
    finding.occurrences = affected;
  }

  const findings = [...ctx.findings.values()].map((f) => ({
    ...f,
    samples: f.samples.map(({ _key, ...sample }) => sample),
  }));

  return {
    findings,
    recordIssues: records.map((_, rowIndex) => ctx.recordIssues.get(rowIndex) ?? []),
    normalization,
    recordCount: records.length,
    metaDeclarations: {
      declaredEnums: meta.declaredEnums ?? {},
      units: meta.units ?? {},
      dateFormats: meta.dateFormats ?? {},
      scales: meta.scales ?? {},
      namespaces: meta.namespaces ?? {},
    },
  };
}

export function summarizeCategories(findings) {
  const counts = {};
  for (const finding of findings) {
    counts[finding.category] = (counts[finding.category] ?? 0) + 1;
  }
  return counts;
}
