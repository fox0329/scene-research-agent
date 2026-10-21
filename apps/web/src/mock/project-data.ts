import { STAGE_DEFS } from "@scene/contract";

/**
 * Mock 数据 — 项目工作台（T2.3）
 * 首版硬编码，后续按 03-数据契约与API.md 接真实 API
 */

/* ═══ 阶段定义（现行 8 阶段 0–7；取自契约 STAGE_DEFS，不是 00b 的旧 9 阶段）═══ */

export type StageDef = {
  index: number;
  label: string;
}

export const STAGES: StageDef[] = STAGE_DEFS.map((s) => ({
  index: s.id,
  label: s.name,
}));

/* ═══ 项目与会话 ═══ */

export type Conversation = {
  id: string;
  name: string;
}

export type ProjectStatus = "active" | "done";

export type Project = {
  id: string;
  name: string;
  status: ProjectStatus;
  /** 当前所处阶段 0-8（数据落库口径；用户看到的推进单位是流程步） */
  stage: number;
  productLine: string;
  /** 场景描述（分析锚 v1.11） */
  description?: string;
  /**
   * 本场景私有库 id（v3.0，变更表 #160：按需创建、可删）
   *
   * null/undefined = 本场景还没有私有库（第一次上传材料时才建）；`productLine` 是它的名字。
   */
  own_line_id?: string | null;
  /**
   * 流程进度（v1.5：左栏显示「第 n/8 步」）
   *
   * 可选：后端旧版本或演示数据没有该字段 → 不显示进度（不做本地猜测）。
   */
  flow?: {
    currentStep: number;
    completedCount: number;
    finished: boolean;
  };
  conversations: Conversation[];
}

export const projects: Project[] = [
  {
    id: "p1",
    name: "智慧会议室",
    status: "active",
    stage: 2,
    productLine: "感知与控制产品线",
    conversations: [
      { id: "p1c1", name: "补充 M4 边界与限制" },
      { id: "p1c2", name: "阶段 2 质量关检查" },
      { id: "p1c3", name: "上传产品白皮书并解析" },
      { id: "p1c4", name: "阶段 1 门槛筛查" },
    ],
  },
  {
    id: "p2",
    name: "工业设备预测性维护",
    status: "active",
    stage: 4,
    productLine: "IoT 产品线",
    conversations: [
      { id: "p2c1", name: "匹配矩阵分析" },
      { id: "p2c2", name: "商业分析：利润池" },
      { id: "p2c3", name: "门槛筛查：一票否决排查" },
      { id: "p2c4", name: "上传 IoT 产品资料" },
    ],
  },
  {
    id: "p3",
    name: "智慧园区",
    status: "done",
    stage: 5, // 交付物（2026-10-20 价值验证阶段删除后，交付物为阶段 5）
    productLine: "综合解决方案",
    conversations: [
      { id: "p3c1", name: "生成交付物" },
      { id: "p3c3", name: "方案与成本分析" },
    ],
  },
];

/* ═══ 通用枚举 ═══ */

/** 来源标记：AI 提取 / 用户确认 / 架构推断（G-R0/G-R5） */
export type SourceTag = "AI" | "用户" | "推断";

/** 检查评级：pass 通过 / warn 提醒 / fail 不通过 */
export type CheckRating = "pass" | "warn" | "fail";

/* ═══ 阶段 0：材料入库 ═══ */

/** 完成度检查：不阻断，仅记录缺失风险（00b §2.4） */
export type Stage0Check = {
  index: number;
  item: string;
  rating: CheckRating;
  statusLabel: string;
  risk: string;
}

