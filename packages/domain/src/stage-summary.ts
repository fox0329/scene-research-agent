/**
 * stage-summary — 阶段总结文档生成（对应 04 §五）
 *
 * 两种口径：
 *  - `buildStageSummary`：整篇六段骨架 Markdown（交付物装配仍用它，输出不变）
 *  - `buildStageBrief`：右栏「阶段总结」要点视图（v2.10 用户定调）——只给两块：
 *    ① 调研信息来源的**可打开源地址** ② 由表内真实字段确定性推导的**结论提醒**
 *
 * 整篇总结**围绕一个范围**展开，**不给无依据的决策建议**（是否该进由用户自己定），
 * 但**每条信息都必须带核实判定**（准确吗·客观吗·为什么——v1.27 用户定调）；
 * 要点视图（brief）里的「结论提醒」只由**表里的真实字段 + 固定规则**推导，
 * 不调模型、不编造（用户定调 2026-10-21：「关于这个阶段的几个重点的结论性的提醒或建议」）：
 *  - `scope: "step"`（右栏默认，v2.9）：**只讲本步**——表集限本步、不含用户诉求全文、
 *    不含上下游衔接（用户定调："右栏的补充说明和阶段总结只针对当前阶段做说明和总结，
 *    不要整理整个过程"）
 *  - `scope: "stage"`（交付物装配用）：阶段级归纳，开头带诉求基准、结尾带上下游衔接
 *
 * 关键设计：**确定性生成**——由阶段信息行 + 完整度报告 + 注册表推导，
 * 不需要 LLM（更稳、可测、零成本）。LLM 只用于可选润色，不是必需路径。
 */

import {
  STAGE_DEFS,
  TABLES,
  flowStep,
  middleColumns,
  stageDef,
  tableDef,
  tablesOfStage,
  type InfoStageId,
  type TableDef,
} from "@scene/contract";
import { gapsToSummaryLines, isEmptyValue, type InfoRow, type StageCompleteness } from "./completeness.js";
import { isHttpUrl, normalizeUrl } from "./web-url.js";

/** 资料库表在总结里的显示名：表号不露出；M4/M5 合并口径写清「不做/限制」 */
function tableLabel(t: TableDef): string {
  if (t.code === "M4") return "边界与限制（不做）";
  if (t.code === "M5") return "边界与限制（限制）";
  if (/^M[1-6]$/u.test(t.code) || t.code === t.name) return t.name;
  return `${t.code} ${t.name}`;
}

/** 产出/引用清单用短名：资料库表用中文名，其他表只写表号（列表里不重复表名） */
function tableRef(t: TableDef): string {
  if (/^M[1-6]$/u.test(t.code) || t.code === t.name) return tableLabel(t);
  return t.code;
}

export interface StageSummaryInput {
  stage: InfoStageId;
  /**
   * 本份总结覆盖的表集（缺省 = 本阶段全部表）
   *
   * 右栏按**当前步骤**传本步表集：阶段 1 横跨第 1、2 两步（表1-1 归第 1 步），
   * 不限定表集就会在第 2 步的总结里再讲一遍场景定义。
   */
  tableCodes?: readonly string[];
  /**
   * 步骤号（右栏口径）：给了就用**本步的标题与目标**做抬头与摘要首句，
   * 抬头从「阶段 1 · 认识场景」变成「第 2 步 · 认识场景」
   */
  step?: number;
  /**
   * 总结范围（v2.9）
   *
   * - `step`（右栏默认）：只讲本步——跳过用户诉求全文与「上下游衔接」
   * - `stage`（交付物装配）：阶段级归纳，含诉求基准与上下游衔接
   */
  scope?: "step" | "stage";
  /**
   * 一条提醒都推导不出时的兜底文案（可缺）
   *
   * 交付物步没有自己的表，它汇总的是前面所有产出；此时再说「本步还没有判据」
   * 会让用户以为整条链都没产出，必须换成「前面还没有…」的口径。
   */
  fallbackAdvice?: string;
  scenarioName: string;
  /** 产品线名（可缺） */
  productLineName?: string;
  /** 表号 → 行 */
  rowsByTable: Readonly<Record<string, readonly InfoRow[] | undefined>>;
  /** 完整度报告（由 checkStageCompleteness 产出） */
  completeness: StageCompleteness;
  /** 用户诉求原文（第一输入，作为文档开头的基准） */
  briefRawText?: string;
  /** 生成时间（可注入，便于测试） */
  generatedAt?: string;
}

