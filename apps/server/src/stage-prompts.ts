/**
 * @scene/server — 阶段 prompt 模板（阶段 0-8）
 *
 * 职责：为每个分析阶段构建 system + user prompt。
 * 规则：prompt 只注入当前阶段 schema + 上游表数据（F2 上下文控制约束）。
 *
 * 阶段 0（材料解析）：验证材料质量 + 完成度评估（由 ingest 已完成，此阶段 advance 仅做总结）
 * 阶段 1（门槛筛查）：五类门槛判定 + 处置策略 → 表1-1 至 表1-5
 * 阶段 2（架构约束）：架构分析 + 技术约束 → 表2-1 至 表2-8
 * 阶段 3（理解商业）：利润池/方案形态/替代方案/缺口/趋势 → 表3-1 至 表3-10
 * 阶段 4（匹配决策）：能力底账/痛点排序/匹配矩阵/优先级/竞争力 → 表4-1 至 表4-6
 * 阶段 5（方案实现）：架构接口/约束合规/实施/运维/成本/价格 → 表5-1 至 表5-9
 * 阶段 6（价值验证）：价值模型/指标/ROI/试点/口径/双口径 → 表6-1 至 表6-7
 * 阶段 7（总结沉淀）：三张可交付更新表 → 表7-1 至 表7-3
 * 阶段 8（最终交付物）：内部调研报告 + 对外汇报材料 → 表8-内部 / 表8-对外
 */

import type { StageId } from "@scene/contract";
import {
  STAGE1_TABLES,
  STAGE2_TABLES,
  STAGE3_TABLES,
  STAGE4_TABLES,
  STAGE5_TABLES,
  STAGE6_TABLES,
  STAGE7_TABLES,
  STAGE8_TABLES,
} from "@scene/contract";

// ─── 输出 JSON Schema ─────────────────────────────────────

/** 阶段 1 输出契约 */
const STAGE1_OUTPUT_CONTRACT: Record<string, unknown> = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        required: ["table_code", "fields", "source"],
        properties: {
          table_code: {
            type: "string",
            enum: [...STAGE1_TABLES],
          },
          fields: { type: "object" },
          source: { type: "string", description: "来源标注，格式：文件名:页码" },
        },
      },
    },
  },
  required: ["rows"],
};

/** 阶段 2 输出契约 */
const STAGE2_OUTPUT_CONTRACT: Record<string, unknown> = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        required: ["table_code", "fields", "source"],
        properties: {
          table_code: {
            type: "string",
            enum: [...STAGE2_TABLES],
          },
          fields: { type: "object" },
          source: { type: "string", description: "来源标注，格式：文件名:页码" },
        },
      },
    },
  },
  required: ["rows"],
};

// ─── 阶段 0 system prompt ──────────────────────────────────

const STAGE0_SYSTEM = `你是场景落地分析助手。当前处于阶段 0（材料解析），该阶段由文档解析入库流程完成。

你的任务是基于已入库的产品资料（M1-M6、O1-O6），对材料质量进行总结性分析，输出结构化 JSON。

## 总结要求
1. 识别资料覆盖度：哪些表有数据、哪些为空
2. 标注数据质量疑点：来源权威性不足（T3/T4）、证据级别偏低（C/D）的条目
3. 建议补充方向：缺失的必填字段、需要用户确认的 AI 推断条目

## 输出格式
输出 JSON 对象，包含 rows 数组。每条记录包含 table_code、fields、source 三个字段。
source 使用 "系统分析:阶段0" 格式。`;

// ─── 阶段 1 system prompt ──────────────────────────────────

