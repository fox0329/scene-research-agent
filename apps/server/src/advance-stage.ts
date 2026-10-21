/**
 * @scene/server — advance-stage command（阶段推进 + SSE 流式）
 *
 * 应用层编排：infra(dshClient / db) + domain(workflow / gate / barrier-scan / evidence)
 * 流程：取 scenario → 取上游数据 → 组 prompt → DSH 流式 → 产出 row/gate/advice/done 事件
 *
 * F2 三条工程约束：
 * 1. 上下文控制：prompt 只注入当前阶段 schema + 上游表数据
 * 2. 会话：阶段分析不再登记 conversation（变更表 #174，用户定调「没有意义」）；DSH session 照建
 * 3. 流式续传：follow 事件带递增 id，支持 Last-Event-ID
 */

import type {
  DshClient,
  FollowEvent,
  SessionHandle,
  StageId,
  TableCode,
  Scenario,
  StageData,
  Product,
  SpecParam,
  Capability,
  Boundary,
  Limitation,
  OptionalMaterial,
} from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { mkdirSync, writeFileSync } from "node:fs";
import { extractFirstJson, extractRowsBestEffort, repairTruncatedJson } from "./json-extract.js";
import { join } from "node:path";
import {
  flowStepOfTable,
  flowStepsOfStage,
  isModelStage,
  middleColumns,
  stageDef,
  tableDef,
  tablesOfStage,
  upstreamDepsOf,
  type InfoStageId,
} from "@scene/contract";
import {
  advance,
  LAST_STAGE,
  checkStageCompleteness,

  gradeAnalysisEvidence,
  gradeSource,
  parseCitations,
  validateIncomingRows,
} from "@scene/domain";
import type { InfoRow, PostcheckFinding, PostcheckReport, RowViolation } from "@scene/domain";
import { hasCustomerFacts, missingMaterialHint } from "@scene/domain";
import { buildStagePrompt, getStageOutputContract } from "./stage-prompts.js";
import { scenarioLineContext } from "./scenario-lines.js";
import { runScenarioClarify, clarifyAbortEvent } from "./scenario-clarify.js";
import { generateStageSummary } from "./stage-summary-service.js";
import { makeSourceLookup, runPostcheck } from "./postcheck-pass.js";
import { readAnchorRows, writeAnchorRows } from "./scenario-anchor.js";
import {
  researchBriefLines,
  researchHostsOf,
  runStepResearch,
  type StepResearchResult,
} from "./step-research.js";
import type { ResearchSource } from "@scene/infra";
import type { ResearchPromptContext } from "./stage-prompts.js";

// ─── 依赖注入接口 ──────────────────────────────────────────

/**
 * 本步调研执行器（可注入：单测不联网）
 *
 * 生产默认 `runStepResearch`；测试注入假结果验证「提示词注入」与「saved=0 仍继续」。
 */
export type StepResearchRunner = (
  db: DbInstance,
  scenario: Scenario,
  step: number,
  deps?: { keywords?: string[] },
) => Promise<StepResearchResult>;

/** advance-stage command 依赖 */
export interface AdvanceStageDeps {
  db: DbInstance;
  dshClient: DshClient;
  /** 覆盖默认联网调研（测试用；不传=真联网，但没有 researchRepo 时跳过） */
  research?: StepResearchRunner;
}

/** 调研等待上限（用户要求 60 秒；超时按「调研未完成」处理，不阻断分析） */
const RESEARCH_TIMEOUT_MS = 60_000;

// ─── DSH 产出结构 ──────────────────────────────────────────

interface DshStageOutput {
  rows: Array<{
    /** 由输出契约约束枚举；服务端再用注册表本地校验（未知表号不入库） */
    table_code: string;
    fields: Record<string, unknown>;
    source: string;
    /** AI提取 / AI推断（模型不得自称用户确认，由本地校验拦下） */
    source_type?: string;
  }>;
}

// ─── 工厂函数 ──────────────────────────────────────────────

/**
 * 创建 advance-stage command。
 *
 * @param deps - 注入的依赖（db / dshClient）
 * @returns 包含 execute 方法的 command 对象
 */
/** 模型流空闲心跳间隔（默认 15 秒；测试用 STAGE_KEEPALIVE_MS 压到毫秒级） */
/**
 * 解析一条产出行的来源标记（G-R0 / G-R5）
 *
 * 模型声明优先；**没声明时按出处如实判定**——给得出 `文件名:页码` 才算「AI提取」，
 * 给不出就是「AI推断」。
 *
 * 变更表 #162：原来未声明一律记 AI提取，等于替模型声称"材料里真有这句"，
 * 转头又被自检判成「声称有据但无出处」的硬伤——谎报的源头在这里。
 */
export function resolveSourceType(
  declared: unknown,
  source: unknown,
): "AI提取" | "AI推断" {
  if (declared === "AI提取" || declared === "AI推断") return declared;
  return parseCitations(String(source ?? "")).length > 0 ? "AI提取" : "AI推断";
}

/**
 * 产出行校验的机械违规 → 自检问题（变更表 #163）
 *
 * 这些违规（枚举非法 / 缺必填列 / 自称用户确认 / 核实推诿）是确定性层判出来的，
 * 原来只作为进度消息报给用户、行照样入库，修复轮又只吃 `runDeterministicPostcheck`
 * 的问题清单 → 永远修不掉。转成自检问题后：第 2 轮改、第 3 轮复查、仍存疑按实留痕。
 */
export function rowViolationsToFindings(
  violations: readonly RowViolation[],
  rows: readonly { id: string; tableCode: string; row: InfoRow }[],
): PostcheckFinding[] {
  const out: PostcheckFinding[] = [];
  for (const v of violations) {
    const target = rows[v.rowIndex];
    if (!target) continue; // 下标对不上（行没入库）就不编造 rowId
    const def = tableDef(v.tableCode as never);
    const label =
      (def ? middleColumns(def) : [])
        .map((c) => String(target.row[c.key] ?? "").trim())
        .find((value) => value !== "") ?? v.tableCode;
    out.push({
      tableCode: v.tableCode,
      rowId: target.id,
      label,
      kind: v.kind,
      detail: v.detail,
      severity: "硬伤", // 机械违规没有"存疑"的余地：要么改掉，要么按实留痕
    });
  }
  return out;
}

