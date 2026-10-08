/**
 * @scene/server — 交付物报告生成命令（变更表 #112 / #136 / #137）
 *
 * 用户定调：「要的是总结，不是罗列」——报告正文由**模型撰写**，本命令负责：
 *  取数 → 组提示词 → 流式撰写 → **确定性校验**（不合规带着违规清单重试一次）
 *  → 逐章兜底装配 → 落盘（`data/deliverables/`）。
 *
 * 为什么校验在服务端而不只写在提示词里：不给建议、对外不带内部信息是产品铁律，
 * 靠模型自觉迟早会漏（AGENTS.md §三.5 高风险判定必须落确定性层）。
 *
 * 落盘位置：`data/deliverables/<场景 id>.<口径>.md`（`solution` / `construction`）。
 * 不新增数据库表（报告是产物，不是业务事实；事实仍在 33 张表里），导出到 `exports/`
 * 由 report-service 负责。
 *
 * 变更表 #137（用户定调）：交付物**两份**——「<场景>解决方案」与「<场景>建设工作方案」，
 * 两份都是客户端可读的正式交付物，章节骨架完全不同（`REPORT_CHAPTERS[kind]`）。所以一趟
 * 生成按 `REPORT_KINDS` 各跑一遍：提示词、校验、预算、落盘文件互不串（#136 曾收敛成一份，
 * 本次按 #137 再补第二份）。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DshClient, FollowEvent, Scenario, SessionHandle, StageData } from "@scene/contract";
import {
  REPORT_KINDS,
  REPORT_KIND_LABEL,
  reportChapters,
  tableDef,
  type ReportKind,
} from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import {
  safeWriteFile,
  buildReportMarkdown,
  reportChapterDigest,
  type ChapterDigest,
} from "@scene/infra";
import {
  missingChapterArtifacts,
  proseChars,
  checkReport,
  matchChapterKey,
  repairProseHeads,
  reportMinChars,
  type ReportViolation,
} from "@scene/domain";
import {
  buildChapterPrompt,
  buildCompressPrompt,
  buildReportPrompt,
  chapterProseBudget,
} from "./report-prompts.js";

/**
 * 报告正文落盘目录
 *
 * 调用时读环境变量：测试与 E2E 各用临时目录，绝不写进仓库 `data/`
 * （旧实现把路径写死在模块顶层，测试只能写进真实目录）。
 */
export function deliverableDir(): string {
  return process.env.DELIVERABLE_DIR ?? join(process.cwd(), "data", "deliverables");
}

/**
 * 交付物文件路径（按口径一份：`<id>.solution.md` / `<id>.construction.md`）
 *
 * 历史遗留：`#136` 之前落的是 `<id>.internal.md` / `<id>.external.md`，读取时按
 * `legacyDeliverableReportPath` 兜底（只对 `solution`），已有项目的定稿不会因为改名而消失。
 */
export function deliverableReportPath(scenarioId: string, kind: ReportKind): string {
  return join(deliverableDir(), `${scenarioId}.${kind}.md`);
}

/** 旧版对外口径的落盘路径（只读兼容，不再写入） */
export function legacyDeliverableReportPath(scenarioId: string): string {
  return join(deliverableDir(), `${scenarioId}.external.md`);
}

/** 报告生成依赖 */
export interface DeliverableReportDeps {
  db: DbInstance;
  dshClient: DshClient;
  /** 流式读取的心跳间隔（毫秒），便于测试注入 */
  keepaliveMs?: number;
}

/** 生成结果（返回给调用方与测试）：两个口径各一份 */
export interface DeliverableReportResult {
  /** 各口径的最终 Markdown（两份都生成） */
  markdowns: Record<ReportKind, string>;
  /** 全部口径都通过确定性校验 */
  passed: boolean;
  /** 进度诊断：各口径各章是模型写的还是兜底来的 */
  sources: { kind: ReportKind; key: string; from: "模型" | "兜底" }[];
  /** **最终**版本的校验结果汇总（重写把问题改掉后，这里就是干净的） */
  violations: ReportViolation[];
  /** 是否因硬伤重写过 */
  retried: boolean;
}

/** 单份报告的撰写结果（run 循环里按口径汇总） */
interface WrittenReport {
  markdown: string;
  sources: DeliverableReportResult["sources"];
  violations: ReportViolation[];
  retried: boolean;
}

