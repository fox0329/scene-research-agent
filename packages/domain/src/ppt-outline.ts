/**
 * @scene/domain — PPT 大纲的确定性校验与兜底（变更表 #141 立、#142 升）
 *
 * 模型只产内容（一页页的小节标签、标题、副题、块/栏/阶段/层/卡片/表格/标签、结论带），
 * **能不能上这一页由本模块说了算**：页数规模、字段长度、各组数量、布局回落、
 * 禁用词（占位 / 决策建议 / 内部痕迹），全部在这里逐条判定。
 * 判定留在确定性层（AGENTS.md §三.5），渲染层因此可以假定拿到的页一定能画。
 *
 * 铁律：
 *  - 模型返回不合法 → 明确失败值（`outline: null` + `error`），调用方据此重试一次再兜底提示；
 *  - 页内字段超限 → **截断**（截断不许把一页的正文全部抹掉）；缺字段按布局回落，绝不产空版式；
 *  - 页数超上限 → 截掉尾部页面；不足下限 → 保留（无法凭空造页），只记提示。
 *
 * 纯函数、无 IO。
 */

import {
  PPT_DEFAULT_LAYOUT,
  PPT_LAYOUT_ALIASES,
  PPT_LIMITS,
  PPT_LAYOUTS,
  type PptBlock,
  type PptCard,
  type PptColumn,
  type PptLayer,
  type PptLayout,
  type PptOutline,
  type PptPage,
  type PptStage,
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
  /**
   * 每页的**有效短句**数（与 `outline.pages` 同序、同长度）
   *
   * 只数内容短句，不数 6 条固定骨架文本（小节标签 / 标题 / 副题 / 结论带 / 页码 / 页脚）。
   * 调用方据此判断"这一页是不是空页"——内容偏少时重试一次（见 `apps/server/src/ppt-export.ts`）。
   */
  pageSentences: number[];
  /** 丢掉的非法页数（非对象 / 没标题 / 内容为空 / 命中禁用词 / 超页数上限） */
  dropped: number;
  /** 被截断的字段数（超字数上限或超条目上限） */
  trimmed: number;
  /** 因禁用词被擦掉的条目数（块行 / 栏行 / 阶段 / 层 / 卡片 / 表格行 / 标签） */
  scrubbed: number;
  /** 提示（页数不足、布局回落、禁用词丢弃等），不阻断 */
  notes: string[];
  /** 整体失败原因（没有 JSON / 不是 JSON / 没有 pages / 全被丢光） */
  error?: string;
}

/**
 * 一页的**有效短句**数（内容短句，口径与渲染一致）
 *
 * 块 / 栏 = `head` + `note` + 每行一条；阶段 = `head` + `note`；层 = `head` + 每个组件；
 * 卡片 = `value` + `label`；表格 = 表头格 + 每个数据格；要点清单 = 每行一条。
 * 固定骨架（小节标签 / 标题 / 副题 / 结论带 / 页码 / 页脚）不算——它们由渲染层生成，恒在。
 */