export const stage0Checks: Stage0Check[] = [
  { index: 1, item: "M1 产品清单已填写", rating: "pass", statusLabel: "3 型号",   risk: "—" },
  { index: 2, item: "M2 规格书已填写",   rating: "pass", statusLabel: "4 参数类", risk: "—" },
  { index: 3, item: "M3 能力清单已填写", rating: "pass", statusLabel: "18 项",    risk: "—" },
  { index: 4, item: "M4 边界与限制（不做）已填写", rating: "fail", statusLabel: "空白",     risk: "阶段 1 门槛判据缺失，阶段 4 边界只能推断" },
  { index: 5, item: "M4 边界与限制（限制）已填写", rating: "warn", statusLabel: "仅 2 条",  risk: "阶段 6 验收约束不完整" },
  { index: 6, item: "M6 硬件报价已填写", rating: "pass", statusLabel: "3 项",     risk: "—" },
  { index: 7, item: "来源抽查",           rating: "warn", statusLabel: "未抽查",   risk: "证据可信度未验证" },
  { index: 8, item: "质量六维已评估",     rating: "pass", statusLabel: "已评估",   risk: "—" },
];

/** 场景级覆盖：本场景对资料库的补充，不影响资料库本身 */
export type Stage0Override = {
  item: string;
  libraryValue: string;
  sceneValue: string;
  reason: string;
  source: SourceTag;
}

export const stage0Overrides: Stage0Override[] = [
  { item: "协议支持", libraryValue: "Modbus/MQTT/OPC UA", sceneValue: "仅 Modbus/MQTT", reason: "客户网络封闭 OPC 端口", source: "用户" },
  { item: "部署规模", libraryValue: "—",                  sceneValue: "12 间会议室",     reason: "客户现场勘测",         source: "用户" },
];

/* ═══ 阶段 1：门槛筛查 ═══ */

/** 表 1-1 场景定义：一句话说清场景是什么、谁在买 */
export type SceneDefinitionRow = {
  key: string;
  value: string;
}

export const sceneDefinition: SceneDefinitionRow[] = [
  { key: "场景名称",     value: "智慧会议室（存量改造）" },
  { key: "场景边界",     value: "覆盖会议室环境感知与设备联动 / 不含安防监控、消防联动" },
  { key: "买方类型",     value: "企业行政/IT 部门（存量楼宇优先）" },
  { key: "决策链",       value: "拍板：行政总监 / 使用：IT 运维 / 付费：年度预算" },
  { key: "核心业务流程", value: "预约 → 签到 → 环境联动 → 释放 → 数据报表" },
];

/** 表 1-3 门槛扫描：技术 / 准入 / 经济 / 生态锁定 / 一票否决者 */
export type BarrierItem = {
  category: string;
  /** E 一票否决类用错误色突出 */
  isVeto: boolean;
  barrier: string;
  vetoer: string;
  rating: CheckRating;
  statusLabel: string;
  authority: "T1" | "T2" | "T3";
}

export const barriers: BarrierItem[] = [
  { category: "A 技术",     isVeto: false, barrier: "存量中控协议私有（快思聪）",   vetoer: "IT 运维",  rating: "warn", statusLabel: "借道",   authority: "T3" },
  { category: "B 准入",     isVeto: false, barrier: "无国家强制认证要求",           vetoer: "—",        rating: "pass", statusLabel: "过得了", authority: "T1" },
  { category: "C 经济",     isVeto: false, barrier: "预算科目：智慧办公专项（有）", vetoer: "财务",     rating: "pass", statusLabel: "过得了", authority: "T2" },
  { category: "D 生态",     isVeto: false, barrier: "预约入口被钉钉/飞书占据",      vetoer: "IT 部门",  rating: "warn", statusLabel: "绕道",   authority: "T2" },
  { category: "E 一票否决", isVeto: true,  barrier: "信息条线：数据不得出园区",     vetoer: "信息中心", rating: "pass", statusLabel: "已识别", authority: "T1" },
];

/* ═══ 质量关检查项（阶段 1/2 共用结构）═══ */

export type QualityCheckItem = {
  title: string;
  desc: string;
  pass: boolean;
}

export type QualityGate = {
  title: string;
  subtitle: string;
  passed: number;
  total: number;
  /** 示意检查项（完整清单见 00b §3） */
  items: QualityCheckItem[];
}

