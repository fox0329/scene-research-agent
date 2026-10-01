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
| PATCH | `/library/rows/{code}/{rowId}` | 单元格编辑（body: `{ cell, value }`）；source_type 自动转 `用户确认`；**服务端内联触发失效计算**（markStale 依赖反查，技术方案 F3），无需单独调用 |
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
| GET | `/projects/{id}/resume` | 断点续做对账（T4.1）：`{ action: fresh|resume|rerun|complete, stage, needsRecompute, danglingConversationIds, banner }` |
| GET | `/projects/{id}/stages/{n}/events` | SSE 断线续传：凭 `Last-Event-ID` 增量重放该阶段最近一次分析流（进程存续期内可续；进程重启后走 resume 对账重跑） |
| POST | `/projects/{id}/rollback` | 回退清理（T4.2）：`{ targetStage }` → `{ scenarioId, fromStage, toStage, markedStages, markedRows, banner }`；下游阶段既有分析标记待重算（数据保留不自动覆盖），非法阶段 400、场景不存在 404 |
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
| GET | `/conversations/{id}/messages/events` | 回复流断线重连（`Last-Event-ID` 头或 `?lastEventId=` 增量重放，v1.5） |

### 知识库 / 交付物 / 系统

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/knowledge?category=&product_line_id=` | 知识查询 |
| POST | `/projects/{id}/deliverables/export` | 双口径导出，返回 md 文件路径 |
| GET | `/system/status` | 探活 + 配置快照：`{ db, model_configured, provider_count, default_model }`（v1.6） |
| GET | `/system/providers` | 供应商登记表（v1.6）：`{ providers, default_model }`，密钥不回显（`has_key` + `key_masked`） |
| POST | `/system/providers` | 登记/更新（v1.6）：`{ name, base_url, api_key?, models }`；`api_key` 省略时保留旧密钥；链接非 http(s) 或无模型 400 |
| DELETE | `/system/providers/{name}` | 删除档案（v1.6）：默认模型被引用时一并清除；未知名 404 |
| PUT | `/system/providers/default` | 设默认模型（v1.6）：`{ provider, model }`，model 空取该供应商首模型；成员校验失败 400 |
| POST | `/system/providers/test` | 连接质量检查（v1.6）：草稿 `{ base_url, api_key, model? }` 或已存 `{ name, model? }`（密钥服务端自取）；两段式 `/models` 探活鉴权 → 指定模型时 `chat/completions` 最小生成；返回 `{ ok, stage, models_latency_ms, chat_latency_ms, models_seen, error }`；v1.7 起候选端点探测（裸域名自动试 `/v1/models`/`/models`），chat 段用命中后 base |
| POST | `/system/providers/models` | 模型列表发现（v1.7，仿 CC Switch）：`{ name?, base_url?, api_key? }`（同 test 取密钥规则）；候选端点探测 + 多格式解析（OpenAI/智谱目录），返回 `{ ok, models, resolved_base_url, latency_ms, error }`，`resolved_base_url` 供表单回填修正 |

| PATCH | `/library/product-lines/{id}` | 产品线（资料库）重命名（v1.9）：`{ name }`；名称空 400、未知名 404 |
| POST | `/library/product-lines/{id}/dedupe-products` | 产品去重（v1.9）：同型号产品合并（保留最早一条，缺位字段补全），M2 规格参数归并到保留产品，删重复行（F3 照打）；返回 `{ groups, products_removed, specs_moved, merged }` |

| GET | `/projects/{id}/material-sources` | 场景资料来源（v1.10）：`{ own, linked }`——专属库 + 引用的通用库 |
| PUT | `/projects/{id}/material-sources` | 设置引用的通用库（v1.10）：`{ linked_line_ids }`；专属库不可被引用 400 |

### 联真实现口径（v1.4 登记，M5-T5.1）

§三 端点自 M0 冻结，本节登记 M5 接真时的实现收口口径，不改变端点语义：

| 项 | 口径 |
|---|---|
| 前缀 | 全部 REST 端点挂 `/api/v1` 之下（§三 表中路径为省略写法）；SSE 同 |
| 错误形态 | 统一 `{ "error": "中文说明" }`；400 参数/状态非法、404 资源不存在、500 兜底 |
| 项目语义 | "项目"即 scenario 表行；列表响应 `Scenario[]`（含 current_stage/status），新建入参 `{ name, product_line_id }` |
| 行形态 | 各 GET 返回 §二 对应 contract 行类型原样 JSON（stage_data 的 `row` 为对象非字符串；`is_stale` 为布尔） |
| 阶段面板 | `GET /projects/{id}/stages/{n}` 返回 `{ rows: StageData[], gates: QualityGate[], advice }`，advice 由领域层 gate 计算，LLM 不参与判定 |
| 会话流式 | 发消息走 `POST /conversations/{id}/messages`，SSE 复用 §四 格式与事件中枢（同 advance）；断线补拉 `GET .../messages?after_id=` |
| 静态托管 | server 同源托管 web 构建产物（`@fastify/static`，可用 `WEB_DIST` 覆盖路径）；单端口 4081 起完整应用 |
| 上传 | `POST /library/ingest` 用 multipart（`@fastify/multipart`，单文件上限 50MB）；解析进度经 SSE `/library/ingest/{id}/events` |
| 模型配置（v1.6） | 应用自持：登记表 `data/providers.local.json`（0600、`SCENE_PROVIDERS_FILE` 可覆盖路径）是 LLM 调用唯一配置源；不再读项目 `.dsh/settings.yaml`，环境变量密钥通道退役；v1.4 的 `GET/PUT /system/settings*` 由 `/system/providers*` 取代，密钥永不下发前端（仅掩码） |
| 降级 | 模型未配置/链接不可达时：分析与会话端点返回流内 `error` 事件（不 500，文案含设置页指引）；纯 CRUD 端点不受影响，UI 可离线浏览真实已入库数据 |

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
| v1.2 | 2026-09-23 | T4.1 断点续做：新增 `GET /projects/{id}/resume`、`GET /projects/{id}/stages/{n}/events`（Last-Event-ID 重放）两个端点；SSE 报文按 §四 输出 `event: follow` 行；已登记 `docs/项目变更表.md` |
| v1.3 | 2026-09-23 | T4.2 回退清理：新增 `POST /projects/{id}/rollback`（下游标记待重算、数据保留）；advance 重算覆盖语义——同阶段重跑先清本阶段 stage_data/quality_gate 再写入，早期阶段重算不回拉 current_stage；已登记 `docs/项目变更表.md` |
| v1.4 | 2026-09-23 | M5-T5.1 联真实现口径：`/api/v1` 前缀、错误信封 `{ error }`、行形态（布尔/对象反序列化）、阶段面板响应 `{ rows, gates, advice }`、会话 SSE 复用事件中枢、静态托管与上传（multipart 50MB）、设置读写走项目 `.dsh/settings.yaml`、DSH 缺失降级为流内 error；变更表 #14 |
| v1.5 | 2026-09-23 | M5-T5.5 对话抽屉接 converse：新增 `GET /conversations/{id}/messages/events` 回复流重连端点（`Last-Event-ID`/`?lastEventId=` 增量重放，进程内事件中枢缓冲，与 `stages/{n}/events` 同构）；中枢事件补发单调 id 保证重放语义；变更表 #15 |
| v1.6 | 2026-09-23 | 模型配置应用自持（试用反馈 #47）：新增 `/system/providers` 五端点（列表/登记更新/删除/默认模型/测试连接，两段式链接质量检查），`/system/status` 改为 `{ db, model_configured, provider_count, default_model }` 配置快照，移除 `GET/PUT /system/settings*`；配置落 `data/providers.local.json`（0600，`SCENE_PROVIDERS_FILE` 可覆盖），密钥不回显、环境变量与 `.dsh/settings.yaml` 通道退役；变更表 #16 |
| v1.7 | 2026-09-23 | 模型列表发现（仿 CC Switch）：新增 `POST /system/providers/models`（候选端点探测 + 多格式解析，返回 `resolved_base_url` 供表单回填）；`providers/test` 与发现同走候选探测，chat 段用命中后 base；`providers` 登记自动补 `/v1`（含裸域名）；变更表 #17 |
| v1.8 | 2026-09-23 | 上传入库增强与"对话即导入"：ingest 上传 `product_line_id` 支持 URL query 兜底（multipart 字段顺序无关，修复 `file()` 只收 file 部件之前字段的 400）；ingest done 事件新增 `table_counts`（每表入库行数）；`POST /conversations/{id}/messages` 消息流新增对话即导入——消息内本地文件路径自动解析入库，导入报告以 text 事件随流回显并附给模型；变更表 #18 |
| v1.9 | 2026-09-24 | 资料库三连（用户三问题）：新增产品去重端点与产品线重命名端点，M2 规格书支持按产品出表；变更表 #21 |
| v1.10 | 2026-09-24 | 场景专属资料 + 链接通用库：product_line 增 scenario_id 归属列（存量库幂等 ALTER）、新表 scenario_linked_line；建场景自动建专属库、场景内上传落专属库、可引用通用库（GET/PUT material-sources 两端点），阶段分析合并两路资料；变更表 #22 |
| v1.11 | 2026-09-24 | 阶段分析锚定场景：scenario 增 description（分析锚），全部阶段提示词注入【场景锚】+硬规则，表1-1 场景要素以锚为准禁臆造；变更表 #23 |
| v1.12 | 2026-09-24 | 场景澄清：分析前置预检（描述缺失/含糊/含推断→澄清问题进对话并中止分析）、手动触发端点 POST /projects/{id}/clarify-scenario、场景锚条「场景澄清」按钮；变更表 #24 |
| v1.13 | 2026-09-24 | 场景定义对话式梳理：建场景只输名字→系统起草定义（POST /projects/{id}/draft-definition）发进「场景梳理」对话；对话确认/修正经【场景定义 vN】块自动回写描述；变更表 #26 |
| v1.14 | 2026-09-24 | 场景定义口径对齐（场景本位禁产品/问题后置调研）+ 生成定义后自动弹出对话抽屉；变更表 #27 |
| v1.15 | 2026-09-24 | 场景定义精简为两段式（场景长什么样+范围，问题/目标移出定义期）+ 建场景即弹对话抽屉；变更表 #28 |
| v1.16 | 2026-09-24 | 对话抽屉弹出即显状态提示（场景范围梳理中…），生成完成自动清除；变更表 #29 |
| v1.17 | 2026-09-24 | 对话即操作：converse 注入业务流操作手册 + 【执行命令】分发（advance_stage/export_deliverables/dedupe_products/clarify_scenario），结果回写对话；变更表 #30 |
| v2.0 | 2026-09-25 | **信息模型重构（不兼容变更）**：产品定位改为「用方法论帮用户一步步获得有价值、全面的信息」，**整体移除判断与建议产出**。详见 §七 迁移说明；变更表 #31–#53 |

---

## 七、v2.0 信息模型迁移说明（不兼容变更）

> 依据：`04-业务过程重定义.md` v1.4、`05-表格定义总表.md`、`06-设计审查与压缩方案.md`、`07-业务流程总表.md`。
> 一句话：**产品不再产出判断，只产出信息**；判断由用户自己做。

### 7.1 表定义成为唯一事实源

新增 `packages/contract/src/tables.ts`（34 张信息表）：表号/名称/阶段/级别/行粒度/列定义（字段·中文表头·必填·条件必填·枚举·类型·截断·块·引用）/**栏位分配（中栏 | 右栏补充）**/完整度规则/被引用阶段。
后端提示词、前端列定义、交付物装配**全部由它派生**；`05-表格定义总表.md` 亦由它生成（`pnpm gen:docs`，`pnpm check:docs` 做漂移守卫）。

- 阶段口径：**8 阶段（0-7）**。阶段 0 材料解析与入库（`producedBy: 解析入库`）、阶段 1-6 模型分析、阶段 7 最终交付物（`系统组装`）。
  旧编号阶段 8 已合并为阶段 7；`GET .../stages/8/...` 仍可用（按 7 处理），但不再有独立语义。
- 级别：`重要`（中栏表格，逐格校对）/ `支撑`（中栏折叠，抽查）/ `过程`（归右栏阶段总结）。
- **列预算**：中栏 ≤ 6 列；元信息列（`source`/`evidence_level`/`authority`）与长文本说明一律进**右栏补充列**；表格默认不出现横向滚动。

### 7.2 数据表变更

| 变更 | 说明 |
|---|---|
| 新增 `scenario_brief` | 场景诉求（第一输入，一场景一行）：`scene_name`/`intent`（想搞清楚什么，必填）/客户·地域·范围·用途·时间线索/`raw_text`（**用户原文，确认基准，系统不得改写**） |
| 新增 `stage_summary` | 阶段总结文档（复合主键 `scenario_id + stage`）：六段骨架 Markdown，**确定性生成，不需要 LLM** |
| `stage_data.table_code` 放宽 | 由 `TableCode` 放宽为 `TableCode \| InfoTableCode`（含「可选材料」等新表号）；**未知表号的产出行不入库**（无 schema 无法渲染） |
| `quality_gate` 停用 | 保留表结构但**不再读写**（判断类产出整体移除） |
| 场景锚（表1-1）落点 | 不再写 `scenario.description` 文本；**锚行存 `stage_data`（stage=1, table_code=表1-1）**，`description` **降级为由锚行派生的展示缓存** |

### 7.3 新增/变更端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects/{id}/brief` | 读场景诉求 + 场景锚（幂等预建 12 行锚骨架） |
| PUT | `/projects/{id}/brief` | 写场景诉求（`intent` 必填）；`raw_text` 首次写入后不再改写 |
| POST | `/projects/{id}/brief/draft` | 起草场景锚：诉求 + 资料库 → 12 项内容；**用户确认过的行不被覆盖**；LLM 失败降级为按线索预填（`used_llm=false`） |
| PUT | `/projects/{id}/anchor` | 批量写锚行（逐格确认/编辑）；返回重算后的 `description` |
| GET | `/projects/{id}/stages/{n}/completeness` | **信息完整度**（替代旧质量关读接口）：`{ stage, expectedTables, tablesWithData, missingTables, gaps, percent }`——只说明"还缺什么"，**不产出通过/不通过** |
| GET | `/projects/{id}/stages/{n}/summary` | 阶段总结文档：`{ stage, markdown, completeness }`；`?format=md` 直接下载；`?refresh=1` 强制重算 |
| POST | `/projects` | 可随建随传场景诉求字段（`intent`/`customer_hint`/`region_hint`/`scope_hint`/`audience`/`deadline`） |
| POST | `/projects/{id}/draft-definition` | **兼容保留**：内部改走场景锚，响应形状不变（`description`/`open_questions`/`conversation_id`）；`description` 变为派生缓存 |
| POST | `/projects/{id}/deliverables/export` | 交付物改为**装配式**：内部报告 = 各阶段总结装配 + 附录（来源索引/覆盖概览）；对外材料 = 章节 ← 表映射且**只渲染中栏列**（天然不含来源/证据级/权威性） |

