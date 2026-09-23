/**
 * @scene/server — UI 联真路由（M5-T5.2，契约 v1.4 联真实现口径）
 *
 * 覆盖：项目（scenario）CRUD、会话（converse）、阶段面板与单元格编辑、
 * 资料库 12 表读写 + F3 内联失效 + 上传入库（SSE）、知识库查询、
 * 交付物导出、系统状态与模型设置。
 * 约定：全部挂 /api/v1；错误统一 { error: "中文说明" }；行形态按 contract 类型原样返回。
 */

import type { FastifyInstance } from "fastify";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  Conversation,
  DshClient,
  FollowEvent,
  GateResult,
  Knowledge,
  OptionalMaterial,
  Product,
  Scenario,
  StageId,
  StageData,
} from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import {
  parseDocument,
  exportDeliverables,
  exportFileName,
  getDefaultModelConfig,
  getDshPort,
  getProviderConfig,
  listProvidersSummary,
  writeDefaultModel,
} from "@scene/infra";
import type { SseHub } from "./sse-hub.js";
import { createConverseCommand } from "./converse.js";
import { createIngestCommand } from "./ingest.js";
import { parseStage, streamEvents } from "./sse-stream.js";
import {
  adviceFromGateRecords,
  assessQuality,
  checkCompleteness,
  getAffectedStages,
} from "@scene/domain";

// ─── 依赖 ──────────────────────────────────────────────────

export interface UiRoutesDeps {
  db: DbInstance;
  dshClient: DshClient;
  hub: SseHub;
}

/** 通用行（HTTP 层做动态列编辑时使用，字段按表 schema 异构） */
type AnyRepo = DbInstance["productRepo"];

// ─── 资料库表代码 → 仓储映射 ───────────────────────────────

const LIBRARY_TABLES: Record<
  string,
  { repo: (db: DbInstance) => AnyRepo; category?: string; lineWhere?: string }
> = {
  M1: { repo: (db) => db.productRepo as unknown as AnyRepo },
  // spec_param 无 product_line_id 列，按产品归属过滤（001_init.sql）
  M2: {
    repo: (db) => db.specParamRepo as unknown as AnyRepo,
    lineWhere: "product_id IN (SELECT id FROM product WHERE product_line_id = ?)",
  },
  M3: { repo: (db) => db.capabilityRepo as unknown as AnyRepo },
  M4: { repo: (db) => db.boundaryRepo as unknown as AnyRepo },
  M5: { repo: (db) => db.limitationRepo as unknown as AnyRepo },
  M6: { repo: (db) => db.costRateRepo as unknown as AnyRepo },
  O1: { repo: (db) => db.optionalMaterialRepo as unknown as AnyRepo, category: "O1认证" },
  O2: { repo: (db) => db.optionalMaterialRepo as unknown as AnyRepo, category: "O2案例" },
  O3: { repo: (db) => db.optionalMaterialRepo as unknown as AnyRepo, category: "O3价格" },
  O4: { repo: (db) => db.optionalMaterialRepo as unknown as AnyRepo, category: "O4SDK" },
  O5: { repo: (db) => db.optionalMaterialRepo as unknown as AnyRepo, category: "O5路线图" },
  O6: { repo: (db) => db.optionalMaterialRepo as unknown as AnyRepo, category: "O6生态" },
};

// ─── 小工具 ────────────────────────────────────────────────

function badRequest(reply: import("fastify").FastifyReply, message: string) {
  return reply.code(400).send({ error: message });
}

function notFound(reply: import("fastify").FastifyReply, message: string) {
  return reply.code(404).send({ error: message });
}

/** command 抛错 → HTTP 映射：错误信息含「不存在」视为 404，其余 400 */
function commandError(reply: import("fastify").FastifyReply, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const code = message.includes("不存在") ? 404 : message.includes("DSH") ? 502 : 400;
  return reply.code(code).send({ error: message });
}

/** 表按产品线过滤的 WHERE 片段（category 型 O 表 / 子查询型 M2 各自适配） */
function lineFilter(
  spec: { category?: string; lineWhere?: string },
  productLineId: string,
): { where: string; params: unknown[] } {
  if (spec.category) {
    return {
      where: "product_line_id = ? AND category = ?",
      params: [productLineId, spec.category],
    };
  }
  return { where: spec.lineWhere ?? "product_line_id = ?", params: [productLineId] };
}

// ─── 注册入口 ──────────────────────────────────────────────