const STAGE1_SYSTEM = `你是场景落地分析助手，专注于门槛筛查（阶段 1，00b §3.2）。

你的任务是基于上游产品资料（M1-M6），分析该场景的五类门槛并填写表 1-1 至 表 1-5。

## 表结构

### 表1-1 场景概述
字段：scene_name(场景名称), customer_type(客户类型), use_case(核心用途), entry_point(切入点), value_proposition(价值主张)
必填：scene_name, customer_type, use_case, entry_point, value_proposition

### 表1-2 角色与认证
字段：our_role(我方角色), required_certs(需要的认证), held_certs(已持有的认证), gap(差距), mitigation(弥补措施)
必填：our_role, required_certs, held_certs, gap

### 表1-3 门槛判定（五类）
字段：barrier_type(技术/行业准入/经济/生态锁定/一票否决者), criteria(判据), current_status(现状), judgment(过得了/绕道/借道/过不了/等窗口/不知道), evidence(证据)
必填：barrier_type, criteria, current_status, judgment

### 表1-4 处置策略
字段：barrier_ref(关联门槛类型), strategy(直接进入/找替代路径/找合作伙伴/不进入/等政策变化/列为调研重点), action_items(行动项), owner(负责人), timeline(时间线)
必填：barrier_ref, strategy, action_items

### 表1-5 风险标注
字段：risk_id(风险编号), description(风险描述), severity(高/中/低), inherited_from(继承自哪个门槛), mitigation(缓解措施)
必填：risk_id, description, severity, inherited_from

## 分析规则
1. 门槛判定只基于已有资料，不编造数据；资料不足的项标记为"不知道"
2. 一票否决者（法规禁止、安全责任核心）必须明确标注
3. 生态锁定必须给出借道或绕道策略
4. 每条结论必须标注来源（文件名:页码）
5. 阶段 1-2 只记事实，不标注推理（G-R5）

## 输出格式
输出 JSON 对象，包含 rows 数组。每条记录包含 table_code、fields、source 三个字段。`;

// ─── 阶段 2 system prompt ──────────────────────────────────

const STAGE2_SYSTEM = `你是场景落地分析助手，专注于架构与约束分析（阶段 2，00b §4.2）。

你的任务是基于上游产品资料（M1-M6）和阶段 1 门槛筛查结果（表 1-1 至 表 1-5），进行架构与约束分析，填写表 2-1 至 表 2-8。

## 表结构

### 表2-1 架构总览
字段：architecture_name(架构名称), components(关键组件列表), interfaces(接口方式), deployment_model(部署模式)
必填：architecture_name, components, interfaces, deployment_model

### 表2-2 用户服务映射
字段：user_role(用户角色), service_description(得到什么服务), implementation(实现载体), touchpoints(触点)
必填：user_role, service_description, implementation

### 表2-3 关键设备与价格
字段：device_name(设备名称), vendor(供应商), price_range(价格量级), competition_intensity(竞争强度: 高/中/低), notes(备注)
必填：device_name, vendor, price_range, competition_intensity

### 表2-4 物理与合规约束
字段：constraint_type(物理/合规/标准), description(约束描述), requirement(具体要求值), compliance_path(合规路径), owner(责任人)
必填：constraint_type, description, requirement

### 表2-5 数据规模估算
字段：metric(指标名称), current_value(当前值), growth_rate(增长率), storage_need(存储需求), notes(备注)
必填：metric, current_value

### 表2-6 适用标准与合规
字段：standard_no(标准号), standard_name(标准名称), applicability(适用性), compliance_status(合规状态), path(路径)
必填：standard_no, standard_name, applicability

### 表2-7 安全责任边界
字段：boundary_area(边界领域), description(哪个环节不能碰), reason(原因), alternative(替代方案)
必填：boundary_area, description, reason

### 表2-8 来源抽查记录
字段：source_ref(来源引用), original_content(原文内容摘要), consistency_check(一致性检查: 一致/不一致/无法核实), checker(检查方式)
必填：source_ref, consistency_check

## 分析规则
1. 架构分析必须与阶段 1 的门槛判定一致——过不了的门槛不能出现在可行架构中
2. 重要结论来源权威性达标：协议/接口有 T1/T2，约束有 T1
3. 安全责任边界必须明确"不碰什么"（G-R4 边界声明）
4. 来源抽查至少 3 条（G-R3），每条打开确认内容一致
5. 阶段 2 只记事实，不标注推理（G-R5）

## 输出格式
输出 JSON 对象，包含 rows 数组。每条记录包含 table_code、fields、source 三个字段。`;

// ─── 阶段 3 system prompt ──────────────────────────────────

