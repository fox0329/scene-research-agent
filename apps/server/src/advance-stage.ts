/**
 * @scene/server — advance-stage command（阶段推进 + SSE 流式）
 *
 * 应用层编排：infra(dshClient / db) + domain(workflow / gate / barrier-scan / evidence)
 * 流程：取 scenario → 取上游数据 → 组 prompt → DSH 流式 → 产出 row/gate/advice/done 事件
 *
 * F2 三条工程约束：
 * 1. 上下文控制：prompt 只注入当前阶段 schema + 上游表数据
 * 2. 会话登记：DSH session 同步登记为 conversation
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
  CostRate,
  OptionalMaterial,
} from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isModelStage,
  stageDef,
  tableDef,
  tablesOfStage,
  type InfoStageId,
} from "@scene/contract";
import {
  advance,
  LAST_STAGE,
  checkStageCompleteness,
  gapsBrief,
  validateIncomingRows,
} from "@scene/domain";
import type { InfoRow, PostcheckReport } from "@scene/domain";
import { buildStagePrompt, getStageOutputContract } from "./stage-prompts.js";
import { runScenarioClarify, clarifyAbortEvent } from "./scenario-clarify.js";
import { generateStageSummary } from "./stage-summary-service.js";
import { makeSourceLookup, runPostcheck } from "./postcheck-pass.js";
import { readAnchorRows, writeAnchorRows } from "./scenario-anchor.js";

// ─── 依赖注入接口 ──────────────────────────────────────────

/** advance-stage command 依赖 */
export interface AdvanceStageDeps {
  db: DbInstance;
  dshClient: DshClient;
}

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

/** 进度文案用的表标签（表号 + 表名） */
function labelOf(code: string): string {
  const t = tableDef(code);
  return t ? `${code} ${t.name}` : code;
}

/** 单张表的生成结果 */
interface TableGenResult {
  code: string;
  rows: DshStageOutput["rows"];
  /** 已输出字数（进度诊断用） */
  chars: number;
  /** 本表失败原因；有值即视为该表没有产出 */
  error?: string;
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