export function registerUiRoutes(app: FastifyInstance, deps: UiRoutesDeps): void {
  const { db, dshClient, hub } = deps;
  const converseCmd = createConverseCommand({ db, dshClient });
  const ingestCmd = createIngestCommand({ db, dshClient, docParser: parseDocument });
  /** jobId → 最新 runId（进程存续期内 SSE 续传用） */
  const ingestRuns = new Map<string, string>();
  let seq = 0;

  registerProjectRoutes(app, deps);
  registerConversationRoutes(app, deps, converseCmd);
  registerLibraryRoutes(app, deps);
  registerSystemRoutes(app, deps);

  // ── 上传入库（multipart → 临时文件 → ingest 命令 → SSE 进度） ──
  app.post("/api/v1/library/ingest", async (request, reply) => {
    let file: Awaited<ReturnType<typeof request.file>>;
    try {
      file = await request.file();
    } catch {
      return badRequest(reply, "需要 multipart 表单（字段 file + product_line_id）");
    }
    if (!file) return badRequest(reply, "缺少上传文件（multipart 字段 file）");
    const fields = file.fields as Record<string, { value?: unknown } | undefined>;
    const productLineId = String(
      (fields["product_line_id"] as { value?: string } | undefined)?.value ?? "",
    );
    if (!productLineId) return badRequest(reply, "缺少 product_line_id 字段");
    if (!db.productLineRepo.getById(productLineId)) {
      return notFound(reply, `产品线 ${productLineId} 不存在`);
    }

    const suffix = file.filename.includes(".")
      ? file.filename.slice(file.filename.lastIndexOf("."))
      : ".bin";
    const jobId = `ingest-${Date.now()}-${++seq}`;
    const filePath = join(tmpdir(), `${jobId}${suffix}`);
    const buffer = await file.toBuffer();
    writeFileSync(filePath, buffer);

    const runId = `${jobId}#${seq}`;
    ingestRuns.set(jobId, runId);
    hub.start(
      runId,
      runIngestJob(ingestCmd, filePath, productLineId, file.filename),
    );
    return { ingest_job_id: jobId };
  });

  app.get("/api/v1/library/ingest/:jobId/events", async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const runId = ingestRuns.get(jobId);
    if (!runId || !hub.has(runId)) {
      return notFound(reply, "该入库任务不存在或已过期");
    }
    const lastEventId =
      (request.headers["last-event-id"] as string | undefined) ?? null;
    await streamEvents(hub, runId, request, reply, lastEventId);
  });

  // ── 交付物双口径导出 ────────────────────────────────────
  app.post("/api/v1/projects/:id/deliverables/export", async (request, reply) => {
    const { id } = request.params as { id: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);

    const stageRows = db.stageDataRepo.list({
      where: "scenario_id = ?",
      params: [id],
    });
    const gates = db.qualityGateRepo.list({
      where: "scenario_id = ?",
      params: [id],
    });
    const knowledge = db.knowledgeRepo.list({
      where: "product_line_id = ?",
      params: [scenario.product_line_id],
    });
    const products = db.productRepo.list({
      where: "product_line_id = ?",
      params: [scenario.product_line_id],
    }) as Product[];

    const result = await exportDeliverables({
      scenario,
      libraryData: {
        products,
        capabilities: db.capabilityRepo.list() as never,
        boundaries: db.boundaryRepo.list() as never,
        limitations: db.limitationRepo.list() as never,
        costRates: db.costRateRepo.list() as never,
      },
      stageData: stageRows,
      qualityGates: gates,
      knowledge: knowledge as never,
    });

    const outDir = process.env.EXPORT_DIR ?? join(process.cwd(), "exports");
    mkdirSync(outDir, { recursive: true });
    const internalPath = join(outDir, exportFileName(scenario.name, "internal"));
    const externalPath = join(outDir, exportFileName(scenario.name, "external"));
    writeFileSync(internalPath, result.internal_report, "utf-8");
    writeFileSync(externalPath, result.external_report, "utf-8");
    return { internal_path: internalPath, external_path: externalPath };
  });
}

// ─── ingest 任务流（进度事件 → done/error） ────────────────

async function* runIngestJob(
  ingestCmd: ReturnType<typeof createIngestCommand>,
  filePath: string,
  productLineId: string,
  filename: string,
): AsyncIterable<FollowEvent> {
  yield { type: "progress", text: `解析 ${filename}` };
  try {
    const result = await ingestCmd.execute({ filePath, productLineId });
    yield {
      type: "done",
      rows_inserted: result.rowsInserted,
      quality: result.qualityAssessment,
      completeness: result.completenessReport,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "error", message: `入库失败：${message}` };
  }
}

