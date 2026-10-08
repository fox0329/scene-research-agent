/**
 * @scene/server — 导出 PPT（变更表 #141 立、#142 升：信息量与排版；#145 升：生成后版面检查；
 * #146 升：**大纲质量要求 + 三轮修复闭环**）
 *
 * 用户点一次「导出PPT文档」，全自动跑完，不需要任何交互。变更表 #146 起编排是**最多三轮的闭环**
 * （`PPT_OUTLINE_ROUNDS = 3`），每一轮：
 *   1. **重新取正文**（`getReport`，每轮都重读——正文被用户改过时下一轮就用新的）；
 *   2. **重新生成大纲**（一次模型调用 + 不合要求时重试一次）；
 *   3. **优化大纲**（变更表 #146 新增的第二次模型调用 `buildPptOutlineReviewPrompt`：
 *      把这一轮的 JSON + 上一轮的问题清单喂进去，要求"只输出优化后的完整 JSON、不许删内容、
 *      点对点解决列出的问题"）；
 *   4. **确定性渲染**（`@scene/infra` 按七种布局画 SVG；图标只写 `data-icon` 占位）；
 *   5. **检查**：`checkPptOutlineQuality`（大纲质量判据：观点型标题 / 记忆点 / 信息量 / 数字可溯源 /
 *      页间不重复 / 叙事顺序 / 自包含 / 图标与版式）+ `checkPptDeck`（版面质量门禁）。
 *
 * **上一轮的全部问题**（两类都点名到页）作为下一轮的反馈喂进生成 / 优化提示词；问题清单为空
 * 即通过、立刻导出。**三轮都过不了不报错**（用户定调「不是不满足标准就报错或者什么的」）：
 * 取**问题最少的那一轮**产物照常导出，notice 写清「已生成，但仍有 N 处未达标：第X页…」，
 * **不拒绝写出、不抛错、不阻断**（#145 的"不达标就拒绝写出"口径就此作废）。
 *
 * 与导出 Word 同一条纪律（`docx-export.ts`）：技能缺失 / python3 不可用 / 大纲不合法 /
 * 子进程失败，一律只回一条 `notice` + 不产文件，绝不抛 500、绝不覆盖已有文件
 * （落盘走 `safeWriteFileBytes` 的先读后写：内容没变记为 `unchanged`）。
 *
 * 临时项目目录建在 `os.tmpdir()`，跑完就删（无论成败）。
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  PPT_LIMITS,
  PPT_OUTLINE_QUALITY,
  PPT_OUTLINE_ROUNDS,
  REPORT_KIND_LABEL,
  type DshClient,
  type FollowEvent,
  type PptIssue,
  type PptOutline,
  type ReportKind,
  type Scenario,
  type SessionHandle,
} from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import {
  PPT_MIN_QUALITY,
  checkPptDeck,
  exportFileName,
  isPptContentIssue,
  isPptRenderIssue,
  renderPptDeck,
  safeWriteFileBytes,
  writePptSvgs,
  type PptQualityIssue,
  type PptSvgPage,
} from "@scene/infra";
import {
  checkPptOutlineQuality,
  parsePptOutline,
  pptPageSentenceBar,
  type PptOutlineParse,
} from "@scene/domain";
import { getReport } from "./report-service.js";
import { streamPrompt } from "./dsh-stream.js";
import {
  buildPptOutlinePrompt,
  buildPptOutlineReviewPrompt,
  buildPptRetryPrompt,
} from "./ppt-prompt.js";

const run = promisify(execFile);

/** 转档子进程超时（技能里装依赖/首次运行时也可能慢，给足 2 分钟） */
export const PPT_EXPORT_TIMEOUT_MS = 120_000;

/** 默认技能目录（用户本机 DSH 的技能；只读，不修改） */
export function pptMasterDir(): string {
  return process.env.PPT_MASTER_DIR ?? join(homedir(), ".dsh", "skills", "ppt-master");
}

