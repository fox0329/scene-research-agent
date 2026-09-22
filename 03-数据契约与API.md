# 场景通 — 数据契约与 API

> **状态**：v0.1 草案（2026-09-22，待用户审核 → M0 T0.6 校验后冻结为 contract v1.0 子集）
>
> **范围**：本文件是 M0/M1/M2 所需子集（资料库 8 表 + 场景层 6 表 + 知识表 + API + SSE）；**阶段 3-8 的 stage_data 表 schema 于 M3 前补齐为 v1.1**（滚动冻结，技术方案 §十五）。
>
> **依据**：产品定义 v0.4 §4.4（15 表三层）、00b 工作流标准 v2.2（表格定义）、技术方案 v0.3（§5.3 dsh-client、§十二契约测试）。
>
> **变更纪律**：冻结后任何修改须登记 `docs/项目变更表.md` 并升版本（规则 7）；TS 类型与 JSON Schema 以 `packages/contract` 为唯一实现，本文件是人读版。

---

## 一、通用约定

- 主键 `id`：TEXT（UUID v4）；时间：TEXT（ISO 8601）
- REST 前缀 `/api/v1`；请求/响应均 JSON；错误统一结构 `{ code, message, detail? }`
- 通用列（凡标注"含溯源"的表）：

| 列 | 类型 | 说明 |
|---|---|---|
| source_type | TEXT 枚举 | `AI提取 / AI推断 / 用户确认 / 用户补充` |
| source | TEXT | 出处：`文件名.pdf:12` 或 `URL`；溯源铁律要求非空（推断类可空但标记待确认） |
| source_authority | TEXT 枚举 | `T1 / T2 / T3 / T4`，可空（用户补充默认 A 级证据对应可不填） |
| evidence_level | TEXT 枚举 | `A / B / C / D`，可空；D 级不得入库 |

## 二、数据表（15 张）

### 第一层 · 产品资料库（全局，8 表）

**product_line**：`id, name(唯一), created_at, updated_at`

**product**（M1，含溯源）：`id, product_line_id→product_line, model, name, status(在售/停售/在研/规划/待确认), launch_date, former_name?, position_desc, + 通用列`

**spec_param**（M2，含溯源）：`id, product_id→product, param_class, param_name, value, measured(实测/宣称/未提及), + 通用列`　索引：`(product_id, param_class)`

**capability**（M3，含溯源）：`id, product_line_id, domain, name, description, maturity(已交付/组件具备/在研/规划), dependency, inapplicable_scene?, + 通用列`　索引：`(product_line_id, domain)`

**boundary**（M4）：`id, product_line_id, description(不做的事), reason, has_plan(有/无/未定), response(客户要求时怎么办), owner, plan_date?, + 通用列`

**limitation**（M5）：`id, product_line_id, product_name, description, impact(高/中/低), fix_status(已修复/修复中/无计划/硬件限制), external_visible(可提/内部可提/不可提), owner, + 通用列`

**cost_rate**（M6）：`id, product_line_id, category(实施/商务), item, rate(单价), unit, standard_hours, data_source(历史项目/内部报价/行业均值/待确认)`　索引：`(product_line_id, category)`

**optional_material**（O1-O6）：`id, product_line_id, category(O1认证/O2案例/O3价格/O4SDK/O5路线图/O6生态), payload(JSON 按类异构), + 通用列`　索引：`(product_line_id, category)`

### 第二层 · 场景分析项目（6 表）

**scenario**：`id, name, product_line_id, status(进行中/已完成/已归档), current_stage(0-8), created_at, updated_at`

**scenario_material**（场景级覆盖，不写资料库）：`id, scenario_id, ref_table, ref_id, override_value(JSON), reason, + 通用列`　唯一键：`(scenario_id, ref_table, ref_id)`

**stage_data**（阶段 0-8 全部分析表，行式存储）：`id, scenario_id, stage(0-8), table_code(如 表1-3/表2-2), row(JSON，结构由该表 schema 定义), is_stale(BOOL，资料失效标记), + 通用列`　索引：`(scenario_id, stage, table_code)`。**55 张表的 row schema 以 packages/contract 内 JSON Schema 为准，本文件 v1.1 附阶段 3-8 清单。**

**conversation**：`id, scenario_id, title, status(活跃/已归档), dsh_session_id(与 DSH session 一一映射), created_at, updated_at`

