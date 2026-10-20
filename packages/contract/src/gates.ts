/**
 * output-gates — 每张表的「输出门限」（可机器判定，契约层）
 *
 * 用户定调（2026-10-20）：「明确每个表格的生成要求，输出检查门限，一定要确保输出内容的价值。
 * 没价值的内容删除」。
 *
 * 与 `completeness` 的分工（两者都要，不是二选一）：
 *   - `completeness`：给人看的生成要求（自然语言），进提示词，告诉模型"这一行该写成什么样"
 *   - `TABLE_GATES`：给机器判的门限（本文件），生成后逐条跑，**不达标就点名**
 *
 * 为什么必须可判定：提示词是建议，不是判定。写「供应商须具名」模型照样可能写「行业主流厂商」；
 * 只有把门限写成代码，才能在生成后拦住它，也才能回答"这张表的输出到底值不值钱"。
 *
 * 判定落 `packages/domain/src/output-gates.ts`，模型不参与判定（AGENTS §三.5、G-0.3）。
 */

/** 门限的生效范围：仅当某列有值/为空时才判（一张表装两类行时用） */
export interface GateScope {
  column: string;
  /** 有值/为空时才判（缺省按 equals 分支） */
  present?: boolean;
  /** 等于某值时才判（同一张表装多种 payload 时用，如可选材料的 O1/O2/O3） */
  equals?: string;
}

export type GateSpec =
  /** 必填列非空（含占位词也算不达标） */
  | { kind: "non-empty"; columns: readonly string[]; text: string }
  /** 至少一列里有具体数值（带单位/量级） */
  | { kind: "has-number"; columns: readonly string[]; text: string }
  /** 必须落到具名主体（厂商名、协议名、标准号…），不许「行业主流」「待确认」 */
  | { kind: "named"; columns: readonly string[]; text: string }
  /** 并列项（、/，/；分隔）至少 n 项 */
  | { kind: "min-items"; column: string; min: number; text: string }
  /** 取值必须落在给定枚举内 */
  | { kind: "enum"; column: string; values: readonly string[]; text: string }
  /** 取值必须落在该列自己的枚举内（枚举只定义一处，避免漂移） */
  | { kind: "enum-of-column"; column: string; text: string }
  /** 同表内该列不许重复（阶段3 与 M3 撞名那种要能发现） */
  | { kind: "unique"; columns: readonly string[]; text: string }
  /** 必须覆盖某集合（漏一层就点名） */
  | { kind: "coverage"; column: string; values: readonly string[]; text: string }
  /** 跨表核对：本表该列的值须在另一张表里存在（如关系两端须是场景要素） */
  | { kind: "cross-ref"; column: string; table: string; target: string; text: string }
  /** 数值列合计须等于目标值（如权重合计 100） */
  | { kind: "sum-to"; column: string; target: number; tolerance: number; text: string }
  /** 不许空话（「注意风险」「加强管理」这类写了等于没写） */
  | { kind: "not-vague"; columns: readonly string[]; text: string }
  /** 不许把「合计/总计」当数据行写进表里（派生值不是发现） */
  | { kind: "no-aggregate-row"; column: string; text: string }
  /** 定制判定：门槛三问（表1-3） */
  | { kind: "gate-questions"; text: string }
  /** 定制判定：约束成立性（表2-5） */
  | { kind: "constraint-check"; text: string };

/** 带作用域的门限 */
export type ScopedGate = GateSpec & { when?: GateScope };

