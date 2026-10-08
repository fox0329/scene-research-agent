/**
 * @scene/server — 导出 PPT（变更表 #141）
 *
 * 用户点一次「导出PPT文档」，全自动跑完四步，不需要任何交互：
 *   1. **取正文**：当前项目该口径的交付物正文（`solution` / `construction` 各自可导）；
 *   2. **模型产大纲**（一次调用 + 解析失败重试一次）：严格 JSON、5–10 页、无封面尾页、
 *      问题 → 方案 → 价值——口径见 `docs/PPT输出要求.md` 与 `ppt-prompt.ts`；
 *   3. **确定性渲染**：`@scene/infra` 按五种布局画 SVG（绝不让模型写 SVG）；
 *   4. **转档**：调用户本机的 ppt-master 技能（`PPT_MASTER_DIR` 可配）导出 pptx，落到用户选的目录。
 *
 * 与导出 Word 同一条纪律（`docx-export.ts`）：**不阻断**——技能缺失 / python3 不可用 /
 * 大纲不合法 / 子进程失败，一律只回一条 `notice` + 不产文件，绝不抛 500、绝不覆盖已有文件
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
  REPORT_KIND_LABEL,
  type DshClient,
  type FollowEvent,
  type PptOutline,
  type ReportKind,
  type Scenario,
} from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { exportFileName, renderPptDeck, safeWriteFileBytes, writePptSvgs } from "@scene/infra";
import { parsePptOutline, type PptOutlineParse } from "@scene/domain";
import { getReport } from "./report-service.js";
import { streamPrompt } from "./dsh-stream.js";
import { buildPptOutlinePrompt, buildPptRetryPrompt } from "./ppt-prompt.js";

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
}

/** 一次模型调用 + 解析失败重试一次（重试仍失败 → 失败值，不阻断、不产文件） */
async function buildOutline(args: {
  dshClient: DshClient;
  scenario: Scenario;
  kind: ReportKind;
  markdown: string;
  keepaliveMs: number;
  push: (event: FollowEvent) => void;
}): Promise<OutlineOutcome> {
  const { dshClient, scenario, kind, markdown, keepaliveMs, push } = args;
  const label = REPORT_KIND_LABEL[kind];
  push({ type: "progress", message: "PPT：正在梳理大纲…" });
  let session;
  try {
    session = await dshClient.createSession({ title: `${scenario.name} · PPT 大纲` });
  } catch (err: unknown) {
    return { outline: null, error: `无法创建模型会话（${err instanceof Error ? err.message : String(err)}）`, notes: [] };
  }
  const first = await streamPrompt({
    dshClient,
    session,
    ...buildPptOutlinePrompt(kind, scenario.name, markdown),
    label: `PPT 大纲（${label}）`,
    keepaliveMs,
    push,
  });
  if (first.error) return { outline: null, error: first.error, notes: [] };

  let parsed = parsePptOutline(first.text);
  const reason = retryReason(parsed, first.text.trim().length);
  if (reason !== null) {
    push({ type: "progress", message: `PPT：${reason}，重试一次…` });
    const again = await streamPrompt({
      dshClient,
      session,
      ...buildPptRetryPrompt(kind, scenario.name),
      label: "PPT 大纲（重试）",
      keepaliveMs,
      push,
    });
    if (again.error) {
      return { outline: null, error: `首次输出不合法（${reason}），重试调用失败（${again.error}）`, notes: [] };
    }
    parsed = parsePptOutline(again.text);
    if (parsed.error) return { outline: null, error: `模型未返回合规 JSON（${parsed.error}）`, notes: [] };
  }
  return { outline: parsed.outline, notes: [...parsed.notes] };
}

/**
 * 要不要重试（只重试一次）
 *
 * 两种情形值得重试：**根本解析不出来**，和**页数少于 5 页下限**——用户口径是 5–10 页，
 * 少页多半是模型偷懒，重发一次格式要求比直接出一份 4 页的 PPT 更接近用户要的规模。
 * 页数只是略多/略少（>10 截尾）不重试：那种情况确定性层已经能处理好，省一次模型调用。
 */
