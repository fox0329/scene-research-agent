/**
 * @scene/contract — PPT 演示大纲契约（变更表 #141）
 *
 * 「导出PPT文档」= 把某一份交付物的正文交给模型产出一份**页面大纲**（本文件定义它的形状），
 * 再由 `@scene/infra` 确定性地渲染成 SVG、由 ppt-master 技能导出 pptx。
 *
 * 分工（AGENTS.md §三.5 高风险判定落确定性层）：
 *  - **模型**只产内容：每页放什么标题、要点、对比、卡片、表格；
 *  - **契约**定义页面的形状与限额（页码规模、字段长度、各组数量）——单一事实源，
 *    提示词、`parsePptOutline` 校验、SVG 渲染三处都读它，避免各写一份；
 *  - **领域层**逐条校验（`parsePptOutline`）；**基础设施层**只负责画（禁模型写 SVG）。
 *
 * 页面口径（用户定调）：默认 B 站蓝色模版、**不要封面与尾页**，只有中间页，
 * 全程自动完成，5–10 页（目标 6–8 页），突出问题 → 方案 → 价值。
 */

/** 五种页面布局：@see docs/PPT输出要求.md */
export const PPT_LAYOUTS = ["要点", "双栏对比", "数据卡片", "图文说明", "表格"] as const;

export type PptLayout = (typeof PPT_LAYOUTS)[number];

/** 缺布局时的默认布局（页面内容比版式重要，缺了按要点排） */
export const PPT_DEFAULT_LAYOUT: PptLayout = "要点";

/** 双栏对比的一组（两栏并排） */
export interface PptColumn {
  head: string;
  bullets: string[];
}

/** 数据卡片的一张（值 + 说明） */
export interface PptCard {
  value: string;
  label: string;
}

/** 表格页的一张表（≤6 行 × ≤5 列） */
export interface PptTable {
  head: string[];
  rows: string[][];
}

/** 一页（不要封面、不要目录、不要尾页：`pages[0]` 就是第一张内容页） */
export interface PptPage {
  layout: PptLayout;
  /** 页面标题（页眉左上） */
  title: string;
  /** 一句话要点（标题下一行） */
  takeaway: string;
  /** 要点布局的条目；其它布局可为空数组 */
  bullets: string[];
  /** 双栏对比的两组（恰好 2 组） */
  columns: PptColumn[];
  /** 数据卡片的 3–4 张 */
  cards: PptCard[];
  /** 表格页的表；非表格页为 null */
  table: PptTable | null;
}

/** 一份 PPT 的大纲（模型只输出这个 JSON） */
export interface PptOutline {
  pages: PptPage[];
}

/**
 * 页面与字段限额（确定性层按它 clamp / 截断，渲染层按它排版）
 *
 * 这些值是「读者在 1280×720 屏幕上能一眼看完」的上限，不是建议：
 * 超了由 `parsePptOutline` 确定性截断，绝不让模型自由发挥。
 */
export const PPT_LIMITS = {
  /** 页数下限：少于这个数说明模型没按口径写（无法凭空造页，领域层只记录提示） */
  minPages: 5,
  /** 页数上限：超了截掉尾部页面 */
  maxPages: 10,
  /** 目标页数（进提示词） */
  targetPages: 7,
  /** 标题 ≤ 20 字 */
  titleChars: 20,
  /** 一句话要点 ≤ 40 字 */
  takeawayChars: 40,
  /** 要点页：3–5 条，每条 ≤ 40 字 */
  bullets: { min: 3, max: 5, chars: 40 },
  /** 双栏对比：恰好 2 组，每组标题 ≤ 12 字、≤3 条、每条 ≤ 40 字 */
  columns: { count: 2, headChars: 12, bullets: 3, bulletChars: 40 },
  /** 数据卡片：3–4 张，值 ≤ 8 字、说明 ≤ 14 字 */
  cards: { min: 3, max: 4, valueChars: 8, labelChars: 14 },
  /** 表格：≤6 行 × ≤5 列，表头 ≤8 字、单元格 ≤20 字 */
  table: { maxRows: 6, maxCols: 5, headChars: 8, cellChars: 20 },
} as const;
