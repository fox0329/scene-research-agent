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
import {
  advance,
  LAST_STAGE,
  runGate,
  decideAdvice,
  GATE_CHECK_TITLES,
  sampleSources,
} from "@scene/domain";
import type { GateCheckInput, GateCheckResult } from "@scene/domain";
import { buildStagePrompt, getStageOutputContract } from "./stage-prompts.js";

// ─── 依赖注入接口 ──────────────────────────────────────────

/** advance-stage command 依赖 */
export interface AdvanceStageDeps {
  db: DbInstance;
  dshClient: DshClient;
}

// ─── DSH 产出结构 ──────────────────────────────────────────

interface DshStageOutput {
  rows: Array<{
    /** 由输出契约 JSON Schema 在 DSH 侧约束枚举；阶段 0 总结允许自由表号 */
    table_code: TableCode;
    fields: Record<string, unknown>;
    source: string;
  }>;
}

// ─── 工厂函数 ──────────────────────────────────────────────

/**
 * 创建 advance-stage command。
 *
 * @param deps - 注入的依赖（db / dshClient）
 * @returns 包含 execute 方法的 command 对象
 */
export function createAdvanceStageCommand(deps: AdvanceStageDeps) {
  return {
    execute: (opts: { scenarioId: string; stage: StageId }) =>
      executeAdvanceStage(deps, opts),
  };
}

// ─── 主流程（AsyncGenerator 产出 FollowEvent 流） ──────────

async function* executeAdvanceStage(
  deps: AdvanceStageDeps,
  opts: { scenarioId: string; stage: StageId },
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

  // 2. 取上游数据（按阶段依赖）
  const upstreamData = collectUpstreamData(db, scenario, stage);

  // 3. 组 prompt
  const stagePrompt = buildStagePrompt(stage, upstreamData);
  const outputContract = getStageOutputContract(stage);

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
  yield emit({ type: "progress", stage, message: "正在调用 AI 分析..." });

  let fullText = "";
  try {
    const stream = dshClient.prompt(session, {
      system: stagePrompt.system,
      user: stagePrompt.user,
      outputContract,
    });

    for await (const event of stream) {
      if (event.type === "text") {
        fullText += (event as { type: "text"; text: string }).text;
      }
      if (event.type === "error") {
        yield emit({
          type: "error",
          message: (event as { type: "error"; message: string }).message,
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

  // 8. 写入 stage_data → yield row 事件
  //    重算覆盖（T4.2）：先清除该阶段旧数据行与旧质量关记录再写新结果；
  //    旧数据在被重算前始终保留（§4.1 失效语义），重算即用户决定。
  yield emit({ type: "progress", stage, message: "正在写入分析结果..." });

  db.stageDataRepo.deleteByScenarioStage(scenarioId, stage);
  db.qualityGateRepo.deleteByScenarioStage(scenarioId, stage);

  const writtenRows: StageData[] = [];
  for (const row of dshOutput.rows) {
    const inserted = db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage,
      table_code: row.table_code,
      row: row.fields,
      is_stale: false,
      source_type: "AI提取",
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
      fields: row.fields,
    });
  }

  // 9. 质量关检查（阶段 0/7/8 无质量关）
  const gateTitles = GATE_CHECK_TITLES[stage];
  if (gateTitles.length > 0) {
    yield emit({ type: "progress", stage, message: "正在执行质量关检查..." });

    const gateResults = runStageGate(db, scenarioId, stage, writtenRows);

    // 写入 quality_gate 表
    for (const result of gateResults) {
      db.qualityGateRepo.insert({
        scenario_id: scenarioId,
        stage,
        item_no: result.itemNo,
        title: result.title,
        result: result.result,
        detail: result.detail,
        evidence_refs: {},
      });
    }

    // 建议三档
    const advice = decideAdvice(gateResults);

    yield emit({
      type: "gate",
      stage,
      results: gateResults,
      passed: gateResults.filter((r) => r.isPassed).length,
      total: gateResults.length,
    });

    yield emit({ type: "advice", stage, level: advice });

    // 10. 记录系统消息到 conversation
    db.messageRepo.insert({
      conversation_id: conversation.id,
      role: "系统",
      content: `阶段 ${stage} 分析完成。共 ${writtenRows.length} 条数据。质量关 ${gateResults.filter((r) => r.isPassed).length}/${gateResults.length} 通过。建议：${advice}。`,
      stage,
    });
  } else {
    // 无质量关的阶段（0/7/8），直接记录消息
    db.messageRepo.insert({
      conversation_id: conversation.id,
      role: "系统",
      content: `阶段 ${stage} 分析完成。共 ${writtenRows.length} 条数据。`,
      stage,
    });
  }

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
function collectUpstreamData(
  db: DbInstance,
  scenario: Scenario,
  stage: StageId,
): Record<string, unknown[]> {
  const data: Record<string, unknown[]> = {};
  const plId = scenario.product_line_id;

  // 所有阶段都需要基础材料
  if (stage >= 0) {
    const products = db.productRepo.list({
      where: "product_line_id = ?",
      params: [plId],
    }) as Product[];

    data["M1_产品型号"] = products;
    data["M2_规格参数"] = db.specParamRepo.list() as SpecParam[];
    data["M3_能力清单"] = db.capabilityRepo.list({
      where: "product_line_id = ?",
      params: [plId],
    }) as Capability[];
    data["M4_边界声明"] = db.boundaryRepo.list({
      where: "product_line_id = ?",
      params: [plId],
    }) as Boundary[];
    data["M5_已知限制"] = db.limitationRepo.list({
      where: "product_line_id = ?",
      params: [plId],
    }) as Limitation[];
    data["M6_成本单价"] = db.costRateRepo.list({
      where: "product_line_id = ?",
      params: [plId],
    }) as CostRate[];
    data["O_可选材料"] = db.optionalMaterialRepo.list({
      where: "product_line_id = ?",
      params: [plId],
    }) as OptionalMaterial[];
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

/**
 * 对写入的 stage_data 执行质量关检查。
 *
 * 简化实现：对每项检查，基于已写入数据的数量和来源质量给出通过/不通过。
 * 完整实现应由各阶段的确定性规则产出单项判定。
 */
function runStageGate(
  _db: DbInstance,
  _scenarioId: string,
  stage: StageId,
  writtenRows: StageData[],
): GateCheckResult[] {
  const titles = GATE_CHECK_TITLES[stage];
  if (titles.length === 0) return [];

  // 基于写入数据量和来源多样性做基础判定
  const hasData = writtenRows.length > 0;
  const sourceSet = new Set(
    writtenRows.map((r) => r.source).filter((s): s is string => Boolean(s)),
  );
  const sourceSample = sampleSources([...sourceSet], 3);
  const hasEnoughSources = sourceSample.length >= 3;

  const checks: GateCheckInput[] = titles.map((title, i) => {
    // 最后一项通常是"来源抽查至少 3 条通过"
    if (title.includes("来源抽查")) {
      return {
        title,
        result: hasEnoughSources ? "通过" : "不通过",
        isCritical: false,
        detail: hasEnoughSources
          ? `抽查 ${sourceSample.length} 条来源`
          : `来源不足（${sourceSample.length}/3）`,
      };
    }

    // 其他项：有数据则通过，无数据则未检
    return {
      title,
      result: hasData ? "通过" : "未检",
      isCritical: i < 3, // 前 3 项通常为关键项
      detail: hasData
        ? `基于 ${writtenRows.length} 条分析数据`
        : "无分析数据",
    };
  });

  return runGate(stage, checks);
}

// ─── DSH 输出解析 ──────────────────────────────────────────

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