export function pptPageSentences(page: PptPage): number {
  switch (page.layout) {
    case "网格要点":
      return page.blocks.reduce(
        (n, b) => n + (b.head === "" ? 0 : 1) + (b.note === "" ? 0 : 1) + b.lines.length,
        0,
      );
    case "双栏对比":
      return page.columns.reduce(
        (n, c) => n + (c.head === "" ? 0 : 1) + (c.note === "" ? 0 : 1) + c.lines.length,
        0,
      );
    case "流程阶段":
      return page.stages.reduce((n, s) => n + (s.head === "" ? 0 : 1) + (s.note === "" ? 0 : 1), 0);
    case "分层架构":
      return page.layers.reduce((n, l) => n + (l.head === "" ? 0 : 1) + l.items.length, 0);
    case "数据卡片":
      return page.cards.length * 2;
    case "表格":
      return page.table === null
        ? 0
        : page.table.head.length + page.table.rows.reduce((n, row) => n + row.length, 0);
    default:
      return page.bullets?.length ?? 0;
  }
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

/** 字符串数组（内容行 / 标签）：去空、去重、擦禁用词、截断、限量 */
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

/** 布局归一：缺 / 旧名 / 不认识的取值按兜底布局排（内容比版式重要） */
function layoutOf(value: unknown): { layout: PptLayout; note?: string } {
  const raw = typeof value === "string" ? value.trim() : "";
  if ((PPT_LAYOUTS as readonly string[]).includes(raw)) return { layout: raw as PptLayout };
  const alias = PPT_LAYOUT_ALIASES[raw];
  if (alias) return { layout: alias };
  if (raw === "") return { layout: PPT_DEFAULT_LAYOUT };
  return {
    layout: PPT_DEFAULT_LAYOUT,
    note: `布局「${cut(raw, 12).text}」不认识，按「${PPT_DEFAULT_LAYOUT}」排`,
  };
}

// ─── 各布局的字段归一 ──────────────────────────────────────

interface Blocks {
  blocks: PptBlock[];
  trimmed: number;
  scrubbed: number;
}

/** 网格要点：最多 4 块，块头 / 小注 / 内容行逐项截断与擦禁用词 */
function blocksOf(value: unknown): Blocks {
  let trimmed = 0;
  let scrubbed = 0;
  const blocks: PptBlock[] = [];
  if (!Array.isArray(value)) return { blocks, trimmed, scrubbed };
  const limit = PPT_LIMITS.blocks.count;
  if (value.length > limit) trimmed += value.length - limit;
  for (const raw of value.slice(0, limit)) {
    if (typeof raw !== "object" || raw === null) {
      scrubbed += 1;
      continue;
    }
    const o = raw as Record<string, unknown>;
    const head = cut(o["head"], PPT_LIMITS.blocks.headChars);
    const note = cut(o["note"], PPT_LIMITS.blocks.noteChars);
    if (hasPptBanned(`${head.text}｜${note.text}`)) {
      scrubbed += 1;
      continue;
    }
    const lines = textList(o["lines"], PPT_LIMITS.blocks.lineChars, PPT_LIMITS.blocks.maxLines);
    if (head.text === "" && lines.items.length === 0) {
      scrubbed += 1;
      continue;
    }
    if (head.truncated || note.truncated) trimmed += 1;
    trimmed += lines.trimmed;
    scrubbed += lines.scrubbed;
    blocks.push({ head: head.text, note: note.text, lines: lines.items });
  }
  return { blocks, trimmed, scrubbed };
}

interface Columns {
  columns: PptColumn[];
  trimmed: number;
  scrubbed: number;
}

/** 双栏对比：恰好 2 组，栏头 / 小注 / 内容行都要合规，超限截断 */
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
    const note = cut(o["note"], PPT_LIMITS.columns.noteChars);
    if (head.text === "" || hasPptBanned(`${head.text}｜${note.text}`)) {
      scrubbed += 1;
      continue;
    }
    // 兼容 #141 的 `bullets` 字段名
    const rawLines = Array.isArray(o["lines"]) && o["lines"].length > 0 ? o["lines"] : o["bullets"];
    const lines = textList(rawLines, PPT_LIMITS.columns.lineChars, PPT_LIMITS.columns.maxLines);
    if (head.truncated || note.truncated) trimmed += 1;
    columns.push({ head: head.text, note: note.text, lines: lines.items });
    trimmed += lines.trimmed;
    scrubbed += lines.scrubbed;
  }
  return { columns, trimmed, scrubbed };
}

interface Stages {
  stages: PptStage[];
  trimmed: number;
  scrubbed: number;
}

/** 流程阶段：3–5 个，多则截、不够由 settle 回落 */
function stagesOf(value: unknown): Stages {
  let trimmed = 0;
  let scrubbed = 0;
  const stages: PptStage[] = [];
  if (!Array.isArray(value)) return { stages, trimmed, scrubbed };
  if (value.length > PPT_LIMITS.stages.max) trimmed += value.length - PPT_LIMITS.stages.max;
  for (const raw of value.slice(0, PPT_LIMITS.stages.max)) {
    if (typeof raw !== "object" || raw === null) {
      scrubbed += 1;
      continue;
    }
    const o = raw as Record<string, unknown>;
    const head = cut(o["head"], PPT_LIMITS.stages.headChars);
    const note = cut(o["note"], PPT_LIMITS.stages.noteChars);
    if (head.text === "" || hasPptBanned(`${head.text}｜${note.text}`)) {
      scrubbed += 1;
      continue;
    }
    if (head.truncated || note.truncated) trimmed += 1;
    stages.push({ head: head.text, note: note.text });
  }
  return { stages, trimmed, scrubbed };
}

