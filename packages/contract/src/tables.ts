/**
 * @scene/contract — 表定义注册表（单一事实源）
 *
 * 本文件是 35 张信息表的**唯一事实源**：表号、名称、阶段、级别、行粒度、列定义、
 * 栏位分配（中栏 / 右栏补充）、枚举、完整度规则。
 *
 * 派生关系（三处共用同一份定义，不再各写一遍）：
 *   后端提示词   ← columns（生成字段说明）
 *   前端表格     ← middleColumns(table) + supplementColumns(table)
 *   数据契约     ← TableDef（列即数据形状）
 *
 * 设计依据：`04-业务过程重定义.md` v1.4 + `05-表格定义总表.md` v0.7
 *
 * 与旧常量的关系：本文件**只新增、不改动**既有 `StageId` / `STAGE*_TABLES` / `TableCode`；
 * 旧常量标记为 @deprecated，待 P3/P4 迁移完成后删除（见 06 §十六 之后的实施计划）。
 */

// ─── 阶段（8 阶段方法论骨架，0-7） ──────────────────────────

/** 阶段编号（0-7）：阶段 0 材料入库 → 阶段 7 最终交付物 */
export type InfoStageId = 0 | 1 | 2 | 3 | 4 | 5;

/** 表级别：决定中栏默认状态与右栏归属（**不再表示"是否需要决策"**） */
export type TableTier = "重要" | "支撑" | "过程";

/** 列的显示栏位 */
export type ColumnSlot = "中栏" | "右栏补充";

/** 值的呈现类型 */
export type ValueType = "text" | "longText" | "number" | "date" | "ref";

// ─── 枚举字典 ──────────────────────────────────────────────

export const ENUMS = {
  product_status: ["在售", "停售", "在研", "规划", "待确认"],
  maturity: ["已交付", "组件具备", "在研", "规划"],
  param_class: ["核心配置", "接口与端口", "电气规格", "环境与防护", "机械结构", "通信协议", "认证与安规", "软件"],
  measured: ["实测", "宣称", "未提及"],
  barrier_type: ["技术", "行业准入", "经济", "生态锁定", "一票否决者"],
  can_touch: ["可以碰", "只能配合", "不能碰"],
  our_role: ["替代", "辅助", "外围", "不参与"],
  value_density: ["高", "中", "低"],
  win_loss: ["强", "平", "弱", "未知"],
  stock_maturity: ["空白", "零散", "拥挤"],
  match: ["真能解", "需补齐", "不能做"],
  level_hml: ["高", "中", "低"],
  optional_category: ["O1认证", "O2案例", "O3价格", "O4SDK", "O5路线图", "O6生态"],
  element_type: ["硬件", "软件", "服务"],
  competition: ["高", "中", "低", "未知"],
  /** 上游供给集中度（表3-5）：这一环是少数几家说了算，还是谁都能做 */
  concentration: ["高度集中（1-2 家）", "较集中（3-5 家）", "分散（多家可选）", "未知"],
  /** 可替代性（表3-5）：换供应商的代价 */
  substitutability: ["多家可替代", "少数可替代", "难以替代（需重新认证）", "单一来源", "未知"],
  /** 议价权（表3-5）：这一环的价格是谁定的 */
  bargaining: ["在供给方", "在采购方", "相对均衡", "未知"],
  has_plan: ["有", "无", "未定"],
  fix_status: ["已修复", "修复中", "无计划", "硬件限制"],
  visibility: ["可提", "内部可提", "不可提"],
  position: ["扩张", "稳定", "收缩", "未知"],
  /** 硬件报价口径（M6）：报的是设备本身还是含安装/维保/年费，不能混在一行 */
  price_scope: ["纯设备", "含安装", "含三年维保", "年费"],
  procurement_method: ["公开招标", "邀请招标", "竞争性磋商", "单一来源", "框架协议", "集采目录", "直接采购", "未知"],
  evidence_level: ["A", "B", "C", "D"],
  authority: ["T1", "T2", "T3", "T4"],
  asset_target: ["产品路线图", "能力底账", "新发现的限制", "销售打法"],
  pilot_kind: ["试点范围", "试点时长", "成功判据", "风险", "验收口径", "合同条款"],
  rate_category: ["实施", "商务"],
  source_type: ["AI提取", "AI推断", "用户确认", "用户补充"],
  /**
   * 核实结论：这条信息目前处在哪种证据状态（不是"来源等级"，是核实后的判定）
   *
   * 为什么要有「行业通例」这一档：实跑发现模型把**行业公开常识**也写成「无法核实」，
   * 一个阶段 85 条全进"不能当结论用"的桶里，等于把行情信息作废。行情是能自证的
   * （公开、可查、无利益相关方），只是**不是本客户的事实**——所以单独一档。
   */
  verification_verdict: ["已核实", "交叉一致", "行业通例", "单一来源", "无法核实", "有反证"],
} as const;

export type EnumName = keyof typeof ENUMS;

// ─── 列定义 ────────────────────────────────────────────────

export interface TableColumn {
  /** 字段名（英文 snake_case，数据层键） */
  key: string;
  /** 中文表头 */
  label: string;
  /** 显示栏位 */
  slot: ColumnSlot;
  /** 是否必填 */
  required?: boolean;
  /** 条件必填说明（如「仅认证类必填」） */
  requiredWhen?: string;
  /** 枚举名（取值必须落在 ENUMS[enum] 内） */
  enum?: EnumName;
  /** 值类型（默认 text） */
  type?: ValueType;
  /** 中栏单行截断字数（长文本列必须给） */
  truncate?: number;
  /** 引用哪张表（type=ref 时给） */
  refTable?: string;
  /** 所属块（同一张表内多子块时使用，如方案架构的架构块/接口块） */
  block?: string;
  /** 说明（供提示词与 tooltip） */
  note?: string;
}

/**
 * 固定行的内容属主
 *
 * 用户定调（2026-09-26）：「用户只负责输入场景名称，智能体负责从业务角度说清楚
 * 场景的范围」——**谁最该知道这件事，谁负责产出**。把智能体本该调研/推断的项
 * 摆成用户的填空题，等于把智能体的活推给用户（用户原话：都让用户填，要我们干什么）。
 *
 *  - `用户`：只有用户知道，必须由他输入（表1-1 仅「场景名称」）
 *  - `智能体`：行业通例/可由名称与材料推出，智能体先给内容，用户只需看与改
 */
export type FixedRowOwner = "用户" | "智能体";

/** 表内固定行（用于「项 / 内容」纵向呈现的单例表，如表1-1 场景概述） */
export interface FixedRow {
  key: string;
  label: string;
  required?: boolean;
  /** 内容属主；缺省视为「智能体」（见 `FixedRowOwner`） */
  owner?: FixedRowOwner;
  longText?: boolean;
  note?: string;
}

// ─── 表定义 ────────────────────────────────────────────────

export interface TableDef {
  /** 表号（沿用 00b 编号不重排；阶段 0 用 M1-M6 与「可选材料」） */
  code: string;
  /** 表名（白话） */
  name: string;
  /** 所属阶段 */
  stage: InfoStageId;
  /** 级别 */
  tier: TableTier;
  /** 一行代表什么 */
  rowUnit: string;
  /** 目的（一句话） */
  purpose: string;
  /** 列定义 */
  columns: readonly TableColumn[];
  /** 固定行（与 columns 二选一：单例表用固定行 + 项/内容两列） */
  fixedRows?: readonly FixedRow[];
  /** 分组维度（该字段不进列，仅用于分组渲染，如表2 规格书按型号分组） */
  groupBy?: string;
  /**
   * 子块的显示名（缺省 = `${block}块`）
   *
   * 为什么需要：多子块表的各块在界面上**各占一个"表"**（用户定调：不分两级、芯片一行显示），
   * 块名必须能独立看懂——「架构块」脱离表名看不懂，「方案架构」可以。
   */
  blockLabels?: Readonly<Record<string, string>>;
  /** 是否常驻中栏顶部（表1-1 = 场景锚） */
  pinned?: boolean;
  /** 动态 payload（可选材料：1 张表 6 种 payload，按 category 切换） */
  payloads?: Readonly<Record<string, readonly TableColumn[]>>;
  /** 完整度规则（可机器判定） */
  completeness: readonly string[];
  /** 被哪些阶段引用 */
  consumedBy?: readonly InfoStageId[];
  /**
   * 同一阶段内**必须先有它**的表（按表号）
   *
   * 用途：阶段分析改为**按表并发生成**（v1.22）——并发的代价是失去"一次看到整步"的视野。
   * 这里把真实的先后依赖声明出来：被依赖的表先跑，跑完把**刚生成的行**作为上游上下文
   * 喂给下游表，保证口径一致（如实施计划要按架构与接口项算）。
   * 没有真实依赖的表一律并发，不要为了"稳"随手加依赖——那会把并发收益吃光。
   */
  dependsOnTables?: readonly string[];
}

// ─── 列构造助手 ────────────────────────────────────────────

function col(
  key: string,
  label: string,
  slot: ColumnSlot,
  o: Omit<Partial<TableColumn>, "key" | "label" | "slot"> = {},
): TableColumn {
  return { key, label, slot, ...o };
}

/** 中栏列（主信息，受列预算约束：每张表 ≤6 列） */
export const mid = (key: string, label: string, o: Parameters<typeof col>[3] = {}): TableColumn =>
  col(key, label, "中栏", o);

/** 右栏列（补充说明：长文本全文、来源、权威性、证据等级等） */
export const sup = (key: string, label: string, o: Parameters<typeof col>[3] = {}): TableColumn =>
  col(key, label, "右栏补充", o);

/** 通用元信息列组（一律进右栏补充，不进中栏） */
export const META_COLUMNS: readonly TableColumn[] = [
  sup("source", "来源", { required: true, note: "文件名:页码 / 章节 / URL；无来源即缺陷" }),
  sup("evidence_level", "证据等级", { enum: "evidence_level", note: "仅证据敏感表必填" }),
  sup("authority", "来源权威性", { enum: "authority", note: "仅证据敏感表必填" }),
];

/** 长文本列默认截断字数（中栏单行显示） */
export const TRUNCATE_DEFAULT = 20;

// ─── 阶段定义 ──────────────────────────────────────────────

/** 本阶段信息的产出方式——决定是否需要模型分析 */
export type StageProducer =
  /** 确定性解析入库（材料流水线填充 M 表，不调用模型） */
  | "解析入库"
  /** 模型分析（按表定义生成行） */
  | "模型分析"
  /** 系统组装（交付物按章节 ← 表映射生成，不调用模型） */
  | "系统组装";

