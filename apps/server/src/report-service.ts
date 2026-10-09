/**
 * @scene/server — 交付物报告服务（变更表 #112 / #137）
 *
 * 一份交付物有两个来源，这里统一成一个出口，界面与导出都只认它：
 *  - **正式版**：模型撰写的方案，落在 `data/deliverables/<场景>.<口径>.md`；
 *  - **要点版**：还没生成正式版时，用 `@scene/infra` 的确定性装配（章节 ← 表映射）
 *    即时推导——保证「交付物」这一步任何时候都有东西可看（用户不用先点生成）。
 *
 * 变更表 #137：交付物**两份**——「<场景>解决方案」（`solution`）与「<场景>建设工作方案」
 * （`construction`），章节骨架与落盘文件各一份，互不串。旧项目落的是 `<场景>.external.md`，
 * 读取 `solution` 时兜底认它，改名不会让已有定稿消失。
 *
 * 为什么不落库：报告是**产物**不是业务事实；事实仍在 33 张表里。落文件也让「重新生成
 * 不覆盖历史导出」与「导出即所见」两件事都成立（导出前先取同一份内容）。
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPORT_KINDS, type ReportKind, type Scenario } from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { safeWriteFile, exportFileName, type ChapterDigest } from "@scene/infra";
import { reportChapterDigest } from "@scene/infra";
import {
  deliverableDir,
  deliverableReportPath,
  legacyDeliverableReportPath,
} from "./deliverable-report.js";

/** 导出目录（调用时读环境变量：测试用临时目录） */
export function exportDir(): string {
  return process.env.EXPORT_DIR ?? join(process.cwd(), "exports");
}

/** 交付物正文（HTTP 出口形状：界面只认这四个字段） */
export interface DeliverableReportView {
  markdown: string;
  /** 正文字数（不含空白） */
  chars: number;
  /** true = 模型撰写的正式版；false = 确定性要点版 */
  generated: boolean;
  generated_at: string | null;
}

export interface ReportView extends DeliverableReportView {
  kind: ReportKind;
  /** 该报告用到的章节原料（界面/调试用，不落盘） */
  digest: readonly ChapterDigest[];
}

/** 正文字数口径：不含空白（与界面上显示的"字数"一致） */
function countChars(markdown: string): number {
  return markdown.replace(/\s/g, "").length;
}

/**
 * 正式版落盘内容
 *
 * 新路径优先（`<id>.<口径>.md`）；只有 `solution` 兼容旧 `<id>.external.md`
 * （变更表 #136 之前的对外定稿），其余口径没有历史文件。
 */
function readGenerated(scenarioId: string, kind: ReportKind): { text: string; path: string } | null {
  const candidates = [deliverableReportPath(scenarioId, kind)];
  if (kind === "solution") candidates.push(legacyDeliverableReportPath(scenarioId));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    if (text.trim() !== "") return { text, path };
  }
  return null;
}

/** 取某一口径的交付物：正式版优先，没有就即时推导要点版 */
export function getReport(db: DbInstance, scenario: Scenario, kind: ReportKind): ReportView {
  const stageData = db.stageDataRepo.list({
    where: "scenario_id = ?",
    params: [scenario.id],
  });
  const digest = reportChapterDigest(kind, stageData);
  const generated = readGenerated(scenario.id, kind);
  if (generated) {
    return {
      kind,
      markdown: generated.text,
      chars: countChars(generated.text),
      generated: true,
      generated_at: statSync(generated.path).mtime.toISOString(),
      digest,
    };
  }
  /**
   * 未生成 → **返回空**（用户定调 2026-10-09：「价值验证完成后 交付物没有开始的时候不需要填充内容」）
   *
   * 这里曾经即时推导一份"要点版"（把各表要点按章节搬过来，实测 1.6 万 / 2.2 万字）当预览，
   * 毛病是**看起来像成稿**：用户以为交付物已经生成，而它没有归纳、也不能当交付件用。
   * 现在没生成就是空的，界面只留「生成报告」入口。
   * 要点版函数本身保留——生成报告时某一章模型没写，仍由它逐章兜底（deliverable-report.ts）。
   */
  return { kind, markdown: "", chars: 0, generated: false, generated_at: null, digest };
}

/** 取两份交付物（GET /deliverables 的形状） */
export function getReports(db: DbInstance, scenario: Scenario): Record<ReportKind, DeliverableReportView> {
  const out = {} as Record<ReportKind, DeliverableReportView>;
  for (const kind of REPORT_KINDS) {
    const view = getReport(db, scenario, kind);
    out[kind] = {
      markdown: view.markdown,
      chars: view.chars,
      generated: view.generated,
      generated_at: view.generated_at,
    };
  }
  return out;
}

/**
 * 用户在中栏改完报告正文后保存（变更表 #135 / #137）。
 * 落盘同样走先读后写：内容没变不碰文件；文件被应用之外改过则保留那份、新内容另存。
 */
export function saveReportFile(
  scenario: Scenario,
  kind: ReportKind,
  markdown: string,
): { path: string; written: boolean; overwritten: boolean; notice?: string } {
  const dir = deliverableDir();
  mkdirSync(dir, { recursive: true });
  const saved = safeWriteFile(deliverableReportPath(scenario.id, kind), markdown);
  if (saved.notice) console.warn(`[save] ${saved.notice}`);
  return saved;
}

/** 导出两份 md 到 `exports/`（写盘内容 = 界面所见）：`<场景>解决方案.md` / `<场景>建设工作方案.md` */
export function writeReportFiles(
  db: DbInstance,
  scenario: Scenario,
): { files: string[]; notice?: string } {
  const outDir = exportDir();
  mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  const notices: string[] = [];
  for (const kind of REPORT_KINDS) {
    const view = getReport(db, scenario, kind);
    // 先读后写（变更表 #131）：内容一模一样就一个字节都不动；被手改过就不覆盖用户文件，另存「(应用版 时间)」
    const saved = safeWriteFile(join(outDir, exportFileName(scenario.name, kind)), view.markdown);
    files.push(saved.path);
    if (saved.notice) {
      notices.push(saved.notice);
      console.warn(`[export] ${saved.notice}`);
    }
  }
  return notices.length > 0 ? { files, notice: notices.join("；") } : { files };
}

/** 某一口径的交付物是否已生成（界面按钮文案用） */
export function hasGeneratedReport(scenarioId: string, kind: ReportKind): boolean {
  return readGenerated(scenarioId, kind) !== null;
}

export { deliverableDir, deliverableReportPath };
