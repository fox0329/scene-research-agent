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
export type InfoStageId = 0 | 1 | 2 | 3 | 4 | 5 | 6;

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
  measured: ["实测", "宣称", "未提及"],
  barrier_type: ["技术", "行业准入", "经济", "生态锁定", "一票否决者"],
  industry_practice: ["正面满足", "换技术路径", "借道合作", "等窗口", "行业普遍不做"],
  can_touch: ["可以碰", "只能配合", "不能碰"],
  our_role: ["替代", "辅助", "外围", "不参与"],
  match: ["真能解", "需补齐", "不能做"],
  level_hml: ["高", "中", "低"],
  optional_category: ["O1认证", "O2案例", "O3价格与授权", "O4开发资料", "O5路线图", "O6交付与生态"],
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
  position: ["扩张", "稳定", "收缩"],
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
    goal: "我方有哪些产品、能力、边界、限制、费率；有哪些认证/案例/价格/资料/路线图/生态",
    tableCodes: ["M1", "M2", "M3", "M4", "M5", "可选材料"],
    summaryTitle: "① 材料入库总结",
  },
  {
    id: 1,
    name: "认识场景（含门槛与合规）",
    producedBy: "模型分析",
    goal: "场景是什么、由哪些业务环节组成、每环节能否参与、有哪些要素、系统怎么连、有哪些硬约束与门槛、认证现状、现有交付运维方式",
    tableCodes: ["表1-1", "表1-2", "表1-3", "表2-2", "表2-3", "表2-4", "表2-5", "表2-7"],
    summaryTitle: "② 场景认识总结",
  },
  {
    id: 2,
    name: "理解商业",
    producedBy: "模型分析",
    goal: "钱怎么分、有哪些方案形态、客户怎么买、对手位势、替代方案与价格、别人踩过的坑、没被满足的需求、行业趋势",
    tableCodes: ["表3-1", "表3-2", "表3-3", "表3-4", "表3-5", "表3-6", "表3-7", "表3-8", "表3-9"],
    summaryTitle: "③ 商业格局总结",
  },
  {
    id: 3,
    name: "能力匹配",
    producedBy: "模型分析",
    goal: "我方能力底账、客户每条需求能否满足、细分优先级、竞争力评分",
    tableCodes: ["表4-1", "表4-2", "表4-3", "表4-4", "表4-5"],
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
    name: "价值与验证",
    producedBy: "模型分析",
    goal: "收益对应指标、怎么测、基线、预期改善、用户感受、试点设计与验收口径",
    tableCodes: ["表6-1", "表6-4"],
    summaryTitle: "⑥ 价值与验证总结",
  },
  {
    id: 6,
    name: "最终交付物",
    producedBy: "系统组装",
    goal: "内部调研报告 + 对外汇报材料（文档产出，非表）",
    tableCodes: [],
    summaryTitle: "⑦ 交付说明",
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

// ─── 阶段 0 · 材料解析与入库（6 张） ────────────────────────

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
      mid("launch_date", "上市/计划时间", { type: "date" }),
      sup("former_name", "曾用名/代号"),
      sup("material_sync", "资料同步"),
      sup("position_desc", "一句话定位", { type: "longText" }),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["model/name/status 非空且 model 无重复", "每行有来源"],
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
      mid("param_class", "参数类", { required: true }),
      mid("param_name", "参数项", { required: true }),
      mid("value", "值", { required: true }),
      mid("measured", "实测/宣称", { required: true, enum: "measured" }),
      sup("product_id", "所属产品", { required: true, type: "ref", refTable: "M1" }),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["四必填非空", "实测行须 T1/T2 来源", "宣称行标注为 B 级以下"],
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
      sup("description", "一句话描述", { required: true, type: "longText" }),
      sup("dependency", "依赖条件"),
      sup("inapplicable_scene", "不适用场景"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["domain/name/maturity 非空", "每行有来源", "已交付行须有 O2 案例佐证或标『无案例』"],
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
      mid("plan_date", "计划时间", { type: "date" }),
      sup("reason", "原因", { required: true, type: "longText" }),
      sup("response", "客户要求时怎么办", { required: true, type: "longText" }),
      sup("owner", "填写人"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["description/reason/has_plan/response 非空", "source_type 至少『用户确认』"],
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
      sup("date", "日期", { type: "date" }),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["四项必填非空", "source_type ≥『用户确认』"],
    consumedBy: [4, 5],
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

// ─── 阶段 1 · 认识场景（含门槛与合规）（8 张） ──────────────

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
    consumedBy: [2, 3, 4, 5, 6, 6],
  },
  {
    code: "表1-2",
    name: "场景环节地图",
    stage: 1,
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
      "依据须可回溯材料；没有材料就按行业通例口径写（来源列标 AI推断）",
    ],
    consumedBy: [3, 4, 6],
  },
  {
    code: "表1-3",
    name: "门槛与合规",
    stage: 1,
    tier: "重要",
    rowUnit: "一道门槛（一票否决者类为一个角色；认证类为一项认证要求）",
    purpose: "五类门槛是什么、判据是什么、卡在谁手里、行业里一般怎么过（不写我方的行动，也不猜本客户的合规结论）",
    columns: [
      mid("barrier_type", "门槛类型", { required: true, enum: "barrier_type" }),
      mid("barrier_name", "门槛", { required: true }),
      mid("veto_holder", "否决者", { requiredWhen: "生态锁定类除外" }),
      mid("criteria", "判据", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("industry_practice", "行业通行处置", { enum: "industry_practice", note: "行业里这道门槛一般怎么过（市场知识）" }),
      sup("cert_gap", "认证差距", { requiredWhen: "认证类必填" }),
      sup("source", "来源", { required: true }),
      sup("evidence_level", "证据等级", { required: true, enum: "evidence_level" }),
      sup("authority", "来源权威性", { required: true, enum: "authority" }),
    ],
    completeness: [
      "五类门槛各 ≥1 行",
      "criteria 含具体等级/标准号/数值（禁『较高』『相关』）",
      "只针对本场景能问到的事实；没有材料依据的门槛照行业通例写，不猜本客户的合规结论",
    ],
    consumedBy: [4, 6],
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
      mid("competition", "竞争激烈度", { enum: "competition" }),
      sup("key_params", "关键技术参数", { type: "longText" }),
      sup("served_role", "服务的对象角色"),
      sup("touchpoint", "触点"),
      sup("source", "出处", { required: true }),
    ],
    completeness: ["element_name/element_type/function 非空", "price_range 缺须显式写『未提供』", "供应商与价格须有来源或标『待确认』"],
    consumedBy: [2, 4],
  },
  {
    code: "表2-3",
    name: "分层架构",
    stage: 1,
    tier: "过程",
    rowUnit: "一个层级",
    purpose: "客户侧架构的文字版，供方案架构参照",
    columns: [
      mid("layer", "层级", { required: true }),
      mid("components", "包含组件", { required: true }),
      mid("interface", "接口/协议", { required: true }),
      sup("note", "说明"),
      sup("source", "出处", { required: true }),
    ],
    completeness: ["layer/components/interface 非空", "接口协议须有来源"],
    dependsOnTables: ["表2-2"],
    consumedBy: [4],
  },
  {
    code: "表2-4",
    name: "要素间关系",
    stage: 1,
    tier: "过程",
    rowUnit: "一条交互关系",
    purpose: "客户侧要素之间怎么交互，供接口设计参照",
    columns: [
      mid("interaction_type", "交互类型", { required: true }),
      mid("from_to", "起点→终点", { required: true }),
      mid("method", "方式", { required: true }),
      mid("key_params", "关键参数"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["from_to/method 非空", "方式（协议）须 T1/T2"],
    dependsOnTables: ["表2-2"],
    consumedBy: [4],
  },
  {
    code: "表2-5",
    name: "物理与合规约束",
    stage: 1,
    tier: "支撑",
    rowUnit: "一个约束项",
    purpose: "这个场景的硬约束（要求与出处；怎么落地由后面的方案表回答）",
    columns: [
      mid("constraint_item", "约束项", { required: true }),
      mid("required_value", "具体要求值", { required: true }),
      mid("standard_no", "适用标准号"),
      sup("period", "周期"),
      sup("source", "出处", { required: true }),
      sup("evidence_level", "证据等级", { required: true, enum: "evidence_level" }),
      sup("authority", "来源权威性", { required: true, enum: "authority" }),
    ],
    completeness: ["constraint_item/required_value 非空且为具体数值或等级", "约束类须 T1"],
    consumedBy: [2, 4],
  },
  {
    code: "表2-7",
    name: "交付与运维现状",
    stage: 1,
    tier: "过程",
    rowUnit: "一个现状项",
    purpose: "客户现有的交付与运维方式，供交付模式设计参照",
    columns: [
      mid("item", "项", { required: true }),
      mid("status", "现状", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      sup("note", "说明"),
      sup("source", "出处", { required: true }),
    ],
    completeness: ["item/status 非空", "status 须说明『谁在做、什么形式、周期如何』"],
    consumedBy: [4],
  },
];

// ─── 阶段 2 · 理解商业（8 张） ──────────────────────────────

const TABLES_STAGE_2: readonly TableDef[] = [
  {
    code: "表3-1",
    name: "利润池",
    stage: 2,
    tier: "重要",
    rowUnit: "一个产业链环节",
    purpose: "钱在哪个环节",
    columns: [
      mid("link", "环节", { required: true }),
      mid("gross_margin", "毛利率", { required: true, note: "数值或区间，禁『较高/较低』" }),
      mid("representative", "代表企业", { required: true }),
      sup("source", "数据来源", { required: true }),
      sup("evidence_level", "证据等级", { required: true, enum: "evidence_level" }),
      sup("authority", "来源权威性", { required: true, enum: "authority" }),
    ],
    completeness: ["覆盖 ≥3 个环节", "每行必须有来源"],
    consumedBy: [6],
  },
  {
    code: "表3-2",
    name: "方案形态",
    stage: 2,
    tier: "重要",
    rowUnit: "一种方案形态",
    purpose: "市面有几种打法、哪种在扩张、各自适合什么客户（不写我方怎么切）",
    columns: [
      mid("form", "方案形态", { required: true }),
      mid("key_points", "要点", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("leader", "主导者", { required: true }),
      mid("position", "当前地位", { required: true, enum: "position" }),
      mid("fit_for", "适用条件", { required: true, note: "这种打法适合什么客户、什么预算档、什么场景规模" }),
      sup("form_no", "形态编号"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["≥3 种形态", "form/key_points/leader/fit_for 非空"],
    consumedBy: [3, 6],
  },
  {
    code: "表3-3",
    name: "采购机制",
    stage: 2,
    tier: "支撑",
    rowUnit: "一类客户",
    purpose: "客户怎么买、钱从哪出、谁拍板谁用、决策多久、现在谁在供",
    columns: [
      mid("customer_type", "客户类型", { required: true }),
      mid("decision_maker", "决策角色", { note: "哪类岗位拍板（写角色不写人名）——表1-1 只给画像，明细在这里查" }),
      mid("user_role", "使用角色", { note: "谁日常用" }),
      mid("payer", "付费方", { note: "钱从谁的预算出" }),
      mid("default_choice", "默认选择", { required: true }),
      mid("budget_item", "预算科目", { required: true }),
      // 中栏预算上限 6 列：采购方式/决策周期属于"怎么操作"的说明类信息，放右栏补充列，
      // 中栏只留"谁买、默认选谁、钱从哪出"这三件主信息。
      sup("procurement_method", "采购方式"),
      sup("decision_cycle", "决策周期"),
      sup("decision_basis", "决策依据"),
      sup("incumbent", "现在谁在供", { note: "在位供应商的类型或厂商名" }),
      sup("path_nodes", "路径关键节点", { note: "这条采购路径上必须过的关口" }),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["customer_type/default_choice/budget_item 非空", "每行有来源"],
    consumedBy: [4],
  },
  {
    code: "表3-4",
    name: "竞争对手对照",
    stage: 2,
    tier: "支撑",
    rowUnit: "一个对照维度（固定 4 列：竞品 A/B/C/D）",
    purpose: "市面上有哪几家对手、各自什么水平（我方与对手的对照在阶段 3 表4-5）",
    columns: [
      mid("dimension", "对照维度", { required: true }),
      mid("competitor_a", "竞品 A"),
      mid("competitor_b", "竞品 B"),
      mid("competitor_c", "竞品 C"),
      mid("competitor_d", "竞品 D"),
      sup("source", "来源", { required: true }),
      sup("evidence_level", "证据等级", { required: true, enum: "evidence_level" }),
      sup("authority", "来源权威性", { required: true, enum: "authority" }),
    ],
    completeness: ["竞品 ≥3 家（A/B/C 至少填满）", "维度 ≥3 个", "竞品取值须有来源"],
    consumedBy: [3],
  },
  {
    code: "表3-5",
    name: "上游供给格局",
    stage: 2,
    tier: "重要",
    rowUnit: "一个上游环节（关键器件 / 材料 / 基础软件 / 集成服务）",
    purpose: "这个场景的上游是谁在供、集不集中、能不能换、交期撑不撑得住、有没有被卡的风险",
    columns: [
      mid("link", "上游环节", { required: true, note: "如：气体传感器、边缘控制器、通信模组、平台软件、集成实施" }),
      mid("who_supplies", "主要供给方", { required: true, note: "写厂商/产品名或「多家分散、无主导厂商」；不许只写「供应商」" }),
      mid("concentration", "供给集中度", { required: true, enum: "concentration", note: "这一环是少数几家说了算，还是谁都能做" }),
      mid("substitutability", "可替代性", { required: true, enum: "substitutability", note: "换供应商的代价：能不能换、换谁、要不要重新认证" }),
      mid("bargaining", "议价权在谁", { required: true, enum: "bargaining", note: "这一环的价格是谁定的" }),
      mid("supply_risk", "被卡点", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT, note: "交期/产能/单一来源/认证绑定/国产化替代——这一环最容易卡在哪" }),
      sup("no", "编号"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["≥3 个上游环节（覆盖关键器件、基础软件、集成服务）", "link/who_supplies/supply_risk 非空", "每条有来源"],
    consumedBy: [4, 5],
  },
  {
    code: "表3-6",
    name: "替代方案",
    stage: 2,
    tier: "重要",
    rowUnit: "一个可对照方案（必须含「什么都不做」）",
    purpose: "客户手上还有什么可选项、各自什么价格",
    columns: [
      mid("alternative", "替代方案", { required: true, note: "必须含『什么都不做』" }),
      mid("customer_gets", "客户得到什么", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("cost_structure", "成本结构", { required: true }),
      mid("unit_cost", "单位成本", { required: true, type: "number" }),
      mid("chosen_when", "谁在用、什么条件下选它", { required: true, note: "这类方案的实际采用者与采用条件" }),
      sup("no", "编号"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["≥2 个对照方案（含「什么都不做」）", "alternative/customer_gets/cost_structure/unit_cost/chosen_when 非空", "成本须有来源或标『估算』"],
    consumedBy: [3, 4, 6],
  },
  {
    code: "表3-7",
    name: "同行踩过的坑",
    stage: 2,
    tier: "支撑",
    rowUnit: "一个坑（一条会被踩到的事）",
    purpose: "同行在这类项目上踩过的坑，以及我们方案里怎么避（写成硬指标，不是口头承诺）",
    columns: [
      mid("pitfall", "坑（现场会发生什么）", { required: true, note: "写具体场面：谁在什么环节干了什么、结果出了什么事" }),
      mid("consequence", "后果（钱·工期·安全）", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT, note: "落到钱、工期、安全、口碑——不写「影响较大」这类空话" }),
      mid("avoid_in_design", "我们方案里怎么避", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT, note: "写成可验收的硬指标或交付条款（如「验收含批量交付节拍」），不写「加强管理」" }),
      sup("no", "编号"),
      sup("symptom", "表现（现场细节）"),
      sup("root_cause", "根因"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["≥2 条", "pitfall/consequence/avoid_in_design 非空", "每条有来源"],
    consumedBy: [4],
  },
  {
    code: "表3-8",
    name: "未满足需求",
    stage: 2,
    tier: "重要",
    rowUnit: "一个需求缺口",
    purpose: "『值得打的位置』的唯一来源 + 痛点排序",
    columns: [
      mid("rank", "排序", { required: true, note: "按痛感从高到低排，1 = 最痛" }),
      mid("gap", "缺口描述", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("who_hurts", "谁在痛", { required: true }),
      mid("pain_level", "痛到什么程度", { required: true, enum: "level_hml" }),
      mid("current_alternative", "现有替代方案", { type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("cross_validation", "多源验证", { required: true, note: "几条独立来源印证；只有模型知识就写「单一来源（模型知识）」" }),
      sup("why_unsatisfied", "为什么不满意", { required: true, type: "longText" }),
      sup("budget_item", "对应预算科目", { required: true, note: "按行业惯例的科目名写（如信息化建设/行政后勤改造），不写客户的具体预算编号" }),
      sup("gap_source", "缺口来源"),
      sup("source", "来源", { required: true }),
      sup("evidence_level", "证据等级", { required: true, enum: "evidence_level" }),
      sup("authority", "来源权威性", { required: true, enum: "authority" }),
    ],
    completeness: ["≥3 条", "gap/who_hurts/pain_level/why_unsatisfied 非空", "每行有来源", "rank/多源验证/对应预算科目 非空"],
    consumedBy: [3, 6],
  },
  {
    code: "表3-9",
    name: "行业趋势",
    stage: 2,
    tier: "过程",
    rowUnit: "一条趋势",
    purpose: "变化方向与时间窗口（对场景各方的影响，不写对我方含义）",
    columns: [
      mid("trend", "趋势", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("driver", "驱动力", { required: true }),
      mid("impact", "对场景各方的影响", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT, note: "对客户、对在位供应商分别意味着什么" }),
      mid("window", "时间窗口", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      sup("no", "编号"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["趋势/对场景各方的影响 非空", "时间窗口须为具体时间段"],
    consumedBy: [3, 6],
  },
];

// ─── 阶段 3 · 能力匹配（5 张） ──────────────────────────────

const TABLES_STAGE_3: readonly TableDef[] = [
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
    completeness: ["ability/maturity/proof 非空", "已交付行须有案例或验收数据"],
    consumedBy: [6],
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
      mid("can_touch", "我方可参与程度", { required: true, enum: "can_touch" }),
      mid("our_role", "我方角色", { required: true, enum: "our_role" }),
      mid("role_reason", "角色判定依据", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT, note: "依据 M3 能力清单 / M4 边界 / M5 已知限制；对得上的写清型号或产品线" }),
      sup("source", "来源", { required: true }),
      sup("evidence_level", "证据等级", { required: true, enum: "evidence_level" }),
      sup("authority", "来源权威性", { required: true, enum: "authority" }),
    ],
    completeness: [
      "每个环节一行（对齐表1-2）",
      "can_touch 与 our_role 非空且取值合法",
      "判定依据须引用 M3/M4/M5 的具体条目",
    ],
    consumedBy: [4, 5, 6],
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
      mid("ability_basis", "能力依据", { required: true, type: "ref", refTable: "表4-1" }),
      mid("boundary_note", "边界说明", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      sup("risk", "风险"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["match 取值合法", "覆盖表3-8 每条缺口", "boundary_note 非空", "ability_basis 可回溯表4-1"],
    dependsOnTables: ["表4-1"],
    consumedBy: [6],
  },
  {
    code: "表4-4",
    name: "细分优先级",
    stage: 3,
    tier: "重要",
    rowUnit: "一个细分场景",
    purpose: "先打哪个细分——公司能力进场后，把市场形态与我方能力对起来",
    columns: [
      mid("sub_scene", "细分场景", { required: true }),
      mid("value_density", "价值密度", { required: true }),
      mid("fit", "我方契合度", { required: true }),
      mid("difficulty", "进入难度", { required: true }),
      mid("stock_maturity", "存量成熟度", { required: true }),
      mid("rank", "综合排序", { required: true }),
      sup("market_form", "对应市场形态或趋势", { note: "引用表3-2 的形态或表3-9 的趋势" }),
      sup("entry_note", "我方切入点／对我方含义", { type: "longText", note: "承接表3-2 与表3-9 里原先挂在我方的那两项" }),
      sup("strategy", "策略"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["≥2 个细分场景", "四维度非空", "必须给出排名第一的结论"],
    consumedBy: [6],
  },
  {
    code: "表4-5",
    name: "竞争力判断",
    stage: 3,
    tier: "重要",
    rowUnit: "一个评分维度（末行总分）",
    purpose: "与对手/替代方案比，赢面评分与依据（我方对照全在这里）",
    columns: [
      mid("dimension", "维度", { required: true }),
      mid("weight", "权重", { required: true, type: "number" }),
      mid("score", "评分(1-5)", { required: true, type: "number" }),
      mid("basis", "打分依据", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      sup("compared_with", "对照对象", { note: "与哪家竞品（表3-4）或哪个替代方案（表3-6）比" }),
      sup("advantage", "我方优势"),
      sup("weakness", "我方劣势"),
      sup("implication", "对我方意味着什么", { type: "longText" }),
      sup("source", "来源"),
    ],
    completeness: ["维度 ≥4 个", "权重之和 = 100%", "总分 = Σ(权重 × 评分)"],
    consumedBy: [6],
  },
];

// ─── 阶段 4 · 方案与实现（3 张） ────────────────────────────

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
    completeness: ["架构块五项非空", "接口块三项非空且接口 ≥1 条", "boundary 不得为空"],
    consumedBy: [6],
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
    completeness: ["六项必填非空", "man_days 为数值", "依赖不可控条件的项须显式标注"],
    dependsOnTables: ["表5-1"],
    consumedBy: [6],
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
    completeness: ["item/content/SLA 非空", "SLA 须含响应时限与故障处理时限"],
    consumedBy: [6],
  },
];

// ─── 阶段 5 · 价值与验证（2 张） ────────────────────────

const TABLES_STAGE_5: readonly TableDef[] = [
  {
    code: "表6-1",
    name: "价值与指标",
    stage: 5,
    tier: "重要",
    rowUnit: "一项收益/指标",
    purpose: "收益怎么测、基线在哪",
    columns: [
      mid("benefit", "收益", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("metric", "对应指标", { required: true }),
      /* 基线归**右栏补充说明**（变更表 #153，用户选定）：客户基线在调研阶段通常拿不到，
         真机两个项目 19 行里 19 行都是「未提供」——一个 required 的长文本列白占中栏。
         挪位后三件事**都不受影响**（判据一律按列 key `baseline` 读，与栏位无关）：
           ① G-R8「价值主张必须有指标 + 本客户基线」的落点（`postcheck.ts` 按 key 取值）；
           ② 完整度「baseline/how_to_measure/user_feeling 非空」与「无基线行强制标 C 级假设」
              （`completeness.ts` 按列定义判必填；规则原文见本表 completeness）；
           ③ 报告「价值」章的映射列（`REPORT_CHAPTERS` 的 `cols` 含 baseline，装配按 key 取——
              见 `packages/infra/src/md-export.ts` 的 `renderBlock`：显式列出的 key 从**全部列**里取，
              不按中栏/右栏过滤，否则挪到右栏的报告就再也看不到基线）。
         `required` 保留：拿不到就如实写「未提供（本客户材料未含）」并标 C 级假设，不许填行情数字冒充。
         不传 `truncate`：它只服务中栏单行单元格的截断（`TableColumn.truncate` 的定义），
         右栏是「可增高多行编辑器」，长文本全文显示，截断在这里没有落点。 */
      sup("baseline", "基线", { required: true, type: "longText" }),
      mid("expected", "预期改善", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("how_to_measure", "怎么测", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("user_feeling", "用户感受", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT, note: "必须用客户语言" }),
      sup("evidence_level", "证据级", { required: true, enum: "evidence_level" }),
      sup("metric_type", "指标类型", { required: true }),
      sup("duration", "测多久"),
      sup("auto_collect", "自动采集方案"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["≥2 条", "baseline/how_to_measure/user_feeling 非空", "无基线行强制标 C 级假设"],
    consumedBy: [6],
  },
  {
    code: "表6-4",
    name: "试点与验收",
    stage: 5,
    tier: "重要",
    rowUnit: "一个验证要素",
    purpose: "怎么验证、算不算成功、怎么验收",
    columns: [
      mid("kind", "要素类型", { required: true, enum: "pilot_kind" }),
      mid("content", "内容", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      sup("source", "来源"),
    ],
    completeness: ["kind 覆盖『成功判据』与『验收口径』两类"],
    consumedBy: [6],
  },
];

// ─── 35 张表总表（阶段 0–6） ───────────────────────────────────────────

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
  ...TABLES_STAGE_5,
].map((t) => ({ ...t, columns: [...t.columns, ...VERIFICATION_COLUMNS] }));

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
  "表1-3": [
    {
      kind: "enum-complete",
      column: "barrier_type",
      values: ENUMS.barrier_type,
      label: "五类门槛各 ≥1 行",
    },
  ],
  "表3-1": [{ kind: "min-rows", min: 3, label: "覆盖 ≥3 个产业链环节" }],
  "表3-2": [{ kind: "min-rows", min: 3, label: "≥3 种方案形态" }],
  "表3-4": [
    { kind: "min-rows", min: 3, label: "对照维度 ≥3 个" },
    {
      kind: "all-columns-non-empty",
      columns: ["competitor_a", "competitor_b", "competitor_c"],
      label: "竞品 ≥3 家（A/B/C 均填）",
    },
  ],
  "表3-6": [{ kind: "min-rows", min: 2, label: "≥2 个对照方案（含我方方案行）" }],
  "表3-7": [{ kind: "min-rows", min: 2, label: "失败反模式 ≥2 条" }],
  "表3-8": [{ kind: "min-rows", min: 3, label: "需求缺口 ≥3 条" }],
  "表4-4": [{ kind: "min-rows", min: 2, label: "细分场景 ≥2 个" }],
  "表4-5": [{ kind: "min-rows", min: 4, label: "竞争力维度 ≥4 个" }],
  "表6-1": [{ kind: "min-rows", min: 2, label: "价值与指标 ≥2 条" }],
  "表6-4": [
    {
      kind: "enum-complete",
      column: "kind",
      values: ["成功判据", "验收口径"],
      label: "覆盖『成功判据』与『验收口径』两类",
    },
  ],
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
  if (tablesOfStage(6).length !== 0) issues.push("交付物阶段（6）不应有信息表（它是文档组装）");

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
// 交付物只有一份：**客户端可读的「<场景>解决方案」**（变更表 #136）。
// 用户定调（2026-10-07 / 变更表 #136）：「交付物不再分内部调研版和外部汇报版，直接用
// 外部汇报版生成一个版本，就叫 XXX解决方案」——内部口径的章节（主要风险点）、价值
// 段落与能力边界、术语表全部退场。
//
// 变更表 #137（2026-10-08）：交付物**再加一份「<场景>建设工作方案」**（参照客户给的两份
// 建设工作方案定稿），与「<场景>解决方案」并列——两份都是客户端可读的正式交付物，
// 章节骨架完全不同，所以章节定义按口径分开（`REPORT_CHAPTERS[kind]`）。
//
// 报告 = 素材（本章块里的表）+ 构件（报告自己长出来的设计原则、架构分层、主辅职责、
// 编号连接关系、选型、价值表、实施要点与下一步）。素材是证据，构件才是报告的价值。

/** 交付物口径（变更表 #137：解决方案 + 建设工作方案，两份都是客户可读的正式交付物） */
export const REPORT_KINDS = ["solution", "construction"] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];

/**
 * 报告类型名——拼在场景名后面，就是文件名与一级标题
 *
 * 例：`智慧会议室` → `智慧会议室解决方案` / `智慧会议室建设工作方案`。
 */
export const REPORT_KIND_LABEL: Record<ReportKind, string> = {
  solution: "解决方案",
  construction: "建设工作方案",
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
  | "principles"
  /** 价值表（价值 / 现在 / 采用后 / 怎么核 四列） */
  | "value-table";

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
 * 在 Word 里增删章节编号会自动重排（变更表 #136）；Markdown 正文里也不手写「一、」。
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
  /* ── <场景>解决方案：给客户看的方案，讲清现状 / 问题 / 方案 / 价值 / 下一步 ── */
  solution: [
  {
    key: "status",
    label: "现状",
    sections: [
      { title: "场景在业务中的位置", keywords: ["位置", "定位", "在业务中"] },
      { title: "既有体系构成", keywords: ["体系", "现有", "构成"] },
      { title: "现状特征与提升空间", keywords: ["现状", "提升", "空间"], artifacts: ["table"] },
    ],
    blocks: [
      { code: "表1-1", heading: "场景锚（在讲哪个场景）" },
      { code: "表1-2", heading: "业务环节与现在的做法", cols: ["link", "owner_now", "current_tool"] },
      { code: "表2-3", heading: "系统怎么连（分层架构）", cols: ["layer", "components", "interface"] },
      { code: "表2-7", heading: "现在怎么交付与运维", cols: ["item", "status"] },
      { code: "表3-9", heading: "行业趋势", cols: ["trend", "impact"] },
    ],
  },
  {
    key: "problems",
    label: "场景与问题",
    /* 用户定稿：章下直接写「场景边界」与「典型问题」两段，不套小节标题（变更表 #129/#131） */
    sections: [
      { title: "场景边界", keywords: ["边界"], noHeading: true },
      { title: "典型问题", keywords: ["问题", "痛点"], noHeading: true },
    ],
    blocks: [
      { code: "表1-2", heading: "各环节现在的问题", cols: ["link", "pain"] },
      { code: "表3-8", heading: "今天还没被满足的需求", cols: ["gap", "who_hurts", "pain_level", "current_alternative"] },
    ],
  },
  {
    key: "solution",
    label: "方案",
    sections: [
      { title: "设计原则", keywords: ["原则"], artifacts: ["principles"] },
      { title: "总体架构", keywords: ["架构", "层次"], artifacts: ["table"] },
      { title: "主辅职责对照", keywords: ["职责", "主辅"], artifacts: ["table"] },
      { title: "连接关系与接口", keywords: ["连接", "接口"], artifacts: ["numbered-connections"] },
      { title: "选型与配置", keywords: ["选型", "配置", "组成", "清单"], artifacts: ["table"] },
      { title: "实施要点", keywords: ["实施", "要点", "部署"] },
    ],
    blocks: [
      { code: "表4-2", heading: "我方在哪些环节参与、以什么角色", cols: ["link", "can_touch", "our_role"] },
      { code: "表4-3", heading: "需求-能力对照", cols: ["gap_ref", "match", "our_product", "boundary_note"] },
      { code: "表5-1", heading: "方案架构与接口", cols: ["layer", "components", "interface", "integration", "boundary", "interface_name", "type", "protocol"] },
      { code: "表5-3", heading: "实施安排", cols: ["item", "content", "window"] },
      { code: "表5-4", heading: "交付与运维", cols: ["item", "content", "sla"] },
    ],
  },
  {
    key: "value",
    label: "价值",
    /* 用户定稿：章下直接写一张四列价值表（价值 / 现在 / 采用后 / 怎么核），无小节标题 */
    sections: [
      { title: "核心价值", keywords: ["价值", "收益"], artifacts: ["value-table"], noHeading: true },
    ],
    blocks: [
      { code: "表6-1", heading: "收益 → 指标 → 基线与预期", as: "table", cols: ["benefit", "metric", "baseline", "expected", "how_to_measure"] },
      { code: "表4-5", heading: "能力与竞争力自评", as: "table", cols: ["dimension", "weight", "score"] },
      { code: "表6-4", heading: "试点与验收", cols: ["kind", "content"] },
    ],
  },
  {
    key: "next",
    label: "下一步",
    sections: [{ title: "步骤与交付物", keywords: ["步骤", "交付物", "计划", "安排"], artifacts: ["table"] }],
    blocks: [
      { code: "表5-3", heading: "实施安排", cols: ["item", "content", "window"] },
      { code: "表5-4", heading: "交付与运维", cols: ["item", "content", "sla"] },
      { code: "表6-4", heading: "试点与验收", cols: ["kind", "content"] },
    ],
  },
  ],

  /* ── <场景>建设工作方案：给客户的"怎么建"——为什么建 / 建成什么样 / 建什么 /
       怎么建 / 什么时候谁做什么 / 怎么保障 / 与监管怎么协同（变更表 #137） ── */
  construction: [
    {
      key: "background",
      label: "建设背景与必要性",
      /* 客户定稿：章下直接写，不套 `###` 小节标题 */
      sections: [
        { title: "现场现状", keywords: ["现状", "现场", "今天"], noHeading: true },
        { title: "主要痛点", keywords: ["痛点", "问题", "卡在"], noHeading: true },
        { title: "监管与政策要求", keywords: ["监管", "政策", "合规", "要求"], noHeading: true },
        { title: "不建设的代价", keywords: ["代价", "不建", "风险"], noHeading: true },
      ],
      blocks: [
        { code: "表1-1", heading: "场景锚（在讲哪个场景）" },
        { code: "表1-2", heading: "业务环节与现在的做法", cols: ["link", "owner_now", "current_tool", "pain"] },
        { code: "表3-8", heading: "今天还没被满足的需求", cols: ["gap", "who_hurts", "pain_level", "current_alternative"] },
        { code: "表3-9", heading: "行业与监管趋势", cols: ["trend", "impact"] },
      ],
    },
    {
      key: "goals",
      label: "建设目标与思路",
      sections: [
        { title: "总体目标", keywords: ["总体目标", "总目标"] },
        { title: "分项目标", keywords: ["分项目标", "子目标", "具体目标"] },
        { title: "总体建设思路", keywords: ["思路", "路径选择", "总体考虑"] },
      ],
      blocks: [
        { code: "表3-8", heading: "要解决的需求（目标要对得上）", cols: ["gap", "who_hurts", "pain_level"] },
        { code: "表6-1", heading: "收益 → 指标 → 基线与预期", as: "table", cols: ["benefit", "metric", "baseline", "expected"] },
        { code: "表4-5", heading: "我方能力自评（哪些能自己扛）", as: "table", cols: ["dimension", "weight", "score"] },
      ],
    },
    {
      key: "content",
      label: "建设内容",
      sections: [
        { title: "总体架构", keywords: ["架构", "总体架构", "层次"], artifacts: ["table"] },
        { title: "核心功能", keywords: ["核心功能", "功能", "能力"], artifacts: ["table"] },
        { title: "状态研判与分级管控", keywords: ["研判", "分级", "管控", "预警"] },
      ],
      blocks: [
        { code: "表5-1", heading: "方案架构与接口", cols: ["layer", "components", "interface", "integration", "boundary"] },
        { code: "表4-2", heading: "我方在哪些环节参与、以什么角色", cols: ["link", "can_touch", "our_role"] },
        { code: "表4-3", heading: "需求-能力对照", cols: ["gap_ref", "match", "our_product", "boundary_note"] },
        { code: "表2-3", heading: "系统怎么连（分层架构）", cols: ["layer", "components", "interface"] },
        { code: "表6-1", heading: "收益 → 指标 → 基线与预期", as: "table", cols: ["benefit", "metric", "baseline", "expected"] },
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
        { code: "表4-2", heading: "我方在哪些环节参与、以什么角色", cols: ["link", "can_touch", "our_role"] },
      ],
    },
    {
      key: "schedule",
      label: "工作安排",
      /* 客户定稿：第 5 章章下直接就是那张里程碑计划表，不套 `###` 小节 */
      sections: [
        { title: "阶段与时间安排", keywords: ["阶段", "时间", "计划", "安排", "进度"], artifacts: ["table"], noHeading: true },
      ],
      blocks: [
        { code: "表5-3", heading: "实施安排（阶段与时间窗口）", cols: ["item", "content", "window"] },
        { code: "表6-4", heading: "试点与验收", cols: ["kind", "content"] },
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
        { code: "表4-5", heading: "我方能力自评（哪些要借外力）", as: "table", cols: ["dimension", "weight", "score"] },
        { code: "表5-4", heading: "交付与运维", cols: ["item", "content", "sla"] },
      ],
    },
    {
      key: "outlook",
      label: "监管协同展望",
      /* 章下直接写 1–2 段（参照件如此），不再套一个与章同名的小节 */
      sections: [],
      blocks: [
        { code: "表3-9", heading: "行业与监管趋势", cols: ["trend", "impact"] },
        { code: "表6-4", heading: "试点与验收", cols: ["kind", "content"] },
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
