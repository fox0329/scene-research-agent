/**
 * @scene/domain — PPT 大纲的确定性校验与兜底（变更表 #141 立、#142 升；#146 升：大纲质量判据）
 *
 * 模型只产内容（一页页的小节标签、标题、副题、块/栏/阶段/层/卡片/表格/标签、结论带），
 * **能不能上这一页由本模块说了算**：页数规模、字段长度、各组数量、布局回落、
 * 禁用词（占位 / 决策建议 / 内部痕迹），全部在这里逐条判定。
 * 判定留在确定性层（AGENTS.md §三.5），渲染层因此可以假定拿到的页一定能画。
 *
 * 变更表 #146 再加一套**大纲质量判据**（`checkPptOutlineQuality`）：观点型标题、记忆点、
 * 每页信息量、数字可溯源、页间不重复、叙事顺序、自包含、图标与版式成套——见本文件末。
 * 导出编排拿它当"这份大纲够不够好"的唯一尺子，不合格**不报错**，而是带着问题清单重跑
 * （重新提取 → 优化 → 再检查），最多 `PPT_OUTLINE_ROUNDS` 轮。
 *
 * 变更表 #151 补两条：④ 的**中文数字**（`三成` / `五类` / `两倍` / `三分之一` / `百分之三十`
 * 与原阿拉伯数字同一条口径，语境不符的常见词一律不误报）、⑧ 的**图标重复**（同一页两个元素
 * 用同一个图标名要报；"图标数 ≥ 元素数"结构上必然成立，不单列）。
 *
 * 铁律：
 *  - 模型返回不合法 → 明确失败值（`outline: null` + `error`），调用方据此重试一次再兜底提示；
 *  - 页内字段超限 → **截断**（截断不许把一页的正文全部抹掉）；缺字段按布局回落，绝不产空版式；
 *  - 页数超上限 → 截掉尾部页面；不足下限 → 保留（无法凭空造页），只记提示。
 *
 * 纯函数、无 IO。
 */