export interface StageDef {
  id: InfoStageId;
  /** 阶段名 */
  name: string;
  /** 本阶段信息由谁产出（阶段 0 解析入库、1-6 模型分析、7 系统组装） */
  producedBy: StageProducer;
  /** 这一步要获得什么信息 */
  goal: string;
  /** 本阶段产出的表号 */
  tableCodes: readonly string[];
  /** 右栏阶段总结文档标题（第 N 份） */
  summaryTitle: string;
}

export const STAGE_DEFS: readonly StageDef[] = [
  {
    id: 0,
    name: "材料解析与入库",
    producedBy: "解析入库",
    goal: "我方有哪些产品、能力、边界与限制、硬件报价；有哪些认证/案例/价格/资料/路线图/生态",
    tableCodes: ["M1", "M2", "M3", "M4", "M5", "M6", "可选材料"],
    summaryTitle: "① 材料入库总结",
  },
  {
    id: 1,
    name: "认识场景（含门槛与合规）",
    producedBy: "模型分析",
    goal: "场景是什么、有哪些要素与产业链构成、系统怎么连、有哪些硬约束与门槛、认证现状（只看场景与行业本身：客户现状与我方产品都不在这一步）",
    tableCodes: ["表1-1", "表1-3", "表2-2", "表2-3", "表2-4", "表2-5"],
    summaryTitle: "② 场景认识总结",
  },
  {
    id: 2,
    name: "理解商业",
    producedBy: "模型分析",
    goal: "钱在哪个环节、市面有哪几种打法与谁在做、客户怎么买、我方上游会不会被卡、哪些缺口值得打",
    tableCodes: ["表3-1", "表3-2", "表3-3", "表3-5", "表3-8"],
    summaryTitle: "③ 商业格局总结",
  },
  {
    id: 3,
    name: "能力匹配",
    producedBy: "模型分析",
    goal: "客户现状底数（现在谁在做、用什么、怎么交付运维）、我方能力底账、客户每条需求能否满足、细分优先级、竞争力评分",
    tableCodes: ["表1-2", "表4-1", "表4-2", "表4-3", "表4-4"],
    summaryTitle: "④ 能力匹配总结",
  },
  {
    id: 4,
    name: "方案与实现",
    producedBy: "模型分析",
    goal: "方案架构与接口、边界声明、约束满足路径、实施计划、交付运维与 SLA",
    tableCodes: ["表5-1", "表5-3", "表5-4"],
    summaryTitle: "⑤ 方案与实现总结",
  },
  {
    id: 5,
    name: "最终交付物",
    producedBy: "系统组装",
    goal: "《<场景>解决方案》（一份，七章，文档产出非表）",
    tableCodes: [],
    summaryTitle: "⑥ 交付说明",
  },
];

// ─── 场景诉求（第一输入，§3.0） ────────────────────────────

export interface ScenarioBriefField {
  key: string;
  label: string;
  required?: boolean;
  longText?: boolean;
  placeholder?: string;
}

/** 新建场景三段式的字段（输入记录，不编号为信息表） */
export const SCENARIO_BRIEF_FIELDS: readonly ScenarioBriefField[] = [
  { key: "scene_name", label: "场景名称", required: true, placeholder: "如：智慧水务" },
  {
    key: "intent",
    label: "一句话：你想搞清楚什么",
    required: true,
    longText: true,
    placeholder: "如：这个场景值不值得进 / 怎么做方案 / 客户要求我们出个方案",
  },
  { key: "customer_hint", label: "客户/行业", placeholder: "如：市政水务集团" },
  { key: "region_hint", label: "地域/客户名", placeholder: "如：华东某市" },
  { key: "scope_hint", label: "想覆盖范围", placeholder: "如：只看出厂到管网这一段" },
  {
    key: "audience",
    label: "用途",
    placeholder: "自研判断 / 给领导看 / 给客户看",
  },
  { key: "deadline", label: "时间要求", placeholder: "如：两周内要初判" },
];

// ─── 阶段总结文档骨架（§五） ───────────────────────────────

export interface SummarySection {
  key: string;
  title: string;
  /** 内容要求（给生成器与提示词） */
  brief: string;
}

export const SUMMARY_DOC_SECTIONS: readonly SummarySection[] = [
  { key: "abstract", title: "一、信息摘要", brief: "一段话：本阶段获得了什么信息、覆盖了哪些方面" },
  { key: "key_info", title: "二、关键信息清单", brief: "要点式，每条指向中栏对应表与行，便于回查" },
  {
    key: "method",
    title: "三、说明与方法口径",
    brief: "怎么展开的、采用什么口径与假设；C 级假设与 AI推断条目集中列在此处",
  },
  { key: "sources", title: "四、来源与抽查", brief: "T1-T4 分布 + 已抽查条目（文件名:页码）" },
  {
    key: "gaps",
    title: "五、待补齐信息",
    brief:
      "分两栏：需要用户补充的（极少，通常为空）+ 智能体将自行补齐的（含来源/推断留痕）——缺口不是「用户的缺口」",
  },
  { key: "links", title: "六、上下游衔接", brief: "上游依据哪些表、下游引用哪些表" },
];

/** 阶段总结文档必须**不含**的内容（避免退化成决策文档） */
export const SUMMARY_DOC_FORBIDDEN: readonly string[] = [
  "任何建议、判断、结论性评价（进/不进、能做/不能做、值不值）",
  "建议档位与通过/不通过",
];

// ─── 阶段 0 · 材料解析与入库（7 张；UI 按 M1/M2/M3/M4 合并/M6/可选材料呈现） ──