export const gate0: QualityGate = {
  title: "质量关 0 · 门槛筛查",
  subtitle: "10 项检查（示意 4 项）",
  passed: 8,
  total: 10,
  items: [
    { title: "能明确写出我方角色，不需我方不持有的认证", desc: "角色：辅助（存量改造集成方）", pass: true },
    { title: "买方有预算科目可挂",                         desc: "智慧办公专项，T2",            pass: true },
    { title: "门槛扫描表无\u201c不知道\u201d状态",          desc: "快思聪协议适配深度待确认",    pass: false },
    { title: "来源抽查至少 3 条通过",                       desc: "仅抽查 2 条，1 条内容不一致", pass: false },
  ],
};

export const gate1: QualityGate = {
  title: "质量关 1 · 认识场景",
  subtitle: "9 项检查",
  passed: 7,
  total: 9,
  items: [
    { title: "完整架构图+要素间关系",             desc: "4 层架构 + 8 种交互",        pass: true },
    { title: "重要结论来源权威性达标",            desc: "协议/接口缺 T1 来源",        pass: false },
    { title: "适用标准号与合规路径",              desc: "缺等保二级具体标准号",       pass: false },
    { title: "关键设备有价格量级与竞争强度",      desc: "12 项要素均已标注",          pass: true },
  ],
};

/* ═══ 阶段 2：认识场景 ═══ */

export type SceneElementType = "硬件" | "软件" | "服务";
export type Competition = "高" | "中" | "低";

/** 场景要素清单 */
export type SceneElement = {
  index: number;
  name: string;
  type: SceneElementType;
  func: string;
  params: string;
  vendor: string;
  competition: Competition;
  source: SourceTag;
}

export const sceneElements: SceneElement[] = [
  { index: 1, name: "会议平板",       type: "硬件", func: "触控展示、白板、投屏",   params: "65\"/86\" 4K", vendor: "MAXHUB、华为", competition: "高", source: "AI" },
  { index: 2, name: "中控主机",       type: "硬件", func: "集中控制、场景切换",     params: "RS232/485",   vendor: "快思聪、AMX",  competition: "中", source: "AI" },
  { index: 3, name: "预约系统",       type: "软件", func: "预约、签到、释放",       params: "并发500",      vendor: "钉钉、飞书",   competition: "高", source: "用户" },
  { index: 4, name: "环境传感器",     type: "硬件", func: "温湿度、光照、人流",     params: "±0.5°C",      vendor: "自研 SEN-200", competition: "低", source: "AI" },
  { index: 5, name: "智慧空间平台",   type: "软件", func: "云端管理、数据分析",     params: "SaaS",         vendor: "自研 SW-500",  competition: "中", source: "推断" },
];

/* ═══ 右栏：决策支撑 ═══ */

export type RiskKind = "inherit" | "gap" | "ok";

export type DependencyItem = {
  /** up 上游依赖 / down 下游消费 */
  dir: "up" | "down";
  text: string;
  sub: string;
}

export type RiskEntry = {
  /** inherit 继承风险 / gap 本阶段缺口 / ok 通过 */
  kind: RiskKind;
  title: string;
  detail: string;
}

export type GateSnapshot = {
  label: string;
  passed: number;
  total: number;
  failed: string[];
}

export type DecisionData = {
  /** 当前选中要素名（表格行选中后联动，暂为 mock） */
  title: string;
  evidence: {
    sourceTag: SourceTag;
    evidenceLevel: string;
    evidenceLevelKind: "primary" | "success" | "warning";
    authority: string;
    authorityKind: "primary" | "success" | "warning";
    citation: string;
    confirmed: boolean;
  };
  dependencies: DependencyItem[];
  risks: RiskEntry[];
  gate: GateSnapshot;
}

