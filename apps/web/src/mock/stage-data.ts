/**
 * Mock 数据 — 阶段面板（T2.4）
 * 对齐场景通-prototype-v10.html 的阶段 0-2 内容
 * 后续按 03-数据契约与API.md 接真实 API
 */

/* ═══ 建议卡数据（阶段 0/1/2）═══ */

export type AdviceLevel = "建议通过" | "建议有条件通过" | "建议不通过";

export type AdviceData = {
  level: AdviceLevel;
  reason: string;
  risks: string[];
  conditions?: string[];
  satisfied: number;
  total: number;
};

export const stage0Advice: AdviceData = {
  level: "建议通过",
  reason: "材料解析完成，不阻断",
  risks: [
    "M4 边界声明为空 → 已在右栏登记为继承风险",
    "来源未抽查 → 阶段 1 起每质量关将自动抽查 ≥3 条",
  ],
  satisfied: 6,
  total: 8,
};

export const stage1Advice: AdviceData = {
  level: "建议有条件通过",
  reason: "先打存量中控改造细分",
  risks: [],
  conditions: [
    "确认快思聪协议适配方案（借道策略）",
    "补 1 条 T2 以上来源通过抽查",
  ],
  satisfied: 8,
  total: 10,
};

export const stage2Advice: AdviceData = {
  level: "建议通过",
  reason: "场景已摸清，可进入商业分析",
  risks: [
    "协议/接口缺 T1 来源 → 建议补官方协议文档",
    "缺等保二级具体标准号（GB/T 22239-2019）→ 待确认版本",
  ],
  satisfied: 7,
  total: 9,
};

/* ═══ 质量关 0 检查项扩展（10 项）═══ */

export type QualityCheckListItem = {
  title: string;
  desc: string;
  pass: boolean;
};

export const gate0FullItems: QualityCheckListItem[] = [
  { title: "能明确写出我方角色，不需我方不持有的认证", desc: "角色：辅助（存量改造集成方）", pass: true },
  { title: "买方有预算科目可挂",                         desc: "智慧办公专项，T2",            pass: true },
  { title: "门槛扫描表无\u201c不知道\u201d状态",          desc: "快思聪协议适配深度待确认",    pass: false },
  { title: "来源抽查至少 3 条通过",                       desc: "仅抽查 2 条，1 条内容不一致", pass: false },
  { title: "买方决策链已识别",                             desc: "行政总监/IT 运维/财务",       pass: true },
  { title: "一票否决者已标注",                             desc: "信息中心：数据不出园区",       pass: true },
  { title: "门槛权威性均达 T2 以上",                       desc: "4/5 达标，1 项 T3",           pass: true },
  { title: "经济门槛有预算依据",                           desc: "智慧办公专项预算",             pass: true },
  { title: "生态锁定风险已识别",                           desc: "预约入口被钉钉/飞书占据",     pass: true },
  { title: "技术门槛有可行方案",                           desc: "快思聪借道策略待验证",         pass: true },
];

/* ═══ 质量关 1 检查项扩展（9 项）═══ */

export const gate1FullItems: QualityCheckListItem[] = [
  { title: "完整架构图+要素间关系",                        desc: "4 层架构 + 8 种交互",        pass: true },
  { title: "重要结论来源权威性达标",                       desc: "协议/接口缺 T1 来源",        pass: false },
  { title: "适用标准号与合规路径",                         desc: "缺等保二级具体标准号",       pass: false },
  { title: "关键设备有价格量级与竞争强度",                 desc: "12 项要素均已标注",          pass: true },
  { title: "要素清单覆盖硬件、软件、服务三类",             desc: "硬件 7 / 软件 3 / 服务 2",   pass: true },
  { title: "每个要素有至少一个供应商",                     desc: "12 项要素均已填写供应商",     pass: true },
  { title: "竞争强度高（>7 分）的要素有应对方案",          desc: "会议平板/预约系统为高竞争",   pass: true },
  { title: "场景边界已明确不含什么",                       desc: "不含安防监控、消防联动",      pass: true },
  { title: "来源标记已覆盖所有非用户直接提供的数据",       desc: "AI 提取 8 / 用户确认 2 / 推断 2", pass: true },
];