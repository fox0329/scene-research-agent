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
  filterRowByStage,
  isModelStage,
  stageDef,
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
import type { InfoRow } from "@scene/domain";
import { buildStagePrompt, getStageOutputContract } from "./stage-prompts.js";
import { runScenarioClarify, clarifyAbortEvent } from "./scenario-clarify.js";
import { generateStageSummary } from "./stage-summary-service.js";
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
  //   阶段 7 = 系统组装（交付物按「章节 ← 表映射」生成，不调用模型）
  // 兼容旧数据：历史 current_stage = 8（老 9 阶段口径）视为现行阶段 7。
  // StageId 已收窄为 0-7，但**运行期数据可能仍是老编号**——数据比类型活得久，
  // 所以这里按数值比较（不要为了类型好看把这层兼容删掉）。
  const rawStage = stage as number;
  const effectiveStage = (rawStage === 8 ? 7 : rawStage) as InfoStageId;
  if (!isModelStage(effectiveStage)) {
    yield emit({
      type: "progress",
      stage,
      message: `${stageDef(effectiveStage).name}：本阶段信息由「${stageDef(effectiveStage).producedBy}」产生，不调用模型分析`,
    });
    // 仍生成右栏总结（确定性），保证用户随时有可读的阶段交代
    const summary = generateStageSummary(db, scenario, stage);
    yield emit({ type: "summary", stage, markdown: summary.markdown });
    // 推进阶段是**用户动作**而非模型动作：非模型阶段同样可以推进
    const next: StageId = stage < LAST_STAGE ? advance(stage) : stage;
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

  // 3. 组 prompt
  const stepTables = opts.tables;
  const stagePrompt = buildStagePrompt(
    stage,
    upstreamData,
    { name: scenario.name, description: scenario.description },
    stepTables ? { tables: stepTables } : undefined,
  );
  const outputContract = getStageOutputContract(stage, stepTables);

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

  // 6. DSH 流式调用
  yield emit({
    type: "progress",
    stage,
    message: "正在调用 AI 分析...（本步一次生成整步的表格，通常 1–3 分钟；可离开本页，结果会落库）",
  });

  let fullText = "";
  /** 生成过程的心跳：模型连上后可能几十秒不吐字，没有心跳用户会以为卡死 */
  let lastBeatAt = 0;
  let lastBeatChars = 0;
  try {
    const stream = dshClient.prompt(session, {
      system: stagePrompt.system,
      user: stagePrompt.user,
      outputContract,
    });

    /**
     * 逐事件读取模型流，**空闲时补一条"仍在思考"心跳**
     *
     * 原来的心跳只在"有字吐出来"时发：推理型模型先想几十秒到两分钟不吐字，这段时间
     * 前端一条事件都收不到——用户看到的就是"一直显示在分析中"（实机反馈），
     * 前端侧的连接看门狗也分不清"在思考"还是"连接死了"。按时间补心跳后：
     * ① 界面上一直有动静（已等待 N 秒）；② 静默只可能来自真断线，看门狗判得准。
     */
    const keepaliveMs = keepaliveIntervalMs();
    const reader = createEventReader(stream[Symbol.asyncIterator]());
    let waitingSince = Date.now();
    for (;;) {
      const step = await reader.race(keepaliveMs);
      if (step.kind === "tick") {
        yield emit({
          type: "progress",
          stage,
          message: `模型仍在思考（已等待 ${Math.round((Date.now() - waitingSince) / 1000)} 秒）…`,
        });
        continue;
      }
      if (step.result.done) break;
      const event = step.result.value;
      waitingSince = Date.now();
      if (event.type === "text") {
        fullText += (event as { type: "text"; text: string }).text;
        const now = Date.now();
        if (now - lastBeatAt >= 1500 && fullText.length - lastBeatChars >= 80) {
          lastBeatAt = now;
          lastBeatChars = fullText.length;
          yield emit({
            type: "progress",
            stage,
            message: `模型已输出 ${fullText.length} 字，正在生成…`,
          });
        }
      }
      if (event.type === "error") {
        yield emit({
          type: "error",
          message: (event as { type: "error"; message: string }).message,
        });
        return;
      }
      // 供应商因输出长度上限截断（finish_reason=length）：**不能当成功**——
      // 截断的 JSON 解析必然失败，若继续走"清旧数据 + 写新数据"就会把用户原有的
      // 本步数据清空且一条不写（实机事故：第 3 步重算后 30 行变 0 行）。
      if (event.type === "done" && (event as { finishReason?: string }).finishReason === "length") {
        yield emit({
          type: "error",
          message:
            "模型输出被长度上限截断（本次未写入任何数据，本步原有内容已保留）——请重试；若反复出现，说明本步要一次生成的表太多，需要拆小后重算",
        });
        return;
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    yield emit({ type: "error", message: `AI 分析失败: ${message}` });
    return;
  }

  // 7. 解析 DSH 输出
  const dshOutput = parseDshOutput(fullText);
  dumpRawOutput(stage, fullText);

  /**
   * 解析不出任何行 = 失败，**绝不能清库**
   *
   * 曾经的顺序是「先 deleteByScenarioStage 再 insert」：模型输出被截断或不是合法
   * JSON 时，parseDshOutput 静默返回 `{rows:[]}`，于是旧数据被删、新数据为 0，
   * 用户只看到「完成，共写入 0 条信息」——一步重算把本步数据清空（实机事故）。
   * 现在先判定解析结果，再决定动不动旧数据。
   */
  if (dshOutput.rows.length === 0) {
    yield emit({
      type: "error",
      message:
        "模型这次没有产出可解析的表格数据（未写入任何内容，本步原有数据已保留）——可直接重试",
    });
    return;
  }

  // 8. 写入 stage_data → yield row 事件
  //    重算覆盖（T4.2）：先清除该阶段旧数据行与旧质量关记录再写新结果；
  //    旧数据在被重算前始终保留（§4.1 失效语义），重算即用户决定。
  yield emit({ type: "progress", stage, message: "正在写入分析结果..." });

  // 场景锚（表1-1）是跨阶段常驻的全链唯一场景定义：
  // 重算阶段不能把它一起删掉（且用户确认过的内容必须保留），故先快照后恢复。
  const anchorSnapshot = readAnchorRows(db, scenarioId);
  db.stageDataRepo.deleteByScenarioStage(scenarioId, stage);
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
    const { source_type: declared, confirm_state: _ignored, ...rawFields } = row.fields;
    // 跨阶段表里属于后续阶段的列（如表2-5 的"实现路径/责任人"要到阶段 4）本步一律不入库：
    // 由契约的列级 filledInStages 决定，不靠提示词自觉（实机曾把"责任人"这类我方内容填进第 2 步）
    const fields = filterRowByStage(String(row.table_code), effectiveStage, rawFields);
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

  // 9. 信息完整度检查（**替代旧「质量关 + 建议三档」**）
  //    只输出"还缺什么"，不输出通过/不通过、不给建议；不齐备不阻断。
  yield emit({ type: "progress", stage, message: "正在检查信息完整度..." });

  // 按**本次分析的表集**算完整度：指定了步骤就只算本步的表（阶段 1 横跨第 1、2 两步，
  // 按整阶段算会把这步没产出的表1-1 也算成本步欠账）
  const coveredCodes = stepTables ?? tablesOfStage(effectiveStage).map((t) => t.code);
  const rowsByTable: Record<string, InfoRow[]> = {};
  for (const code of coveredCodes) {
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

/**
 * 把模型原始输出落盘留证（`SCENE_DUMP_RAW_DIR=/tmp/xxx` 时生效）
 *
 * 解析失败时最需要的就是"模型到底吐了什么"——之前没有任何留证，只能靠猜
 * （截断？截断在哪？）。默认关闭，排查时打开。
 */
function dumpRawOutput(stage: number, text: string): void {
  const dir = process.env["SCENE_DUMP_RAW_DIR"];
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `stage-${stage}-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`),
      text,
      "utf8",
    );
  } catch {
    /* 留证失败不影响分析 */
  }
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