function keepaliveIntervalMs(): number {
  const raw = Number(process.env["STAGE_KEEPALIVE_MS"] ?? 15_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

type TickRace<T> = { kind: "tick" } | { kind: "next"; result: IteratorResult<T> };

/**
 * 逐事件读取 + 空闲心跳（两者赛跑）
 *
 * 直接在 `for await` 里发不了定时心跳（回调里不能 yield），所以把「读下一个事件」
 * 和「计时」放在一起竞争。**关键：心跳赢了不能把这次读取丢掉**——每次 tick 都重新
 * `iterator.next()` 的话，上一次挂着的读取结果会被吞掉（模型已经吐出来的字凭空消失，
 * 最后解析不出行，整步分析反而失败）。所以这里只发起一次读取，tick 后继续等同一个
 * 读取结果。
 */
function createEventReader<T>(iterator: AsyncIterator<T>): {
  race: (ms: number) => Promise<TickRace<T>>;
} {
  let pending: Promise<IteratorResult<T>> | null = null;
  let cached: IteratorResult<T> | null = null;
  let failure: unknown = null;
  let hasFailure = false;

  return {
    race(ms: number): Promise<TickRace<T>> {
      if (hasFailure) return Promise.reject(failure);
      if (cached !== null) {
        const result = cached;
        cached = null;
        return Promise.resolve<TickRace<T>>({ kind: "next", result });
      }
      if (pending === null) {
        pending = iterator.next().then(
          (result) => {
            pending = null;
            cached = result; // 先缓存，等下一次 race 真正取走
            return result;
          },
          (err: unknown) => {
            pending = null;
            hasFailure = true;
            failure = err instanceof Error ? err : new Error(String(err));
            throw failure;
          },
        );
      }
      const read = pending;
      return new Promise<TickRace<T>>((resolve, reject) => {
        const timer = setTimeout(() => resolve({ kind: "tick" }), ms);
        read.then(
          (result) => {
            clearTimeout(timer);
            cached = null;
            resolve({ kind: "next", result });
          },
          (err: unknown) => {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
      });
    },
  };
}

/** 按表并发的上限（默认 5；STAGE_TABLE_CONCURRENCY 可覆盖，测试里压到 1 看串行顺序） */
function tableConcurrency(): number {
  const raw = Number(process.env["STAGE_TABLE_CONCURRENCY"] ?? 5);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 5;
}

/**
 * 等待生成后三问自检的**总上限**（默认 10 分钟；POSTCHECK_DEADLINE_MS 可覆盖，测试压到毫秒级）
 *
 * 为什么必须有总上限：行是在自检**之前**就落库的，自检只是生成过程的内部环节。
 * 一旦自检这条链卡住（模型调用悬挂、上游不返回），没有上限就等于把整步、整条 SSE
 * 流、以及用户界面一起钉死在"分析中"——实跑里"方案实现"就这样挂了十几分钟，
 * 用户只能按 F5 才看到早就写好的内容（故障清单 #47）。
 * 到点按已落库内容收口，并在进度里明说"自检未跑完"，绝不静默。
 */
function postcheckDeadlineMs(): number {
  const raw = Number(process.env["POSTCHECK_DEADLINE_MS"] ?? 600_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 600_000;
}

/** 自检等待期间的心跳间隔（让前端看到"还在动"，也避免客户端看门狗把连接判死） */
function postcheckHeartbeatMs(): number {
  const raw = Number(process.env["POSTCHECK_HEARTBEAT_MS"] ?? 20_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
}

/** 进度文案用的表标签（表号 + 表名） */
function labelOf(code: string): string {
  const t = tableDef(code);
  return t ? `${code} ${t.name}` : code;
}

/**
 * 本次分析属于哪个流程步（调研结果按步落库，右栏按步读）
 *
 * 优先按表反查：一次分析只跑一步的表集，表号到步的映射是确定的；
 * 调用方没传表集时（整阶段重算）退回该阶段的第一步。
 */
function researchStepOf(stage: InfoStageId, tables?: readonly string[]): number | undefined {
  for (const code of tables ?? []) {
    const step = flowStepOfTable(code);
    if (step) return step.id;
  }
  const steps = flowStepsOfStage(stage);
  return steps.length > 0 ? steps[0]!.id : undefined;
}

/**
 * 收集本步调研的实体关键词（上游已产出的门槛名 / 对手名 / 能力名）
 *
 * 用户要的是"深度调研"：只搜「场景名 + 表名」会得到一堆泛泛的行业页；
 * 带上本步真实存在的实体（如「等保三级」「CT15」）才能搜到具体标准与资质要求。
 * 拿不到就返回空数组——query 构造会退回表名/通用词，不影响调研本身。
 */
export function collectResearchKeywords(db: DbInstance, scenarioId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown): void => {
    for (const part of String(raw ?? "").split(/[、,，；;/|\n]+/u)) {
      const k = part.replace(/[（(][^）)]*[）)]/gu, "").replace(/\s+/gu, " ").trim();
      const len = Array.from(k).length;
      if (len < 2 || len > 20) continue;
      if (/^(未知|未提供|无|暂无|待确认|其他)$/u.test(k)) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
      if (out.length >= 3) return;
    }
  };
  const read = (tableCode: string, keys: readonly string[]): void => {
    try {
      const rows = db.stageDataRepo
        .list({ where: "scenario_id = ? AND table_code = ?", params: [scenarioId, tableCode] })
        .filter((r) => String(r.table_code) === tableCode)
        .slice(0, 5);
      for (const r of rows) {
        for (const key of keys) push((r.row as Record<string, unknown>)[key]);
        if (out.length >= 3) return;
      }
    } catch {
      /* 老库/测试替身没有该表：没有关键词就用通用 query，不影响调研 */
    }
  };
  read("表1-3", ["barrier_name"]);
  read("表3-2", ["players"]);
  read("表4-1", ["ability"]);
  return out.slice(0, 3);
}

/** 单张表的生成结果 */
interface TableGenResult {
  code: string;
  rows: DshStageOutput["rows"];
  /** 已输出字数（进度诊断用） */
  chars: number;
  /** 本表失败原因；有值即视为该表没有产出 */
  error?: string;
  /**
   * 是否只是"抢救出来的半张表"（连接中断时救回的完整行）
   *
   * 半张表**绝不能覆盖已有的完整数据**：实测把表2-3 从 6 行覆盖成 2 行、
   * 表2-4/2-7 从 13 行覆盖成 5 行，等于用残缺数据换掉好数据（故障 #65）。
   * 是否落库由调用处按"这张表原本有没有数据"决定。
   */
  partial?: boolean;
}

/**
 * 就绪队列：前置都完成了的表立刻起跑（**不等整轮**）
 *
 * 为什么不等整轮：一轮等于把"依赖链最长的那些表"串起来跑——实测第 2 步按轮跑 3 轮约 65 秒，
 * 而阶段 1 只有"要素清单 → 分层架构/要素间关系"一条两级链，等整轮白等一整个批次。
 * 依赖不在本批里（跨阶段上游，已在上游上下文）视为已满足；出现环时剩余表直接放行——
 * 分析不能因为一处声明笔误就卡死。纯函数，可单测。
 */
export function readyTables(args: {
  codes: readonly string[];
  depsOf: (code: string) => readonly string[];
  started: ReadonlySet<string>;
  /** 已**产出**的表（不是"已开始"）：依赖必须真的完成，下游才拿得到它的行 */
  finished: ReadonlySet<string>;
  limit: number;
}): string[] {
  const inBatch = new Set(args.codes);
  const ready: string[] = [];
  for (const code of args.codes) {
    if (ready.length >= args.limit) break;
    if (args.started.has(code)) continue;
    const deps = args.depsOf(code).filter((d) => inBatch.has(d) && d !== code);
    // 关键：等的是"完成"而不是"开始"——只判开始会让下游拿到空的依赖上下文（口径照样对不上）
    if (deps.every((d) => args.finished.has(d))) ready.push(code);
  }
  // 环/死锁兜底：**没有任何在跑的**且一个都起不来，才把剩余表按序放行
  // （只看"ready 为空"会在正常情况下误放行：依赖还在跑时下游本来就是没就绪的）
  if (ready.length === 0 && args.started.size === args.finished.size) {
    for (const code of args.codes) {
      if (ready.length >= args.limit) break;
      if (!args.started.has(code)) ready.push(code);
    }
  }
  return ready;
}

/**
 * 生成单张表（v1.22 按表并发的执行单元）
 *
 * 为什么按表拆：整步一次生成要 1–3 分钟（实测第 2 步 105 秒），而且**一个表里的畸形 JSON
 * 会让整步失败**（实测第 3 步模型把行级 source 重复写了一次，30 KB 输出整份作废）。
 * 拆成一张表一次调用后：延迟 ≈ 最慢那张表，单表失败只影响这张表（其余照常落库）。
 *
 * 进度事件通过 `push` 出口交给主循环统一编号——并发任务里不能 yield。
 */
async function generateOneTable(
  code: string,
  d: {
    dshClient: DshClient;
    session: SessionHandle;
    stage: InfoStageId;
    scenario: { name: string; description?: string | null; brief?: string | null };
    upstreamData: Record<string, unknown>;
    siblings: readonly string[];
    keepaliveMs: number;
    /** 本步联网调研上下文（先调研、再分析；没跑调研时不传） */
    research?: ResearchPromptContext;
    push: (event: FollowEvent) => void;
  },
): Promise<TableGenResult> {
  const label = labelOf(code);
  const progress = (message: string): void => {
    d.push({ type: "progress", stage: d.stage, message });
  };
  const prompt = buildStagePrompt(d.stage, d.upstreamData, d.scenario, {
    tables: [code],
    siblings: d.siblings,
    ...(d.research ? { research: d.research } : {}),
  });
  progress(`正在生成 ${label}…`);

  /**
   * 流一次并返回原始文本（不做解析）
   *
   * 抽出来是为了失败重试：实跑里出现过"某张表这次没成功"（模型只吐 81 字、
   * 或吐了 4.5k 字却解析不出行），而重新跑整步要 5 分钟、还会把其它 8 张表一起重生成。
   * 单表原样重试一次，成本只与真失败的张数成正比。
   */
  async function streamOnce(): Promise<{ text: string; error?: string }> {
  let text = "";
  try {
    const stream = d.dshClient.prompt(d.session, {
      system: prompt.system,
      user: prompt.user,
      outputContract: getStageOutputContract(d.stage, [code]),
    });
    const reader = createEventReader(stream[Symbol.asyncIterator]());
    let waitingSince = Date.now();
    let beatAt = 0;
    let beatChars = 0;
    for (;;) {
      const step = await reader.race(d.keepaliveMs);
      if (step.kind === "tick") {
        progress(`${label}：模型仍在思考（已等待 ${Math.round((Date.now() - waitingSince) / 1000)} 秒）…`);
        continue;
      }
      if (step.result.done) break;
      const event = step.result.value;
      waitingSince = Date.now();
      if (event.type === "text") {
        text += (event as { type: "text"; text: string }).text;
        const now = Date.now();
        if (now - beatAt >= 1500 && text.length - beatChars >= 80) {
          beatAt = now;
          beatChars = text.length;
          progress(`${label}：已输出 ${text.length} 字…`);
        }
      }
      if (event.type === "error") {
        return {
          text,
          error: `${label}：${String((event as FollowEvent)["message"] ?? "模型调用出错")}`,
        };
      }
      if (event.type === "done" && (event as { finishReason?: string }).finishReason === "length") {
        return { text, error: `${label} 的输出被长度上限截断，请重试` };
      }
    }
  } catch (err: unknown) {
    return { text, error: `${label} 调用失败：${err instanceof Error ? err.message : String(err)}` };
  }
    return { text };
  }

  /** 解析一次输出；解析不出本表的行时返回 null（由调用方决定是否重试） */
  // 返回类型跟着 parseDshOutput 走（原始行形状），不要写成 InfoRow——那是落库后的形状
  const parseOnce = (text: string) => {
    const parsed = parseDshOutput(text);
    // 只认本表自己的行：模型多写别的表号时按表归位，避免重复入库
    const rows = parsed.rows.filter((r) => String(r.table_code) === code);
    return rows.length > 0 ? rows : null;
  };

  /**
   * 只有"连接被中断"才抢救正文
   *
   * 撞到输出上限（finish_reason=length）时输出是**不完整的**：把半张表写进去会覆盖
   * 原来的完整数据，所以那条路保持"报错 + 不清库"（既有安全保证）。连接被重置不同——
   * 模型其实已经写完大部分，救回来是净收益（故障清单 #65）。
   */
  const salvageable = (err?: string): boolean =>
    err !== undefined &&
    /terminated|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|无法连接|连接超时|响应超时|fetch failed/i.test(err);

  const first = await streamOnce();
  dumpRawOutput(d.stage, first.text, code, { failed: !parseOnce(first.text) });
  if (first.error) {
    /* 流被中断（terminated／连接重置）时**必须先抢救正文再报错**：
       实测表2-2 已经写出 5 KB、表2-7 写出 2.7 KB，旧实现直接返回 0 行、
       连解析都不试，等于白丢（故障清单 #65）。 */
    const salvagedFromError = salvageable(first.error) ? parseOnce(first.text) : null;
    if (salvagedFromError) {
      d.push({
        type: "progress",
        stage: d.stage,
        message: `⚠️ ${label}：连接中断（${first.error}），已抢救出 ${salvagedFromError.length} 行`,
      });
      dumpRawFailure(code, d.stage, first.text, `连接中断但抢救出 ${salvagedFromError.length} 行：${first.error}`);
      return { code, rows: salvagedFromError, chars: first.text.length, partial: true };
    }
    dumpRawFailure(code, d.stage, first.text, first.error);
    return { code, rows: [], chars: first.text.length, error: first.error };
  }
  const rows = parseOnce(first.text);
  if (rows) return { code, rows, chars: first.text.length };

  /**
   * 解析不出行 → 原样重试一次（只这一张表；实跑里 81 字/无 JSON 的失败重试后能出结果）
   *
   * 失败必须留证：原始输出按表落盘（含"开头 200 字"写进提示），
   * 否则事后只有一句"没有产出可解析的行"，连模型吐了什么都查不到（这是实跑踩过的坑）。
   */
  progress(`${label} 没产出可解析的行，重试一次…`);
  const second = await streamOnce();
  dumpRawOutput(d.stage, second.text, code, { failed: !parseOnce(second.text) });
  /* 第二次也解析成功：只有"这一轮流被中断过"才算半张表；干净重试成功就是完整产出 */
  const parsedSecond = parseOnce(second.text);
  if (parsedSecond) {
    if (second.error) {
      d.push({
        type: "progress",
        stage: d.stage,
        message: `⚠️ ${label}：连接中断（${second.error}），已抢救出 ${parsedSecond.length} 行`,
      });
    }
    return {
      code,
      rows: parsedSecond,
      chars: second.text.length,
      ...(second.error ? { partial: true } : {}),
    };
  }
  /* 第二次也中断 → 退回头一次的正文再抢救 */
  if (second.error && salvageable(second.error)) {
    const salvaged = parseOnce(first.text);
    if (salvaged) {
      d.push({
        type: "progress",
        stage: d.stage,
        message: `⚠️ ${label}：重试仍中断（${second.error}），已抢救出 ${salvaged.length} 行`,
      });
      return { code, rows: salvaged, chars: first.text.length, partial: true };
    }
  }

  const detail = describeUnparseable(second.text || first.text);
  const reason = `${label} 没有产出可解析的行（重试一次仍未成功。模型输出${detail}）`;
  dumpRawFailure(code, d.stage, second.text || first.text, reason);
  return { code, rows: [], chars: (second.text || first.text).length, error: reason };
}

export function createAdvanceStageCommand(deps: AdvanceStageDeps) {
  return {
    execute: (opts: { scenarioId: string; stage: StageId; tables?: readonly string[] }) =>
      executeAdvanceStage(deps, opts),
  };
}

// ─── 主流程（AsyncGenerator 产出 FollowEvent 流） ──────────

async function* executeAdvanceStage(
  deps: AdvanceStageDeps,
  opts: { scenarioId: string; stage: StageId; tables?: readonly string[] },
): AsyncIterable<FollowEvent> {
  const { db, dshClient } = deps;
  const { scenarioId, stage } = opts;
  let eventId = 0;

  const emit = (event: FollowEvent): FollowEvent => {
    eventId++;
    return { ...event, id: String(eventId) };
  };

  // 1. 取 scenario
  const scenario = db.scenarioRepo.getById(scenarioId);
  if (!scenario) {
    yield emit({ type: "error", message: `场景 ${scenarioId} 不存在` });
    return;
  }

  // 进度：阶段分析开始
  yield emit({
    type: "progress",
    stage,
    message: `开始阶段 ${stage} 分析`,
  });

  // 非模型阶段守卫（2026-10-20 起为 6 阶段口径：0-5）：
  //   阶段 0 = 解析入库（材料流水线确定性填 M 表，不调用模型）
  //   阶段 5 = 系统组装（交付物按「章节 ← 表映射」生成，不调用模型）
  // 兼容旧数据：历史 current_stage ≥ 6（含价值验证 5、交付物 6/7/8 的老口径）都视为现行阶段 5；
  // 价值验证阶段已删除（变更表 #243），历史值一律按交付物处理——那一步本来就不填表。
  // StageId 已收窄为 0-5，但**运行期数据可能仍是老编号**——数据比类型活得久，
  // 所以这里按数值比较（不要为了类型好看把这层兼容删掉）。
  const rawStage = stage as number;
  const effectiveStage = (rawStage >= 6 ? 5 : rawStage) as InfoStageId;
  if (!isModelStage(effectiveStage)) {
    yield emit({
      type: "progress",
      stage,
      message: `${stageDef(effectiveStage).name}：本阶段信息由「${stageDef(effectiveStage).producedBy}」产生，不调用模型分析`,
    });
    // 仍生成右栏总结（确定性），保证用户随时有可读的阶段交代
    const summary = generateStageSummary(db, scenario, effectiveStage);
    yield emit({ type: "summary", stage, markdown: summary.markdown });
    // 推进阶段是**用户动作**而非模型动作：非模型阶段同样可以推进
    const next: StageId = effectiveStage < LAST_STAGE ? advance(effectiveStage) : effectiveStage;
    if (next > scenario.current_stage) {
      db.scenarioRepo.update(scenarioId, { current_stage: next });
    }
    yield emit({ type: "done", stage, rowsWritten: 0 });
    return;
  }

  // 场景预检（v1.12）：信息不足/含糊/含推断 → 对话提澄清问题并中止本次分析。
  // 原则：需要向用户澄清的必须通过对话提出来，不能不管场景蒙头分析。
  yield emit({ type: "progress", stage, message: "场景预检：检查场景信息是否足以支撑分析…" });
  const clarify = await runScenarioClarify(db, dshClient, scenario);
  if (clarify.needClarification) {
    yield emit(clarifyAbortEvent(clarify.questions.length, stage));
    return;
  }

  // 调研先行（2026-10-21 用户定调）：**先完成一轮真实联网调研，再构造分析提示词**。
  //
  // 旧实现是 fire-and-forget：模型已经写完，链接才慢慢落库，提示词里根本没有来源，
  // 于是分析只能写「行业通例（模型知识）」——用户质问的正是这个。
  // 现在是 await（60 秒上限）：调研结果进提示词，saved=0 时强制来源写「未知」，
  // 但**绝不阻断分析**（超时/失败/引擎不可用都照常往下走）。
  //
  // 没有 `researchRepo` 的库（测试替身/极老版本）且没有注入执行器时跳过：
  // 没有落点就不做无谓的联网。
  const researchStep = researchStepOf(effectiveStage, opts.tables);
  const researchEnabled =
    deps.research !== undefined || typeof db.researchRepo?.upsert === "function";
  let researchContext: ResearchPromptContext | undefined;
  let researchRows: ResearchSource[] = [];
  if (researchStep !== undefined && researchEnabled) {
    const runResearch = deps.research ?? runStepResearch;
    const keywords = collectResearchKeywords(db, scenario.id);
    const startedAt = Date.now();
    yield emit({
      type: "progress",
      stage,
      message:
        `开始本步联网调研（检索 + 抓正文验真，最多 ${Math.round(RESEARCH_TIMEOUT_MS / 1000)} 秒）` +
        (keywords.length > 0 ? `，关键实体：${keywords.join("、")}` : "") +
        "…",
    });

    type ResearchRace =
      | { kind: "done"; result: StepResearchResult }
      | { kind: "timeout" }
      | { kind: "error"; message: string };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ResearchRace>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), RESEARCH_TIMEOUT_MS);
    });
    const outcome = await Promise.race<ResearchRace>([
      runResearch(db, scenario, researchStep, { keywords }).then(
        (result) => ({ kind: "done" as const, result }),
        (err: unknown) => ({
          kind: "error" as const,
          message: err instanceof Error ? err.message : String(err),
        }),
      ),
      timeout,
    ]);
    if (timer) clearTimeout(timer);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);

    if (outcome.kind === "done") {
      researchRows = outcome.result.sources;
      const lines = researchBriefLines(researchRows);
      const saved = outcome.result.saved;
      const verified = outcome.result.verified;
      const t1 = outcome.result.authorityCounts.T1;
      const t2 = outcome.result.authorityCounts.T2;
      const firstError = outcome.result.errors[0];
      researchContext = {
        lines,
        strict: lines.length === 0,
        ...(lines.length === 0
          ? { note: firstError ?? "联网检索未取得可用来源" }
          : {}),
      };
      const tail = outcome.result.errors.length > 0 ? `；${outcome.result.errors[0]}` : "";
      console.info(
        `[step-research] 场景 ${scenario.id} 第 ${researchStep} 步：saved=${saved}，verified=${verified}，` +
          `T1=${t1}，T2=${t2}，fetched=${outcome.result.fetched}，queries=${outcome.result.queries}，` +
          `engine=${outcome.result.engine}，${elapsed}s${tail}`,
      );
      if (saved > 0) {
        yield emit({
          type: "progress",
          stage,
          message:
            `联网调研完成：取得 ${saved} 条来源，其中 ${verified} 条已抓正文验真` +
            `（T1 ${t1} 条、T2 ${t2} 条），用时 ${elapsed} 秒` +
            (firstError ? `；部分检索未完成：${firstError}` : ""),
        });
      } else {
        /* saved=0：不阻断分析，但必须让用户看见"这一步没有联网来源"（用户要求如实说明） */
        yield emit({
          type: "progress",
          stage,
          message:
            `联网调研未取得来源（${firstError ?? "检索没有返回可用结果"}）；` +
            "本步「来源」列只能写「未知」，分析继续",
        });
      }
    } else {
      const reason =
        outcome.kind === "timeout"
          ? `调研超过 ${Math.round(RESEARCH_TIMEOUT_MS / 1000)} 秒未完成`
          : `联网调研失败（${outcome.message}）`;
      /**
       * 超时/失败不等于"一条都没有"：检索可能已经落了一部分（只是抓正文还没跑完）。
       * 这里回读本步已存的来源，有多少用多少；真的一条都没有才注入严格块。
       * 实测第 3 步超时 60 秒后仍存了 52 条来源，旧实现却整步写成「未知」，白费一次调研。
       */
      let partial: ResearchSource[] = [];
      try {
        partial = db.researchRepo
          .listByStep(scenario.id, researchStep)
          .filter((r) => r.status === "有效");
      } catch {
        partial = [];
      }
      researchRows = partial;
      const lines = researchBriefLines(partial);
      researchContext = {
        lines,
        strict: lines.length === 0,
        note:
          lines.length === 0
            ? `${reason}；未取得任何来源`
            : `${reason}；仅使用已取得的 ${lines.length} 条来源（未跑完的抓取不阻塞分析）`,
      };
      yield emit({
        type: "progress",
        stage,
        message:
          lines.length === 0
            ? `${reason}；未取得任何来源，本步「来源」列只能写「未知」，分析继续（不阻断）`
            : `${reason}，但已取得 ${lines.length} 条来源，先用这些继续分析（不阻断）`,
      });
    }
  }

  // 2. 取上游数据（按阶段依赖）
  const upstreamData = collectUpstreamData(db, scenario, stage);

  // 3. 本步要产出的表集 —— 按表并发生成的调度单元（v1.22）
  const stepTables = opts.tables;
  const coveredCodes = [
    ...(stepTables ?? tablesOfStage(effectiveStage).map((t) => t.code)),
  ];
  const concurrency = tableConcurrency();

  // 4. 创建 DSH session
  const session = await dshClient.createSession({
    title: `阶段 ${stage} · 分析`,
  });

  // 5. 不再登记会话（变更表 #174）
  //
  // 历史做法：把每次分析的 DSH session 同步成一条「阶段 N · 分析」会话，于是场景下面
  // 一路堆出七八条只有一句系统总结的会话——用户定调「没有意义」。分析进度与结果都有
  // 自己的落点（流程轴进度、右栏阶段总结、阶段数据表），不需要借会话承载。
  // DSH session 本身照建：模型调用要靠它。

  // 6. 按表并发生成：波内并发、波间串行（有真实依赖的表等前一层跑完，并把行喂给它）
  //
  //    为什么不是一次生成整步：① 延迟 —— 实测第 2 步 105 秒，按表拆开后 ≈ 最慢那张表；
  //    ② 抗损 —— 一次输出里任何一处 JSON 畸形都会让整步失败（实测第 3 步 30 KB 输出因
  //    行级 source 重复而整份作废），按表拆开后坏一张只丢一张。
  yield emit({
    type: "progress",
    stage,
    message: `正在并行生成 ${coveredCodes.length} 张表（最多 ${concurrency} 张同时跑，依赖表等前置完成即开始）——可离开本页，结果会落库`,
  });

  const keepaliveMs = keepaliveIntervalMs();
  const results = new Map<string, TableGenResult>();
  /** 本步已产出的行，按表号键：喂给依赖它的下游表（口径一致） */
  const producedRows: Record<string, unknown[]> = {};
  /* 现状类表缺客户材料 → 不生成占位，改为提示"需要先补材料"（用户定调 2026-10-14） */
  const needMaterial = new Map<string, string>();

  // 并发任务不能 yield，进度事件先进队列，由主循环统一编号后发出（保持 id 单调，续传才准）
  const queue: FollowEvent[] = [];
  let wake: (() => void) | null = null;
  const push = (event: FollowEvent): void => {
    queue.push(event);
    wake?.();
    wake = null;
  };
  const depsOf = (code: string): readonly string[] => tableDef(code)?.dependsOnTables ?? [];
  const started = new Set<string>();
  const finished = new Set<string>();
  let poolSettled = false;
  let poolError: unknown = null;

  const pool = (async (): Promise<void> => {
    const running = new Map<string, Promise<void>>();
    let settledCount = 0;
    // 退出条件是"全部**结束**"而不是"全部**开始**"：只看开始会在最后几张表还在跑时提前收工
    // （实测：表2-3/表2-4 刚起始就被丢下，整步 done 却少了这两张表的数据）
    while (settledCount < coveredCodes.length) {
      for (const code of readyTables({
        codes: coveredCodes,
        depsOf,
        started,
        finished,
        limit: concurrency,
      })) {
        started.add(code);
        push({ type: "progress", stage, message: `开始生成 ${labelOf(code)}…` });
        const task = generateOneTable(code, {
          dshClient,
          session,
          stage: effectiveStage,
          scenario: { name: scenario.name, description: scenario.description },
          upstreamData: {
            ...upstreamData,
            ...Object.fromEntries(
              depsOf(code)
                .filter((dep) => producedRows[dep])
                .map((dep) => [dep, producedRows[dep]!]),
            ),
          },
          siblings: coveredCodes.filter((c) => c !== code),
          keepaliveMs,
          ...(researchContext ? { research: researchContext } : {}),
          push,
        })
          .then((result) => {
            /* 半张表（连接中断抢救出来的）与已有数据比一比：已有数据就保留旧的、只提示重算，
               绝不拿残缺结果覆盖完整数据；空表则可以落（救回来总比空着强） */
            let effective = result;
            if (result.partial === true && result.rows.length > 0) {
              const hasExisting = db
                .stageDataRepo.listByScenarioStage(scenarioId, effectiveStage)
                .some((r) => r.table_code === code);
              if (hasExisting) {
                const message =
                  `${labelOf(code)}：连接中断，已抢救出 ${result.rows.length} 行，` +
                  `为避免覆盖原有内容未落库（建议重算本表）`;
                effective = { code, rows: [], chars: result.chars, error: message };
                push({ type: "progress", stage, message: `⚠️ ${message}` });
              } else {
                push({
                  type: "progress",
                  stage,
                  message: `⚠️ ${labelOf(code)}：连接中断，已把抢救出的 ${result.rows.length} 行落库（建议重算本表补全）`,
                });
              }
            }
            /* 现状类表（表1-2 / 表2-7）：整表都是"材料里没有"时**不生成占位**，
               直接告诉用户"需要先补客户材料"——比堆一整表"未提供 + 行业通例"有用
               （用户定调 2026-10-14：干脆不生成，直接提示需要先补材料） */
            if (
              effective.rows.length > 0 &&
              !effective.rows.some((r) => hasCustomerFacts(effective.code, r.fields as InfoRow))
            ) {
              const hint = missingMaterialHint(effective.code);
              needMaterial.set(effective.code, hint);
              push({ type: "progress", stage, message: `📋 ${hint}` });
              effective = { code: effective.code, rows: [], chars: effective.chars };
            }

            results.set(code, effective);
            if (effective.rows.length > 0) {
              producedRows[code] = effective.rows.map((r) => ({ ...r.fields, source: r.source }));
            }
            // 不管成没成都要标记完成：失败的依赖不能让下游干等
            finished.add(code);
            // 单张表失败必须当场说出来（只在收尾汇总里提一句，用户看不到是哪张表卡住的）
            if (effective.error) {
              push({ type: "progress", stage, message: `⚠️ ${effective.error}` });
            }
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            results.set(code, {
              code,
              rows: [],
              chars: 0,
              error: `${labelOf(code)} 生成失败：${message}`,
            });
            finished.add(code);
            push({ type: "progress", stage, message: `⚠️ ${labelOf(code)} 生成失败：${message}` });
          })
          .finally(() => {
            running.delete(code);
            settledCount++;
          });
        running.set(code, task);
      }
      if (running.size === 0) break; // 兜底：没有在跑的任务就收工，绝不空转
      await Promise.race(running.values());
    }
  })().then(
    () => {
      poolSettled = true;
      wake?.();
      wake = null;
    },
    (err: unknown) => {
      poolError = err;
      poolSettled = true;
      wake?.();
      wake = null;
    },
  );

  while (!poolSettled || queue.length > 0) {
    while (queue.length > 0) {
      const event = queue.shift()!;
      yield emit(event);
    }
    if (poolSettled) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  await pool;
  if (poolError) {
    yield emit({
      type: "error",
      message: `按表生成时出错：${poolError instanceof Error ? poolError.message : String(poolError)}`,
    });
    return;
  }

  // 单表失败不再拖垮整步：成功的照常落库，失败的保留原有内容并明确告诉用户是哪张表
  const tableResults = coveredCodes
    .map((code) => results.get(code))
    .filter((r): r is TableGenResult => Boolean(r));
  /* 缺客户材料的现状类表**不算失败**：它是有意不生成，走 tablesNeedMaterial 提示 */
  const failedTables = tableResults.filter((r) => r.rows.length === 0 && !needMaterial.has(r.code));
  const dshOutput: DshStageOutput = { rows: tableResults.flatMap((r) => r.rows) };
  const failureNote = failedTables.map((r) => r.error ?? `${r.code} 未产出`).join("；");

  /**
   * 全部表都没产出 = 失败，**绝不能清库**
   *
   * 曾经的顺序是「先 deleteByScenarioStage 再 insert」：模型输出被截断或不是合法
   * JSON 时，parseDshOutput 静默返回 `{rows:[]}`，于是旧数据被删、新数据为 0，
   * 用户只看到「完成，共写入 0 条信息」——一步重算把本步数据清空（实机事故）。
   * 现在先判定产出，再决定动不动旧数据；按表并发后失败粒度到表，只有全军覆没才整步报错。
   */
  if (dshOutput.rows.length === 0) {
    /* 本步只有"缺客户材料的现状类表"时不是失败：照常收尾并提示补材料（用户定调 2026-10-14） */
    if (failedTables.length === 0 && needMaterial.size > 0) {
      yield emit({
        type: "progress",
        stage,
        message: `本步没有可写内容：${[...needMaterial.values()].join("；")}`,
      });
      /* 不推进阶段：本步什么都没写，让用户补完材料再重算本步 */
      yield emit({
        type: "done",
        stage,
        rowsWritten: 0,
        tablesNeedMaterial: [...needMaterial.keys()],
      });
      return;
    }
    yield emit({
      type: "error",
      message: `模型这次没有产出可解析的表格数据（未写入任何内容，本步原有数据已保留）——可直接重试${
        failureNote ? `。原因：${failureNote}` : ""
      }`,
    });
    return;
  }

  // 8. 写入 stage_data → yield row 事件
  yield emit({ type: "progress", stage, message: "正在写入分析结果..." });

  // 场景锚（表1-1）是跨阶段常驻的全链唯一场景定义：
  // 重算阶段不能把它一起删掉（且用户确认过的内容必须保留），故先快照后恢复。
  const anchorSnapshot = readAnchorRows(db, scenarioId);
  // 只删「本次确实产出」的表（重算覆盖，T4.2）：失败的表保留原有内容，用户不会白丢信息
  const succeededCodes = new Set(tableResults.filter((r) => r.rows.length > 0).map((r) => r.code));
  for (const code of coveredCodes) {
    if (succeededCodes.has(code)) {
      db.stageDataRepo.deleteByScenarioStageTable(scenarioId, stage, code);
    }
  }
  db.qualityGateRepo.deleteByScenarioStage(scenarioId, stage);

  // 未知表号的产出行不入库（无 schema 就无法渲染，入库只会污染数据）
  const allowedCodes = new Set(
    stepTables ?? tablesOfStage(effectiveStage).map((t) => t.code),
  );
  const violations = validateIncomingRows(
    effectiveStage,
    dshOutput.rows as Parameters<typeof validateIncomingRows>[1],
    stepTables,
  );
  const acceptedRows = dshOutput.rows.filter((r) => allowedCodes.has(String(r.table_code)));

  const writtenRows: StageData[] = [];
  for (const row of acceptedRows) {
    // 通用列从行里剥掉：`source_type`/`confirm_state` 由服务端掌握，
    // **模型自封的「用户确认」不得进入数据**（否则污染证据等级）
    // v1.25：原来这里还会按列级 filledInStages 剥掉"后续阶段才填"的列（表2-5 实现路径/责任人等）。
    // 那套跨阶段补填已删——后面的步只跑自己的表，不会回头更新上游表，列永远填不上，留着只会让人以为"以后会填"。
    const { source_type: declared, confirm_state: _ignored, ...fields } = row.fields;
    // 来源标记（变更表 #162）：模型声明优先，未声明按出处如实判定，不替模型声称"材料提取"
    const sourceType = resolveSourceType(declared ?? row.source_type, row.source);
    // 来源权威性 / 证据分级只出自领域层（AGENTS §3.5：分级是判定，LLM 不进入判定路径）。
    // 分析行按 A/B/C 三分（变更表 #167，用户定调 v1.35）——「D 不得入库」只管材料入库。
    // 两处同步写：库里是列，行 JSON 里也有这两个字段（阶段小结读它），
    // 只改一处就会出现"列说 C、JSON 说 B"（#166 的同一类问题）。
    const authority = gradeSource(sourceType);
    const evidenceLevel = gradeAnalysisEvidence(
      sourceType,
      parseCitations(row.source ?? "").length > 0,
    );
    const normalized: InfoRow = { ...fields, authority, evidence_level: evidenceLevel };
    const inserted = db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage,
      table_code: row.table_code as TableCode,
      row: normalized,
      is_stale: false,
      source_type: sourceType,
      source: row.source,
      // 变更表 #162：来源权威性按 G-R1 的确定性映射派生（用户补充 T1 / 用户确认 T2 /
      // AI提取 T3 / AI推断 T4）。原来一律写死 T3，把"模型推断"伪装成"材料提取"，
      // 右栏的来源权威性列因此失去分辨力。
      source_authority: authority,
      evidence_level: evidenceLevel,
    });
    writtenRows.push(inserted);
    yield emit({
      type: "row",
      stage,
      tableCode: row.table_code,
      rowId: inserted.id,
      fields: normalized,
    });
  }

  // 恢复场景锚（重算不丢用户确认过的锚行）
  if (anchorSnapshot.length > 0 && isModelStage(effectiveStage) && stage === 1) {
    writeAnchorRows(db, scenarioId, anchorSnapshot);
  }

  // 部分表失败：明确告诉用户是哪张表、原有内容已保留（不要把失败藏起来）
  if (failedTables.length > 0) {
    /* 失败必须留痕：装好的应用里只有日志可查（0.1.3 起 LOG_LEVEL=info），
       否则用户只能看到界面上一句"没生成成功"，查不到是超时、截断还是供应商拒绝。 */
    console.warn(
      `[本步分析] 场景 ${scenario.id} 第 ${effectiveStage} 步有 ${failedTables.length} 张表没产出：${failureNote}`,
    );
    yield emit({
      type: "progress",
      stage,
      message: `有 ${failedTables.length} 张表这次没生成成功：${failedTables
        .map((r) => r.code)
        .join("、")}（这些表沿用了原有内容，可单独重试）`,
    });
  }

  // 8.5 生成后三问自检（规则 G-R8，v1.28）
  //
  // 用户定调：「每个阶段生成后有没有 1、确认来源的真实性 2、确认表述的准确、客观性
  // 3、问三次这真实吗？客观吗？有价值吗？把这个要作为规则在每次生成后检查」，
  // 并且明确「这是生成过程的一个步骤，为什么要用户判断」——所以它在这里、不在界面上：
  // 自动查（确定性层真查材料 + 模型三问）→ 自动改 → 改不掉的按实降级 → 继续往下走。
  yield emit({ type: "progress", stage, message: "正在做生成后自检（真实吗·客观吗·有价值吗）..." });
  const pcQueue: string[] = [];
  let pcSettled = false;
  let pcReport: PostcheckReport | undefined;
  /** 本步表集当前落库的行：自检与产出行校验共用同一份口径 */
  const listStageRows = (): {
    id: string;
    tableCode: string;
    row: InfoRow;
    source?: string | null;
    sourceType?: string | null;
  }[] =>
    coveredCodes.flatMap((code) =>
      db.stageDataRepo
        .list({
          where: "scenario_id = ? AND stage = ? AND table_code = ?",
          params: [scenarioId, stage, code],
        })
        .map((r) => ({
          id: r.id,
          tableCode: code,
          row: r.row as InfoRow,
          source: r.source,
          sourceType: r.source_type,
        })),
    );
  const pcPromise = runPostcheck({
    listRows: listStageRows,
    listViolations: () => {
      const rows = listStageRows();
      return rowViolationsToFindings(
        validateIncomingRows(
          effectiveStage,
          rows.map((r) => ({
            table_code: r.tableCode,
            fields: r.row,
            source: r.source ?? undefined,
            source_type: r.sourceType ?? undefined,
          })),
          stepTables,
        ),
        rows,
      );
    },
    lookup: makeSourceLookup(db),
    /* 表4-4 的对手必须能回查到表3-2 的 players（用户定调：「没调研到写未知可以」） */
    knownOpponents: () =>
      db.stageDataRepo
        .list({
          where: "scenario_id = ? AND table_code = ?",
          params: [scenarioId, "表3-2"],
        })
        .map((r) => String((r.row as Record<string, unknown>)["players"] ?? ""))
        .filter((x) => x.trim() !== ""),
    dshClient,
    applyFix: (rowId, patch) => {
      db.stageDataRepo.update(rowId, patch);
    },
    onProgress: (message) => pcQueue.push(message),
    scenarioName: scenario.name,
    stage,
    /* 来源门禁：模型引用的 URL host 必须在本步调研结果里（空数组=本步没有任何来源） */
    ...(researchStep !== undefined && researchEnabled
      ? { researchHosts: () => researchHostsOf(researchRows) }
      : {}),
  })
    .then((outcome) => {
      pcReport = outcome.report;
      return outcome;
    })
    .catch((err: unknown) => {
      // 自检失败绝不能连累本次生成（宁可少一轮自检，也不能丢用户的产出）
      pcQueue.push(`自检未完成（不影响本次产出）：${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    })
    .finally(() => {
      pcSettled = true;
    });
  const pcStartedAt = Date.now();
  const pcDeadlineMs = postcheckDeadlineMs();
  const pcHeartbeatMs = postcheckHeartbeatMs();
  let pcLastBeat = pcStartedAt;
  let pcAbandoned = false;
  while (!pcSettled || pcQueue.length > 0) {
    while (pcQueue.length > 0) {
      yield emit({ type: "progress", stage, message: pcQueue.shift()! });
    }
    if (pcSettled) break;
    const waited = Date.now() - pcStartedAt;
    if (waited > pcDeadlineMs) {
      // 到点收口：自检是内部环节，绝不许把整步/整条流/用户界面一起钉在"分析中"
      pcAbandoned = true;
      yield emit({
        type: "progress",
        stage,
        message: `生成后自检超过 ${Math.round(pcDeadlineMs / 60_000)} 分钟仍未返回，已跳过自检、按已落库内容继续（不影响本次产出）`,
      });
      break;
    }
    // 心跳：自检长时间没有产出时，前端仍要看到"还在动"，看门狗也不会误判连接已死
    if (Date.now() - pcLastBeat >= pcHeartbeatMs) {
      pcLastBeat = Date.now();
      yield emit({
        type: "progress",
        stage,
        message: `正在做生成后三问自检…（已用 ${Math.round(waited / 1000)} 秒）`,
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  // 放弃等待时不再 await：那条链可能永远不返回，await 会把后面的完整度检查、总结、done 全断送
  if (!pcAbandoned) await pcPromise;
  if (pcReport) {
    yield emit({ type: "postcheck", stage, report: pcReport });
  }

  // 9. 信息完整度检查（**替代旧「质量关 + 建议三档」**）
  //    只输出"还缺什么"，不输出通过/不通过、不给建议；不齐备不阻断。
  yield emit({ type: "progress", stage, message: "正在检查信息完整度..." });

  // 按**本次分析的表集**算完整度：指定了步骤就只算本步的表（阶段 1 横跨第 1、2 两步，
  // 按整阶段算会把这步没产出的表1-1 也算成本步欠账）
  const completenessCodes = coveredCodes;
  const rowsByTable: Record<string, InfoRow[]> = {};
  for (const code of completenessCodes) {
    rowsByTable[code] = db.stageDataRepo
      .list({ where: "scenario_id = ? AND table_code = ?", params: [scenarioId, code] })
      .map((r) => r.row as InfoRow);
  }
  const completeness = checkStageCompleteness({
    stage: effectiveStage,
    rowsByTable,
    ...(stepTables ? { tableCodes: stepTables } : {}),
  });
  yield emit({ type: "completeness", stage, completeness, violations });

  // 10. 右栏阶段总结文档（确定性生成，不额外调用模型）
  const summary = generateStageSummary(db, scenario, stage);
  yield emit({ type: "summary", stage, markdown: summary.markdown });

  // 11. 更新 scenario.current_stage（只前进不回退：重算早期阶段时保持进度，
  //     阶段 8 为终态；是否继续推进由用户决定——核心原则）
  const nextStage: StageId = stage < LAST_STAGE ? advance(stage) : stage;
  if (nextStage > scenario.current_stage) {
    db.scenarioRepo.update(scenarioId, { current_stage: nextStage });
  }

  // 12. done 事件
  yield emit({
    type: "done",
    stage,
    rowsWritten: writtenRows.length,
    ...(failedTables.length > 0 ? { tablesFailed: failedTables.map((r) => r.code) } : {}),
    ...(needMaterial.size > 0 ? { tablesNeedMaterial: [...needMaterial.keys()] } : {}),
  });
}

// ─── 子函数：收集上游数据 ──────────────────────────────────

/**
 * 按阶段依赖收集上游表数据。
 * F2 上下文控制：只注入当前阶段需要的数据。
 */
export function collectUpstreamData(
  db: DbInstance,
  scenario: Scenario,
  stage: StageId,
): Record<string, unknown[]> {
  const data: Record<string, unknown[]> = {};

  // 资料来源（v2.9：本场景专属库 + **默认引用的通用库**，用户可逐个取消）
  // 存储仍隔离：本场景上传只落自己的库，绝不写回主库。
  // 口径与失效反查、成本重算共用一份实现（见 scenario-lines.ts）。
  const { ownLineId: ownLine, lineIds, scopeOf } = scenarioLineContext(db, scenario);
  const annotate = <T extends object>(rows: T[]): (T & { data_scope: string })[] =>
    rows.map((r) => ({
      ...r,
      // v3.0：私有库可能还没有（按需创建）→ 场景级行（无 product_line_id）落到"主库"
      data_scope: scopeOf(String((r as { product_line_id?: string }).product_line_id ?? ownLine ?? "")),
    }));

  /**
   * 按库优先级排序：本场景 → 主库
   *
   * 必要性：SQL `IN (...)` 的返回顺序是**表的物理顺序**，不是 `lineIds` 顺序。
   * 不排序就去重，会让主库的同名型号把本场景的版本挤掉（本场景优先失效）。
   */
  const lineOrder = new Map(lineIds.map((id, i) => [id, i]));
  const ownFirst = <T extends object>(rows: T[]): T[] =>
    [...rows].sort((a, b) => {
      const la = lineOrder.get(String((a as { product_line_id?: string }).product_line_id ?? "")) ?? 99;
      const lb = lineOrder.get(String((b as { product_line_id?: string }).product_line_id ?? "")) ?? 99;
      return la - lb;
    });

  /** 同一型号在多库出现时去重：**本场景优先**（配合上面的排序） */
  const dedupeBy = <T extends object>(rows: T[], key: string): T[] => {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const r of rows) {
      const k = String((r as Record<string, unknown>)[key] ?? "");
      if (k === "") {
        out.push(r);
        continue;
      }
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out;
  };
  const inLines = `(${lineIds.map(() => "?").join(",")})`;
  // spec_param 无 product_line_id 列，经 product 反查多库
  const specByLines = `product_id IN (SELECT id FROM product WHERE product_line_id IN ${inLines})`;

  /**
   * 公司材料（M1–M4 + M6）**只从阶段 3（能力匹配）起注入**
   *
   * 用户定调（2026-10-02）：场景定义 / 认识场景 / 商业梳理这三步是**从不同角度理解场景本身**，
   * 不需要公司产品能力；到能力匹配才把公司能力放进去评估。原先每个阶段都注入 M1–M5，
   * 模型是"看着我们自己的产品在写场景"，于是自然写出「我方切入点」「我方优势」「我方角色」——
   * 表里的公司侧列（表1-2 可参与程度、表3-2 我方切入点…）就是这么长出来的。
   * 现在阶段 0–2 只给场景侧上下文（场景锚 + 前几步的场景产出），公司材料在阶段 3 才进场。
   *
   * 资料库口径（v2.11）：M4 在读取层合并「边界 + 限制」（底层仍是 boundary/limitation 两张表），
   * M6 硬件报价随公司材料一起进场，供成本测算与赢面判断；M5 不再作为独立上下文块。
   */
  if (stage >= 3) {
    const products = db.productRepo.list({
      where: `product_line_id IN ${inLines}`,
      params: lineIds,
    }) as Product[];

    // 产品清单只给四列（型号/名称/状态/来源）；DB 里的上市日期、定位、曾用名不再进提示词
    data["产品清单"] = dedupeBy(annotate(ownFirst(products)), "model").map((p) => ({
      model: p.model,
      name: p.name,
      status: p.status,
      source: p.source,
      data_scope: p.data_scope,
    }));
    data["规格书"] = annotate(db.specParamRepo.list({
      where: specByLines,
      params: lineIds,
    }) as SpecParam[]).map((p) => ({
      product_model: products.find((x) => x.id === p.product_id)?.model ?? "",
      param_class: p.param_class,
      param_name: p.param_name,
      value: p.value,
      measured: p.measured,
      data_scope: p.data_scope,
    }));
    // 能力清单：依赖条件已并入 description，不再单独给 dependency；「不适用场景」列已删
    data["能力清单"] = annotate(db.capabilityRepo.list({
      where: `product_line_id IN ${inLines}`,
      params: lineIds,
    }) as Capability[]).map((c) => ({
      domain: c.domain,
      name: c.name,
      maturity: c.maturity,
      description: c.description,
      source: c.source,
      data_scope: c.data_scope,
    }));

    // 边界与限制 = 边界（不做）+ 已知限制，读取层合并；底层两张表保留、数据不迁移
    const boundaries = annotate(db.boundaryRepo.list({
      where: `product_line_id IN ${inLines}`,
      params: lineIds,
    }) as Boundary[]);
    const limitations = annotate(db.limitationRepo.list({
      where: `product_line_id IN ${inLines}`,
      params: lineIds,
    }) as Limitation[]);
    data["边界与限制"] = [
      ...boundaries.map((b) => ({
        类型: "不做",
        对象: "公司/业务",
        说明: b.description,
        依据: b.reason ?? "",
        影响程度: "—",
        客户要求时怎么办: b.response,
        来源: b.source,
        data_scope: b.data_scope,
      })),
      ...limitations.map((l) => ({
        类型: "限制",
        对象: l.product_name,
        说明: l.description,
        依据: "—",
        影响程度: l.impact,
        客户要求时怎么办: "—",
        来源: l.source,
        data_scope: l.data_scope,
      })),
    ];

    // 报价：只作为成本测算与赢面判断的锚点，模型不得自编价格
    const quoteRows = db.quoteRepo.list({
      where: `product_id IN (SELECT id FROM product WHERE product_line_id IN ${inLines})`,
      params: lineIds,
    });
    const lineOfProduct = new Map(products.map((p) => [p.id, p.product_line_id]));
    data["报价"] = quoteRows.map((q) => ({
      model: q.model,
      config: q.config,
      unit_price: q.unit_price,
      source: q.source,
      data_scope: scopeOf(lineOfProduct.get(q.product_id) ?? ""),
    }));

    /* 可选材料：O3 价格类别已下线，存量行不再进上下文（数据仍在库里） */
    data["可选材料"] = annotate(db.optionalMaterialRepo.list({
      where: `product_line_id IN ${inLines}`,
      params: lineIds,
    }) as OptionalMaterial[]).filter((m) => String(m.category) !== "O3价格");
  }

  // 阶段 2+ 需要阶段 1 的结果
  if (stage >= 2) {
    data["阶段1_门槛筛查"] = db.stageDataRepo.listByScenarioStage(
      scenario.id,
      1 as StageId,
    );
  }

  /* 竞品情报（2026-10-20）：材料库里以「竞品情报」开头的材料，作为阶段 3 起的对手出处
   *
   * 为什么单独一块：模型的上下文只带 M1–M4 + M6 与上游表，不带材料原文；对手要具名就必须
   * 有可回查的出处（用户定调「没调研到写未知可以」）。约定：调研报告命名 **竞品情报-**，
   * 按页注入，引用写 `文件名:页码`。
   */
  if (stage >= 3) {
    try {
      const pages = db.db
        .prepare(
          "SELECT file_name, page, content FROM source_page WHERE file_name LIKE '竞品情报%' ORDER BY file_name, page LIMIT 16",
        )
        .all() as { file_name: string; page: number; content: string }[];
      data["竞品情报"] = pages.map((r) => ({
        出处: `${r.file_name}:${r.page}`,
        内容: String(r.content ?? "").replace(/\s+/g, " ").slice(0, 600),
      }));
    } catch {
      /* 老库没有 source_page：没有竞品情报就不注入，不影响生成 */
    }
  }

  /* 阶段 2 之后的上游结论（变更表 #225）
   *
   * 审计（docs/表格精简审计.md §3.1）发现这里原来只带 M1–M5 与阶段 1，
   * 导致阶段2/3/4/5 共 21 张表写完下游一次都没读过——表4-3 声称覆盖表3-8
   * 每条、表4-5 与表3-4 互指，全都因为没有数据连接而不成立。
   *
   * 按契约里的依赖声明取数，并且：
   *   - 只取声明里点名的列（结论列，不要过程列）；
   *   - 只取中栏列（右栏是溯源留痕，灌进提示词只烧 token）；
   *   - 每表行数封顶，避免长表撑爆上下文。
   */
  for (const dep of upstreamDepsOf(stage)) {
    const def = tableDef(dep.table as never);
    if (!def) continue;
    const rows = db.stageDataRepo.listByScenarioStage(scenario.id, def.stage);
    const mine = rows.filter((r) => String(r.table_code) === dep.table);
    if (mine.length === 0) continue;

    const middle = new Set(middleColumns(def).map((c) => c.key));
    const want = (dep.columns && dep.columns.length > 0 ? dep.columns : [...middle]).filter((k) =>
      middle.has(k),
    );
    data[dep.table] = mine.slice(0, dep.maxRows).map((r) => {
      const row = (r.row ?? {}) as Record<string, unknown>;
      const picked: Record<string, unknown> = {};
      for (const k of want) picked[k] = row[k] ?? "";
      return picked;
    });
  }

  return data;
}

// ─── 子函数：执行质量关 ────────────────────────────────────

/* 既有调用点/测试从本模块取，实现搬到 json-extract（定义整理那条路也要用同一套） */
export { repairTruncatedJson };

// ─── DSH 输出解析 ──────────────────────────────────────────

/** 原始输出落盘的目录：默认落 `data/raw-output/`（相对仓库根），可用 `SCENE_DUMP_RAW_DIR` 覆盖 */
function rawDumpDir(): string {
  return process.env["SCENE_DUMP_RAW_DIR"] ?? join(process.cwd(), "data", "raw-output");
}

function writeRawDump(kind: string, stage: number, text: string, code?: string): void {
  try {
    const dir = rawDumpDir();
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tag = code ? `${stage}-${code.replace(/[^\w\u4e00-\u9fa5-]/g, "")}` : String(stage);
    writeFileSync(join(dir, `${kind}-${tag}-${stamp}.txt`), text, "utf8");
  } catch {
    /* 留证失败不影响分析 */
  }
}

/**
 * 把模型原始输出落盘留证
 *
 * 排查时要看"模型到底吐了什么"，但每次都存会把盘写满：
 *  - 默认只存**解析失败的**（外加 `SCENE_DUMP_RAW_DIR` 打开时存全部）；
 *  - 解析失败时最需要这段文本——实跑里出现过"模型只吐 81 字"与"吐了 4.5k 字却解析不出行"
 *    两种失败，事后没有任何留证，连是什么都查不到。
 */
function dumpRawOutput(
  stage: number,
  text: string,
  code?: string,
  opts: { failed?: boolean } = {},
): void {
  const on = process.env["SCENE_DUMP_RAW_DIR"] !== undefined || opts.failed;
  if (!on) return;
  writeRawDump(opts.failed ? "fail" : "raw", stage, text, code);
}

/** 解析失败单独留证（带失败原因），与上面的原始 dump 区分开，便于一眼找到出问题的表 */
function dumpRawFailure(code: string, stage: number, text: string, reason: string): void {
  writeRawDump("fail", stage, `# ${reason}\n\n${text}`, code);
}

/** 把"解析不出行"的输出开头摘出来，写进给用户看的提示里（不许只说"没产出"） */
function describeUnparseable(text: string): string {
  const head = text.trim().replace(/\s+/g, " ").slice(0, 120);
  if (head === "") return "为空";
  return `开头是「${head}」`;
}

/**
 * 从 DSH 输出文本中提取 JSON。
 * 复用 ingest.ts 的解析策略。
 */
function parseDshOutput(text: string): DshStageOutput {
  const trimmed = text.trim();

  // 1. 直接 parse
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isDshStageOutput(parsed)) return parsed;
  } catch {
    // 继续
  }

  // 2. ```json 代码块
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch?.[1]) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim()) as unknown;
      if (isDshStageOutput(parsed)) return parsed;
    } catch {
      // 继续
    }
  }

  /* 3. 从第一个 { 开始按括号配对取一个**完整**对象
        （模型常常在合法 JSON 后面又跟一份内容，整段 parse 会报 Extra data → 整表误判失败） */
  const first = extractFirstJson(trimmed);
  if (isDshStageOutput(first)) return first;

  // 4. 抢救被截断的输出（连接被重置时最常见：模型其实已经写出大部分行）
  const repaired = repairTruncatedJson(trimmed);
  if (isDshStageOutput(repaired)) return repaired;

  /* 5. 逐行抢救：某一行语法坏掉（少逗号/引号没转义）时，别让整张表作废
        —— 实测表2-3、表2-5 就这样整张丢掉，其余十几行其实都是好的（故障清单 #65） */
  const salvaged = extractRowsBestEffort(trimmed);
  if (salvaged) {
    const rows = salvaged.rows.filter(
      (r): r is DshStageOutput["rows"][number] =>
        typeof r === "object" && r !== null && typeof (r as { table_code?: unknown }).table_code === "string",
    );
    if (rows.length > 0) {
      console.warn(
        `[模型输出] 整段 JSON 不合法，逐行抢救出 ${rows.length} 行（跳过 ${salvaged.skipped} 行残缺/语法错）`,
      );
      return { rows };
    }
  }

  return { rows: [] };
}

function isDshStageOutput(val: unknown): val is DshStageOutput {
  if (typeof val !== "object" || val === null) return false;
  const obj = val as Record<string, unknown>;
  return Array.isArray(obj["rows"]);
}