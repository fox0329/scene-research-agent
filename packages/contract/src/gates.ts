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
  | { kind: "constraint-check"; text: string }
  /**
   * 跨表覆盖：另一张表里（可按条件筛选）的每一项，必须在本表某列的文本里出现
   *
   * 用途（2026-10-20 用户定调「所有的输出都应该有门限卡住」）：阶段 4 的方案必须
   * 覆盖阶段 3 判定的高价值细分／「不参与」的环节——否则方案可以另起炉灶，
   * 能力匹配白做。匹配用**最长公共子串 ≥ minMatch**（中文标签常带括注与修饰，全等会误杀）。
   */
  | {
      kind: "cross-coverage";
      table: string;
      sourceColumn: string;
      targetColumns: readonly string[];
      /** 只判源表里满足条件的行（如 value_density=高） */
      where?: { column: string; in: readonly string[] };
      minMatch?: number;
      text: string;
    }
  /**
   * 跨表合计一致性：本表某数值列合计，须落在另一张表若干单元格「人天」总和的区间内
   *
   * 用途：表5-3 的 `man_days` 合计要覆盖表4-3 判「需补齐」的处置人天——
   * 方案里少写一半工作量，是最典型的「两套账」（实测市政污水 110 vs 180–280）。
   */
  | {
      kind: "cross-sum";
      table: string;
      sourceColumn: string;
      where?: { column: string; in: readonly string[] };
      column: string;
      minRatio: number;
      maxRatio: number;
      text: string;
    }
  /**
   * 否定性覆盖：整表**没有一行**给出否定判定时提示（边界声明可能缺失）
   *
   * 不阻断、只提示：全部环节都「能做」在少数项目上成立，但多数时候意味着没敢下否定结论
   * （G-R10）。用户定调 2026-10-20：宁可提示让人看一眼。
   */
  | {
      kind: "absence-hint";
      column: string;
      values: readonly string[];
      minRows: number;
      text: string;
    };

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
  M6: [
    { kind: "non-empty", columns: ["model", "config", "unit_price", "price_scope", "source"], text: "型号/配置/含税单价/价格口径/来源五项必填" },
    { kind: "cross-ref", column: "model", table: "M1", target: "model", text: "报价型号必须能在 M1 产品清单里找到" },
    { kind: "enum-of-column", column: "price_scope", text: "价格口径只能取 纯设备/含安装/含三年维保/年费" },
    { kind: "not-vague", columns: ["unit_price"], text: "单价须给含税金额、区间或「面议」，不许写「优惠」「按项目」" }
  ],
  可选材料: [
    { kind: "enum-of-column", column: "category", text: "材料类别取该列枚举" },
    { kind: "non-empty", columns: ["cert_no", "valid_until", "issuer"], text: "认证类材料须给证书号、有效期与发证机构（无证书号视为未取得）", when: { column: "category", equals: "O1认证" } },
    { kind: "non-empty", columns: ["delivered_at", "acceptance"], text: "案例类材料须给交付时间与可验收指标（「效果良好」不算）", when: { column: "category", equals: "O2案例" } },
    { kind: "non-empty", columns: ["file"], text: "价格材料只存报价单/价格表文件引用；具体单价与口径请录到「M6 硬件报价」", when: { column: "category", equals: "O3价格" } }
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
  ],  "表2-3": [
    { kind: "non-empty", columns: ["layer", "components", "interface"], text: "层级/组件/接口必填" },
    { kind: "unique", columns: ["layer"], text: "一层一行，同一层不许拆成多行" },
    { kind: "min-items", column: "components", min: 2, text: "每层至少 2 个具名组件（一个组件的层要并到相邻层）" },
    { kind: "not-vague", columns: ["components"], text: "组件须具名（型号/产品线/系统名），不许「各类终端/各类网关/若干设备」" },
    { kind: "not-vague", columns: ["interface"], text: "接口须给协议名/标准号 + 承载方式，不许「网络对接/接口互通/按需对接」" },
    { kind: "named", columns: ["interface"], text: "接口须落到可查的协议或标准（ONVIF/RTSP/Modbus/HL7 等）" }
  ],

  "表2-4": [
    { kind: "non-empty", columns: ["interaction_type", "from_to", "method"], text: "类型/起终点/方式必填" },
    { kind: "cross-ref", column: "from_to", table: "表2-2", target: "element_name", text: "关系两端须点名要素或具名外部主体（监管平台/电网/运营商/上级平台放行），禁「各类/各系统」" },
    { kind: "named", columns: ["method"], text: "方式须落到协议名/标准号，或「私有协议（厂商：X）」" },
    { kind: "not-vague", columns: ["from_to"], text: "起终点须是具名主体，不许写「各类设备/各系统/若干」" },
    { kind: "not-vague", columns: ["method"], text: "方式须写清协议 + 经由哪一网段 + 谁开放接口，不许「经院内网对接」这类无主体写法" }
  ],
  "表2-5": [
    { kind: "constraint-check", text: "每行须可执行（数值/等级/清单至少一样）+ 点明适用对象，且不是门槛复述" },
    { kind: "non-empty", columns: ["standard_no"], text: "适用标准号/规范名必填（国标号、行标号、客户制度名或图纸条款号）" }
  ],

  "表1-2": [
    { kind: "non-empty", columns: ["link", "owner_now", "current_tool", "current_flow", "pain"], text: "环节/现在谁在做/用什么/怎么做/痛点必填" },
    { kind: "unique", columns: ["link"], text: "同一业务环节只写一行" },
    { kind: "has-number", columns: ["current_flow"], text: "现状做法须给频次或单次耗时（每班 2 次、每次 30 分钟）" },
    { kind: "not-vague", columns: ["pain"], text: "痛点须写「哪一步、错/慢/漏多少」，不许「效率低/易出错」" }
  ],
  "表3-1": [
    { kind: "non-empty", columns: ["link", "gross_margin", "representative"], text: "环节/毛利率/代表企业必填" },
    { kind: "unique", columns: ["link"], text: "一行一环节，环节不许重复" },
    { kind: "has-number", columns: ["gross_margin"], text: "毛利率须给数字（区间或单值），并带口径（年报/项目成交/经销/集采后/测算）" },
    { kind: "named", columns: ["representative"], text: "代表企业须具名 ≥2 家，禁「等/…/多家」" },
  ],
  "表3-2": [
    { kind: "non-empty", columns: ["key_points", "players", "position", "price_band", "fit_for"], text: "形态/主要玩家/地位/价格带/适用条件必填" },
    { kind: "unique", columns: ["key_points"], text: "一种形态一行，形态写法不许重复或写成编号" },
    { kind: "enum-of-column", column: "position", text: "当前地位只取 扩张/稳定/收缩/未知" },
    { kind: "min-items", column: "players", min: 2, text: "主要玩家至少 2 家具名（顿号分隔）" },
    { kind: "not-vague", columns: ["players", "key_points"], text: "玩家须具名、要点须写清交付与边界，禁「多家厂商/各类方案」" },
    { kind: "has-number", columns: ["fit_for"], text: "适用条件须含一个量化条件（产线数/预算/规模）" },
  ],
  "表3-3": [
    { kind: "non-empty", columns: ["customer_type", "decision_maker", "budget", "default_choice", "procurement_method", "decision_cycle"], text: "客户类型/拍板/钱从哪出/默认选择/采购方式/决策周期必填" },
    { kind: "unique", columns: ["customer_type"], text: "一类客户一行，类型不许重复" },
    { kind: "enum-of-column", column: "procurement_method", text: "采购方式只取七值（公开招标/邀请招标/竞争性磋商/单一来源/框架协议/集采目录/直接采购/未知）" },
    { kind: "named", columns: ["decision_maker"], text: "拍板须写岗位（总监/经理/总工/主任/厂长/部长/院长/采购），不写人名" },
    { kind: "has-number", columns: ["decision_cycle"], text: "决策周期须给月数（如「3–9 个月」），禁「较长/半年左右」" },
    { kind: "not-vague", columns: ["default_choice"], text: "默认选择须具名，或明确「自建/人工/不采购」" },
  ],
  "表3-5": [
    { kind: "non-empty", columns: ["link", "who_supplies", "concentration", "substitutability", "bargaining", "supply_risk"], text: "上游环节/供给方/集中度/可替代性/议价权/被卡点必填" },
    { kind: "enum-of-column", column: "concentration", text: "集中度只取枚举值" },
    { kind: "enum-of-column", column: "substitutability", text: "可替代性只取枚举值" },
    { kind: "enum-of-column", column: "bargaining", text: "议价权只取枚举值" },
    { kind: "has-number", columns: ["supply_risk"], text: "被卡点须含量级（周/天/%/家/月）" },
    { kind: "named", columns: ["who_supplies"], text: "供给方须具名，禁「多家/若干/供应商」" },
  ],
  "表3-8": [
    { kind: "non-empty", columns: ["rank", "gap", "who_hurts", "pain_level", "current_alternative", "acceptance"], text: "六列必填（含验收条件）" },
    { kind: "unique", columns: ["rank"], text: "排序 1..n 连续且唯一" },
    { kind: "enum-of-column", column: "pain_level", text: "痛级只取 高/中/低" },
    { kind: "not-vague", columns: ["gap", "who_hurts", "acceptance"], text: "缺口须含差距量、谁在痛须到岗位、验收条件须是客户语言，禁「效率低/客户/加强管理」" },
    { kind: "has-number", columns: ["consequence"], text: "不解决的损失须带数字与单位（钱/工期/安全）" },
  ],
  "表4-1": [
    { kind: "non-empty", columns: ["ability", "maturity"], text: "能力与成熟度必填" },
    { kind: "unique", columns: ["ability"], text: "同一能力不许重复登记（会虚高能力面）" },
    { kind: "enum-of-column", column: "maturity", text: "成熟度取该列枚举" },
    { kind: "cross-ref", column: "ability", table: "M3", target: "name", text: "能力项须逐字用 M3 能力清单的名字（改名即视为新能力，会虚高）" }
  ],
  "表4-2": [
    { kind: "non-empty", columns: ["link", "our_role", "our_scope"], text: "环节/我方角色/我方承担必填" },
    { kind: "cross-ref", column: "link", table: "表1-2", target: "link", text: "环节须与表1-2 逐字同名" },
    { kind: "enum-of-column", column: "our_role", text: "我方角色取该列枚举" },
    { kind: "not-vague", columns: ["our_scope"], text: "我方承担须写「做 X、不做 Y」，不许只写配合/支持/参与" },
    { kind: "absence-hint", column: "our_role", values: ["不参与"], minRows: 5, text: "全部环节都判「替代/辅助/外围」，没有一行「不参与」——边界声明可能缺失（不必凑数，但要想清楚真的都能碰？）" }
  ],
  "表4-3": [
    { kind: "non-empty", columns: ["gap_ref", "match", "our_product", "action"], text: "缺口/匹配结论/我方产品/处置必填" },
    { kind: "cross-ref", column: "gap_ref", table: "表3-8", target: "gap", text: "缺口须逐字复述表3-8 缺口原文（写编号不算），源表改字必须重跑本表" },
    { kind: "enum-of-column", column: "match", text: "匹配结论取该列枚举" },
    { kind: "unique", columns: ["gap_ref"], text: "同一缺口只对照一次" },
    { kind: "has-number", columns: ["action"], text: "处置须给量：需补齐写人天，能解写验收/交付口径，不能做写转分包对象" },
    { kind: "absence-hint", column: "match", values: ["不能做"], minRows: 5, text: "缺口全部「真能解/需补齐」，没有一行「不能做」——要么真的都能做，要么没敢下否定结论（G-R10）" }
  ],
  "表4-4": [
    { kind: "non-empty", columns: ["sub_scene", "value_density", "opponent", "win_loss", "entry_action", "rank"], text: "细分/价值密度/主要对手/胜负/切入动作/首打顺序必填" },
    { kind: "unique", columns: ["rank"], text: "首打顺序不许重复（1、1、1 视为未排序）" },
    { kind: "unique", columns: ["sub_scene"], text: "一个细分一行，细分名不许重复" },
    { kind: "enum-of-column", column: "value_density", text: "价值密度只取 高/中/低（理由写右栏）" },
    { kind: "enum-of-column", column: "win_loss", text: "胜负只取 强/平/弱/未知（未知须在右栏写缺哪类信息）" },
    { kind: "not-vague", columns: ["entry_action"], text: "切入动作须是可执行的第一件事（试点范围/周期/提交对象），不许「加强推广」「持续跟踪」" },
    { kind: "no-aggregate-row", column: "sub_scene", text: "不许写「合计/平均/综合赢面」这类派生行" }
  ],

  "表5-1": [
    { kind: "non-empty", columns: ["layer", "components", "interface", "integration"], text: "架构块：层/组件/接口/对接方式必填", when: { column: "interface_name", present: false } },
    { kind: "non-empty", columns: ["interface_name", "type", "protocol"], text: "接口块：接口名称/类型/协议必填", when: { column: "interface_name", present: true } },
    { kind: "named", columns: ["interface"], text: "架构块的接口须给协议名或标准号，不许「标准协议」", when: { column: "interface_name", present: false } },
    { kind: "not-vague", columns: ["boundary"], text: "边界声明须写清我方不做X／客户负责Y／第三方负责Z，不许「以实际为准」", when: { column: "interface_name", present: false } },
    { kind: "cross-coverage", table: "表4-4", sourceColumn: "sub_scene", where: { column: "value_density", in: ["高"] }, targetColumns: ["layer", "components", "interface", "integration", "boundary"], minMatch: 3, text: "阶段 3 判「高价值」的细分，方案里必须有对应层/组件/接口（没覆盖＝方案另起炉灶）" },
    { kind: "cross-coverage", table: "表4-2", sourceColumn: "link", where: { column: "our_role", in: ["不参与"] }, targetColumns: ["boundary", "components"], minMatch: 3, text: "判「不参与」的环节，边界声明里必须出现（否则等于没声明不碰）" }
  ],
  "表5-3": [
    { kind: "non-empty", columns: ["item", "content", "window", "man_days", "rollback"], text: "事项/内容/时间窗/人天/回退必填（回退写清回退点与触发条件）" },
    { kind: "has-number", columns: ["man_days"], text: "人天须为整数（≥1），不许 0、约、待评估" },
    { kind: "unique", columns: ["item"], text: "同一实施项不许重复登记（拆行会虚增人天）" },
    { kind: "not-vague", columns: ["rollback"], text: "回退须给回退点 + 触发条件 + 耗时，不许「按需回退」" },
    { kind: "cross-sum", table: "表4-3", sourceColumn: "action", where: { column: "match", in: ["需补齐", "不能做"] }, column: "man_days", minRatio: 0.6, maxRatio: 3, text: "实施人天合计须覆盖表4-3 判「需补齐」的处置人天（少一半＝两套账，多三倍＝重复计工）" }
  ],
  "表5-4": [
    { kind: "non-empty", columns: ["item", "content", "sla"], text: "交付项/内容/SLA 必填" },
    { kind: "has-number", columns: ["sla"], text: "SLA 须给响应时限与恢复时限（≤2 小时／≤8 小时）及可用率或到场时限" },
    { kind: "min-items", column: "sla", min: 2, text: "SLA 至少两项时限（响应 + 恢复/到场）" }
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
