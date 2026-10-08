/**
 * @scene/domain — PPT 大纲的确定性校验与兜底（变更表 #141）
 *
 * 模型只产内容（一页页的标题、要点、对比、卡片、表格），**能不能上这一页由本模块说了算**：
 * 页数规模、字段长度、各组数量、禁用词（占位 / 决策建议 / 内部痕迹），全部在这里逐条判定。
 * 判定留在确定性层（AGENTS.md §三.5），渲染层因此可以假定拿到的页一定能画。
 *
 * 铁律：
 *  - 模型返回不合法 → 明确失败值（`outline: null` + `error`），调用方据此重试一次再兜底提示；
 *  - 页内字段超限 → **截断**（截断不许把一页的正文全部抹掉）；缺布局按「要点」处理；
 *  - 页数超上限 → 截掉尾部页面；不足下限 → 保留（无法凭空造页），只记提示。
 *
 * 纯函数、无 IO。
 */

import {
  PPT_DEFAULT_LAYOUT,
  PPT_LIMITS,
  PPT_LAYOUTS,
  type PptCard,
  type PptColumn,
  type PptLayout,
  type PptOutline,
  type PptPage,
  type PptTable,
} from "@scene/contract";
import { jsonSlice } from "./report-review.js";

/**
 * 禁用词：出现即不许进 PPT（占位 / 决策建议 / 内部痕迹三类）
 *
 * 与《建设工作方案输出要求》§五、§六同口径——PPT 是客户看的中间页，连占位都不留。
 */
export const PPT_BANNED_PATTERNS: readonly RegExp[] = [
  /待客户提供|待补齐|待现场勘查|待确认|暂缺|未提供|TBD/,
  /建议先|建议采用|建议采购|推荐采用|推荐方案|值得投入|应当优先|不建议|可以决定/,
  /来源[:：]|出处[:：]|摘自[:：]|参见[:：]|表\d+-\d+|ingest-|证据级|权威性|核实结论|信息完整度|信息缺口/,
];

/** 是否含禁用词 */
export function hasPptBanned(text: string): boolean {
  return PPT_BANNED_PATTERNS.some((re) => re.test(text));
}

/** 命中的禁用词（写进提示，让用户看得出为什么丢了一页） */
export function pptBannedHit(text: string): string | null {
  for (const re of PPT_BANNED_PATTERNS) {
    const hit = re.exec(text);
    if (hit) return hit[0];
  }
  return null;
}

export interface PptOutlineParse {
  /** 合规大纲；整体失败时为 null（调用方不产文件） */
  outline: PptOutline | null;
  /** 采纳的页数 */
  pages: number;
  /** 丢掉的非法页数（非对象 / 没标题 / 内容为空 / 命中禁用词 / 超页数上限） */
  dropped: number;
  /** 被截断的字段数（超字数上限或超条目上限） */
  trimmed: number;
  /** 因禁用词被擦掉的条目数（要点 / 栏内条目 / 卡片 / 表格行） */
  scrubbed: number;
  /** 提示（页数不足、布局回落、禁用词丢弃等），不阻断 */
  notes: string[];
  /** 整体失败原因（没有 JSON / 不是 JSON / 没有 pages / 全被丢光） */
  error?: string;
}

/** 归一化 + 截断一段文本（压空白、去首尾；不切断代理对） */
function cut(value: unknown, max: number): { text: string; truncated: boolean } {
  const full = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(full);
  if (chars.length <= max) return { text: full, truncated: false };
  return { text: chars.slice(0, max).join(""), truncated: true };
}

interface TextList {
  items: string[];
  trimmed: number;
  scrubbed: number;
}

/** 字符串数组（要点 / 栏内条目）：去空、去重、擦禁用词、截断、限量 */
function textList(value: unknown, max: number, limit: number): TextList {
  const items: string[] = [];
  let trimmed = 0;
  let scrubbed = 0;
  if (!Array.isArray(value)) return { items, trimmed, scrubbed };
  for (const raw of value) {
    const { text, truncated } = cut(raw, max);
    if (text === "") continue;
    if (hasPptBanned(text)) {
      scrubbed += 1;
      continue;
    }
    if (truncated) trimmed += 1;
    if (!items.includes(text)) items.push(text);
  }
  if (items.length > limit) trimmed += items.length - limit;
  return { items: items.slice(0, limit), trimmed, scrubbed };
}

