/**
 * @scene/server — 交付物终检（变更表 #139）
 *
 * 用户问：「没有最终检查文档质量的环节吗？」——在此之前，交付物只有逐章机械规则，
 * 没有任何一步"通读全篇"。本模块补上这条链路，每份交付物各做一次：
 *
 *   1. **通读找问题**（`reviewReport` 的第一次调用）：整篇交给模型，要它返回严格 JSON
 *      （章名 + 段落锚点 + 类型 + 一句话说明），最多 12 条，只报"读者会卡住"的问题；
 *      输出先容错（剥代码围栏、取首尾大括号），仍解析不了就**用更短的提示重试一次**（#139 补丁：
 *      实测首次可能只吐 3 个字），再失败才跳过；
 *   2. **只改被点名的段落**（按章分组，逐章一次调用）：返回改后的整章，**采纳必须过四道
 *      确定性关卡**（`fixAccepted`：没被点名的段落逐字不变 / 字数 ±25% / 章首段仍合格 /
 *      构件不变少），任一不过就整章保留原稿；
 *   3. **复查**（第三次调用）：把改后的段落与原问题清单再问一次"这几处解决了吗"，仍存疑的
 *      **只记提示、不再改**。
 *
 * 铁律：模型调用失败 / JSON 解析失败 → **跳过终检，绝不阻断出稿**（只记一条提示）。
 * 纯逻辑（解析、确定性判据、采纳关卡）都在 `@scene/domain` 的 `report-review.ts`，
 * 这里只做提示词、调用编排与违规清单拼装。
 */

import { REPORT_KIND_LABEL, reportChapters, type ReportKind } from "@scene/contract";
import type { DshClient, FollowEvent, SessionHandle } from "@scene/contract";
import {
  MAX_REVIEW_ISSUES,
  deterministicReviewFindings,
  fixAccepted,
  matchChapterKey,
  missingChapterArtifacts,
  parseReviewIssues,
  parseUnresolved,
  type ReportViolation,
  type ReviewIssue,
} from "@scene/domain";
import { streamPrompt } from "./dsh-stream.js";

/** 终检三个调用的用户提示里各带一句"路标"，测试与排查靠它认这一步 */
export const REVIEW_PROMPT_MARKER = "## 终检：通读全文，找读者会卡住的地方";
export const FIX_PROMPT_MARKER = "## 终检：只改下面点名的段落";
export const VERIFY_PROMPT_MARKER = "## 终检：复查这几处解决没有";
/** 首次通读没给出合规 JSON 时的重试路标（与上面的通读路标不同，测试据此分辨两次调用） */
export const REVIEW_RETRY_PROMPT_MARKER = "## 终检：上一次的输出无法解析，只按格式重发一次";

/** 终检运行开关（默认开；测试与排查可关） */
export type ReviewMode = "on" | "off";

export interface ReviewReportArgs {
  kind: ReportKind;
  /** 装配好的整篇（终检的输入与兜底输出） */
  markdown: string;
  scenarioName: string;
  dshClient: DshClient;
  keepaliveMs: number;
  push: (event: FollowEvent) => void;
  /** `off` = 一次终检调用都不发（调用方据此跳过） */
  enabled: boolean;
}

export interface ReportReviewOutcome {
  /** 终检后的整篇（没改或跳过时与入参逐字相同） */
  markdown: string;
  /** 模型报出的问题条数（已丢掉不合规的） */
  issues: number;
  /** 被丢掉的不合规条数（缺字段 / 锚点定位不到 / 超过 12 条） */
  dropped: number;
  /** 采纳并改掉的条数 */
  fixed: number;
  /** 仍存疑、只记提示的条数 */
  remaining: number;
  /** 终检产生的违规（带 `from: "终检"`） */
  violations: ReportViolation[];
  /** 跳过终检的原因（调用失败 / 解析失败） */
  skipped?: string;
}