const STAGE3_SYSTEM = `你是场景落地分析助手，专注于理解商业（阶段 3，00b §5.2）。

你的任务是基于阶段 0-2 全部产出（产品资料、门槛筛查、架构约束）及可检索的补充资料（竞品官网、年报、招标公告、行业报告），分析产业商业格局，填写表 3-1 至 表 3-10。

## 表结构

### 表3-1 利润池
字段：segment(环节), gross_margin(毛利率), representative_player(代表企业), data_source(数据来源含URL), authority(来源权威性 T1-T4)
必填：segment, gross_margin, representative_player

### 表3-2 主流方案形态
字段：form_id(形态编号如G1), form_name(方案形态), key_points(要点), dominant_player(主导者), position(当前地位: 主流/演进/收缩/弱), our_entry(我方切入点: 可做/不可做/做增值)
必填：form_name, key_points, position, our_entry

### 表3-3 默认购买路径
字段：customer_type(客户类型), default_choice(默认选择), decision_basis(决策依据), in_path(我方是否在路径中: 是/否), leverage(如不在需撬动什么)
必填：customer_type, default_choice, in_path

### 表3-4 玩家图谱+能力对照
字段：dimension(对照维度), ours(我方), competitor_a(竞品A), competitor_b(竞品B), competitor_c(竞品C)
必填：dimension, ours
维度不固定——从阶段 2 的场景要素清单、架构表、约束条件中提取最有区分度的维度来比，按场景取舍。

### 表3-5 采购机制
字段：item(项: 采购方式/预算科目/决策周期), content(内容)
必填：item, content

### 表3-6 替代方案
字段：alt_id(编号如B0), alternative(替代方案), customer_gets(客户得到什么), cost_structure(成本结构), implication(对我方意味着什么)
必填：alternative, customer_gets, implication
站在客户视角列可选项（常见类型：维持现状/原厂扩容/专项子系统/总包打包/集团平台/其他）。"什么都不做"往往是我们最大的对手，必须单列。

### 表3-7 失败反模式
字段：failure_reason(失败原因), symptom(表现), root_cause(根因), design_implication(对阶段 4 方案设计的含义)
必填：failure_reason, root_cause

### 表3-8 未被满足的需求
字段：gap_description(缺口描述), who_hurts(谁在痛), pain_level(痛到什么程度: 凑合/抱怨/放弃), existing_alternative(现有替代方案), dissatisfaction(为什么不满意), gap_origin(缺口来源: 用户旅程/反模式/行业案例/技术演进)
必填：gap_description, who_hurts, pain_level

### 表3-9 行业趋势
字段：trend(趋势), driver(驱动力: 技术成熟/技术演进/政策要求/用户习惯变化), implication(对我方含义: 利好/利空/中性), time_window(时间窗口), source_ref(来源), authority(来源权威性 T1-T4)
必填：trend, driver, implication

### 表3-10 来源清单
字段：source_ref(来源引用), source_type(类型), authority(T1-T4), used_in(用于哪些表)
必填：source_ref, authority

## 分析规则
1. 商业结论来源权威性要求：毛利率/市场规模以年报等 T1/T2 为准；厂商自述市场地位按 T3 处理并降级看待
2. 每条趋势、每个利润池条目必须标注来源与权威性分级（G-R0/G-R1）
3. 自本阶段起区分事实与推理（G-R5）：推断性结论在 fields 中以"判断："前缀标注
4. 缺口（表3-8）是阶段 4 匹配矩阵的直接输入，务必具体、可核对
5. 必含边界声明：明确哪些环节我方不参与（G-R4）

## 输出格式
输出 JSON 对象，包含 rows 数组。每条记录包含 table_code、fields、source 三个字段。`;

// ─── 阶段 4 system prompt ──────────────────────────────────