/** 技能里的导出器脚本；技能没装返回 null（调用方只提示、不报错） */
export function pptExporterScript(dir = pptMasterDir()): string | null {
  const script = join(dir, "scripts", "svg_to_pptx.py");
  return existsSync(script) ? script : null;
}

/**
 * 技能里的 SVG 收尾脚本（图标嵌入 + 圆角转路径）；老版本技能没有它 → 返回 null（只提示、不报错）
 *
 * 与转档脚本同一套"技能目录可配"的口径：`PPT_MASTER_DIR` → `~/.dsh/skills/ppt-master`。
 */
export function pptFinalizeScript(dir = pptMasterDir()): string | null {
  const script = join(dir, "scripts", "finalize_svg.py");
  return existsSync(script) ? script : null;
}

export interface PptExportResult {
  /** 实际落盘的文件（被手改过时会是另存名） */
  files: string[];
  /** 没写盘的文件（内容与磁盘上完全一致） */
  unchanged: string[];
  /** 需要提示用户的话（技能缺失 / 大纲失败 / 转档失败 / 被手改过） */
  notice?: string;
}

export interface PptExportArgs {
  db: DbInstance;
  scenario: Scenario;
  kind: ReportKind;
  /** 导出目标目录（路由已校验过：主目录下的可写文件夹） */
  dir: string;
  dshClient: DshClient;
  /** 阶段进度（SSE 通道 / 单测的 spy） */
  push: (event: FollowEvent) => void;
  keepaliveMs?: number;
  /** 技能目录覆盖（测试用；默认 `PPT_MASTER_DIR` → `~/.dsh/skills/ppt-master`） */
  skillDir?: string;
}

/** 只回一条提示、不产文件（技能缺失 / 大纲失败 / 转档失败都走这里） */
function refuse(notice: string): PptExportResult {
  return { files: [], unchanged: [], notice };
}

/** 交付物文件名 → PPT 文件名（`<场景>解决方案.pptx`，与 Word 同口径） */
export function pptFileName(scenarioName: string, kind: ReportKind): string {
  return exportFileName(scenarioName, kind).replace(/\.md$/, ".pptx");
}

interface OutlineOutcome {
  outline: PptOutline | null;
  /** 失败原因（人话，直接进 notice） */
  error?: string;
  /** 校验时被丢掉/擦掉的内容说明（随成功结果一起提示） */
  notes: string[];
  /** 模型会话（版面检查不达标时还要再发一次重试提示，复用同一个会话） */
  session: SessionHandle | null;
}