interface Layers {
  layers: PptLayer[];
  trimmed: number;
  scrubbed: number;
}

/** 分层架构：3–4 层，每层 2–4 个组件 */
function layersOf(value: unknown): Layers {
  let trimmed = 0;
  let scrubbed = 0;
  const layers: PptLayer[] = [];
  if (!Array.isArray(value)) return { layers, trimmed, scrubbed };
  if (value.length > PPT_LIMITS.layers.max) trimmed += value.length - PPT_LIMITS.layers.max;
  for (const raw of value.slice(0, PPT_LIMITS.layers.max)) {
    if (typeof raw !== "object" || raw === null) {
      scrubbed += 1;
      continue;
    }
    const o = raw as Record<string, unknown>;
    const head = cut(o["head"], PPT_LIMITS.layers.headChars);
    if (head.text === "" || hasPptBanned(head.text)) {
      scrubbed += 1;
      continue;
    }
    const items = textList(o["items"], PPT_LIMITS.layers.itemChars, PPT_LIMITS.layers.maxItems);
    if (head.truncated) trimmed += 1;
    trimmed += items.trimmed;
    scrubbed += items.scrubbed;
    layers.push({ head: head.text, items: items.items });
  }
  return { layers, trimmed, scrubbed };
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

// ─── 版式回落 ──────────────────────────────────────────────

/** 一页的归一化结果（page === null = 这页非法，丢掉） */
interface PageResult {
  page: PptPage | null;
  trimmed: number;
  scrubbed: number;
  notes: string[];
}

interface SettleArgs {
  layout: PptLayout;
  kicker: string;
  title: string;
  subtitle: string;
  highlight: string;
  blocks: PptBlock[];
  columns: PptColumn[];
  stages: PptStage[];
  layers: PptLayer[];
  cards: PptCard[];
  table: PptTable | null;
  chips: string[];
  bullets: string[];
  notes: string[];
}

/** 把各布局的内容摊平成一行行短句（降级到「要点清单」时用，尽量不丢内容） */
function flatten(args: {
  blocks: readonly PptBlock[];
  columns: readonly PptColumn[];
  stages: readonly PptStage[];
  layers: readonly PptLayer[];
  cards: readonly PptCard[];
}): string[] {
  const out: string[] = [];
  for (const b of args.blocks) out.push(...b.lines);
  for (const c of args.columns) out.push(...c.lines);
  for (const s of args.stages) out.push(s.note === "" ? s.head : `${s.head}：${s.note}`);
  for (const l of args.layers) out.push(`${l.head}：${l.items.join("、")}`);
  for (const c of args.cards) out.push(c.label === "" ? c.value : `${c.value}：${c.label}`);
  return out;
}

/** 去重（保序） */
function unique(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) if (line !== "" && !out.includes(line)) out.push(line);
  return out;
}

/**
 * 版式回落：这一页的内容撑不起它自己要的版式时，降级到「要点清单」而不是留一张空版式
 *
 * 例：`双栏对比` 只给了一栏 → 它的内容搬进要点行；`分层架构` 不足 3 层 → 同上；
 * `网格要点` 不足 3 块 → 降级（3 块照画，2 块以下降级）。降级只搬内容、不删内容。
 */