/** 取一行里第一个非空业务值（用于给行起名——行标识） */
function firstValue(row: InfoRow, keys: readonly string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (!isEmptyValue(v)) return String(v).trim();
  }
  return "";
}

/** 取一行里最多 n 个非空业务值（用于关键信息清单的取值样例，比只有标识更有信息量） */
function valuesOf(row: InfoRow, keys: readonly string[], n = 2): string {
  const out: string[] = [];
  for (const k of keys) {
    const v = row[k];
    if (!isEmptyValue(v)) out.push(String(v).trim());
    if (out.length >= n) break;
  }
  return out.join("·");
}

/**
 * 权威性分布的文案（第一、第四节共用）
 *
 * v1.27 修：第四节原来只印 T1-T4，漏了「未标」——当整阶段都没标权威性时，
 * 第四节会显示「T1 0 / T2 0 / T3 0 / T4 0；不同来源共 3 个」，自相矛盾。
 */
function authoritySummary(dist: Record<string, number>, unit = ""): string {
  const parts = (["T1", "T2", "T3", "T4"] as const).map((k) => `${k} ${dist[k]}${unit}`);
  if (dist["未标"]) parts.push(`未标 ${dist["未标"]}${unit}`);
  return parts.join(" / ");
}

/** 来源权威性分布（T1-T4） */
function authorityDistribution(rows: readonly InfoRow[]): Record<string, number> {
  const dist: Record<string, number> = { T1: 0, T2: 0, T3: 0, T4: 0, 未标: 0 };
  for (const row of rows) {
    const a = String(row["source_authority"] ?? row["authority"] ?? "").trim();
    dist[a in dist ? a : "未标"] = (dist[a in dist ? a : "未标"] ?? 0) + 1;
  }
  return dist;
}

/** 一行信息 + 它属于哪张表（保证起名/取列时用对表） */
interface RowEntry {
  code: string;
  row: InfoRow;
}

/** 汇总本阶段全部行，并保留表的归属 */
function allEntries(input: StageSummaryInput, tables: readonly TableDef[]): RowEntry[] {
  const out: RowEntry[] = [];
  for (const t of tables) {
    for (const row of input.rowsByTable[t.code] ?? []) out.push({ code: t.code, row });
  }
  return out;
}

/** 核实结论的五个取值（顺序：从最强到最弱） */
export const VERIFICATION_VERDICTS = [
  "已核实",
  "交叉一致",
  "行业通例",
  "单一来源",
  "无法核实",
  "有反证",
] as const;

/** 取一行的核实结论；早期数据没有该列时算「未核」 */
export function verificationVerdict(row: Record<string, unknown>): string {
  const v = String(row["verification_verdict"] ?? "").trim();
  return v === "" ? "未核" : v;
}

/** 本份总结覆盖的表（按给定顺序；`tableCodes` 缺省 = 本阶段全部表） */
function tablesFor(input: StageSummaryInput): TableDef[] {
  if (!input.tableCodes) return [...tablesOfStage(input.stage)];
  return input.tableCodes
    .map((c) => tableDef(c))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));
}


/** 给一行起个可读标签（用**它自己那张表**的中栏列） */
function labelOf(entry: RowEntry): string {
  const keys = middleColumns(tableDef(entry.code)).map((c) => c.key);
  return firstValue(entry.row, keys) || "(未命名条目)";
}

// ─── 右栏「阶段总结」要点视图（brief） ────────────────────────

/** 一条信息来源：`url` 能点开就点开；没有网址的（`文件名:页码`）给 `file` 原文，前端按文本显示 */
export interface StageBriefSource {
  label: string;
  url: string;
  file?: string;
}

/** 右栏要点：来源地址 + 结论提醒 */
export interface StageBrief {
  sources: StageBriefSource[];
  advice: string[];
}