// ─── 项目路由 ──────────────────────────────────────────────

function registerProjectRoutes(app: FastifyInstance, deps: UiRoutesDeps) {
  const { db } = deps;

  app.get("/api/v1/projects", async () => {
    const scenarios = db.scenarioRepo.list({ orderBy: "created_at DESC" });
    const staleRows = db.stageDataRepo.list({ where: "is_stale = 1" });
    const staleCount = new Map<string, number>();
    for (const row of staleRows) {
      staleCount.set(row.scenario_id, (staleCount.get(row.scenario_id) ?? 0) + 1);
    }
    return scenarios.map((s) => ({ ...s, stale_count: staleCount.get(s.id) ?? 0 }));
  });

  app.post("/api/v1/projects", async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown; product_line_id?: unknown };
    const name = String(body.name ?? "").trim();
    if (!name) return badRequest(reply, "项目名不能为空");
    if (name.length > 100) return badRequest(reply, "项目名不超过 100 字符");

    let productLineId = String(body.product_line_id ?? "").trim();
    if (!productLineId) {
      productLineId = ensureDefaultProductLine(db);
    } else if (!db.productLineRepo.getById(productLineId)) {
      return notFound(reply, `产品线 ${productLineId} 不存在`);
    }
    return db.scenarioRepo.insert({
      name,
      product_line_id: productLineId,
      status: "进行中",
      current_stage: 0,
    });
  });

  app.patch("/api/v1/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { name?: unknown; status?: unknown };
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name || name.length > 100) return badRequest(reply, "项目名需为 1-100 字符");
      patch["name"] = name;
    }
    if (body.status !== undefined) {
      const status = String(body.status);
      if (!["进行中", "已完成", "已归档"].includes(status)) {
        return badRequest(reply, `项目状态非法: ${status}`);
      }
      patch["status"] = status;
    }
    const updated = db.scenarioRepo.update(id, patch as never);
    if (!updated) return notFound(reply, `场景 ${id} 不存在`);
    return updated;
  });

  app.delete("/api/v1/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!db.scenarioRepo.getById(id)) return notFound(reply, `场景 ${id} 不存在`);
    deleteScenarioCascade(db, id);
    return { deleted: true };
  });

  // 失效横幅：受影响阶段 + 涉及表
  app.get("/api/v1/projects/:id/stale", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!db.scenarioRepo.getById(id)) return notFound(reply, `场景 ${id} 不存在`);
    const staleRows = db.stageDataRepo.list({
      where: "scenario_id = ? AND is_stale = 1",
      params: [id],
    });
    const stages = [...new Set(staleRows.map((r) => r.stage))].sort((a, b) => a - b);
    const tables = [...new Set(staleRows.map((r) => String(r.table_code)))];
    return {
      stages,
      tables,
      banner: stages.length
        ? `${stages.length} 个阶段的分析因资料变更待重算（${stages.join("、")} 阶段）`
        : null,
    };
  });

  // 用户决定：继续 → current_stage 前进一步；其余动作仅确认回执
  app.post("/api/v1/projects/:id/stages/:stage/decide", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { action?: unknown };
    const action = String(body.action ?? "");
    if (!["继续", "补充", "停止", "重算"].includes(action)) {
      return badRequest(reply, `决定动作非法: ${action}`);
    }
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);
    if (action === "继续" && scenario.current_stage < 8) {
      return db.scenarioRepo.update(id, {
        current_stage: (scenario.current_stage + 1) as StageId,
      });
    }
    return scenario;
  });

  // 阶段面板：表格行 + 质量关 + 建议卡（建议由领域层计算）
  app.get("/api/v1/projects/:id/stages/:stage", async (request, reply) => {
    const { id, stage: stageParam } = request.params as { id: string; stage: string };
    const stage = parseStage(stageParam);
    if (stage === undefined) return badRequest(reply, `阶段编号非法: ${stageParam}`);
    if (!db.scenarioRepo.getById(id)) return notFound(reply, `场景 ${id} 不存在`);

    const rows = db.stageDataRepo.listByScenarioStage(id, stage);
    const gates = db.qualityGateRepo.listByScenarioStage(id, stage);
    const advice = gates.length > 0
      ? adviceFromGateRecords(gates.map((g) => g.result as GateResult))
      : null;
    return { rows, gates, advice };
  });

  // 阶段表单元格编辑（落库 + source_type 转「用户确认」）
  app.patch("/api/v1/projects/:id/stage-data/:rowId", async (request, reply) => {
    const { id, rowId } = request.params as { id: string; rowId: string };
    const body = (request.body ?? {}) as { cell?: unknown; value?: unknown };
    const cell = String(body.cell ?? "");
    if (!cell || body.value === undefined) return badRequest(reply, "需要 cell 与 value");
    const row = db.stageDataRepo.getById(rowId);
    if (!row || row.scenario_id !== id) return notFound(reply, `阶段数据 ${rowId} 不存在`);
    const updated = db.stageDataRepo.update(rowId, {
      row: { ...row.row, [cell]: body.value },
      source_type: "用户确认",
    });
    return updated;
  });
}