const TABLES_STAGE_0: readonly TableDef[] = [
  {
    code: "M1",
    name: "产品清单",
    stage: 0,
    tier: "支撑",
    rowUnit: "一个型号",
    purpose: "建立候选池——全链产品事实的唯一来源",
    columns: [
      mid("model", "型号/编号", { required: true, note: "唯一键（去重依据）" }),
      mid("name", "产品名", { required: true }),
      mid("status", "状态", { required: true, enum: "product_status" }),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["model/name/status 非空且 model 无重复", "每行有来源",
      "一行一个可独立选型/报价的主型号；扩展单元与选配件并入所属型号括注，不单独成行",
      "状态取 在售/停售/在研/规划；判不出就写清缺哪份依据并入待补，不写「待确认」",],
    consumedBy: [3, 4],
  },
  {
    code: "M2",
    name: "规格书",
    stage: 0,
    tier: "支撑",
    rowUnit: "一个参数项",
    purpose: "拆解关键参数，支撑能力匹配与选型",
    groupBy: "product_id",
    columns: [
      mid("param_class", "参数类", { required: true, enum: "param_class" }),
      mid("param_name", "参数项", { required: true }),
      mid("value", "值", { required: true }),
      mid("measured", "实测/宣称", { required: true, enum: "measured" }),
      sup("product_id", "所属产品", { required: true, type: "ref", refTable: "M1" }),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["四必填非空", "实测行须 T1/T2 来源", "宣称行标注为 B 级以下",
      "参数类只取八类（核心配置/接口与端口/电气规格/环境与防护/机械结构/通信协议/认证与安规/软件）",
      "只有支持/不支持的布尔项进 M3，不进本表",],
    consumedBy: [3, 4],
  },
  {
    code: "M3",
    name: "能力清单",
    stage: 0,
    tier: "支撑",
    rowUnit: "一个能力项",
    purpose: "列出产品线能做什么、做到什么程度",
    columns: [
      mid("domain", "能力域", { required: true }),
      mid("name", "能力项", { required: true }),
      mid("maturity", "成熟度", { required: true, enum: "maturity" }),
      sup("description", "一句话描述", { required: true, type: "longText", note: "依赖条件（需要什么硬件/平台/配置）并入本列写清，不再单列" }),
      sup("inapplicable_scene", "不适用场景"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["domain/name/maturity 非空", "每行有来源", "已交付行须有 O2 案例佐证或标『无案例』",
      "依赖条件并入 description：需要什么硬件/平台/配置，和一句话描述一起写",
      "不适用场景必填：什么工况下不能用（这是本表唯一能做边界的地方）",
      "说明书里写着的记「组件具备」；「已交付」只给有案例或验收记录的",],
    consumedBy: [1, 3],
  },
  {
    code: "M4",
    name: "边界声明",
    stage: 0,
    tier: "支撑",
    rowUnit: "一条『不做的事』",
    purpose: "说清不做什么——场景环节参与判定的依据",
    columns: [
      mid("description", "不做的事", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("has_plan", "有无计划", { required: true, enum: "has_plan" }),
      sup("reason", "原因", { required: true, type: "longText" }),
      sup("response", "客户要求时怎么办", { required: true, type: "longText" }),
      sup("owner", "填写人"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["description/reason/has_plan/response 非空", "source_type 至少『用户确认』",
      "一行一条业务边界（不做土建、不承接 7×24 驻场、不做第三方设备质保）；说明书注意事项归表5-1",
      "客户硬要求时的做法要可执行：外协/联合体/客户另采，写清谁做、钱算谁的",],
    consumedBy: [1, 3],
  },
  {
    code: "M5",
    name: "已知限制",
    stage: 0,
    tier: "支撑",
    rowUnit: "一条限制",
    purpose: "列出已知缺陷，避免验收踩坑",
    columns: [
      mid("product_name", "产品/能力", { required: true }),
      mid("impact", "影响程度", { required: true, enum: "level_hml" }),
      mid("fix_status", "修复状态", { required: true, enum: "fix_status" }),
      mid("external_visible", "对外可否提及", { required: true, enum: "visibility" }),
      sup("description", "已知限制或缺陷", { required: true, type: "longText" }),
      sup("owner", "填写人"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["四项必填非空", "source_type ≥『用户确认』",
      "一行一个可复现缺陷：什么工况出现 + 影响哪个型号 + 现有 workaround；免责声明不进本表",
      "限制必须挂具体型号（写「我方产品」等于把型号限制放大成公司级结论）",],
    consumedBy: [4, 5],
  },
  {
    code: "M6",
    name: "硬件报价",
    stage: 0,
    tier: "支撑",
    rowUnit: "一个报价口径",
    purpose: "给成本测算与赢面判断提供真实报价锚点，禁止模型自己编价格",
    columns: [
      mid("model", "所属产品", { required: true, type: "ref", refTable: "M1", note: "必须能在 M1 产品清单里找到同型号" }),
      mid("config", "配置/构成", { required: true, note: "报价对应的硬件配置或交付构成" }),
      mid("unit_price", "含税单价（元）", { required: true, note: "允许写区间（12000–15000）或「面议」，但必须含税并写清口径" }),
      mid("price_scope", "价格口径", { required: true, enum: "price_scope", note: "纯设备 / 含安装 / 含三年维保 / 年费" }),
      mid("valid_until", "报价有效期", { note: "日期或「长期」" }),
      sup("source", "来源", { required: true, note: "报价单/销售确认/历史项目，必须可回查" }),
    ],
    completeness: [
      "model 必须能在 M1 产品清单中找到对应型号；找不到先补 M1，不许凭空建型号",
      "unit_price 必须含税且写清 price_scope（纯设备/含安装/含三年维保/年费）；区间或「面议」要保留原文口径",
      "每行有来源（报价单/销售确认/历史项目），无来源不要入表",
      "一行一个报价口径：同型号不同配置或不同口径分行，不合并成一行",
    ],
    consumedBy: [2, 3],
  },
  {
    code: "可选材料",
    name: "可选材料",
    stage: 0,
    tier: "支撑",
    rowUnit: "一条材料记录",
    purpose: "按类别记录认证/案例/价格/开发资料/路线图/生态（1 张表 6 种 payload）",
    columns: [
      mid("category", "类别", { required: true, enum: "optional_category" }),
      sup("source", "出处", { required: true }),
    ],
    payloads: {
      O1认证: [
        mid("model", "型号", { required: true }),
        mid("cert_type", "证书类型", { required: true }),
        mid("cert_no", "证书号", { required: true }),
        mid("valid_until", "有效期至", { required: true, type: "date" }),
        sup("issuer", "发证机构", { required: true }),
        sup("covered_models", "覆盖型号"),
        sup("file", "证书文件"),
      ],
      O2案例: [
        mid("name", "案例名", { required: true }),
        mid("scene", "场景", { required: true }),
        mid("delivered_at", "交付时间", { required: true, type: "date" }),
        mid("acceptance", "验收指标与结果", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
        sup("customer", "客户(脱敏)"),
        sup("scale", "部署规模"),
        sup("revisit_allowed", "可否回访"),
        sup("evidence_level", "证据等级", { enum: "evidence_level" }),
      ],
      O3价格与授权: [
        mid("item", "产品/服务", { required: true }),
        mid("pricing_model", "计价方式", { required: true }),
        mid("price", "价格或区间", { required: true }),
        sup("license_model", "授权模式"),
        sup("maintenance", "维保政策"),
        sup("note", "口径备注"),
      ],
      O4开发资料: [
        mid("product", "产品", { required: true }),
        mid("doc_name", "资料名称", { required: true }),
        mid("version", "版本"),
        sup("coverage", "覆盖内容"),
      ],
      O5路线图: [
        mid("item", "能力/产品", { required: true }),
        mid("status", "当前状态", { required: true }),
        mid("planned_at", "计划可用时间", { required: true }),
        mid("confidence", "置信度", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
        sup("owner", "负责人"),
      ],
      O6交付与生态: [
        mid("item", "项", { required: true }),
        mid("coverage", "覆盖范围", { required: true }),
        mid("status", "现状", { required: true }),
        sup("partner", "合作方"),
        sup("depth", "合作深度"),
      ],
    },
    completeness: ["category/payload 非空且 payload 必填齐全", "每行有出处", "O1 有效期已过须标注", "O5 低置信不得作能力证明"],
    consumedBy: [1, 3, 4],
  },
];

// ─── 阶段 1 · 认识场景（含门槛与合规）（6 张） ──────────────

const TABLES_STAGE_1: readonly TableDef[] = [
  {
    code: "表1-1",
    name: "场景概述",
    stage: 1,
    tier: "重要",
    pinned: true,
    rowUnit: "本场景（单行，纵向 项/内容 呈现）",
    purpose:
      "场景锚——**用户给场景名称，智能体从业务角度写出一份场景业务画像**（边界/生产对象/核心系统/买方/采购特征）；允许抽象与待定",
    columns: [
      mid("item", "项", { required: true }),
      mid("content", "内容", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
    ],
    fixedRows: [
      // 2026-09-26 定稿（用户给的参考形态，燃气场站为例）：
      //  场景名称        燃气场站（Gas Stations / City-Gate & Distribution Stations）  ← 用户输入
      //  场景边界        城市燃气门站、调压站/箱、LNG 储备站、CNG/LNG 加气站…
      //  生产对象        天然气的接收、过滤、计量、调压、储存/气化、输送或充装…
      //  核心生产系统     工艺装置 + 站控(PLC/RTU/SCADA) + 安全仪表与消防 + 调度/信息化平台 + 运维作业
      //  买方类型        城燃集团 / 地方燃气公司 / 长输管网企业 / 大型工业用户自管站【检索·B】
      //  采购特征        集团技术规范 + 集采/供应商名录 + 区域项目实施…
      //
      // 两条定调：① 只有「场景名称」是用户的活（`owner: "用户"`），其余由智能体从业务角度写；
      // ② 拍板者/使用者/付费者**不进表1-1**（参考里没有）——那是"研究出来才知道"的，
      //    留在表3-3 购买路径与采购机制里按客户类型一行行查。
      { key: "scene_name", label: "场景名称", required: true, owner: "用户" },
      { key: "scene_boundary", label: "场景边界", required: true },
      { key: "production_object", label: "生产对象" },
      { key: "core_systems", label: "核心生产系统" },
      { key: "buyer_type", label: "买方类型" },
      { key: "procurement", label: "采购特征" },
    ],
    completeness: [
      "场景名称由用户给出（唯一必填的用户输入）",
      "其余 5 项由智能体从业务角度写出；买方/采购类应带来源",
      "允许抽象、可留「待定」——不阻断后续阶段",
    ],
    consumedBy: [2, 3, 4, 5],
  },
  {
    code: "表1-3",
    name: "门槛与合规",
    stage: 1,
    tier: "重要",
    rowUnit: "一道门槛（一票否决者类为一个角色；认证类为一项认证要求）",
    purpose: "真正能卡住进场的门槛：谁在卡、拿不出什么就不能进场、判据是什么（不写我方的行动，也不猜本客户的合规结论）",
    columns: [
      mid("barrier_type", "门槛类型", { required: true, enum: "barrier_type" }),
      mid("barrier_name", "门槛", { required: true }),
      mid("veto_holder", "否决者", { requiredWhen: "生态锁定类除外" }),
      mid("criteria", "判据", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      /* 变更表 #84（用户拍板）保留：可由门槛判据 + 行业通例推断，实测 26% 有真值，不是空列 */
      sup("cert_gap", "认证差距", { requiredWhen: "认证类必填" }),
      sup("source", "来源", { required: true }),
      sup("evidence_level", "证据等级", { required: true, enum: "evidence_level" }),
      sup("authority", "来源权威性", { required: true, enum: "authority" }),
    ],
    completeness: [
      /* 用户定调 2026-10-20：「所谓的门槛一定是要真实，而且重要的，比如防爆等级、装备承制资格这种，
         只是普通的要求不能叫门槛」——据此**取消"五类各 ≥1 行"配额**：配额会逼模型凑数，
         实测 19 行里 11 行是难度/成本/风险。某类为空是正常结果。 */
      "每行必须过后面的门槛三问：否决者是外部主体 + 判据有可核验凭据 + 不满足就出局（写出「否则…」的后果）",
      "criteria 含具体等级/标准号/数值（禁『较高』『相关』）",
      "只针对本场景能问到的事实；没有材料依据的门槛照行业通例写，不猜本客户的合规结论",
      "经不起三问的（技术难度、一次性成本、环境约束、内部态度）不许进本表——按性质归表2-5/表3-5/表4-2",
    ],
    consumedBy: [4, 5],
  },
  {
    code: "表2-2",
    name: "场景要素清单",
    stage: 1,
    tier: "支撑",
    rowUnit: "一个场景要素",
    purpose: "场景里有什么、多少钱、竞争多激烈",
    columns: [
      mid("element_name", "要素名称", { required: true }),
      mid("element_type", "类型", { required: true, enum: "element_type" }),
      mid("function", "功能", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("vendor", "主要供应商"),
      mid("price_range", "价格量级"),
      sup("key_params", "关键技术参数", { type: "longText" }),
      sup("served_role", "服务的对象角色"),
      sup("touchpoint", "触点"),
      sup("source", "出处", { required: true }),
    ],
    completeness: [
      "element_name/element_type/function 非空",
      "price_range 按行业口径给量级（如「万元级」「十万元级」）；判断不了写『量级待确认（行业口径）』——不许写『未提供（本客户…）』",
      "供应商写行业主流厂商（不是客户指定品牌），与价格都须有来源或标『待确认』",
    
      "price_range 写「人民币量级 + 计价单位 + 典型用量」：「单床 2000–6000 元，40 床/病区约 8–24 万元」；比例计价须折出基数",
      "vendor 写可查厂商名，≥1 家主场 + 2 家备选；客户指定品牌写右栏，不占中栏",],
    consumedBy: [2, 4],
  },
  {
    code: "表2-3",
    name: "分层架构",
    stage: 1,
    /* 专家复审（2026-10-20 用户定调）：本表的价值是「一眼看清整个场景的系统架构」。
       原 tier=过程 只进阶段总结、不上中栏，用户根本看不到——这是它被误判没用的真正原因 */
    tier: "重要",
    rowUnit: "一个层级（或一个架构块）",
    purpose: "一眼看清整个场景的系统架构：分几层、每层有什么、层间怎么连、哪段是谁的",
    columns: [
      mid("layer", "层级", { required: true }),
      mid("components", "包含组件", { required: true }),
      mid("interface", "接口/协议", { required: true }),
      sup("note", "说明"),
      sup("source", "出处", { required: true }),
    ],
    completeness: [
      "layer/components/interface 非空；接口协议须有来源",
      "层级一行一层，顺序全表一致（感知→网络→平台→应用→展现；行业不同可换名）",
      "组件写得出型号、产品线名或具名系统（「海康 DS-2CD3T46」「医院 HIS」）；禁「各类终端、各类网关、若干设备」",
      "接口给协议名/标准号 + 承载方式（ONVIF/RTSP over 视频专网、HL7 v2 over 院内网），不写「网络对接」「接口互通」",
      "每层写清谁提供/谁维护（客户既有/第三方/运营商/我方新增），这是后面判「能不能碰」的基线",
      "写清层间边界：本层不包含什么（「平台层不含视频存储，存储归网络层 NVR」）",
      "至少覆盖 3 个层级；本场景确实缺某层，写「本场景无此层」（不许整行不写）",
      "只画客户现状与已有系统；我方新增分层与新增接口归表5-1，不许提前写",
    ],
    dependsOnTables: ["表2-2"],
    consumedBy: [4],
  },
  {
    code: "表2-4",
    name: "要素间关系",
    stage: 1,
    tier: "过程",
    rowUnit: "一条交互关系",
    purpose: "客户侧要素之间怎么交互，供接口设计与报价参照",
    columns: [
      mid("interaction_type", "交互类型", { required: true }),
      mid("from_to", "起点→终点", { required: true }),
      mid("method", "方式", { required: true }),
      mid("key_params", "关键参数"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["from_to/method 非空", "方式（协议）须 T1/T2",
      "起终点具名：设备/系统全称（对得上表2-2）或具名外部主体（监管平台、电网、运营商专网）；禁「各类/各系统」",
      "method 给协议名/标准号或「私有协议（厂商：X）」，并写经由网段与接口开放方",
      "方式里写清经由哪一网段、谁开放接口（分层归表2-3，不在本表重复）",
      "只记客户现状；我方新增/改造接口归表5-1",],
    dependsOnTables: ["表2-2"],
    consumedBy: [4],
  },
  {
    code: "表2-5",
    name: "物理与合规约束",
    stage: 1,
    tier: "支撑",
    rowUnit: "一个约束项",
    purpose: "设计要满足的硬约束：要满足多少（数值/等级/清单）、依据哪条标准、多久一次；回答「怎么设计」而非「能不能进」（能不能进看表1-3）",
    columns: [
      mid("constraint_item", "约束项", { required: true }),
      mid("required_value", "具体要求值", { required: true }),
      mid("standard_no", "适用标准号"),
      sup("period", "周期"),
      sup("source", "出处", { required: true }),
      sup("evidence_level", "证据等级", { required: true, enum: "evidence_level" }),
      sup("authority", "来源权威性", { required: true, enum: "authority" }),
    ],
    completeness: [
      /* 用户定调 2026-10-20：「不用合成一张表，要区分边界，同时要确认表格内容是否真有价值」。 */
      "每行必须可执行：给出数值、等级或具名清单之一（只引标准号不说要求多少，不算约束）",
      "必须点明适用对象（表2-2 的要素名，或车间/区域/工序），否则下游改不了设计",
      "不得复述准入门槛（须持证/须通过认证/须列入名录）——那是表1-3；本表只写设计要满足什么值",
      "一行一项：多个约束项拆开写，否则下游无法逐条对照",
      "约束类须 T1",
    ],
    consumedBy: [2, 4],
  },
];

// ─── 阶段 2 · 理解商业（9 张） ──────────────────────────────

const TABLES_STAGE_2: readonly TableDef[] = [
  /* 2026-10-20 用户定调「不超过 5 张表」：8 张 → 5 张。
     保留 3-1/3-2/3-3/3-5/3-8；3-7 的坑并入 3-8（坑是缺口的证据，两处维护必然漏改）；
     3-4 的厂商与价格事实拆进 3-2，逐维对比归阶段3 表4-4（那里才有「我方 vs 对手」这一行）；
     3-9 整表删除（16 行全是「行业通例/AI 推断」，无可定位出处）。 */
  {
    code: "表3-1",
    name: "利润池",
    stage: 2,
    tier: "重要",
    rowUnit: "一个产业链环节",
    purpose: "钱在哪个环节：毛利空间与规模够不够养一个产品线——决定报价锚点定在哪、做整机还是只做集成",
    columns: [
      mid("link", "环节", { required: true }),
      mid("gross_margin", "毛利率", { required: true, note: "区间或单值 + 口径，如「20%–30%（测算）」；禁「较高/较低/行业口径」" }),
      mid("representative", "代表企业", { required: true, note: "≥2 家具名，禁「等/…/多家」" }),
      sup("source", "数据来源", { required: true }),
      sup("margin_basis", "毛利口径与样本", { note: "哪一年、几家、什么口径（年报/项目成交/集采后/测算）" }),
      sup("evidence_level", "证据等级", { required: true, enum: "evidence_level" }),
      sup("authority", "来源权威性", { required: true, enum: "authority" }),
    ],
    completeness: [
      "≥5 个环节，覆盖至少 1 个上游器件环节 + 1 个下游运维/渠道环节",
      "一行一环节，link 唯一；环节名首词受控（器件/整机/软件/集成/运维/渠道）",
      "毛利率必须是「区间/单值 + 口径」；口径只取年报/项目成交/经销/集采后/测算，禁单写「行业口径」",
      "代表企业 ≥2 家具名；出现「…」「等」视为未完成",
      "与表3-5 的「上游环节」不得逐字同名（一个是价值链段，一个是我方采购件）",
    ],
    consumedBy: [5],
  },
  {
    code: "表3-2",
    name: "方案形态与主要玩家",
    stage: 2,
    tier: "重要",
    rowUnit: "一种方案形态（一种打法）",
    purpose: "市面有几种打法、谁在做、卖什么价、适合什么客户——决定主推哪种形态、和谁正面撞、价格带怎么定",
    columns: [
      /* 2026-10-20 用户定调：原「形态」列被「要点」列逐字包含（要点一开头就是形态名），删掉形态列 */
      mid("key_points", "形态（交付什么·不做什么）", { required: true, note: "≤40 字，一句话就是这行的名字：交付什么 + 不交付什么（只/不含/除外）；不写价格" }),
      mid("players", "主要玩家", { required: true, note: "2–3 家具名，顿号分隔；这是阶段 3 的对手池" }),
      mid("position", "当前地位", { required: true, enum: "position" }),
      mid("price_band", "价格带", { required: true, note: "数字区间 + 单位 + 口径（项目成交/框架协议/年费/单机）；无价格材料写「未获取（缺哪类样本）」" }),
      mid("fit_for", "适用条件", { required: true, note: "≤40 字，含客户类型 + 一个量化条件（产线数/预算/规模）" }),
      sup("form_no", "编号"),
      sup("detail", "要点全文"),
      sup("position_basis", "地位判据", { note: "中标公告/年报/招标文件条款/渠道访谈" }),
      sup("price_basis", "报价口径与样本"),
      sup("source", "来源", { required: true }),
      sup("evidence_level", "证据等级", { required: true, enum: "evidence_level" }),
      sup("authority", "来源权威性", { required: true, enum: "authority" }),
    ],
    completeness: [
      "≥5 种形态；若有基线形态（什么都不做/沿用现状），排第一行",
      "key_points 唯一、≤40 字；第一句就是形态名（交付物 + 边界词：只/仅/不含/除外/不做），不写价格",
      "players 2–3 家具名；与表4-4 的「主要对手」同池",
      "position 只取扩张/稳定/收缩/未知；至少 1 行「扩张」，全行业无扩张时单列一行「无扩张形态」并在右栏给判据",
      "price_band 数字区间 + 单位 + 口径；「未获取」≤2 行，右栏写缺哪类样本",
      "fit_for ≤40 字且含一个数字（产线数/预算/规模）",
    ],
    consumedBy: [3, 5],
  },
  {
    code: "表3-3",
    name: "采购机制",
    stage: 2,
    /* 2026-10-20 提级：11 列一行一段，只靠抽查必漏；它直接决定「今年能不能碰」 */
    tier: "重要",
    rowUnit: "一类客户（按采购主体与预算口径分）",
    purpose: "这类客户怎么买、谁拍板、钱从哪出、多久能签——决定今年能不能碰、先找谁、要不要陪标",
    columns: [
      mid("customer_type", "客户类型", { required: true, note: "按采购主体分（集团/单厂/园区/渠道），不按行业分；唯一" }),
      mid("decision_maker", "拍板", { required: true, note: "岗位 1–3 个，含角色词（总监/经理/总工/主任/厂长/部长/院长/采购）；不写人名" }),
      mid("budget", "钱从哪出", { required: true, note: "格式「<付费方>｜<预算科目>」，两侧都非空" }),
      mid("default_choice", "默认选择", { required: true, note: "具名厂商/系统，或「自建/人工/不采购」；禁「无」「暂无」" }),
      mid("procurement_method", "采购方式", { required: true, enum: "procurement_method" }),
      mid("decision_cycle", "决策周期", { required: true, note: "「N–M 个月」或「N 个月」；禁「较长/半年左右」" }),
      sup("user_role", "使用角色"),
      sup("decision_basis", "决策依据"),
      sup("path_nodes", "路径关键节点", { note: "三段：资格（谁审、要什么证）/ 采购（招标/磋商/框架/集采）/ 付款（预付/进度款/质保金）" }),
      sup("incumbent", "在位供应商细节", { note: "厂商与合同到期；与中栏 default_choice 不重复" }),
      sup("source", "来源", { required: true }),
      sup("evidence_level", "证据等级", { required: true, enum: "evidence_level" }),
      sup("authority", "来源权威性", { required: true, enum: "authority" }),
    ],
    completeness: [
      "≥3 类客户，customer_type 唯一；按「谁买/预算口径」分，不按行业分",
      "decision_maker 写岗位且含角色词；一格 ≤3 个角色；不写人名/电话",
      "budget 必须两段（付费方｜科目），两侧非空；科目含「预算/费/专项/资金/科目」之一",
      "default_choice 必须具名或明确「自建/人工/不采购」；禁「无/暂无」",
      "procurement_method 只取七值；decision_cycle 给月数区间",
      "path_nodes 三段齐全（资格/采购/付款）；缺一段该行标「无法核实」，不得进阶段 4",
    ],
    consumedBy: [4],
  },
  {
    code: "表3-5",
    name: "上游供给格局",
    stage: 2,
    /* 2026-10-20 降为支撑：只保留我方真要采购/依赖的上游件（3–6 行），不再做行业上游全景 */
    tier: "支撑",
    rowUnit: "一个我方要采购/依赖的上游环节（部件/软件/服务级）",
    purpose: "我方要买的东西谁在供、能不能换、交期撑不撑、哪里会被卡——决定报价留多少涨价预备费、要不要锁产能、备选型号",
    columns: [
      mid("link", "上游环节", { required: true, note: "部件/软件/服务级；不得与表3-1 的环节逐字同名" }),
      mid("who_supplies", "主要供给方", { required: true, note: "2–5 家具名，或「前三家：A/B/C（合计 X%）」；禁「多家/若干/供应商」" }),
      mid("concentration", "集中度", { required: true, enum: "concentration" }),
      mid("substitutability", "可替代性", { required: true, enum: "substitutability" }),
      mid("bargaining", "议价权", { required: true, enum: "bargaining" }),
      mid("supply_risk", "被卡点", { required: true, note: "≤40 字，含一个量级（周/天/%/家/月）；写「卡在哪」，不写「有风险」" }),
      sup("mitigation", "卡住怎么办", { required: true, note: "四选一 + 动作：备选型号 / 安全库存 / 改设计 / 锁产能" }),
      sup("no", "编号"),
      sup("source", "来源", { required: true }),
      sup("evidence_level", "证据等级", { required: true, enum: "evidence_level" }),
      sup("authority", "来源权威性", { required: true, enum: "authority" }),
    ],
    completeness: [
      "只保留与 BOM/交付清单对应的上游，3–6 行；link 到部件/软件/服务级",
      "who_supplies 具名 2–5 家，或前三家 + 份额；禁「多家/若干」",
      "三个枚举列只取枚举值；判不了写「未知」，右栏写缺哪份依据",
      "supply_risk ≤40 字且含一个量级；不写「供应链有风险」",
      "mitigation 必填（备选/库存/改设计/锁产能 + 具体动作）；空则该行不放行",
      "至少 1 行「高度集中」或「单一来源」；若无，右栏逐行说明为何不成立",
    ],
    consumedBy: [4, 5],
  },
  {
    code: "表3-8",
    name: "值得打的缺口",
    stage: 2,
    tier: "重要",
    rowUnit: "一个缺口（同行踩过的坑是它的证据，不另起一行）",
    purpose: "哪个缺口最痛、现在拿什么凑合、客户会拿什么验收——决定先打哪个、值多少钱、阶段 4 合同验收怎么写",
    columns: [
      mid("rank", "排序", { required: true, note: "1..n 连续；按痛级降序，同级按后果量级降序" }),
      mid("gap", "缺口", { required: true, note: "≤40 字，含「现状→期望」或一个差距量；禁「效率低/信息孤岛」" }),
      mid("who_hurts", "谁在痛", { required: true, note: "岗位，顿号分隔；禁「客户/用户/企业/行业」" }),
      mid("pain_level", "痛级", { required: true, enum: "level_hml" }),
      mid("current_alternative", "现有替代", { required: true, note: "人工/Excel/自建/某厂商；确实没有写「无替代（忍着）」" }),
      mid("acceptance", "验收条件", { required: true, note: "≤40 字，客户验收语言：含 验收/条款/点位/指标/SLA/复算/可用率 之一" }),
      sup("symptom", "现场表现", { note: "从表3-7 的坑迁来" }),
      sup("root_cause", "根因"),
      sup("consequence", "不解决的损失", { required: true, note: "钱/工期/安全，带数字 + 单位" }),
      sup("why_unsatisfied", "为什么现有方案不行"),
      sup("cross_validation", "多源验证", { note: "来源条数，或「单一来源（模型知识）」" }),
      sup("why_now", "为什么现在能打", { note: "只有具名主体 + 日期 + 来源才填；原表3-9 的唯一合法归宿" }),
      sup("budget_item", "预算科目", { note: "须与表3-3 的 budget 科目同词表" }),
      sup("gap_source", "缺口来源"),
      sup("source", "来源", { required: true }),
      sup("evidence_level", "证据等级", { required: true, enum: "evidence_level" }),
      sup("authority", "来源权威性", { required: true, enum: "authority" }),
    ],
    completeness: [
      "≥3 条（新生成 ≥5）；rank 为 1..n 连续整数、不重复",
      "gap ≤40 字，含「现状→期望」或一个差距量；无基线的行 ≤1/3，且右栏标「行业通例」",
      "who_hurts 到岗位，禁泛称「客户/用户/行业」",
      "current_alternative 写现在怎么凑合；禁「无」",
      "acceptance ≤40 字且是客户验收语言（验收/条款/点位/指标/SLA/复算）；禁「加强/注意/关注/提升/优化」",
      "右栏 consequence 必填且含数字 + 单位；cross_validation 非空",
      "缺口来自同行坑时，右栏写 symptom/root_cause（坑不再单独成表）",
    ],
    consumedBy: [3, 5],
  },
];

const TABLES_STAGE_3: readonly TableDef[] = [

  {
    code: "表1-2",
    name: "场景环节地图",
    stage: 3,
    tier: "重要",
    rowUnit: "一个业务环节",
    purpose: "铺开场景的全部业务环节，把每个环节**现在是怎么做的**写清楚（谁在做、用什么、什么问题）",
    columns: [
      mid("link", "业务环节", { required: true }),
      mid("owner_now", "现在谁在做", { required: true, note: "写角色或岗位（如「班组长人工抄表」），不写人名" }),
      mid("current_tool", "现在用什么", { required: true, note: "现有系统/设备/方式；纯人工也要写明" }),
      mid("current_flow", "现在怎么做", { required: true, note: "流程与频次（谁在什么时候做什么）" }),
      mid("pain", "现状问题", { required: true, note: "这个环节现在卡在哪；没有就写「未发现明确问题」" }),
      sup("description", "环节说明", { required: true, type: "longText" }),
      sup("responsibility", "责任归属", { required: true }),
      sup("reason", "依据", { required: true, type: "longText" }),
      sup("source", "来源", { required: true }),
      sup("evidence_level", "证据等级", { required: true, enum: "evidence_level" }),
      sup("authority", "来源权威性", { required: true, enum: "authority" }),
    ],
    completeness: [
      "业务环节 ≥3 个",
      "每环节 owner_now / current_tool / current_flow / pain 非空——本步只写现状",
      "current_flow 须给频次与单次耗时（每班 2 次、每次 30 分钟），否则下游算不出人天",
      "依据须可回溯材料；没有材料就按行业通例口径写（来源列标 AI推断）",
    
      "≥4 个环节（含仍在用人工的环节）；环节名用动宾短语且唯一，生成后冻结",
      "谁在做写岗位；用什么写系统/设备/表单名（含「纸质台账」）",
      "现状问题写「哪一步、错/慢/漏多少」；没有明确问题写「未发现明确问题」",],
    consumedBy: [4, 5],
  },
  {
    code: "表4-1",
    name: "能力底账",
    stage: 3,
    tier: "重要",
    rowUnit: "一个能力项",
    purpose: "能不能做、到什么程度、边界在哪（证明材料属引用，归右栏）",
    columns: [
      mid("ability", "能力项", { required: true }),
      mid("maturity", "成熟度", { required: true, enum: "maturity" }),
      mid("limitation", "限制条件", { type: "longText", truncate: TRUNCATE_DEFAULT }),
      sup("no", "编号"),
      sup("proof", "证明材料", { required: true }),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["ability/maturity/proof 非空", "已交付行须有案例或验收数据",
      "只登记本场景会用的能力（8–20 行），全量能力归 M3，禁止整表重抄",
      "能力项逐字用 M3 能力名；场景特有说法写进限制条件，不改名",
      "限制绑定型号/产品线（CT15 无 NPU；AI Box 6TOPS）；无限制写「无已知限制（依据 …）」",],
    /* 客户现状表已移到本阶段（2026-10-14）：现成现状，再谈能不能满足 */
    dependsOnTables: ["表1-2"],
    consumedBy: [5],
  },
  {
    code: "表4-2",
    name: "我方参与地图",
    stage: 3,
    tier: "重要",
    rowUnit: "一个业务环节（来自表1-2）",
    purpose: "公司能力进场的第一步：逐环节看这个场景我方能不能碰、以什么角色参与",
    columns: [
      mid("link", "业务环节", { required: true, note: "与表1-2 的环节一致" }),
      /* 2026-10-20 用户定调「精简」：能否碰 与 我方角色 是同一判定的两种编码（不参与＝不能碰），
         合并为一列；能否碰原判定降右栏保留，不丢存量数据 */
      mid("our_role", "我方角色", { required: true, enum: "our_role", note: "替代/辅助/外围/不参与；「不参与」就是不能碰" }),
      mid("our_scope", "我方承担", { required: true, note: "≤40 字：我们做哪块、不做哪块（做 X，不做 Y），不许只写「配合」「支持」" }),
      sup("can_touch", "能否碰（原判定）", { enum: "can_touch" }),
      sup("role_reason", "角色判定依据", { type: "longText", truncate: TRUNCATE_DEFAULT, note: "依据 M3 能力清单 / M4 边界与限制；写清型号或产品线（依据属右栏，不进中栏）" }),
      sup("source", "来源", { required: true }),
      sup("evidence_level", "证据等级", { required: true, enum: "evidence_level" }),
      sup("authority", "来源权威性", { required: true, enum: "authority" }),
    ],
    completeness: [
      "每个环节一行（对齐表1-2）",
      "our_role 非空且取值合法；our_scope 写「做 X、不做 Y」，不写空话",
      "判定依据须引用 M3/M4 的具体条目",
    
      "环节与表1-2 一一对应、逐字同名；写「不能碰」必须给底账查找结论与反证型号",
      "依据写「【表4-1|能力项】+ 事实」，不写行业套话、不复述结论；缺算法与缺硬件分开写",],
    /* 客户现状表已移到本阶段（2026-10-14）：现成现状，再谈能不能满足 */
    dependsOnTables: ["表1-2"],
    consumedBy: [4, 5],
  },
  {
    code: "表4-3",
    name: "需求-能力对照",
    stage: 3,
    tier: "重要",
    rowUnit: "一个缺口（覆盖表3-8 每条）",
    purpose: "逐条记录客户需求能否满足",
    columns: [
      mid("gap_ref", "缺口（来自表3-8）", { required: true, type: "ref", refTable: "表3-8" }),
      mid("match", "匹配判定", { required: true, enum: "match" }),
      mid("our_product", "我方产品", { required: true }),
      /* 2026-10-20 精简：原「能力依据」是引用痕迹（G-R9 应归右栏）；「边界说明」升级为「处置」，
         直接写下一步怎么办（能解→交付形态 / 需补齐→补什么+人天 / 不能做→转分包或弃标） */
      mid("action", "处置", { required: true, note: "能解→交付形态；需补齐→补什么 + 人天；不能做→转分包/弃标" }),
      sup("ability_basis", "能力依据", { required: true, type: "ref", refTable: "表4-1" }),
      sup("risk", "风险"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["match 取值合法", "覆盖表3-8 每条缺口", "action 非空且能照着做（含人天或去向）", "ability_basis 可回溯表4-1",
      "gap_ref 逐字复述表3-8 缺口原文（写编号不算）",
      "需补齐写补什么 + 人天；不能做写转分包或弃标建议；能力依据（右栏）写【表4-1|能力项】",],
    dependsOnTables: ["表4-1", "表1-2"],
    consumedBy: [5],
  },
  {
    code: "表4-4",
    name: "细分打法与赢面",
    stage: 3,
    tier: "重要",
    rowUnit: "一个细分场景",
    /* 2026-10-20 用户定调「精简」：原表4-4（四维打分）+ 表4-5（每行一个评分维度）并成一张。
       4-5 的行粒度是评分模板——照着填得出一堆 25/20/20/15/10 的伪精度权重，对手却藏在右栏看不见；
       4-4 的四维（价值密度/契合度/难度/成熟度）本来是 表3-8×表3-2×表4-2×表4-3 的再编码。
       合并后：一行一个细分，一眼看到「先打哪个 + 对谁强/弱 + 第一件事做什么」。 */
    purpose: "先打哪个细分、打不打得过——把市场形态、我方能力与对手摆在同一行",
    columns: [
      mid("sub_scene", "细分场景", { required: true }),
      mid("value_density", "价值密度", { required: true, enum: "value_density", note: "只填 高/中/低，理由写右栏" }),
      mid("opponent", "主要对手", { required: true, note: "具名 1–2 家（取表3-2 的 players）或「客户现状（自建/手工）」" }),
      mid("win_loss", "胜负", { required: true, enum: "win_loss", note: "对上面这个对手：强/平/弱" }),
      mid("entry_action", "切入动作", { required: true, note: "≤40 字：第一件事做什么（试点/标杆/联合投标/换型替换）" }),
      mid("rank", "首打顺序", { required: true, type: "number", note: "1=首打；同项目内 1..n 连续不重复" }),
      sup("fit", "我方契合度", { note: "高/中/低 + 一句依据" }),
      sup("difficulty", "进入难度", { note: "高/中/低 + 一句依据" }),
      sup("stock_maturity", "存量成熟度", { note: "空白/零散/拥挤" }),
      sup("four_dim", "四维对照（技术/交付/价格/服务）", { type: "longText", note: "逐维写我方 vs 该对手：谁强、差多少（数字/案例）" }),
      sup("advantage", "我方优势"),
      sup("weakness", "我方劣势"),
      sup("implication", "对我方意味着什么", { type: "longText" }),
      sup("market_form", "对应市场形态", { note: "引用表3-2 的形态；规则类变化引表3-3 右栏 decision_basis" }),
      sup("entry_note", "我方切入点", { type: "longText", note: "承接表3-2 的形态与表3-3 的决策依据" }),
      sup("strategy", "策略"),
      sup("source", "来源", { required: true }),
    ],
    completeness: [
      "≥2 个细分场景；每个细分一行，sub_scene 唯一",
      "value_density 只取 高/中/低；opponent 只认表3-2 的 players 或本客户材料点名的厂商，禁「竞争对手」；调研不到写「未知」并在右栏写缺哪类情报",
      "win_loss 只取 强/平/弱；entry_action ≤40 字、是一件能立刻做的事",
      "rank 1..n 连续不重复；第一行注明「首打」+ 可验证理由（已有案例/已招标/对手缺席）",
      "四维对照、契合度/难度/成熟度定档依据写右栏；不写权重、不写总分（不做伪精度）",
    ],
    /* 跨阶段的表3-2/表3-8 通过上游上下文注入，不写进 dependsOnTables（同阶段依赖才写这里） */
    dependsOnTables: ["表1-2"],
    consumedBy: [5],
  },
];

const TABLES_STAGE_4: readonly TableDef[] = [
  {
    code: "表5-1",
    name: "架构与接口",
    stage: 4,
    tier: "重要",
    rowUnit: "架构块 = 一个层级；接口块 = 一个接口",
    purpose: "方案全貌 + 边界声明 + 接口清单（工作量口径见表5-3 的「人天」，本表不夹带）",
    blockLabels: { 架构: "方案架构", 接口: "接口清单" },
    columns: [
      mid("layer", "层", { required: true, block: "架构" }),
      mid("components", "组件/设备", { required: true, block: "架构" }),
      mid("interface", "接口/协议", { required: true, block: "架构" }),
      mid("integration", "与既有系统对接方式", { required: true, block: "架构" }),
      mid("boundary", "边界声明（不做什么）", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT, block: "架构" }),
      mid("interface_name", "接口名称", { required: true, block: "接口" }),
      mid("type", "类型", { required: true, block: "接口" }),
      mid("protocol", "协议/方式", { required: true, block: "接口" }),
      sup("source", "出处", { required: true }),
    ],
    completeness: ["架构块五项非空", "接口块三项非空且接口 ≥1 条", "boundary 不得为空",
      "架构块一行一层；接口块一行一接口（接口名称/类型/协议 + 对端系统 + 新增/改造/沿用）",
      "边界声明一行一项（我方不做X／客户负责Y／第三方负责Z），不写「以实际为准」",
      "本表不写人天（归表5-3）、不写 SLA（归表5-4）",],
    consumedBy: [5],
  },
  {
    code: "表5-3",
    name: "实施计划",
    stage: 4,
    tier: "重要",
    rowUnit: "一个实施项",
    purpose: "落地路径与前置条件（人天用于排期与工作量核算）；门槛应对行动也写在这里",
    columns: [
      mid("item", "项", { required: true }),
      mid("content", "内容", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("window", "窗口", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("man_days", "人天", { required: true, type: "number" }),
      mid("rollback", "回退", { required: true }),
      sup("env_prep", "环境准备"),
      sup("owner", "负责人"),
      sup("source", "出处"),
    ],
    completeness: ["六项必填非空", "man_days 为数值", "依赖不可控条件的项须显式标注",
      "人天给 ≥1 的整数，不含折扣；回退写清回退点 + 触发条件 + 耗时",
      "表1-3 每道门槛须有一行「门槛应对：<门槛名>」，写拿证路径/周期/责任人，或明写放弃",],
    dependsOnTables: ["表5-1"],
    consumedBy: [5],
  },
  {
    code: "表5-4",
    name: "交付与运维",
    stage: 4,
    tier: "重要",
    rowUnit: "一个交付/运维项",
    purpose: "交付方式与 SLA",
    columns: [
      mid("item", "项", { required: true }),
      mid("content", "内容", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("sla", "SLA", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      sup("note", "说明"),
      sup("source", "出处"),
    ],
    completeness: ["item/content/SLA 非空", "SLA 须含响应时限与故障处理时限",
      "SLA 给三项：响应 ≤X 小时、恢复 ≤Y 小时、可用率 ≥Z%（或到场 ≤W 小时）",
      "SLA 写计量口径：起算时点（报障/工单受理）、服务时段（7×24 或 5×8）、超时处置",
      "只写交付物与服务承诺，不写实施步骤（归表5-3）",],
    consumedBy: [5],
  },
];

// ─── 全部信息表（阶段 0–5） ───────────────────────────────────────────

/**
 * 核实两列：**每张表每一行**都要回答「这条信息准确吗、客观吗、为什么」
 *
 * 用户定调（v1.27）：「你的输出要核实客观性，要有价值……你应该对每一条信息问几个问题，
 * 这准确吗、客观吗？为什么准确，为什么客观。**不是要提示**，告诉用户来源准不准」。
 *
 * 所以这条不是「来源等级」那种标签，而是**核实之后的判定**：
 * - `verification_verdict`：已核实（材料能直接对上）/ 交叉一致（多源同向）/ 单一来源 /
 *   无法核实（只有模型知识或本客户数据缺失）/ 有反证（材料之间冲突，要写清冲在哪）
 * - `verification`：三段说明——**准确**（对得上哪份材料、数值能否复算、有无反例）、
 *   **客观**（是事实记录还是推断、谁的口径、有无利益相关方）、**为什么**（凭什么采信、哪里还不确定）
 *
 * 统一追加而不是 35 张表各写一遍：核实是每张表的义务，逐表手写必然漏。
 */
export const VERIFICATION_COLUMNS: readonly TableColumn[] = [
  sup("verification_verdict", "核实结论", {
    required: true,
    enum: "verification_verdict",
    note: "核实后的判定，不是来源等级：材料能直接对上=已核实；多源同向=交叉一致；行业公开常识、非本客户事实=行业通例；只有一处材料=单一来源；本客户事实缺材料/材料冲突判不了=无法核实；材料互相矛盾=有反证",
  }),
  sup("verification", "核实说明（准确·客观·为什么）", {
    required: true,
    type: "longText",
    truncate: 40,
    note: "三段写清：① 准确——对得上哪份材料的哪一处、数值能否复算、有没有反例；② 客观——是事实记录还是推断、谁的口径、有无利益相关方；③ 为什么——凭什么采信、哪里还不确定。**不许把核实推给读者**（不写「待核实」「建议抽查」「请用户确认」）",
  }),
];

export const TABLES: readonly TableDef[] = [
  ...TABLES_STAGE_0,
  ...TABLES_STAGE_1,
  ...TABLES_STAGE_2,
  ...TABLES_STAGE_3,
  ...TABLES_STAGE_4,
].map((t) =>
  // 表1-1（场景概述）例外：用户定调 v1.35（2026-10-09）「表1-1 只有项和内容两列，不需要核实」。
  // 它是固定 6 行的画像概览，不是用来记录"这条信息核实过没有"的分析表；
  // 附加两列会连带产生假问题——必填列校验按"核实两列必填"判它缺值，而界面上根本没这两列。
  t.code === "表1-1" ? t : { ...t, columns: [...t.columns, ...VERIFICATION_COLUMNS] },
);

/** 信息表表号联合类型（由注册表派生，供数据层使用） */
export type InfoTableCode = (typeof TABLES)[number]["code"];

export const TABLES_BY_CODE: Readonly<Record<string, TableDef>> = Object.fromEntries(
  TABLES.map((t) => [t.code, t]),
);

// ─── 覆盖度规则（可机器判定） ──────────────────────────────
//
// `TableDef.completeness` 是给人看的自然语言规则；本表是**可执行**的那部分，
// 供领域层的完整度检查直接跑（阶段进度与缺口清单的唯一依据）。

export type CoverageRule =
  | { kind: "min-rows"; min: number; label: string }
  | { kind: "enum-complete"; column: string; values: readonly string[]; label: string }
  | { kind: "all-columns-non-empty"; columns: readonly string[]; label: string };

export const COVERAGE_RULES: Readonly<Record<string, readonly CoverageRule[]>> = {
  "表1-2": [{ kind: "min-rows", min: 3, label: "业务环节 ≥3 个" }],
  /* 表1-3 不再设配额（变更表 #228）：门槛是发现出来的，不是凑出来的 */
  /* 2026-10-20 阶段 2 收成 5 张（用户定调「不超过 5 张表」）：3-4/3-7/3-9 已删除 */
  "表3-1": [{ kind: "min-rows", min: 5, label: "≥5 个产业链环节" }],
  "表3-2": [{ kind: "min-rows", min: 3, label: "≥3 种方案形态（目标 5 种）" }],
  "表3-3": [{ kind: "min-rows", min: 2, label: "≥2 类客户" }],
  "表3-5": [{ kind: "min-rows", min: 3, label: "≥3 个我方采购/依赖的上游环节" }],
  "表3-8": [{ kind: "min-rows", min: 3, label: "需求缺口 ≥3 条" }],
  "表4-4": [{ kind: "min-rows", min: 2, label: "细分场景 ≥2 个" }],
};

// ─── 派生助手 ──────────────────────────────────────────────

/** 中栏列（受列预算约束：≤6） */
export function middleColumns(t: TableDef, category?: string): readonly TableColumn[] {
  const payload = category && t.payloads ? (t.payloads[category] ?? []) : [];
  return [...t.columns, ...payload].filter((c) => c.slot === "中栏" && c.key !== t.groupBy);
}

/** 右栏补充列（长文本全文、来源、权威性、证据等级等） */
export function supplementColumns(t: TableDef, category?: string): readonly TableColumn[] {
  const payload = category && t.payloads ? (t.payloads[category] ?? []) : [];
  return [...t.columns, ...payload].filter((c) => c.slot === "右栏补充");
}

/** 核实两列的 key（v1.27：每条信息准确吗·客观吗·为什么） */
export const VERIFICATION_KEYS = ["verification_verdict", "verification"] as const;

/** 该表的核实列（每张表都有两列，统一追加） */
export function verificationColumns(t: TableDef): readonly TableColumn[] {
  return t.columns.filter((c) => (VERIFICATION_KEYS as readonly string[]).includes(c.key));
}

/**
 * 右栏「补充说明」表用的列：出处、证据等级、来源权威性、周期、说明……
 *
 * 核实两列**不进这张表**（v1.27）：右栏宽 240–480，横排进 8 列会挤成 27px/列；
 * 核实说明是长文本，单独一段纵向排（结论 + 全文）才读得下去，也才显得出它是重点。
 * 提示词渲染照旧用 `supplementColumns`（两列都要模型产出）。
 */
export function detailColumns(t: TableDef, category?: string): readonly TableColumn[] {
  return supplementColumns(t, category).filter(
    (c) => !(VERIFICATION_KEYS as readonly string[]).includes(c.key),
  );
}

/** 按块分组的中栏列（用于方案架构等多子块表） */
export function middleColumnsByBlock(t: TableDef): Readonly<Record<string, readonly TableColumn[]>> {
  const out: Record<string, TableColumn[]> = {};
  for (const c of middleColumns(t)) {
    const b = c.block ?? "";
    (out[b] ??= []).push(c);
  }
  return out;
}

/** 取阶段定义 */
/** 本阶段是否需要模型分析（阶段 0 解析入库、阶段 7 系统组装都不需要） */
export function isModelStage(stage: InfoStageId): boolean {
  return stageDef(stage).producedBy === "模型分析";
}

export function stageDef(id: InfoStageId): StageDef {
  const d = STAGE_DEFS.find((s) => s.id === id);
  if (!d) throw new Error(`未知阶段：${id}`);
  return d;
}

/** 取表定义 */
export function tableDef(code: string): TableDef {
  const t = TABLES_BY_CODE[code];
  if (!t) throw new Error(`未知表号：${code}`);
  return t;
}

/** 本阶段的表 */
export function tablesOfStage(id: InfoStageId): readonly TableDef[] {
  return TABLES.filter((t) => t.stage === id);
}

/** 常驻表（表1-1 场景锚） */
export function pinnedTables(): readonly TableDef[] {
  return TABLES.filter((t) => t.pinned);
}

/**
 * 行是否属于某个子块：块内任一列有值即算属于
 *
 * 为什么需要：v1.26 起多子块表的每个块在界面上各自成表（用户定调：拆成多个表格、一行显示），
 * 而生成时一行只填一个块的列（表5-1 的 rowUnit：架构块 = 一个层级；接口块 = 一个接口）。
 * 不按块过滤，接口块视图里会挂着一排「架构块的行」全是空格子。
 */
export function rowBelongsToBlock(
  t: TableDef,
  block: string,
  row: Readonly<Record<string, unknown>>,
): boolean {
  const cols = middleColumnsByBlock(t)[block] ?? [];
  if (cols.length === 0) return true;
  return cols.some((c) => {
    const v = row[c.key];
    if (Array.isArray(v)) return v.length > 0;
    return v !== undefined && v !== null && String(v).trim() !== "";
  });
}

/**
 * 子块的显示名：优先用注册表的 `blockLabels`，缺省 `${block}块`
 *
 * 界面（芯片一行）与文档（05 表格定义总表）都走这里，避免两处各写一遍。
 */
export function blockLabel(t: TableDef, block: string): string {
  return t.blockLabels?.[block] ?? `${block}块`;
}

/** 枚举取值 */
export function enumValues(name: EnumName): readonly string[] {
  return ENUMS[name];
}

/** 列预算上限 */
export const MIDDLE_COLUMN_BUDGET = 6;

/**
 * 按「块 / payload / 整表」分组取中栏列——**列预算的唯一核算口径**
 *
 * 多子块表（方案架构）与 payload 表（可选材料）不能把各块列数相加，
 * 因为界面同一时刻只渲染一个块/一种 payload。
 */
export function middleColumnGroups(
  t: TableDef,
): readonly { label: string; cols: readonly TableColumn[] }[] {
  if (t.payloads) {
    return Object.entries(t.payloads).map(([cat, cols]) => ({
      label: `${t.code}(${cat})`,
      cols: [...t.columns, ...cols].filter((c) => c.slot === "中栏" && c.key !== t.groupBy),
    }));
  }
  if (t.columns.some((c) => c.block)) {
    return Object.entries(middleColumnsByBlock(t)).map(([b, cols]) => ({
      label: `${t.code}(${b})`,
      cols,
    }));
  }
  return [{ label: t.code, cols: middleColumns(t) }];
}

/** 该表在任一时刻实际渲染的最大中栏列数 */
export function effectiveMiddleMax(t: TableDef): number {
  return Math.max(...middleColumnGroups(t).map((g) => g.cols.length));
}

/** 列预算违规清单（任一时刻的中栏列数 > 上限） */
export function columnBudgetViolations(): readonly { code: string; count: number; columns: string[] }[] {
  const out: { code: string; count: number; columns: string[] }[] = [];
  for (const t of TABLES) {
    for (const g of middleColumnGroups(t)) {
      if (g.cols.length > MIDDLE_COLUMN_BUDGET) {
        out.push({ code: g.label, count: g.cols.length, columns: g.cols.map((c) => c.label) });
      }
    }
  }
  return out;
}

/** 注册表完整性断言（供单测调用；返回问题清单，空数组即通过） */
export function registryIssues(): readonly string[] {
  const issues: string[] = [];

  // 表数：由阶段表集求和推导——写死数字就要在两处同步，漏一处守卫就形同虚设
  // （v1.29 加表3-5 时正是这样：这里还写着 35，测试却按注册表算 36）
  const declared = STAGE_DEFS.reduce((n, s) => n + s.tableCodes.length, 0);
  if (TABLES.length !== declared) {
    issues.push(`表数应为 ${declared}（阶段表集求和），实际 ${TABLES.length}`);
  }

  // 表号唯一
  const seen = new Set<string>();
  for (const t of TABLES) {
    if (seen.has(t.code)) issues.push(`表号重复：${t.code}`);
    seen.add(t.code);
  }

  for (const t of TABLES) {
    // 列预算
    for (const v of columnBudgetViolations()) {
      if (v.code === t.code || v.code.startsWith(`${t.code}(`)) {
        issues.push(`列预算超限：${v.code} 中栏 ${v.count} 列（上限 ${MIDDLE_COLUMN_BUDGET}）：${v.columns.join("/")}`);
      }
    }
    // 枚举合法（引用名必须存在且取值非空）
    const enumMap = ENUMS as Readonly<Record<string, readonly string[]>>;
    for (const c of t.columns) {
      if (c.enum && (enumMap[c.enum] ?? []).length === 0) {
        issues.push(`${t.code}.${c.key} 引用了空或不存在的枚举 ${c.enum}`);
      }
    }
    // 长文本必须给截断
    for (const c of t.columns) {
      if (c.type === "longText" && c.slot === "中栏" && !c.truncate)
        issues.push(`${t.code}.${c.key} 是长文本列但未给 truncate`);
    }
    // 目的与行粒度
    if (!t.purpose) issues.push(`${t.code} 缺 purpose`);
    if (!t.rowUnit) issues.push(`${t.code} 缺 rowUnit`);
    if (t.completeness.length === 0) issues.push(`${t.code} 缺 completeness`);
    // pinned 只能是表1-1
    if (t.pinned && t.code !== "表1-1") issues.push(`常驻表只能是表1-1，实际 ${t.code}`);
  }

  // 阶段覆盖与阶段定义一致
  for (const s of STAGE_DEFS) {
    const actual = tablesOfStage(s.id).map((t) => t.code);
    const declared = [...s.tableCodes];
    if (actual.length !== declared.length || actual.some((c) => !declared.includes(c))) {
      issues.push(`阶段 ${s.id} 的表清单与表定义不一致：定义 ${actual.join(",")} vs 声明 ${declared.join(",")}`);
    }
  }

  // 最后一步（交付物）无表：它是系统组装，不产信息表
  if (tablesOfStage(5).length !== 0) issues.push("交付物阶段（5）不应有信息表（它是文档组装）");

  // 覆盖度规则只能挂在存在的表上，且列名必须真实存在
  for (const [code, rules] of Object.entries(COVERAGE_RULES)) {
    const t = TABLES_BY_CODE[code];
    if (!t) {
      issues.push(`覆盖度规则挂在未知表号：${code}`);
      continue;
    }
    for (const r of rules) {
      const cols = r.kind === "enum-complete" ? [r.column] : r.kind === "all-columns-non-empty" ? r.columns : [];
      for (const key of cols) {
        if (!t.columns.some((c) => c.key === key)) {
          issues.push(`${code} 覆盖度规则引用了不存在的列：${key}`);
        }
      }
    }
  }

  return issues;
}


// ─── 交付物：章节 ← 表映射 ──────────────────────────────────
// ─── 交付物：章节 ← 表映射 ──────────────────────────────────
//
// 交付物只有一份：**客户端可读的「<场景>解决方案」**（变更表 #246，用户定调 2026-10-21）
//
// 演变：v1.31 起先有「解决方案」一份 → #136 收成对外单一口径 → #137 又加了一份
// 「建设工作方案」（客户给了两份定稿，章节骨架不同）→ #246 把两份**合成一份**：
// 「不再区分汇报对象，就是一个对用户的解决方案材料」，章序按建设工作方案的"怎么建"
// 主线展开，前面补客户现状与问题，后面收口下一步。
//
// 报告 = 素材（本章块里的表）+ 构件（报告自己长出来的设计原则、架构分层、核心功能、
// 主辅职责、编号连接关系、选型、实施要点与下一步）。素材是证据，构件才是报告的价值。
//
// 价值不单开表也不单开章（#246 用户定调：价值不一定要数据，"更多的还是从解决了什么问题
// 的角度描述"）：写在「建设目标与思路」里——解决了什么问题、谁受益、怎么看出来；
// 客户没给基线就如实写"待客户校准"，不许编数字。

/** 交付物口径：只有一份客户端可读的「<场景>解决方案」（变更表 #246） */
export const REPORT_KINDS = ["solution"] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];

/**
 * 报告类型名——拼在场景名后面，就是文件名与一级标题
 *
 * 例：`智慧会议室` → `智慧会议室解决方案`。
 */
export const REPORT_KIND_LABEL: Record<ReportKind, string> = {
  solution: "解决方案",
};

export interface DeliverableSection {
  key: string;
  title: string;
  /** 本节引用的表号（按顺序渲染） */
  tables: readonly string[];
  /** 给读者的口径说明（不含判断） */
  note?: string;
}

/** 章节里必须自建的小节，以及这一小节要产出的「方案构件」 */
export type ReportArtifact =
  /** 自建表格（层次/职责/选型/步骤这类，素材表里没有现成结构） */
  | "table"
  /** 带编号的连接关系（① ② ③…），与接口表一一对应 */
  | "numbered-connections"
  /** 我方设计原则（原则一/原则二…） */
  | "principles";

export interface ReportSection {
  /** 小节名（`###` 级） */
  title: string;
  /**
   * 同义关键词：模型换个说法写这一节也算写了
   *
   * 实测模型会把「场景在业务中的位置」写成「场景定位」或直接并进章节导语——
   * 小节名只是提示，不该卡住一份内容已经写全的报告。
   */
  keywords?: readonly string[];
  /** 这一小节必须自建的构件（校验据此把关，不来自任何表） */
  artifacts?: readonly ReportArtifact[];
  /** 章下直接写、不套 `###` 小节标题（校验不要求它单独成节） */
  noHeading?: boolean;
}

export interface ReportBlock {
  /** 表号 */
  code: string;
  /** 本章这一块的小标题（模型看到的素材名） */
  heading: string;
  /** 只取这些列（缺省 = 该表全部中栏列）——同一张表在不同章节取不同侧面 */
  cols?: readonly string[];
  /** 渲染方式：要点（默认，一行一条结论）或表格（数值/对比类） */
  as?: "bullets" | "table";
}

/**
 * 报告章节
 *
 * 章标题**不带序号**：Word 交付物里由模板的多级列表自动编号（1 / 1.1 / 1.1.1），
 * 在 Word 里增删章节编号会自动重排；Markdown 正文里也不手写「一、」。
 */
export interface ReportChapter {
  key: string;
  /** 章节名（不含序号） */
  label: string;
  /** 必须写出的小节（`###` 级）与自建构件 */
  sections: readonly ReportSection[];
  /** 整章级构件（章下不设小节时用） */
  artifacts?: readonly ReportArtifact[];
  /** 本章素材（模型据此撰写，不直接搬进报告） */
  blocks: readonly ReportBlock[];
}

export const REPORT_CHAPTERS: Record<ReportKind, readonly ReportChapter[]> = {
  /* ── 《<场景>解决方案》：一份材料讲完"现在什么样 / 要解决什么 / 怎么建 / 怎么落地" ──
       七章（变更表 #246）：现状与问题 / 建设目标与思路 / 方案总体与建设内容 /
       建设路径 / 工作安排 / 保障措施 / 下一步。 */
  solution: [
    {
      key: "status",
      label: "现状与问题",
      sections: [
        // 这两节按版式就是章下连续正文（不套 `###`），noHeading 让校验别把「没单独成节」当缺小节
        { title: "场景在业务中的位置", keywords: ["位置", "定位", "在业务中"], noHeading: true },
        { title: "既有体系与今天的做法", keywords: ["体系", "现有", "构成", "做法"], noHeading: true },
        { title: "主要问题", keywords: ["问题", "痛点", "卡在"], noHeading: true },
        { title: "现状特征与提升空间", keywords: ["现状", "提升", "空间"], artifacts: ["table"] },
      ],
      blocks: [
        { code: "表1-1", heading: "场景锚（在讲哪个场景）" },
        { code: "表1-2", heading: "业务环节、现在的做法与问题", cols: ["link", "owner_now", "current_tool", "pain"] },
        { code: "表3-8", heading: "值得打的缺口", cols: ["gap", "who_hurts", "pain_level", "acceptance"] },
      ],
    },
    {
      key: "goals",
      label: "建设目标与思路",
      sections: [
        { title: "总体目标", keywords: ["总体目标", "总目标"] },
        { title: "分项目标", keywords: ["分项目标", "子目标", "具体目标"] },
        { title: "总体建设思路", keywords: ["思路", "路径选择", "总体考虑"] },
        /* 价值从"解决了什么问题"讲（#246）：谁受益、改变了什么、怎么看得出来 */
        { title: "建成后改变什么", keywords: ["价值", "收益", "改变", "解决"], noHeading: true },
      ],
      blocks: [
        { code: "表3-8", heading: "要解决的需求（目标要对得上）", cols: ["gap", "who_hurts", "pain_level", "acceptance"] },
        { code: "表4-4", heading: "哪些细分我们自己能扛", as: "table", cols: ["sub_scene", "opponent", "win_loss"] },
      ],
    },
    {
      key: "solution",
      label: "方案总体与建设内容",
      sections: [
        { title: "设计原则", keywords: ["原则"], artifacts: ["principles"] },
        { title: "总体架构", keywords: ["架构", "层次"], artifacts: ["table"] },
        { title: "核心功能", keywords: ["核心功能", "功能", "能力"], artifacts: ["table"] },
        { title: "主辅职责对照", keywords: ["职责", "主辅"], artifacts: ["table"] },
        { title: "连接关系与接口", keywords: ["连接", "接口"], artifacts: ["numbered-connections"] },
        { title: "选型与配置", keywords: ["选型", "配置", "组成", "清单"], artifacts: ["table"] },
        { title: "实施要点", keywords: ["实施", "要点", "部署"] },
      ],
      blocks: [
        { code: "表5-1", heading: "方案架构与接口", cols: ["layer", "components", "interface", "integration", "boundary", "interface_name", "type", "protocol"] },
        { code: "表4-2", heading: "我方在哪些环节参与、以什么角色", cols: ["link", "our_role", "our_scope"] },
        { code: "表4-3", heading: "需求-能力对照", cols: ["gap_ref", "match", "our_product", "action"] },
        { code: "表5-3", heading: "实施安排", cols: ["item", "content", "window"] },
        { code: "表5-4", heading: "交付与运维", cols: ["item", "content", "sla"] },
      ],
    },
    {
      key: "path",
      label: "建设路径",
      sections: [
        { title: "数据采集", keywords: ["数据采集", "采集", "数据来源"] },
        { title: "新增感知设备", keywords: ["新增", "设备", "感知设备", "清单"], artifacts: ["table"] },
      ],
      blocks: [
        { code: "表5-1", heading: "方案架构与接口（采集点位落在哪一层）", cols: ["layer", "components", "interface"] },
        { code: "表5-3", heading: "实施安排", cols: ["item", "content", "window"] },
        { code: "表5-4", heading: "交付与运维", cols: ["item", "content", "sla"] },
        { code: "表4-2", heading: "我方在哪些环节参与、以什么角色", cols: ["link", "our_role", "our_scope"] },
      ],
    },
    {
      key: "schedule",
      label: "工作安排",
      /* 客户定稿：章下直接就是那张里程碑计划表，不套 `###` 小节 */
      sections: [
        { title: "阶段与时间安排", keywords: ["阶段", "时间", "计划", "安排", "进度"], artifacts: ["table"], noHeading: true },
      ],
      blocks: [
        { code: "表5-3", heading: "实施安排（阶段与时间窗口）", cols: ["item", "content", "window"] },
        { code: "表5-4", heading: "交付与运维", cols: ["item", "content", "sla"] },
      ],
    },
    {
      key: "safeguards",
      label: "保障措施",
      sections: [
        { title: "组织保障", keywords: ["组织", "团队", "分工"] },
        { title: "制度保障", keywords: ["制度", "流程", "规范"] },
        { title: "资金保障", keywords: ["资金", "预算", "投入"] },
        { title: "人才保障", keywords: ["人才", "培训", "能力建设"] },
      ],
      blocks: [
        { code: "表4-4", heading: "哪些细分要借外力", as: "table", cols: ["sub_scene", "opponent", "win_loss", "entry_action"] },
        { code: "表5-4", heading: "交付与运维", cols: ["item", "content", "sla"] },
      ],
    },
    {
      key: "next",
      label: "下一步",
      sections: [{ title: "步骤与交付物", keywords: ["步骤", "交付物", "计划", "安排"], artifacts: ["table"] }],
      blocks: [
        { code: "表5-3", heading: "实施安排", cols: ["item", "content", "window"] },
        { code: "表5-4", heading: "交付与运维", cols: ["item", "content", "sla"] },
      ],
    },
  ],
};

/** 某一口径的全部章节（按顺序） */
export function reportChapters(kind: ReportKind): readonly ReportChapter[] {
  return REPORT_CHAPTERS[kind];
}

/** 章节名（不含序号）：Markdown 里就写这个名字，编号交给 Word 自动生成 */
export function reportChapterHeading(kind: ReportKind, key: string): string {
  return reportChapters(kind).find((c) => c.key === key)?.label ?? "";
}

/** 某一口径的全部章节名（按顺序）——校验据此判断"缺章" */
export function reportChapterHeadings(kind: ReportKind): readonly string[] {
  return reportChapters(kind).map((c) => c.label);
}
