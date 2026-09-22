/**
 * Mock 数据 — 项目工作台（T2.3）
 * 首版硬编码，后续按 03-数据契约与API.md 接真实 API
 */

/* ═══ 阶段定义（9 阶段，对应 00b 工作流标准）═══ */

export type StageDef = {
  index: number;
  label: string;
}

export const STAGES: StageDef[] = [
  { index: 0, label: "材料入库" },
  { index: 1, label: "门槛筛查" },
  { index: 2, label: "认识场景" },
  { index: 3, label: "理解商业" },
  { index: 4, label: "匹配决策" },
  { index: 5, label: "方案实现" },
  { index: 6, label: "价值验证" },
  { index: 7, label: "总结沉淀" },
  { index: 8, label: "交付物" },
];

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
  /** 当前所处阶段 0-8 */
  stage: number;
  productLine: string;
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
      { id: "p1c1", name: "补充 M4 边界声明" },
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
    stage: 8,
    productLine: "综合解决方案",
    conversations: [
      { id: "p3c1", name: "生成交付物" },
      { id: "p3c2", name: "价值验证完成" },
      { id: "p3c3", name: "方案与成本分析" },
      { id: "p3c4", name: "总结沉淀回写" },
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
  { index: 4, item: "M4 边界声明已填写", rating: "fail", statusLabel: "空白",     risk: "阶段 1 门槛判据缺失，阶段 4 边界只能推断" },
  { index: 5, item: "M5 已知限制已填写", rating: "warn", statusLabel: "仅 2 条",  risk: "阶段 6 验收约束不完整" },
  { index: 6, item: "M6 成本结构已填写", rating: "pass", statusLabel: "3 项",     risk: "—" },
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
    { kind: "inherit", title: "M4 边界声明为空",     detail: "影响：门槛筛查缺少判据，阶段 5 方案边界不清" },
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