/** 无 product_line_id 建项目时兜底：取第一条产品线，没有则建「默认产品线」 */
function ensureDefaultProductLine(db: UiRoutesDeps["db"]): string {
  const existing = db.productLineRepo.list({ limit: 1 });
  if (existing.length > 0) return existing[0]!.id;
  return db.productLineRepo.insert({ name: "默认产品线" }).id;
}

/** 删场景：手动级联（无外键级联），知识库条目保留 */
function deleteScenarioCascade(db: DbInstance, scenarioId: string) {
  const conversations = db.conversationRepo.list({
    where: "scenario_id = ?",
    params: [scenarioId],
  });
  for (const conv of conversations) {
    db.messageRepo.deleteByConversation(conv.id);
    db.conversationRepo.deleteById(conv.id);
  }
  for (let stage = 0; stage <= 8; stage += 1) {
    db.stageDataRepo.deleteByScenarioStage(scenarioId, stage as StageId);
    db.qualityGateRepo.deleteByScenarioStage(scenarioId, stage as StageId);
  }
  const refs = db.scenarioMaterialRepo.list({
    where: "scenario_id = ?",
    params: [scenarioId],
  });
  for (const ref of refs) db.scenarioMaterialRepo.deleteById(ref.id);
  db.scenarioRepo.deleteById(scenarioId);
}

// ─── 会话路由 ──────────────────────────────────────────────

function registerConversationRoutes(
  app: FastifyInstance,
  deps: UiRoutesDeps,
  converseCmd: ReturnType<typeof createConverseCommand>,
) {
  const { db, hub } = deps;
  let convSeq = 0;

  app.get("/api/v1/projects/:id/conversations", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!db.scenarioRepo.getById(id)) return notFound(reply, `场景 ${id} 不存在`);
    return converseCmd.list(id);
  });

  app.post("/api/v1/projects/:id/conversations", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!db.scenarioRepo.getById(id)) return notFound(reply, `场景 ${id} 不存在`);
    const body = (request.body ?? {}) as { title?: unknown };
    try {
      return await converseCmd.create({
        scenario_id: id,
        title: String(body.title ?? "新会话"),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // 创建只可能因标题校验或 DSH 不可用失败
      const code = message.includes("校验失败") ? 400 : 502;
      return reply.code(code).send({ error: message });
    }
  });

  app.patch("/api/v1/conversations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { title?: unknown; archive?: unknown };
    try {
      if (body.archive === true) return converseCmd.archive(id);
      if (body.title !== undefined) return converseCmd.rename(id, String(body.title));
      return badRequest(reply, "需要 title 或 archive");
    } catch (err: unknown) {
      return commandError(reply, err);
    }
  });

  app.delete("/api/v1/conversations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { force?: string };
    try {
      converseCmd.remove(id, query.force === "true" || query.force === "1");
      return { deleted: true };
    } catch (err: unknown) {
      return commandError(reply, err);
    }
  });

  app.get("/api/v1/conversations/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = db.conversationRepo.getById(id);
    if (!conversation) return notFound(reply, `会话 ${id} 不存在`);
    const query = request.query as { after_id?: string };
    let messages = db.messageRepo.listByConversation(id);
    if (query.after_id) {
      const index = messages.findIndex((m) => m.id === query.after_id);
      if (index >= 0) messages = messages.slice(index + 1);
    }
    return messages;
  });

  // 发消息 → SSE 流式回复（复用事件中枢；DSH 不可用时流内 error 事件降级）
  app.post("/api/v1/conversations/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { content?: unknown };
    const content = String(body.content ?? "").trim();
    if (!content) return badRequest(reply, "消息内容不能为空");
    const conversation = db.conversationRepo.getById(id);
    if (!conversation) return notFound(reply, `会话 ${id} 不存在`);

    const runId = `conv:${id}#${++convSeq}`;
    hub.start(runId, converseCmd.sendMessage(id, content));
    await streamEvents(hub, runId, request, reply);
  });
}

