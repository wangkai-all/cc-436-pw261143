/**
 * 契约版本管理：字段规范化、兼容性推导、版本号递增与冲突检测。
 * 兼容性结论由“字段级差异”推导，而不是由提交者自报，避免把破坏性变化伪装成兼容升级。
 */
import { CATEGORY_META } from './policies.js';

export const FIELD_TYPES = ['string', 'number', 'integer', 'boolean', 'date', 'date-time', 'object', 'array'];
export const FORMATS_BY_TYPE = {
  string: ['uuid', 'email', ''],
  date: ['date'],
  'date-time': ['date-time'],
};

const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

export function normalizeField(input, index = 0) {
  const name = String(input?.name ?? '').trim();
  if (!FIELD_NAME_RE.test(name)) {
    throw new Error(`字段名 "${name || '空'}" 必须是小写字母/数字/下划线，且以字母开头`);
  }
  const type = String(input.type ?? 'string');
  if (!FIELD_TYPES.includes(type)) throw new Error(`字段 ${name} 的类型 ${type} 不支持`);

  const enumValues = Array.isArray(input.enum)
    ? [...new Set(input.enum.map((v) => String(v).trim()).filter((v) => v.length > 0))]
    : [];
  if ((type === 'number' || type === 'integer') && enumValues.length) {
    throw new Error(`字段 ${name} 是数值类型，枚举请使用 min/max 约束`);
  }
  const numeric = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`字段 ${name} 的数值约束不是合法数字`);
    return n;
  };
  const intOrNull = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`字段 ${name} 的长度约束必须是非负整数`);
    return n;
  };
  const semanticText = (v) => {
    const text = v === null || v === undefined ? '' : String(v).trim();
    return text || undefined;
  };
  const semantics = input.semantics ?? {};
  const normalized = {
    id: String(input.id ?? `f${index}`),
    name,
    label: String(input.label ?? name).slice(0, 60),
    description: String(input.description ?? '').slice(0, 400),
    type,
    required: Boolean(input.required),
    nullable: Boolean(input.nullable),
    enum: enumValues,
    format: String(input.format ?? '').trim(),
    min: null,
    max: null,
    minLength: null,
    maxLength: null,
    pattern: '',
    semantics: {
      unit: semanticText(semantics.unit),
      scale: semantics.scale === undefined || semantics.scale === null || semantics.scale === '' ? undefined : Number(semantics.scale),
      dateFormat: semanticText(semantics.dateFormat),
      namespace: semanticText(semantics.namespace),
    },
    policy: {},
  };
  if (type === 'number' || type === 'integer') {
    normalized.min = numeric(input.min);
    normalized.max = numeric(input.max);
    if (normalized.min !== null && normalized.max !== null && normalized.min > normalized.max) {
      throw new Error(`字段 ${name} 的 min 不能大于 max`);
    }
    if (normalized.semantics.scale !== undefined && !(normalized.semantics.scale > 0)) {
      throw new Error(`字段 ${name} 的 scale 必须是正数`);
    }
  }
  if (type === 'string' || type === 'date' || type === 'date-time') {
    normalized.minLength = intOrNull(input.minLength);
    normalized.maxLength = intOrNull(input.maxLength);
    if (normalized.minLength !== null && normalized.maxLength !== null && normalized.minLength > normalized.maxLength) {
      throw new Error(`字段 ${name} 的 minLength 不能大于 maxLength`);
    }
    if (input.pattern) {
      try {
        new RegExp(String(input.pattern));
      } catch {
        throw new Error(`字段 ${name} 的正则表达式不合法`);
      }
      normalized.pattern = String(input.pattern);
    }
  }
  if (type === 'string' && input.format && !['uuid', 'email'].includes(input.format)) {
    throw new Error(`字段 ${name} 的格式 ${input.format} 不支持`);
  }
  if ((type === 'date' || type === 'date-time') && input.format && input.format !== type) {
    throw new Error(`字段 ${name} 的格式必须与类型一致`);
  }
  if (type === 'date' || type === 'date-time') normalized.format = type;
  if (Array.isArray(input.policy)) {
    for (const action of input.policy) {
      if (['accept', 'quarantine', 'block'].includes(action)) normalized.policy[action] = action;
    }
  } else if (input.policy && typeof input.policy === 'object') {
    for (const [cat, action] of Object.entries(input.policy)) {
      if (CATEGORY_META[cat] && ['accept', 'quarantine', 'block'].includes(action)) {
        normalized.policy[cat] = action;
      }
    }
  }
  return normalized;
}