### 7.4 SSE 事件类型变更

| 旧 | 新 | 说明 |
|---|---|---|
| `gate` | `completeness` | 载荷 `{ completeness, violations }`：完整度报告 + 产出行校验违规（未知表号/缺必填列/枚举非法/缺来源/自称用户确认）。**不阻断** |
| `advice` | `summary` | 载荷 `{ markdown }`：该阶段总结文档（六段骨架） |

### 7.5 确认机制（新增）

- 三层确认对象：**L1 场景本体**（表1-1 的 6 个必确认固定行）、**L2 环节与角色**（表1-2 每环节的能否参与/我方角色）、**L3 事实与枚举**（其余表抽查 + 待确认清单）。
- 状态机：系统推断 → 待确认 → 用户确认 / 用户修改 / 用户否决（由 `source_type` 推导，显式 `confirm_state` 优先）。
- **铁律：只有「用户确认」「用户补充」可被下游当依据**；模型产出只允许标 `AI提取` / `AI推断`（本地校验拦截自称用户确认）。
- 对照式确认以**用户诉求原文**为基准，把系统理解分为 一致 / 系统补充 / 推断 / 待补充 四态；「冲突」需语义判断，交由对话确认处理。

### 7.6 存量库迁移

旧表号与旧阶段号需要迁移（`O1..O6` → `可选材料`、`表1-4`/`表1-5` → `表1-3`、`表2-8` → `表1-2`、阶段 7/8 重编号等）。
提供 `scripts/migrate-info-model.mjs`：默认**只报告**（dry-run），`--apply` 才写入；无法无损映射的行会被列出待人工处理。
| v2.1 | 2026-09-25 | **UI 逻辑重构：业务流程逐页推进（9 步）**：新增流程状态与推进端点（`GET /projects/{id}/flow`、`POST .../flow/steps/{n}/complete|reopen`、`POST .../flow/unlock-all`，`POST .../stages/{n}/advance?step=N` 按流程步限定表集）；新表 `scenario_step`、`scenario.flow_unlocked_all`；`GET /projects` 每项增加 `flow` 进度；资料合并改为**默认含主库**且每行标注 `data_scope`；变更表 #55 |

