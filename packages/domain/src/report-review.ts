/**
 * @scene/domain — 交付物终检（变更表 #139）
 *
 * 用户质问：「没有最终检查文档质量的环节吗？」——在此之前，交付物只有**逐章机械规则**
 * （缺章 / 缺构件 / 内部痕迹 / 篇幅），没有任何一步"通读全篇"：章与章之间的重复、前后矛盾、
 * 空话套话、表格与正文对不上，这些跨章的毛病一条都查不出来。
 *
 * 终检分两半，纯逻辑都在本模块：
 *  - **模型侧**（提示词与三次调用在 `apps/server/src/report-review.ts`）：通读找问题 → 只改被点名的
 *    段落 → 复查。模型返回的任何内容都要过确定性关卡（`fixAccepted` / `parseReviewIssues`）。
 *  - **确定性侧**（本模块，接进 `checkReport`）：断头段（硬伤）、跨章重复句、空节、章首段不合规。
 *
 * 纯函数，无 IO；高风险判定落确定性层（AGENTS.md §三.5）。
 */

import { proseChars } from "./md-metrics.js";
import {
  brokenProseHeads,
  firstProseParagraph,
  leadParagraphIssue,
  LEAD_PARAGRAPH_SOFT_MAX_CHARS,
} from "./prose-shape.js";
import type { ReportViolation } from "./report-gate.js";

/** 终检允许的问题条数上限（再多就不是"读者会卡住"，是风格偏好） */
export const MAX_REVIEW_ISSUES = 12;

/** 终检的问题类型（写进提示词，解析时只认这些） */
export const REVIEW_ISSUE_TYPES = [
  "悬空残句",
  "章首不自足",
  "重复",
  "前后矛盾",
  "空话套话",
  "表格与正文不一致",
  "读不通",
] as const;

export type ReviewIssueType = (typeof REVIEW_ISSUE_TYPES)[number];

/** 终检模型报出的一条问题：锚点 = 该段前 12 个字（用于定位与"未被点名的段落逐字不变"） */
export interface ReviewIssue {
  chapter: string;
  anchor: string;
  type: ReviewIssueType;
  note: string;
}

export interface ParsedReviewIssues {
  issues: ReviewIssue[];
  /** 被丢掉的条数（缺字段 / 类型不认 / 锚点定位不到 / 超过 12 条） */
  dropped: number;
  /** 整体无法解析（不是 JSON / 没有 issues 字段）——调用方据此跳过终检，绝不阻断出稿 */
  error?: string;
}

/** 一条确定性终检发现（与 checkReport 的违规同构，便于直接并进 violations） */
export interface ReviewFinding {
  kind: ReportViolation["kind"];
  hard: boolean;
  detail: string;
}

/** 小节正文少于这个字数就算「空节」（占位、没写内容） */
export const STUB_SECTION_CHARS = 30;

/** 跨章重复句的最短长度（太短的句子（如「实施要点」）重复是正常的） */
export const DUPLICATE_SENTENCE_MIN_CHARS = 20;