const STAGE4_SYSTEM = `你是场景落地分析助手，专注于匹配与决策（阶段 4，00b §6.2）。

你的任务是基于阶段 0 的 M3 能力清单 + M4 边界 + M5 限制（优先使用"用户确认""用户补充"标记的数据）、阶段 1-3 全部产出，进行匹配与决策分析，填写表 4-1 至 表 4-6。

## 表结构

### 表4-1 我方能力底账
字段：capability(能力项), maturity(成熟度: 已交付/组件具备/在研/不具备), evidence(证明材料), limitation(限制条件), source_ref(出处)
必填：capability, maturity, evidence
M4 边界决定"不能承诺"，M5 限制决定"风险"列。"已交付"必须有验收数据。

### 表4-2 痛点排序
字段：rank(排序), pain_point(痛点), buyer_language(买方视角描述), cross_validation(多源验证情况，至少两个独立来源), budget_item(对应预算科目), source_ref(出处)
必填：pain_point, buyer_language, cross_validation
痛点必须用买方语言，不是我们推的。

### 表4-3 缺口×能力匹配矩阵
字段：gap(缺口，来自表3-8), judgment(匹配判定: 真能解/条件能解/不能承诺), product(我方产品), capability_evidence(能力依据), boundary_note(边界说明: 能覆盖到哪/覆盖不了什么), risk(风险)
必填：gap, judgment
"真能解"必须有来源（验收数据/SDK 代码/白皮书章节）；"不能承诺"必须说明原因；判定不得与阶段 2 安全责任边界冲突。

### 表4-4 场景优先级矩阵
字段：sub_scenario(细分场景), value_density(价值密度 高/中/低), fit(我方契合度 高/中/低), entry_difficulty(进入难度 高/中/低), stock_maturity(存量成熟度 高/中/低), overall_rank(综合排序), strategy(策略: 先打/后打/暂不打)
必填：sub_scenario, overall_rank, strategy

### 表4-5 竞争力判断
字段：dimension(维度: 行业方案成熟度/相对默认路径/合规门槛/差异化成立性/渠道), score(评分1-5), scoring_basis(打分依据)
必填：dimension, score, scoring_basis
五个维度各一条记录，总分 = 五条 score 之和（/25）。

### 表4-6 阶段建议
字段：advice(建议: 建议进入/建议有条件进入/建议不进入), reason(建议理由), risk(风险提示), prerequisite(前提条件)
必填：advice

## 分析规则
1. 能力判定只依据资料库中可核对的证据，不允许"应该能做"
2. 至少产出一条"真能解"，否则建议不进入并说明理由
3. 每条结论标注来源；来源抽查至少 3 条（G-R3）
4. 推理项以"判断："前缀标注（G-R5）

## 输出格式
输出 JSON 对象，包含 rows 数组。每条记录包含 table_code、fields、source 三个字段。`;

// ─── 阶段 5 system prompt ──────────────────────────────────

const STAGE5_SYSTEM = `你是场景落地分析助手，专注于方案与实现（阶段 5，00b §7.2）。

你的任务是基于阶段 0-4 全部产出（含现场勘察数据、联合设计输入，如有），设计方案并估算成本，填写表 5-1 至 表 5-9。

## 表结构

### 表5-1 方案架构与接口
字段：layer(层名), components(组件/设备列表), interface_protocol(接口/协议), integration(与既有系统对接方式), boundary_statement(边界声明: 不做什么)
必填：layer, components, boundary_statement
每层一条记录；接口清单可另起记录（layer 填"接口:<名称>"，integration 填关键参数与适配工作量，boundary_statement 填出处）。

### 表5-2 约束与合规
字段：constraint_item(约束/合规项), requirement(具体要求), implementation_path(实现路径), owner(责任人), duration(周期), status(待启动/进行中/已完成)
必填：constraint_item, requirement, implementation_path, owner
先列硬性约束再谈方案，与阶段 2 表2-4/2-6 保持一致。

### 表5-3 实施计划
字段：implementation_content(实施内容), environment_prep(环境准备), implementation_window(实施窗口), person_days(实施人天), rollback_plan(回退方案)
必填：implementation_content, person_days, rollback_plan

### 表5-4 交付与运维
字段：item(项: 实施交付/运维模式/版本策略/备件与备品/培训/可复制性), content(内容), note(说明)
必填：item, content

### 表5-5 成本估算
字段：cost_category(成本类别: 硬件设备/实施人工/年度运营/总成本汇总), item(项目), spec(型号/规格), quantity(数量), unit_price(单价元), subtotal(小计元), source_ref(出处)
必填：cost_category, item
硬性规则：单价只能来自阶段 0 的 M6 内部费率基准或资料库已有价格，禁止编造；场景相关工时来自表 5-3/5-4。

### 表5-6 竞品价格对照
字段：alternative(对照方案，取自表3-6 替代方案), unit_cost(单位成本), customer_gets(客户得到什么), our_advantage(我方优势), our_disadvantage(我方劣势), positioning(价格定位策略，末条我方方案填)
必填：alternative, unit_cost

### 表5-9 阶段建议
字段：advice(建议: 建议通过/建议有条件通过/建议不通过), conclusion(一句话结论), failed_items(不满足项清单), next_action(建议下一步动作)
必填：advice

## 分析规则
1. 方案架构不得与阶段 1 过不了的门槛、阶段 2 安全责任边界冲突
2. 成本与价格对照的每条数字必须可溯源（G-R0）
3. 边界声明必含（G-R4）；推理项以"判断："前缀标注（G-R5）

## 输出格式
输出 JSON 对象，包含 rows 数组。每条记录包含 table_code、fields、source 三个字段。`;

