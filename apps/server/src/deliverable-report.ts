/**
 * @scene/server — 交付物报告生成命令（变更表 #112 / #136 / #137 / #139）
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
import type { DshClient, FollowEvent, Scenario, StageData } from "@scene/contract";
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
  proseChars,
  checkReport,
  matchChapterKey,
  reportMinChars,
  reportMaxChars,
  missingChapterArtifacts,
  firstProseParagraph,
  leadParagraphIssue,
  type ReportViolation,
} from "@scene/domain";
import { buildChapterPrompt, buildReportPrompt } from "./report-prompts.js";
import { streamPrompt } from "./dsh-stream.js";
import { reviewReport, type ReviewMode } from "./report-review.js";

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
  /** 交付物终检开关（变更表 #139，默认 `on`）：关掉就一次终检调用都不发 */
  review?: ReviewMode;
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
  /** 终检小结（变更表 #139）：各口径各一行 */
  review: DeliverableReviewSummary[];
}

/** 一份交付物终检的小结（进 `done` 事件，界面/测试据此显示"发现几处、改了几处、留几处"） */
export interface DeliverableReviewSummary {
  kind: ReportKind;
  /** 模型报出的问题条数 */
  issues: number;
  /** 采纳并改掉的条数 */
  fixed: number;
  /** 仍存疑、只记提示的条数 */
  remaining: number;
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

/**
 * 回炉重写稿的采纳判据（变更表 #139 补丁）
 *
 * 真实现象：目标章 613 → 692 字、路径 724 → 779 字都被收下了——重写**更长**等于没达标；
 * 而且重写稿把「### 数据采集」这类小节整节吃掉了（少一节就是掉内容）。所以采纳必须**同时**满足：
 *   ① 比原稿更短 ② 方案构件不比原稿少 ③ `###` 小节数不比原稿少 ④ 章首段仍合格。
 * 返回 `null` = 采纳；返回字符串 = 拒绝原因（调用方保留原稿，绝不截断）。
 */
export function chapterRewriteRejection(args: {
  kind: ReportKind;
  key: string;
  before: string;
  after: string;
}): string | null {
  const { kind, key, before, after } = args;
  const wasChars = proseChars(before);
  const nowChars = proseChars(after);
  if (nowChars >= wasChars) return `重写稿没变短（${wasChars} → ${nowChars} 字）`;

  const missingBefore = missingChapterArtifacts(kind, key, before);
  const missingAfter = missingChapterArtifacts(kind, key, after);
  if (missingAfter.length > missingBefore.length) return "方案构件变少";

  const wasSections = countSections(before);
  const nowSections = countSections(after);
  if (nowSections < wasSections) return `小节变少（${wasSections} → ${nowSections} 个）`;

  const lead = leadParagraphIssue(firstProseParagraph(after));
  if (lead) return `章首段不合格：${lead}`;
  return null;
}

/** `###` / `####` 小节数（用来确认重写没有把整节吃掉） */
function countSections(markdown: string): number {
  return (markdown.match(/^#{3,4}\s/gm) ?? []).length;
}

/** 超总量时最多回炉几章（少了没用，多了既慢又容易越改越差） */
/** 只在 checkReport 与终检里各算一次的确定性判据（同类型只报一条） */
const DETERMINISTIC_VIOLATION_KINDS = new Set(["悬空残句", "重复", "空节", "章首段不合规"]);

const MAX_REWRITE_CHAPTERS = 2;

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

  // 篇幅回炉（变更表 #139 补丁：**总量驱动**）
  //
  // 用户要的是"总字数"（「可以设置一个总的字数，比如 2000–5000 字左右，没必要直接截断」），
  // 所以逐章预算只是**提示词里的写作指引**，不当硬闸——真实场景模型稳定写 500–800 字/章，
  // 拿逐章线逐章触发只会白跑四五章。现在的规矩：
  //   ① 全篇正文总字数（表格不计，与 `reportMaxChars` 同一口径）没超上限 → **一章都不回炉**；
  //   ② 超了 → 只挑**正文最长的 1–2 章**各回炉重写一次（提示重申该章预算）；
  //   ③ 改完重算总量，仍超 → **保留、不截断**，只提示「超总上限 M（已回炉 K 章）」；
  //   ④ 低于下限只提示（`checkReport` 的「篇幅不足」），不回炉。每章最多一次，失败不中断整篇。
  const maxChars = reportMaxChars(kind);
  let total = proseChars(chapterText(written, digest));
  const longest = [...digest]
    .filter((d) => (written.get(d.key)?.trim() ?? "") !== "")
    .sort((a, b) => proseChars(written.get(b.key) ?? "") - proseChars(written.get(a.key) ?? ""))
    .slice(0, MAX_REWRITE_CHAPTERS);
  let requalified = 0;
  const overLimit = error === undefined && total > maxChars;
  if (!overLimit && error === undefined) {
    push({
      type: "progress",
      message: `${label}：正文合计 ${total} 字，在总上限 ${maxChars} 字内，不回炉`,
    });
  }
  if (overLimit) {
    push({
      type: "progress",
      message: `${label}：正文合计 ${total} 字，超总上限 ${maxChars} 字，回炉最长的 ${longest.length} 章…`,
    });
    for (const d of longest) {
      // 前几章已经改回总量就不再动下一章（"1–2 章"里的 1）
      if (total <= maxChars) break;
      const body = written.get(d.key)?.trim();
      if (!body) continue;
      const wasChars = proseChars(body);
      const r = await streamPrompt({
        dshClient,
        session,
        ...buildChapterPrompt(kind, [d], scenario.name),
        label: `${label}（回炉·${d.title}）`,
        keepaliveMs,
        push,
      });
      if (r.error) {
        // 回炉失败只是"这一章没救回来"：保留原正文，绝不让整篇生成中断
        push({
          type: "progress",
          message: `${label}：${d.title} 回炉重写失败（${r.error}），保留原正文`,
        });
        continue;
      }
      const rewritten = splitReportChapters(r.text, kind, [d.key]).get(d.key)?.trim();
      if (!rewritten) {
        push({
          type: "progress",
          message: `${label}：${d.title} 回炉产出解析不出来，保留原正文`,
        });
        continue;
      }
      // 采纳门槛（#139 补丁）：重写更长 / 构件变少 / 小节被吃掉 / 章首段不合格 → 一律保留原稿
      const rejected = chapterRewriteRejection({
        kind,
        key: d.key,
        before: body,
        after: rewritten,
      });
      if (rejected !== null) {
        push({
          type: "progress",
          message: `${label}：${d.title} 回炉稿 ${wasChars} 字 → ${proseChars(rewritten)} 字，没达标，保留原稿（${rejected}）`,
        });
        continue;
      }
      written.set(d.key, rewritten);
      requalified += 1;
      // 每改一章就重算总量：够用就停手，不为了"凑满两章"多跑一次
      total = proseChars(chapterText(written, digest));
      push({
        type: "progress",
        message: `${label}：${d.title} 回炉后 ${proseChars(rewritten)} 字（原 ${wasChars} 字），正文合计 ${total} 字`,
      });
    }
    if (total > maxChars) {
      push({
        type: "progress",
        message: `${label}：正文 ${total} 字，超总上限 ${maxChars}（已回炉 ${requalified} 章），保留正文不截断`,
      });
    } else {
      push({
        type: "progress",
        message: `${label}：回炉后正文 ${total} 字，已在总上限 ${maxChars} 字内`,
      });
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
  // 只带硬伤：像「缺小节」这种提示性项塞进重写提示，等于让模型把刚回炉掉的铺陈又写回来
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
  /** 终检报出的问题条数（变更表 #139） */
  reviewed?: number;
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
  /** 终检默认开（变更表 #139）；`off` 时一次终检调用都不发 */
  const reviewMode: ReviewMode = deps.review ?? "on";

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
      review: [],
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
            // 交付物终检（变更表 #139）：装配好的整篇再过一道"通读找问题 → 只改被点名的段落 → 复查"。
            // 它只降级不阻断：模型失败/解析失败就跳过，落盘的仍是撰写出来的整篇。
            const reviewed = await reviewReport({
              kind,
              markdown: written.markdown,
              scenarioName: scenario.name,
              dshClient,
              keepaliveMs,
              push,
              enabled: reviewMode === "on",
            });
            result.markdowns[kind] = reviewed.markdown;
            result.sources.push(...written.sources);
            // 初稿校验决定要不要重写；对外要说的是「交付出去的那份还有哪些问题」。
            // 确定性判据（断头段/重复/空节/章首段）初稿与终检后各算一次——同类型取后者（终检后最新状态），
            // 其余类型按「类型 + 说明」去重，右栏才不会把同一条提示数两遍
            const mergedViolations = new Map<string, ReportViolation>();
            for (const v of [...written.violations, ...reviewed.violations]) {
              const key = DETERMINISTIC_VIOLATION_KINDS.has(v.kind) ? v.kind : `${v.kind}|${v.detail}`;
              mergedViolations.set(key, v);
            }
            result.violations.push(...mergedViolations.values());
            if (result.violations.some((v) => v.hard)) result.passed = false;
            result.review.push({
              kind,
              issues: reviewed.issues,
              fixed: reviewed.fixed,
              remaining: reviewed.remaining,
            });
            summaries.set(kind, {
              retried: written.retried,
              fallback: written.sources.filter((s) => s.from === "兜底").length,
              violations: written.violations.length,
              reviewed: reviewed.issues,
            });
            if (written.retried) result.retried = true;
            // 用户会直接在交付物上改字：覆盖前留档，手改永远可恢复（变更表 #127）
            // 先读后写（变更表 #131）：内容相同不落盘；被手改过则保留用户版本、新版本另存
            const saved = safeWriteFile(deliverableReportPath(scenario.id, kind), reviewed.markdown);
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
          (s.reviewed ? `；终检发现 ${s.reviewed} 处` : "") +
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
      // 终检小结（变更表 #139）：每份一行「发现几处、改了几处、留几处提示」
      review: result.review,
    };
  }
}