export const decisionData: DecisionData = {
  title: "会议平板",
  evidence: {
    sourceTag: "AI",
    evidenceLevel: "B 级 · 间接有据",
    evidenceLevelKind: "primary",
    authority: "T2 较权威",
    authorityKind: "success",
    citation: "产品白皮书.pdf → p12",
    confirmed: false,
  },
  dependencies: [
    { dir: "up",   text: "上游：M1 产品清单",     sub: "产品资料库 · IPC-3000" },
    { dir: "down", text: "下游：阶段 4 匹配矩阵", sub: "候选池" },
    { dir: "down", text: "下游：阶段 5 成本估算", sub: "设备单价依据" },
  ],
  risks: [
    { kind: "inherit", title: "M4 边界与限制为空",     detail: "影响：门槛筛查缺少判据，阶段 5 方案边界不清" },
    { kind: "gap",     title: "协议/接口缺 T1 来源", detail: "RS232/485、Modbus 协议权威性不足，建议补充官方文档" },
    { kind: "gap",     title: "等保二级标准号未填",   detail: "GB/T 22239-2019，需确认适用版本" },
    { kind: "ok",      title: "要素完整性",           detail: "12 项要素已覆盖硬件/软件/服务" },
  ],
  gate: { label: "质量关 1 快照", passed: 7, total: 9, failed: ["来源权威性", "标准号与合规路径"] },
};

/* ═══ 对话消息（mock）═══ */

export type ChatMessage = {
  role: "user" | "ai";
  time: string;
  /** 支持 \n 换行，气泡按 pre-line 渲染 */
  text: string;
}

export const conversationMessages: ChatMessage[] = [
  { role: "user", time: "14:20", text: "帮我看一下会议平板的竞争格局" },
  {
    role: "ai",
    time: "14:21",
    text: "会议平板竞争（2026-09）：\n· MAXHUB V6：市占约 28%（T3）\n· 华为 IdeaHub S2：市占约 15%（T3）\n\n建议存量改造切入。",
  },
  { role: "user", time: "14:25", text: "中控主机快思聪价格多少？" },
  {
    role: "ai",
    time: "14:26",
    text: "中控主机价格：\n· 快思聪 CP4：¥15,000-25,000（T2）\n· 国产替代：¥3,000-8,000（T3）\n\n建议以国产均价 ¥5,000 为基准。",
  },
  { role: "user", time: "14:30", text: "帮我补充预约系统的竞品对比" },
  {
    role: "ai",
    time: "14:31",
    text: "预约系统对比：\n· 钉钉：蓝牙签到，15 分钟释放\n· 飞书：人脸+Wi-Fi，10 分钟释放，IoT 联动\n\n我方可同时支持两种。",
  },
];

/* ═══ 阶段 3：理解商业 ═══ */

/** 利润池（表 3-1） */
export type ProfitPoolEntry = {
  segment: string;
  revenue: number;
  margin: number;
  growth: number;
  source: SourceTag;
}

export const profitPool: ProfitPoolEntry[] = [
  { segment: "会议平板", revenue: 50000, margin: 35, growth: 12, source: "AI" },
  { segment: "中控系统", revenue: 20000, margin: 45, growth: 8, source: "AI" },
  { segment: "预约管理", revenue: 10000, margin: 60, growth: 25, source: "AI" },
  { segment: "音视频设备", revenue: 30000, margin: 28, growth: 15, source: "推断" },
];

/** 替代方案（表 3-6） */
export type Alternative = {
  id: string;
  name: string;
  cost: number;
  featureCoverage: number;
  costComparison?: string;
  featureAdvantage?: number;
}

export const alternatives: Alternative[] = [
  { id: "A1", name: "钉钉会议室", cost: 3000, featureCoverage: 60 },
  { id: "A2", name: "飞书会议室", cost: 5000, featureCoverage: 80 },
  { id: "A3", name: "华为 IdeaHub", cost: 15000, featureCoverage: 95 },
];

/** 未被满足的需求（表 3-8） */
export type UnmetNeed = {
  id: string;
  description: string;
  evidenceLevel: "A" | "B" | "C" | "D";
  sourceAuthority: "T1" | "T2" | "T3" | "T4";
  isConfirmed?: boolean;
  sourceCount?: number;
  source: SourceTag;
}