/** 一次模型调用 + 解析失败重试一次（重试仍失败 → 失败值，不阻断、不产文件） */
async function buildOutline(args: {
  dshClient: DshClient;
  scenario: Scenario;
  kind: ReportKind;
  markdown: string;
  keepaliveMs: number;
  push: (event: FollowEvent) => void;
  /** 上一轮判出的问题（变更表 #146：带进这一轮的生成 / 重试提示词，点对点改） */
  feedback: readonly PptIssue[];
}): Promise<OutlineOutcome> {
  const { dshClient, scenario, kind, markdown, keepaliveMs, push, feedback } = args;
  const label = REPORT_KIND_LABEL[kind];
  let session;
  try {
    session = await dshClient.createSession({ title: `${scenario.name} · PPT 大纲` });
  } catch (err: unknown) {
    return {
      outline: null,
      error: `无法创建模型会话（${err instanceof Error ? err.message : String(err)}）`,
      notes: [],
      session: null,
    };
  }
  const first = await streamPrompt({
    dshClient,
    session,
    ...buildPptOutlinePrompt(kind, scenario.name, markdown, feedback),
    label: `PPT 大纲（${label}）`,
    keepaliveMs,
    push,
  });
  if (first.error) return { outline: null, error: first.error, notes: [], session };

  let parsed = parsePptOutline(first.text);
  // 诊断（变更表 #142 收尾）：模型偶发返回非 JSON，失败时把长度与开头记进服务端日志，
  // 方便定位"到底是返空、返了说明、还是 JSON 被截断"，不把原文写进用户可见的 notice
  if (parsed.outline === null) {
    console.warn(
      `[ppt] 大纲首次解析失败：返回 ${first.text.length} 字｜开头 ${JSON.stringify(first.text.trim().slice(0, 120))}｜原因 ${parsed.error ?? "-"}`,
    );
  }
  const reason = retryReason(parsed, first.text.trim().length);
  if (reason !== null) {
    push({ type: "progress", message: `PPT：${reason}，重试一次…` });
    const again = await streamPrompt({
      dshClient,
      session,
      ...buildPptRetryPrompt(kind, scenario.name, reason, feedback),
      label: "PPT 大纲（重试）",
      keepaliveMs,
      push,
    });
    if (again.error) {
      // 重试连调用都失败：首次本来就不可用才算失败；首次只是内容偏少时保留首次（有总比没有好）
      if (parsed.outline === null) {
        return {
          outline: null,
          error: `首次输出不合法（${reason}），重试调用失败（${again.error}）`,
          notes: [],
          session,
        };
      }
    } else {
      parsed = pickBetter(parsed, parsePptOutline(again.text));
      if (parsed.outline === null) {
        return {
          outline: null,
          error: `模型未返回合规 JSON（${parsed.error ?? "首次与重试都不合规"}）`,
          notes: [],
          session,
        };
      }
    }
  }
  return { outline: parsed.outline, notes: [...parsed.notes, ...thinNotes(parsed)], session };
}

// ─── 生成后版面检查（变更表 #145） ──────────────────────────

interface DeckCheck {
  /** 全部问题（空数组 = 达标） */
  all: PptQualityIssue[];
  /** 内容类问题（可点名后让模型重写一次） */
  content: PptQualityIssue[];
  /** 渲染类问题（确定性缺陷，只能改渲染层） */
  render: PptQualityIssue[];
}

/** 一份渲染产物过一遍质量门禁，并按"内容类 / 渲染类"分好（用户定调的 `PPT_MIN_QUALITY`） */
function inspectDeck(pages: readonly PptSvgPage[]): DeckCheck {
  const all = checkPptDeck(pages.map((p) => p.svg));
  return {
    all,
    content: all.filter((i) => isPptContentIssue(i.code)),
    render: all.filter((i) => isPptRenderIssue(i.code)),
  };
}

/** 问题清单 → 人话（`第 3 页信息量不足：只有 9 条文字…`，最多点名前 4 条，免得 notice 太长） */
function issueText(issues: readonly PptIssue[]): string {
  return issues
    .slice(0, 4)
    .map((i) => `第 ${i.page} 页${i.code}：${i.detail}`)
    .join("；");
}

/**
 * 版面最低要求的一句话（写进 notice，让用户知道这一档质量卡在哪几条线上）
 *
 * 阈值取自 `PPT_MIN_QUALITY`（变更表 #145：用户定调的**最低要求**，只许收紧不许放宽）——
 * 导出链路**直接引用**它，所以这一档质量不可能被悄悄关掉。
 */
function minRequirementText(): string {
  return [
    `最低要求：内容字号 ≥${PPT_MIN_QUALITY.minFontSize}px`,
    `内容距画布边 ≥${PPT_MIN_QUALITY.minContentMargin}px`,
    `内容区底部留白 ≤${PPT_MIN_QUALITY.maxBottomGap}px`,
  ].join("、");
}

/**
 * 大纲最低要求的一句话（变更表 #146，写进"仍有 N 处未达标"的 notice）
 *
 * 数字全部从契约 `PPT_OUTLINE_QUALITY` 现取（改阈值就会改文案，改不动才怪）。
 */