**message**：`id, conversation_id, role(用户/系统), content, stage?, table_ref?(引用表格行), created_at`　索引：`conversation_id, created_at`

**quality_gate**：`id, scenario_id, stage, item_no, title, result(通过/不通过/未检), detail, evidence_refs(JSON，抽查采样记录), checked_at`　索引：`(scenario_id, stage)`

### 第三层 · 知识库（1 表）

**knowledge**：`id, product_line_id?, scene?, category(竞品/需求/趋势/成本), content, source, source_authority, from_scenario_id, created_at`　索引：`(category, created_at)`

## 三、REST API（按 command 分组，技术方案 §3.2）

### 资料库（ingest / edit-cell）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/library/product-lines` | 产品线列表（含表计数） |
| POST | `/library/product-lines` | 建产品线 |
| POST | `/library/ingest` | 上传材料（multipart）→ 解析入表；返回 ingest_job_id，进度走 SSE `/library/ingest/{id}/events` |
| GET | `/library/tables/{code}` | 读表（M1-M6/O*，code 如 `M1`、`O2`）；支持 `?product_line_id=` |
| PATCH | `/library/rows/{code}/{rowId}` | 单元格编辑（body: `{ cell, value }`）；source_type 自动转 `用户确认` |
| POST | `/library/rows/{code}` / DELETE `/{rowId}` | 增行 / 删行（标 `用户补充`） |
| GET | `/library/quality-summary?product_line_id=` | 六维总评 + 完成度检查 |

### 项目与阶段（advance-stage / sync-library）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/projects` | 新建（`{ name, product_line_id }`），材料引用自动建立 |
| GET | `/projects` | 列表（含 current_stage、stale 概要） |
| PATCH | `/projects/{id}` | 重命名 / 归档（`{ name? , status? }`） |
| DELETE | `/projects/{id}` | 删除（连带场景层数据；知识库保留） |
| GET | `/projects/{id}/stale` | 失效横幅数据：受影响阶段 + 涉及表 |
| POST | `/projects/{id}/stages/{n}/advance` | 推进阶段 n 分析；**SSE**（事件见 §四） |
| POST | `/projects/{id}/stages/{n}/decide` | 用户决定：`{ action: 继续|补充|停止|重算 }` |
| GET | `/projects/{id}/stages/{n}` | 读阶段面板（表格行 + 质量关 + 建议卡） |
| PATCH | `/projects/{id}/stage-data/{rowId}` | 分析表单元格编辑 |

### 会话（converse）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/projects/{id}/conversations` | 会话列表 / 新建 |
| PATCH | `/conversations/{id}` | 重命名 / 归档 |
| DELETE | `/conversations/{id}` | 删除（DSH 侧会话保留，仅解除映射） |
| POST | `/conversations/{id}/messages` | 发消息；**SSE** 流式回复 |
| GET | `/conversations/{id}/messages?after_id=` | 断线补拉 |

### 知识库 / 交付物 / 系统

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/knowledge?category=&product_line_id=` | 知识查询 |
| POST | `/projects/{id}/deliverables/export` | 双口径导出，返回 md 文件路径 |
| GET | `/system/status` | DSH 探活（绿/黄 + 版本/端口） |
| GET/PUT | `/system/settings` | 模型选择（读 .dsh/settings.yaml 或经 DSH settings） |

## 四、SSE 事件格式（统一）

```
event: follow
id: <单调递增整数>
data: { "type": "text"|"tool_call"|"progress"|"row"|"gate"|"advice"|"done"|"error", ... }
```

- `id` 供 `Last-Event-ID` 断线续传（技术方案 §八 F2）
- `row`：阶段分析产出的表格行（已过领域校验）；`gate`/`advice`：质量关与建议三档（领域层计算结果）
- `error` 后连接关闭；客户端凭 after_id / Last-Event-ID 恢复

## 五、dsh-client 接口（摘自技术方案 §5.3，冻结后不可变）

```ts
interface DshClient {
  createSession(opts: { title: string; preset?: string }): Promise<SessionHandle>
  prompt(h: SessionHandle, input: { system: string; user: string; outputContract: JsonSchema }): AsyncIterable<FollowEvent>
  cancel(h: SessionHandle): Promise<void>
}
```

## 六、版本记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-09-22 | 草案：15 表 schema、API 按 6 command 分组、SSE 事件格式、dsh-client 接口；阶段 3-8 的 stage_data row schema 留待 v1.1（M3 前） |