---

## 八、v2.1 业务流程逐页推进（v2.3 起为 8 步）

> 动机：v1.4 把 8 个阶段并列成 tab，等于把整套方法论摊开给用户看（一进来面对 8 个空表格）。
> v2.1 改为**流程驱动**：方法论藏在流程里，用户只回答"现在这一步"。

### 8.1 概念区分（重要）

| 概念 | 含义 | 数量 |
|---|---|---|
| **阶段**（stage） | **数据落库口径**（`stage_data.stage`），稳定不变 | 8（0-7） |
| **流程步**（flow step） | **用户看到的推进单位** | 9（1-9） |

第 2 步「场景定义与边界」与第 3 步「认识场景」**同属阶段 1，但表集不重叠**：
表1-1（场景锚）归第 2 步（诉求起草 + 用户确认），其余 7 张归第 3 步（模型分析）。
因此 `?step=N` 会**按该步表集限定模型输出契约**——阶段 1 的分析不再重复产出场景锚。

### 8.2 8 步定义（`packages/contract/src/flow.ts`）

| 步 | 标题 | 类型 | 落库阶段 | 就绪判定（决定「完成本步」可否点） |
|---|---|---|---|---|
| 1 | 场景定义与边界 | 确认 | 1 | 定义已整理 **且** 表1-1 的 **6 项 L1 全部**为「用户确认/用户补充」（AI 推断不算）；L1 全空时 `readyHint` 指向「场景定义」对话 |
| 2 | 认识场景 | 分析 | 1 | 本步表集至少 1 张有数据（**不要求齐备**） |
| 3 | 理解商业 | 分析 | 2 | 同上 |
| 4 | 能力匹配 | 分析 | 3 | 同上 |
| 5 | 方案与实现 | 分析 | 4 | 同上 |
| 6 | 价值与验证 | 分析 | 5 | 同上 |
| 7 | 总结沉淀 | 分析 | 6 | 同上 |
| 8 | 交付物 | 组装 | 7 | 随时可生成并导出 |