/** 布局归一：缺 / 不认识的取值一律按「要点」排（内容比版式重要） */
function layoutOf(value: unknown): { layout: PptLayout; note?: string } {
  const raw = typeof value === "string" ? value.trim() : "";
  if ((PPT_LAYOUTS as readonly string[]).includes(raw)) return { layout: raw as PptLayout };
  if (raw === "") return { layout: PPT_DEFAULT_LAYOUT };
  return { layout: PPT_DEFAULT_LAYOUT, note: `布局「${cut(raw, 12).text}」不认识，按「要点」排` };
}

interface Columns {
  columns: PptColumn[];
  trimmed: number;
  scrubbed: number;
}

/** 双栏：恰好 2 组，组标题与条目都要合规，超限截断 */
function columnsOf(value: unknown): Columns {
  let trimmed = 0;
  let scrubbed = 0;
  const columns: PptColumn[] = [];
  if (!Array.isArray(value)) return { columns, trimmed, scrubbed };
  if (value.length > PPT_LIMITS.columns.count) trimmed += value.length - PPT_LIMITS.columns.count;
  for (const raw of value.slice(0, PPT_LIMITS.columns.count)) {
    if (typeof raw !== "object" || raw === null) {
      scrubbed += 1;
      continue;
    }
    const o = raw as Record<string, unknown>;
    const head = cut(o["head"], PPT_LIMITS.columns.headChars);
    if (head.text === "" || hasPptBanned(head.text)) {
      scrubbed += 1;
      continue;
    }
    if (head.truncated) trimmed += 1;
    const bullets = textList(o["bullets"], PPT_LIMITS.columns.bulletChars, PPT_LIMITS.columns.bullets);
    columns.push({ head: head.text, bullets: bullets.items });
    trimmed += bullets.trimmed;
    scrubbed += bullets.scrubbed;
  }
  return { columns, trimmed, scrubbed };
}

interface Cards {
  cards: PptCard[];
  trimmed: number;
  scrubbed: number;
}

/** 数据卡片：3–4 张，值与说明都要短 */
function cardsOf(value: unknown): Cards {
  let trimmed = 0;
  let scrubbed = 0;
  const cards: PptCard[] = [];
  if (!Array.isArray(value)) return { cards, trimmed, scrubbed };
  if (value.length > PPT_LIMITS.cards.max) trimmed += value.length - PPT_LIMITS.cards.max;
  for (const raw of value.slice(0, PPT_LIMITS.cards.max)) {
    if (typeof raw !== "object" || raw === null) {
      scrubbed += 1;
      continue;
    }
    const o = raw as Record<string, unknown>;
    const value0 = cut(o["value"], PPT_LIMITS.cards.valueChars);
    const label = cut(o["label"], PPT_LIMITS.cards.labelChars);
    if (value0.text === "" && label.text === "") continue;
    if (hasPptBanned(`${value0.text}${label.text}`)) {
      scrubbed += 1;
      continue;
    }
    if (value0.truncated || label.truncated) trimmed += 1;
    cards.push({ value: value0.text, label: label.text });
  }
  return { cards, trimmed, scrubbed };
}

interface Table {
  table: PptTable | null;
  trimmed: number;
  scrubbed: number;
}

