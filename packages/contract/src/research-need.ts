/**
 * research-need — 哪些列的内容**不需要调研**
 *
 * 用户定调（2026-11-03）：「蓝色指的是需要调研而没有数据来源的数据；红色指的是需要调研、
 * 既没有数据来源、又不能通过模型推测或者行业通识填写的内容；其他的不需要调研的内容，
 * 比如场景定义、技术实现这些，应该用黑色字体」。
 *
 * 判定基准：
 *  - **不需要调研**：场景定义与拆解、技术实现与分层、要素间技术交互、我方产品能力、
 *    我方实施计划与交付。这类内容本来就该由模型按逻辑写出来，标蓝只会误导用户
 *    以为"这里本该有外部依据"。
 *  - **需要调研**（未登记即默认）：市场份额、价格带宽、毛利、客户采购习惯与决策链、
 *    竞对打法与赢面、上游供给与交期、认证与合规要求、缺口与痛的量级。
 *
 * 只登记"不需要调研"的列；没登记的列按需要调研处理（保守：宁可提示缺依据）。
 */
const NO_RESEARCH_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  /* 场景概述：由场景描述与用户输入得出，属定义 */
  "表1-1": ["item", "content"],
  /* 场景环节地图：环节拆解与现状描述 */
  "表1-2": ["link", "description", "responsibility"],
  /* 场景要素清单：要素名称/类型/功能/服务对象/触点属拆解；供应商/价格/参数要调研 */
  "表2-2": ["element_name", "element_type", "function", "served_role", "touchpoint"],
  /* 分层架构：技术实现 */
  "表2-3": ["layer", "components", "interface", "note"],
  /* 要素间关系：技术交互 */
  "表2-4": ["interaction_type", "from_to", "method", "key_params"],
  /* 物理与合规约束：约束项本身属常识；具体限值/标准号/周期要查标准 */
  "表2-5": ["constraint_item"],
  /* 值得打的缺口：排序是我方判断，其余（痛级、替代、损失、预算科目）要调研 */
  "表3-8": ["rank"],
  /* 能力底账：我方产品能力，内部知识 */
  "表4-1": ["ability", "maturity", "limitation", "no", "proof"],
  /* 我方参与地图：全部是我方角色判断 */
  "表4-2": ["link", "our_role", "our_scope", "can_touch", "role_reason"],
  /* 需求-能力对照：基于表3-8 与表4-1 的匹配判断 */
  "表4-3": ["gap_ref", "match", "our_product", "action", "ability_basis", "risk"],
  /* 细分打法：细分/对手/赢面/价值密度/存量成熟度/市场形态要调研；
     打入动作、顺序、契合度、难度、四维、优劣势、策略是我方判断 */
  "表4-4": [
    "entry_action",
    "rank",
    "fit",
    "difficulty",
    "four_dim",
    "advantage",
    "weakness",
    "implication",
    "entry_note",
    "strategy",
  ],
  /* 架构与接口：技术方案 */
  "表5-1": ["layer", "components", "interface", "integration", "boundary", "interface_name", "type", "protocol"],
  /* 实施计划：我方计划 */
  "表5-3": ["item", "content", "window", "man_days", "rollback", "env_prep", "owner"],
  /* 交付与运维：我方承诺 */
  "表5-4": ["item", "content", "sla", "note"],
};

/** 这一列的内容是否需要调研（未登记默认 true） */
export function columnNeedsResearch(tableCode: string, columnKey: string): boolean {
  const exempt = NO_RESEARCH_COLUMNS[tableCode];
  if (!exempt) return true;
  return !exempt.includes(columnKey);
}

/** 供测试与排查用：拿到某张表里"不需要调研"的列 */
export function noResearchColumnsOf(tableCode: string): readonly string[] {
  return NO_RESEARCH_COLUMNS[tableCode] ?? [];
}