function settle(args: SettleArgs): PptPage | null {
  const { kicker, title, subtitle, highlight, chips, notes } = args;
  let { layout } = args;
  let bullets = args.bullets;
  const { blocks, columns, stages, layers, cards, table } = args;
  const fallback: string[] = [];

  /** 降级到兜底布局：把本布局的内容摊平留给要点行 */
  const degrade = (reason: string, lines: readonly string[]): void => {
    notes.push(`${reason}，按「${PPT_DEFAULT_LAYOUT}」排`);
    fallback.push(...lines);
    layout = PPT_DEFAULT_LAYOUT;
  };

  if (layout === "网格要点" && blocks.length < PPT_LIMITS.blocks.min) {
    degrade(`网格要点不足 ${PPT_LIMITS.blocks.min} 块`, flatten({ blocks, columns: [], stages: [], layers: [], cards: [] }));
  }
  if (layout === "双栏对比" && columns.length < PPT_LIMITS.columns.count) {
    degrade("双栏对比不足两栏", flatten({ blocks: [], columns, stages: [], layers: [], cards: [] }));
  }
  if (layout === "流程阶段" && stages.length < PPT_LIMITS.stages.min) {
    degrade(
      `流程阶段不足 ${PPT_LIMITS.stages.min} 个`,
      flatten({ blocks: [], columns: [], stages, layers: [], cards: [] }),
    );
  }
  if (layout === "分层架构" && layers.length < PPT_LIMITS.layers.min) {
    degrade(
      `分层架构不足 ${PPT_LIMITS.layers.min} 层`,
      flatten({ blocks: [], columns: [], stages: [], layers, cards: [] }),
    );
  }
  if (layout === "数据卡片" && cards.length < PPT_LIMITS.cards.min) {
    degrade(
      `数据卡片不足 ${PPT_LIMITS.cards.min} 张`,
      flatten({ blocks: [], columns: [], stages: [], layers: [], cards }),
    );
  }
  if (layout === "表格" && table === null) {
    degrade("表格页没有合规表格", bullets);
  }

  if (layout === PPT_DEFAULT_LAYOUT) {
    // 要点清单：优先用模型给的 bullets，不够就用降级兜底的行补足
    const pool = unique([...bullets, ...fallback]).map((line) => cut(line, PPT_LIMITS.bullets.chars).text);
    bullets = unique(pool).slice(0, PPT_LIMITS.bullets.max);
  }

  const hasContent =
    bullets.length > 0 ||
    blocks.length > 0 ||
    columns.length > 0 ||
    stages.length > 0 ||
    layers.length > 0 ||
    cards.length > 0 ||
    table !== null ||
    subtitle !== "";
  if (!hasContent) return null;

  return {
    layout,
    kicker,
    title,
    subtitle,
    blocks: layout === "网格要点" ? blocks : [],
    columns: layout === "双栏对比" ? columns : [],
    stages: layout === "流程阶段" ? stages : [],
    layers: layout === "分层架构" ? layers : [],
    cards: layout === "数据卡片" ? cards : [],
    table: layout === "表格" ? table : null,
    chips,
    highlight,
    takeaway: subtitle,
    bullets,
  };
}

/**
 * 一页的逐条校验
 *
 * 顺序很重要：先判标签 / 标题 / 副题 / 结论带的禁用词（页级问题只能丢页），
 * 再把超限字段截断，最后按布局补齐 / 回落——**任何一步都不许把一页的正文抹干净**。
 */
