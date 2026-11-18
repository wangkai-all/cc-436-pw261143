# 契约哨站 · 数据源契约管理与漂移治理

为每个数据源登记字段类型、枚举范围、必填条件与版本兼容策略；采集任务按策略对漂移选择**放行 / 隔离 / 阻断**，并始终保留具体差异样本。提供契约对比、受影响批次、兼容版本批准、失败数据回放，以及一套证明"误报例外不会吞掉真实漂移"的自检矩阵。

零依赖：仅使用 Node.js 内置模块（`node:http`、`node:sqlite`），前端为原生 ESM + 手写样式。

## 运行

要求 Node.js **>= 22.5**（用到内置 `node:sqlite`）。

```bash
npm run seed     # 重置并生成演示数据库与模拟载荷（会覆盖 data/sentinel.db）
npm start        # 启动 http://127.0.0.1:4173
npm test         # 46 个单元 / 集成 / HTTP 测试
```

可选环境变量：`PORT`、`HOST`、`DB_PATH`。`npm run dev` 为 watch 模式。

演示数据包含 3 个数据源、17 个采集批次、1 条误报例外、1 个待批准的兼容版本草案，以及 48 条隔离/阻断记录（其中 29 条待处理）；执行 `npm run seed` 可随时恢复初始状态。

## 功能地图

| 页面 | 路径 | 能做什么 |
|---|---|---|
| 总览 | `#/` | 累计批次、漂移观测、待处理隔离、阻断行数；漂移类别分布与数据流去向；最近批次与事件流 |
| 防漏检自检 | `#/verify` | 26 项场景矩阵：良性样本不误报、破坏性漂移必检出、真实漂移不被例外吞掉 |
| 契约版本 | `#/source/:slug/contracts` | 当前契约字段表（类型 / 必填 / 可空 / 约束 / 语义）、观测到的新字段、待批准版本、任意两版对比与受影响批次 |
| 采集批次 | `#/source/:slug/batches` | 本地模拟接口（场景 + 数据流模式 + 标签）、批次列表、批次详情与差异样本 |
| 隔离与回放 | `#/source/:slug/quarantine` | 按状态筛选、单行/批量按新契约回放、回放结果留档 |
| 策略配置 | `#/source/:slug/policy` | 版本兼容策略（增量兼容 / 严格审批 / 版本锁定）、类别级处置、样本保留上限 |
| 误报例外 | `#/source/:slug/exceptions` | 精确签名例外列表、影响面预演、停用/启用 |
| 演练台 | `POST /api/playground` | 按当前契约与例外试算任意载荷，不写库 |

## 核心设计

### 1. 检测与处置分离

`detectPayload()` 永远记录**所有**漂移（类别、严重度、签名、样本、行号），`enforceDetection()` 才按策略给出动作。因此被策略放行的新增字段依然以"漂移观测"进入收件箱，不会被静默丢弃；被例外压制的条目保留 `suppressed` 标记而不是从结果里消失。

### 2. 版本兼容性由字段差异推导

`diffContracts()` 逐字段比较：新增可选字段、枚举扩展、放宽约束、必填转可选、移除格式为前向兼容；移除字段、类型变更、新增必填字段、枚举收缩、收紧约束、语义变更、禁止 null 为破坏性。破坏性草案不能按兼容流程批准（需显式 `confirmBreaking`），版本号按兼容性自动递增。

### 3. 误报例外只匹配精确签名

例外签名 = `sha1(类别 + 字段路径 + 观测签名基)`，观测签名基按形状取值：

- 字符串：只记类型 → `bank_trace_id: "TRC-…"` 的例外会豁免后续所有字符串形态；
- 对象：记排序后的键名 → `{trace, bank}` 与 `{value}` 不会互相豁免；
- 枚举：记具体取值 → 拼写错误 `RETURNED` 不会蹭到 `returned` 的例外；
- 格式/约束：记规则 + 阈值。

同字段换成另一种变形、或同类漂移换了签名，一律重新处置。`test/detect.test.js` 与 `test/core.test.js` 对"例外不吞真实漂移"有专门断言，页面上的自检矩阵也会在有人把真实漂移登记成误报时报红。

### 4. 语义冲突独立于值域

载荷可通过 `meta.units` / `meta.scales` / `meta.dateFormats` / `meta.namespaces` 声明实际语义。即使数值仍在 `min/max` 内，单位从元变分也会整批阻断，避免"合法数值 + 错误含义"混入。声明了 `meta.declaredEnums` 的枚举扩展记为 `enum_extension`（增量），未声明的形似新值记为 `enum_violation`（越界）。

### 5. 观察模式

批次可选 shadow 模式：不放行、不隔离、不阻断，但记录"若按策略会如何处置"（`recommendedAction`），用于上线前评估规则，不污染隔离队列。

### 6. 回放

隔离记录保留原始 `record` 与原因。回放时按**指定版本**的契约重新检测；批准新版本（如补充 `returned` 枚举）后可把历史隔离行回放为通过，结果与耗时留档，可重复回放失败行。

