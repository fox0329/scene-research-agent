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

export const TABLE_GATES: Readonly<Record<string, readonly GateSpec[]>> = {
  M1: [
    { kind: "non-empty", columns: ["model", "name", "status"], text: "型号/名称/状态必填" },
  ],
  M2: [
    { kind: "non-empty", columns: ["param_class", "param_name", "value"], text: "参数分类/参数/取值必填" },
    { kind: "has-number", columns: ["value"], text: "取值须是可比的数值或等级（如 6TOPS、IP67、-20~60℃）" },
  ],
  M3: [
    { kind: "non-empty", columns: ["domain", "name", "maturity"], text: "领域/能力/成熟度必填" },
    { kind: "unique", columns: ["name"], text: "同一能力不许重复登记（会虚高能力面）" },
  ],
  M4: [{ kind: "non-empty", columns: ["description"], text: "边界描述必填（说不做什么）" }],
  M5: [
    { kind: "non-empty", columns: ["product_name", "impact"], text: "产品与影响必填" },
    { kind: "non-empty", columns: ["fix_status"], text: "处置状态必填（已修/计划/不修要写清）" },
  ],
  可选材料: [{ kind: "non-empty", columns: ["category"], text: "材料类别必填" }],

  "表1-1": [
    { kind: "non-empty", columns: ["item", "content"], text: "项与内容必填" },
    { kind: "min-items", column: "content", min: 1, text: "内容不能只写占位词" },
  ],
  "表1-3": [
    { kind: "gate-questions", text: "每行须过门槛三问：外部主体 + 可核验凭据 + 不满足即出局" },
    { kind: "non-empty", columns: ["barrier_type", "barrier_name", "criteria"], text: "类型/门槛/判据必填" },
  ],
  "表2-2": [
    { kind: "non-empty", columns: ["element_name", "element_type", "function", "vendor", "price_range"], text: "五项都必填" },
    { kind: "enum", column: "element_type", values: ["硬件", "软件", "服务", "集成", "耗材"], text: "类型须落在枚举内" },
    { kind: "named", columns: ["vendor"], text: "供应商须写具体厂商，不许「行业主流厂商」" },
    { kind: "has-number", columns: ["price_range"], text: "价格须带量级（元/千元/万元/百万元）" },
  ],
  "表2-3": [
    { kind: "non-empty", columns: ["layer", "components", "interface"], text: "层级/组件/接口必填" },
    { kind: "min-items", column: "components", min: 2, text: "每层至少 2 个具名组件" },
    { kind: "unique", columns: ["layer"], text: "同一层不许重复" },
  ],
  "表2-4": [
    { kind: "non-empty", columns: ["interaction_type", "from_to", "method"], text: "类型/起终点/方式必填" },
    { kind: "cross-ref", column: "from_to", table: "表2-2", target: "element_name", text: "关系两端须是表2-2 里的要素" },
  ],
  "表2-5": [
    { kind: "constraint-check", text: "每行须可执行（数值/等级/清单至少一样），且不是门槛复述" },
  ],

  "表3-1": [
    { kind: "non-empty", columns: ["link", "gross_margin", "representative"], text: "环节/毛利/代表厂商必填" },
    { kind: "has-number", columns: ["gross_margin"], text: "毛利须给数值区间（%）" },
  ],
  "表3-2": [
    { kind: "non-empty", columns: ["form", "key_points", "leader"], text: "形态/要点/主导厂商必填" },
    { kind: "unique", columns: ["form"], text: "同一方案形态只写一行" },
  ],
  "表3-3": [
    { kind: "non-empty", columns: ["customer_type", "decision_maker", "user_role", "payer", "budget_item"], text: "客户类型/拍板/使用/付费/预算科目必填" },
  ],
  "表3-4": [
    { kind: "non-empty", columns: ["dimension", "competitor_a", "competitor_b", "competitor_c"], text: "维度与主要竞品必填" },
    { kind: "unique", columns: ["dimension"], text: "同一对照维度只写一行" },
  ],
  "表3-5": [
    { kind: "non-empty", columns: ["link", "who_supplies", "concentration", "supply_risk"], text: "环节/供给方/集中度/断供风险必填" },
    { kind: "named", columns: ["who_supplies"], text: "供给方须具名，不许「多家」了事" },
  ],
  "表3-7": [
    { kind: "non-empty", columns: ["pitfall", "consequence", "avoid_in_design"], text: "坑/后果/规避必填" },
    { kind: "not-vague", columns: ["avoid_in_design"], text: "规避措施须落到具体做法（写进合同/交付物/验收条款），不许「注意风险」" },
  ],
  "表3-8": [
    { kind: "non-empty", columns: ["gap", "who_hurts", "pain_level"], text: "缺口/谁疼/痛级必填" },
    { kind: "has-number", columns: ["rank"], text: "排序须给数字" },
  ],
  "表3-9": [
    { kind: "non-empty", columns: ["trend", "driver", "impact", "window"], text: "趋势/驱动/影响/窗口必填" },
    { kind: "has-number", columns: ["window"], text: "时间窗口须给时间（年内/1-3 年）" },
  ],

  "表1-2": [
    { kind: "non-empty", columns: ["link", "owner_now", "current_tool", "current_flow", "pain"], text: "环节/现在谁在做/用什么/怎么做/痛点必填" },
    { kind: "unique", columns: ["link"], text: "同一业务环节只写一行" },
  ],
  "表4-1": [
    { kind: "non-empty", columns: ["ability", "maturity", "limitation"], text: "能力/成熟度/限制必填" },
    { kind: "unique", columns: ["ability"], text: "同一能力不许重复登记（直接决定能否判「不能碰」）" },
  ],
  "表4-2": [
    { kind: "non-empty", columns: ["link", "can_touch", "our_role", "role_reason"], text: "环节/能否碰/我方角色/依据必填" },
    { kind: "cross-ref", column: "link", table: "表1-2", target: "link", text: "环节须与表1-2 一致" },
  ],
  "表4-3": [
    { kind: "non-empty", columns: ["gap_ref", "match", "our_product", "ability_basis"], text: "缺口/匹配结论/我方产品/依据必填" },
    { kind: "cross-ref", column: "gap_ref", table: "表3-8", target: "gap", text: "缺口须来自表3-8" },
  ],
  "表4-4": [
    { kind: "non-empty", columns: ["sub_scene", "value_density", "fit", "difficulty"], text: "细分/价值密度/匹配/难度必填" },
    { kind: "has-number", columns: ["rank"], text: "排序须给数字" },
  ],
  "表4-5": [
    { kind: "non-empty", columns: ["dimension", "weight", "score", "basis"], text: "维度/权重/得分/依据必填" },
    { kind: "has-number", columns: ["score"], text: "得分须是数字" },
    { kind: "no-aggregate-row", column: "dimension", text: "不许写「合计/总计/综合赢面」这类派生行（合计由门限核对，派生值不是发现）" },
    { kind: "sum-to", column: "weight", target: 100, tolerance: 0.5, text: "权重合计须为 100" },
  ],

  "表5-1": [
    { kind: "non-empty", columns: ["layer", "components", "interface", "integration"], text: "层/组件/接口/集成方式必填" },
  ],
  "表5-3": [
    { kind: "non-empty", columns: ["item", "content", "window"], text: "事项/内容/时间窗必填" },
    { kind: "has-number", columns: ["man_days"], text: "人天须给数字（排期与报价的依据）" },
  ],
  "表5-4": [
    { kind: "non-empty", columns: ["item", "content"], text: "交付项与内容必填" },
    { kind: "has-number", columns: ["sla"], text: "SLA 须落到具体指标（响应 ≤2 小时、可用率 99.9%）" },
  ],

  "表6-1": [
    { kind: "non-empty", columns: ["benefit", "metric", "expected", "how_to_measure"], text: "收益/指标/预期/怎么测必填" },
    { kind: "has-number", columns: ["expected"], text: "预期改善须给数值（不许「显著提升」）" },
  ],
  "表6-4": [
    { kind: "non-empty", columns: ["kind", "content"], text: "类别与内容必填" },
    { kind: "coverage", column: "kind", values: ["成功判据", "验收口径"], text: "须覆盖成功判据与验收口径" },
  ],
};

/** 某张表的门限（没有登记的返回空数组，测试会拦） */
export function gatesOf(tableCode: string): readonly GateSpec[] {
  return TABLE_GATES[tableCode] ?? [];
}

/** 门限的人话（进提示词与文档，和 completeness 一起给模型看） */
export function gateRequirementText(gate: GateSpec): string {
  return gate.text;
}
