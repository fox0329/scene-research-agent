/**
 * @scene/contract — 数据契约 v1.0
 *
 * 场景通 15 张数据表的唯一 TypeScript 类型来源。
 * 对应设计文档：`03-数据契约与API.md`
 * 变更纪律：修改须登记 docs/项目变更表.md 并升版本（规则 7）。
 *
 * v1.0 冻结范围：资料库 8 表 + 场景层 6 表 + 知识表 + 通用枚举 + API 类型
 * 阶段 3-8 的 stage_data row schema 于 M3 前补齐为 v1.1
 */

// ─── 通用枚举 ─────────────────────────────────────────────

/** 数据来源类型（G-R0 溯源铁律） */
export type SourceType = "AI提取" | "AI推断" | "用户确认" | "用户补充";

/** 来源权威性分级（G-R1） */
export type Authority = "T1" | "T2" | "T3" | "T4";

/** 证据分级（G-R2）：A=直接可验证 B=间接有据 C=架构推断 D=过度宣称 */
export type EvidenceLevel = "A" | "B" | "C" | "D";

/** 阶段编号 0-8 */
export type StageId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

// InfoTableCode 由 ./tables.js 导出并在文件末尾 re-export；此处仅作类型引用
type InfoTableCode = import("./tables.js").InfoTableCode;

/**
 * 建议三档（00b §3.3 / §4.3 / §5.3 统一口径）
 * - 建议通过：质量关全部达标或仅有不影响结论的轻微不满足项
 * - 建议有条件通过：存在需补齐的前提条件，补齐后可继续
 * - 建议不通过：存在阻止性风险，不建议继续
 */

/** 产品状态 */
export type ProductStatus = "在售" | "停售" | "在研" | "规划" | "待确认";

/** 成熟度 */
export type Maturity = "已交付" | "组件具备" | "在研" | "规划";

/** 影响程度 */
export type ImpactLevel = "高" | "中" | "低";

/** 修复状态 */
export type FixStatus = "已修复" | "修复中" | "无计划" | "硬件限制";

/** 对外可见性 */
export type Visibility = "可提" | "内部可提" | "不可提";

/** 质量关结果 */
export type GateResult = "通过" | "不通过" | "未检";

/** 用户决定动作 */
export type DecisionAction = "继续" | "补充" | "停止" | "重算";

// ─── 通用溯源字段 ──────────────────────────────────────────

/** 含溯源表共用的溯源列 */
export interface TraceableFields {
  source_type?: SourceType;
  source?: string;
  source_authority?: Authority;
  evidence_level?: EvidenceLevel;
}

// ─── stage_data 表编号常量（00b 表号，v1.1 补齐阶段 3-8） ──

/** 阶段 0 表号 */
export const STAGE0_TABLES = ["M1", "M2", "M3", "M4", "M5", "M6", "O1", "O2", "O3", "O4", "O5", "O6"] as const;
/** 阶段 1 表号 */
export const STAGE1_TABLES = ["表1-1", "表1-2", "表1-3", "表1-4", "表1-5"] as const;
/** 阶段 2 表号 */
export const STAGE2_TABLES = ["表2-1", "表2-2", "表2-3", "表2-4", "表2-5", "表2-6", "表2-7", "表2-8"] as const;
/** 阶段 3 表号 */
export const STAGE3_TABLES = ["表3-1", "表3-2", "表3-3", "表3-4", "表3-5", "表3-6", "表3-7", "表3-8", "表3-9", "表3-10"] as const;
/** 阶段 4 表号 */
export const STAGE4_TABLES = ["表4-1", "表4-2", "表4-3", "表4-4", "表4-5", "表4-6"] as const;
/** 阶段 5 表号 */
export const STAGE5_TABLES = ["表5-1", "表5-2", "表5-3", "表5-4", "表5-5", "表5-6", "表5-9"] as const;
/** 阶段 6 表号 */
export const STAGE6_TABLES = ["表6-1", "表6-2", "表6-3", "表6-4", "表6-5", "表6-6", "表6-7"] as const;
/** 阶段 7 表号 */
export const STAGE7_TABLES = ["表7-1", "表7-2", "表7-3"] as const;
/** 阶段 8 表号 */
export const STAGE8_TABLES = ["表8-内部", "表8-对外"] as const;