import {
  PPT_DEFAULT_ICON,
  PPT_DEFAULT_LAYOUT,
  PPT_ICONS,
  PPT_LAYOUT_ALIASES,
  PPT_LIMITS,
  PPT_LAYOUTS,
  PPT_OUTLINE_QUALITY,
  normalizePptIcon,
  type PptBlock,
  type PptCard,
  type PptColumn,
  type PptIssue,
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

/**
 * 图标归一：模型给的名字必须在 `PPT_ICONS` 白名单里，否则回落 `PPT_DEFAULT_ICON`
 *
 * 判定留在确定性层（渲染层只负责画）：名字写错不该让整页崩，也不该让那一页空着没图标。
 */
function iconOf(value: unknown): string {
  return normalizePptIcon(value);
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
    blocks.push({ head: head.text, note: note.text, lines: lines.items, icon: iconOf(o["icon"]) });
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
    columns.push({ head: head.text, note: note.text, lines: lines.items, icon: iconOf(o["icon"]) });
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
    stages.push({ head: head.text, note: note.text, icon: iconOf(o["icon"]) });
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
    layers.push({ head: head.text, items: items.items, icon: iconOf(o["icon"]) });
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
    cards.push({ value: value0.text, label: label.text, icon: iconOf(o["icon"]) });
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

  const rawIcons = Array.isArray(o["icons"]) ? o["icons"] : [];
  const icons = head.map((_, i) => iconOf(rawIcons[i]));

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
  return { table: rows.length === 0 ? null : { head, rows, icons }, trimmed, scrubbed };
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
  icon: string;
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
  const { kicker, icon, title, subtitle, highlight, chips, notes } = args;
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
    icon,
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
    icon: iconOf(o["icon"]),
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
    icon: PPT_DEFAULT_ICON,
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

// ─── 大纲质量判据（变更表 #146） ──────────────────────────────
//
// 用户定调：「不是不满足标准就报错或者什么的，而是重新从文件提取大纲，优化大纲，然后再优化 PPT，
// 保证高质量」——所以这套判据**不用来拒绝导出**，而是用来生成"下一轮要改什么"的问题清单。
// 词表与阈值全部来自契约 `PPT_OUTLINE_QUALITY`（提示词同源），这里只做判定。

/** 大纲质量的问题码（每一条都对应 §八 里的一条明确要求） */
export const PPT_OUTLINE_ISSUE_CODES = [
  "非观点型标题",
  "标题超长",
  "缺记忆点",
  "信息量不足",
  "数字不在正文",
  "两页重复",
  "叙事顺序错",
  "不自包含",
  "图标不合规",
  "图标重复",
  "版式与字段不成套",
] as const;

export type PptOutlineQualityCode = (typeof PPT_OUTLINE_ISSUE_CODES)[number];

/** 一条大纲质量问题（形状与版面门禁的 `PptQualityIssue` 一致，便于合成一条反馈） */
export interface PptOutlineQualityIssue extends PptIssue {
  code: PptOutlineQualityCode;
}

/**
 * 某种版式**结构上最多能写几条**有效短句
 *
 * 存在的理由：`流程阶段`（5 段 × head+note = 10）、`数据卡片`（4 张 × value+label = 8）、
 * `要点清单`（6 行）**结构上就到不了 12 条**——对它们只能要求"把字段写满"，
 * 否则这两类版式永远不合格、notice 永远在点名（判据必须可满足，见 §八.4）。
 */
export function pptLayoutSentenceMax(layout: PptLayout): number {
  switch (layout) {
    case "网格要点":
      return PPT_LIMITS.blocks.count * (2 + PPT_LIMITS.blocks.maxLines);
    case "双栏对比":
      return PPT_LIMITS.columns.count * (2 + PPT_LIMITS.columns.maxLines);
    case "流程阶段":
      return PPT_LIMITS.stages.max * 2;
    case "分层架构":
      return PPT_LIMITS.layers.max * (1 + PPT_LIMITS.layers.maxItems);
    case "数据卡片":
      return PPT_LIMITS.cards.max * 2;
    case "表格":
      return PPT_LIMITS.table.maxCols + PPT_LIMITS.table.maxRows * PPT_LIMITS.table.maxCols;
    default:
      return PPT_LIMITS.bullets.max;
  }
}

/** 这一页要求的最低有效短句数（版式上限不足 12 条的，按"写满"算） */
export function pptPageSentenceBar(layout: PptLayout): number {
  return Math.min(PPT_OUTLINE_QUALITY.minSentencesPerPage, pptLayoutSentenceMax(layout));
}

/** 一页的全部文字（判数字 / 重复 / 自包含用；顺序稳定、去掉空串与重复项） */
function pageTexts(page: PptPage): string[] {
  const out: string[] = [page.kicker, page.title, page.subtitle, page.highlight, ...page.chips];
  for (const b of page.blocks) out.push(b.head, b.note, ...b.lines);
  for (const c of page.columns) out.push(c.head, c.note, ...c.lines);
  for (const s of page.stages) out.push(s.head, s.note);
  for (const l of page.layers) out.push(l.head, ...l.items);
  for (const c of page.cards) out.push(c.value, c.label);
  if (page.table !== null) out.push(...page.table.head, ...page.table.rows.flat());
  out.push(...(page.bullets ?? []));
  return [...new Set(out.map((t) => t.trim()).filter((t) => t !== ""))];
}

/**
 * 一页在叙事线上的位置（`group` = -1 表示这一页不参与顺序判定）
 *
 * `field` 是命中的那个字段（`kicker` / `title`），`hit` 是命中的那个词——都只为把问题说清楚。
 */
interface NarrativeHit {
  group: number;
  hit: string;
  fieldLabel: string;
}

const NO_NARRATIVE: NarrativeHit = { group: -1, hit: "", fieldLabel: "" };

/** 归一化后按"**等值或以该词开头**"匹配词表（不是"出现过"：「把机制用起来」不算问题页） */
function wordsHit(text: string, words: readonly string[]): string | null {
  const norm = text.replace(/\s+/g, "");
  if (norm === "") return null;
  return words.find((word) => norm === word || norm.startsWith(word)) ?? null;
}

/**
 * 一页归到叙事线的哪一段（变更表 #146 补充 2）
 *
 * 规则（真跑被误报坑过一轮又一轮，所以收紧）：
 * ① **只看 `kicker`**（模型给这一页定的栏目名，最可靠），`kicker` 归不进**才**看 `title`；
 *    `subtitle` / `highlight` / 块内容一律不参与——一页标题写「四类问题一起解决」不是"问题页"。
 * ② 匹配是**等值或以词开头**，不是"出现过"——末页「把机制用起来，问题不回潮」不归类。
 * ③ **末页豁免**：末页归到 `narrativeClosing`（展望 / 保障 / 下一步 / 监管 / 协同）整页不判——
 *    收尾回望问题是正常的，把它算成"问题页"排到方案页之后是纯误报。
 */
function narrativeGroupOf(page: PptPage, isLast: boolean): NarrativeHit {
  for (const [fieldLabel, text] of [
    ["小节标签", page.kicker],
    ["标题", page.title],
  ] as const) {
    const hit = wordsHit(text, PPT_OUTLINE_QUALITY.narrative.flatMap((g) => g.words));
    if (hit === null) continue;
    if (isLast && wordsHit(text, PPT_OUTLINE_QUALITY.narrativeClosing.words) !== null) return NO_NARRATIVE;
    const group = PPT_OUTLINE_QUALITY.narrative.findIndex((g) => (g.words as readonly string[]).includes(hit));
    return { group, hit, fieldLabel };
  }
  return NO_NARRATIVE;
}

/** 判重用的归一化：去掉空白与标点，只比"说的是不是同一件事" */
function normalizeForCompare(text: string): string {
  return text.replace(/[\s，。、；：！？（）()【】《》「」“”"'·—\-…,.!?;:%％|｜]/g, "");
}

/** 数字比对用的归一化：全角数字折半角、全角百分号折半角、去掉空白 */
function normalizeForNumber(text: string): string {
  return text
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\uFF05/g, "%")
    .replace(/\s+/g, "");
}

const CN_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"] as const;

/** 阿拉伯数字 → 中文数字（0–99；范围外给 null，不做过度换算） */
function cnNumberOf(value: number): string | null {
  if (!Number.isInteger(value) || value < 0 || value > 99) return null;
  if (value < 10) return CN_DIGITS[value]!;
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return `${tens === 1 ? "" : CN_DIGITS[tens]}十${ones === 0 ? "" : CN_DIGITS[ones]}`;
}

/** 量词（中文数字写法只在带量词时才算数，避免「统一」里的「一」把 1 洗白） */
const CN_QUANTIFIERS =
  "个|台|间|倍|天|小时|分钟|周|月|年|万|亿|元|次|人|张|条|层|块|列|行|页|项|套|辆|米|户|家|所|种|类|份|组|批|级|处|分|秒|件";

/** 中文数字的字（与契约 `numberCnPattern` 同一批字；`零` 不收——「零故障」这类词太常见） */
const CN_CHARS = /[一二三四五六七八九十百千万两俩半]/;

/** 中文数字的「字 → 值」（`两` / `俩` = 2） */
const CN_DIGIT_VALUE: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  俩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 中文数字的「位 → 权」 */
const CN_UNIT_VALUE: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

/**
 * 中文数字 → 数值（变更表 #151）
 *
 * 只认 `一–九` / `两` / `俩` / `十百千万`；出现别的字（含 `半`）返回 null——换算不出来就不换算，
 * 只按原样比对（`半小时` 这类没有干净阿拉伯写法的写法不受影响）。
 */
function cnNumberValue(text: string): number | null {
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of text) {
    const value = CN_DIGIT_VALUE[ch];
    if (value !== undefined) {
      digit = value;
      continue;
    }
    const unit = CN_UNIT_VALUE[ch];
    if (unit === undefined) return null;
    if (unit === 10000) {
      section = (section + (digit === 0 ? 1 : digit)) * 10000;
      total += section;
      section = 0;
      digit = 0;
      continue;
    }
    section += (digit === 0 ? 1 : digit) * unit;
    digit = 0;
  }
  return total + section + digit;
}

/**
 * 数字部分像不像"一个数"（变更表 #151）
 *
 * 必须含 `一–九` / `两` / `俩` / `半`，或**正好是 `十`**；光杆的 `十/百/千/万` 是"单位词"不算数——
 * 「万元」「百米」「千万」「百般」正是靠这一条挡掉的（`十分钟` / `十项` 因为正好是 `十` 仍算数）。
 * 另外**单独一个 `一`** 不算（「一个平台」「一次说清」「一度」「一成不变」都是口头语，不是数字）。
 */
function cnNumeralOk(numeral: string): boolean {
  if (numeral === "一") return false;
  if (numeral === "十") return true;
  if (/[二三四五六七八九两俩半]/.test(numeral)) return true;
  return /^一[十百千万]/.test(numeral);
}

/**
 * 一段文字里"像数值"的中文数字（变更表 #151）
 *
 * 三个分支全在契约 `PPT_OUTLINE_QUALITY.numberCnPattern` 里（提示词与判据同源），这里只做两件
 * 契约表达不了的事：① 用捕获组取数字部分做 `cnNumeralOk`（分数式是数学语境，不判）；
 * ② 同一段里重复的只留一个。
 */
function cnNumberTokens(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(new RegExp(PPT_OUTLINE_QUALITY.numberCnPattern, "g"))) {
    const token = m[0];
    // 组 1 / 2 是分数式（三分之一、百分之三十）；组 3 是「数字 + 单位」的数字部分；光杆分支没有组
    const numeral = m[3] ?? (m[1] === undefined ? token : "");
    if (numeral !== "" && !cnNumeralOk(numeral)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * 中文数字 token 的阿拉伯等价写法（变更表 #151）
 *
 * 与 `numberGrounded` 的反向宽容对称：大纲写「三成」而正文写「3 成」也算对得上。
 * 三种写法都给：`三成` → `3成`、`百分之三十` → `百分之30` / `30%`、`三分之一` → `1/3`；
 * 换算不出来（含 `半` 等）就一个都不给——只认原样。
 */
function cnTokenVariants(token: string): string[] {
  const out: string[] = [];
  const percent = /^百分之(.+)$/.exec(token);
  if (percent !== null) {
    const value = cnNumberValue(percent[1]!);
    // 「百分之X」要单独走：整串替换会把「百」也算成 100（`百分之三十` → `100分之30`），
    // 而正文里真正会出现的写法是「百分之30」与「30%」
    if (value !== null) out.push(`百分之${value}`, `${value}%`);
  } else {
    const frac = /^(.+?)分之(.+)$/.exec(token);
    const left = frac === null ? null : cnNumberValue(frac[1]!);
    const right = frac === null ? null : cnNumberValue(frac[2]!);
    // 中文分数的读法是「分母分之分子」（三分之一 = 1/3），所以斜杠写法要倒过来
    if (left !== null && right !== null) out.push(`${right}/${left}`);
    // 只把分子换成阿拉伯数字的混合写法（正文写「3分之一」）
    if (left !== null && frac !== null) out.push(`${left}分之${frac[2]!}`);
  }
  const substituted = token.replace(/[一二三四五六七八九十百千万两俩半]+/g, (run) => {
    const value = cnNumberValue(run);
    return value === null ? run : String(value);
  });
  if (substituted !== token) out.push(substituted);
  return out;
}

/**
 * 这个数字在报告正文里找得到吗（**防编造**，硬判据）
 *
 * 比对宽容三处（宁可放过一处改写，也不误杀）：① 全角/半角与空白差异；
 * ② 整数允许正文写的是中文数字（「八个环节」↔「8 个环节」），但**要求带量词**；
 * ③ 变更表 #151：大纲里的**中文数字**允许正文写阿拉伯数字（「三成」↔「3 成」、
 *    「百分之三十」↔「30%」），反向也认（正文写「百分之三十」兜住大纲里的 30）。
 */
function numberGrounded(token: string, mdNorm: string): boolean {
  if (mdNorm.includes(token)) return true;
  if (CN_CHARS.test(token)) return cnTokenVariants(token).some((v) => mdNorm.includes(v));
  const cn = cnNumberOf(Number(token));
  if (cn === null) return false;
  if (new RegExp(`${cn}(?:${CN_QUANTIFIERS})`).test(mdNorm)) return true;
  return mdNorm.includes(`百分之${cn}`) || mdNorm.includes(`${cn}%`);
}

/** 观点型标题的判定（返回命中的空词；null = 不弱） */
function weakTitleHit(title: string): string | null {
  const norm = normalizeForCompare(title);
  for (const word of PPT_OUTLINE_QUALITY.weakTitleWords) {
    if (!norm.includes(word)) continue;
    const rest = norm.split(word).join("");
    if (norm.length < PPT_OUTLINE_QUALITY.weakTitleShortChars || rest.length < PPT_OUTLINE_QUALITY.weakTitleRestChars) {
      return word;
    }
  }
  return null;
}

/** 标题有没有判断语气（含动词 / 判断词 / 数字即可——词表宁宽不严，不做过度 NLP） */
function hasJudgment(title: string): boolean {
  const norm = normalizeForCompare(title);
  if (/\d/.test(norm)) return true;
  return PPT_OUTLINE_QUALITY.judgmentWords.some((w) => norm.includes(w));
}

/** 版式与字段是否成套（沿用 `parsePptOutline` 的同一组限额，不重复实现降级） */
function layoutFieldDefect(page: PptPage): string | null {
  const l = PPT_LIMITS;
  switch (page.layout) {
    case "网格要点":
      return page.blocks.length >= l.blocks.min ? null : `声明了「网格要点」却只有 ${page.blocks.length} 块（要 ${l.blocks.min}–${l.blocks.count} 块）`;
    case "双栏对比":
      return page.columns.length >= l.columns.count ? null : `声明了「双栏对比」却只有 ${page.columns.length} 栏（要 ${l.columns.count} 栏）`;
    case "流程阶段":
      return page.stages.length >= l.stages.min && page.stages.length <= l.stages.max
        ? null
        : `声明了「流程阶段」却有 ${page.stages.length} 个阶段（要 ${l.stages.min}–${l.stages.max} 个）`;
    case "分层架构":
      return page.layers.length >= l.layers.min && page.layers.length <= l.layers.max
        ? null
        : `声明了「分层架构」却有 ${page.layers.length} 层（要 ${l.layers.min}–${l.layers.max} 层）`;
    case "数据卡片":
      return page.cards.length >= l.cards.min && page.cards.length <= l.cards.max
        ? null
        : `声明了「数据卡片」却有 ${page.cards.length} 张（要 ${l.cards.min}–${l.cards.max} 张）`;
    case "表格":
      if (page.table === null) return "声明了「表格」却没给合规 table";
      if (page.table.head.length < 2) return `表格只有 ${page.table.head.length} 列（至少要 2 列）`;
      return page.table.rows.length === 0 ? "表格只有表头、没有数据行" : null;
    default:
      return (page.bullets ?? []).length >= l.bullets.min
        ? null
        : `「要点清单」只有 ${(page.bullets ?? []).length} 行（要 ${l.bullets.min}–${l.bullets.max} 行）`;
  }
}

/** 一页的图标名清单（页图标 + 每个块/栏/阶段/层/卡片 + 表头列） */
function pageIcons(page: PptPage): string[] {
  const out = [page.icon];
  for (const b of page.blocks) out.push(b.icon);
  for (const c of page.columns) out.push(c.icon);
  for (const s of page.stages) out.push(s.icon);
  for (const l of page.layers) out.push(l.icon);
  for (const c of page.cards) out.push(c.icon);
  if (page.table !== null) out.push(...page.table.icons);
  return out;
}

/** 一页的标题问题（观点型 / 超长 / 空词） */
function titleIssues(page: PptPage, index: number): PptOutlineQualityIssue[] {
  const out: PptOutlineQualityIssue[] = [];
  const page1 = index + 1;
  const title = page.title.trim();
  if (Array.from(title).length > PPT_LIMITS.titleChars) {
    out.push({
      code: "标题超长",
      page: page1,
      detail: `标题「${title}」有 ${Array.from(title).length} 字，超过 ${PPT_LIMITS.titleChars} 字`,
    });
  }
  const weak = weakTitleHit(title);
  if (weak !== null) {
    out.push({
      code: "非观点型标题",
      page: page1,
      detail: `标题「${title}」是章节式空词（命中「${weak}」）——标题必须是一句判断 / 结论`,
    });
    return out;
  }
  if (Array.from(title).length <= PPT_OUTLINE_QUALITY.weakTitleShortChars && !hasJudgment(title)) {
    // #146 补充：**只在短标题上**要求判断语气——口径是「≤8 字且不含判断词」
    // （真跑误报：「四层架构加一脑一平台」11 字、没有动词，却是一句合格的架构页标题）
    out.push({
      code: "非观点型标题",
      page: page1,
      detail: `标题「${title}」看不出观点（${Array.from(title).length} 字、也没有动词/判断词）——要写成一句话的判断`,
    });
  }
  return out;
}

/** 一页的记忆点问题（`highlight` 必须非空且不超字） */
function highlightIssues(page: PptPage, index: number): PptOutlineQualityIssue[] {
  const text = page.highlight.trim();
  const page1 = index + 1;
  if (text === "") {
    return [
      {
        code: "缺记忆点",
        page: page1,
        detail: `没有记忆点（highlight 为空）——每页都要有一句 ≤ ${PPT_OUTLINE_QUALITY.highlightChars} 字、能记住的结论`,
      },
    ];
  }
  const len = Array.from(text).length;
  if (len > PPT_OUTLINE_QUALITY.highlightChars) {
    return [
      {
        code: "缺记忆点",
        page: page1,
        detail: `记忆点「${text}」有 ${len} 字，超过 ${PPT_OUTLINE_QUALITY.highlightChars} 字（记忆点要短到能记住）`,
      },
    ];
  }
  return [];
}

/** 一页的数字可溯源问题（每个数字都要在报告正文里出现；阿拉伯与中文数字同一口径） */
function numberIssues(page: PptPage, index: number, mdNorm: string): PptOutlineQualityIssue[] {
  const out: PptOutlineQualityIssue[] = [];
  const seen = new Set<string>();
  for (const text of pageTexts(page)) {
    const norm = normalizeForNumber(text);
    const tokens = [
      ...(norm.match(new RegExp(PPT_OUTLINE_QUALITY.numberPattern, "g")) ?? []),
      // 变更表 #151：中文数字（三成 / 五类 / 十二项 / 三十 / 两倍 / 半小时 / 三分之一 / 百分之三十）
      ...cnNumberTokens(norm),
    ];
    for (const token of tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      if (numberGrounded(token, mdNorm)) continue;
      out.push({
        code: "数字不在正文",
        page: index + 1,
        detail: `数字「${token}」在报告正文里找不到（数字只能照抄正文，不许换算、加总、估）`,
      });
    }
  }
  return out;
}

/**
 * 「目录」是不是被当成了一页的**结构性标签**（变更表 #146 补充）
 *
 * 报告正文里「目录」是正当内容词（「按客户信创目录逐项核定」「设备目录」），禁它的本意是
 * **不许做目录页**，所以只在页面的框（kicker / title / subtitle / highlight）上、且整格就是
 * 「目录 / 内容目录 / …」或以「目录」结尾（≤ `dirLabelMaxChars` 字）时才算。
 */
function dirLabelHit(text: string): string | null {
  const norm = text.replace(/\s+/g, "");
  if (norm === "") return null;
  if ((PPT_OUTLINE_QUALITY.selfContainedDirLabels as readonly string[]).includes(norm)) return norm;
  return norm.endsWith("目录") && norm.length <= PPT_OUTLINE_QUALITY.dirLabelMaxChars ? norm : null;
}

/** 一页的自包含问题（不许写"参考正文""详见报告"这类指路话，也不许出现目录页的痕迹） */
function selfContainedIssues(page: PptPage, index: number): PptOutlineQualityIssue[] {
  const out: PptOutlineQualityIssue[] = [];
  // ① 结构性标签：只看"这一页的框"——目录页的痕迹只会留在标题/副题/小节标签/结论带上
  for (const text of [page.kicker, page.title, page.subtitle, page.highlight]) {
    const label = dirLabelHit(text);
    if (label === null) continue;
    out.push({
      code: "不自包含",
      page: index + 1,
      detail: `出现「${label}」——PPT 不做目录页，每页都要直接写内容（这是独立文件，不靠页间指路）`,
    });
  }
  // ② 指路话：正文条目里也不许出现（「目录」不在此列，见上面的说明）
  for (const text of pageTexts(page)) {
    const hit = PPT_OUTLINE_QUALITY.selfContainedBanned.find((word) => text.includes(word));
    if (hit === undefined) continue;
    out.push({
      code: "不自包含",
      page: index + 1,
      detail: `出现「${hit}」——PPT 是独立文件，每页都要直接写清（不许"参考正文 / 详见报告"这类指路话，也不许"建议采用 / 谢谢观看"这类与这一页无关的话）`,
    });
    if (out.length >= PPT_OUTLINE_QUALITY.duplicatePerPage) break;
  }
  return out;
}

/**
 * 一页的图标重复问题（变更表 #151）
 *
 * 用户原本要的是"图标与字段 / 标题的关键词不匹配就报"，但"图标含义贴不贴切"没有可靠判定依据，
 * 硬做只会制造误报、让 PPT 白跑轮次。换成这条**客观可判**的：同一页两个元素用同一个图标名
 * （一页里重复用同一个图标 = 单调且失去区分度）。**不判**"图标数与元素数"——领域层 `iconOf`
 * 会给每个元素兜一个图标、渲染层还会画页图标与结论带 bulb，那条线结构上必然成立（见契约
 * `PPT_OUTLINE_QUALITY.iconReuseBanned`）。
 */
function iconReuseIssues(page: PptPage, index: number): PptOutlineQualityIssue[] {
  const counts = new Map<string, number>();
  for (const name of pageIcons(page)) counts.set(name, (counts.get(name) ?? 0) + 1);
  const out: PptOutlineQualityIssue[] = [];
  for (const [name, count] of counts) {
    if (count < 2) continue;
    out.push({
      code: "图标重复",
      page: index + 1,
      detail: `第 ${index + 1} 页把图标「${name}」用了 ${count} 次（同一页的每个块 / 栏 / 阶段 / 层 / 卡片 / 表头列各给一个不同的图标）`,
    });
  }
  return out;
}

/** 一页的图标与版式问题 */
function shapeIssues(page: PptPage, index: number): PptOutlineQualityIssue[] {
  const out: PptOutlineQualityIssue[] = [];
  const page1 = index + 1;
  const bad = pageIcons(page).filter((name) => !(PPT_ICONS as readonly string[]).includes(name));
  if (bad.length > 0) {
    out.push({
      code: "图标不合规",
      page: page1,
      detail: `图标名 ${[...new Set(bad)].map((n) => `「${n}」`).join("、")} 不在白名单里（只能从 ${PPT_ICONS.length} 个名字里选，选不出用 ${PPT_DEFAULT_ICON}）`,
    });
  }
  if (PPT_OUTLINE_QUALITY.iconReuseBanned) out.push(...iconReuseIssues(page, index));
  if (page.table !== null && page.table.icons.length !== page.table.head.length) {
    out.push({
      code: "图标不合规",
      page: page1,
      detail: `table.icons 有 ${page.table.icons.length} 个、表头有 ${page.table.head.length} 列，要一一对应`,
    });
  }
  const defect = layoutFieldDefect(page);
  if (defect !== null) out.push({ code: "版式与字段不成套", page: page1, detail: defect });
  return out;
}

/**
 * 判"像不像一句话"用的词（变更表 #146 补充 2）：只取 `judgmentWords` 里**两个字以上**的
 *
 * 单字动词（走 / 用 / 定 / 核…）是为**标题**判定收的"宁宽不严"，拿来判句子会误命中——
 * 真跑报过「人走自动释放」（命中「走」）这种 6 字动作短语。判句子的词只能是多字的。
 */
const SENTENCE_WORDS = PPT_OUTLINE_QUALITY.judgmentWords.filter((word) => Array.from(word).length >= 2);

/**
 * 这一条像不像"一句话"（变更表 #146 补充）
 *
 * 页间重复要抓的是"两页说了同一件事"，不是"两页都提到了同一个名词"：真跑误报了
 * 「人体存在传感器」——第 4 页讲建设内容、第 5 页讲设备清单各提一次是正常的。
 * 所以重复项必须满足任一条：① 含标点；② 归一化后 ≥ `duplicateSentenceMinChars` 字；
 * ③ 含两个字的判断/动作词（`SENTENCE_WORDS`）。纯名词/动作短语一律不判。
 */
function isSentenceLike(text: string, norm: string): boolean {
  if (new RegExp(`[${PPT_OUTLINE_QUALITY.duplicatePunct}]`).test(text)) return true;
  if (norm.length >= PPT_OUTLINE_QUALITY.duplicateSentenceMinChars) return true;
  return SENTENCE_WORDS.some((word) => norm.includes(word));
}

/** 页间重复（归一化后同一句话出现在两页就要报，并指出两页页号；专有名词不算） */
function duplicateIssues(pages: readonly PptPage[]): PptOutlineQualityIssue[] {
  const out: PptOutlineQualityIssue[] = [];
  const first = new Map<string, number>();
  const reported = new Map<number, number>();
  for (const [i, page] of pages.entries()) {
    const counts = reported.get(i + 1) ?? 0;
    let hits = counts;
    for (const text of pageTexts(page)) {
      const norm = normalizeForCompare(text);
      if (norm.length < PPT_OUTLINE_QUALITY.duplicateMinChars) continue;
      if (!isSentenceLike(text, norm)) continue;
      const at = first.get(norm);
      if (at === undefined) {
        first.set(norm, i + 1);
        continue;
      }
      if (at === i + 1 || hits >= PPT_OUTLINE_QUALITY.duplicatePerPage) continue;
      hits += 1;
      out.push({
        code: "两页重复",
        page: i + 1,
        detail: `第 ${at} 页与第 ${i + 1} 页说了同一件事：「${text}」（同一句话不许出现在两页）`,
      });
    }
    reported.set(i + 1, hits);
  }
  return out;
}

/**
 * 叙事顺序（问题 → 方案 → 价值；**只比三个组各自第一次出现的页码**，变更表 #146 补充 2）
 *
 * 为什么不再"逐页非递减"：那一页讲保障、风险回潮、监管配合这类内容再正常不过，逐页比会把它们
 * 全当成"顺序错"，而且每轮换一批（模型被假问题牵着改，越改越乱）。现在只要求
 * `首次(问题) < 首次(方案) < 首次(价值)`——三组各自第一次出现的位置对就行，
 * 中间夹多少页、夹的是什么组都不管。三组里缺哪组就只比剩下两组。
 */
function narrativeIssues(pages: readonly PptPage[]): PptOutlineQualityIssue[] {
  const out: PptOutlineQualityIssue[] = [];
  const firstAt = new Map<number, { page: number; hit: string; fieldLabel: string }>();
  for (const [i, page] of pages.entries()) {
    const hit = narrativeGroupOf(page, i === pages.length - 1);
    if (hit.group < 0 || firstAt.has(hit.group)) continue;
    firstAt.set(hit.group, { page: i + 1, hit: hit.hit, fieldLabel: hit.fieldLabel });
  }
  const describe = (group: number): string => {
    const at = firstAt.get(group);
    return at === undefined
      ? ""
      : `第 ${at.page} 页讲的是「${PPT_OUTLINE_QUALITY.narrative[group]!.label}」（${at.fieldLabel}「${at.hit}」）`;
  };
  // 两两比：先出现的组必须页码更小；谁排错了就点谁的名
  for (const [before, after] of [
    [0, 1],
    [1, 2],
  ] as const) {
    const a = firstAt.get(before);
    const b = firstAt.get(after);
    if (a === undefined || b === undefined || a.page < b.page) continue;
    out.push({
      code: "叙事顺序错",
      page: a.page,
      detail: `${describe(before)}，却排在第 ${b.page} 页「${PPT_OUTLINE_QUALITY.narrative[after]!.label}」（${b.fieldLabel}「${b.hit}」）之后（叙事线只能是 问题 → 方案 → 价值）`,
    });
  }
  return out.sort((x, y) => x.page - y.page);
}

/**
 * 一份大纲的质量判据（变更表 #146）
 *
 * @param outline 已经过 `parsePptOutline` 归一的大纲（也可以用别处构造的同形对象）
 * @param markdown 这份 PPT 的来源**报告正文**（判"数字是不是编的"唯一依据）
 * @returns 逐条问题（空数组 = 大纲合格）；**调用方不许拿它拒绝导出**，它是"下一轮改什么"的输入
 *
 * 输出按 `问题码 + 页码 + detail` 去重（变更表 #146 补充）：同一页同一个词命中两次会产出两条
 * 一字不差的问题，喂给下一轮提示词会让模型以为有两处。
 */
export function checkPptOutlineQuality(
  outline: PptOutline,
  markdown: string,
): PptOutlineQualityIssue[] {
  const mdNorm = normalizeForNumber(markdown);
  const out: PptOutlineQualityIssue[] = [];
  for (const [i, page] of outline.pages.entries()) {
    out.push(...titleIssues(page, i));
    out.push(...highlightIssues(page, i));
    const bar = pptPageSentenceBar(page.layout);
    const sentences = pptPageSentences(page);
    if (sentences < bar) {
      out.push({
        code: "信息量不足",
        page: i + 1,
        detail: `只有 ${sentences} 条有效短句，少于 ${bar} 条（${page.layout}最多写 ${pptLayoutSentenceMax(page.layout)} 条，要写满）`,
      });
    }
    out.push(...numberIssues(page, i, mdNorm));
    out.push(...selfContainedIssues(page, i));
    out.push(...shapeIssues(page, i));
  }
  out.push(...duplicateIssues(outline.pages));
  out.push(...narrativeIssues(outline.pages));
  const seen = new Set<string>();
  return out.filter((issue) => {
    const key = `${issue.code}|${issue.page}|${issue.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