## 模拟场景

`src/catalog.js` 为每个数据源定义场景与期望矩阵，`GET /api/sources/:slug/mock?variant=…` 返回确定性（可传 `seed`）载荷：

| 场景 | 制造的变化 | 期望 |
|---|---|---|
| `clean` | 完全合规 | 无漂移 |
| `new_field` | 多发未声明字段 | 新增字段（增量放行，保留样本） |
| `enum_extension` | 声明并发送新枚举值 | 枚举扩展（增量） |
| `type_change` | 字段 JSON 类型改变 | 类型变更（隔离） |
| `missing_required` | 必填字段消失 | 必填缺失（阻断） |
| `semantic_conflict` | 单位/量纲改变，值域仍合法 | 语义冲突（阻断） |
| `mixed` | 增量 + 破坏性并存 | 多类别，整体按最严处置 |
| `benign_lookalike` | 数值字符串、声明枚举、可空缺省 | 无漂移（不误报） |
| `vendor_extra` | 已知良性附加字段 | 新增字段（可登记例外） |
| `vendor_extra_regression` | 同名字段变成对象 | 新增字段 + 类型变更（例外不得吞掉） |
| `enum_typo` | 形似新枚举但未声明 | 枚举越界（隔离） |

三个数据源分别演示三种版本策略：零售订单流（增量兼容）、支付清算单（严格审批，新增字段也隔离）、设备遥测（版本锁定，任何漂移阻断）。

## HTTP API（节选）

```
GET    /api/meta
GET    /api/overview
GET    /api/sources
GET    /api/sources/:slug
PATCH  /api/sources/:slug
GET    /api/sources/:slug/contracts
POST   /api/sources/:slug/contracts
GET    /api/sources/:slug/contracts/compare?from=&to=
POST   /api/sources/:slug/contracts/:version/approve
GET    /api/sources/:slug/mock?variant=&seed=
POST   /api/sources/:slug/ingest        { variant | payload, mode: live|shadow, label }
GET    /api/sources/:slug/batches
GET    /api/sources/:slug/timeline
GET    /api/sources/:slug/field-proposals
GET    /api/sources/:slug/quarantine?status=
POST   /api/sources/:slug/quarantine/replay-all
GET    /api/sources/:slug/exceptions
POST   /api/sources/:slug/exceptions
POST   /api/sources/:slug/exceptions/preview
GET    /api/sources/:slug/verify
GET    /api/verify
GET    /api/batches/:id
POST   /api/quarantine/:id/replay
PATCH  /api/exceptions/:id
GET    /api/exceptions/:id/impact
POST   /api/playground
```

错误统一返回 `{ "error": "…", "…detail" }`，客户端按状态码（400/404/409）展示。

## 演示动线（约 3 分钟）

1. `#/verify` 先看 26/26 全绿，理解场景矩阵在验证什么。
2. 进入「支付清算单 → 采集批次」，选 `供应商附加字段` 调用模拟接口：严格策略下即使只多一个字段也会隔离。
3. 打开该批次详情，看差异卡片的契约期望 / 实际观测 / 原始样本；在 `new_field` 上「登记为误报」并预览影响面。
4. 再跑一次 `供应商附加字段` → 放行；改跑 `附加字段变体升级`（同名字段变对象）→ 仍被隔离。这就是"例外不吞真实漂移"。
5. 进入「零售订单流 → 契约版本」，对比 `1.1.0 → 1.2.0`（枚举扩展），查看受影响批次并批准；随后到「隔离与回放」把历史失败行按 1.2.0 回放为通过。
6. 回「防漏检自检」确认仍然全绿。

> 实际生产化时的注意事项：示例按单进程内嵌 SQLite 设计，多副本部署需换集中式数据库；例外目前只按数据集内精确签名生效，若要做到跨数据源共享需另行定义作用域与审批流。

## 目录结构

```
src/
  db.js          SQLite 表结构与访问助手
  policies.js    漂移类别、处置策略、版本策略、enforceDetection
  detect.js      契约检测、签名、样本与归一化
  contracts.js   字段规范化、版本差异与兼容性推导
  catalog.js     3 个数据源、模拟场景与期望矩阵
  core.js        业务逻辑（采集、契约、例外、回放、自检、总览）
  server.js      HTTP 路由与静态文件服务
public/
  index.html  app.js  api.js  ui.js  styles.css
  views/overview.js  views/source.js  views/verify.js
scripts/reset-seed.js
test/detect.test.js  contracts.test.js  core.test.js  http.test.js
data/               演示数据库与生成的模拟载荷（不入库）
```

## 测试

```bash
npm test
```

覆盖：检测分类与签名、数值归一化、语义冲突合并、策略升级与字段级覆盖、例外精确匹配、契约兼容性判定方向、采集→隔离→例外→回放→批准全链路、错误路径与静态资源安全。