export const unmetNeeds: UnmetNeed[] = [
  { id: "N1", description: "跨平台统一预约", evidenceLevel: "A", sourceAuthority: "T1", isConfirmed: true, sourceCount: 3, source: "AI" },
  { id: "N2", description: "无感签到", evidenceLevel: "B", sourceAuthority: "T2", isConfirmed: true, sourceCount: 2, source: "AI" },
  { id: "N3", description: "设备联动控制", evidenceLevel: "C", sourceAuthority: "T3", isConfirmed: false, sourceCount: 1, source: "推断" },
];

/* ═══ 阶段 4：能力匹配 ═══ */

/** 能力匹配矩阵（表 4-3） */
export type CapabilityMatch = {
  scene: string;
  capability: string;
  matchLevel: "完全匹配" | "部分匹配" | "不匹配";
  gap: string;
  effort: string;
  source: SourceTag;
}

export const capabilityMatch: CapabilityMatch[] = [
  { scene: "预约管理", capability: "日历集成", matchLevel: "完全匹配", gap: "无", effort: "低", source: "AI" },
  { scene: "设备控制", capability: "IoT 平台", matchLevel: "部分匹配", gap: "协议适配", effort: "中", source: "AI" },
  { scene: "数据分析", capability: "BI 报表", matchLevel: "不匹配", gap: "需要开发", effort: "高", source: "推断" },
];

/** 优先级矩阵（表 4-4） */
export type PriorityMatrix = {
  scene: string;
  painScore: number;
  matchScore: number;
  priorityScore: number;
  rank: number;
  recommendation: "优先推进" | "条件推进" | "暂缓";
}

export const priorityMatrix: PriorityMatrix[] = [
  { scene: "预约管理", painScore: 90, matchScore: 85, priorityScore: 88, rank: 1, recommendation: "优先推进" },
  { scene: "设备控制", painScore: 70, matchScore: 60, priorityScore: 65, rank: 2, recommendation: "条件推进" },
  { scene: "数据分析", painScore: 50, matchScore: 30, priorityScore: 40, rank: 3, recommendation: "暂缓" },
];

/* ═══ 阶段 5：方案设计 ═══ */

/** 成本估算（表 5-5） */
export type CostEstimate = {
  category: "硬件" | "软件" | "服务";
  item: string;
  unitCost: number;
  quantity: number;
  total: number;
  source: SourceTag;
}

export const costEstimate: CostEstimate[] = [
  { category: "硬件", item: "会议平板", unitCost: 8000, quantity: 10, total: 80000, source: "AI" },
  { category: "硬件", item: "中控主机", unitCost: 5000, quantity: 10, total: 50000, source: "AI" },
  { category: "软件", item: "预约系统", unitCost: 2000, quantity: 1, total: 2000, source: "AI" },
  { category: "软件", item: "设备管理平台", unitCost: 5000, quantity: 1, total: 5000, source: "AI" },
  { category: "服务", item: "实施部署", unitCost: 10000, quantity: 1, total: 10000, source: "推断" },
  { category: "服务", item: "培训", unitCost: 3000, quantity: 1, total: 3000, source: "推断" },
];

/** 竞品价格对照（表 5-6） */
export type CompetitorPricing = {
  competitor: string;
  price: number;
  coverage: number;
  priceComparison: "高于我方" | "低于我方" | "持平";
  advantage: string;
}

export const competitorPricing: CompetitorPricing[] = [
  { competitor: "钉钉", price: 3000, coverage: 60, priceComparison: "低于我方", advantage: "生态完整" },
  { competitor: "飞书", price: 5000, coverage: 80, priceComparison: "持平", advantage: "用户体验好" },
  { competitor: "华为", price: 15000, coverage: 95, priceComparison: "高于我方", advantage: "品牌溢价" },
];

/* ═══ 阶段 6：价值验证 ═══ */

/** 投资回报估算（表 6-3） */
export type RoiEstimate = {
  metric: string;
  baseline: string;
  improvement: string;
  monetaryValue: number;
  confidence: "高" | "中" | "低";
  source: SourceTag;
}