**本步表集由注册表派生**（不重抄表号）：第 2 步 = `tablesOfStage(1)` 减去表1-1。

**「场景定义」对话不占流程步**：它是「新建场景」的一部分（`GET/POST /projects/{id}/definition*`，
见 §九），聊清楚后用户点「整理成定义」落成表1-1；第 1 步负责**逐项确认**。

### 8.3 三条推进规则

1. **数据判定可用 + 用户显式推进**：服务端只算 `ready`（并给 `readyHint` 说明缺什么），
   **不自动完成**。门槛在**流程步进**上；**信息完备度仍只提示不阻断**（两者不可混）。
2. **默认锁步**：第 n 步未完成则第 n+1 步为「未解锁」；`POST .../flow/unlock-all` 一键解锁全部。
3. **已完成步骤可回去重跑**：`POST .../flow/steps/{n}/reopen` 清掉第 n 步及其后的完成标记
   （**数据保留**，按既有失效/重算语义处理下游），场景回到「进行中」。

### 8.4 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects/{id}/flow` | 8 步三态（已完成/当前/可推进/未解锁）+ `ready`/`readyHint`/`progress` + `currentStep`/`completedCount`/`unlockedAll`/`finished` |
| POST | `/projects/{id}/flow/steps/{n}/complete` | 完成本步：写 `scenario_step`、`current_stage` 单调推进、第 8 步置场景「已完成」；返回最新流程状态 |
| POST | `/projects/{id}/flow/steps/{n}/reopen` | 回到第 n 步重跑：清后缀标记 + 场景回「进行中」；数据保留 |
| POST | `/projects/{id}/flow/unlock-all` | 解锁全部步骤 |
| POST | `/projects/{id}/stages/{n}/advance?step=N` | 按第 N 步的表集限定分析范围（不传 `step` 则整阶段） |
| GET | `/projects` | 每项新增 `flow: { currentStep, completedCount, finished }`（左栏显示「第 n/8 步」） |