/** 来源列表上限（右栏窄，超过这个数量用户也读不完） */
const BRIEF_SOURCES_MAX = 20;
/** 来源标签截断长度（~24 字） */
const BRIEF_LABEL_MAX = 24;
/** 单条提醒截断长度（~60 字） */
const BRIEF_ADVICE_MAX = 60;
/** 提醒条数上限 */
const BRIEF_ADVICE_LIMIT = 4;
/** 认证差距为这些值时等于"没有差距" */
const NO_CERT_GAP = new Set(["无", "不适用", "不涉及", "暂无"]);

const URL_RE = /https?:\/\/[^\s<>"'`，。；：、）】》\]}]+/giu;
const URL_TRAILING_RE = /[.,;:!?，。；：、）】》\]}]+$/u;

/** 去掉 URL 尾部的句读；成对的英文括号属于 URL 本身（`.../A_(b)`），不成对的才剥 */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const stripped = url.replace(URL_TRAILING_RE, "");
    if (stripped !== url) {
      url = stripped;
      continue;
    }
    const open = (url.match(/\(/gu) ?? []).length;
    const close = (url.match(/\)/gu) ?? []).length;
    if (close > open) {
      url = url.slice(0, url.lastIndexOf(")"));
      continue;
    }
    return url;
  }
}

/** 取单元格文本（多值列按「、」连接，与中栏同一口径） */
function cellTextOf(v: unknown): string {
  if (Array.isArray(v)) {
    return v
      .map((x) => String(x ?? "").trim())
      .filter((s) => s !== "")
      .join("、");
  }
  return String(v ?? "").trim();
}

/** 按字符数截断（中文按字算，不按 UTF-16 码元） */
function clipChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/** 行标签：优先用这一行最像主键的字段，取不到就用表名 */
function briefLabelOf(row: InfoRow, table: TableDef): string {
  let raw = firstValue(row, [
    "barrier_name",
    "gap_ref",
    "sub_scene",
    "model",
    "name",
    "item",
  ]);
  if (raw === "") {
    // 没有这些字段的表：退回它自己的中栏主列（最后一档才是表名）
    for (const c of middleColumns(table)) {
      const text = cellTextOf(row[c.key]);
      if (text !== "") {
        raw = text;
        break;
      }
    }
  }
  return clipChars((raw || table.name).replace(/\s+/gu, " "), BRIEF_LABEL_MAX);
}