/** 表格：≤6 行 × ≤5 列；擦掉命中禁用词的行；表头不足两列或没有数据行视为没有表 */
function tableOf(value: unknown): Table {
  let trimmed = 0;
  let scrubbed = 0;
  if (typeof value !== "object" || value === null) return { table: null, trimmed, scrubbed };
  const o = value as Record<string, unknown>;
  const rawHead = Array.isArray(o["head"]) ? o["head"] : [];
  if (rawHead.length > PPT_LIMITS.table.maxCols) trimmed += rawHead.length - PPT_LIMITS.table.maxCols;
  const head: string[] = [];
  for (const h of rawHead.slice(0, PPT_LIMITS.table.maxCols)) {
    const c = cut(h, PPT_LIMITS.table.headChars);
    if (c.truncated) trimmed += 1;
    if (c.text === "" || hasPptBanned(c.text)) return { table: null, trimmed, scrubbed };
    head.push(c.text);
  }
  if (head.length < 2) return { table: null, trimmed, scrubbed };

  const rows: string[][] = [];
  const rawRows = Array.isArray(o["rows"]) ? o["rows"] : [];
  if (rawRows.length > PPT_LIMITS.table.maxRows) trimmed += rawRows.length - PPT_LIMITS.table.maxRows;
  for (const row of rawRows) {
    if (!Array.isArray(row)) continue;
    const cells: string[] = [];
    for (const cell of row.slice(0, head.length)) {
      const c = cut(cell, PPT_LIMITS.table.cellChars);
      if (c.truncated) trimmed += 1;
      cells.push(c.text);
    }
    if (cells.join("") === "") continue;
    if (hasPptBanned(cells.join(""))) {
      scrubbed += 1;
      continue;
    }
    while (cells.length < head.length) cells.push("");
    rows.push(cells);
    if (rows.length >= PPT_LIMITS.table.maxRows) break;
  }
  return { table: rows.length === 0 ? null : { head, rows }, trimmed, scrubbed };
}

/** 一页的归一化结果（page === null = 这页非法，丢掉） */
interface PageResult {
  page: PptPage | null;
  trimmed: number;
  scrubbed: number;
  notes: string[];
}

interface SettleArgs {
  layout: PptLayout;
  title: string;
  takeaway: string;
  bullets: string[];
  columns: PptColumn[];
  cards: PptCard[];
  table: PptTable | null;
  notes: string[];
}

/**
 * 版式回落：这一页的内容撑不起它自己要的版式时，降级到「要点」而不是留一张空版式
 *
 * 例：`双栏对比` 只给了一栏 → 按要点排它那一栏的条目；`表格` 没给出合规表 → 按要点排。
 */
function settle(args: SettleArgs): PptPage | null {
  const { title, takeaway, notes } = args;
  let { layout, columns, cards, table } = args;
  let bullets = args.bullets;
  const fallback: string[] = [];

  if (layout === "双栏对比" && columns.length < PPT_LIMITS.columns.count) {
    for (const c of columns) fallback.push(...c.bullets);
    fallback.push(...columns.filter((c) => c.bullets.length === 0).map((c) => c.head));
    notes.push("双栏对比不足两栏，按要点排");
    layout = PPT_DEFAULT_LAYOUT;
    columns = [];
    cards = [];
    table = null;
  }
  if (layout === "数据卡片" && cards.length < PPT_LIMITS.cards.min) {
    fallback.push(...cards.map((c) => (c.label === "" ? c.value : `${c.value}：${c.label}`)));
    notes.push(`数据卡片不足 ${PPT_LIMITS.cards.min} 张，按要点排`);
    layout = PPT_DEFAULT_LAYOUT;
    columns = [];
    cards = [];
  }
  if (layout === "表格" && table === null) {
    notes.push("表格页没有合规表格，按要点排");
    layout = PPT_DEFAULT_LAYOUT;
    columns = [];
    cards = [];
  }
  if (bullets.length === 0) bullets = fallback.slice(0, PPT_LIMITS.bullets.max);

  const hasContent =
    bullets.length > 0 || columns.length > 0 || cards.length > 0 || table !== null || takeaway !== "";
  if (!hasContent) return null;
  return { layout, title, takeaway, bullets, columns, cards, table };
}

/**
 * 一页的逐条校验
 *
 * 顺序很重要：先判标题与禁用词（页级问题只能丢页），再把超限字段截断，
 * 最后按布局补齐/回落——**任何一步都不许把一页的正文抹干净**（抹干净就丢页，不产空页）。
 */