/** 全部表号联合类型 */
export type TableCode =
  | typeof STAGE0_TABLES[number]
  | typeof STAGE1_TABLES[number]
  | typeof STAGE2_TABLES[number]
  | typeof STAGE3_TABLES[number]
  | typeof STAGE4_TABLES[number]
  | typeof STAGE5_TABLES[number]
  | typeof STAGE6_TABLES[number]
  | typeof STAGE7_TABLES[number]
  | typeof STAGE8_TABLES[number];

// ─── 第一层 · 产品资料库（8 表） ───────────────────────────

/** 产品线 */
export interface ProductLine {
  id: string;
  name: string;
  /** 归属场景 id：NULL=通用资料库（共享），非空=该场景的专属资料库（v1.10） */
  scenario_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** 产品型号（M1，含溯源） */
export interface Product extends TraceableFields {
  id: string;
  product_line_id: string;
  model: string;
  name: string;
  status: ProductStatus;
  launch_date: string;
  former_name?: string;
  position_desc: string;
  created_at: string;
  updated_at: string;
}

/** 规格参数（M2，含溯源） */
export interface SpecParam extends TraceableFields {
  id: string;
  product_id: string;
  param_class: string;
  param_name: string;
  value: string;
  measured: "实测" | "宣称" | "未提及";
  created_at: string;
  updated_at: string;
}

/** 能力清单（M3，含溯源） */
export interface Capability extends TraceableFields {
  id: string;
  product_line_id: string;
  domain: string;
  name: string;
  description: string;
  maturity: Maturity;
  dependency: string;
  inapplicable_scene?: string;
  created_at: string;
  updated_at: string;
}

/** 边界/不做什么（M4，含溯源） */
export interface Boundary extends TraceableFields {
  id: string;
  product_line_id: string;
  /** 不做的事 */
  description: string;
  reason: string;
  has_plan: "有" | "无" | "未定";
  /** 客户要求时怎么办 */
  response: string;
  owner: string;
  plan_date?: string;
  created_at: string;
  updated_at: string;
}

/** 已知局限（M5，含溯源） */
export interface Limitation extends TraceableFields {
  id: string;
  product_line_id: string;
  product_name: string;
  description: string;
  impact: ImpactLevel;
  fix_status: FixStatus;
  external_visible: Visibility;
  owner: string;
  created_at: string;
  updated_at: string;
}

/** 成本单价（M6） */
export interface CostRate {
  id: string;
  product_line_id: string;
  category: "实施" | "商务";
  item: string;
  /** 单价（元/人天 或 元/趟 等） */
  rate: number;
  unit: string;
  standard_hours: number;
  data_source: "历史项目" | "内部报价" | "行业均值" | "待确认";
  created_at: string;
  updated_at: string;
}

/** 可选材料（O1-O6，含溯源） */
export interface OptionalMaterial extends TraceableFields {
  id: string;
  product_line_id: string;
  category: "O1认证" | "O2案例" | "O3价格" | "O4SDK" | "O5路线图" | "O6生态";
  /** JSON，结构按 category 异构 */
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ─── 第二层 · 场景分析项目（6 表） ─────────────────────────

/** 场景分析项目 */
export interface Scenario {
  id: string;
  name: string;
  /** 场景描述（分析锚，v1.11）：客户/行业、要解决的问题、目标与边界——全部阶段提示词强制围绕它 */
  description?: string | null;
  /** 场景专属资料库（product_line，v1.10 起每个场景自动带一条；引用的通用库见 scenario_linked_line） */
  product_line_id: string;
  status: "进行中" | "已完成" | "已归档";
  current_stage: StageId;
  created_at: string;
  updated_at: string;
}

/** 场景引用的通用资料库（多对多；引用不拷贝，分析时与专属库合并） */
export interface ScenarioLinkedLine {
  id: string;
  scenario_id: string;
  product_line_id: string;
  created_at: string;
  updated_at: string;
}

/** 场景级材料覆盖（不写资料库） */
export interface ScenarioMaterial extends TraceableFields {
  id: string;
  scenario_id: string;
  ref_table: string;
  ref_id: string;
  /** JSON，覆盖值 */
  override_value: Record<string, unknown>;
  reason: string;
  created_at: string;
  updated_at: string;
}

/** 阶段数据（行式存储，55 张表共用） */
export interface StageData extends TraceableFields {
  id: string;
  scenario_id: string;
  stage: StageId;
  /**
   * 表编号（旧 00b 编号 ∪ 新信息表注册表编号）
   *
   * v1.4 起表定义以 `tables.ts` 注册表为唯一事实源（含「可选材料」等新表号），
   * 旧 `TableCode` 联合类型待 P3-d 迁移完成后删除。
   */
  table_code: TableCode | InfoTableCode;
  /** JSON，结构由该表 schema 定义（v1.1 补齐阶段 3-8） */
  row: Record<string, unknown>;
  /** 资料失效标记（产品定义 §4.1 失效语义） */
  is_stale: boolean;
  created_at: string;
  updated_at: string;
}

/** 会话（与 DSH session 一一映射） */
export interface Conversation {
  id: string;
  scenario_id: string;
  title: string;
  status: "活跃" | "已归档";
  dsh_session_id: string;
  created_at: string;
  updated_at: string;
}

/** 消息 */
export interface Message {
  id: string;
  conversation_id: string;
  role: "用户" | "系统";
  content: string;
  stage?: StageId;
  /** 引用表格行，格式 "table_code:row_id" */
  table_ref?: string;
  created_at: string;
}

/** 质量关检查记录 */
export interface QualityGate {
  id: string;
  scenario_id: string;
  stage: StageId;
  item_no: string;
  title: string;
  result: GateResult;
  detail: string;
  /** JSON，抽查采样记录 */
  evidence_refs: Record<string, unknown>;
  checked_at: string;
}

// ─── 第三层 · 知识库（1 表） ────────────────────────────────

/** 知识库条目 */
export interface Knowledge {
  id: string;
  product_line_id?: string;
  scene?: string;
  category: "竞品" | "需求" | "趋势" | "成本";
  content: string;
  source: string;
  source_authority: Authority;
  from_scenario_id: string;
  created_at: string;
}

// ─── API 请求/响应类型（03-数据契约与API.md §三） ─────────

/** 统一错误响应 */
export interface ApiError {
  code: string;
  message: string;
  detail?: string;
}

/** 产品线创建请求 */
export interface CreateProductLineRequest {
  name: string;
}

/** 场景创建请求 */
export interface CreateScenarioRequest {
  name: string;
  product_line_id: string;
}

/** 场景级覆盖创建请求 */
export interface CreateScenarioMaterialRequest {
  ref_table: string;
  ref_id: string;
  override_value: Record<string, unknown>;
  reason: string;
}

/** 单元格编辑请求 */
export interface EditCellRequest {
  cell: string;
  value: unknown;
}

/** 用户决定请求 */
export interface DecideRequest {
  action: DecisionAction;
}

/** SSE 事件类型 */
export type SseEventType =
  | "text"
  | "tool_call"
  | "progress"
  | "row"
  | "completeness"
  | "summary"
  | "done"
  | "error";

/** SSE follow 事件 */
export interface FollowEvent {
  type: SseEventType;
  [key: string]: unknown;
}

/** DSH 会话句柄 */
export interface SessionHandle {
  sessionId: string;
}

/** DSH 客户端接口（技术方案 §5.3，冻结后不可变） */
export interface DshClient {
  createSession(opts: {
    title: string;
    preset?: string;
  }): Promise<SessionHandle>;
  prompt(
    h: SessionHandle,
    input: {
      system: string;
      user: string;
      outputContract: Record<string, unknown>;
    },
  ): AsyncIterable<FollowEvent>;
  cancel(h: SessionHandle): Promise<void>;
}

/** 系统状态响应 */
export interface SystemStatus {
  dsh: "ok" | "error";
  dsh_port: number;
  db: "ok" | "error";
}

/** 模型配置 */
export interface ModelConfig {
  provider: string;
  default_model: string;
  analysis_model: string;
}

/**
 * 交付物生成输入（md-export 使用）
 *
 * v1.4 起：交付物由**阶段总结文档 + 表数据**装配，不再有手写章节与「结论」。
 * 旧 `ExportData`（含 libraryData / qualityGates）已废弃——判断类产出整体移除。
 */
export interface DeliverableInput {
  scenario: Scenario;
  /** 各阶段总结文档（内部报告正文；阶段 0-6） */
  stageSummaries: readonly { stage: number; title: string; markdown: string }[];
  /** 全部阶段数据行（内部报告附录 + 对外材料章节 ← 表映射） */
  stageData: StageData[];
  /** 生成日期（可注入，便于测试） */
  generatedAt?: string;
}

/** 导出响应 */
export interface ExportResult {
  internal_report: string;
  external_report: string;
}
// ─── 表定义注册表（单一事实源；实现迁移期间与旧常量并存） ──────
// 依据 04-业务过程重定义.md v1.4 + 05-表格定义总表.md v0.7
// 旧常量（StageId / STAGE*_TABLES / TableCode / AdviceLevel 等）标记为待迁移，见 06 §十六
export * from "./tables.js";

// ─── 场景诉求（第一输入）与场景锚（表1-1） ────────────────────
// 依据 04-业务过程重定义.md v1.4：§3.0 输入：场景诉求；§3.0.4 场景锚最终是一个表格

/**
 * 场景诉求（项目元信息，不属于 34 张信息表）
 *
 * 它是**本产品的第一输入**，也是确认机制的**对照基准**：
 * 系统理解的场景（表1-1）必须与它对齐；`raw_text` 保留用户原始输入，
 * **系统不得改写**（改了就失去基准意义）。
 */
export interface ScenarioBrief {
  scenario_id: string;
  /** 场景名称 */
  scene_name: string;
  /** 一句话：你想搞清楚什么（必填，用户诉求的最小完整表达） */
  intent: string;
  /** 客户/行业线索 */
  customer_hint?: string | null;
  /** 地域/客户名线索 */
  region_hint?: string | null;
  /** 想覆盖的范围线索 */
  scope_hint?: string | null;
  /** 用途：自研判断 / 给领导看 / 给客户看 */
  audience?: string | null;
  /** 时间要求 */
  deadline?: string | null;
  /** 用户原始输入原文（对照基准，不可改写） */
  raw_text: string;
  created_at: string;
  updated_at: string;
}

/** 场景锚（表1-1）的行形态：项 / 内容 */
export interface AnchorRow {
  /** 项名（与表1-1 固定行的 label 对应） */
  item: string;
  /** 内容 */
  content: string;
  /** 来源 */
  source?: string | null;
  /** 数据来源标记（AI提取 / AI推断 / 用户确认 / 用户补充） */
  source_type?: SourceType | null;
  /** 确认状态（显式覆盖时使用） */
  confirm_state?: string | null;
}

/** 场景锚的表号 */
export const ANCHOR_TABLE_CODE = "表1-1";
/** 场景锚所属阶段 */
export const ANCHOR_STAGE: StageId = 1;

// ─── 阶段总结文档（每阶段一份，右栏显示、可导出；见 04 §五） ──────

/** 阶段总结文档行（一场景一阶段一份） */
export interface StageSummaryRow {
  scenario_id: string;
  stage: StageId;
  /** Markdown 正文（六段骨架，不含建议与判断） */
  content: string;
  created_at: string;
  updated_at: string;
}