/** 第一次调用：通读找问题（严格 JSON） */
export function buildReviewPrompt(
  kind: ReportKind,
  markdown: string,
): { system: string; user: string } {
  const label = REPORT_KIND_LABEL[kind];
  const chapters = reportChapters(kind)
    .map((c) => c.label)
    .join(" / ");
  const system = [
    `你是《<场景>${label}》的**终审编辑**，负责通读全篇做最后一遍质量检查。`,
    "",
    "## 只做一件事：报出**读者会卡住**的地方",
    "- 悬空残句：一段从半句话开始、或结尾断掉的正文；",
    "- 章首不自足：本章第一段没有点明对象与当前处境，读者不知道这章在说什么；",
    "- 重复：同一件事在两个章里各说一遍（≥20 字的原句重复）；",
    "- 前后矛盾：两处说法/数字对不上；空话套话：说了等于没说；表格与正文不一致；读不通的句子。",
    "- **不许提风格偏好**（用词、语气、篇幅长短、小节顺序一概不报），**不许要求重写整篇**。",
    "- 每条必须能靠 `anchor`（**该段前 12 个字，原样照抄**）定位到正文里的具体段落；定位不到就不要报。",
    `- 最多 ${MAX_REVIEW_ISSUES} 条；实在没问题就报空数组。宁可少报，不许编。`,
    "",
    "## 输出（**只输出这一段 JSON**）",
    "- **不要任何解释、不要 Markdown 代码围栏、不要前后缀**——你的回复会被直接 `JSON.parse`；",
    `- 字段固定四个：\`chapter\`（章名原样抄）/ \`anchor\`（该段前 12 个字）/ \`type\` / \`note\`，最多 ${MAX_REVIEW_ISSUES} 条；`,
    "- 形状照这个最小样例（有几条就写几条，没问题就 `issues` 为空数组）：",
    '{"issues":[{"chapter":"建设背景与必要性","anchor":"本方案对象是企业与园区","type":"读不通","note":"开头是半句话"}]}',
    '{"issues":[]}',
  ].join("\n");
  const user = [
    REVIEW_PROMPT_MARKER,
    "",
    `## 交付物`,
    `<场景>${label}（章节：${chapters}）`,
    "",
    "## 全文",
    markdown,
  ].join("\n");
  return { system, user };
}

/**
 * 通读重试：首次输出没法解析成 JSON 时用（实测模型偶尔只回三个字）
 *
 * 第二次的提示**刻意更短**——只重复输出格式 + 一句"上一次的输出无法解析"，
 * 免得模型又顺着长篇上下文写一堆解释。
 */
export function buildReviewRetryPrompt(kind: ReportKind): { system: string; user: string } {
  const label = REPORT_KIND_LABEL[kind];
  const system = [
    "你上一次的输出无法解析为 JSON。现在**只重复输出那一段 JSON**，不要任何其它文字。",
    "",
    "## 格式（唯一要求）",
    "- 直接输出一个 JSON 对象，不要解释、不要 Markdown 代码围栏、不要前后缀；",
    `- 形状：\`{"issues":[{"chapter":"章名原样抄","anchor":"该段前 12 个字","type":"悬空残句|章首不自足|重复|前后矛盾|空话套话|表格与正文不一致|读不通","note":"一句话说明"}]}\`；`,
    `- 最多 ${MAX_REVIEW_ISSUES} 条；没问题就输出 {"issues":[]}。`,
  ].join("\n");
  const user = [
    REVIEW_RETRY_PROMPT_MARKER,
    `（《<场景>${label}》的终检：上一次的输出无法解析为 JSON，请只按格式重发一次）`,
    "只输出 JSON。",
  ].join("\n");
  return { system, user };
}

/** 第二次调用：只改被点名的段落，返回改后的整章 */
export function buildFixPrompt(
  kind: ReportKind,
  chapterTitle: string,
  chapterMarkdown: string,
  issues: readonly ReviewIssue[],
): { system: string; user: string } {
  const label = REPORT_KIND_LABEL[kind];
  const system = [
    `你是《<场景>${label}》的定稿编辑，只修被点名的段落。`,
    "",
    "## 纪律（违反就算改坏）",
    "1. **只改被点名的段落**：其余段落、标题、表格、数字、标点**逐字不变**。",
    "2. 不许引入素材之外的任何信息、数字、结论；不许改数字与判定。",
    "3. 整章字数变化控制在 **±25%** 以内——这是改病句，不是重写。",
    "4. 章首段仍要是本章总纲：不超过 120 字、点明对象与当前处境、不以分号列举或半句开头。",
    "5. 输出**整章 Markdown**：以 `## 章名` 开头，保留原有 `### 小节` 标题与表格；不要前言、结语与代码块围栏。",
  ].join("\n");
  const user = [
    FIX_PROMPT_MARKER,
    "",
    `## 这一章的问题（只改这些）`,
    ...issues.map((i) => `- 【${i.type}】${i.anchor}……${i.note}`),
    "",
    `## 这一章现在的内容（${chapterTitle}）`,
    chapterMarkdown,
  ].join("\n");
  return { system, user };
}

/** 第三次调用：复查这几处解决没有（只记提示，不再改） */
export function buildVerifyPrompt(
  kind: ReportKind,
  markdown: string,
  issues: readonly ReviewIssue[],
): { system: string; user: string } {
  const label = REPORT_KIND_LABEL[kind];
  const system = [
    `你在复查《<场景>${label}》的修改结果：给你**原问题清单**与改后的正文，逐条判断解决没有。`,
    "",
    "- 只看被点名那处是否已经读得通、说得清；**不做新的评审**，不提新问题，不要求重写。",
    '- 输出严格 JSON：`{"unresolved":[{"anchor":"没解决的那条 anchor（原样）","note":"一句话说明"}]}`；',
    '  都解决了就是 `{"unresolved":[]}`。不要解释、不要代码块围栏。',
  ].join("\n");
  const user = [
    VERIFY_PROMPT_MARKER,
    "",
    "## 原问题清单",
    ...issues.map((i) => `- 【${i.type}】${i.anchor}……${i.note}`),
    "",
    "## 改后的正文",
    markdown,
  ].join("\n");
  return { system, user };
}