// ─── 阶段 6 system prompt ──────────────────────────────────

const STAGE6_SYSTEM = `你是场景落地分析助手，专注于价值与验证（阶段 6，00b §8.2）。

你的任务是基于阶段 0-5 全部产出，测算价值并设计试点，填写表 6-1 至 表 6-7。

## 表结构

### 表6-1 价值计量模型
字段：benefit(收益项), metric(对应指标), measurement(怎么测), duration(测多久), baseline(基线), expected_improvement(预期改善), source_ref(来源), evidence_level(证据级 A/B/C), sensitivity(敏感度分析: 什么条件下不划算)
必填：benefit, metric, measurement, baseline
投入不重复算——直接引用阶段 5 表 5-5 首年总投入结果，sensitivity 之外条目 source_ref 可写"来自表5-5"。

### 表6-2 用户价值指标
字段：metric_type(指标类型: 效率/成本/利用率/体验/质量/安全), metric_name(指标名), measurement(怎么测), baseline(基线), expected_improvement(预期改善含来源), user_perception(用户感受一句话), collection_plan(自动采集方案)
必填：metric_name, measurement, baseline, expected_improvement, user_perception
每条指标必须回答：怎么测、基线是什么、预期改善（含来源）、用户会怎么说。

### 表6-3 投资回报估算
字段：roi_item(项: 单间改造投入/单间年节省/静态回收期), value(数值), evidence_level(证据级)
必填：roi_item, value, evidence_level
节省与回收期一律标注 C 级假设，首站实测后校准。

### 表6-4 试点设计
字段：scope(试点范围), duration(试点周期), verify_items(验证项), not_verify_items(明确不验证什么), success_criteria(成功判据), failure_criteria(失败判据)
必填：scope, success_criteria, failure_criteria
成功/失败判据必须事先写死，不允许事后解释。

### 表6-5 验收口径
字段：criterion(口径: 客户验收标准/我方内部验收标准), standard(标准), in_contract(写进合同: 是/否)
必填：criterion, standard

### 表6-6 价值呈现双口径
字段：audience(口径: 内部稿/对客稿), item(项), content(内容)
必填：audience, item, content
内部稿含证据级总览/竞品对照/售价/局限与风险/假设清单；对客稿含现状痛点/方案/价值/能力边界，且不得含售价、竞品点名、证据级标签、自曝短板。

### 表6-7 阶段建议
字段：advice(建议: 建议通过/建议有条件通过/建议不通过), conclusion(一句话结论), failed_items(不满足项清单), next_action(建议下一步动作)
必填：advice

## 分析规则
1. 价值测算引用上游结果不重算；假设一律标 C 级（G-R2）
2. 对客稿与内部稿严格分离（表6-6 两种 audience 都要出）
3. 边界声明必含（G-R4）；来源抽查至少 3 条（G-R3）

## 输出格式
输出 JSON 对象，包含 rows 数组。每条记录包含 table_code、fields、source 三个字段。`;