### 8.5 数据表与资料合并

| 变更 | 说明 |
|---|---|
| 新增 `scenario_step` | 流程步完成记录（`scenario_id + step` 复合主键，**用户点「完成本步」才写入**，`completed_at`） |
| `scenario.flow_unlocked_all` | 是否已解锁全部步骤（幂等 ALTER，默认 0） |
| 资料合并（`collectUpstreamData`） | 资料来源 = **本场景专属库 + 全部主库（`scenario_id IS NULL`）+ 显式引用的通用库**；<br>每行标注 `data_scope`（`本场景` / `主库：<名>` / `引用库：<名>`），提示词上游表首列渲染「资料来源」；<br>**同一型号多库出现时本场景优先**（先按库优先级排序再去重）；<br>**存储隔离**：本场景上传只落自己的库，绝不写回主库。 |
| v2.2 | 2026-09-25 | **场景定义改为对话式**：流程第 1 步由三段式表单改为**对话**——只输场景名称→弹出独立「场景定义」对话页（模型先给理解再提 ≤3 个场景本体问题）→用户点「整理成定义」把对话整理成表1-1（保留已确认行；模型只能标 用户补充/AI推断）。新增 `GET/POST /projects/{id}/definition*` 三端点；第 1 步就绪判定改为「定义已整理」；变更表 #58 |