function outlineMinRequirementText(): string {
  return [
    `大纲最低要求：标题是一句判断（不是「${PPT_OUTLINE_QUALITY.weakTitleWords.slice(0, 3).join("/")}」这类章节名）`,
    `每页 ≥${PPT_OUTLINE_QUALITY.minSentencesPerPage} 条有效短句`,
    `数字只能来自报告正文`,
    `不许两页说同一件事`,
    `叙事按 问题 → 方案 → 价值`,
  ].join("、");
}

/**
 * 优化大纲（变更表 #146）：**复用同一个会话**，把这一轮的 JSON + 上一轮问题清单喂进去
 *
 * 要求是"只输出优化后的完整 JSON、schema 不变、不许删内容、点对点解决列出的问题"。
 * 返回 null = 这次评审没拿到合规大纲（调用方保留生成的那一份，绝不因此丢整轮产物）。
 */
async function reviewOutline(args: {
  dshClient: DshClient;
  session: SessionHandle;
  kind: ReportKind;
  scenarioName: string;
  outline: PptOutline;
  issues: readonly PptIssue[];
  round: number;
  keepaliveMs: number;
  push: (event: FollowEvent) => void;
}): Promise<{ outline: PptOutline; notes: string[] } | null> {
  const reviewed = await streamPrompt({
    dshClient: args.dshClient,
    session: args.session,
    ...buildPptOutlineReviewPrompt({
      kind: args.kind,
      scenarioName: args.scenarioName,
      outline: args.outline,
      issues: args.issues,
      round: args.round,
    }),
    label: "PPT 大纲（优化）",
    keepaliveMs: args.keepaliveMs,
    push: args.push,
  });
  if (reviewed.error) {
    console.warn(`[ppt] 大纲优化调用失败，保留生成的那一份：${reviewed.error}`);
    return null;
  }
  const parsed = parsePptOutline(reviewed.text);
  if (parsed.outline === null) {
    console.warn(`[ppt] 大纲优化没返回合规 JSON，保留生成的那一份：${parsed.error ?? "-"}`);
    return null;
  }
  return { outline: parsed.outline, notes: [...parsed.notes, ...thinNotes(parsed)] };
}

/**
 * 页面内容偏少的判定线
 *
 * 领域层的"有效短句"**不数** 6 条固定骨架文本（小节标签 / 标题 / 副题 / 结论带 / 页码 / 页脚），
 * 而质量门禁的 `PPT_LIMITS.minSentencesPerPage`（12）把骨架也算进去了 —— 所以这里取 8，
 * 比门禁更严一档：真跑暴露过"一页只有 2 条短句"的空页，等渲染完再发现就晚了。
 * 版式结构上限不足 8 条的（数据卡片 8 / 要点清单 6）按"写满"算（`pptPageSentenceBar`）。
 */
const THIN_PAGE_MIN = 8;

/** 有效短句数不足的页（页码从 1 开始；来源是领域层的 `pageSentences`） */
function thinPages(parsed: PptOutlineParse): { page: number; count: number }[] {
  const pages = parsed.outline?.pages ?? [];
  return parsed.pageSentences
    .map((count, i) => ({ page: i + 1, count, bar: Math.min(THIN_PAGE_MIN, pptPageSentenceBar(pages[i]?.layout ?? "要点清单")) }))
    .filter((x) => x.count < x.bar);
}

/**
 * 重试用哪一份
 *
 * 首次**解析不出来**时当然用重试的；首次只是**内容偏少**时不能无条件换掉——
 * 重试可能更差（甚至不是 JSON），那就保留首次。比法：先比空页数，再比页数。
 */
function pickBetter(first: PptOutlineParse, again: PptOutlineParse): PptOutlineParse {
  if (again.outline === null) return first;
  if (first.outline === null) return again;
  const thinDiff = thinPages(again).length - thinPages(first).length;
  if (thinDiff !== 0) return thinDiff < 0 ? again : first;
  return again.outline.pages.length >= first.outline.pages.length ? again : first;
}