function retryReason(parsed: PptOutlineParse, chars: number): string | null {
  if (parsed.error) return `首次输出 ${chars} 字且不是合规大纲`;
  if ((parsed.outline?.pages.length ?? 0) < PPT_LIMITS.minPages) {
    return `首次只排了 ${parsed.outline?.pages.length ?? 0} 页（少于 ${PPT_LIMITS.minPages} 页下限）`;
  }
  return null;
}

interface RenderOutcome {
  svgDir: string | null;
  error?: string;
}

/** 逐页渲染 SVG（每页一条进度，不逐帧刷屏） */
function renderPages(
  outline: PptOutline,
  projectDir: string,
  scenarioName: string,
  push: (event: FollowEvent) => void,
): RenderOutcome {
  try {
    const pages = renderPptDeck(outline, {
      scenarioName,
      onPage: (index, total) =>
        push({ type: "progress", message: `PPT：大纲 ${total} 页，正在渲染第 ${index + 1} 页…` }),
    });
    return { svgDir: writePptSvgs(projectDir, pages) };
  } catch (err: unknown) {
    return { svgDir: null, error: `页面写盘失败（${err instanceof Error ? err.message : String(err)}）` };
  }
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

/** 大纲校验时的提示（丢页 / 截断）拼进 notice，让用户知道 PPT 与正文的差异 */
function withNotes(result: PptExportResult, notes: readonly string[]): PptExportResult {
  if (notes.length === 0) return result;
  const text = `PPT 大纲有 ${notes.length} 处调整：${notes.slice(0, 4).join("；")}`;
  return { ...result, notice: result.notice ? `${result.notice}；${text}` : text };
}

/**
 * 导出某一份交付物的 PPT（唯一入口）
 *
 * 任何一步失败都只回 `notice`，不抛错、不产半个文件（AGENTS.md §六.2 兜底要求）。
 */
export async function exportReportPptx(args: PptExportArgs): Promise<PptExportResult> {
  const { db, scenario, kind, dir, dshClient, push } = args;
  const keepaliveMs = args.keepaliveMs ?? 30_000;
  const script = pptExporterScript(args.skillDir ?? pptMasterDir());
  if (script === null) {
    push({ type: "progress", message: "PPT：导出组件未就绪" });
    return refuse("PPT 导出组件未就绪：找不到 ppt-master 技能（可用 PPT_MASTER_DIR 指定技能目录）");
  }
  const markdown = getReport(db, scenario, kind).markdown;
  if (markdown.trim() === "") {
    return refuse(`PPT 未导出：「${scenario.name}${REPORT_KIND_LABEL[kind]}」还没有正文`);
  }

  const built = await buildOutline({ dshClient, scenario, kind, markdown, keepaliveMs, push });
  if (built.outline === null) {
    return refuse(`PPT 大纲生成失败（${built.error ?? "模型未返回合规 JSON"}），未导出 PPT`);
  }

  let projectDir: string | null = null;
  try {
    projectDir = mkdtempSync(join(tmpdir(), `scene-ppt-${safeSegment(scenario.id)}-`));
    const rendered = renderPages(built.outline, projectDir, scenario.name, push);
    if (rendered.svgDir === null) return refuse(`PPT 未导出：${rendered.error ?? "渲染失败"}`);
    push({ type: "progress", message: "PPT：正在转成 PPTX…" });
    const outFile = join(projectDir, "out.pptx");
    const converted = await convertToPptx(script, projectDir, outFile);
    if (!converted.ok) {
      return refuse(`PPT 未导出（转档失败：${converted.reason}）`);
    }
    const saved = withNotes(savePptx(dir, scenario.name, kind, readFileSync(outFile)), built.notes);
    push({ type: "progress", message: `PPT：已导出 ${basename(saved.files[0] ?? saved.unchanged[0] ?? "")}` });
    return saved;
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