export const TABLE_GATES: Readonly<Record<string, readonly ScopedGate[]>> = {
  M1: [
    { kind: "enum", column: "status", values: ["在售", "停售", "在研", "规划"], text: "状态须是 在售/停售/在研/规划（「待确认」不算回答）" },
    { kind: "unique", columns: ["model"], text: "同一型号只登记一行（扩展单元并入所属型号）" }
  ],
  M2: [
    { kind: "enum-of-column", column: "param_class", text: "参数类只取八类（核心配置/接口与端口/电气规格/环境与防护/机械结构/通信协议/认证与安规/软件）" },
    { kind: "cross-ref", column: "product_id", table: "M1", target: "model", text: "参数须挂在 M1 现存型号上" }
  ],
  M3: [
    { kind: "non-empty", columns: ["inapplicable_scene"], text: "不适用场景必填（什么工况下不能用）" },
    { kind: "unique", columns: ["name"], text: "同一能力只登记一行" }
  ],
  M4: [
    { kind: "not-vague", columns: ["description", "response"], text: "边界与客户硬要求时的做法须具体（谁做、钱算谁的），不许「以实际为准/暂不涉及/后续再议」" }
  ],
  M5: [
    { kind: "cross-ref", column: "product_name", table: "M1", target: "model", text: "限制须挂在具体型号上（不许写「我方产品」）" },
    { kind: "not-vague", columns: ["description"], text: "限制须是可复现缺陷（什么工况出现、影响什么），免责话术不算" }
  ],
  可选材料: [
    { kind: "enum-of-column", column: "category", text: "材料类别取该列枚举" },
    { kind: "non-empty", columns: ["cert_no", "valid_until", "issuer"], text: "认证类材料须给证书号、有效期与发证机构（无证书号视为未取得）", when: { column: "category", equals: "O1认证" } },
    { kind: "non-empty", columns: ["delivered_at", "acceptance"], text: "案例类材料须给交付时间与可验收指标（「效果良好」不算）", when: { column: "category", equals: "O2案例" } },
    { kind: "has-number", columns: ["price"], text: "价格须给金额与计价单位（含税口径写右栏）", when: { column: "category", equals: "O3价格" } }
  ],

  "表1-1": [
    { kind: "non-empty", columns: ["item", "content"], text: "项与内容必填（「待定」最多一格并写明缺什么才能定）" }
  ],
  "表1-3": [
    { kind: "gate-questions", text: "每行须过门槛三问：外部主体 + 可核验凭据 + 不满足即出局" },
    { kind: "named", columns: ["veto_holder"], text: "否决者须具名（机关/客户部门/认证机构），不许「相关方/行业」" }
  ],
  "表2-2": [
    { kind: "non-empty", columns: ["element_name", "element_type", "function", "vendor", "price_range"], text: "五项都必填" },
    { kind: "enum-of-column", column: "element_type", text: "类型须落在该列枚举内（硬件/软件/服务）" },
    { kind: "named", columns: ["vendor"], text: "供应商须写可查的厂商名；禁「行业主流厂商/系统集成商/各厂商实施团队/第三方服务商」" },
    { kind: "has-number", columns: ["price_range"], text: "价格须给人民币金额量级（元/千元/万元/百万元）；纯比例或纯规格值不算" },
    { kind: "unique", columns: ["element_name"], text: "同一要素只登记一行" }
  ],
  "表2-4": [
    { kind: "non-empty", columns: ["interaction_type", "from_to", "method"], text: "类型/起终点/方式必填" },
    { kind: "cross-ref", column: "from_to", table: "表2-2", target: "element_name", text: "关系两端须点名要素或具名外部主体（监管平台/电网/运营商/上级平台放行），禁「各类/各系统」" },
    { kind: "named", columns: ["method"], text: "方式须落到协议名/标准号，或「私有协议（厂商：X）」" },
    { kind: "not-vague", columns: ["from_to"], text: "起终点须是具名主体，不许写「各类设备/各系统/若干」" },
    { kind: "not-vague", columns: ["method"], text: "方式须写清协议 + 经哪一层/哪一网段 + 谁开放接口，不许「经院内网对接」这类无主体写法" }
  ],
  "表2-5": [
    { kind: "constraint-check", text: "每行须可执行（数值/等级/清单至少一样）+ 点明适用对象，且不是门槛复述" },
    { kind: "non-empty", columns: ["standard_no"], text: "适用标准号/规范名必填（国标号、行标号、客户制度名或图纸条款号）" }
  ],

  "表3-1": [
    { kind: "non-empty", columns: ["link", "gross_margin", "representative"], text: "环节/毛利/代表厂商必填" },
    { kind: "has-number", columns: ["gross_margin"], text: "毛利须给百分数区间或单值，并标口径（年报/项目成交/集采后）" },
    { kind: "unique", columns: ["link"], text: "一行一环节，同一环节不重复" },
    { kind: "min-items", column: "representative", min: 2, text: "代表企业至少 2 家具名可查主体" }
  ],
  "表3-2": [
    { kind: "non-empty", columns: ["form", "key_points", "leader"], text: "形态/要点/主导厂商必填" },
    { kind: "unique", columns: ["form"], text: "同一形态只写一行；form 写形态名称，不写编号" },
    { kind: "enum-of-column", column: "position", text: "地位取该列枚举（扩张/稳定/收缩）" },
    { kind: "coverage", column: "position", values: ["扩张"], text: "必须指出正在扩张的形态；全行业无扩张时写一行明示" }
  ],
  "表3-3": [
    { kind: "non-empty", columns: ["customer_type", "decision_maker", "user_role", "payer", "default_choice", "budget_item"], text: "客户类型/拍板/使用/付费/默认选择/预算科目必填" },
    { kind: "has-number", columns: ["decision_cycle"], text: "决策周期须给月数区间（1–3／3–9 个月）" }
  ],
  "表3-4": [
    { kind: "non-empty", columns: ["dimension", "competitor_a", "competitor_b", "competitor_c"], text: "维度与主要竞品必填" },
    { kind: "unique", columns: ["dimension"], text: "同一维度只一行，且维度名须含口径（如「单病区价格量级」）" },
    { kind: "not-vague", columns: ["competitor_a", "competitor_b", "competitor_c", "competitor_d"], text: "取值须是数字或具名事实，禁「较强/偏弱/较高/有限/为主/推进中」" }
  ],
  "表3-5": [
    { kind: "non-empty", columns: ["link", "who_supplies", "concentration", "supply_risk"], text: "环节/供给方/集中度/断供风险必填" },
    { kind: "named", columns: ["who_supplies"], text: "供给方须点名厂商/产品或「前三家：A/B/C（合计份额 X%）」，不许只写「多家」" },
    { kind: "enum-of-column", column: "concentration", text: "集中度取该列枚举" },
    { kind: "enum-of-column", column: "substitutability", text: "可替代性取该列枚举" },
    { kind: "enum-of-column", column: "bargaining", text: "议价权取该列枚举" },
    { kind: "has-number", columns: ["supply_risk"], text: "被卡点须给交期周数/份额%/家数/认证月数之一" }
  ],
  "表3-7": [
    { kind: "non-empty", columns: ["pitfall", "consequence", "avoid_in_design"], text: "坑/后果/规避必填" },
    { kind: "has-number", columns: ["consequence"], text: "后果须给钱/工期/安全量级（返工 3 人月、停机 2 天、返修率 5%）" },
    { kind: "not-vague", columns: ["avoid_in_design"], text: "规避须落到设计措施 + 验收/合同落点，不许「注意风险/提前沟通」" }
  ],
  "表3-8": [
    { kind: "non-empty", columns: ["gap", "who_hurts", "pain_level", "cross_validation"], text: "缺口/谁疼/痛级/多源验证必填" },
    { kind: "unique", columns: ["rank"], text: "排序不许重复（1..n 连续）" },
    { kind: "unique", columns: ["gap"], text: "同一缺口只登记一行（它是表4-3 的引用锚）" },
    { kind: "enum-of-column", column: "pain_level", text: "痛级取该列枚举" },
    { kind: "has-number", columns: ["gap"], text: "缺口须带现状值与差距量（0.38→0.28 kWh/m³）" }
  ],
  "表3-9": [
    { kind: "non-empty", columns: ["trend", "driver", "impact", "window"], text: "趋势/驱动/影响/窗口必填" },
    { kind: "named", columns: ["driver"], text: "驱动力须具名（文件号/标准号/补贴名/招标条款）" },
    { kind: "min-items", column: "impact", min: 2, text: "影响须分别写对客户与对在位供应商" },
    { kind: "has-number", columns: ["window"], text: "时间窗口须给年份或月数（2027 前、18 个月内），不接受「未来几年」" }
  ],

  "表1-2": [
    { kind: "non-empty", columns: ["link", "owner_now", "current_tool", "current_flow", "pain"], text: "环节/现在谁在做/用什么/怎么做/痛点必填" },
    { kind: "unique", columns: ["link"], text: "同一业务环节只写一行" },
    { kind: "has-number", columns: ["current_flow"], text: "现状做法须给频次或单次耗时（每班 2 次、每次 30 分钟）" },
    { kind: "not-vague", columns: ["pain"], text: "痛点须写「哪一步、错/慢/漏多少」，不许「效率低/易出错」" }
  ],
  "表4-1": [
    { kind: "non-empty", columns: ["ability", "maturity"], text: "能力与成熟度必填" },
    { kind: "unique", columns: ["ability"], text: "同一能力不许重复登记（会虚高能力面）" },
    { kind: "enum-of-column", column: "maturity", text: "成熟度取该列枚举" },
    { kind: "cross-ref", column: "ability", table: "M3", target: "name", text: "能力项须逐字用 M3 能力清单的名字（改名即视为新能力，会虚高）" }
  ],
  "表4-2": [
    { kind: "non-empty", columns: ["link", "can_touch", "our_role", "role_reason"], text: "环节/能否碰/我方角色/依据必填" },
    { kind: "cross-ref", column: "link", table: "表1-2", target: "link", text: "环节须与表1-2 逐字同名" },
    { kind: "enum-of-column", column: "can_touch", text: "能否碰取该列枚举" },
    { kind: "enum-of-column", column: "our_role", text: "我方角色取该列枚举" }
  ],
  "表4-3": [
    { kind: "non-empty", columns: ["gap_ref", "match", "our_product", "ability_basis"], text: "缺口/匹配结论/我方产品/依据必填" },
    { kind: "cross-ref", column: "gap_ref", table: "表3-8", target: "gap", text: "缺口须逐字复述表3-8 缺口原文（写编号不算），源表改字必须重跑本表" },
    { kind: "enum-of-column", column: "match", text: "匹配结论取该列枚举" },
    { kind: "unique", columns: ["gap_ref"], text: "同一缺口只对照一次" }
  ],
  "表4-4": [
    { kind: "non-empty", columns: ["sub_scene", "value_density", "fit", "difficulty", "stock_maturity", "rank"], text: "细分/四维度/综合排序必填" },
    { kind: "unique", columns: ["rank"], text: "排名不许重复（1、1、1 视为未排序）" }
  ],
  "表4-5": [
    { kind: "non-empty", columns: ["dimension", "weight", "score", "basis"], text: "维度/权重/评分/依据必填" },
    { kind: "enum", column: "score", values: ["1", "2", "3", "4", "5"], text: "评分只填 1-5 整数（1 明显劣势、3 持平、5 明显优势）" },
    { kind: "no-aggregate-row", column: "dimension", text: "不许写「合计/总计/综合赢面」这类派生行（合计由门限核对）" },
    { kind: "sum-to", column: "weight", target: 100, tolerance: 0.5, text: "权重合计须为 100" }
  ],

  "表5-1": [
    { kind: "non-empty", columns: ["layer", "components", "interface", "integration"], text: "架构块：层/组件/接口/对接方式必填", when: { column: "interface_name", present: false } },
    { kind: "non-empty", columns: ["interface_name", "type", "protocol"], text: "接口块：接口名称/类型/协议必填", when: { column: "interface_name", present: true } },
    { kind: "named", columns: ["interface"], text: "架构块的接口须给协议名或标准号，不许「标准协议」", when: { column: "interface_name", present: false } },
    { kind: "not-vague", columns: ["boundary"], text: "边界声明须写清我方不做X／客户负责Y／第三方负责Z，不许「以实际为准」", when: { column: "interface_name", present: false } }
  ],
  "表5-3": [
    { kind: "non-empty", columns: ["item", "content", "window", "man_days", "rollback"], text: "事项/内容/时间窗/人天/回退必填（回退写清回退点与触发条件）" },
    { kind: "has-number", columns: ["man_days"], text: "人天须为整数（≥1），不许 0、约、待评估" },
    { kind: "unique", columns: ["item"], text: "同一实施项不许重复登记（拆行会虚增人天）" },
    { kind: "not-vague", columns: ["rollback"], text: "回退须给回退点 + 触发条件 + 耗时，不许「按需回退」" }
  ],
  "表5-4": [
    { kind: "non-empty", columns: ["item", "content", "sla"], text: "交付项/内容/SLA 必填" },
    { kind: "has-number", columns: ["sla"], text: "SLA 须给响应时限与恢复时限（≤2 小时／≤8 小时）及可用率或到场时限" },
    { kind: "min-items", column: "sla", min: 2, text: "SLA 至少两项时限（响应 + 恢复/到场）" }
  ],

  "表6-1": [
    { kind: "non-empty", columns: ["benefit", "metric", "expected", "how_to_measure", "user_feeling"], text: "收益/指标/预期/怎么测/用户感受必填" },
    { kind: "has-number", columns: ["expected"], text: "预期改善须数值+单位（≤2 小时／↓30%／98.5%），不接受「提升至…」「显著提升」" },
    { kind: "unique", columns: ["metric"], text: "同一指标不许重复登记（防一条收益拆三条）" }
  ],
  "表6-4": [
    { kind: "non-empty", columns: ["kind", "content"], text: "类别与内容必填" },
    { kind: "coverage", column: "kind", values: ["试点范围", "试点时长", "成功判据", "验收口径"], text: "须覆盖试点范围、试点时长、成功判据、验收口径" },
    { kind: "not-vague", columns: ["content"], text: "成功判据须给阈值+取数方式+判定人，不许「运行稳定/客户满意」" }
  ],
};

/** 某张表的门限（没有登记的返回空数组，测试会拦） */
export function gatesOf(tableCode: string): readonly ScopedGate[] {
  return TABLE_GATES[tableCode] ?? [];
}

/** 门限的人话（进提示词与文档，和 completeness 一起给模型看） */
export function gateRequirementText(gate: GateSpec): string {
  return gate.text;
}
