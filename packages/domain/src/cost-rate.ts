/**
 * cost-rate — M6「内部费率」的标准骨架
 *
 * 用户定调（2026-10-04）：「内部费率就算是空表也得有，不能让用户自己建表」。
 *
 * 背景：M6 是**成本单价的唯一来源**（原先供 表5-5 成本估算用；该表已按用户定调删除，
 * 靠它）；`cost_rate` 表建成后一直是 0 行，用户打开 M6 只看到「本表暂无资料」，
 * 想用就得自己一项一项建行——把"填单价"这件事变成了"先设计费率表"。
 *
 * 这里的骨架 = 一套**行业通例的实施工序 + 商务项**，`rate`/`standard_hours` 一律 0、
 * `data_source` 标「待确认」、`source` 标「标准骨架·待填单价」：
 *   · 结构先给全（用户只填数字，不再建行）；
 *   · 0 值与「待确认」一起表示"还没报价"——契约 completeness 明确
 *     「『待确认』行不得用于报价」，所以骨架行不会被当成真实费率消费。
 */

/** 骨架行（不含 id/时间戳，落库由应用层补） */
export interface RateSkeletonRow {
  category: "实施" | "商务";
  item: string;
  rate: number;
  unit: string;
  standard_hours: number;
  data_source: "待确认";
  source: string;
}

/** 骨架来源标注：一眼看出是系统给的结构、用户要填的是单价 */
export const RATE_SKELETON_SOURCE = "标准骨架·待填单价";

/** 标准工时默认值：一天 = 8 小时（人天类项目的起点，用户可按实际改） */
const HOURS_PER_DAY = 8;

function row(category: "实施" | "商务", item: string, unit = "人天", hours = HOURS_PER_DAY): RateSkeletonRow {
  return { category, item, rate: 0, unit, standard_hours: hours, data_source: "待确认", source: RATE_SKELETON_SOURCE };
}

/**
 * 标准费率骨架（14 项）
 *
 * 实施项对齐表5-3「实施计划」的工序（勘察 → 安装调试 → 接入联调 → 逻辑配置 →
 * 近场/元服务开发 → 上云纳管 → 客户系统对接 → 培训 → 试运行验收），
 * 商务项覆盖项目管理、差旅与售后运维年费——这三项是成本类口径里最容易漏报的。
 */
export const RATE_SKELETON: RateSkeletonRow[] = [
  row("实施", "现场勘察与点位清点"),
  row("实施", "设备安装与上电调试"),
  row("实施", "协议接入与点位联调"),
  row("实施", "控制逻辑与场景联动配置"),
  row("实施", "近场交互（元服务）开发"),
  row("实施", "平台上云与子系统纳管"),
  row("实施", "客户业务系统对接"),
  row("实施", "培训与交付文档"),
  row("实施", "试运行与验收支持"),
  row("实施", "定制开发（按需授予）"),
  row("商务", "项目管理（按实施人天计提）"),
  row("商务", "差旅（元/人天·趟）"),
  row("商务", "售后运维（年费）", "年", 0),
  row("商务", "备件与耗材", "项", 0),
];

/**
 * 判断某产品线的费率是否还是"未填的骨架"
 *
 * 用途：区分"系统刚给的结构"与"用户已填过的费率"——重命名/重复触发时不要覆盖用户已填的值。
 */
export function isSkeletonRow(row: { data_source?: string; source?: string | null }): boolean {
  return row.data_source === "待确认" && String(row.source ?? "").startsWith(RATE_SKELETON_SOURCE);
}