/** 把模型返回里的 JSON 抠出来（允许 ```json 围栏与前后寒暄）；PPT 大纲解析同用 */
export function jsonSlice(raw: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const text = fenced?.[1] ?? raw;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

/** 这一条问题是不是合规的（字段齐、类型认、锚点能在正文里定位到） */
function isUsableIssue(item: unknown, markdown: string): item is ReviewIssue {
  if (typeof item !== "object" || item === null) return false;
  const o = item as Record<string, unknown>;
  const chapter = o["chapter"];
  const anchor = o["anchor"];
  const type = o["type"];
  const note = o["note"];
  if (typeof chapter !== "string" || chapter.trim() === "") return false;
  if (typeof anchor !== "string" || anchor.trim() === "") return false;
  if (typeof note !== "string" || note.trim() === "") return false;
  if (!(REVIEW_ISSUE_TYPES as readonly string[]).includes(String(type))) return false;
  // 锚点必须定位得到：模型编一条"读者会卡住"的话，这里就把它挡住
  return markdown.replace(/\s/g, "").includes(anchor.replace(/\s/g, ""));
}

/**
 * 解析终检模型返回的严格 JSON
 *
 * 约束（提示词里也写了）：`{ "issues": [ { chapter, anchor, type, note } ] }`，最多 12 条，
 * 每条必须能靠 `anchor` 定位到具体段落，没问题就 `issues: []`。
 * 不合规的条目**逐条丢弃**（缺字段 / 超 12 条 / 锚点定位不到）；整体不是 JSON 才算 `error`。
 */
export function parseReviewIssues(raw: string, markdown: string): ParsedReviewIssues {
  const slice = jsonSlice(raw);
  if (slice === null) return { issues: [], dropped: 0, error: "返回里没有 JSON" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return { issues: [], dropped: 0, error: "返回的不是合规 JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { issues?: unknown }).issues)) {
    return { issues: [], dropped: 0, error: "返回里缺少 issues 数组" };
  }
  const items = (parsed as { issues: unknown[] }).issues;
  const issues: ReviewIssue[] = [];
  let dropped = 0;
  for (const item of items) {
    if (issues.length >= MAX_REVIEW_ISSUES) {
      dropped += 1;
      continue;
    }
    if (!isUsableIssue(item, markdown)) {
      dropped += 1;
      continue;
    }
    issues.push({
      chapter: item.chapter.trim(),
      anchor: item.anchor.trim(),
      type: item.type,
      note: item.note.trim(),
    });
  }
  return { issues, dropped };
}

/** 解析复查返回：`{ "unresolved": [ { anchor, note } ] }`；解析不了返回 null（调用方只记提示） */
export function parseUnresolved(raw: string): { anchor: string; note: string }[] | null {
  const slice = jsonSlice(raw);
  if (slice === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return null;
  }
  const list = (parsed as { unresolved?: unknown } | null)?.unresolved;
  if (!Array.isArray(list)) return null;
  const out: { anchor: string; note: string }[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o["anchor"] !== "string" || o["anchor"].trim() === "") continue;
    out.push({
      anchor: o["anchor"].trim(),
      note: typeof o["note"] === "string" ? o["note"].trim() : "",
    });
  }
  return out;
}

/** 按 `## 章名` 切块（标题行 + 该章正文）；`###` 与更深的标题不算章 */
export function chapterBlocks(markdown: string): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const line of markdown.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m?.[1]) {
      if (current) out.push({ title: current.title, body: current.lines.join("\n").trim() });
      current = { title: m[1].trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) out.push({ title: current.title, body: current.lines.join("\n").trim() });
  return out;
}

/** 按空行分段（正文段落；表格行与标题行各自成段，交给调用方过滤） */
function paragraphs(markdown: string): string[] {
  return markdown
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

/** 这一段的正文是不是被终检点名了（锚点落在这一段里） */
function isNamed(paragraph: string, anchors: readonly string[]): boolean {
  const flat = paragraph.replace(/\s/g, "");
  return anchors.some((a) => a !== "" && flat.includes(a.replace(/\s/g, "")));
}

/** 正文句子（跳过标题行 / 表格行 / 引用行） */
function sentencesOf(markdown: string): string[] {
  const prose = markdown
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("|") && !t.startsWith("#") && !t.startsWith(">");
    })
    .join("");
  return prose
    .split(/[。！？]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * 跨章重复句：同一句 ≥20 字的话出现在**两个不同的章**里
 *
 * 同章里的重复（如小节导语与结论）不算——那是结构，不是"读者读了两遍同一件事"。
 */
export function duplicateSentences(markdown: string): string[] {
  const where = new Map<string, Set<string>>();
  for (const { title, body } of chapterBlocks(markdown)) {
    for (const s of sentencesOf(body)) {
      if (proseChars(s) < DUPLICATE_SENTENCE_MIN_CHARS) continue;
      const set = where.get(s) ?? new Set<string>();
      set.add(title);
      where.set(s, set);
    }
  }
  return [...where.entries()].filter(([, chapters]) => chapters.size >= 2).map(([s]) => s);
}

/**
 * 空节：`###` 小节下既没有正文、也没有表（像占位）
 *
 * 有表的节不算空——「主辅职责对照」「选型与配置」这类节的内容就在表里，要求它们再写 30 字
 * 正文等于逼模型重复表格（变更表 #246 实跑噪音）。
 */
export function stubSections(markdown: string): string[] {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^###\s+(.+?)\s*$/.exec(lines[i]!);
    if (!m?.[1]) {
      i += 1;
      continue;
    }
    let j = i + 1;
    const body: string[] = [];
    while (j < lines.length && !/^#{1,4}\s/.test(lines[j]!)) {
      body.push(lines[j]!);
      j += 1;
    }
    const hasTable = body.some((line) => line.trim().startsWith("|"));
    if (!hasTable && proseChars(body.join("\n")) < STUB_SECTION_CHARS) out.push(m[1].trim());
    i = j;
  }
  return out;
}