/**
 * 要不要重试（只重试一次）
 *
 * 三种情形值得重试：**根本解析不出来**、**页数少于 5 页下限**、**有页面内容太少**（空页）。
 * 用户口径是 5–10 页且每页要写满，少页/空页多半是模型偷懒，重发一次比直接出一份稀薄的 PPT 更接近用户要的。
 * 页数只是略多（>10 截尾）不重试：确定性层已经能处理好，省一次模型调用。
 */
function retryReason(parsed: PptOutlineParse, chars: number): string | null {
  if (parsed.error) return `首次输出 ${chars} 字且不是合规大纲`;
  if ((parsed.outline?.pages.length ?? 0) < PPT_LIMITS.minPages) {
    return `首次只排了 ${parsed.outline?.pages.length ?? 0} 页（少于 ${PPT_LIMITS.minPages} 页下限）`;
  }
  const thin = thinPages(parsed);
  if (thin.length > 0) {
    const where = thin.slice(0, 3).map((p) => `第 ${p.page} 页只有 ${p.count} 条`).join("、");
    return `${where}（每页请写到 ${PPT_LIMITS.minSentencesPerPage} 条以上）`;
  }
  return null;
}

/** 重试后仍偏少的页：不阻断，只在 notice 里点名（用户知道哪一页需要自己补） */
function thinNotes(parsed: PptOutlineParse): string[] {
  const thin = thinPages(parsed);
  if (thin.length === 0) return [];
  const where = thin.slice(0, 4).map((p) => `第 ${p.page} 页只有 ${p.count} 条`).join("、");
  return [`${where}，内容偏少（每页建议 ${PPT_LIMITS.minSentencesPerPage} 条以上）`];
}

interface RenderOutcome {
  svgDir: string | null;
  /** 渲染出来的页面（版面检查直接量内存里的 SVG，不重读盘） */
  pages: PptSvgPage[];
  error?: string;
}

/** 逐页渲染 SVG（每页一条进度，不逐帧刷屏；重渲前先清空上一版，免得少页时留下旧页） */
function renderPages(
  outline: PptOutline,
  projectDir: string,
  scenarioName: string,
  push: (event: FollowEvent) => void,
): RenderOutcome {
  try {
    rmSync(join(projectDir, "svg_output"), { recursive: true, force: true });
    rmSync(join(projectDir, "svg_final"), { recursive: true, force: true });
    const pages = renderPptDeck(outline, {
      scenarioName,
      onPage: (index, total) =>
        push({ type: "progress", message: `PPT：大纲 ${total} 页，正在渲染第 ${index + 1} 页…` }),
    });
    return { svgDir: writePptSvgs(projectDir, pages), pages };
  } catch (err: unknown) {
    return {
      svgDir: null,
      pages: [],
      error: `页面写盘失败（${err instanceof Error ? err.message : String(err)}）`,
    };
  }
}

/**
 * 转档前先收尾 SVG（变更表 #144）
 *
 * **参数逐字固定**：`finalize_svg.py <项目目录> --only embed-icons fix-rounded`。
 * `--only` 里**不带 `flatten-text`**：PPT 里的文字必须仍是可编辑文本（`<tspan>` 强调段由
 * ppt-master 的原生转档保留成同一段落的多个 run）。超时与转档同一套。
 */
async function finalizeSvgs(
  script: string,
  projectDir: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await run("python3", [script, projectDir, "--only", "embed-icons", "fix-rounded"], {
      timeout: PPT_EXPORT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true };
  } catch (err: unknown) {
    const e = err as { code?: string; killed?: boolean; stderr?: unknown; message?: string };
    if (e.code === "ENOENT") return { ok: false, reason: "本机没有可用的 python3" };
    if (e.killed) return { ok: false, reason: `收尾超过 ${PPT_EXPORT_TIMEOUT_MS / 1000} 秒未完成` };
    const detail = String(e.stderr ?? e.message ?? "").trim().slice(-300);
    return { ok: false, reason: detail === "" ? "收尾子进程失败" : detail };
  }
}