---

## 九、v2.2 场景定义对话（流程第 1 步）

> 用户定调："场景定义不该让用户一项一项填空——难度大、不友好，不是智能体该有的模式。"

### 9.1 交互与落点

```
只输场景名称 → 弹出独立的「场景定义」对话页
  → 模型每轮：先给我的理解（2–4 句）→ 再提 ≤3 个场景本体问题
  → 用户对话回答（说"不知道"就标待定，不追问）
  → 用户点「整理成定义」→ 对话整理成表1-1 场景锚
  → 关闭后进入第 2 步：表格逐项确认（L1 六项）
```

**对话是手段，表格是产物**：表1-1 仍是唯一场景定义（可逐格确认、可精确引用）。

### 9.2 三条硬规则

1. **只在用户点「整理成定义」时才写表**——不自动增量改用户的表。
2. **整理时保留用户已确认的行**（用户的决定优先）。
3. 模型只能标 `用户补充`（转述用户原话）或 `AI推断`（猜的）；
   **`用户确认` 永远只能由用户动作产生**（模型自称会被降级）。

### 9.3 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects/{id}/definition` | 幂等创建/复用标题为「场景定义」的会话；返回 `{ conversation_id, messages, anchor, brief }`（顺带幂等预建 12 行锚骨架） |
| POST | `/projects/{id}/definition/messages` | 发一条消息，**SSE** 流式回复；系统提示词换为「场景定义助手」（只谈场景本体、每轮 ≤3 问、不给判断） |
| POST | `/projects/{id}/definition/consolidate` | **「整理成定义」**：读该会话消息 → 按表1-1 固定项整理 → 合并写锚（保留已确认）→ 返回 `{ rows, alignment, updated, skipped, open_questions, used_llm }`；模型不可用时降级为不写任何内容 |

### 9.4 就绪判定变更

流程第 1 步（场景定义）的就绪条件由「诉求的『想搞清楚什么』非空」改为
**「定义已整理」**（表1-1 至少一项有内容）；`readyHint` 指向「开始场景定义对话 / 整理成定义」。
第 2 步（场景定义与边界）不变：**6 项 L1 全部由用户确认**。
| v2.3 | 2026-09-25 | **流程收成 8 步（用户拍板）**：用户问"为什么又变成了9个阶段"——查证为两件事：① 老文档 00b 的 9 阶段口径仍在被引用（已修）；② 用户可见流程步被我做成 9 步（多出的一步是"场景定义对话"独立占步）。**收成 8 步**：定义对话归入「新建场景」（不占步），第 1 步=场景定义与边界(确认,表1-1)，第 2-8 步=认识场景/理解商业/能力匹配/方案与实现/价值与验证/总结沉淀/交付物；用户可见 8 步与底层 8 阶段（0-7）**数量对齐、编号不等**（第 1、2 步同属阶段 1，第 3–8 步对应阶段 2–7）。**就绪口径**：第 1 步 = 定义已整理 **且** 6 项 L1 全部由用户确认/补充（定义未整理时提示指向对话）；变更表 #60 |
