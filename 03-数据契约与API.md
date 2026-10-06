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

**cost_rate**（M6）：`id, product_line_id, category(实施/商务), item, rate(单价), unit, standard_hours, data_source(历史项目/内部报价/行业均值/待确认), note(说明), source_type, source, source_authority, evidence_level`　索引：`(product_line_id, category)`
> 来源四列与 note 于 2026-10-04 补齐（原建表漏了，契约表M6 里 source 是必填；当时 表5-5 还要求"单价可回溯 M6 或标来源"，该表已于变更表 #105 删除）；老库由 `runMigrations` 的幂等 ALTER 自愈。
> **标准骨架**：新建产品线（含场景专属资料库）即播种 14 行标准费率（9 项实施工序 + 商务 5 项），`rate`/`standard_hours` 为 0、`data_source` 标「待确认」——契约 completeness 已规定「『待确认』行不得用于报价」，骨架不会被当成真实单价消费。用户只填数字，不用自己建表。

**optional_material**（O1-O6）：`id, product_line_id, category(O1认证/O2案例/O3价格/O4SDK/O5路线图/O6生态), payload(JSON 按类异构), + 通用列`　索引：`(product_line_id, category)`

### 第二层 · 场景分析项目（6 表）

**scenario**：`id, name, product_line_id, status(进行中/已完成/已归档), current_stage(0-8), created_at, updated_at`

**scenario_material**（场景级覆盖，不写资料库）：`id, scenario_id, ref_table, ref_id, override_value(JSON), reason, + 通用列`　唯一键：`(scenario_id, ref_table, ref_id)`

**stage_data**（阶段 0-8 全部分析表，行式存储）：`id, scenario_id, stage(0-8), table_code(如 表1-3/表2-2), row(JSON，结构由该表 schema 定义), is_stale(BOOL，资料失效标记), + 通用列`　索引：`(scenario_id, stage, table_code)`。**55 张表的 row schema 以 packages/contract 内 JSON Schema 为准，本文件 v1.1 附阶段 3-8 清单。**

**conversation**：`id, scenario_id, title, status(活跃/已归档), dsh_session_id(与 DSH session 一一映射), created_at, updated_at`

**message**：`id, conversation_id, role(用户/系统), content, stage?, table_ref?(引用表格行), created_at`　索引：`conversation_id, created_at`

**quality_gate**：`id, scenario_id, stage, item_no, title, result(通过/不通过/未检), detail, evidence_refs(JSON，抽查采样记录), checked_at`　索引：`(scenario_id, stage)`

## 三、REST API（按 command 分组，技术方案 §3.2）

### 资料库（ingest / edit-cell）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/library/product-lines` | 产品线列表（含表计数） |
| POST | `/library/product-lines` | 建产品线 |
| POST | `/library/ingest` | 上传材料（multipart）→ 解析入表；返回 ingest_job_id，进度走 SSE `/library/ingest/{id}/events` |
| GET | `/library/tables/{code}` | 读表（M1-M6/O*，code 如 `M1`、`O2`）；支持 `?product_line_id=` |
| PATCH | `/library/rows/{code}/{rowId}` | 单元格编辑（body: `{ cell, value }`）；source_type 自动转 `用户确认`；**服务端内联触发失效计算**（markStale 依赖反查，技术方案 F3），无需单独调用 |
| POST | `/library/rows/{code}` / DELETE `/{rowId}` | 增行 / 删行（标 `用户补充`）。**入口校验**：M1 必填 `model`、M2 必填 `product_id/param_name/value`、M3 `name`、M4/M5 `description`、M6 `item`，缺了返回 400 并指明缺哪列；其余 NOT NULL 列按表给缺省值（M1 `status=待确认`、M2 `measured=未提及`、M3 `maturity=在研`、M4 `has_plan=未定`、M6 `category=实施/rate=0/unit=人天/data_source=待确认`）。M2 无 `product_line_id` 列，按 `product_id` 归属 |
| GET | `/library/quality-summary?product_line_id=` | 六维总评 + 完成度检查 |

### 项目与阶段（advance-stage / sync-library）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/projects` | 新建（`{ name, product_line_id }`），材料引用自动建立 |
| GET | `/projects` | 列表（含 current_stage、stale 概要） |
| PATCH | `/projects/{id}` | 重命名 / 归档（`{ name? , status? }`） |
| DELETE | `/projects/{id}` | 删除（连带场景层数据） |
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