export function normalizeContractFields(fields) {
  if (!Array.isArray(fields) || fields.length === 0) throw new Error('契约至少需要一个字段');
  const normalized = fields.map((f, i) => normalizeField(f, i));
  const seen = new Set();
  for (const field of normalized) {
    if (seen.has(field.name)) throw new Error(`字段名重复：${field.name}`);
    seen.add(field.name);
  }
  return normalized;
}

function shallowEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function constraintDiff(oldField, newField) {
  const diffs = [];
  const tighten = (key, label, lowerIsTighter = false) => {
    const before = oldField[key];
    const after = newField[key];
    if (shallowEqual(before, after)) return;
    let breaking = false;
    if (before === null || before === undefined) breaking = after !== null && after !== undefined;
    else if (after === null || after === undefined) breaking = false;
    else breaking = lowerIsTighter ? after > before : after < before;
    diffs.push({
      kind: 'constraint',
      constraint: key,
      label,
      from: before,
      to: after,
      breaking,
      detail: breaking
        ? `${label}收紧：${String(before ?? '无')} → ${String(after ?? '无')}，既有数据可能越界`
        : `${label}放宽：${String(before ?? '无')} → ${String(after ?? '无')}`,
    });
  };
  // 第二参数为 true 表示“数值变大 = 收紧”
  tighten('min', '最小值', true);
  tighten('max', '最大值');
  tighten('minLength', '最小长度', true);
  tighten('maxLength', '最大长度');
  if (!shallowEqual(oldField.pattern, newField.pattern)) {
    diffs.push({
      kind: 'constraint',
      constraint: 'pattern',
      label: '正则',
      from: oldField.pattern,
      to: newField.pattern,
      breaking: Boolean(newField.pattern),
      detail: newField.pattern ? '新增/修改正则收紧格式要求' : '移除正则',
    });
  }
  return diffs;
}

function semanticsDiff(oldField, newField) {
  const diffs = [];
  for (const key of ['unit', 'scale', 'dateFormat', 'namespace']) {
    const before = oldField.semantics?.[key];
    const after = newField.semantics?.[key];
    if (shallowEqual(before, after)) continue;
    diffs.push({
      kind: 'semantics',
      aspect: key,
      from: before ?? null,
      to: after ?? null,
      breaking: true,
      detail: `语义变更 ${key}：${String(before ?? '未声明')} → ${String(after ?? '未声明')}，历史数据不可直接比较`,
    });
  }
  return diffs;
}

/**
 * 对比两版字段，推导兼容性。
 * compatibility: identical | forward_compatible | breaking
 */