/** 从一行里抽出全部 http(s) 源地址（去重后按出现顺序） */
function urlsOfRow(row: InfoRow, seen: Set<string>): string[] {
  const out: string[] = [];
  for (const v of Object.values(row)) {
    const text = cellTextOf(v);
    if (text === "") continue;
    for (const m of text.matchAll(URL_RE)) {
      const raw = trimUrl(m[0]);
      if (!isHttpUrl(raw)) continue;
      const key = normalizeUrl(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/** 文件名 / 文件名:页码 / 报告名带扩展名——这类来源点不开，但必须让用户知道去资料库看哪份 */
const FILE_SOURCE_RE = /\.(?:pdf|docx?|xlsx?|pptx?|md|txt)\b|^[^。；\n]{2,50}[:：]\s*\d/iu;

/** 没有网址时的兜底：列出本步引用的文件来源（按原文去重） */
function fileSourcesOf(input: StageSummaryInput, tables: readonly TableDef[]): StageBriefSource[] {
  const out: StageBriefSource[] = [];
  const seen = new Set<string>();
  const push = (text: string, source: string) => {
    if (seen.has(text)) return true;
    seen.add(text);
    out.push({ label: text, url: "", file: source });
    return out.length < BRIEF_SOURCES_MAX;
  };
  // 先挑「像文件」的（文件名/带扩展名/文件名:页码），它们指得回资料库
  for (const t of tables) {
    for (const row of input.rowsByTable[t.code] ?? []) {
      for (const key of ["source", "proof", "ability_basis"] as const) {
        const text = cellTextOf(row[key]).replace(/\s+/gu, " ");
        if (text === "" || !FILE_SOURCE_RE.test(text)) continue;
        if (!push(clipChars(text, BRIEF_LABEL_MAX), text)) return out;
      }
    }
  }
  if (out.length > 0) return out;
  // 连文件名都没有（实跑常见：来源写「行业通例（模型知识）」）：
  // 列出**来源原文**并给出条数——点不开，但用户至少知道这一步的底是行业通例还是用户确认
  const counts = new Map<string, number>();
  for (const t of tables) {
    for (const row of input.rowsByTable[t.code] ?? []) {
      const text = cellTextOf(row["source"]).replace(/\s+/gu, " ") || cellTextOf(row["source_type"]);
      if (text === "" || text === "—" || text === "待补") continue;
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
  }
  for (const [text, n] of counts) {
    const label = `${clipChars(text, BRIEF_LABEL_MAX)}（${n} 条）`;
    if (!push(label, text)) return out;
  }
  return out;
}

/**
 * 从**本步表集的真实行**里抽可打开的来源地址
 *
 * 只收 `http(s)://`：`文件名:页码` 这类来源无法点开，不属于本块的职责
 * （它们仍写在总结全文的「核实结论」里）。
 */
function briefSourcesOf(input: StageSummaryInput, tables: readonly TableDef[]): StageBriefSource[] {
  const out: StageBriefSource[] = [];
  const seen = new Set<string>();
  for (const t of tables) {
    for (const row of input.rowsByTable[t.code] ?? []) {
      const urls = urlsOfRow(row, seen);
      if (urls.length === 0) continue;
      const label = briefLabelOf(row, t);
      for (const url of urls) {
        out.push({ label, url });
        if (out.length >= BRIEF_SOURCES_MAX) return out;
      }
    }
  }
  // 一条网址都没有（大多数实跑数据是「文件名:页码」）：退回文件来源，
  // 否则用户看不到"这句话从哪来"，溯源就断在右栏
  return out.length > 0 ? out : fileSourcesOf(input, tables);
}

/** 认证差距常写成一整句（"认证类要求：需取得…；若…"），右栏只留得下前半句（截断不带省略号，交给外层统一加） */
function shortGap(gap: string): string {
  const cut = gap.replace(/^[^：:]{0,6}[：:]\s*/u, "");
  const head = cut.split(/[；;。]/u)[0] ?? cut;
  return Array.from(head.trim()).slice(0, 26).join("");
}

/** 规则 1：认证差距非空且不是「无」类 → 不建议贸然进入 */
function certAdvice(row: InfoRow): string | null {
  const gap = cellTextOf(row["cert_gap"]);
  if (gap === "" || NO_CERT_GAP.has(gap)) return null;
  const barrier = cellTextOf(row["barrier_name"]) || "该门槛";
  return `门槛「${barrier}」：拿不出 ${shortGap(gap)}——不建议贸然进入`;
}

/** 规则 2：对某对手胜负为「弱」→ 不建议正面竞争 */
function weakAdvice(row: InfoRow): string | null {
  if (cellTextOf(row["win_loss"]) !== "弱") return null;
  const opponent = cellTextOf(row["opponent"]) || "该对手";
  const weakness = cellTextOf(row["weakness"]);
  return `对 ${opponent} 处弱势${weakness === "" ? "" : `：${weakness}`}——不建议正面竞争`;
}

/** 规则 3：匹配判定为「不能做」→ 建议分包或放弃这一段 */
function cannotDoAdvice(row: InfoRow): string | null {
  if (cellTextOf(row["match"]) !== "不能做") return null;
  const gap = cellTextOf(row["gap_ref"]) || "该缺口";
  const action = cellTextOf(row["action"]);
  return `「${gap}」做不了${action === "" ? "" : `，${action}`}——建议分包或放弃这一段`;
}

/**
 * 把数据里带出来的内部表号换成人类说法
 *
 * 界面从 v2.10 起不再显示表号，但模型写进「对手/缺口」字段的括号里仍可能带
 * “（表3-2 所列厂商）”。右栏提醒直接引用了这些字段，必须在这里洗掉，
 * 否则又会出现用户看不懂的「表3-2」。
 */
function humanizeTableRefs(text: string): string {
  return text
    .replace(/（表\d+-\d+\s*所列/gu, "（前述")
    .replace(/表\d+-\d+\s*所列/gu, "前述")
    .replace(/（表\d+-\d+）/gu, "")
    .replace(/表\d+-\d+/gu, "相关表");
}

/** 截断时优先断在句读上（"…环保产…"这种半截词用户读不下去） */
function clipAdvice(text: string): string {
  if (text.length <= BRIEF_ADVICE_MAX) return text;
  const clean = text.replace(/…$/u, "");
  // 结论在「——」之后：截断只能发生在依据部分，绝不能把「不建议…」截掉
  const mark = clean.lastIndexOf("——");
  if (mark > 0) {
    const tail = clean.slice(mark);
    const room = BRIEF_ADVICE_MAX - Array.from(tail).length - 1;
    if (room > 8) {
      const head = Array.from(clean.slice(0, mark)).slice(0, room).join("");
      return `${head.replace(/[，、；：\s]+$/u, "")}…${tail}`;
    }
    return tail.replace(/^——/u, "");
  }
  const head = Array.from(clean).slice(0, BRIEF_ADVICE_MAX).join("");
  const cut = Math.max(head.lastIndexOf("；"), head.lastIndexOf("，"), head.lastIndexOf("、"));
  return cut > 12 ? `${head.slice(0, cut)}…` : `${head}…`;
}

/** 一条都判不出时的兜底（不凑数） */
const BRIEF_FALLBACK = "本步还没有可下结论的判据：门槛、赢面与能力匹配表尚未产出，风险提醒随这些表出现";

/**
 * 右栏要点视图（确定性推导，不需要 LLM）
 *
 * 只读 `rowsByTable`（本步表集已由调用方按 `tableCodes` 限定）：
 *  - **来源**：行内出现的 http(s) 地址，去重、最多 20 条，标签取行的主标识
 *  - **提醒**：表1-3 认证差距 / 表4-4 胜负为弱 / 表4-3 不能做；
 *    去重、每条 ≤60 字、最多 4 条；一条都判不出时只给一句兜底
 *
 * 不改 `buildStageSummary` 的任何输出——交付物装配仍走那一份六段骨架。
 */
export function buildStageBrief(input: StageSummaryInput): StageBrief {
  const tables = tablesFor(input);

  const candidates: string[] = [];
  // 门槛最多留 2 条：一个场景常有好几道认证门槛，全列会把其他两类提醒挤掉
  const barriers = new Set<string>();
  for (const row of input.rowsByTable["表1-3"] ?? []) {
    const a = certAdvice(row);
    if (!a) continue;
    const name = cellTextOf(row["barrier_name"]) || a;
    if (barriers.has(name) || barriers.size >= 2) continue;
    barriers.add(name);
    candidates.push(a);
  }
  for (const row of input.rowsByTable["表4-4"] ?? []) {
    const a = weakAdvice(row);
    if (a) candidates.push(a);
  }
  for (const row of input.rowsByTable["表4-3"] ?? []) {
    const a = cannotDoAdvice(row);
    if (a) candidates.push(a);
  }
  const advice: string[] = [];
  const seenAdvice = new Set<string>();
  for (const raw of candidates) {
    const text = clipAdvice(humanizeTableRefs(raw.replace(/\s+/gu, " ").trim()));
    if (text === "" || seenAdvice.has(text)) continue;
    seenAdvice.add(text);
    advice.push(text);
    if (advice.length >= BRIEF_ADVICE_LIMIT) break;
  }

  return {
    sources: briefSourcesOf(input, tables),
    advice: advice.length > 0 ? advice : [input.fallbackAdvice ?? BRIEF_FALLBACK],
  };
}

/**
 * 生成阶段总结文档（Markdown，六段骨架）
 *
 * 骨架：一、信息摘要 ｜ 二、关键信息清单 ｜ 三、说明与方法口径
 *       四、核实结论 ｜ 五、待补齐信息
 *       （**步骤级**到此为止；**阶段级**再加 六、上下游衔接）
 */
export function buildStageSummary(input: StageSummaryInput): string {
  const def = stageDef(input.stage);
  const scope = input.scope ?? "stage";
  const tables = tablesFor(input);
  const entries = allEntries(input, tables);
  const rows = entries.map((e) => e.row);
  const dist = authorityDistribution(rows);
  const generatedAt = input.generatedAt ?? new Date().toISOString().slice(0, 10);
  const L: string[] = [];

  // 文档头（右栏按步骤时抬头写「第 n 步」，不用底层阶段名——用户看的单位是步）
  const stepDef = input.step === undefined ? undefined : flowStep(input.step);
  L.push(
    stepDef
      ? `# 第 ${input.step} 步 · ${stepDef.title} — 总结`
      : `# 阶段 ${input.stage} · ${def.name} — 总结`,
  );
  L.push("");
  L.push(
    `> 场景：${input.scenarioName}${input.productLineName ? ` ｜ 产品线：${input.productLineName}` : ""} ｜ 生成时间：${generatedAt} ｜ 信息完整度：${input.completeness.tablesWithData}/${input.completeness.expectedTables} 张表齐备（${input.completeness.percent}%）`,
  );
  if (scope !== "step" && input.briefRawText) {
    L.push(">");
    L.push("> **用户诉求（第一输入，唯一基准）**：");
    for (const line of input.briefRawText.split("\n")) L.push(`> ${line}`);
  }
  L.push("");

  // 一、信息摘要
  const assumptions = entries.filter((e) => String(e.row["evidence_level"] ?? "") === "C");
  const inferred = entries.filter((e) => String(e.row["source_type"] ?? "") === "AI推断");
  L.push("## 一、信息摘要");
  L.push("");
  L.push(
    stepDef ? `本步要获得的信息是：${stepDef.goal}` : `本阶段要获得的信息是：${def.goal}`,
  );
  L.push("");
  L.push(
    `共获得 **${tables.length} 张表 / ${rows.length} 行**信息（其中 ${input.completeness.tablesWithData} 张表已有数据）；` +
      `来源分布 ${authoritySummary(dist)}；` +
      `标注为 C 级假设的条目 ${assumptions.length} 条、系统推断条目 ${inferred.length} 条。`,
  );
  L.push("");

  // 二、关键信息清单
  L.push("## 二、关键信息清单");
  L.push("");
  if (rows.length === 0) {
    L.push(stepDef ? "（本步尚无信息，见第五节待补清单）" : "（本阶段尚无信息，见第五节待补清单）");
  } else {
    for (const t of tables) {
      const tRows = input.rowsByTable[t.code] ?? [];
      if (tRows.length === 0) {
        L.push(`- **${tableLabel(t)}**：尚无数据`);
        continue;
      }
      const keys = middleColumns(t).map((c) => c.key).slice(0, 3);
      const sample = tRows
        .slice(0, 3)
        .map((r) => valuesOf(r, keys))
        .filter((s) => s !== "");
      L.push(
        `- **${tableLabel(t)}**：${tRows.length} 行${sample.length ? `——${sample.join("；")}${tRows.length > 3 ? " …" : ""}` : ""}`,
      );
    }
  }
  L.push("");

  // 三、说明与方法口径（变更表 #149：删掉"数值型按原值录入"这类固定口径套话——
  // 它对每一份总结、每一步都一模一样，读者得不到任何本步的信息；
  // C 级假设与系统推断是本步真实存在的东西，留在这里）
  L.push("## 三、说明与方法口径");
  L.push("");
  if (assumptions.length > 0) {
    L.push(`- **C 级假设（${assumptions.length} 条，按 G-R2 不作结论；核实结论见第四节）**：`);
    for (const e of assumptions.slice(0, 10)) {
      L.push(`  - ${e.code}｜${labelOf(e)}`);
    }
  } else {
    L.push("- C 级假设：无。");
  }
  if (inferred.length > 0) {
    L.push(`- **系统推断（${inferred.length} 条，模型按行业通例补的；核实结论见第四节）**：`);
    for (const e of inferred.slice(0, 10)) {
      L.push(`  - ${e.code}｜${labelOf(e)}`);
    }
  } else {
    L.push("- 系统推断：无。");
  }
  L.push("");

  // 四、核实结论（v1.27：每条信息都带核实判定——准不准、客不客观、为什么）
  L.push("## 四、核实结论");
  L.push("");
  const sources = [...new Set(rows.map((r) => String(r["source"] ?? "").trim()).filter((s) => s !== ""))];
  if (rows.length === 0) {
    L.push(
      stepDef ? "（本步尚无信息，见第五节待补清单）" : "（本阶段尚无信息，见第五节待补清单）",
    );
  } else {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const v = verificationVerdict(r);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const unverified = counts.get("未核") ?? 0;
    L.push(
      `- 核实分布：${VERIFICATION_VERDICTS.map((v) => `${v} ${counts.get(v) ?? 0} 条`).join(" / ")}` +
        (unverified > 0 ? ` ／ 未核 ${unverified} 条（早期数据未带核实列）` : ""),
    );
    for (const [verdict, tail] of [
      ["有反证", "材料之间冲突，冲突点写在核实说明里"],
      ["无法核实", "本客户事实缺材料、或材料冲突到判不了——**不能当结论用**"],
    ] as const) {
      const list = entries.filter((e) => verificationVerdict(e.row) === verdict);
      if (list.length === 0) continue;
      L.push(`- **${verdict}（${list.length} 条）：${tail}**：`);
      for (const e of list.slice(0, 10)) L.push(`  - ${e.code}｜${labelOf(e)}`);
      if (list.length > 10) L.push(`  - （其余 ${list.length - 10} 条见各表）`);
    }
    L.push("- 每条信息的核实理由（**准确**：对得上哪份材料、能否复算；**客观**：事实还是推断、谁的口径、有无利益相关方；**为什么**：凭什么采信、哪里不确定）见各表「核实说明」列。");
    // 变更表 #149：删掉「生成后自检（三问）」这段留痕——自检是生成过程的内部环节
    // （规则 G-R8），它的结论已经逐行写在行的核实说明里（降级标记「【生成后自检】」），
    // 在总结里再自述一遍"我查了几条"属于内部过程上界面，用户拿不到任何本步信息。
    if (sources.length > 0) {
      L.push(
        `- 来源分布：${authoritySummary(dist, " 条")}；不同来源共 ${sources.length} 个`,
      );
    } else {
      L.push("- 来源分布：本步尚未带来源的信息（来源是硬要求，见第五节待补清单）");
    }
  }
  L.push("");

  // 五、待补齐信息（缺口分属主：用户的活 vs 智能体的待办）
  L.push("## 五、待补齐信息");
  L.push("");
  for (const line of gapsToSummaryLines(input.completeness)) L.push(line);
  L.push("");

  // 六、上下游衔接（**只在阶段级/交付物装配时给**：右栏按步骤总结时不讲整个过程）
  if (scope !== "step") {
    L.push("## 六、上下游衔接");
    L.push("");
    L.push(`- 本阶段产出：${tables.map(tableRef).join("、") || "（无信息表）"}`);
    const downstream = new Map<InfoStageId, string[]>();
    for (const t of tables) {
      for (const s of t.consumedBy ?? []) {
        const list = downstream.get(s);
        if (list) list.push(tableRef(t));
        else downstream.set(s, [tableRef(t)]);
      }
    }
    for (const [s, codes] of [...downstream.entries()].sort((a, b) => a[0] - b[0])) {
      const name = STAGE_DEFS.find((x) => x.id === s)?.name ?? `阶段 ${s}`;
      L.push(`  - 阶段 ${s} · ${name} 会引用：${[...new Set(codes)].join("、")}`);
    }
    const upstream = TABLES.filter(
      (t) => t.stage < input.stage && (t.consumedBy ?? []).includes(input.stage),
    ).map(tableLabel);
    L.push(`- 上游依据：${upstream.join("、") || "（无跨阶段依赖）"}`);
    L.push("");
  }
  L.push("---");
  L.push("");
  L.push(
    "> 本文档每条信息都带**核实结论**（准不准 · 客不客观 · 为什么）；只给可核实的事实与判定，**不给决策建议**——该不该进由你自己定。",
  );
  L.push("");
  return L.join("\n");
}