### 交付物 / 系统

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/projects/{id}/deliverables/export` | 双口径导出，返回 md 文件路径 |
| GET | `/system/status` | 探活 + 配置快照：`{ db, model_configured, provider_count, default_model }`（v1.6） |
| GET | `/system/providers` | 供应商登记表（v1.6）：`{ providers, default_model }`，密钥不回显（`has_key` + `key_masked`） |
| POST | `/system/providers` | 登记/更新（v1.6）：`{ name, base_url, api_key?, models }`；`api_key` 省略时保留旧密钥；链接非 http(s) 或无模型 400 |
| DELETE | `/system/providers/{name}` | 删除档案（v1.6）：默认模型被引用时一并清除；未知名 404 |
| PUT | `/system/providers/default` | 设默认模型（v1.6）：`{ provider, model }`，model 空取该供应商首模型；成员校验失败 400 |
| POST | `/system/providers/test` | 连接质量检查（v1.6）：草稿 `{ base_url, api_key, model? }` 或已存 `{ name, model? }`（密钥服务端自取）；两段式 `/models` 探活鉴权 → 指定模型时 `chat/completions` 最小生成；返回 `{ ok, stage, models_latency_ms, chat_latency_ms, models_seen, error }`；v1.7 起候选端点探测（裸域名自动试 `/v1/models`/`/models`），chat 段用命中后 base |
| POST | `/system/providers/models` | 模型列表发现（v1.7，仿 CC Switch）：`{ name?, base_url?, api_key? }`（同 test 取密钥规则）；候选端点探测 + 多格式解析（OpenAI/智谱目录），返回 `{ ok, models, resolved_base_url, latency_ms, error }`，`resolved_base_url` 供表单回填修正 |

| PATCH | `/library/product-lines/{id}` | 产品线（资料库）重命名（v1.9）：`{ name }`；名称空 400、未知名 404 |
| POST | `/library/product-lines/{id}/dedupe-products` | 资料库去重（v1.34 起同时清规格）：① 同型号产品行合并（**「在售」优先于「待确认」**，同状态留创建更早的；缺位字段补全、规格归并到保留行）；② 同产品内规格去重——完全相同留一条、一个值包含另一个的**留更完整那句**、值互相冲突的（如工作温度两个值）**不合并**；判定在领域层 `library-dedupe`（可单测、幂等）；返回 `{ groups, products_removed, specs_moved, specs_removed, spec_exact_groups, spec_near_groups, merged }` |
| — | ingest 写入路径 | 同一把尺子：M1 按归一型号（去空白 + 大写）**匹配已有产品**，匹配上就并入（补缺位字段）不新建行；M2 走 upsert——完全相同不重写、新材料更完整则覆盖库里那条、值冲突并存。**这是"重复行"的根因修复**（旧实现每批材料都新建产品行） |

| GET | `/projects/{id}/material-sources` | 场景资料来源（v2.8 起入口在「本场景资料」面板内）：`{ own, linked }`——专属库 + 引用的通用库。**v2.9：`linked` = 通用库里没被取消的那些，因此新建场景默认就是全引用** |
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
| 静态托管 | server 同源托管 web 构建产物（`@fastify/static`，可用 `WEB_DIST` 覆盖路径）；单端口 46172 起完整应用 |
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

- 阶段口径：**7 阶段（0-6）**。阶段 0 材料解析与入库（`producedBy: 解析入库`）、阶段 1-5 模型分析、阶段 6 最终交付物（`系统组装`）。
  v1.31 删掉原阶段 6「总结沉淀」（表7-1 一并删除）；`GET .../stages/7|8/...` 仍可用（按阶段 6 处理），但不再有独立语义。
- 级别：`重要`（中栏表格，逐格校对）/ `支撑`（中栏折叠，抽查）/ `过程`（归右栏阶段总结）。
- **列预算**：中栏 ≤ 6 列；元信息列（`source`/`evidence_level`/`authority`）与长文本说明一律进**右栏补充列**；表格默认不出现横向滚动。

### 7.2 数据表变更

| 变更 | 说明 |
|---|---|
| 新增 `scenario_brief` | 场景诉求（第一输入，一场景一行）：`scene_name`/`intent`（想搞清楚什么，必填）/客户·地域·范围·用途·时间线索/`raw_text`（**用户原文，确认基准，系统不得改写**） |
| 新增 `stage_summary` | 总结文档（复合主键 `scenario_id + stage`）：阶段级六段骨架 Markdown，**确定性生成，不需要 LLM**。**v2.10 起右栏读的是步骤级五段**（`?step=N`，即时推导**不落库**——库里那份留给交付物装配） |
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
| GET | `/projects/{id}/stages/{n}/summary` | 总结文档：`{ stage, markdown, completeness, scope }`；**`?step=N` = 只讲这一步**（右栏口径：表集限本步、无诉求全文、无上下游衔接）；`?format=md` 直接下载；`?refresh=1` 强制重算（v2.10） |
| POST | `/projects` | 可随建随传场景诉求字段（`intent`/`customer_hint`/`region_hint`/`scope_hint`/`audience`/`deadline`） |
| POST | `/projects/{id}/draft-definition` | **兼容保留**：内部改走场景锚，响应形状不变（`description`/`open_questions`/`conversation_id`）；`description` 变为派生缓存 |
| POST | `/projects/{id}/deliverables/export` | 交付物改为**装配式**：内部报告 = 各阶段总结装配 + 附录（来源索引/覆盖概览）；对外材料 = 章节 ← 表映射且**只渲染中栏列**（天然不含来源/证据级/权威性） |

### 7.4 SSE 事件类型变更

| 旧 | 新 | 说明 |
|---|---|---|
| `gate` | `completeness` | 载荷 `{ completeness, violations }`：完整度报告 + 产出行校验违规（未知表号/缺必填列/枚举非法/缺来源/自称用户确认）。**不阻断** |
| `advice` | `summary` | 载荷 `{ markdown }`：总结文档（本次分析按步骤级五段，交付物装配按阶段级六段；v2.10） |

### 7.5 确认机制（新增）

- **表1-1 只有 6 项，其中 5 项由智能体写**（2026-09-26 定稿，见 v2.7）：`场景名称` 由用户给，`场景边界 / 生产对象 / 核心生产系统 / 买方类型 / 采购特征` 是智能体按业务角度写的**场景业务画像**；`拍板者 / 使用者 / 付费者` 不在表1-1，它们是表3-3 的列。
- **固定行属主**（`FixedRowOwner`）：契约给每个固定行标 `owner: "用户" | "智能体"`，取代原来的 `confirmRequired`（"哪些项必须用户逐项确认"整套概念已删除）。
- **就地编辑即确认**（v2.8）：界面已无「确认无误」按钮——第 1 步的确认动作就是**直接改表格**，改一格写 `source_type = "用户补充"`。`confirm_state` 列仍在（服务端能力保留），但不再有 UI 去写它；**不改 `source_type` 是铁律**（G-R0 溯源与 G-R5 事实/假设分离都靠它）。
- 状态机：`source_type` ∈ {`AI提取`,`AI推断`,`用户确认`,`用户补充`}；**铁律：只有「用户确认」「用户补充」可被下游当依据**；模型产出只允许标 `AI提取` / `AI推断`（本地校验拦截自称用户确认）。
- **界面不显示「待确认」**（用户拍板）：智能体自己的待办（缺内容 / 缺来源 / 推断未标注）走 `Gap.owner = "智能体"`，只进阶段总结第五节「待补齐信息」，不进右栏、不阻断。
- 对照式确认以**用户诉求原文**为基准，把系统理解分为 一致 / 系统补充 / 推断 / 待补充 四态；「冲突」需语义判断，交由对话确认处理。

### 7.6 存量库迁移

旧表号与旧阶段号需要迁移（`O1..O6` → `可选材料`、`表1-4`/`表1-5` → `表1-3`、`表2-8` → `表1-2`、阶段 7/8 重编号等）。
提供 `scripts/migrate-info-model.mjs`：默认**只报告**（dry-run），`--apply` 才写入；无法无损映射的行会被列出待人工处理。
| v2.1 | 2026-09-25 | **UI 逻辑重构：业务流程逐页推进（9 步）**：新增流程状态与推进端点（`GET /projects/{id}/flow`、`POST .../flow/steps/{n}/complete|reopen`、`POST .../flow/unlock-all`，`POST .../stages/{n}/advance?step=N` 按流程步限定表集）；新表 `scenario_step`、`scenario.flow_unlocked_all`；`GET /projects` 每项增加 `flow` 进度；资料合并改为**默认含主库**且每行标注 `data_scope`；变更表 #55 |

---

## 八、v2.1 业务流程逐页推进（v2.3 起为 8 步、v2.12 起为 7 步）

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

### 8.2 7 步定义（`packages/contract/src/flow.ts`）

| 步 | 标题 | 类型 | 落库阶段 | 就绪判定（决定「完成本步」可否点） |
|---|---|---|---|---|
| 1 | 场景定义与边界 | 确认 | 1 | **定义已整理**（表1-1 除「场景名称」外任一项有内容）——**不要求确认齐全**（用户常说不准）；`readyHint` 里点名「核心 x/2 项已确认」，全空时指向「场景定义」对话 |
| 2 | 认识场景 | 分析 | 1 | 本步表集至少 1 张有数据（**不要求齐备**） |
| 3 | 理解商业 | 分析 | 2 | 同上 |
| 4 | 能力匹配 | 分析 | 3 | 同上 |
| 5 | 方案与实现 | 分析 | 4 | 同上 |
| 6 | 价值与验证 | 分析 | 5 | 同上 |
| 7 | 交付物 | 组装 | 6 | 随时可生成并导出 |

**本步表集由注册表派生**（不重抄表号）：第 2 步 = `tablesOfStage(1)` 减去表1-1。

**「场景定义」对话不占流程步**：它是「新建场景」的一部分（`GET/POST /projects/{id}/definition*`，
见 §九），聊清楚后用户点「整理成定义」落成表1-1；第 1 步负责**逐项确认**。

### 8.3 三条推进规则

1. **数据判定可用 + 用户显式推进**：服务端只算 `ready`（并给 `readyHint` 说明缺什么），
   **不自动完成**。门槛在**流程步进**上；**信息完备度仍只提示不阻断**（两者不可混）。
2. **默认锁步**：第 n 步未完成则第 n+1 步为「未解锁」，未解锁节点不可点——
   **没有「解锁全部」这个后门**（v2.9 用户定调：不需要这个功能；真实工作里的「先看后面」
   由「回看已完成步骤」覆盖）。
3. **已完成步骤可回去重跑**：`POST .../flow/steps/{n}/reopen` 清掉第 n 步及其后的完成标记
   （**数据保留**，按既有失效/重算语义处理下游），场景回到「进行中」。

### 8.4 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects/{id}/flow` | 8 步三态（已完成/当前/可推进/未解锁）+ `ready`/`readyHint`/`progress` + `currentStep`/`completedCount`/`finished`；每步含 `title`（完整）与 **`short`（进度卡关键词）** |
| POST | `/projects/{id}/flow/steps/{n}/complete` | 完成本步：写 `scenario_step`、`current_stage` 单调推进、第 8 步置场景「已完成」；返回最新流程状态 |
| POST | `/projects/{id}/flow/steps/{n}/reopen` | 回到第 n 步重跑：清后缀标记 + 场景回「进行中」；数据保留 |
| POST | `/projects/{id}/stages/{n}/advance?step=N` | 按第 N 步的表集限定分析范围（不传 `step` 则整阶段） |
| GET | `/projects` | 每项新增 `flow: { currentStep, completedCount, finished }`（左栏显示「第 n/8 步」） |