/** 章与章之间由装配层插的 `---` 分隔线：不属于这一章，改动时原样带回 */
const CHAPTER_SEPARATOR = /(?:\n+---\s*)+$/;

/**
 * 按章切出 `## 章名` 那一块的精确区间（含标题行；用于"其它章逐字不变"）
 *
 * 注意尾部的 `---` 装配分隔线要**排除在章之外**：模型只会返回这一章的内容，
 * 若把分隔线算进"改前的章"，每次改动都会被判成"动了没被点名的段落"（实测踩到过）。
 */
function chapterSlice(
  markdown: string,
  title: string,
): { start: number; end: number; text: string } | null {
  const heads: { title: string; start: number }[] = [];
  const re = /^##\s+(.+?)\s*$/gm;
  for (let m = re.exec(markdown); m !== null; m = re.exec(markdown)) {
    heads.push({ title: m[1]!.trim(), start: m.index });
  }
  const i = heads.findIndex((h) => h.title.includes(title) || title.includes(h.title));
  if (i < 0) return null;
  const start = heads[i]!.start;
  const end = i + 1 < heads.length ? heads[i + 1]!.start : markdown.length;
  const raw = markdown.slice(start, end);
  const sep = CHAPTER_SEPARATOR.exec(raw);
  const text = sep ? raw.slice(0, sep.index) : raw;
  return { start, end: start + text.length, text };
}

/** 把切出来的那块换掉（其余字节原样保留，分隔线归位） */
function replaceChapter(
  markdown: string,
  slice: { start: number; end: number },
  chapter: string,
): string {
  const tail = markdown.slice(slice.end);
  const head = markdown.slice(0, slice.start);
  const gap = tail.trim() === "" ? "" : "\n\n" + tail.replace(/^\n+/, "");
  return head + chapter.trim() + gap;
}

