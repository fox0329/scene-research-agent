/**
 * Mock 数据 — 产品资料库
 * 首版硬编码，后续接真实 API
 */

/* ── 质量总评 ── */
export type QualityDimension = {
  dimension: string;
  rating: "pass" | "warn" | "fail";
  note: string;
}

export type ReminderItem = {
  table: string;
  missing: string;
  impact: string;
}

export const qualityDimensions: QualityDimension[] = [
  { dimension: "状态可分辨", rating: "pass", note: "所有产品均标注在售/停售/在研状态" },
  { dimension: "可追溯",     rating: "pass", note: "87% 参数可定位到具体文件和页码" },
  { dimension: "可验证",     rating: "warn", note: "仅 23% 参数有实测数据，其余为宣称值" },
  { dimension: "有时效",     rating: "pass", note: "最新资料 2026-08，未超过 6 个月" },
  { dimension: "含边界",     rating: "fail", note: "M4 边界声明完全空白" },
  { dimension: "含反面",     rating: "warn", note: "M5 仅 2 条限制，建议补充" },
];

export const reminders: ReminderItem[] = [
  { table: "M4 边界声明", missing: "完全空白", impact: "门槛筛查缺判据，方案边界不清" },
  { table: "M5 已知限制", missing: "仅 2 条",   impact: "验收约束不完整" },
  { table: "M6 内部费率", missing: "商务类待确认", impact: "成本估算只能用行业均值" },
];

/* ── M1 产品清单 ── */
export type ProductItem = {
  id: string;
  model: string;
  name: string;
  status: "在售" | "停售" | "在研";
  launchDate: string;
  positioning: string;
  source: "AI" | "用户" | "推断";
  citation: string;
}

export const products: ProductItem[] = [
  { id: "p1", model: "IPC-3000",  name: "智能会议终端", status: "在售", launchDate: "2025-06", positioning: "一体化会议室控制终端",  source: "AI",   citation: "白皮书 p12" },
  { id: "p2", model: "SEN-200",   name: "环境感知传感器", status: "在售", launchDate: "2025-03", positioning: "温湿度+光照+人流一体", source: "AI",   citation: "可售清单 p3" },
  { id: "p3", model: "SW-500",    name: "智慧空间平台",  status: "在研", launchDate: "2026-Q4", positioning: "云端空间管理与数据分析", source: "推断", citation: "宣讲材料 p8" },
];

/* ── M2 规格书 ── */
export type SpecItem = {
  category: string;
  param: string;
  value: string;
  citation: string;
  verified: "实测" | "宣称";
}

export const specs: SpecItem[] = [
  { category: "计算", param: "处理器",       value: "4 核 A76 @2.0GHz",                   citation: "白皮书 p15", verified: "宣称" },
  { category: "接口", param: "网口",         value: "2\u00d7千兆 RJ45",                    citation: "白皮书 p15", verified: "实测" },
  { category: "协议", param: "支持协议",      value: "Modbus TCP / MQTT / OPC UA",          citation: "白皮书 p16", verified: "宣称" },
  { category: "电气", param: "功耗",         value: "\u226430W（PoE+ 供电）",              citation: "白皮书 p17", verified: "宣称" },
];

/* ── M3 能力清单 ── */
export type CapabilityItem = {
  name: string;
  description: string;
  maturity: "已交付" | "组件具备" | "在研";
  dependency: string;
  source: "AI" | "用户" | "推断";
}

export const capabilities: CapabilityItem[] = [
  { name: "设备接入", description: "Modbus/MQTT/OPC UA 设备接入", maturity: "已交付",   dependency: "需网关硬件",  source: "用户" },
  { name: "数据采集", description: "实时采集温湿度/光照/人流",     maturity: "已交付",   dependency: "SEN-200",      source: "AI" },
  { name: "场景联动", description: "基于规则的设备联动控制",       maturity: "组件具备", dependency: "需配置引擎",    source: "AI" },
  { name: "能耗分析", description: "会议室能耗统计与优化建议",     maturity: "在研",     dependency: "SW-500 平台",   source: "推断" },
];

/* ── M5 已知限制 ── */
export type LimitItem = {
  product: string;
  limit: string;
  severity: "高" | "中" | "低";
  fixStatus: string;
  disclosure: "内部可提" | "不可提";
  source: "AI" | "用户" | "推断";
}

export const limits: LimitItem[] = [
  { product: "IPC-3000", limit: "多设备并发轮询场景偶发丢包", severity: "中", fixStatus: "修复中", disclosure: "内部可提", source: "用户" },
  { product: "SEN-200",  limit: "高湿环境（>85%RH）精度漂移", severity: "低", fixStatus: "硬件限制", disclosure: "不可提", source: "用户" },
];

/* ── M6 内部费率 ── */
export type RateItem = {
  category: string;
  item: string;
  unitPrice: string;
  refHours: string;
  source: "AI" | "用户" | "推断" | "历史项目";
}

export const rates: RateItem[] = [
  { category: "实施", item: "安装部署",     unitPrice: "800 元/人天",  refHours: "0.5 人天/站",    source: "历史项目" },
  { category: "实施", item: "现场调试",     unitPrice: "800 元/人天",  refHours: "0.5 人天/站",    source: "历史项目" },
  { category: "商务", item: "售前方案设计", unitPrice: "1,200 元/人天", refHours: "0.2 人天/项目",  source: "推断" },
];

/* ── O 可选材料：已交付案例 ── */
export type CaseItem = {
  name: string;
  client: string;
  scene: string;
  date: string;
  result: string;
  evidenceLevel: "A" | "B" | "C";
}

export const cases: CaseItem[] = [
  { name: "某银行培训中心", client: "金融\u00b7培训", scene: "智慧会议室", date: "2025-11", result: "12 间，空置率降 35%", evidenceLevel: "B" },
  { name: "某园区展厅",     client: "园区\u00b7展厅", scene: "环境监控",   date: "2025-06", result: "86 点位，验收通过",   evidenceLevel: "B" },
];