function normalizePage(item: unknown, index: number): PageResult {
  const where = `第 ${index + 1} 页`;
  if (typeof item !== "object" || item === null) {
    return { page: null, trimmed: 0, scrubbed: 0, notes: [`${where}不是页面对象，已丢弃`] };
  }
  const o = item as Record<string, unknown>;
  const title = cut(o["title"], PPT_LIMITS.titleChars);
  if (title.text === "") {
    return { page: null, trimmed: 0, scrubbed: 0, notes: [`${where}没有标题，已丢弃`] };
  }
  // 副题：新字段优先，缺则回退 #141 的 `takeaway`
  const subtitle = cut(o["subtitle"] ?? o["takeaway"], PPT_LIMITS.subtitleChars);
  const kicker = cut(o["kicker"], PPT_LIMITS.kickerChars);
  const highlight = cut(o["highlight"], PPT_LIMITS.highlightChars);
  const banned = pptBannedHit(
    `${kicker.text}｜${title.text}｜${subtitle.text}｜${highlight.text}`,
  );
  if (banned !== null) {
    return {
      page: null,
      trimmed: 0,
      scrubbed: 0,
      notes: [`${where}出现不能进客户材料的「${banned}」，已丢弃`],
    };
  }

  const notes: string[] = [];
  let trimmed =
    (title.truncated ? 1 : 0) +
    (subtitle.truncated ? 1 : 0) +
    (kicker.truncated ? 1 : 0) +
    (highlight.truncated ? 1 : 0);
  const { layout, note } = layoutOf(o["layout"]);
  if (note) notes.push(`${where}${note}`);

  const bullets = textList(o["bullets"], PPT_LIMITS.bullets.chars, PPT_LIMITS.bullets.max);
  const chips = textList(o["chips"], PPT_LIMITS.chips.chars, PPT_LIMITS.chips.max);
  const blocks = blocksOf(o["blocks"]);
  const cols = columnsOf(o["columns"]);
  const stages = stagesOf(o["stages"]);
  const layers = layersOf(o["layers"]);
  const cards = cardsOf(o["cards"]);
  const table = tableOf(o["table"]);
  trimmed +=
    bullets.trimmed +
    chips.trimmed +
    blocks.trimmed +
    cols.trimmed +
    stages.trimmed +
    layers.trimmed +
    cards.trimmed +
    table.trimmed;
  const scrubbed =
    bullets.scrubbed +
    chips.scrubbed +
    blocks.scrubbed +
    cols.scrubbed +
    stages.scrubbed +
    layers.scrubbed +
    cards.scrubbed +
    table.scrubbed;
  if (scrubbed > 0) notes.push(`${where}擦掉 ${scrubbed} 处不能进客户材料的内容`);

  // 兼容 #141：缺 `blocks` 但有 `bullets` → 转成 1–2 块（不足 3 块再由 settle 降级到要点清单）
  let normalizedBlocks = blocks.blocks;
  if (normalizedBlocks.length === 0 && bullets.items.length > 0) {
    normalizedBlocks = chunkToBlocks(bullets.items, title.text, notes, where);
  }
  // 小节标签缺失 → 用标题前 8 字兜底（胶囊必须存在，不然页面缺一个锚点）
  const kickerText = kicker.text === "" ? cut(title.text, PPT_LIMITS.kickerChars).text : kicker.text;
  if (kicker.text === "") notes.push(`${where}缺小节标签，用标题前 ${PPT_LIMITS.kickerChars} 字兜底`);
  // 结论带缺失 → 用副题（副题也空 → 用标题），保证每页都有一条
  const highlightText = highlight.text === "" ? subtitle.text || title.text : highlight.text;

  const page = settle({
    layout,
    kicker: kickerText,
    title: title.text,
    subtitle: subtitle.text,
    highlight: highlightText,
    blocks: normalizedBlocks,
    columns: cols.columns,
    stages: stages.stages,
    layers: layers.layers,
    cards: cards.cards,
    table: table.table,
    chips: chips.items,
    bullets: bullets.items,
    notes,
  });
  if (page === null) {
    return { page: null, trimmed, scrubbed, notes: [...notes, `${where}没有可展示的内容，已丢弃`] };
  }
  return { page, trimmed, scrubbed, notes };
}

/** 旧 `bullets` → 1–2 块（每块最多 4 行；块头用标题，第二块无头） */
function chunkToBlocks(
  bullets: readonly string[],
  title: string,
  notes: string[],
  where: string,
): PptBlock[] {
  const size = PPT_LIMITS.blocks.maxLines;
  const chunks: string[][] = [];
  for (let i = 0; i < bullets.length && chunks.length < 2; i += size) {
    chunks.push(bullets.slice(i, i + size));
  }
  notes.push(`${where}用的是旧 bullets 字段，已转成 ${chunks.length} 块`);
  return chunks.map((lines, i) => ({
    head: i === 0 ? cut(title, PPT_LIMITS.blocks.headChars).text : "",
    note: "",
    lines,
  }));
}

/** 整体失败值（调用方据此重试一次 / 提示"未导出 PPT"） */
function fail(error: string, notes: string[] = []): PptOutlineParse {
  return { outline: null, pages: 0, pageSentences: [], dropped: 0, trimmed: 0, scrubbed: 0, notes, error };
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
  const pageSentences: number[] = [];
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
    pageSentences.push(pptPageSentences(r.page));
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
  return { outline: { pages }, pages: pages.length, pageSentences, dropped, trimmed, scrubbed, notes };
}