/** 从模型返回里取回改后的整章（没写 `## 章名` 时整段就是该章，补回标题） */
function fixedChapterOf(text: string, kind: ReportKind, title: string): string | undefined {
  const want = matchChapterKey(kind, title);
  if (want === null) return undefined;
  const parts = text.split(/\n(?=## )/);
  const hit = parts.find(
    (p) => matchChapterKey(kind, (p.match(/^## [^\n]*/) ?? [""])[0] ?? "") === want,
  );
  if (hit) return hit.trim();
  if (!/^##\s+/m.test(text)) return `## ${title}\n\n${text.trim()}`;
  return undefined;
}

/** 确定性补充（断头段 / 重复 / 空节 / 章首段）→ 带 `from: "终检"` 的违规 */
function deterministicViolations(markdown: string): ReportViolation[] {
  return deterministicReviewFindings(markdown).map((f) => ({ ...f, from: "终检" as const }));
}

/**
 * 一份交付物的终检：通读 → 逐章修 → 复查
 *
 * 任何一步失败都只降级为"跳过/保留原稿"，绝不抛错、绝不阻断出稿。
 */
export async function reviewReport(args: ReviewReportArgs): Promise<ReportReviewOutcome> {
  const { kind, markdown, scenarioName, dshClient, keepaliveMs, push, enabled } = args;
  const label = REPORT_KIND_LABEL[kind];
  const skip = (skipped: string): ReportReviewOutcome => {
    if (skipped !== "") {
      // 终检只降级不阻断：说清为什么跳过，正文照常出稿
      push({ type: "progress", message: `${label}：终检跳过（${skipped}），正文照常出稿` });
    }
    return {
      markdown,
      issues: 0,
      dropped: 0,
      fixed: 0,
      remaining: 0,
      violations: deterministicViolations(markdown),
      skipped,
    };
  };
  if (!enabled) return skip("");

  push({ type: "progress", message: `终检：通读「${scenarioName}${label}」找问题…` });
  let session: SessionHandle;
  try {
    session = await dshClient.createSession({ title: `${scenarioName}${label} · 终检` });
  } catch (err: unknown) {
    return skip(err instanceof Error ? err.message : String(err));
  }

  const read = await streamPrompt({
    dshClient,
    session,
    ...buildReviewPrompt(kind, markdown),
    label: `${label}（终检）`,
    keepaliveMs,
    push,
  });
  if (read.error) return skip(read.error);

  const firstChars = read.text.trim().length;
  let parsed = parseReviewIssues(read.text, markdown);
  if (parsed.error) {
    // 首次没吐合规 JSON（实测模型有时只回 3 个字）→ 用更短的提示**重试一次**，再失败才跳过
    push({
      type: "progress",
      message: `终检：首次输出 ${firstChars} 字且不是合规 JSON，重试一次…`,
    });
    const again = await streamPrompt({
      dshClient,
      session,
      ...buildReviewRetryPrompt(kind),
      label: `${label}（终检·重试）`,
      keepaliveMs,
      push,
    });
    if (again.error) {
      return skip(`首次输出 ${firstChars} 字且非合规 JSON，重试调用失败（${again.error}）`);
    }
    parsed = parseReviewIssues(again.text, markdown);
    if (parsed.error) return skip(`首次输出 ${firstChars} 字且非合规 JSON，重试后仍失败`);
  }
  if (parsed.issues.length === 0) {
    push({ type: "progress", message: `终检：未发现"读者会卡住"的问题` });
    return {
      markdown,
      issues: 0,
      dropped: parsed.dropped,
      fixed: 0,
      remaining: 0,
      violations: deterministicViolations(markdown),
    };
  }

  push({
    type: "progress",
    message: `终检：发现 ${parsed.issues.length} 处，正在逐章修…`,
  });

  let current = markdown;
  const open: ReviewIssue[] = [];
  const groups = new Map<string, ReviewIssue[]>();
  for (const issue of parsed.issues) {
    const key = matchChapterKey(kind, issue.chapter) ?? issue.chapter;
    groups.set(key, [...(groups.get(key) ?? []), issue]);
  }

  for (const [key, issues] of groups) {
    const title = reportChapters(kind).find((c) => c.key === key)?.label ?? issues[0]!.chapter;
    const slice = chapterSlice(current, title);
    if (!slice) {
      open.push(...issues);
      continue;
    }
    const fixed = await streamPrompt({
      dshClient,
      session,
      ...buildFixPrompt(kind, title, slice.text, issues),
      label: `${label}（终检·${title}）`,
      keepaliveMs,
      push,
    });
    const after = fixed.error ? undefined : fixedChapterOf(fixed.text, kind, title);
    if (after === undefined) {
      push({
        type: "progress",
        message: `${label}：终检改动「${title}」没拿到可用的整章，保留原稿`,
      });
      open.push(...issues);
      continue;
    }
    const guard = fixAccepted({
      before: slice.text,
      after,
      anchors: issues.map((i) => i.anchor),
      missingBefore: missingChapterArtifacts(kind, key, slice.text),
      missingAfter: missingChapterArtifacts(kind, key, after),
    });
    if (!guard.ok) {
      push({
        type: "progress",
        message: `${label}：终检改动「${title}」未过确定性检查（${guard.reason}），整章保留原稿`,
      });
      open.push(...issues);
      continue;
    }
    current = replaceChapter(current, slice, after);
  }

  // 复查：改完再问一次"这几处解决了吗"；仍存疑的只记提示，不再改
  const remainingIssues: ReviewIssue[] = [...open];
  if (open.length < parsed.issues.length) {
    const verify = await streamPrompt({
      dshClient,
      session,
      ...buildVerifyPrompt(kind, current, parsed.issues),
      label: `${label}（终检复查）`,
      keepaliveMs,
      push,
    });
    const unresolved = verify.error ? null : parseUnresolved(verify.text);
    if (unresolved === null) {
      push({ type: "progress", message: `${label}：终检复查没拿到结论，改过的部分按已解决记` });
    } else {
      for (const u of unresolved) {
        const hit = parsed.issues.find((i) => i.anchor === u.anchor);
        if (hit && !remainingIssues.some((i) => i.anchor === hit.anchor)) remainingIssues.push(hit);
        if (!hit) {
          remainingIssues.push({
            chapter: "",
            anchor: u.anchor,
            type: "读不通",
            note: u.note || "复查仍存疑",
          });
        }
      }
    }
  }
  const total = parsed.issues.length;
  const remaining = remainingIssues.length;
  const fixedCount = Math.max(0, total - remaining);

  // 终检产生的违规：仍存疑的问题逐条记提示（`from: "终检"` 让调用方看得出出处）
  const violations: ReportViolation[] = [
    ...deterministicViolations(current),
    ...remainingIssues.map((i) => ({
      kind: "终检问题" as const,
      hard: false,
      detail: `终检存疑：${i.type}——${i.note}（${i.chapter || "未定位"}｜${i.anchor}）`,
      from: "终检" as const,
    })),
  ];

  push({
    type: "progress",
    message: `终检：发现 ${total} 处，改了 ${fixedCount} 处，留 ${remaining} 处提示`,
  });
  return {
    markdown: current,
    issues: total,
    dropped: parsed.dropped,
    fixed: fixedCount,
    remaining,
    violations,
  };
}
