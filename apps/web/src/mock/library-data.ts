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
  { dimension: "含边界",     rating: "fail", note: "边界与限制里没有「不做」类记录" },
  { dimension: "含反面",     rating: "warn", note: "边界与限制里仅 2 条限制，建议补充" },
];

export const reminders: ReminderItem[] = [
  { table: "边界与限制（不做）", missing: "完全空白", impact: "门槛筛查缺判据，方案边界不清" },
  { table: "边界与限制（限制）", missing: "仅 2 条",   impact: "验收约束不完整" },
  { table: "报价", missing: "仅 3 个示例口径", impact: "成本测算缺真实报价锚点" },
];

/* ── M1 产品清单（四列：型号/名称/状态/来源） ── */
export type ProductItem = {
  id: string;
  model: string;
  name: string;
  status: "在售" | "停售" | "在研";
  source: "AI" | "用户" | "推断";
}

export const products: ProductItem[] = [
  { id: "p1", model: "IPC-3000",  name: "智能会议终端", status: "在售", source: "AI" },
  { id: "p2", model: "SEN-200",   name: "环境感知传感器", status: "在售", source: "AI" },
  { id: "p3", model: "SW-500",    name: "智慧空间平台",  status: "在研", source: "推断" },
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
  domain: string;
  name: string;
  /** 依赖条件并入描述，不再单列（DB 列保留） */
  description: string;
  maturity: "已交付" | "组件具备" | "在研";
  source: "AI" | "用户" | "推断";
}

export const capabilities: CapabilityItem[] = [
  { domain: "设备接入", name: "设备接入", description: "Modbus/MQTT/OPC UA 设备接入（依赖：网关硬件）", maturity: "已交付", source: "用户" },
  { domain: "数据采集", name: "数据采集", description: "实时采集温湿度/光照/人流（依赖：SEN-200）", maturity: "已交付", source: "AI" },
  { domain: "场景联动", name: "场景联动", description: "基于规则的设备联动控制（依赖：配置引擎）",   maturity: "组件具备", source: "AI" },
  { domain: "能耗分析", name: "能耗分析", description: "会议室能耗统计与优化建议（依赖：SW-500 平台）", maturity: "在研", source: "推断" },
];

/* ── M4 边界与限制（合并视图） ── */
export type BoundaryItem = {
  type: "不做" | "限制";
  target: string;
  description: string;
  /** 凭什么判「不做」；限制类没有依据，填「—」 */
  reason: string;
  impact: "高" | "中" | "低" | "—";
  response: string;
  source: "AI" | "用户" | "推断";
}

export const boundaryRows: BoundaryItem[] = [
  { type: "不做", target: "公司/业务", description: "不承接客户自建平台的二次开发", reason: "个性化开发无法复用标准产品，交付风险不可控", impact: "—", response: "只做标准接口对接，个性化开发转生态伙伴", source: "用户" },
  { type: "限制", target: "IPC-3000", description: "多设备并发轮询场景偶发丢包", reason: "—", impact: "中", response: "—", source: "用户" },
  { type: "限制", target: "SEN-200",  description: "高湿环境（>85%RH）精度漂移", reason: "—", impact: "低", response: "—", source: "用户" },
];

/* ── 报价（示例数据） ── */
export type QuoteItem = {
  model: string;
  config: string;
  unit_price: string;
  price_scope: "纯设备" | "含安装" | "含三年维保" | "年费";
  valid_until: string;
  source: string;
}

export const quotes: QuoteItem[] = [
  { model: "IPC-3000", config: "标准配置（8G+128G）", unit_price: "12000–15000", price_scope: "含安装",     valid_until: "2026-12-31", source: "示例数据" },
  { model: "IPC-3000", config: "标准配置（8G+128G）", unit_price: "9800",        price_scope: "纯设备",     valid_until: "长期",       source: "示例数据" },
  { model: "SEN-200",  config: "单只装",              unit_price: "680",         price_scope: "纯设备",     valid_until: "长期",       source: "示例数据" },
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