  const first = await streamOnce();
  dumpRawOutput(d.stage, first.text, code, { failed: !parseOnce(first.text) });
  if (first.error) {
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
  const retried = second.error ? null : parseOnce(second.text);
  if (retried) return { code, rows: retried, chars: second.text.length };

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

  // 非模型阶段守卫（v1.4 起为 8 阶段口径）：
  //   阶段 0 = 解析入库（材料流水线确定性填 M 表，不调用模型）
  //   阶段 6 = 系统组装（交付物按「章节 ← 表映射」生成，不调用模型）
  // 兼容旧数据：历史 current_stage = 8（老 9 阶段口径）或 7（老口径：交付物）都视为现行阶段 6；
  // 老 6（总结沉淀）已删除，历史值按 6（交付物）处理——那一步本来就不填表。
  // StageId 已收窄为 0-7，但**运行期数据可能仍是老编号**——数据比类型活得久，
  // 所以这里按数值比较（不要为了类型好看把这层兼容删掉）。
  const rawStage = stage as number;
  const effectiveStage = (rawStage >= 7 ? 6 : rawStage) as InfoStageId;
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

  // 5. 会话登记：将 DSH session 同步为 conversation（F2 约束 2）
  const conversation = db.conversationRepo.insert({
    scenario_id: scenarioId,
    title: `阶段 ${stage} · 分析`,
    status: "活跃",
    dsh_session_id: session.sessionId,
  });

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
          push,
        })
          .then((result) => {
            results.set(code, result);
            if (result.rows.length > 0) {
              producedRows[code] = result.rows.map((r) => ({ ...r.fields, source: r.source }));
            }
            // 不管成没成都要标记完成：失败的依赖不能让下游干等
            finished.add(code);
            // 单张表失败必须当场说出来（只在收尾汇总里提一句，用户看不到是哪张表卡住的）
            if (result.error) {
              push({ type: "progress", stage, message: `⚠️ ${result.error}` });
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
  const failedTables = tableResults.filter((r) => r.rows.length === 0);
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
    const sourceType = declared === "AI推断" || row.source_type === "AI推断" ? "AI推断" : "AI提取";
    const inserted = db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage,
      table_code: row.table_code as TableCode,
      row: fields,
      is_stale: false,
      source_type: sourceType,
      source: row.source,
      source_authority: "T3",
      evidence_level: "B",
    });
    writtenRows.push(inserted);
    yield emit({
      type: "row",
      stage,
      tableCode: row.table_code,
      rowId: inserted.id,
      fields,
    });
  }

  // 恢复场景锚（重算不丢用户确认过的锚行）
  if (anchorSnapshot.length > 0 && isModelStage(effectiveStage) && stage === 1) {
    writeAnchorRows(db, scenarioId, anchorSnapshot);
  }

  // 部分表失败：明确告诉用户是哪张表、原有内容已保留（不要把失败藏起来）
  if (failedTables.length > 0) {
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
  const pcPromise = runPostcheck({
    listRows: () =>
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
      ),
    lookup: makeSourceLookup(db),
    dshClient,
    applyFix: (rowId, patch) => {
      db.stageDataRepo.update(rowId, patch);
    },
    onProgress: (message) => pcQueue.push(message),
    scenarioName: scenario.name,
    stage,
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
  while (!pcSettled || pcQueue.length > 0) {
    while (pcQueue.length > 0) {
      yield emit({ type: "progress", stage, message: pcQueue.shift()! });
    }
    if (pcSettled) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  await pcPromise;
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

  // 11. 记录系统消息到 conversation
  db.messageRepo.insert({
    conversation_id: conversation.id,
    role: "系统",
    content: [
      `阶段 ${stage} 分析完成，共写入 ${writtenRows.length} 条信息。`,
      gapsBrief(completeness),
      violations.length > 0 ? `产出行校验：${violations.length} 处需修正（见右栏）。` : "",
      pcReport
        ? `生成后自检：检 ${pcReport.checked} 行，自动改正 ${pcReport.fixed} 行${
            pcReport.downgraded > 0 ? `，${pcReport.downgraded} 行因出处无法定位按实降级` : ""
          }${pcReport.remaining > 0 ? `，仍有 ${pcReport.remaining} 处存疑（见总结第四段）` : ""}。`
        : "",
      "右栏已生成阶段总结文档。",
    ]
      .filter(Boolean)
      .join(" "),
    stage,
  });
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
    conversationId: conversation.id,
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
  //
  // 通用库是产品资料基础设施（上传一次全场景共用），所以新建场景默认全部引用；
  // 用户在「本场景资料」里取消勾选 = 显式排除（`scenario_linked_line.excluded = 1`）。
  // 表里没有行 = 默认引用（存量场景因此不需要回填）。
  // 存储仍隔离：本场景上传只落自己的库，绝不写回主库。
  const ownLine = scenario.product_line_id;
  const excludedLineIds = new Set(
    db.scenarioLinkedLineRepo
      .list({ where: "scenario_id = ?", params: [scenario.id] })
      .filter((l) => Boolean(l.excluded))
      .map((l) => l.product_line_id),
  );
  const globalLines = db.productLineRepo
    .list({ where: "scenario_id IS NULL" })
    .filter((l) => !excludedLineIds.has(l.id));
  const lineIds = [...new Set([ownLine, ...globalLines.map((l) => l.id)])];

  /** 行来源标注：本场景 / 主库：<名>（合并后仍可区分，用户可核对） */
  const scopeOf = (lineId: string): string => {
    if (lineId === ownLine) return "本场景";
    const g = globalLines.find((l) => l.id === lineId);
    return `主库：${g?.name ?? lineId}`;
  };
  const annotate = <T extends object>(rows: T[]): (T & { data_scope: string })[] =>
    rows.map((r) => ({
      ...r,
      data_scope: scopeOf(
        String((r as { product_line_id?: string }).product_line_id ?? ownLine),
      ),
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
   * 公司材料（M1–M6 + 可选材料）**只从阶段 3（能力匹配）起注入**
   *
   * 用户定调（2026-10-02）：场景定义 / 认识场景 / 商业梳理这三步是**从不同角度理解场景本身**，
   * 不需要公司产品能力；到能力匹配才把公司能力放进去评估。原先每个阶段都注入 M1–M6，
   * 模型是"看着我们自己的产品在写场景"，于是自然写出「我方切入点」「我方优势」「我方角色」——
   * 表里的公司侧列（表1-2 可参与程度、表3-2 我方切入点…）就是这么长出来的。
   * 现在阶段 0–2 只给场景侧上下文（场景锚 + 前几步的场景产出），公司材料在阶段 3 才进场。
   */
  if (stage >= 3) {
    const products = db.productRepo.list({
      where: `product_line_id IN ${inLines}`,
      params: lineIds,
    }) as Product[];

    data["M1_产品型号"] = dedupeBy(annotate(ownFirst(products)), "model");
    data["M2_规格参数"] = annotate(db.specParamRepo.list({
      where: specByLines,
      params: lineIds,
    }) as SpecParam[]);
    data["M3_能力清单"] = annotate(db.capabilityRepo.list({
      where: `product_line_id IN ${inLines}`,
      params: lineIds,
    }) as Capability[]);
    data["M4_边界声明"] = annotate(db.boundaryRepo.list({
      where: `product_line_id IN ${inLines}`,
      params: lineIds,
    }) as Boundary[]);
    data["M5_已知限制"] = annotate(db.limitationRepo.list({
      where: `product_line_id IN ${inLines}`,
      params: lineIds,
    }) as Limitation[]);
    data["M6_成本单价"] = annotate(db.costRateRepo.list({
      where: `product_line_id IN ${inLines}`,
      params: lineIds,
    }) as CostRate[]);
    data["O_可选材料"] = annotate(db.optionalMaterialRepo.list({
      where: `product_line_id IN ${inLines}`,
      params: lineIds,
    }) as OptionalMaterial[]);
  }

  // 阶段 2+ 需要阶段 1 的结果
  if (stage >= 2) {
    data["阶段1_门槛筛查"] = db.stageDataRepo.listByScenarioStage(
      scenario.id,
      1 as StageId,
    );
  }

  return data;
}

// ─── 子函数：执行质量关 ────────────────────────────────────

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

  // 3. 找第一个 { 开始
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart)) as unknown;
      if (isDshStageOutput(parsed)) return parsed;
    } catch {
      // 继续
    }
  }

  return { rows: [] };
}

function isDshStageOutput(val: unknown): val is DshStageOutput {
  if (typeof val !== "object" || val === null) return false;
  const obj = val as Record<string, unknown>;
  return Array.isArray(obj["rows"]);
}