/** 把模型输出按 `## 章名` 切成 { key: 正文 }（章名匹配只在本口径自己的章里找） */
export function splitReportChapters(
  text: string,
  kind: ReportKind,
  fallbackKeys: readonly string[] = [],
): Map<string, string> {
  const out = new Map<string, string>();
  let current: { key: string; body: string[] } | null = null;
  for (const line of text.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m?.[1]) {
      const key = matchChapterKey(kind, m[1]);
      if (current) out.set(current.key, current.body.join("\n").trim());
      current = key === null ? null : { key, body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) out.set(current.key, current.body.join("\n").trim());
  // 补写调用只要求写一章：模型没按 `## 章名` 起头时，整段就是这一章（否则写好的内容会被丢掉）
  if (out.size === 0 && fallbackKeys.length === 1 && text.trim() !== "") {
    out.set(fallbackKeys[0]!, text.replace(/^#+\s+.+$/m, "").trim());
  }
  return out;
}

/** 一次流式调用：累加正文 + 上报进度 */
async function streamPrompt(args: {
  dshClient: DshClient;
  session: SessionHandle;
  system: string;
  user: string;
  label: string;
  keepaliveMs: number;
  push: (event: FollowEvent) => void;
}): Promise<{ text: string; error?: string }> {
  const { dshClient, session, system, user, label, keepaliveMs, push } = args;
  let text = "";
  let lastBeat = Date.now();
  try {
    const iterator = dshClient
      .prompt(session, { system, user, outputContract: {} })
      [Symbol.asyncIterator]();
    for (;;) {
      // 心跳：模型思考期间没有正文，超过一个心跳就报一次"仍在写"，否则界面看着像卡死
      const step = await Promise.race([
        iterator.next(),
        new Promise<"tick">((resolve) => setTimeout(() => resolve("tick"), keepaliveMs)),
      ]);
      if (step === "tick") {
        push({ type: "progress", message: `${label}：模型仍在撰写（已写 ${text.length} 字）…` });
        continue;
      }
      if (step.done) break;
      const event = step.value;
      if (event.type === "text") {
        text += String((event as { text?: string }).text ?? "");
        if (Date.now() - lastBeat >= 3000) {
          lastBeat = Date.now();
          push({ type: "progress", message: `${label}：已写 ${text.length} 字…` });
        }
      }
      if (event.type === "error") {
        return { text, error: `${label}：${String(event["message"] ?? "模型调用出错")}` };
      }
      if (event.type === "done" && String(event["finishReason"] ?? "") === "length") {
        return { text, error: `${label} 的输出被长度上限截断` };
      }
    }
  } catch (err: unknown) {
    return { text, error: `${label} 调用失败：${err instanceof Error ? err.message : String(err)}` };
  }
  return { text };
}

/**
 * 按口径生成一份报告：整篇写 → 校验 →（有硬伤）重写一次 → 缺章单独补写 → 仍未达标才兜底
 *
 * 为什么缺章"补写"而不是直接兜底：模型整篇写时最容易漏掉第一章（它把场景定义当成了
 * 上下文），而兜底版是数据要点，风格与其它章不齐。单独补一次既保风格统一，代价也小。
 */
async function writeOneReport(args: {
  kind: ReportKind;
  scenario: Scenario;
  stageData: readonly StageData[];
  digest: readonly ChapterDigest[];
  missingTables: readonly string[];
  dshClient: DshClient;
  keepaliveMs: number;
  today: string;
  push: (event: FollowEvent) => void;
}): Promise<WrittenReport> {
  const { kind, scenario, stageData, digest, missingTables, dshClient, keepaliveMs, push } = args;
  const label = REPORT_KIND_LABEL[kind];
  const anchor = stageData
    .filter((r) => r.table_code === "表1-1")
    .map((r) => r.row as Record<string, unknown>);

  push({ type: "progress", message: `正在撰写「${scenario.name}${label}」…` });
  const session = await dshClient.createSession({ title: `${scenario.name} · ${label}` });

  let error: string | undefined;
  let retried = false;
  const written = new Map<string, string>();
  let lastViolations: ReportViolation[] = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = buildReportPrompt(
      kind,
      { scenarioName: scenario.name, anchor, chapters: digest, missingTables },
      attempt === 1 ? undefined : briefOf(lastViolations, written, digest),
    );
    const r = await streamPrompt({ dshClient, session, ...prompt, label, keepaliveMs, push });
    error = r.error;
    // 重写是按章覆盖：这次没写出来的章保留上一版内容（上一版可能写对了）
    for (const [key, body] of splitReportChapters(r.text, kind)) written.set(key, body);
    if (error) break;

    const gate = checkReport(kind, chapterText(written, digest));
    lastViolations = gate.violations;
    push({
      type: "progress",
      message: `${label}：${gate.chars} 字、${gate.chapters.length}/${
        digest.length
      } 节${gate.ok ? "；校验通过" : "；有硬伤待改"}`,
    });
    if (gate.ok) {
      if (retried) push({ type: "progress", message: `${label}：重写后已达标` });
      break;
    }
    if (attempt === 2) break;
    retried = true;
    push({ type: "progress", message: `${label}：有硬伤，正在重写一次…` });
  }

  // 缺章补写：只针对还没写的章，一次调用补齐（比直接给数据要点更像一份报告）
  const missing = digest.filter((d) => !written.get(d.key)?.trim());
  if (error === undefined && missing.length > 0) {
    push({ type: "progress", message: `${label}：${missing.length} 章没写出来，单独补写一次…` });
    const r = await streamPrompt({
      dshClient,
      session,
      ...buildChapterPrompt(kind, missing, scenario.name),
      label: `${label}（补写）`,
      keepaliveMs,
      push,
    });
    for (const [key, body] of splitReportChapters(
      r.text,
      kind,
      missing.map((d) => d.key),
    )) {
      if (body.trim()) written.set(key, body);
    }
    if (r.error) error = r.error;
  }

  // 篇幅回炉：正文（表格不计）超预算的章，让模型只删不加地压一次——提示词约束不住篇幅，
  // 这一步才是能真正把"流水账"压下去的地方；压不动（更长了 / 出错）就保留原样，不截断正文。
  if (error === undefined) {
    for (const d of digest) {
      const body = written.get(d.key)?.trim();
      if (!body) continue;
      const budget = chapterProseBudget(kind, d.key);
      const current = proseChars(body);
      if (current <= budget) continue;
      push({
        type: "progress",
        message: `${label}：${d.title} 正文 ${current} 字，超过 ${budget} 字预算，正在压短…`,
      });
      const r = await streamPrompt({
        dshClient,
        session,
        ...buildCompressPrompt({ title: d.title, markdown: body, budget, current }),
        label: `${label}（压缩·${d.title}）`,
        keepaliveMs,
        push,
      });
      if (r.error) {
        error = r.error;
        break;
      }
      const shorter = splitReportChapters(r.text, kind, [d.key]).get(d.key)?.trim();
      // 先修再判（变更表 #138）：压缩把句子砍成半句时，段首会留下残标点。删掉那截残句头
      // 之后**再**比长度、再查构件——修好的稿子该采纳就采纳，不因为模型的坏习惯整章退回。
      const repaired = shorter === undefined ? undefined : repairProseHeads(shorter);
      const fixed = repaired?.markdown;
      const headNote =
        repaired && repaired.repaired > 0 ? `（修掉 ${repaired.repaired} 处断头句）` : "";
      // 守卫：压缩是"只删不加"，但不许把方案构件删掉（实测有一次把「### 设计原则」整节压没了，
      // 交付物因此缺构件、判硬伤）。构件变少就作废这次压缩，保留原正文——宁可偏长，不能缺构件。
      const lostArtifact =
        fixed !== undefined &&
        missingChapterArtifacts(kind, d.key, fixed).length >
          missingChapterArtifacts(kind, d.key, body).length;
      // 结构塌陷（原来有多个小节、压完成一个都没有）也作废
      const collapsed =
        fixed !== undefined && headingsOf(body).length >= 1 && headingsOf(fixed).length === 0;
      const fragmented = fixed !== undefined && hasFragment(fixed);
      if (lostArtifact || collapsed || fragmented) {
        push({
          type: "progress",
          message: fragmented
            ? `${label}：${d.title} 压缩后出现残句，保留原正文${headNote}`
            : `${label}：${d.title} 压缩会把方案构件/结构压没，保留原正文${headNote}`,
        });
      }
      if (fixed && !lostArtifact && !collapsed && !fragmented && proseChars(fixed) < current) {
        written.set(d.key, fixed);
        push({
          type: "progress",
          message: `${label}：${d.title} 压到正文 ${proseChars(fixed)} 字${headNote}`,
        });
      }
    }
  }

  const filled = digest.filter((d) => written.get(d.key)?.trim()).length;
  const gate = checkReport(kind, chapterText(written, digest));
  if (filled < digest.length || gate.violations.some((v) => v.hard)) {
    push({
      type: "progress",
      message:
        error !== undefined
          ? `${label}：${error}（未达标章节改用要点版兜底）`
          : digest.length - filled > 0
            ? `${label}：仍有 ${digest.length - filled} 章没写出来，这些章节改用要点版兜底`
            : `${label}：章节都写了，但仍有校验硬伤未消除（正文已保留，提示见右栏）`,
    });
  }
  return assemble(kind, written, digest, scenario, stageData, args.today, gate.violations, retried);
}

/** 有没有"残句"：短段落却不像一句完整的话（压缩只删不加，但可能把一句话砍成半句） */
function hasFragment(markdown: string): boolean {
  return markdown.split("\n").some((line) => {
    const t = line.trim().replace(/\*\*$/, "");
    if (t === "" || t.startsWith("|") || t.startsWith("#") || t.startsWith("-") || t.startsWith(">")) {
      return false;
    }
    return t.length < 12 && !/[。！？：；、）】」…]$/.test(t);
  });
}

/**
 * 小节标题（`###` 及更深）——只数小节，不数章标题：
 * 压缩后连一个小节标题都不剩，说明整章被压成一团，这次压缩作废。
 */
function headingsOf(markdown: string): string[] {
  return (markdown.match(/^#{3,4} .*$/gm) ?? []).map((h) => h.trim());
}

/** 已写成章节拼成整篇（给确定性校验用：校验的是最终正文，不是模型的原文） */
function chapterText(written: Map<string, string>, digest: readonly ChapterDigest[]): string {
  return digest
    .map((d) => (written.get(d.key)?.trim() ? `## ${d.title}\n\n${written.get(d.key)}` : ""))
    .filter((x) => x !== "")
    .join("\n\n");
}

/** 重写提示词里的问题清单：确定性校验的具体问题 + 哪几章还没写出来 */
function briefOf(
  violations: readonly ReportViolation[],
  written: Map<string, string>,
  digest: readonly ChapterDigest[],
): string {
  const missing = digest.filter((d) => !written.get(d.key)?.trim()).map((d) => d.title);
  // 只带硬伤：像「缺小节」这种提示性项塞进重写提示，等于让模型把刚压缩掉的铺陈又写回来
  return [
    "上一版的问题（重写时逐条改掉，各章仍要齐全）：",
    ...violations.filter((v) => v.hard).map((v) => `- 【${v.kind}】${v.detail}`),
    ...(missing.length > 0 ? [`- 【缺章】这几章完全没写出来：${missing.join("、")}`] : []),
  ].join("\n");
}

/** 模型正文优先、逐章兜底，装配成最终 Markdown */
function assemble(
  kind: ReportKind,
  written: Map<string, string>,
  digest: readonly ChapterDigest[],
  scenario: Scenario,
  stageData: readonly StageData[],
  today: string,
  violations: ReportViolation[],
  retried: boolean,
): WrittenReport {
  const sources: DeliverableReportResult["sources"] = digest.map((d) => ({
    kind,
    key: d.key,
    from: written.get(d.key)?.trim() ? ("模型" as const) : ("兜底" as const),
  }));
  // 逐章：模型写了就用模型的，没写/空的交给 buildReportMarkdown 用要点版兜底
  const chapterData = digest.map((d) => ({ key: d.key, markdown: written.get(d.key) ?? "" }));
  const markdown = buildReportMarkdown(
    {
      scenario,
      stageSummaries: [],
      stageData: [...stageData],
      chapters: chapterData,
      generatedAt: today,
    },
    kind,
  );
  return { markdown, sources, violations, retried };
}

/** 尚无数据的表（按这一口径报告实际用到的表算） */
function missingTablesOf(stageData: readonly StageData[], kind: ReportKind): string[] {
  const codes = reportChapters(kind).flatMap((c) => c.blocks).map((b) => b.code);
  const unique = [...new Set(codes)];
  const have = new Set(stageData.map((r) => String(r.table_code)));
  return unique.filter((code) => !have.has(code)).map((code) => `${code} ${tableDef(code)?.name ?? ""}`);
}

/** 单份报告的进度小结（收尾文案用） */
interface KindSummary {
  retried: boolean;
  fallback: number;
  violations: number;
}

/**
 * 生成交付物并落盘（两份：解决方案 + 建设工作方案）
 *
 * 用法（SSE 命令）：`execute({ scenarioId })` 是异步生成器，边写边推进度。
 *
 * `kinds` 可只跑其中一份——用户手改过的那份不该被顺手重写（默认仍是两份都跑）。
 */
export interface DeliverableReportInput {
  scenarioId: string;
  kinds?: readonly ReportKind[];
}

export function createDeliverableReportCommand(deps: DeliverableReportDeps) {
  const keepaliveMs = deps.keepaliveMs ?? 20_000;

  return {
    async execute(input: DeliverableReportInput): Promise<AsyncGenerator<FollowEvent>> {
      return run(input);
    },
  };

  async function* run(input: DeliverableReportInput): AsyncGenerator<FollowEvent> {
    const { db, dshClient } = deps;
    const scenario = db.scenarioRepo.getById(input.scenarioId);
    if (!scenario) {
      yield { type: "error", message: `场景 ${input.scenarioId} 不存在` };
      return;
    }
    const stageData = db.stageDataRepo.list({
      where: "scenario_id = ?",
      params: [scenario.id],
    });
    if (stageData.length === 0) {
      yield { type: "error", message: "还没有任何表格数据——先把前面的分析步跑完再生成报告" };
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const result: DeliverableReportResult = {
      markdowns: { solution: "", construction: "" },
      passed: true,
      sources: [],
      violations: [],
      retried: false,
    };
    /** 一份写失败不该拖住另一份：失败信息攒起来，两份都跑完再报 */
    const failures: string[] = [];
    const summaries = new Map<ReportKind, KindSummary>();
    /** 本次要跑哪几份（默认两份；给了 kinds 就只跑那几份） */
    const kindsToWrite = REPORT_KINDS.filter((k) => !input.kinds || input.kinds.includes(k));

    // 撰写是长跑（几分钟），进度必须边跑边出：事件进队列，主循环统一发出
    // （与 advance-stage 同一套泵，续传的 id 才能单调）
    const queue: FollowEvent[] = [];
    let wake: (() => void) | null = null;
    const push = (event: FollowEvent): void => {
      queue.push(event);
      notifyWake();
    };
    /** 唤醒等待中的主循环（拿局部别名再置空：直接 wake?.() 会被 TS 窄化成 null 不可调用） */
    function notifyWake(): void {
      const w = wake;
      wake = null;
      w?.();
    }
    let settled = false;
    let failure: unknown = null;

    const task = (async (): Promise<void> => {
      try {
        // 不再把每张表的全量行塞给模型（#116 用户要精要）：每块最多 MAX_BULLETS 行，
        // 模型据此归纳；完整清单仍在系统内的表里逐行可查。
        mkdirSync(deliverableDir(), { recursive: true });
        for (const kind of kindsToWrite) {
          try {
            const digest = reportChapterDigest(kind, stageData);
            const written = await writeOneReport({
              kind,
              scenario,
              stageData,
              digest,
              missingTables: missingTablesOf(stageData, kind),
              dshClient,
              keepaliveMs,
              today,
              push,
            });
            result.markdowns[kind] = written.markdown;
            result.sources.push(...written.sources);
            result.violations.push(...written.violations);
            if (written.violations.some((v) => v.hard)) result.passed = false;
            summaries.set(kind, {
              retried: written.retried,
              fallback: written.sources.filter((s) => s.from === "兜底").length,
              violations: written.violations.length,
            });
            if (written.retried) result.retried = true;
            // 用户会直接在交付物上改字：覆盖前留档，手改永远可恢复（变更表 #127）
            // 先读后写（变更表 #131）：内容相同不落盘；被手改过则保留用户版本、新版本另存
            const saved = safeWriteFile(deliverableReportPath(scenario.id, kind), written.markdown);
            if (saved.notice) console.warn(`[generate] ${saved.notice}`);
          } catch (err: unknown) {
            failures.push(
              `${REPORT_KIND_LABEL[kind]}：${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } catch (err: unknown) {
        failure = err;
      } finally {
        settled = true;
        notifyWake();
      }
    })();

    while (!settled || queue.length > 0) {
      while (queue.length > 0) yield queue.shift()!;
      if (settled) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    await task;

    if (failure) {
      yield {
        type: "error",
        message: `生成报告失败：${failure instanceof Error ? failure.message : String(failure)}`,
      };
      return;
    }
    if (failures.length > 0) {
      yield { type: "error", message: `生成报告失败：${failures.join("；")}` };
      return;
    }

    // 收尾：本次跑的每一份各报一次（口径名 + 字数 + 兜底与校验提示）
    for (const kind of kindsToWrite) {
      const s = summaries.get(kind) ?? { retried: false, fallback: 0, violations: 0 };
      yield {
        type: "progress",
        message:
          `已生成「${scenario.name}${REPORT_KIND_LABEL[kind]}」：正文 ${proseChars(
            result.markdowns[kind],
          )} 字` +
          `（表格不计，下限 ${reportMinChars(kind)} 字）` +
          (s.fallback > 0 ? `；${s.fallback} 章用了要点版兜底` : "") +
          (s.retried ? "；有硬伤已重写" : "") +
          (s.violations > 0 ? `；${s.violations} 项校验提示` : ""),
      };
    }
    yield {
      type: "done",
      report: {
        solution_chars: result.markdowns.solution.length,
        construction_chars: result.markdowns.construction.length,
      },
      sources: result.sources,
      violations: result.violations,
    };
  }
}
