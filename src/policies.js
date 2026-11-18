/**
 * 漂移类别、默认处置策略与版本兼容策略。
 *
 * 重要设计原则：检测与处置分离。
 * - detectDrift() 只负责“是否发生了变化”，永远记录类别、严重度与样本；
 * - enforceDetection() 才根据策略决定 accept / quarantine / block。
 * 因此即使策略放行了某类漂移，漂移也不会从收件箱消失。
 */

export const CATEGORY_META = {
  new_field: {
    label: '新增字段',
    short: '新增',
    additive: true,
    defaultSeverity: 'info',
    description: '源端载荷出现了契约未声明的字段',
  },
  enum_extension: {
    label: '枚举扩展',
    short: '枚举扩展',
    additive: true,
    defaultSeverity: 'info',
    description: '源端声明并发送了契约枚举之外的新取值',
  },
  missing_required: {
    label: '必填字段缺失',
    short: '字段缺失',
    additive: false,
    defaultSeverity: 'breaking',
    description: '契约要求必填的字段在记录中缺失',
  },
  type_change: {
    label: '类型变更',
    short: '类型',
    additive: false,
    defaultSeverity: 'breaking',
    description: '字段 JSON 类型与契约不兼容（可无损归一化的数值字符串除外）',
  },
  enum_violation: {
    label: '枚举越界',
    short: '枚举越界',
    additive: false,
    defaultSeverity: 'breaking',
    description: '出现了源端未声明、契约也未允许的枚举值',
  },
  format_violation: {
    label: '格式漂移',
    short: '格式',
    additive: false,
    defaultSeverity: 'breaking',
    description: '日期、邮箱、UUID 等格式与契约声明不一致',
  },
  constraint_violation: {
    label: '约束违反',
    short: '约束',
    additive: false,
    defaultSeverity: 'breaking',
    description: '数值范围、长度、正则或非空约束被违反',
  },
  null_violation: {
    label: '空值违规',
    short: '空值',
    additive: false,
    defaultSeverity: 'breaking',
    description: '非空字段出现了 null',
  },
  semantic_conflict: {
    label: '语义冲突',
    short: '语义',
    additive: false,
    defaultSeverity: 'breaking',
    description: '源端声明的单位、量纲、日期格式或命名空间与契约语义不一致',
  },
  malformed_record: {
    label: '记录格式错误',
    short: '坏记录',
    additive: false,
    defaultSeverity: 'breaking',
    description: '记录不是合法的 JSON 对象',
  },
};

export const ACTION_RANK = { accept: 0, quarantine: 1, block: 2 };

export const ACTION_META = {
  accept: { label: '放行', tone: 'good' },
  quarantine: { label: '隔离', tone: 'warning' },
  block: { label: '阻断', tone: 'critical' },
};

export const VERSION_POLICIES = {
  additive_compatible: {
    label: '增量兼容',
    description:
      '新增字段与枚举扩展走类别策略；破坏性变化仍按类别处置。适合可向后兼容的常规数据源。',
  },
  strict: {
    label: '严格审批',
    description:
      '即使新增字段、枚举扩展也必须至少隔离并等待人工批准版本；破坏性变化按类别处理。',
  },
  pinned: {
    label: '版本锁定',
    description:
      '只接受与当前契约完全一致的载荷，任何漂移（包括新增字段）都会阻断。',
  },
};

export const DEFAULT_POLICY = {
  default_action: 'quarantine',
  sample_limit: 4,
  categories: {
    new_field: { action: 'accept' },
    enum_extension: { action: 'accept' },
    missing_required: { action: 'block' },
    type_change: { action: 'quarantine' },
    enum_violation: { action: 'quarantine' },
    format_violation: { action: 'quarantine' },
    constraint_violation: { action: 'quarantine' },
    null_violation: { action: 'quarantine' },
    semantic_conflict: { action: 'block' },
    malformed_record: { action: 'block' },
  },
};

function isAction(value) {
  return value === 'accept' || value === 'quarantine' || value === 'block';
}

export function maxAction(a, b) {
  return (ACTION_RANK[a] ?? 0) >= (ACTION_RANK[b] ?? 0) ? a : b;
}

