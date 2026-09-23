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
/* ═══ 建议卡数据（阶段 3-8）═══ */

export const stage3Advice: AdviceData = {
  level: "建议通过",
  reason: "商业逻辑清晰，利润池和替代方案分析完整",
  risks: [
    "未满足需求中有1项待交叉验证",
    "利润率数据来自AI推断，需补充T1来源",
  ],
  satisfied: 6,
  total: 8,
};

export const stage4Advice: AdviceData = {
  level: "建议有条件通过",
  reason: "能力匹配基本清晰，但存在2个缺口",
  risks: [
    "数据分析能力缺口较大，需评估开发成本",
    "协议适配成本未量化",
  ],
  conditions: [
    "补充数据分析模块的开发工时估算",
    "确认协议适配的技术方案",
  ],
  satisfied: 5,
  total: 7,
};

export const stage5Advice: AdviceData = {
  level: "建议通过",
  reason: "成本估算完整，竞品价格对照清晰",
  risks: [
    "硬件成本来自AI提取，需用户确认",
    "服务成本为推断值，建议补充报价单",
  ],
  satisfied: 5,
  total: 6,
};

export const stage6Advice: AdviceData = {
  level: "建议通过",
  reason: "ROI测算合理，试点设计可执行",
  risks: [
    "置信度中等的指标需在试点中验证",
    "试点范围较小，推广时需重新测算",
  ],
  satisfied: 5,
  total: 7,
};

export const stage7Advice: AdviceData = {
  level: "建议通过",
  reason: "内部报告完整，决策支撑量化充分",
  risks: [
    "综合得分74.25，处于推荐区间但非强烈推荐",
    "竞争壁垒得分较低，需持续关注",
  ],
  satisfied: 5,
  total: 6,
};

export const stage8Advice: AdviceData = {
  level: "建议通过",
  reason: "交付物清单完整，可进入客户沟通",
  risks: [
    "实施计划和培训手册待完成",
    "外部报告需根据客户反馈调整",
  ],
  satisfied: 5,
  total: 6,
};

/* ═══ 质量关 2 检查项（8 项）═══ */

export const gate2FullItems: QualityCheckListItem[] = [
  { title: "利润池数据有T2以上来源", desc: "3/4项达标，1项为推断", pass: true },
  { title: "替代方案覆盖主要竞品", desc: "钉钉、飞书、华为均已分析", pass: true },
  { title: "未满足需求有交叉验证", desc: "2/3项已确认，1项待验证", pass: true },
  { title: "证据等级无D级（过度宣称）", desc: "所有需求证据等级为A/B/C", pass: true },
  { title: "利润率数据有依据", desc: "来源权威性T2以上", pass: true },
  { title: "替代方案成本对比准确", desc: "基于实际报价或权威数据", pass: true },
  { title: "竞争格局分析完整", desc: "涵盖主流玩家和替代方案", pass: true },
  { title: "商业逻辑链条完整", desc: "从需求到利润池的推导清晰", pass: true },
];

/* ═══ 质量关 3 检查项（7 项）═══ */

export const gate3FullItems: QualityCheckListItem[] = [
  { title: "能力匹配矩阵完整", desc: "3项场景需求均已评估", pass: true },
  { title: "缺口有量化评估", desc: "差距和补齐成本已标注", pass: true },
  { title: "优先级矩阵有依据", desc: "痛点×匹配综合打分", pass: true },
  { title: "排名逻辑清晰", desc: "从1开始连续递增", pass: true },
  { title: "匹配度判断有来源", desc: "AI提取/推断已标注", pass: true },
  { title: "补齐成本可执行", desc: "工时或金额已量化", pass: false },
  { title: "风险因素已识别", desc: "技术风险和成本风险已标注", pass: true },
];

/* ═══ 质量关 4 检查项（6 项）═══ */

export const gate4FullItems: QualityCheckListItem[] = [
  { title: "成本估算覆盖硬件/软件/服务", desc: "6项成本均已估算", pass: true },
  { title: "单价来源权威性达标", desc: "硬件成本T2，软件成本T3", pass: true },
  { title: "竞品价格对照完整", desc: "3个竞品均已对比", pass: true },
  { title: "成本汇总准确", desc: "小计和总计计算正确", pass: true },
  { title: "价格对比逻辑正确", desc: "高于/低于/持平判断准确", pass: true },
  { title: "我方优势已说明", desc: "每个竞品的差异化优势已标注", pass: true },
];

/* ═══ 质量关 5 检查项（7 项）═══ */

export const gate5FullItems: QualityCheckListItem[] = [
  { title: "ROI测算有依据", desc: "3项指标均有来源标注", pass: true },
  { title: "置信度评估合理", desc: "高/中/低分级清晰", pass: true },
  { title: "试点设计可执行", desc: "3阶段范围和时长明确", pass: true },
  { title: "成功标准可量化", desc: "设备联动、满意度、ROI均有阈值", pass: true },
  { title: "风险评估完整", desc: "低/中风险已识别", pass: true },
  { title: "投资回报率计算正确", desc: "(收益-投入)/投入×100%", pass: true },
  { title: "回收周期合理", desc: "18个月在行业合理范围内", pass: true },
];

/* ═══ 质量关 6 检查项（6 项）═══ */

export const gate6FullItems: QualityCheckListItem[] = [
  { title: "报告章节完整", desc: "市场/竞争/技术三部分", pass: true },
  { title: "结论有依据", desc: "每个结论有置信度标注", pass: true },
  { title: "决策因素量化", desc: "4个因素均有权重和得分", pass: true },
  { title: "综合得分计算正确", desc: "加权求和逻辑正确", pass: true },
  { title: "建议与得分匹配", desc: "74.25分对应'推荐'", pass: true },
  { title: "关键因素已提取", desc: "Top3因素已列出", pass: true },
];

/* ═══ 质量关 7 检查项（6 项）═══ */

export const gate7FullItems: QualityCheckListItem[] = [
  { title: "报告受众明确", desc: "决策者/技术/财务分别对应", pass: true },
  { title: "语气与受众匹配", desc: "自信/客观/谨慎分级合理", pass: true },
  { title: "交付物清单完整", desc: "4项交付物均已列出", pass: true },
  { title: "状态标注准确", desc: "已完成/进行中/待处理", pass: true },
  { title: "格式说明清晰", desc: "PDF/Excel/Word格式已标注", pass: true },
  { title: "可直接交付", desc: "所有已完成项可直接使用", pass: true },
];