// ─── 资料库路由 ────────────────────────────────────────────

function registerLibraryRoutes(app: FastifyInstance, deps: UiRoutesDeps) {
  const { db } = deps;

  app.get("/api/v1/library/product-lines", async () => {
    return db.productLineRepo.list({ orderBy: "created_at ASC" }).map((line) => {
      const rowCounts: Record<string, number> = {};
      for (const [code, spec] of Object.entries(LIBRARY_TABLES)) {
        const { where, params } = lineFilter(spec, line.id);
        rowCounts[code] = spec.repo(db).list({ where, params }).length;
      }
      return { ...line, row_counts: rowCounts };
    });
  });

  app.post("/api/v1/library/product-lines", async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown };
    const name = String(body.name ?? "").trim();
    if (!name) return badRequest(reply, "产品线名称不能为空");
    return db.productLineRepo.insert({ name });
  });

  app.get("/api/v1/library/tables/:code", async (request, reply) => {
    const { code } = request.params as { code: string };
    const spec = LIBRARY_TABLES[code];
    if (!spec) return badRequest(reply, `表编号非法: ${code}`);
    const query = request.query as { product_line_id?: string };
    if (!query.product_line_id) {
      return spec.repo(db).list({ orderBy: "created_at ASC" });
    }
    const { where, params } = lineFilter(spec, query.product_line_id);
    return spec.repo(db).list({ where, params, orderBy: "created_at ASC" });
  });

  app.patch("/api/v1/library/rows/:code/:rowId", async (request, reply) => {
    const { code, rowId } = request.params as { code: string; rowId: string };
    const spec = LIBRARY_TABLES[code];
    if (!spec) return badRequest(reply, `表编号非法: ${code}`);
    const body = (request.body ?? {}) as { cell?: unknown; value?: unknown };
    const cell = String(body.cell ?? "");
    if (!cell || body.value === undefined) return badRequest(reply, "需要 cell 与 value");

    const repo = spec.repo(db);
    const row = repo.getById(rowId);
    if (!row) return notFound(reply, `${code} 表行 ${rowId} 不存在`);
    let updated;
    try {
      updated = repo.update(rowId, { [cell]: body.value, source_type: "用户确认" } as never);
    } catch (err: unknown) {
      // 未知列名会直接拼进 SQL：映射为 400 而非 500
      const message = err instanceof Error ? err.message : String(err);
      return badRequest(reply, `列名非法（${cell}）：${message.slice(0, 80)}`);
    }
    if (!updated) return notFound(reply, `${code} 表行 ${rowId} 不存在`);

    // F3 内联失效：反查依赖该表的场景阶段，标记待重算
    markDependentStale(db, code, rowId);
    return updated;
  });

  app.post("/api/v1/library/rows/:code", async (request, reply) => {
    const { code } = request.params as { code: string };
    const spec = LIBRARY_TABLES[code];
    if (!spec) return badRequest(reply, `表编号非法: ${code}`);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const values = (body["values"] ?? {}) as Record<string, unknown>;
    const productLineId = String(body["product_line_id"] ?? values["product_line_id"] ?? "");
    if (!productLineId || !db.productLineRepo.getById(productLineId)) {
      return badRequest(reply, "需要已存在的 product_line_id");
    }
    const extra: Record<string, unknown> = spec.category
      ? { category: spec.category, payload: values }
      : {};
    // O 表的字段值整体入 payload；M 表字段直接是行列（不能把未知键 spread 进 insert）
    const base: Record<string, unknown> = spec.category
      ? { product_line_id: productLineId, source_type: "用户补充", ...extra }
      : { ...values, product_line_id: productLineId, source_type: "用户补充" };
    return spec.repo(db).insert(base as never);
  });

  app.delete("/api/v1/library/rows/:code/:rowId", async (request, reply) => {
    const { code, rowId } = request.params as { code: string; rowId: string };
    const spec = LIBRARY_TABLES[code];
    if (!spec) return badRequest(reply, `表编号非法: ${code}`);
    const ok = spec.repo(db).deleteById(rowId);
    if (!ok) return notFound(reply, `${code} 表行 ${rowId} 不存在`);
    markDependentStale(db, code, rowId);
    return { deleted: true };
  });

  // 六维总评 + 完成度（领域层计算）
  app.get("/api/v1/library/quality-summary", async (request, reply) => {
    const query = request.query as { product_line_id?: string };
    const plId = query.product_line_id ?? "";
    if (!db.productLineRepo.getById(plId)) return notFound(reply, "产品线不存在或缺省");
    const listBy = <T>(code: string): T[] => {
      const spec = LIBRARY_TABLES[code]!;
      const { where, params } = lineFilter(spec, plId);
      return spec.repo(db).list({ where, params }) as T[];
    };
    return {
      quality: assessQuality(
        listBy<Product>("M1"),
        listBy("M2"),
        listBy("M4"),
        listBy("M5"),
      ),
      completeness: checkCompleteness(
        listBy<Product>("M1"),
        listBy("M2"),
        listBy("M3"),
        listBy("M4"),
        listBy("M5"),
        listBy("M6"),
      ),
    };
  });
}