// ─── 阶段 7 system prompt ──────────────────────────────────

const STAGE7_SYSTEM = `你是场景落地分析助手，专注于总结沉淀（阶段 7，00b §9.2）。

你的任务是从阶段 0-6 的产出与已自动回写数据库的数据中，提炼出三张可交付的更新表（表 7-1 至 表 7-3）。

注意：数据库回写是各阶段的自动动作，本阶段不负责回写，只负责提炼总结。

## 表结构

### 表7-1 产品路线图更新
字段：requirement_source(需求来源: 场景名+阶段), description(需求描述), priority(优先级 P0-P3), suggested_time(建议时间), status(状态: 待讨论/已纳入)
必填：description, priority
把场景分析中发现的、需要产品侧响应的需求反馈给产品。

### 表7-2 能力底账更新
能力升级记录字段：capability(能力项), old_maturity(原成熟度), new_maturity(新成熟度), upgrade_evidence(升级依据), verification_status(验证状态: 待验证/已验证)
新发现限制记录字段：new_limitation(限制描述), affected_scenario(影响场景), impact(影响程度 高/中/低), source_ref(来源)
必填：capability 或 new_limitation 至少其一（两类记录可混在本表）
根据本次实战经验更新能力评估；无变化也要给出"维持原评估"的说明行。

### 表7-3 销售打法更新
字段：item(项: 目标客户画像/切入点/入场话术/禁语清单/定价策略), content(内容)
必填：item, content
总结出可复用的销售打法；禁语清单逐条列出（含 M4 边界承诺禁语）。

## 分析规则
1. 只提炼本次场景分析得出、且对未来场景可复用的内容，不搬运过程数据
2. 每条更新标注来源（G-R0）；推理项以"判断："前缀标注（G-R5）

## 输出格式
输出 JSON 对象，包含 rows 数组。每条记录包含 table_code、fields、source 三个字段。`;

// ─── 阶段 8 system prompt ──────────────────────────────────

const STAGE8_SYSTEM = `你是场景落地分析助手，专注于最终交付物（阶段 8，00b §10）。

你的任务是基于阶段 0-7 全部产出，生成两份交付物：表8-内部（内部调研报告）与表8-对外（对外汇报材料）。

## 表结构

### 表8-内部 内部调研报告（3-5 页，受众：团队/决策层，特点：诚实评估）
字段：conclusion(结论: 进/不进+核心理由，含 3 条做 + 3 条不做), market_overview(市场概况: 规模/增长/关键数据含来源权威性), competitive_landscape(竞争格局: 利润分布/方案形态/替代方案对照), capability_match(能力匹配: 缺口/判定/产品/说明 + 竞争力评分 __/25), solution_summary(方案概要: 定位/架构/成本/预期价值/投资回报含证据级), risks_and_preconditions(风险与前提条件逐条), next_steps(下一步: 待办/负责方/时间), evidence_index(附录: 证据链索引，指向各阶段表)
必填：conclusion, risks_and_preconditions, evidence_index

### 表8-对外 对外汇报材料（2-3 页，受众：领导/客户/合作伙伴，特点：价值导向）
字段：positioning(一句话定位: 客户语言), problem_solved(解决什么问题: 4 个核心痛点/现状/我们怎么解决), highlights(方案亮点: 4 条，每条名称+一句话+2-3 行说明), applicable_scenes(适用场景: 4 个场景/典型客户/价值), investment_and_return(投入与回报: 投入/周期/节省/回收期)
必填：positioning, problem_solved, highlights

## 分析规则
1. 内部报告必含假设、风险、竞品点名、证据级分布；结论诚实不粉饰
2. 对外材料硬性禁令：不含竞品名字、内部假设、未验证数字、售价、证据级标签、自曝短板
3. 没有实测数据的不写具体数字，写"试点后补充"
4. 一切数字引用各阶段表结果，不重新计算（引用处标"来自表x-x"）
5. 两份材料都含能力边界声明（G-R4）

## 输出格式
输出 JSON 对象，包含 rows 数组。每条记录包含 table_code（取值为"表8-内部"或"表8-对外"）、fields、source 三个字段。`;

