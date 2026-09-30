/**
 * @scene/contract — 表定义注册表（单一事实源）
 *
 * 本文件是 34 张信息表的**唯一事实源**：表号、名称、阶段、级别、行粒度、列定义、
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
export type InfoStageId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

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
  barrier_status: ["过得了", "过不了", "绕道", "借道", "等窗口", "不知道"],
  strategy: ["直接进入", "找替代路径", "找合作伙伴", "不进入", "等政策变化", "列为调研重点"],
  can_touch: ["可以碰", "只能配合", "不能碰"],
  our_role: ["替代", "辅助", "外围", "不参与"],
  match: ["真能解", "需补齐", "不能做"],
  level_hml: ["高", "中", "低"],
  optional_category: ["O1认证", "O2案例", "O3价格与授权", "O4开发资料", "O5路线图", "O6交付与生态"],
  element_type: ["硬件", "软件", "服务"],
  is_digital: ["可以联网采集", "必须物理隔离", "不含电子部分"],
  competition: ["高", "中", "低", "未知"],
  has_plan: ["有", "无", "未定"],
  fix_status: ["已修复", "修复中", "无计划", "硬件限制"],
  visibility: ["可提", "内部可提", "不可提"],
  position: ["扩张", "稳定", "收缩"],
  evidence_level: ["A", "B", "C", "D"],
  authority: ["T1", "T2", "T3", "T4"],
  verified: ["已确认", "未确认"],
  in_contract: ["是", "否", "待定"],
  asset_target: ["产品路线图", "能力底账", "新发现的限制", "销售打法"],
  pilot_kind: ["试点范围", "试点时长", "成功判据", "风险", "验收口径", "合同条款"],
  rate_category: ["实施", "商务"],
  source_type: ["AI提取", "AI推断", "用户确认", "用户补充"],
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
  /** 所属块（同一张表内多子块时使用，如成本估算的四个子块） */
  block?: string;
  /** 说明（供提示词与 tooltip） */
  note?: string;
}