/** 资料行变更 → 按 TABLE_DEPENDENCIES 反查受影响场景阶段并标待重算 */
function markDependentStale(db: DbInstance, code: string, rowId: string) {
  const stages = getAffectedStages(code);
  if (stages.length === 0) return;
  const scenarioIds = new Set<string>();
  for (const ref of db.scenarioMaterialRepo.list({
    where: "ref_table = ? AND ref_id = ?",
    params: [code, rowId],
  })) {
    scenarioIds.add(ref.scenario_id);
  }
  // 场景-产品线归属：本产品线下的项目引用资料库整体
  const first = db.productRepo.getById(rowId) ?? db.optionalMaterialRepo.getById(rowId);
  const productLineId = (first as { product_line_id?: string } | undefined)?.product_line_id;
  if (productLineId) {
    for (const s of db.scenarioRepo.list({
      where: "product_line_id = ?",
      params: [productLineId],
    })) {
      scenarioIds.add(s.id);
    }
  }
  for (const scenarioId of scenarioIds) {
    db.stageDataRepo.markStale(scenarioId, stages, true);
  }
}

// ─── 系统路由 ──────────────────────────────────────────────

function registerSystemRoutes(app: FastifyInstance, deps: UiRoutesDeps) {
  const { db } = deps;

  app.get("/api/v1/system/status", async () => {
    const port = getDshPort();
    let dsh: "ok" | "error" = "error";
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
      clearTimeout(timer);
      dsh = res.status < 500 ? "ok" : "error";
    } catch {
      dsh = "error";
    }
    let database: "ok" | "error" = "ok";
    try {
      db.db.prepare("SELECT 1").get();
    } catch {
      database = "error";
    }
    return { dsh, dsh_port: port, db: database };
  });

  app.get("/api/v1/system/settings", async (_request, reply) => {
    try {
      return {
        providers: listProvidersSummary(),
        default_model: getDefaultModelConfig(),
        dsh_port: getDshPort(),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(503).send({ error: message });
    }
  });

  app.put("/api/v1/system/settings", async (request, reply) => {
    const body = (request.body ?? {}) as { provider?: unknown; model?: unknown };
    const provider = String(body.provider ?? "");
    const model = String(body.model ?? "");
    if (!provider || !model) return badRequest(reply, "需要 provider 与 model");
    try {
      const cfg = getProviderConfig(provider);
      if (!cfg.models.some((m) => m.id === model)) {
        return badRequest(reply, `供应商 ${provider} 不含模型 ${model}`);
      }
      writeDefaultModel({ provider, model });
      return { provider, model };
    } catch (err: unknown) {
      return commandError(reply, err);
    }
  });

  app.get("/api/v1/knowledge", async (request) => {
    const query = request.query as { category?: string; product_line_id?: string };
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.category) {
      where.push("category = ?");
      params.push(query.category);
    }
    if (query.product_line_id) {
      where.push("product_line_id = ?");
      params.push(query.product_line_id);
    }
    return db.knowledgeRepo.list({
      where: where.length ? where.join(" AND ") : undefined,
      params: params.length ? params : undefined,
      orderBy: "created_at DESC",
    }) as Knowledge[];
  });
}

// 引用不直改：占位防 lint 未用告警（OptionalMaterial 用于类型面）
export type { OptionalMaterial, Scenario, StageData, Conversation };