export const roiEstimate: RoiEstimate[] = [
  { metric: "会议效率提升", baseline: "30分钟/会", improvement: "节省10分钟", monetaryValue: 50000, confidence: "高", source: "AI" },
  { metric: "设备能耗降低", baseline: "500度/月", improvement: "降低20%", monetaryValue: 12000, confidence: "中", source: "推断" },
  { metric: "人力成本节省", baseline: "2人/天", improvement: "节省0.5人", monetaryValue: 30000, confidence: "中", source: "AI" },
];

/** 试点设计（表 6-4） */
export type PilotDesign = {
  phase: string;
  scope: string;
  duration: string;
  successCriteria: string;
  risk: string;
  source: SourceTag;
}

export const pilotDesign: PilotDesign[] = [
  { phase: "第一阶段", scope: "1间会议室", duration: "2周", successCriteria: "设备联动成功", risk: "低", source: "AI" },
  { phase: "第二阶段", scope: "5间会议室", duration: "1个月", successCriteria: "用户满意度>80%", risk: "中", source: "AI" },
  { phase: "第三阶段", scope: "全楼层", duration: "3个月", successCriteria: "ROI>15%", risk: "中", source: "推断" },
];

/* ═══ 阶段 6：内部报告 ═══ */

/** 内部调研报告（表 7-1） */
export type InternalReport = {
  section: string;
  content: string;
  conclusion: string;
  confidence: "高" | "中" | "低";
  source: SourceTag;
}

export const internalReport: InternalReport[] = [
  { section: "市场分析", content: "智慧会议室市场规模约50亿", conclusion: "市场增长稳定", confidence: "高", source: "AI" },
  { section: "竞争格局", content: "钉钉、飞书、华为三足鼎立", conclusion: "差异化空间存在", confidence: "中", source: "AI" },
  { section: "技术可行性", content: "我方IoT平台可复用", conclusion: "技术风险可控", confidence: "高", source: "AI" },
];

/** 决策支撑（表 7-2） */
export type DecisionSupport = {
  factor: string;
  weight: number;
  score: number;
  weightedScore: number;
  recommendation: "强烈推荐" | "推荐" | "中性" | "不推荐";
}

export const decisionSupport: DecisionSupport[] = [
  { factor: "市场潜力", weight: 30, score: 85, weightedScore: 25.5, recommendation: "推荐" },
  { factor: "技术匹配", weight: 25, score: 70, weightedScore: 17.5, recommendation: "推荐" },
  { factor: "竞争壁垒", weight: 20, score: 60, weightedScore: 12, recommendation: "中性" },
  { factor: "投资回报", weight: 25, score: 75, weightedScore: 18.75, recommendation: "推荐" },
];

/* ═══ 阶段 8：外部报告 ═══ */

/** 外部调研报告（表 8-1） */
export type ExternalReport = {
  section: string;
  content: string;
  audience: string;
  tone: "自信" | "客观" | "谨慎";
  source: SourceTag;
}

export const externalReport: ExternalReport[] = [
  { section: "解决方案概述", content: "一站式智慧会议室解决方案", audience: "客户决策者", tone: "自信", source: "AI" },
  { section: "技术架构", content: "云边端协同架构", audience: "客户技术团队", tone: "客观", source: "AI" },
  { section: "投资回报", content: "预计18个月回收投资", audience: "客户财务", tone: "自信", source: "AI" },
];

/** 交付物清单（表 8-2） */
export type Deliverable = {
  name: string;
  format: string;
  description: string;
  status: "已完成" | "进行中" | "待处理";
  source: SourceTag;
}

export const deliverables: Deliverable[] = [
  { name: "解决方案白皮书", format: "PDF", description: "完整技术方案", status: "已完成", source: "AI" },
  { name: "报价单", format: "Excel", description: "硬件+软件+服务", status: "已完成", source: "AI" },
  { name: "实施计划", format: "Word", description: "3阶段实施路线", status: "进行中", source: "AI" },
  { name: "培训手册", format: "PDF", description: "用户操作指南", status: "待处理", source: "推断" },
];