export function normalizePolicy(input = {}) {
  const categories = {};
  for (const key of Object.keys(CATEGORY_META)) {
    const raw = input.categories?.[key];
    const action =
      isAction(raw) ? raw : isAction(raw?.action) ? raw.action : DEFAULT_POLICY.categories[key]?.action ?? input.default_action ?? 'quarantine';
    categories[key] = { action };
  }
  return {
    default_action: isAction(input.default_action) ? input.default_action : DEFAULT_POLICY.default_action,
    sample_limit:
      Number.isInteger(input.sample_limit) && input.sample_limit > 0
        ? Math.min(input.sample_limit, 10)
        : DEFAULT_POLICY.sample_limit,
    categories,
  };
}

/**
 * 把检测结果转换为处置结果。
 * 绝不在此函数里丢弃 finding；压制只把 action 降为 accept 并标记 suppressed。
 */
export function enforceDetection(detection, { policy, versionPolicy, contract, exceptions = [], sampleLimit } = {}) {
  const normalized = normalizePolicy(policy);
  const limit = sampleLimit ?? normalized.sample_limit;
  const fieldByName = new Map((contract?.fields ?? []).map((f) => [f.name, f]));

  const findings = detection.findings.map((finding) => {
    let action = normalized.categories[finding.category]?.action ?? normalized.default_action;
    let reason = `类别策略 ${CATEGORY_META[finding.category]?.label ?? finding.category}`;

    if (versionPolicy === 'pinned') {
      const pinned = maxAction(action, 'block');
      if (pinned !== action) {
        action = pinned;
        reason = '版本锁定：任何漂移均阻断';
      }
    } else if (versionPolicy === 'strict' && CATEGORY_META[finding.category]?.additive) {
      const strict = maxAction(action, 'quarantine');
      if (strict !== action) {
        action = strict;
        reason = '严格审批：增量变化需隔离待批准';
      }
    }

    const field = fieldByName.get(finding.fieldPath);
    const override = field?.policy?.[finding.category];
    if (isAction(override)) {
      action = override;
      reason = '字段级策略覆盖';
    }

    let suppressed = false;
    let exceptionId = null;
    const exception = exceptions.find(
      (e) =>
        e.active !== false &&
        e.category === finding.category &&
        e.fieldPath === finding.fieldPath &&
        e.signature === finding.signature,
    );
    if (exception) {
      suppressed = true;
      exceptionId = exception.id;
      action = 'accept';
      reason = '已登记误报例外（签名精确匹配）';
    }

    const trimmedSamples = finding.samples.slice(0, limit);
    return {
      ...finding,
      samples: trimmedSamples,
      action,
      suppressed,
      exceptionId,
      actionReason: reason,
    };
  });

  const byKey = new Map(findings.map((f) => [`${f.category}|${f.fieldPath}`, f]));

  const recordResults = detection.recordIssues.map((issues, rowIndex) => {
    let action = 'accept';
    const reasons = [];
    for (const issue of issues) {
      const finding = byKey.get(`${issue.category}|${issue.fieldPath}`);
      const resolved = finding?.action ?? 'accept';
      action = maxAction(action, resolved);
      reasons.push({
        category: issue.category,
        fieldPath: issue.fieldPath,
        severity: issue.severity,
        action: resolved,
        message: issue.message,
        expected: issue.expected,
        observed: issue.observed,
        suppressed: finding?.suppressed ?? false,
      });
    }
    return {
      rowIndex,
      action,
      status: action === 'accept' ? 'accepted' : action === 'quarantine' ? 'quarantined' : 'blocked',
      reasons,
    };
  });

  let decision = 'accept';
  for (const finding of findings) {
    if (!finding.suppressed || finding.action !== 'accept') {
      decision = maxAction(decision, finding.action);
    }
  }

  const counts = {
    accepted: recordResults.filter((r) => r.status === 'accepted').length,
    quarantined: recordResults.filter((r) => r.status === 'quarantined').length,
    blocked: recordResults.filter((r) => r.status === 'blocked').length,
  };

  return {
    findings,
    records: recordResults,
    decision,
    counts,
    normalization: detection.normalization ?? { coerced: 0, trimmed: 0 },
  };
}

export function policyForClient(policy) {
  return normalizePolicy(policy);
}