function normalizePage(item: unknown, index: number): PageResult {
  const where = `第 ${index + 1} 页`;
  if (typeof item !== "object" || item === null) {
    return { page: null, trimmed: 0, scrubbed: 0, notes: [`${where}不是页面对象，已丢弃`] };
  }
  const o = item as Record<string, unknown>;
  const title = cut(o["title"], PPT_LIMITS.titleChars);
  const takeaway = cut(o["takeaway"], PPT_LIMITS.takeawayChars);
  if (title.text === "") {
    return { page: null, trimmed: 0, scrubbed: 0, notes: [`${where}没有标题，已丢弃`] };
  }
  const banned = pptBannedHit(`${title.text}｜${takeaway.text}`);
  if (banned !== null) {
    return {
      page: null,
      trimmed: 0,
      scrubbed: 0,
      notes: [`${where}出现不能进客户材料的「${banned}」，已丢弃`],
    };
  }

  const notes: string[] = [];
  let trimmed = (title.truncated ? 1 : 0) + (takeaway.truncated ? 1 : 0);
  const { layout, note } = layoutOf(o["layout"]);
  if (note) notes.push(`${where}${note}`);
  const bullets = textList(o["bullets"], PPT_LIMITS.bullets.chars, PPT_LIMITS.bullets.max);
  const cols = columnsOf(o["columns"]);
  const cards = cardsOf(o["cards"]);
  const table = tableOf(o["table"]);
  trimmed += bullets.trimmed + cols.trimmed + cards.trimmed + table.trimmed;
  const scrubbed = bullets.scrubbed + cols.scrubbed + cards.scrubbed + table.scrubbed;
  if (scrubbed > 0) notes.push(`${where}擦掉 ${scrubbed} 处不能进客户材料的内容`);

  const page = settle({
    layout,
    title: title.text,
    takeaway: takeaway.text,
    bullets: bullets.items,
    columns: cols.columns,
    cards: cards.cards,
    table: table.table,
    notes,
  });
  if (page === null) {
    return { page: null, trimmed, scrubbed, notes: [...notes, `${where}没有可展示的内容，已丢弃`] };
  }
  return { page, trimmed, scrubbed, notes };
}

/** 整体失败值（调用方据此重试一次 / 提示"未导出 PPT"） */
function fail(error: string, notes: string[] = []): PptOutlineParse {
  return { outline: null, pages: 0, dropped: 0, trimmed: 0, scrubbed: 0, notes, error };
}

/**
 * 解析并校验模型给出的大纲（唯一入口）
 *
 * @param raw 模型返回的原文（允许 ```json 围栏与前后寒暄，交给 `jsonSlice` 抠）
 */
export function parsePptOutline(raw: string): PptOutlineParse {
  const slice = jsonSlice(raw);
  if (slice === null) return fail("模型返回里没有 JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return fail("模型返回的不是合规 JSON");
  }
  const list = (parsed as { pages?: unknown } | null)?.pages;
  if (!Array.isArray(list)) return fail("模型返回里缺少 pages 数组");

  const notes: string[] = [];
  const pages: PptPage[] = [];
  let dropped = 0;
  let trimmed = 0;
  let scrubbed = 0;
  for (const [i, item] of list.entries()) {
    if (pages.length >= PPT_LIMITS.maxPages) {
      dropped += 1;
      continue;
    }
    const r = normalizePage(item, i);
    trimmed += r.trimmed;
    scrubbed += r.scrubbed;
    notes.push(...r.notes);
    if (r.page === null) {
      dropped += 1;
      continue;
    }
    pages.push(r.page);
  }
  if (list.length > PPT_LIMITS.maxPages) {
    notes.push(`模型给了 ${list.length} 页，超出 ${PPT_LIMITS.maxPages} 页上限，已截掉尾部页面`);
  }
  if (pages.length === 0) return fail("模型返回的 pages 里没有可用页面", notes);
  if (pages.length < PPT_LIMITS.minPages) {
    notes.push(
      `只有 ${pages.length} 页，少于 ${PPT_LIMITS.minPages} 页下限（无法凭空造页，按现有页数导出）`,
    );
  }
  return { outline: { pages }, pages: pages.length, dropped, trimmed, scrubbed, notes };
}