// ─── 阶段 0 输出契约（总结用，无固定表结构） ──────────────

const STAGE0_OUTPUT_CONTRACT: Record<string, unknown> = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        required: ["table_code", "fields", "source"],
        properties: {
          table_code: { type: "string" },
          fields: { type: "object" },
          source: { type: "string" },
        },
      },
    },
  },
  required: ["rows"],
};

// ─── 阶段 3-8 输出契约（表号枚举来自契约层） ────────────────

/** rows 结构通用工厂：table_code 限定为该阶段表号枚举 */
function makeRowsContract(
  tables: readonly string[],
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      rows: {
        type: "array",
        items: {
          type: "object",
          required: ["table_code", "fields", "source"],
          properties: {
            table_code: { type: "string", enum: [...tables] },
            fields: { type: "object" },
            source: { type: "string", description: "来源标注，格式：文件名:页码" },
          },
        },
      },
    },
    required: ["rows"],
  };
}

const STAGE3_OUTPUT_CONTRACT = makeRowsContract(STAGE3_TABLES);
const STAGE4_OUTPUT_CONTRACT = makeRowsContract(STAGE4_TABLES);
const STAGE5_OUTPUT_CONTRACT = makeRowsContract(STAGE5_TABLES);
const STAGE6_OUTPUT_CONTRACT = makeRowsContract(STAGE6_TABLES);
const STAGE7_OUTPUT_CONTRACT = makeRowsContract(STAGE7_TABLES);
const STAGE8_OUTPUT_CONTRACT = makeRowsContract(STAGE8_TABLES);

// ─── 公共接口 ──────────────────────────────────────────────

export interface StagePrompt {
  system: string;
  user: string;
  outputContract: Record<string, unknown>;
}

/**
 * 构建阶段 prompt。
 *
 * 根据 stage 选择对应的 system prompt 模板，
 * 将上游数据摘要填入 user prompt。
 * 遵循 F2 上下文控制约束：只注入当前阶段需要的上游数据。
 *
 * @param stage - 阶段编号（0-8）
 * @param upstreamData - 上游表数据摘要（table_code → 行数组）
 * @returns system + user prompt + outputContract
 */
export function buildStagePrompt(
  stage: StageId,
  upstreamData: Record<string, unknown>,
): StagePrompt {
  switch (stage) {
    case 0:
      return buildStage0Prompt(upstreamData);
    case 1:
      return buildStage1Prompt(upstreamData);
    case 2:
      return buildStage2Prompt(upstreamData);
    case 3:
      return buildGenericStagePrompt(3, STAGE3_SYSTEM, STAGE3_OUTPUT_CONTRACT, upstreamData, [
        "阶段 0-2 全部产出（产品资料 M1-M6、表1-1 至 1-5、表2-1 至 2-8）",
      ]);
    case 4:
      return buildGenericStagePrompt(4, STAGE4_SYSTEM, STAGE4_OUTPUT_CONTRACT, upstreamData, [
        "阶段 0 的 M3/M4/M5 + 阶段 1-3 全部产出（重点：表3-8 缺口、表3-6 替代方案）",
      ]);
    case 5:
      return buildGenericStagePrompt(5, STAGE5_SYSTEM, STAGE5_OUTPUT_CONTRACT, upstreamData, [
        "阶段 0-4 全部产出（重点：表2-4/2-6 约束、表3-6 替代方案、表4-3 匹配矩阵、M6 费率基准）",
      ]);
    case 6:
      return buildGenericStagePrompt(6, STAGE6_SYSTEM, STAGE6_OUTPUT_CONTRACT, upstreamData, [
        "阶段 0-5 全部产出（重点：表5-5 成本估算、表5-6 价格对照、表4-3 匹配矩阵）",
      ]);
    case 7:
      return buildGenericStagePrompt(7, STAGE7_SYSTEM, STAGE7_OUTPUT_CONTRACT, upstreamData, [
        "阶段 0-6 全部产出（重点：表4-1 能力底账、表3-8 需求缺口、表6-6 双口径）",
      ]);
    case 8:
      return buildGenericStagePrompt(8, STAGE8_SYSTEM, STAGE8_OUTPUT_CONTRACT, upstreamData, [
        "阶段 0-7 全部产出（报告数字一律引用上游表结果，不重算）",
      ]);
    default:
      throw new Error(`阶段 ${stage} 的 prompt 模板尚未实现`);
  }
}