/** 逐章的章首段问题（章名 + 原因） */
export function leadParagraphProblems(markdown: string): { chapter: string; reason: string }[] {
  const out: { chapter: string; reason: string }[] = [];
  for (const { title, body } of chapterBlocks(markdown)) {
    const reason = leadParagraphIssue(firstProseParagraph(body));
    if (reason !== null) out.push({ chapter: title, reason });
  }
  return out;
}

/**
 * 整篇上的确定性终检（接进 `checkReport`，终检环节也会再跑一遍做最终断言）
 *
 * 断头段与**章首段不合规**是硬伤（`#247`：≤120 字、点明对象与处境、不以分号列举、
 * 不以半句开头——全是确定性判据，没有审美成分）；重复 / 空节只提示，不阻断出稿。
 */
export function deterministicReviewFindings(markdown: string): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  const broken = brokenProseHeads(markdown);
  if (broken.length > 0) {
    out.push({
      kind: "悬空残句",
      hard: true,
      detail:
        `正文有 ${broken.length} 处断头段（从半句话开始的段落）：` +
        broken.slice(0, 3).map((b) => `「${b.slice(0, 20)}…」`).join("、"),
    });
  }
  const dup = duplicateSentences(markdown);
  if (dup.length > 0) {
    out.push({
      kind: "重复",
      hard: false,
      detail:
        `有 ${dup.length} 句在不止一章里重复出现（同一事实全篇只说一次）：` +
        dup.slice(0, 2).map((s) => `「${s.slice(0, 20)}…」`).join("、"),
    });
  }
  const stubs = stubSections(markdown);
  if (stubs.length > 0) {
    out.push({
      kind: "空节",
      hard: false,
      detail: `这几节的正文不足 ${STUB_SECTION_CHARS} 字（像占位）：${stubs.join("、")}`,
    });
  }
  const leads = leadParagraphProblems(markdown);
  // 只超一点（121–132 字）按提示：读者感知不到 2 个字的差别，判硬伤只会制造噪音（#245 教训）
  const overChars = (reason: string): number => Number(/首段 (\d+) 字/.exec(reason)?.[1] ?? 0);
  const isSoftOnly = (reason: string): boolean => {
    const n = overChars(reason);
    return n > 120 && n <= LEAD_PARAGRAPH_SOFT_MAX_CHARS;
  };
  const hardLeads = leads.filter((l) => !isSoftOnly(l.reason));
  const softLeads = leads.filter((l) => isSoftOnly(l.reason));
  if (hardLeads.length > 0) {
    out.push({
      kind: "章首段不合规",
      hard: true,
      detail:
        "这几章的第一段不像总纲（≤120 字、点明对象与当前处境、不以分号列举或半句开头）：" +
        hardLeads.map((l) => `${l.chapter}（${l.reason}）`).join("、"),
    });
  }
  if (softLeads.length > 0) {
    out.push({
      kind: "章首段不合规",
      hard: false,
      detail:
        `这几章的第一段略超 120 字（≤${LEAD_PARAGRAPH_SOFT_MAX_CHARS} 字按提示，不改也算过）——能压就压一句：` +
        softLeads.map((l) => `${l.chapter}（${l.reason}）`).join("、"),
    });
  }
  return out;
}

/** 终检改动一段/一章的采纳判据（任一不过就整章不采纳、保留原稿） */
export interface FixGuardInput {
  /** 改前的章（含 `## 章名` 标题） */
  before: string;
  /** 改后的章 */
  after: string;
  /** 被终检点名的段落锚点 */
  anchors: readonly string[];
  /** 改前该章还缺哪些方案构件（`missingChapterArtifacts`） */
  missingBefore: readonly string[];
  /** 改后该章还缺哪些方案构件 */
  missingAfter: readonly string[];
  /**
   * 允许动表格（变更表 #244）
   *
   * 「表格与正文不一致」「前后矛盾」常常要靠改表格那一格才能消解；若仍按"未被点名的段落
   * 逐字不变"卡死，这类改动永远采纳不了（实测：压铸 3 条硬伤两轮全被这条挡回）。
   * 只对这两类硬伤放开**含表格的段落**，其余段落仍逐字不动。
   */
  allowTableEdits?: boolean;
}