### 8.5 数据表与资料合并

| 变更 | 说明 |
|---|---|
| 新增 `scenario_step` | 流程步完成记录（`scenario_id + step` 复合主键，**用户点「完成本步」才写入**，`completed_at`） |
| `scenario_linked_line.excluded` | v2.9：`1` = 用户显式取消引用这个通用库（**没有行 = 默认引用**），幂等 ALTER |
| 资料合并（`collectUpstreamData`） | 资料来源 = **本场景专属库 + 默认引用的通用库**（v2.9：通用库**默认全引用**，用户取消勾选的被排除）；<br>每行标注 `data_scope`（`本场景` / `主库：<名>`），提示词上游表首列渲染「资料来源」；<br>**同一型号多库出现时本场景优先**（先按库优先级排序再去重）；<br>**存储隔离**：本场景上传只落自己的库，绝不写回主库。 |
| v2.2 | 2026-09-25 | **场景定义改为对话式**：流程第 1 步由三段式表单改为**对话**——只输场景名称→弹出独立「场景定义」对话页（模型先给理解再提 ≤3 个场景本体问题）→用户点「整理成定义」把对话整理成表1-1（保留已确认行；模型只能标 用户补充/AI推断）。新增 `GET/POST /projects/{id}/definition*` 三端点；第 1 步就绪判定改为「定义已整理」；变更表 #58 |