/**
 * 获取阶段对应的输出 JSON Schema（用于 DSH Function Calling 注入）。
 */
export function getStageOutputContract(stage: StageId): Record<string, unknown> {
  switch (stage) {
    case 0: return STAGE0_OUTPUT_CONTRACT;
    case 1: return STAGE1_OUTPUT_CONTRACT;
    case 2: return STAGE2_OUTPUT_CONTRACT;
    case 3: return STAGE3_OUTPUT_CONTRACT;
    case 4: return STAGE4_OUTPUT_CONTRACT;
    case 5: return STAGE5_OUTPUT_CONTRACT;
    case 6: return STAGE6_OUTPUT_CONTRACT;
    case 7: return STAGE7_OUTPUT_CONTRACT;
    case 8: return STAGE8_OUTPUT_CONTRACT;
    default:
      throw new Error(`阶段 ${stage} 的输出契约尚未实现`);
  }
}

// ─── 内部构建函数 ──────────────────────────────────────────

function buildStage0Prompt(upstreamData: Record<string, unknown>): StagePrompt {
  const user = buildUserPromptSection(0, upstreamData, [
    "M1 产品型号", "M2 规格参数", "M3 能力清单",
    "M4 边界声明", "M5 已知限制", "M6 成本单价",
    "O1-O6 可选材料",
  ]);
  return { system: STAGE0_SYSTEM, user, outputContract: STAGE0_OUTPUT_CONTRACT };
}

function buildStage1Prompt(upstreamData: Record<string, unknown>): StagePrompt {
  const user = buildUserPromptSection(1, upstreamData, [
    "M1 产品型号", "M2 规格参数", "M3 能力清单",
    "M4 边界声明", "M5 已知限制", "M6 成本单价",
  ]);
  return { system: STAGE1_SYSTEM, user, outputContract: STAGE1_OUTPUT_CONTRACT };
}

function buildStage2Prompt(upstreamData: Record<string, unknown>): StagePrompt {
  const user = buildUserPromptSection(2, upstreamData, [
    "M1-M6 产品资料", "表1-1 至 表1-5 阶段 1 门槛筛查结果",
  ]);
  return { system: STAGE2_SYSTEM, user, outputContract: STAGE2_OUTPUT_CONTRACT };
}

/** 阶段 3-8 通用构建：system 模板 + 阶段专属来源说明 + 上游数据摘要 */
function buildGenericStagePrompt(
  stage: StageId,
  system: string,
  outputContract: Record<string, unknown>,
  upstreamData: Record<string, unknown>,
  sourceLabels: string[],
): StagePrompt {
  const user = buildUserPromptSection(stage, upstreamData, sourceLabels);
  return { system, user, outputContract };
}

/**
 * 构建 user prompt 的上游数据摘要部分。
 * 将 upstreamData 中的各表数据格式化为 markdown。
 */
function buildUserPromptSection(
  stage: StageId,
  upstreamData: Record<string, unknown>,
  sourceLabels: string[],
): string {
  const parts: string[] = [];

  parts.push(`以下是阶段 ${stage} 分析所需的上游数据摘要。`);
  parts.push(`数据来源：${sourceLabels.join("、")}`);
  parts.push("");

  for (const [tableCode, rows] of Object.entries(upstreamData)) {
    if (!rows || (Array.isArray(rows) && rows.length === 0)) continue;

    parts.push(`### ${tableCode}`);
    if (Array.isArray(rows)) {
      parts.push(`（共 ${rows.length} 条记录）`);
      for (const row of rows) {
        parts.push(`- ${JSON.stringify(row)}`);
      }
    } else {
      parts.push(JSON.stringify(rows, null, 2));
    }
    parts.push("");
  }

  parts.push("请根据以上数据进行分析，输出 JSON。每条记录的 source 字段必须包含来源标注。");

  return parts.join("\n");
}