/**
 * 矛盾类硬伤的确定性复核（变更表 #244 补丁）
 *
 * 终检模型报"前后矛盾"时会把**它自己的疑问**也报进来（"需确认依据""口径未统一"），
 * 实测压铸一轮 13 条里过半属于这种；直接照单升硬伤，等于让模型的主观判断卡住交付物。
 * 所以升级前先做一道便宜的确定性检查：`note` 里必须**引用两处不同取值**（引号/书名号包起来
 * 的原文，或带单位的数字），且两处都真的在这份报告里出现、且不相等。
 * 复核不过 → 仍按存疑记提示，不进第二轮回炉、不判未通过。
 */
export function contradictionCheck(
  issue: { type: string; note: string },
  markdown: string,
): { confirmed: boolean; reason: string } {
  /* 模型有时先写"两处一致；但……"，再提一个疑问——那不是互斥，是它自己没想清楚 */
  if (/两处一致|口径一致|完全一致|内容一致|不直接冲突|不冲突/.test(issue.note)) {
    return { confirmed: false, reason: "note 自己说明两处一致/不冲突，不算互斥取值" };
  }
  const flat = markdown.replace(/\s/g, "");
  const quoted = [...issue.note.matchAll(/[「“"『《`]([^」”"』》`]{2,40})[」”"』》`]/g)]
    .map((m) => m[1]!.replace(/\s/g, ""))
    .filter((v) => v.length >= 2);
  const values = new Set<string>(quoted);
  for (const m of issue.note.matchAll(/(?:第\s*)?\d+(?:\.\d+)?\s*(?:[–\-—~至]\s*\d+(?:\.\d+)?)?\s*(?:周|个月|月|天|日|小时|分钟|%|人天|万元|元)/g)) {
    values.add(m[0]!.replace(/\s/g, ""));
  }
  const present = [...values].filter((v) => flat.includes(v));
  const distinct = new Set(present);
  if (distinct.size < 2) {
    return {
      confirmed: false,
      reason: distinct.size === 0 ? "note 里没引用可核对的取值" : "note 里只有一处取值，看不出两个互斥值",
    };
  }
  return { confirmed: true, reason: `两处取值都在正文里：${[...distinct].slice(0, 2).join(" / ")}` };
}

/** 被点名段落的字数允许变化幅度（只改病句，不该整章变胖变瘦） */
const FIX_LENGTH_TOLERANCE = 0.25;

/**
 * 采纳终检改动前的四道确定性关卡
 *
 * 1. **未被点名的段落逐字不变**（模型最爱顺手"润色"别处）；
 * 2. 长度变化在 ±25% 内；
 * 3. 章首段仍过「≤120 字、不以分号列举或半句开头」；
 * 4. 方案构件不比改前少（缺构件是硬伤，比病句严重）。
 */
export function fixAccepted(input: FixGuardInput): { ok: boolean; reason?: string } {
  const { before, after, anchors, missingBefore, missingAfter, allowTableEdits } = input;
  if (after.trim() === "") return { ok: false, reason: "改后是空的" };

  const afterParas = paragraphs(after);
  for (const para of paragraphs(before)) {
    if (isNamed(para, anchors)) continue;
    if (allowTableEdits === true && /^\s*\|/m.test(para)) continue;
    if (!afterParas.includes(para)) return { ok: false, reason: "改动了没被点名的段落" };
  }

  const lenBefore = proseChars(before);
  const lenAfter = proseChars(after);
  if (lenBefore > 0) {
    const delta = Math.abs(lenAfter - lenBefore) / lenBefore;
    if (delta > FIX_LENGTH_TOLERANCE) {
      return {
        ok: false,
        reason: `字数从 ${lenBefore} 变成 ${lenAfter}（超过 ±25%）`,
      };
    }
  }

  const lead = leadParagraphIssue(firstProseParagraph(after));
  if (lead !== null) return { ok: false, reason: `章首段仍不合格：${lead}` };

  if (missingAfter.length > missingBefore.length) {
    return { ok: false, reason: `改后方案构件变少（${missingAfter.length} > ${missingBefore.length}）` };
  }
  return { ok: true };
}
