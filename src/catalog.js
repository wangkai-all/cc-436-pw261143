/**
 * 演示数据源目录：契约（含语义声明）+ 本地模拟接口的载荷生成器。
 * 每一个 variant 都对应一种真实世界中常见的演化方式。
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

function hex(rand, len) {
  let out = '';
  for (let i = 0; i < len; i += 1) out += '0123456789abcdef'[Math.floor(rand() * 16)];
  return out;
}

function uuid(rand) {
  return `${hex(rand, 8)}-${hex(rand, 4)}-4${hex(rand, 3)}-a${hex(rand, 3)}-${hex(rand, 12)}`;
}

export const VARIANT_META = {
  clean: { label: '基线合规', hint: '与当前契约完全一致', tone: 'good' },
  new_field: { label: '新增字段', hint: '源端多发了未声明字段', tone: 'info' },
  enum_extension: { label: '枚举扩展', hint: '源端声明并发送新枚举值', tone: 'info' },
  type_change: { label: '类型变更', hint: '字段 JSON 类型改变', tone: 'serious' },
  missing_required: { label: '字段缺失', hint: '必填字段消失', tone: 'critical' },
  semantic_conflict: { label: '语义冲突', hint: '单位或量纲变化，值域仍合法', tone: 'critical' },
  mixed: { label: '混合漂移', hint: '增量变化与破坏性变化并存', tone: 'warning' },
  benign_lookalike: { label: '疑似但合规', hint: '数值字符串、声明枚举、可空字段缺省', tone: 'good' },
  vendor_extra: { label: '供应商附加字段', hint: '已知的良性附加字段', tone: 'info' },
  vendor_extra_regression: { label: '附加字段变体升级', hint: '同名字段类型发生真实变化', tone: 'critical' },
  enum_typo: { label: '枚举拼写错误', hint: '形似新枚举但源端未声明', tone: 'critical' },
};

function money(rand, min, max) {
  return Math.round((min + rand() * (max - min)) * 100) / 100;
}

function dateTime(rand, dayOffset = 0, withMs = false) {
  const base = Date.UTC(2026, 10, 10 + dayOffset, 8 + Math.floor(rand() * 10), Math.floor(rand() * 60), Math.floor(rand() * 60));
  const iso = new Date(base).toISOString();
  if (withMs) return iso;
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

export const CATALOG = [
  {
    slug: 'retail-orders',
    name: '零售订单流',
    domain: '交易',
    owner: '订单平台组',
    description: '来自订单中台的增量订单事件，按小时同步。',
    versionPolicy: 'additive_compatible',
    contractVersion: '1.1.0',
    fields: [
      { name: 'order_id', label: '订单号', type: 'string', required: true, nullable: false, format: 'uuid' },
      {
        name: 'customer_id',
        label: '客户号',
        type: 'string',
        required: true,
        nullable: false,
        pattern: '^CUS-\\d{6}$',
      },
      {
        name: 'status',
        label: '订单状态',
        type: 'string',
        required: true,
        nullable: false,
        enum: ['created', 'paid', 'shipped', 'delivered', 'cancelled'],
      },
      {
        name: 'amount',
        label: '订单金额',
        type: 'number',
        required: true,
        nullable: false,
        min: 0,
        max: 1000000,
        semantics: { unit: 'CNY', scale: 1 },
      },
      { name: 'quantity', label: '件数', type: 'integer', required: true, nullable: false, min: 1, max: 1000 },
      { name: 'currency', label: '币种', type: 'string', required: true, nullable: false, enum: ['CNY', 'USD'] },
      { name: 'created_at', label: '下单时间', type: 'date-time', required: true, nullable: false, format: 'date-time' },
      {
        name: 'channel',
        label: '渠道',
        type: 'string',
        required: false,
        nullable: true,
        enum: ['web', 'app', 'store'],
      },
      { name: 'coupon_code', label: '优惠码', type: 'string', required: false, nullable: true, maxLength: 24 },
    ],
    expectations: {
      clean: [],
      benign_lookalike: [],
      new_field: ['new_field'],
      enum_extension: ['enum_extension'],
      type_change: ['type_change'],
      missing_required: ['missing_required'],
      semantic_conflict: ['semantic_conflict'],
      mixed: ['new_field', 'enum_extension', 'missing_required', 'type_change'],
      vendor_extra: ['new_field'],
      vendor_extra_regression: ['new_field', 'type_change'],
      enum_typo: ['enum_violation'],
    },
    suppressible: { mixed: ['new_field'], new_field: [], vendor_extra: [], vendor_extra_regression: [], enum_typo: [] },
    enumExtension: { field: 'status', value: 'returned' },
    variants: [
      'clean',
      'new_field',
      'enum_extension',
      'type_change',
      'missing_required',
      'semantic_conflict',
      'mixed',
      'benign_lookalike',
      'vendor_extra',
      'vendor_extra_regression',
      'enum_typo',
    ],
    build(rand, variant) {
      const records = Array.from({ length: 12 }, (_, i) => ({
        order_id: uuid(rand),
        customer_id: `CUS-${String(100000 + Math.floor(rand() * 899999))}`,
        status: pick(rand, ['created', 'paid', 'shipped', 'delivered', 'cancelled']),
        amount: money(rand, 19, 8800),
        quantity: 1 + Math.floor(rand() * 6),
        currency: rand() > 0.12 ? 'CNY' : 'USD',
        created_at: dateTime(rand, i % 5),
        channel: pick(rand, ['web', 'app', 'store']),
        coupon_code: rand() > 0.55 ? `SAVE${Math.floor(rand() * 90 + 10)}` : null,
      }));
      const meta = {};

      switch (variant) {
        case 'new_field':
          records.forEach((r, i) => {
            r.loyalty_tier = pick(rand, ['silver', 'gold', 'platinum']);
            if (i % 4 === 0) r.gift_wrap = rand() > 0.5;
          });
          break;
        case 'enum_extension':
          records[2].status = 'returned';
          records[7].status = 'returned';
          meta.declaredEnums = { status: ['returned'] };
          break;
        case 'enum_typo':
          records[2].status = 'RETURNED';
          records[7].status = 'retruned';
          break;
        case 'type_change':
          records[1].quantity = { value: 3, unit: 'pcs' };
          records[4].quantity = 'two';
          records[6].amount = { cents: 129900 };
          records[9].order_id = 984512;
          break;
        case 'missing_required':
          delete records[3].customer_id;
          delete records[8].customer_id;
          delete records[10].amount;
          break;
        case 'semantic_conflict':
          meta.units = { amount: 'CNY-cent' };
          meta.scales = { amount: 100 };
          records.forEach((r) => {
            r.amount = Math.round(r.amount * 100);
          });
          break;
        case 'mixed':
          records[2].status = 'returned';
          meta.declaredEnums = { status: ['returned'] };
          records.forEach((r) => {
            r.loyalty_tier = 'gold';
          });
          delete records[5].customer_id;
          records[10].quantity = 'many';
          break;
        case 'benign_lookalike':
          records.forEach((r, i) => {
            r.amount = r.amount.toFixed(2);
            if (i % 3 === 0) r.quantity = String(r.quantity);
            r.created_at = dateTime(rand, i % 5, true).replace('Z', '+08:00');
          });
          break;
        case 'vendor_extra':
          records.forEach((r) => {
            r.loyalty_tier = 'gold';
          });
          break;
        case 'vendor_extra_regression':
          records.forEach((r) => {
            r.loyalty_tier = { level: 'gold', since: '2025-04-01' };
          });
          records[4].amount = 'not-a-number';
          break;
        default:
          break;
      }
      return { source: 'retail-orders', variant, records, meta };
    },
  },
  {
    slug: 'payment-settlements',
    name: '支付清算单',
    domain: '资金',
    owner: '清结算组',
    description: '合作方每日推送的清算明细，金额单位与手续费率高度敏感。',
    versionPolicy: 'strict',
    contractVersion: '2.0.0',
    fields: [
      { name: 'settlement_id', label: '清算单号', type: 'string', required: true, nullable: false, pattern: '^STL-\\d{8}-\\d{4}$' },
      { name: 'merchant_id', label: '商户号', type: 'string', required: true, nullable: false, pattern: '^M\\d{8}$' },
      {
        name: 'amount',
        label: '清算金额',
        type: 'number',
        required: true,
        nullable: false,
        min: 0,
        semantics: { unit: 'CNY', scale: 1 },
      },
      {
        name: 'fee',
        label: '手续费',
        type: 'number',
        required: true,
        nullable: false,
        min: 0,
        semantics: { unit: 'CNY', scale: 1 },
      },
      { name: 'fee_rate', label: '费率', type: 'number', required: true, nullable: false, min: 0, max: 0.1 },
      {
        name: 'status',
        label: '清算状态',
        type: 'string',
        required: true,
        nullable: false,
        enum: ['pending', 'settled', 'failed'],
      },
      { name: 'currency', label: '币种', type: 'string', required: true, nullable: false, enum: ['CNY'] },
      { name: 'settled_at', label: '结算时间', type: 'date-time', required: true, nullable: true, format: 'date-time' },
      { name: 'reference', label: '外部流水号', type: 'string', required: false, nullable: true, maxLength: 64 },
    ],
    expectations: {
      clean: [],
      benign_lookalike: [],
      vendor_extra: ['new_field'],
      vendor_extra_regression: ['new_field', 'type_change'],
      semantic_conflict: ['semantic_conflict'],
      type_change: ['type_change'],
      missing_required: ['missing_required'],
      mixed: ['new_field', 'missing_required'],
    },
    suppressible: { mixed: ['new_field'], vendor_extra: ['new_field'], vendor_extra_regression: [] },
    variants: ['clean', 'benign_lookalike', 'vendor_extra', 'semantic_conflict', 'type_change', 'missing_required', 'mixed', 'vendor_extra_regression'],
    build(rand, variant) {
      const records = Array.from({ length: 10 }, (_, i) => ({
        settlement_id: `STL-2026111${i % 5}-${String(1000 + Math.floor(rand() * 8999))}`,
        merchant_id: `M${String(10000000 + Math.floor(rand() * 89999999))}`,
        amount: money(rand, 10, 520000),
        fee: money(rand, 0.01, 900),
        fee_rate: Math.round(rand() * 600) / 10000,
        status: pick(rand, ['pending', 'settled', 'failed']),
        currency: 'CNY',
        settled_at: rand() > 0.2 ? dateTime(rand, i % 4) : null,
        reference: rand() > 0.4 ? `REF-${hex(rand, 10)}` : null,
      }));
      const meta = {};
      switch (variant) {
        case 'benign_lookalike':
          records.forEach((r, i) => {
            r.amount = r.amount.toFixed(2);
            r.fee = r.fee.toFixed(2);
            if (i % 2 === 0) r.settled_at = dateTime(rand, 1, true).replace('Z', '+08:00');
          });
          break;
        case 'vendor_extra':
          records.forEach((r) => {
            r.bank_trace_id = `TRC${hex(rand, 12)}`;
          });
          break;
        case 'semantic_conflict':
          meta.units = { amount: 'CNY-cent', fee: 'CNY-cent' };
          meta.scales = { amount: 100, fee: 100 };
          records.forEach((r) => {
            r.amount = Math.round(r.amount * 100);
            r.fee = Math.round(r.fee * 100);
          });
          break;
        case 'type_change':
          records[1].fee_rate = '0.006';
          records[3].fee_rate = 'six bps';
          records[6].amount = '520000.00';
          records[8].status = 1;
          break;
        case 'missing_required':
          delete records[2].merchant_id;
          delete records[5].amount;
          delete records[7].settlement_id;
          break;
        case 'mixed':
          records.forEach((r) => {
            r.bank_trace_id = `TRC${hex(rand, 10)}`;
          });
          records[4].fee_rate = '0.006';
          delete records[9].merchant_id;
          break;
        case 'vendor_extra_regression':
          records.forEach((r) => {
            r.bank_trace_id = { trace: `TRC${hex(rand, 10)}`, bank: 'ICBC' };
          });
          records[4].fee = { amount: 433.14, currency: 'CNY' };
          break;
        default:
          break;
      }
      return { source: 'payment-settlements', variant, records, meta };
    },
  },
  {
    slug: 'iot-telemetry',
    name: '设备遥测',
    domain: '物联网',
    owner: '设备平台组',
    description: '厂区传感器分钟级上报，固件版本决定字段集合，契约锁定。',
    versionPolicy: 'pinned',
    contractVersion: '3.1.4',
    fields: [
      { name: 'device_id', label: '设备号', type: 'string', required: true, nullable: false, pattern: '^DEV-[A-Z]{2}\\d{4}$' },
      { name: 'ts', label: '采集时间', type: 'date-time', required: true, nullable: false, format: 'date-time' },
      {
        name: 'temperature',
        label: '温度',
        type: 'number',
        required: true,
        nullable: false,
        min: -50,
        max: 150,
        semantics: { unit: 'C', scale: 1 },
      },
      { name: 'humidity', label: '湿度', type: 'number', required: true, nullable: false, min: 0, max: 100 },
      { name: 'battery', label: '电量', type: 'number', required: false, nullable: true, min: 0, max: 100 },
      {
        name: 'firmware',
        label: '固件版本',
        type: 'string',
        required: false,
        nullable: true,
        enum: ['1.4.0', '1.5.0'],
      },
    ],
    expectations: {
      clean: [],
      benign_lookalike: [],
      new_field: ['new_field'],
      enum_extension: ['enum_extension'],
      type_change: ['type_change'],
      semantic_conflict: ['semantic_conflict'],
      mixed: ['new_field', 'enum_extension', 'type_change'],
    },
    suppressible: {},
    enumExtension: { field: 'firmware', value: '1.6.0' },
    variants: ['clean', 'new_field', 'enum_extension', 'type_change', 'semantic_conflict', 'benign_lookalike', 'mixed'],
    build(rand, variant) {
      const records = Array.from({ length: 8 }, (_, i) => ({
        device_id: `DEV-${pick(rand, ['AB', 'CD', 'EF'])}${String(1000 + Math.floor(rand() * 8999))}`,
        ts: dateTime(rand, i % 3),
        temperature: Math.round((15 + rand() * 25) * 10) / 10,
        humidity: Math.round(rand() * 1000) / 10,
        battery: Math.round(rand() * 1000) / 10,
        firmware: pick(rand, ['1.4.0', '1.5.0']),
      }));
      const meta = {};
      switch (variant) {
        case 'new_field':
          records.forEach((r) => {
            r.signal_dbm = -30 - Math.floor(rand() * 60);
          });
          break;
        case 'enum_extension':
          records[1].firmware = '1.6.0';
          records[6].firmware = '1.6.0';
          meta.declaredEnums = { firmware: ['1.6.0'] };
          break;
        case 'type_change':
          records[0].temperature = '21.5';
          records[3].humidity = 'fifty';
          records[5].temperature = { value: 22.1, unit: 'C' };
          break;
        case 'semantic_conflict':
          meta.units = { temperature: 'F' };
          records.forEach((r) => {
            r.temperature = Math.round((r.temperature * 1.8 + 32) * 10) / 10;
          });
          break;
        case 'benign_lookalike':
          records.forEach((r, i) => {
            if (i % 2 === 0) r.temperature = r.temperature.toFixed(1);
            if (i % 3 === 0) delete r.battery;
            r.ts = dateTime(rand, i % 3, true);
          });
          break;
        case 'mixed':
          records.forEach((r) => {
            r.signal_dbm = -30 - Math.floor(rand() * 60);
          });
          records[2].firmware = '1.6.0';
          meta.declaredEnums = { firmware: ['1.6.0'] };
          records[4].humidity = 'fifty';
          break;
        default:
          break;
      }
      return { source: 'iot-telemetry', variant, records, meta };
    },
  },
];

export function getCatalogSource(slug) {
  return CATALOG.find((s) => s.slug === slug) ?? null;
}

export function buildMockPayload(slug, variant, { seed } = {}) {
  const source = getCatalogSource(slug);
  if (!source) throw new Error(`未知数据源 ${slug}`);
  if (!source.variants.includes(variant)) throw new Error(`数据源 ${slug} 不支持场景 ${variant}`);
  const random = mulberry32(seed ?? hashSeed(`${slug}:${variant}`));
  const payload = source.build(random, variant);
  payload.generatedAt = new Date().toISOString();
  payload.variantLabel = VARIANT_META[variant]?.label ?? variant;
  return payload;
}

function hashSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function catalogContract(source) {
  return {
    version: source.contractVersion,
    fields: source.fields.map((f, i) => ({
      id: `${source.slug}-f${i}`,
      label: f.label,
      description: f.description ?? '',
      nullable: false,
      required: false,
      type: 'string',
      ...f,
    })),
  };
}
