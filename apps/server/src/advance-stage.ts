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
import { isModelStage, stageDef, tablesOfStage, type InfoStageId } from "@scene/contract";
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

  // 9. 信息完整度检查（**替代旧「质量关 + 建议三档」**）
  //    只输出"还缺什么"，不输出通过/不通过、不给建议；不齐备不阻断。
  yield emit({ type: "progress", stage, message: "正在检查信息完整度..." });

  const rowsByTable: Record<string, InfoRow[]> = {};
  for (const t of tablesOfStage(effectiveStage)) {
    rowsByTable[t.code] = db.stageDataRepo
      .list({ where: "scenario_id = ? AND table_code = ?", params: [scenarioId, t.code] })
      .map((r) => r.row as InfoRow);
  }
  const completeness = checkStageCompleteness({ stage: effectiveStage, rowsByTable });
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

  // 资料来源（v1.5：**默认合并主库** + 本场景专属库 + 显式引用的通用库）
  //
  // 为什么默认带主库：产品资料是**基础设施**（上传一次全场景共用）。
  // 旧实现只带"本场景专属库 + 显式引用的库"，导致新建场景默认看不到任何主库产品。
  // 存储仍隔离：本场景上传只落自己的库，绝不写回主库。
  const ownLine = scenario.product_line_id;
  const globalLines = db.productLineRepo.list({ where: "scenario_id IS NULL" });
  const linkedLineIds = db.scenarioLinkedLineRepo
    .list({ where: "scenario_id = ?", params: [scenario.id] })
    .map((l) => l.product_line_id);
  const lineIds = [...new Set([ownLine, ...globalLines.map((l) => l.id), ...linkedLineIds])];

  /** 行来源标注：主库 / 本场景 / 引用库（合并后仍可区分，用户可核对） */
  const scopeOf = (lineId: string): string => {
    if (lineId === ownLine) return "本场景";
    const g = globalLines.find((l) => l.id === lineId);
    if (g) return `主库：${g.name}`;
    const l = db.productLineRepo.getById(lineId);
    return `引用库：${l?.name ?? lineId}`;
  };
  const annotate = <T extends object>(rows: T[]): (T & { data_scope: string })[] =>
    rows.map((r) => ({
      ...r,
      data_scope: scopeOf(
        String((r as { product_line_id?: string }).product_line_id ?? ownLine),
      ),
    }));

  /**
   * 按库优先级排序：本场景 → 主库 → 引用库
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

  // 所有阶段都需要基础材料
  if (stage >= 0) {
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