/**
 * 图标收尾（找不到脚本 / 跑失败都只 `console.warn`，**绝不阻断导出**）
 *
 * 图标是"锦上添花"：技能缺脚本、python3 挂了、图标库对不上，都不该让用户拿不到 pptx。
 * 技能目录本身缺失走的是上面「找不到 ppt-master 技能」那条既有 notice 分支。
 */
async function embedIcons(skillDir: string, projectDir: string, push: PptExportArgs["push"]): Promise<void> {
  const script = pptFinalizeScript(skillDir);
  if (script === null) {
    console.warn("[ppt-export] 技能里没有 scripts/finalize_svg.py，跳过图标嵌入（老版本技能？）");
    return;
  }
  push({ type: "progress", message: "PPT：正在嵌入图标…" });
  const done = await finalizeSvgs(script, projectDir);
  if (!done.ok) console.warn(`[ppt-export] finalize_svg.py 未成功，跳过图标嵌入继续导出：${done.reason}`);
}

/** 跑技能里的导出器（`--no-compat`：本机没装 cairosvg，原生模式在 PowerPoint 里可编辑） */
async function convertToPptx(
  script: string,
  projectDir: string,
  outFile: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await run("python3", [script, projectDir, "-o", outFile, "--no-compat", "-f", "ppt169"], {
      timeout: PPT_EXPORT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const e = err as { code?: string; killed?: boolean; stderr?: unknown; message?: string };
    if (e.code === "ENOENT") return { ok: false, reason: "本机没有可用的 python3" };
    if (e.killed) return { ok: false, reason: `转档超过 ${PPT_EXPORT_TIMEOUT_MS / 1000} 秒未完成` };
    const detail = String(e.stderr ?? e.message ?? "").trim().slice(-300);
    return { ok: false, reason: detail === "" ? "转档子进程失败" : detail };
  }
  if (!existsSync(outFile)) return { ok: false, reason: "转档没有产出文件" };
  return { ok: true };
}

/** 落盘（先读后写：内容没变不碰文件，用户手改过就另存） */
function savePptx(dir: string, scenarioName: string, kind: ReportKind, bytes: Buffer): PptExportResult {
  const saved = safeWriteFileBytes(join(dir, pptFileName(scenarioName, kind)), bytes);
  const result: PptExportResult = {
    files: saved.written ? [saved.path] : [],
    unchanged: saved.written ? [] : [saved.path],
  };
  if (saved.notice) result.notice = saved.notice;
  return result;
}

/** 大纲校验时的提示（丢页 / 截断 / 内容偏少）拼进 notice，让用户知道 PPT 与正文的差异 */
function withNotes(result: PptExportResult, notes: readonly string[]): PptExportResult {
  if (notes.length === 0) return result;
  const text = `PPT 大纲有 ${notes.length} 处调整：${notes.slice(0, 4).join("；")}`;
  return { ...result, notice: result.notice ? `${result.notice}；${text}` : text };
}

/**
 * 一轮闭环的产物（变更表 #146）
 *
 * 问题数目就是"这一轮有多好"的度量：三轮都过不了时取问题最少的那一轮（`pickBestRound`）。
 */
interface RoundOutcome {
  /** 第几轮（1 起） */
  round: number;
  /** 这一轮最终采纳的大纲（评审产物优先，评审失败时是生成的那一份） */
  outline: PptOutline;
  /** 这一轮渲染出来的页面（已在盘上写过一次） */
  pages: PptSvgPage[];
  /** 大纲校验的调整说明（丢页 / 截断） */
  notes: string[];
  /** 大纲质量判据 + 版面门禁的全部问题（点名到页） */
  issues: PptIssue[];
}

/** 问题最少的那一轮（并列时取更靠后的一轮——它已经过更多轮优化） */
function pickBestRound(rounds: readonly RoundOutcome[]): RoundOutcome {
  return rounds.reduce((best, cur) => (cur.issues.length <= best.issues.length ? cur : best));
}

/** 收尾：图标收尾 → 转档 → 落盘（通过与否都走这一条，notice 由调用方拼） */
async function finishExport(args: {
  projectDir: string;
  scenario: Scenario;
  kind: ReportKind;
  dir: string;
  script: string;
  skillDir: string;
  notes: readonly string[];
  push: (event: FollowEvent) => void;
  result?: PptExportResult;
}): Promise<PptExportResult> {
  const { projectDir, scenario, kind, dir, script, skillDir, notes, push } = args;
  await embedIcons(skillDir, projectDir, push);
  push({ type: "progress", message: "PPT：正在转成 PPTX…" });
  const outFile = join(projectDir, "out.pptx");
  const converted = await convertToPptx(script, projectDir, outFile);
  if (!converted.ok) return refuse(`PPT 未导出（转档失败：${converted.reason}）`);
  const saved = savePptx(dir, scenario.name, kind, readFileSync(outFile));
  const merged: PptExportResult = args.result ? mergeNotice(args.result, saved) : saved;
  push({ type: "progress", message: `PPT：已导出 ${basename(merged.files[0] ?? merged.unchanged[0] ?? "")}` });
  return withNotes(merged, notes);
}

/** 把"仍有未达标"的 notice 与落盘 notice（被手改过会另存）合成一条 */
function mergeNotice(main: PptExportResult, saved: PptExportResult): PptExportResult {
  return {
    files: saved.files,
    unchanged: saved.unchanged,
    notice: saved.notice ? `${main.notice ?? ""}；${saved.notice}` : main.notice,
  };
}

/**
 * 导出某一份交付物的 PPT（唯一入口，变更表 #146：最多三轮的"提取 → 优化 → 检查"闭环）
 *
 * 每一轮都**重新读正文**（用户改过正文时下一轮就用新的），问题清单为空即通过、立即导出；
 * 三轮都过不了**不报错**：取问题最少的那一轮照常导出，notice 点名未达标处。
 * 技能缺失 / 大纲整体失败 / 子进程失败仍然只回 `notice`、不产半个文件（AGENTS.md §六.2）。
 */
export async function exportReportPptx(args: PptExportArgs): Promise<PptExportResult> {
  const { db, scenario, kind, dir, dshClient, push } = args;
  const keepaliveMs = args.keepaliveMs ?? 30_000;
  const skillDir = args.skillDir ?? pptMasterDir();
  const script = pptExporterScript(skillDir);
  if (script === null) {
    push({ type: "progress", message: "PPT：导出组件未就绪" });
    return refuse("PPT 导出组件未就绪：找不到 ppt-master 技能（可用 PPT_MASTER_DIR 指定技能目录）");
  }
  if (getReport(db, scenario, kind).markdown.trim() === "") {
    return refuse(`PPT 未导出：「${scenario.name}${REPORT_KIND_LABEL[kind]}」还没有正文`);
  }

  let projectDir: string | null = null;
  try {
    projectDir = mkdtempSync(join(tmpdir(), `scene-ppt-${safeSegment(scenario.id)}-`));
    const rounds: RoundOutcome[] = [];
    let feedback: readonly PptIssue[] = [];
    let lastError: string | null = null;

    for (let round = 1; round <= PPT_OUTLINE_ROUNDS; round += 1) {
      // ① 每轮重新读正文：用户在中栏改过报告，这一轮就要用新的
      const markdown = getReport(db, scenario, kind).markdown;
      push({ type: "progress", message: `PPT：正在从正文提取大纲（第 ${round} 轮）…` });
      const built = await buildOutline({ dshClient, scenario, kind, markdown, keepaliveMs, push, feedback });
      if (built.outline === null) {
        lastError = built.error ?? "模型未返回合规 JSON";
        continue;
      }

      // ② 优化大纲（变更表 #146）：带着上一轮的问题再要一次完整 JSON，失败就保留生成的那一份
      push({ type: "progress", message: "PPT：正在优化大纲…" });
      const reviewed =
        built.session === null
          ? null
          : await reviewOutline({
              dshClient,
              session: built.session,
              kind,
              scenarioName: scenario.name,
              outline: built.outline,
              issues: feedback,
              round,
              keepaliveMs,
              push,
            });
      const outline = reviewed?.outline ?? built.outline;
      const notes = reviewed?.notes ?? built.notes;

      // ③ 渲染
      const rendered = renderPages(outline, projectDir, scenario.name, push);
      if (rendered.svgDir === null) {
        lastError = rendered.error ?? "渲染失败";
        continue;
      }

      // ④ 检查：大纲质量判据 + 版面门禁（两类问题都点名到页）
      push({ type: "progress", message: "PPT：正在做版面检查…" });
      const deck = inspectDeck(rendered.pages);
      // 渲染类问题是我们的 bug 信号，不许静默放过（但不再因此拒绝导出）
      for (const issue of deck.render) {
        console.warn(`[ppt-export] 版面检查未过（渲染类）第 ${issue.page} 页${issue.code}：${issue.detail}`);
      }
      const issues: PptIssue[] = [...checkPptOutlineQuality(outline, markdown), ...deck.all];
      if (issues.length === 0) {
        push({ type: "progress", message: `PPT：版面检查通过（${rendered.pages.length} 页）` });
        return await finishExport({ projectDir, scenario, kind, dir, script, skillDir, notes, push });
      }
      rounds.push({ round, outline, pages: rendered.pages, notes, issues });
      feedback = issues;
      console.warn(
        `[ppt-export] 第 ${round} 轮大纲仍有 ${issues.length} 处未达标：${issueText(issues)}`,
      );
    }

    // 三轮都过不了：**不报错**，取问题最少的那一轮照常导出（用户明确的取舍）
    if (rounds.length === 0) {
      return refuse(`PPT 大纲生成失败（${lastError ?? "模型未返回合规 JSON"}），未导出 PPT`);
    }
    const best = pickBestRound(rounds);
    // 盘上现在是最后一轮渲染的产物；如果最优的不是最后一轮，重画一次再转档（静默渲染，不再刷进度）
    if (rounds[rounds.length - 1] !== best) {
      const again = renderPages(best.outline, projectDir, scenario.name, () => undefined);
      if (again.svgDir === null) return refuse(`PPT 未导出：${again.error ?? "渲染失败"}`);
    }
    push({
      type: "progress",
      message: `PPT：三轮仍未全达标，按问题最少的一轮（第 ${best.round} 轮）导出…`,
    });
    const notice =
      `已生成，但仍有 ${best.issues.length} 处未达标：${issueText(best.issues)}` +
      `（${outlineMinRequirementText()}；${minRequirementText()}；已按问题最少的一轮（第 ${best.round} 轮）导出）`;
    return await finishExport({
      projectDir,
      scenario,
      kind,
      dir,
      script,
      skillDir,
      notes: best.notes,
      push,
      result: { files: [], unchanged: [], notice },
    });
  } catch (err: unknown) {
    return refuse(`PPT 未导出：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (projectDir !== null) rmSync(projectDir, { recursive: true, force: true });
  }
}

/** 临时目录名里只留安全字符（id 来自库里，不假设它一定是 UUID） */
function safeSegment(id: string): string {
  const cleaned = id.replace(/[^\w.-]/g, "");
  return cleaned === "" ? "scenario" : cleaned.slice(0, 60);
}