/** 表内固定行（用于「项 / 内容」纵向呈现的单例表，如表1-1 场景概述） */
export interface FixedRow {
  key: string;
  label: string;
  required?: boolean;
  /** 是否属于必须由用户确认的 L1 项（见 04 §4.7） */
  confirmRequired?: boolean;
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
  /** 跨阶段填写：列分属多个阶段，回退时按列清除 */
  filledInStages?: readonly InfoStageId[];
  /** 是否常驻中栏顶部（表1-1 = 场景锚） */
  pinned?: boolean;
  /** 动态 payload（可选材料：1 张表 6 种 payload，按 category 切换） */
  payloads?: Readonly<Record<string, readonly TableColumn[]>>;
  /** 完整度规则（可机器判定） */
  completeness: readonly string[];
  /** 被哪些阶段引用 */
  consumedBy?: readonly InfoStageId[];
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

export interface StageDef {
  id: InfoStageId;
  /** 阶段名 */
  name: string;
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
    goal: "我方有哪些产品、能力、边界、限制、费率；有哪些认证/案例/价格/资料/路线图/生态",
    tableCodes: ["M1", "M2", "M3", "M4", "M5", "M6", "可选材料"],
    summaryTitle: "① 材料入库总结",
  },
  {
    id: 1,
    name: "认识场景（含门槛与合规）",
    goal: "场景是什么、由哪些业务环节组成、每环节能否参与、有哪些要素、系统怎么连、有哪些硬约束与门槛、认证现状、现有交付运维方式",
    tableCodes: ["表1-1", "表1-2", "表1-3", "表2-2", "表2-3", "表2-4", "表2-5", "表2-7"],
    summaryTitle: "② 场景认识总结",
  },
  {
    id: 2,
    name: "理解商业",
    goal: "钱怎么分、有哪些方案形态、客户怎么买、对手位势、替代方案与价格、别人踩过的坑、没被满足的需求、行业趋势",
    tableCodes: ["表3-1", "表3-2", "表3-3", "表3-4", "表3-6", "表3-7", "表3-8", "表3-9"],
    summaryTitle: "③ 商业格局总结",
  },
  {
    id: 3,
    name: "能力匹配",
    goal: "我方能力底账、客户每条需求能否满足、细分优先级、竞争力评分",
    tableCodes: ["表4-1", "表4-3", "表4-4", "表4-5"],
    summaryTitle: "④ 能力匹配总结",
  },
  {
    id: 4,
    name: "方案与实现",
    goal: "方案架构与接口、边界声明、约束满足路径、实施计划、交付运维与 SLA、成本构成",
    tableCodes: ["表5-1", "表5-3", "表5-4", "表5-5"],
    summaryTitle: "⑤ 方案与成本总结",
  },
  {
    id: 5,
    name: "价值与验证",
    goal: "收益对应指标、怎么测、基线、预期改善、用户感受、投入产出、试点设计与验收口径",
    tableCodes: ["表6-1", "表6-4"],
    summaryTitle: "⑥ 价值与验证总结",
  },
  {
    id: 6,
    name: "总结沉淀",
    goal: "哪些结论应回写成资产（产品路线图 / 能力底账 / 新发现的限制 / 销售打法）",
    tableCodes: ["表7-1"],
    summaryTitle: "⑦ 沉淀总结",
  },
  {
    id: 7,
    name: "最终交付物",
    goal: "内部调研报告 + 对外汇报材料（文档产出，非表）",
    tableCodes: [],
    summaryTitle: "⑧ 交付说明",
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
  { key: "gaps", title: "五、信息缺口与待补充", brief: "还缺什么、补什么最有价值（表 / 列 / 类别 / 行）" },
  { key: "links", title: "六、上下游衔接", brief: "上游依据哪些表、下游引用哪些表" },
];

/** 阶段总结文档必须**不含**的内容（避免退化成决策文档） */
export const SUMMARY_DOC_FORBIDDEN: readonly string[] = [
  "任何建议、判断、结论性评价（进/不进、能做/不能做、值不值）",
  "建议档位与通过/不通过",
];

// ─── 阶段 0 · 材料解析与入库（7 张） ────────────────────────

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
    code: "M6",
    name: "内部费率",
    stage: 0,
    tier: "支撑",
    rowUnit: "一个费率项目",
    purpose: "成本单价的唯一来源",
    columns: [
      mid("category", "类别", { required: true, enum: "rate_category" }),
      mid("item", "项目", { required: true }),
      mid("rate", "单价", { required: true, type: "number" }),
      mid("unit", "单位", { required: true }),
      mid("standard_hours", "标准工时参考", { required: true, type: "number" }),
      sup("note", "说明"),
      sup("source", "出处", { required: true }),
    ],
    completeness: ["rate/standard_hours 为数值", "source 非空；『待确认』行不得用于报价"],
    consumedBy: [4],
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
    purpose: "场景锚——全链唯一场景定义，用户必须逐格确认",
    columns: [
      mid("item", "项", { required: true }),
      mid("content", "内容", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
    ],
    fixedRows: [
      { key: "scene_name", label: "场景名称", required: true },
      { key: "customer_type", label: "客户类型/行业", required: true, confirmRequired: true },
      { key: "scope_in", label: "覆盖什么", required: true, confirmRequired: true },
      { key: "scope_out", label: "明确不含什么", required: true, confirmRequired: true },
      { key: "buyer_type", label: "买方类型", required: true },
      { key: "decision_maker", label: "拍板者" },
      { key: "user_role", label: "使用者" },
      { key: "payer", label: "付费者" },
      { key: "core_process", label: "核心业务流程", required: true },
      { key: "use_case", label: "核心用途", required: true, confirmRequired: true },
      { key: "entry_point", label: "切入点", required: true, confirmRequired: true },
      { key: "value_proposition", label: "价值主张", required: true, confirmRequired: true },
    ],
    completeness: ["8 个必填行非空", "『未提供』≥2 行则退回场景梳理", "L1 六项须用户确认"],
    consumedBy: [2, 3, 4, 5, 6, 7],
  },
  {
    code: "表1-2",
    name: "场景环节地图",
    stage: 1,
    tier: "重要",
    rowUnit: "一个业务环节",
    purpose: "铺开场景的全部业务环节，标出每个环节能不能碰、我方以什么角色参与",
    columns: [
      mid("link", "业务环节", { required: true }),
      mid("is_digital", "有无电子部分", { required: true, enum: "is_digital" }),
      mid("can_touch", "我方可参与程度", { required: true, enum: "can_touch" }),
      mid("our_role", "我方角色", { required: true, enum: "our_role" }),
      mid("description", "环节说明", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      sup("responsibility", "责任归属", { required: true }),
      sup("reason", "依据", { required: true, type: "longText" }),
      sup("role_reason", "角色判定依据", { required: true, type: "longText" }),
      sup("source", "来源", { required: true }),
      sup("evidence_level", "证据等级", { required: true, enum: "evidence_level" }),
      sup("authority", "来源权威性", { required: true, enum: "authority" }),
    ],
    completeness: ["业务环节 ≥3 个", "每环节 can_touch 与 our_role 非空且取值合法", "依据可回溯 M4 或法规"],
    consumedBy: [3, 4, 7],
  },
  {
    code: "表1-3",
    name: "门槛与合规",
    stage: 1,
    tier: "重要",
    rowUnit: "一道门槛（一票否决者类为一个角色；认证类为一项认证要求）",
    purpose: "五类门槛 + 认证现状 + 处置策略三合一",
    columns: [
      mid("barrier_type", "门槛类型", { required: true, enum: "barrier_type" }),
      mid("barrier_name", "门槛", { required: true }),
      mid("veto_holder", "否决者", { requiredWhen: "生态锁定类除外" }),
      mid("criteria", "判据", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("current_status", "现状", { required: true, enum: "barrier_status" }),
      mid("judgment", "判定", { required: true, enum: "barrier_status" }),
      sup("evidence", "证据", { required: true }),
      sup("held_certs", "已持有认证", { requiredWhen: "认证类必填" }),
      sup("cert_gap", "认证差距", { requiredWhen: "认证类必填" }),
      sup("cert_mitigation", "认证弥补措施"),
      sup("strategy", "处置策略", { enum: "strategy" }),
      sup("action_items", "行动项"),
      sup("owner", "负责人"),
      sup("timeline", "时间线"),
      sup("source", "来源", { required: true }),
      sup("evidence_level", "证据等级", { required: true, enum: "evidence_level" }),
      sup("authority", "来源权威性", { required: true, enum: "authority" }),
    ],
    completeness: [
      "五类门槛各 ≥1 行",
      "criteria 含具体等级/标准号/数值（禁『较高』『相关』）",
      "过不了/不知道行必须有 strategy 与 action_items",
    ],
    consumedBy: [4, 7],
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
    name: "分层架构表",
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
    consumedBy: [4],
  },
  {
    code: "表2-4",
    name: "要素间关系表",
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
    consumedBy: [4],
  },
  {
    code: "表2-5",
    name: "物理与合规约束",
    stage: 1,
    tier: "支撑",
    rowUnit: "一个约束项",
    purpose: "硬约束 + 我方如何满足（要求与响应同行）",
    filledInStages: [1, 4],
    columns: [
      mid("constraint_item", "约束项", { required: true }),
      mid("required_value", "具体要求值", { required: true }),
      mid("standard_no", "适用标准号"),
      mid("compliance_path", "实现路径", { note: "阶段 4 补填" }),
      mid("owner", "责任人", { note: "阶段 4 补填" }),
      sup("period", "周期"),
      sup("status", "状态"),
      sup("source", "出处", { required: true }),
      sup("evidence_level", "证据等级", { required: true, enum: "evidence_level" }),
      sup("authority", "来源权威性", { required: true, enum: "authority" }),
    ],
    completeness: ["constraint_item/required_value 非空且为具体数值或等级", "约束类须 T1", "进入阶段 4 后 compliance_path/owner 不得为空"],
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
    consumedBy: [7],
  },
  {
    code: "表3-2",
    name: "主流方案形态",
    stage: 2,
    tier: "重要",
    rowUnit: "一种方案形态",
    purpose: "市面有几种打法、哪种在扩张，我方切入点在哪",
    columns: [
      mid("form", "方案形态", { required: true }),
      mid("key_points", "要点", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("leader", "主导者", { required: true }),
      mid("position", "当前地位", { required: true, enum: "position" }),
      mid("our_entry", "我方切入点", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      sup("form_no", "形态编号"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["≥3 种形态", "form/key_points/leader/our_entry 非空"],
    consumedBy: [7],
  },
  {
    code: "表3-3",
    name: "购买路径与采购机制",
    stage: 2,
    tier: "支撑",
    rowUnit: "一类客户",
    purpose: "客户怎么买、钱从哪出、决策多久、怎么撬动",
    columns: [
      mid("customer_type", "客户类型", { required: true }),
      mid("default_choice", "默认选择", { required: true }),
      mid("budget_item", "预算科目", { required: true }),
      mid("procurement_method", "采购方式"),
      mid("decision_cycle", "决策周期"),
      sup("decision_basis", "决策依据"),
      sup("in_path", "我方是否在路径中"),
      sup("leverage", "需撬动什么"),
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
    rowUnit: "一个对照维度（固定 4 列：我方 + 竞品 A/B/C）",
    purpose: "我方位势——关键维度上有没有优势",
    columns: [
      mid("dimension", "对照维度", { required: true }),
      mid("our", "我方", { required: true }),
      mid("competitor_a", "竞品 A"),
      mid("competitor_b", "竞品 B"),
      mid("competitor_c", "竞品 C"),
      sup("source", "来源", { required: true }),
      sup("evidence_level", "证据等级", { required: true, enum: "evidence_level" }),
      sup("authority", "来源权威性", { required: true, enum: "authority" }),
    ],
    completeness: ["竞品 ≥3 家（A/B/C 均填）", "维度 ≥3 个", "竞品取值须有来源"],
    consumedBy: [3],
  },
  {
    code: "表3-6",
    name: "替代方案与价格对照",
    stage: 2,
    tier: "重要",
    rowUnit: "一个可对照方案（末行必须是我方方案）",
    purpose: "客户的可选项 + 我方价格位置",
    filledInStages: [2, 4],
    columns: [
      mid("alternative", "替代方案", { required: true, note: "必须含『什么都不做』" }),
      mid("customer_gets", "客户得到什么", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("cost_structure", "成本结构", { required: true }),
      mid("unit_cost", "单位成本", { required: true, type: "number" }),
      mid("our_advantage", "我方优势", { type: "longText", truncate: TRUNCATE_DEFAULT }),
      sup("no", "编号"),
      sup("our_weakness", "我方劣势"),
      sup("implication", "对我方意味着什么", { required: true, type: "longText" }),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["≥2 个对照方案 + 我方方案行", "alternative/customer_gets/cost_structure/unit_cost 非空", "成本须有来源或标『估算』"],
    consumedBy: [4, 7],
  },
  {
    code: "表3-7",
    name: "失败反模式",
    stage: 2,
    tier: "支撑",
    rowUnit: "一个失败原因",
    purpose: "别人踩过的坑，供方案设计规避",
    columns: [
      mid("failure_reason", "失败原因", { required: true }),
      mid("root_cause", "根因", { type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("design_implication", "对方案设计的含义", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      sup("no", "编号"),
      sup("symptom", "表现"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["≥2 条", "failure_reason/design_implication 非空", "每条有来源"],
    consumedBy: [4],
  },
  {
    code: "表3-8",
    name: "没被满足的需求",
    stage: 2,
    tier: "重要",
    rowUnit: "一个需求缺口",
    purpose: "『值得打的位置』的唯一来源 + 痛点排序",
    filledInStages: [2, 3],
    columns: [
      mid("rank", "排序", { note: "阶段 3 补填" }),
      mid("gap", "缺口描述", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("who_hurts", "谁在痛", { required: true }),
      mid("pain_level", "痛到什么程度", { required: true, enum: "level_hml" }),
      mid("current_alternative", "现有替代方案", { type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("cross_validation", "多源验证", { note: "阶段 3 补填" }),
      sup("why_unsatisfied", "为什么不满意", { required: true, type: "longText" }),
      sup("budget_item", "对应预算科目", { note: "阶段 3 补填" }),
      sup("gap_source", "缺口来源"),
      sup("source", "来源", { required: true }),
      sup("evidence_level", "证据等级", { required: true, enum: "evidence_level" }),
      sup("authority", "来源权威性", { required: true, enum: "authority" }),
    ],
    completeness: ["≥3 条", "gap/who_hurts/pain_level/why_unsatisfied 非空", "每行有来源", "阶段 3 后 rank/多源验证/预算科目非空且多源 ≥2 独立来源"],
    consumedBy: [3, 7],
  },
  {
    code: "表3-9",
    name: "行业趋势",
    stage: 2,
    tier: "过程",
    rowUnit: "一条趋势",
    purpose: "变化方向与时间窗口（时机判断）",
    columns: [
      mid("trend", "趋势", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("driver", "驱动力", { required: true }),
      mid("implication", "对我方含义", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("window", "时间窗口", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      sup("no", "编号"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["趋势/对我方含义 非空", "时间窗口须为具体时间段"],
    consumedBy: [7],
  },
];

// ─── 阶段 3 · 能力匹配（4 张） ──────────────────────────────

const TABLES_STAGE_3: readonly TableDef[] = [
  {
    code: "表4-1",
    name: "能力底账",
    stage: 3,
    tier: "重要",
    rowUnit: "一个能力项",
    purpose: "成熟度与证明材料",
    columns: [
      mid("ability", "能力项", { required: true }),
      mid("maturity", "成熟度", { required: true, enum: "maturity" }),
      mid("proof", "证明材料", { required: true }),
      mid("limitation", "限制条件", { type: "longText", truncate: TRUNCATE_DEFAULT }),
      sup("no", "编号"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["ability/maturity/proof 非空", "已交付行须有案例或验收数据"],
    consumedBy: [7],
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
    consumedBy: [7],
  },
  {
    code: "表4-4",
    name: "细分优先级",
    stage: 3,
    tier: "重要",
    rowUnit: "一个细分场景",
    purpose: "先打哪个细分",
    columns: [
      mid("sub_scene", "细分场景", { required: true }),
      mid("value_density", "价值密度", { required: true }),
      mid("fit", "我方契合度", { required: true }),
      mid("difficulty", "进入难度", { required: true }),
      mid("stock_maturity", "存量成熟度", { required: true }),
      mid("rank", "综合排序", { required: true }),
      sup("strategy", "策略"),
      sup("source", "来源", { required: true }),
    ],
    completeness: ["≥2 个细分场景", "四维度非空", "必须给出排名第一的结论"],
    consumedBy: [7],
  },
  {
    code: "表4-5",
    name: "竞争力判断",
    stage: 3,
    tier: "重要",
    rowUnit: "一个评分维度（末行总分）",
    purpose: "赢面评分与依据",
    columns: [
      mid("dimension", "维度", { required: true }),
      mid("weight", "权重", { required: true, type: "number" }),
      mid("score", "评分(1-5)", { required: true, type: "number" }),
      mid("basis", "打分依据", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      sup("source", "来源"),
    ],
    completeness: ["维度 ≥4 个", "权重之和 = 100%", "总分 = Σ(权重 × 评分)"],
    consumedBy: [7],
  },
];

// ─── 阶段 4 · 方案与实现（4 张） ────────────────────────────

const TABLES_STAGE_4: readonly TableDef[] = [
  {
    code: "表5-1",
    name: "方案架构与接口",
    stage: 4,
    tier: "重要",
    rowUnit: "架构块 = 一个层级；接口块 = 一个接口",
    purpose: "方案全貌 + 边界声明 + 接口清单与适配工作量",
    columns: [
      mid("layer", "层", { required: true, block: "架构" }),
      mid("components", "组件/设备", { required: true, block: "架构" }),
      mid("interface", "接口/协议", { required: true, block: "架构" }),
      mid("integration", "与既有系统对接方式", { required: true, block: "架构" }),
      mid("boundary", "边界声明（不做什么）", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT, block: "架构" }),
      mid("interface_name", "接口名称", { required: true, block: "接口" }),
      mid("type", "类型", { required: true, block: "接口" }),
      mid("protocol", "协议/方式", { required: true, block: "接口" }),
      mid("effort", "适配工作量", { required: true, block: "接口" }),
      sup("source", "出处", { required: true }),
    ],
    completeness: ["架构块五项非空", "接口块四项非空且接口 ≥1 条", "boundary 不得为空"],
    consumedBy: [7],
  },
  {
    code: "表5-3",
    name: "实施计划",
    stage: 4,
    tier: "重要",
    rowUnit: "一个实施项",
    purpose: "落地路径与前置条件（人天进成本）",
    columns: [
      mid("item", "项", { required: true }),
      mid("content", "内容", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("window", "窗口", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("man_days", "人天", { required: true, type: "number" }),
      mid("rollback", "回退", { required: true }),
      sup("env_prep", "环境准备"),
      sup("source", "出处"),
    ],
    completeness: ["六项必填非空", "man_days 为数值（与表5-5 人工成本对应）", "依赖不可控条件的项须显式标注"],
    consumedBy: [7],
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
    consumedBy: [7],
  },
  {
    code: "表5-5",
    name: "成本估算",
    stage: 4,
    tier: "重要",
    rowUnit: "一个成本项（硬件/人工/运营/汇总四个子块）",
    purpose: "报价的唯一来源（硬件 + 人工 + 运营）",
    columns: [
      mid("item", "项目", { required: true, block: "硬件" }),
      mid("spec", "型号/规格", { required: true, block: "硬件" }),
      mid("qty", "数量", { required: true, type: "number", block: "硬件" }),
      mid("unit_price", "单价(元)", { required: true, type: "number", block: "硬件" }),
      mid("subtotal", "小计(元)", { required: true, type: "number", block: "硬件" }),
      mid("item", "项", { required: true, block: "人工" }),
      mid("hours", "工时", { required: true, type: "number", block: "人工" }),
      mid("day_rate", "人天单价(元)", { required: true, type: "number", block: "人工" }),
      mid("cost", "费用(元)", { required: true, type: "number", block: "人工" }),
      mid("item", "项", { required: true, block: "运营" }),
      mid("annual_fee", "年费(元)", { required: true, type: "number", block: "运营" }),
      mid("note", "说明", { block: "运营" }),
      mid("item", "项", { required: true, block: "汇总" }),
      mid("amount", "金额(元)", { required: true, type: "number", block: "汇总" }),
      sup("source", "出处", { required: true }),
    ],
    completeness: ["三类成本齐全", "单价可回溯 M6 或标来源", "小计 = 数量 × 单价", "汇总 = 各子块之和"],
    consumedBy: [5, 7],
  },
];

// ─── 阶段 5 · 价值与验证（2 张 + 1 张计算卡片） ─────────────

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
      mid("baseline", "基线", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
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
    consumedBy: [7],
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
      mid("verified_by_buyer", "买方是否确认", { enum: "verified", requiredWhen: "仅『成功判据』类必填" }),
      mid("in_contract", "写进合同", { enum: "in_contract", requiredWhen: "仅『验收口径/合同条款』类必填" }),
      sup("source", "来源"),
    ],
    completeness: ["kind 覆盖『成功判据』与『验收口径』两类", "条件必填项在该类下非空"],
    consumedBy: [7],
  },
];

// ─── 阶段 6 · 总结沉淀（1 张） ──────────────────────────────

const TABLES_STAGE_6: readonly TableDef[] = [
  {
    code: "表7-1",
    name: "资产回写清单",
    stage: 6,
    tier: "过程",
    rowUnit: "一条回写项",
    purpose: "结论变资产（路线图 / 能力底账 / 限制 / 销售打法）",
    columns: [
      mid("target", "目标资产", { required: true, enum: "asset_target" }),
      mid("content", "回写内容", { required: true, type: "longText", truncate: TRUNCATE_DEFAULT }),
      mid("priority", "优先级"),
      mid("status", "状态"),
      sup("basis", "依据", { required: true, note: "须可回溯到某阶段的信息表" }),
      sup("field_patch", "结构化补丁"),
      sup("source", "来源"),
    ],
    completeness: ["target/content/basis 非空", "basis 必须可回溯到某阶段信息表"],
  },
];

// ─── 34 张表总表 ───────────────────────────────────────────

export const TABLES: readonly TableDef[] = [
  ...TABLES_STAGE_0,
  ...TABLES_STAGE_1,
  ...TABLES_STAGE_2,
  ...TABLES_STAGE_3,
  ...TABLES_STAGE_4,
  ...TABLES_STAGE_5,
  ...TABLES_STAGE_6,
];

export const TABLES_BY_CODE: Readonly<Record<string, TableDef>> = Object.fromEntries(
  TABLES.map((t) => [t.code, t]),
);

// ─── 计算卡片（派生值，不是表） ────────────────────────────

export interface ComputedCardDef {
  key: string;
  name: string;
  stage: InfoStageId;
  /** 计算口径 */
  formula: string;
  /** 输入来源 */
  inputs: readonly string[];
  fields: readonly string[];
  /** 不得让模型「填」的理由 */
  reason: string;
}

export const COMPUTED_CARDS: readonly ComputedCardDef[] = [
  {
    key: "roi",
    name: "投资回报",
    stage: 5,
    formula: "回收期 = 投入 ÷ 年收益",
    inputs: ["表5-5", "表6-1"],
    fields: ["总投资", "总收益", "投资回报率", "回收期", "证据级"],
    reason: "派生值若让模型填，必然与表5-5/表6-1 不一致",
  },
];

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

/** 按块分组的中栏列（用于成本估算、方案架构等多子块表） */
export function middleColumnsByBlock(t: TableDef): Readonly<Record<string, readonly TableColumn[]>> {
  const out: Record<string, TableColumn[]> = {};
  for (const c of middleColumns(t)) {
    const b = c.block ?? "";
    (out[b] ??= []).push(c);
  }
  return out;
}

/** 取阶段定义 */
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

/** 跨阶段填写的表（回退时按列清除） */
export function crossStageTables(): readonly TableDef[] {
  return TABLES.filter((t) => (t.filledInStages?.length ?? 0) > 1);
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
 * 多子块表（成本估算、方案架构）与 payload 表（可选材料）不能把各块列数相加，
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

  // 表数
  if (TABLES.length !== 34) issues.push(`表数应为 34，实际 ${TABLES.length}`);

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

  // 阶段 7 无表
  if (tablesOfStage(7).length !== 0) issues.push("阶段 7 不应有信息表（交付物是文档）");

  return issues;
}