---

## 九、v2.2 场景定义对话（流程第 1 步）

> 用户定调："场景定义不该让用户一项一项填空——难度大、不友好，不是智能体该有的模式。"

### 9.1 交互与落点

```
只输场景名称 → 弹出独立的「场景定义」对话页
  → 模型每轮：**先讲行业/这类场景的总体情况（3–5 句）** → 再说对用户场景的理解 → 再提 ≤2 个问题（只问「客户/行业」与「覆盖什么」，说个大概即可）
  → 用户对话回答（说"不知道"就标待定，不追问）
  → 用户点「整理成定义」→ 对话整理成表1-1 场景锚
  → 关闭后回到第 1 步：**可直接推进**（核心 2 项建议顺手确认）
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
第 1 步（场景定义与边界）改为 **定义已整理即可**：核心 2 项只在 `readyHint` 里点名提示，**不阻断推进**。
| v2.3 | 2026-09-25 | **流程收成 8 步（用户拍板）**：用户问"为什么又变成了9个阶段"——查证为两件事：① 老文档 00b 的 9 阶段口径仍在被引用（已修）；② 用户可见流程步被我做成 9 步（多出的一步是"场景定义对话"独立占步）。**收成 8 步**：定义对话归入「新建场景」（不占步），第 1 步=场景定义与边界(确认,表1-1)，第 2-8 步=认识场景/理解商业/能力匹配/方案与实现/价值与验证/总结沉淀/交付物；用户可见 8 步与底层 8 阶段（0-7）**数量对齐、编号不等**（第 1、2 步同属阶段 1，第 3–8 步对应阶段 2–7）。**就绪口径**：第 1 步 = 定义已整理 **且** 6 项 L1 全部由用户确认/补充（定义未整理时提示指向对话）；变更表 #60 |
| v2.4 | 2026-09-25 | **放松场景定义口径（用户拍板）**：用户指出「定义要求太细了，要抽象一点，用户很多时候也没说要定义那么准确，更多的是要对行业有个比较全面的了解」，并明确「**定义不影响后面的业务流程**」。① 表1-1 **必确认项 6 → 2**（客户类型/行业、覆盖什么），其余改选填可「待定」，必填行 9 → 3；② 第 1 步就绪降为「**定义已整理**」（表1-1 除场景名称外任一项有内容），核心 2 项只在 `readyHint` 点名、**不阻断**；③ 对照表与右栏清单改为「核心 2 项 ∪ 模型实际填了/推断的项」，不再要求 12 项齐全；④ 定义对话改为**先讲行业与场景的总体情况**、只问 ≤2 个问题（客户/行业、覆盖什么）、允许说不准、不追问边界；「整理成定义」只在确有依据时填、**留空是允许的**；变更表 #61 |
| v2.5 | 2026-09-25 | **接上对话上下文管理**：用户问「弹出的对话没有接上上下文管理这些基础设施吗？」——查证确认**没有**：`converse.sendMessage` 每条消息都新建 DSH 会话，而 `DshClient` 是**直连供应商 `/chat/completions`** 的实现（只发 system + 当条 user），DSH 侧会话不参与推理；项目手上其实存着完整历史（`messageRepo`）却从没喂给模型。真机实测第二轮问"我刚才说的代号"模型答"**如果之前在其他对话里说过，我这边看不到**"。修：① `sendMessage` 在本轮消息落库**之前**取历史，用 `buildHistoryBlock` 按预算拼「【对话历史】」块（上限 12 条 / 6000 字符，超出从最早处丢弃并**显式标注省略**）随本轮一起发送，顺序为 历史 → 调用方上下文 → 场景上下文 → 导入报告 → 本轮消息；② 系统提示词声明"把它当作你自己的记忆，不要说看不到"；③ `dsh_session_id` 回写为**实际使用**的会话并注释说明架构原因；④ 覆盖两条入口：「场景定义」弹窗与右下角对话抽屉（同一管道）。真机复验：第二轮准确答出「麒麟-7 / 杭州水务集团」、抽屉答出「3 月 15 日」；变更表 #62 |
| v2.7 | 2026-09-26 | **表1-1 从「12 项填空」收敛为「6 项业务画像」（用户拍板）**：用户指出「**拍板者、使用者、付费者这些信息都应该是用户提供的吗？用户什么都不知道还要我们干什么？**」并定调「**用户只负责输入场景名称，智能体只负责从业务角度说清楚场景的范围**」「表格用户自己可以修改」「**不用显示待确认**」。① 表1-1 **12 项 → 6 项**：`scene_name`(用户,必填) / `scene_boundary`(必填) / `production_object` / `core_systems` / `buyer_type` / `procurement`；② `confirmRequired` 整体删除，改为**固定行属主** `owner: "用户" \| "智能体"`，`docgen` 表头加「内容属主」列；③ **拍板者/使用者/付费者搬入表3-3**（`decision_maker`/`user_role`/`payer`，与 `customer_type/default_choice/budget_item` 同表，中栏仍 6 列）；④ `Gap` 新增必填 `owner`，缺口分 `userGaps`/`agentGaps`；⑤ 阶段总结第五节「信息缺口与待补充」→「**待补齐信息**」；⑥ 第 1 步就绪 = **智能体已写出业务画像**（不再要求逐项确认）；⑦ 新增存量迁移脚本 `scripts/migrate-anchor-v119.mjs`（dry-run 默认）；变更表 #64 |（用户投诉「整个页面大量的无效信息」）**：① 定义对话**只在第一轮讲行业**，第二轮起只回 1–2 句"变化的部分" + ≤1 个问题、整轮 ≤120 字，并禁止在正文写自我说明；② 「整理成定义」**只收用户说过的**（`source_type` enum 收窄为 `["用户补充"]`，模型顺手推断的一律不落表，新增 `inferred_dropped` 可观测），`open_questions` ≤2；③ 新增正文去噪 `stripMetaNotes`（剥掉"（用户未明说，按行业通行情况推断）"这类括号注解）与 `compressCell`（超 80 字按句界截断），定义格 ≤80 字；④ 重新整理时清空"本次未再产出的旧推断行"，用户持有行正文也去噪；⑤ 数据层 `update` 支持 `source_type: null` 显式清空，空行不留来源；⑥ 一次性清洗脚本 `scripts/clean-anchor-notes.mjs`（dry-run 默认，--apply 自动备份），已对真实库执行 558→312 字；变更表 #63 |
| v2.8 | 2026-09-26 | **中栏只放信息表 + 确认动作改为就地编辑**（用户定调"中栏只重点显示场景概述这个表格，其他的都不要干扰"）：① 第 1 步中栏只剩表1-1（步标题/引导语/就绪状态行/信息完整度条/「确认无误」按钮全删）；② `PUT /projects/{id}/anchor` 的调用方只剩就地编辑（`source_type` 仍只写「用户补充」）；③ 页头常驻的「资料来源」条删除，`GET/PUT /projects/{id}/material-sources` 的入口移入「本场景资料」面板；④ 阶段总结只带注册表里的固定锚行（存量旧 12 项残项不进总结）；变更表 #65 |
| v2.9 | 2026-09-26 | **通用库默认引用（可取消）+ 删掉「解锁全部步骤」**（用户定调：「新建项目，默认直接引用基础产品资料（默认勾选），除非用户取消勾选，勾选就代表引用，**不需要保存引用按钮**」「进度卡删除解锁全部步骤按钮，不需要这个功能」）：① `scenario_linked_line` 新增 `excluded` 列，**没有行 = 默认引用**（存量场景天然全引用，不需要回填），`excluded = 1` = 用户显式取消；② `PUT /projects/{id}/material-sources` 收的仍是**勾选集合**，落库落补集（哪些被取消）——勾/取消即生效，前端不再有「保存引用」；③ `collectUpstreamData` 的合并范围 = 专属库 + 通用库中未被取消的（去掉无条件全带主库），`data_scope` 只剩 `本场景` / `主库：<名>`；④ **删除 `POST .../flow/unlock-all`** 与 `scenario.flow_unlocked_all` 字段，`buildFlowStatus` 不再有 `unlockedAll`（锁步推进是唯一路径）；变更表 #66/#67 |
| v2.10 | 2026-09-26 | **右栏只讲当前步骤**（用户定调「补充说明和阶段总结只针对当前阶段，不要整理整个过程」）：① `/stages/{n}`、`/stages/{n}/completeness`、`/stages/{n}/summary` 三个端点新增 `?step=N`——完整度按**本步表集**算（阶段 1 不再把第 1 步的表1-1 算进第 2 步）；② 总结新增 `scope: "step" | "stage"`：`step` 时表集限本步、抬头写「第 n 步」、**不含用户诉求全文与上下游衔接**，且**不落库**（`stage_summary` 里那份是阶段级、供交付物装配，两者不互相覆盖）；③ `checkStageCompleteness` / `buildStageSummary` 新增 `tableCodes` 入参；④ 交付物装配口径不变。变更表 #69 |
| v2.11 | 2026-10-04 | **阶段 2 表集变更：新增表3-5 上游供给格局、表3-7 改列改名（随 04 v1.29 / 05 v0.9）**：用户验收「理解商业」时两条判断——「失败反模式我认为价值不大，不够直观」「供应链分析在哪有体现？我没看到」。① **新增 `表3-5 上游供给格局`**（阶段 2，`重要`；3-5 为历史空号，原并入表3-3）：行 = 一个上游环节，列为 主要供给方 / 供给集中度 / 可替代性 / 议价权在谁 / 被卡点，新增三个枚举 `concentration`/`substitutability`/`bargaining`；② **表3-7「失败反模式」→「同行踩过的坑」**，中栏由 `failure_reason`/`root_cause`/`design_implication` 换成 `pitfall` 坑（现场会发生什么）/ `consequence` 后果（钱·工期·安全）/ `avoid_in_design` 我们方案里怎么避（可验收硬指标），旧 `symptom`/`root_cause` 降为右栏补充（**键仍在，存量数据不丢**）；③ 阶段 2 表集 8 → 9 张，`InfoTableCode` / `STAGE2`-等价注册表 / 05 总表 / 提示词 / 对外材料禁引清单同步；④ 存量迁移脚本 `scripts/migrate-table37-pits.mjs`（默认 dry-run，`--apply` 自动备份）：`failure_reason→pitfall`、`design_implication→avoid_in_design`。**API 形状不变**（`stage_data` 的 `row` 是 JSON，列即键）——只有列键变化，前端按注册表渲染，无需改路由。 |
| v2.12 | 2026-10-04 | **阶段口径 8 → 7（0–6）：删阶段 6「总结沉淀」与表7-1**。`InfoStageId` 收窄为 `0..6`；交付物阶段 `7 → 6`；`consumedBy` 里的下游 `7` 全部改为 `6`；`stage_data` 不新增字段，存量迁移删掉 `stage=6` 的旧表7-1 行并把 `scenario.current_stage=7` 改为 `6`（`scripts/migrate-drop-stage6.mjs`，先快照）；老编号 7/8 的请求按阶段 6 处理。流程步 8 → 7（第 7 步 = 交付物）。变更表 #92 |
| v2.13 | 2026-10-04 | **列级变更（随 04 v1.32 / 05 v0.12）：表5-1 删 `effort`；表4-1 `proof` 中栏 → 右栏**。① `表5-1 架构与接口` 去掉 `effort`「适配工作量」——工作量口径统一在 `表5-3` 的 `man_days`「人天」，同一份表里两处口径会打架（实测该列写的是「行业通例量级 3~8 人天/触点」，是编的量级）；② `表4-1 能力底账` 的 `proof`「证明材料」由中栏改到右栏补充——用户定调「来源、引用什么的可以放到右栏」，中栏只留「能力项 / 成熟度 / 限制条件」。**API 形状不变**：`row` 是 JSON、列即键，前端按注册表渲染（`slot` 变了，键仍在，存量数据不丢、不迁移）。新增自检项「中栏夹带出处」「中栏太长」：内容格里的文件名/页码/`ingest-*`/`（M5）`/「材料未提供」由确定性层搬进右栏 `source`。；③ 新增自检项「依据未落到事实」（依据列复述结论／行业套话，确定性识别）。变更表 #93 |
| v2.14 | 2026-10-04 | **自检新增两条跨表校验（随 04 v1.33）**：「判定与能力底账矛盾」（表4-2／4-3／4-5／5-1 等中栏写「无／不支持 X」且该行判「不能碰／不参与」时，拿 **表4-1 能力底账的能力名**比对，命中即点名；**只比能力名、不比限制条件**）、「硬结论无依据」（`can_touch=不能碰` 且本行 `verification_verdict ∈ {无法核实, 有反证}` → 硬伤）。**API 与列结构不变**：这是生成期自检，不改 `stage_data` 形状。变更表 #94 |