export function diffContracts(oldFields = [], newFields = []) {
  const oldMap = new Map(oldFields.map((f) => [f.name, f]));
  const newMap = new Map(newFields.map((f) => [f.name, f]));
  const changes = [];

  for (const [name, field] of oldMap) {
    if (!newMap.has(name)) {
      changes.push({
        kind: 'removed',
        fieldPath: name,
        breaking: true,
        detail: `字段 ${name} 被移除`,
        from: { type: field.type, required: field.required },
        to: null,
      });
    }
  }

  for (const [name, field] of newMap) {
    const before = oldMap.get(name);
    if (!before) {
      changes.push({
        kind: 'added',
        fieldPath: name,
        // 可选字段是纯增量；必填字段会让历史记录与新批次立即不满足契约，必须走破坏性流程。
        breaking: Boolean(field.required),
        detail: `新增${field.required ? '必填' : '可选'}字段 ${name}`,
        from: null,
        to: { type: field.type, required: field.required },
      });
      continue;
    }
    if (before.type !== field.type) {
      changes.push({
        kind: 'type',
        fieldPath: name,
        breaking: true,
        detail: `字段 ${name} 类型 ${before.type} → ${field.type}`,
        from: before.type,
        to: field.type,
      });
      continue;
    }
    if (!before.required && field.required) {
      changes.push({
        kind: 'required',
        fieldPath: name,
        breaking: true,
        detail: `字段 ${name} 由可选变为必填`,
        from: false,
        to: true,
      });
    } else if (before.required && !field.required) {
      changes.push({
        kind: 'required',
        fieldPath: name,
        breaking: false,
        detail: `字段 ${name} 由必填变为可选`,
        from: true,
        to: false,
      });
    }
    if (!before.nullable && field.nullable) {
      changes.push({ kind: 'nullable', fieldPath: name, breaking: false, detail: `字段 ${name} 允许 null`, from: false, to: true });
    } else if (before.nullable && !field.nullable) {
      changes.push({ kind: 'nullable', fieldPath: name, breaking: true, detail: `字段 ${name} 不再允许 null`, from: true, to: false });
    }

    const beforeEnum = before.enum ?? [];
    const afterEnum = field.enum ?? [];
    const removedValues = beforeEnum.filter((v) => !afterEnum.includes(v));
    const addedValues = afterEnum.filter((v) => !beforeEnum.includes(v));
    if (removedValues.length) {
      changes.push({
        kind: 'enum',
        fieldPath: name,
        breaking: true,
        detail: `枚举收缩/改写：移除 ${removedValues.map((v) => `"${v}"`).join('、')}`,
        from: beforeEnum,
        to: afterEnum,
      });
    }
    if (addedValues.length) {
      changes.push({
        kind: 'enum',
        fieldPath: name,
        breaking: false,
        detail: `枚举扩展：新增 ${addedValues.map((v) => `"${v}"`).join('、')}`,
        from: beforeEnum,
        to: afterEnum,
      });
    }

    if (!shallowEqual(before.format, field.format)) {
      changes.push({
        kind: 'format',
        fieldPath: name,
        breaking: Boolean(field.format),
        detail: field.format ? `格式约束 ${before.format || '无'} → ${field.format}` : `移除格式约束 ${before.format}`,
        from: before.format || null,
        to: field.format || null,
      });
    }
    changes.push(...constraintDiff(before, field).map((c) => ({ ...c, fieldPath: name })));
    changes.push(...semanticsDiff(before, field).map((c) => ({ ...c, fieldPath: name })));
  }

  const hasBreaking = changes.some((c) => c.breaking);
  let compatibility = 'identical';
  if (changes.length) compatibility = hasBreaking ? 'breaking' : 'forward_compatible';

  return {
    changes,
    compatibility,
    breakingCount: changes.filter((c) => c.breaking).length,
    summary: summarizeChanges(changes),
  };
}

function summarizeChanges(changes) {
  if (!changes.length) return '字段定义无有意义的差异';
  const breaking = changes.filter((c) => c.breaking);
  const safe = changes.filter((c) => !c.breaking);
  const parts = [];
  if (breaking.length) parts.push(`${breaking.length} 项破坏性变化`);
  if (safe.length) parts.push(`${safe.length} 项前向兼容变化`);
  return parts.join('，');
}

export function bumpVersion(version, compatibility) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? ''));
  if (!match) return '1.0.0';
  const [major, minor, patch] = match.slice(1).map(Number);
  if (compatibility === 'breaking') return `${major + 1}.0.0`;
  if (compatibility === 'forward_compatible') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function validateVersionString(version) {
  return /^\d+\.\d+\.\d+$/.test(String(version ?? ''));
}

/** 把检测到的观测字段形状转成可提交的字段提案。 */
export function proposeFieldFromObservation({ name, samples, suggestedType, existingFields = [] }) {
  const base = {
    name,
    label: name,
    type: suggestedType ?? 'string',
    required: false,
    nullable: true,
    description: '由漂移观测自动生成，请复核类型与语义',
  };
  if (samples?.length) {
    const values = samples.map((s) => s.observed?.value ?? s.record?.[name]).filter((v) => v !== undefined);
    if (base.type === 'string') {
      const strings = values.filter((v) => typeof v === 'string');
      if (strings.length) base.enum = [...new Set(strings)];
    }
  }
  if (existingFields.some((f) => f.name === name)) return { ...base, conflict: true };
  return base;
}
