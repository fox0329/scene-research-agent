/**
 * @scene/server — UI 联真路由（M5-T5.2，契约 v1.4 联真实现口径）
 *
 * 覆盖：项目（scenario）CRUD、会话（converse）、阶段面板与单元格编辑、
 * 资料库 12 表读写 + F3 内联失效 + 上传入库（SSE）、知识库查询、
 * 交付物导出、系统状态与模型设置。
 * 约定：全部挂 /api/v1；错误统一 { error: "中文说明" }；行形态按 contract 类型原样返回。
 */

import type { FastifyInstance } from "fastify";
import { createWriteStream, existsSync, rmSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  Conversation,
  DshClient,
  FollowEvent,
  OptionalMaterial,
  Product,
  Scenario,
  StageId,
  StageData,
} from "@scene/contract";
import {
  ANCHOR_TABLE_CODE,
  FILE_UPLOAD_LIMIT_MB,
  FLOW_LAST_STEP,
  REPORT_KINDS,
  flowStepLabel,
  flowStepOfTable,
  type InfoStageId,
  type ReportKind,
} from "@scene/contract";
import { alignmentWithBrief, anchorFixedRows, buildFlowStatus, type InfoRow } from "@scene/domain";
import type { DbInstance } from "@scene/infra";
import { scenarioLineContext } from "./scenario-lines.js";
import { describeUploadFailure } from "./upload-limits.js";
import {
  NO_SOURCE_FILE_LABEL,
  aggregateMaterials,
  rowBelongsToFile,
  type MaterialRowRef,
} from "./library-materials.js";
import { dedupeLibrary } from "./library-service.js";
import {
  parseDocument,
  registrySummary,
  loadRegistry,
  upsertProvider,
  removeProvider,
  setDefaultModel,
  checkProviderConnection,
  fetchProviderModels,
  deleteSourceIndex,
} from "@scene/infra";
import type { ProviderModelEntry } from "@scene/infra";
import type { SseHub } from "./sse-hub.js";
import { createDeliverableReportCommand } from "./deliverable-report.js";
import { getReports, saveReportFile, writeReportFiles } from "./report-service.js";
import { exportReportDocx } from "./docx-export.js";
import { exportReportPptx } from "./ppt-export.js";
import { closePptRun, ensurePptRun, pptRunId } from "./ppt-progress.js";
import { assertExportDir, pickFolder, safeStartDir } from "./folder-picker.js";
import { createConverseCommand, type ChatImportOutcome } from "./converse.js";
import { requestScenarioClarify } from "./scenario-clarify.js";
import { makeSourceLookup, runPostcheck } from "./postcheck-pass.js";
import {
  generateStageSummary,
  getOrGenerateStageSummary,
  stageCompletenessOf,
} from "./stage-summary-service.js";
import {
  draftAnchor,
  ensureAnchorRows,
  readAnchorRows,
  readBrief,
  syncDerivedDescription,
  upsertBrief,
  writeAnchorRows,
} from "./scenario-anchor.js";
import { DEFINITION_SYSTEM } from "./scenario-definition.js";
import {
  buildDefinitionContext,
  consolidateDefinition,
  definitionMessages,
  ensureDefinitionConversation,
  findDefinitionConversation,
} from "./scenario-definition.js";
import {
  completeFlowStep,
  getFlowState,
  reopenFlowStep,
} from "./flow-service.js";
import { createIngestCommand } from "./ingest.js";
import { parseStage, streamEvents } from "./sse-stream.js";
import {
  assessQuality,
  checkCompleteness,
  getAffectedStages,
  expandHomePath,
} from "@scene/domain";

// ─── 依赖 ──────────────────────────────────────────────────

export interface UiRoutesDeps {
  db: DbInstance;
  dshClient: DshClient;
  hub: SseHub;
  /** 单文件上传上限（MB）；缺省读契约，测试用小值验证 413 与临时文件清理 */
  uploadLimitMb?: number;
}

/** 通用行（HTTP 层做动态列编辑时使用，字段按表 schema 异构） */
type AnyRepo = DbInstance["productRepo"];

// ─── 资料库表代码 → 仓储映射 ───────────────────────────────

const LIBRARY_TABLES: Record<
  string,
  {
    repo: (db: DbInstance) => AnyRepo;
    category?: string;
    lineWhere?: string;
    /** 该表没有 product_line_id 列（靠 product_id 归属产品线）→ 新增行时不许塞这一列 */
    viaProduct?: boolean;
    /** 必填列（缺了直接 400 说清要什么，而不是落到 SQL 约束报 500） */
    require?: string[];
    /** 选填/枚举列的缺省值（NOT NULL 列不能空着插） */
    defaults?: Record<string, unknown>;
  }
> = {
  M1: {
    repo: (db) => db.productRepo as unknown as AnyRepo,
    require: ["model"],
    defaults: { name: "", status: "待确认", launch_date: "", position_desc: "" },
  },
  // spec_param 无 product_line_id 列，按产品归属过滤（001_init.sql）
  M2: {
    repo: (db) => db.specParamRepo as unknown as AnyRepo,
    lineWhere: "product_id IN (SELECT id FROM product WHERE product_line_id = ?)",
    viaProduct: true,
    require: ["product_id", "param_name", "value"],
    // measured 是 NOT NULL 枚举：缺省「未提及」= 材料/用户没给口径，不是"实测"
    defaults: { measured: "未提及", param_class: "未分类" },
  },
  M3: {
    repo: (db) => db.capabilityRepo as unknown as AnyRepo,
    require: ["name"],
    defaults: { domain: "未分类", description: "", maturity: "在研", dependency: "" },
  },
  M4: {
    repo: (db) => db.boundaryRepo as unknown as AnyRepo,
    require: ["description"],
    defaults: { reason: "", has_plan: "未定", response: "", owner: "" },
  },
  M5: {
    repo: (db) => db.limitationRepo as unknown as AnyRepo,
    require: ["description"],
    defaults: {
      product_name: "",
      impact: "低",
      fix_status: "无计划",
      external_visible: "不可提",
      owner: "",
    },
  },
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

/**
 * `?step=N` 解析（右栏"只针对当前步骤"）
 *
 * 缺省返回 `undefined` = 不限定步骤（阶段级）。非法值同样按缺省处理——
 * 右栏拿不到步骤时退回阶段级，不该因为一个查询参数把整页打挂。
 */
function parseStepQuery(query: unknown): number | undefined {
  const raw = (query as { step?: unknown } | null)?.step;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= FLOW_LAST_STEP ? n : undefined;
}

// ─── 注册入口 ──────────────────────────────────────────────

/** `body.kind` 解析：非法值按"没给"处理（与既有交付物接口同一口径） */
function reportKindOf(raw: unknown): ReportKind | undefined {
  return typeof raw === "string" && (REPORT_KINDS as readonly string[]).includes(raw)
    ? (raw as ReportKind)
    : undefined;
}

export function registerUiRoutes(app: FastifyInstance, deps: UiRoutesDeps): void {
  const { db, dshClient, hub } = deps;
  /** 上传上限：契约口径为准，测试可注入小值（见 AppDeps.uploadLimitMb） */
  const uploadLimitMb = deps.uploadLimitMb ?? FILE_UPLOAD_LIMIT_MB;
  const ingestCmd = createIngestCommand({ db, dshClient, docParser: parseDocument });
  const converseCmd = createConverseCommand({
    db,
    dshClient,
    // 对话即导入：消息里的本地文件路径 → ingest 管线入库（默认第一条产品线）
    importFiles: async (paths) => {
      // 优先通用库：场景专属库多了之后，对话导入默认落共享资料
      const lines = db.productLineRepo.list({
        where: "scenario_id IS NULL",
        orderBy: "created_at ASC",
      });
      const line = lines[0] ?? db.productLineRepo.list({ orderBy: "created_at ASC" })[0];
      if (!line) {
        return paths.map((p) => ({
          path: p,
          ok: false,
          error: "尚未创建产品线：请先到「产品资料库」新建一条",
        }));
      }
      const home = homedir();
      const out: ChatImportOutcome[] = [];
      for (const p of paths) {
        const abs = expandHomePath(p, home);
        if (!existsSync(abs)) {
          out.push({ path: p, ok: false, error: "文件不存在，请检查路径" });
          continue;
        }
        try {
          const r = await ingestCmd.execute({ filePath: abs, productLineId: line.id });
          out.push({
            path: p,
            ok: true,
            rowsInserted: r.rowsInserted,
            tableCounts: r.tableCounts,
            lineName: line.name,
          });
        } catch (err: unknown) {
          out.push({ path: p, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return out;
    },
  });
  /** jobId → 最新 runId（进程存续期内 SSE 续传用） */
  const ingestRuns = new Map<string, string>();
  let seq = 0;
  /** 场景 id → 报告生成的最新 runId（报告生成的 SSE 续传用） */
  const reportRuns = new Map<string, string>();
  let reportSeq = 0;

  registerProjectRoutes(app, deps);
  registerConversationRoutes(app, deps, converseCmd);
  registerLibraryRoutes(app, deps);
  registerSystemRoutes(app, deps);

  // ── 上传入库（multipart → 临时文件 → ingest 命令 → SSE 进度） ──
  app.post("/api/v1/library/ingest", async (request, reply) => {
    let file: Awaited<ReturnType<typeof request.file>>;
    try {
      file = await request.file();
    } catch (err) {
      // 文件超上限（413）要单独说清楚：原来一律回「需要 multipart 表单」，
      // 用户以为是自己传错了格式，其实只是文件太大（变更表 #155）
      const tooLarge = describeUploadFailure(err, uploadLimitMb);
      if (tooLarge) {
        return reply.code(413).send({
          statusCode: 413,
          code: "FILE_TOO_LARGE",
          message: tooLarge,
        });
      }
      return badRequest(reply, "需要 multipart 表单（字段 file + product_line_id）");
    }
    if (!file) return badRequest(reply, "缺少上传文件（multipart 字段 file）");
    const fields = file.fields as Record<string, { value?: unknown } | undefined>;
    // 双读兜底：@fastify/multipart 的 file() 只带出排在 file 部件之前的字段，
    // 排在 file 之后的字段会丢（浏览器 FormData 按 append 顺序上线）；
    // URL query 恒可读，任何客户端字段顺序都能过。
    const queryId = (request.query as { product_line_id?: string } | undefined)
      ?.product_line_id;
    const productLineId = String(
      (fields["product_line_id"] as { value?: string } | undefined)?.value
        ?? queryId
        ?? "",
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
    // 流式落盘（变更表 #156）：上游 multipart 读多少写多少，165 MB 的 PPT 不再先攒成一个
    // Buffer 全量驻留内存（旧实现 `toBuffer()` 在 50 MB 上限下勉强能过，300 MB 就会顶爆进程）。
    try {
      await pipeline(file.file, createWriteStream(filePath));
      // 真机实测（#156）踩到的坑：**超限时 pipeline 不报错**。`@fastify/multipart` 只在
      // 文件流上置 `truncated = true` 并把 `FST_REQ_FILE_TOO_LARGE` 留给下一次 `file()`
      // （旧的 `toBuffer()` 正因为自己读了 truncated 才抛）；只看异常会把"截断到上限的
      // 半个文件"当上传成功入库。所以这里必须自己查这个标记。
      if (file.file.truncated) {
        throw Object.assign(new Error("request file too large"), {
          code: "FST_REQ_FILE_TOO_LARGE",
          statusCode: 413,
        });
      }
    } catch (err) {
      // 任何失败路径都不许在 /tmp 留半截文件：超限是流被截断、客户端断开是流没读完，
      // 两者都只写成半个文件——留着只会让下次排查误以为"传上来了"
      rmSync(filePath, { force: true });
      const tooLarge = describeUploadFailure(err, uploadLimitMb);
      if (tooLarge) {
        return reply.code(413).send({
          statusCode: 413,
          code: "FILE_TOO_LARGE",
          message: tooLarge,
        });
      }
      throw err;
    }

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

  // ── 交付物：模型撰写报告 + 两份交付物导出（变更表 #112 / #137） ────────
  /**
   * 取两份报告正文（不落盘）
   *
   * 每份各自：正式版（模型撰写的方案）已生成就返回正式版，否则返回确定性要点版并标
   * `generated: false`——界面据此提示"当前是要点版，点生成报告出正式版"。
   */
  app.get("/api/v1/projects/:id/deliverables", async (request, reply) => {
    const { id } = request.params as { id: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);
    // 变更表 #137：两份交付物——「<场景>解决方案」与「<场景>建设工作方案」，各带
    // markdown / chars / generated / generated_at
    return { reports: getReports(db, scenario) };
  });

  /**
   * 生成交付物（模型撰写 + 确定性校验，SSE 推进度）
   *
   * 为什么单独一条路由而不是走阶段推进：交付物这一步不产表（33 张表全在前面），
   * 它是"把已有结论读成一份报告"，输入是全部表、输出是两份 Markdown。
   */
  app.post("/api/v1/projects/:id/deliverables/generate", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!db.scenarioRepo.getById(id)) return notFound(reply, `场景 ${id} 不存在`);
    // body.kind 可选：只重跑其中一份（不给就是两份都跑）；给了非法值按两份处理
    const body = (request.body ?? {}) as { kind?: unknown };
    const kinds =
      typeof body.kind === "string" && (REPORT_KINDS as readonly string[]).includes(body.kind)
        ? ([body.kind] as readonly ReportKind[])
        : undefined;
    const cmd = createDeliverableReportCommand({ db, dshClient });
    const runId = `${id}:deliverables#${++reportSeq}`;
    reportRuns.set(id, runId);
    const gen = await cmd.execute({ scenarioId: id, kinds });
    hub.start(runId, gen);
    await streamEvents(hub, runId, request, reply);
  });

  /** 续连生成进度（按 Last-Event-ID 重放） */
  app.get("/api/v1/projects/:id/deliverables/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    const runId = reportRuns.get(id);
    if (!runId || !hub.has(runId)) return notFound(reply, "没有正在进行的报告生成任务");
    const lastEventId = (request.headers["last-event-id"] as string | undefined) ?? null;
    await streamEvents(hub, runId, request, reply, lastEventId);
  });

  /**
   * 导出两份 Markdown 到 exports/（写盘内容 = 界面所见）
   *
   * 变更表 #137：`<场景>解决方案.md` + `<场景>建设工作方案.md`
   */
  app.post("/api/v1/projects/:id/deliverables/export", async (request, reply) => {
    const { id } = request.params as { id: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);
    return writeReportFiles(db, scenario);
  });

  /** 保存中栏改过的报告正文（变更表 #135 / #137）：写回数据/deliverables，先读后写留档 */
  app.put("/api/v1/projects/:id/deliverables/:kind", async (request, reply) => {
    const { id, kind } = request.params as { id: string; kind: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);
    if (!(REPORT_KINDS as readonly string[]).includes(kind)) {
      return reply
        .code(400)
        .send({ error: `报告类型只能是 ${REPORT_KINDS.join("、")}，收到 ${kind}` });
    }
    const body = (request.body ?? {}) as { markdown?: unknown };
    if (typeof body.markdown !== "string") {
      return reply.code(400).send({ error: "缺少正文 markdown" });
    }
    if (body.markdown.trim() === "") {
      return reply.code(400).send({ error: "正文不能是空的" });
    }
    if (body.markdown.length > 200_000) {
      return reply.code(400).send({ error: "正文过长（超过 20 万字），拒绝保存" });
    }
    return saveReportFile(scenario, kind as ReportKind, body.markdown);
  });

  /**
   * 弹系统对话框让用户选导出文件夹（变更表 #133）；取消返回 409，界面回退到手填路径
   *
   * body 可选 `{startIn}`（变更表 #151）：对话框的默认起点＝这个项目上次成功导出的目录。
   * **记忆值也要过同一道校验**（`assertExportDir`：主目录下、存在、可写、非敏感目录）——
   * 校验不过（目录被删 / 移走 / 手改过 localStorage）就静默退回系统默认位置，绝不让
   * 一个坏路径把对话框弄弹不出来。
   */
  app.post("/api/v1/projects/:id/deliverables/pick-folder", async (request, reply) => {
    const { id } = request.params as { id: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);
    const body = (request.body ?? {}) as { startIn?: unknown };
    const startIn = safeStartDir(body.startIn);
    const picked = await pickFolder(`把「${scenario.name}」的报告导出到哪个文件夹？`, startIn);
    if (!picked.dir) return reply.code(409).send({ error: picked.reason ?? "未选择文件夹" });
    return { dir: picked.dir };
  });

  /**
   * 导出 Word（按《Word 输出格式规范》生成 docx）到用户选的文件夹（变更表 #133 / #137）
   *
   * 两份交付物同一个版式：`<场景>解决方案.docx` + `<场景>建设工作方案.docx`
   */
  app.post("/api/v1/projects/:id/deliverables/export-docx", async (request, reply) => {
    const { id } = request.params as { id: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);
    const body = (request.body ?? {}) as { dir?: unknown };
    if (typeof body.dir !== "string" || body.dir.trim() === "") {
      return reply.code(400).send({ error: "缺少导出目录 dir" });
    }
    let dir: string;
    try {
      dir = assertExportDir(body.dir);
    } catch (err: unknown) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    try {
      return await exportReportDocx(db, scenario, dir);
    } catch (err: unknown) {
      request.log.error(err);
      return reply.code(500).send({ error: `生成 Word 失败：${err instanceof Error ? err.message : String(err)}` });
    }
  });

  /**
   * 导出 PPT（变更表 #141）：点一次就自动产出 `docs/PPT输出要求.md` 口径的中间页 PPT
   *
   * body：`{dir, kind?, run?}`——`kind` 默认 `solution`（与既有导出接口同口径解析）；
   * `run` 是前端给进度通道的 token（同一 token 先订阅 `…/export-pptx/events?run=`）。
   * 返回与导出 Word 完全同形：`{files, unchanged, notice?}`——失败也只回 notice，不抛 500。
   */
  app.post("/api/v1/projects/:id/deliverables/export-pptx", async (request, reply) => {
    const { id } = request.params as { id: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);
    const body = (request.body ?? {}) as { dir?: unknown; kind?: unknown; run?: unknown };
    if (typeof body.dir !== "string" || body.dir.trim() === "") {
      return reply.code(400).send({ error: "缺少导出目录 dir" });
    }
    let dir: string;
    try {
      dir = assertExportDir(body.dir);
    } catch (err: unknown) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    const kind = reportKindOf(body.kind) ?? "solution";
    const run = typeof body.run === "string" && body.run.trim() !== "" ? body.run.trim() : null;
    const channel = run === null ? null : ensurePptRun(hub, run);
    try {
      const push =
        channel === null
          ? () => undefined
          : (event: FollowEvent): void => {
              if (typeof event.message === "string") channel.push(event.message);
            };
      return await exportReportPptx({ db, scenario, kind, dir, dshClient, push });
    } catch (err: unknown) {
      request.log.error(err);
      return reply.code(500).send({ error: `导出 PPT 失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      if (run !== null) closePptRun(run);
    }
  });

  /** PPT 导出进度（SSE）：前端先订阅、再 POST；run 未建时先建起来，两边谁先到都行 */
  app.get("/api/v1/projects/:id/deliverables/export-pptx/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!db.scenarioRepo.getById(id)) return notFound(reply, `场景 ${id} 不存在`);
    const { run } = request.query as { run?: string };
    if (typeof run !== "string" || run.trim() === "") {
      return reply.code(400).send({ error: "缺少进度通道 run" });
    }
    const token = run.trim();
    ensurePptRun(hub, token);
    const lastEventId = (request.headers["last-event-id"] as string | undefined) ?? null;
    await streamEvents(hub, pptRunId(token), request, reply, lastEventId);
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
    // filename 是真名（file.filename），filePath 是临时落盘路径——两个都传：
    // 落库的 source 必须写"材料叫什么"，不能写临时名（变更表 #156）
    const result = await ingestCmd.execute({ filePath, productLineId, fileName: filename });
    yield {
      type: "done",
      rows_inserted: result.rowsInserted,
      table_counts: result.tableCounts,
      quality: result.qualityAssessment,
      completeness: result.completenessReport,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "error", message: `入库失败：${message}` };
  } finally {
    // 成功也要删：临时件只在解析/分类这段有用，留着就是每次上传在盘上多压一份原文
    // （实测临时目录里积了 89 个 ingest-* 垃圾文件）。变更表 #156
    rmSync(filePath, { force: true });
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
    return scenarios.map((s) => ({
      ...s,
      stale_count: staleCount.get(s.id) ?? 0,
      // v1.5 左栏场景列表显示「第 n/8 步」：只按完成记录推导，不做逐表就绪判定（列表要轻）
      flow: (() => {
        const st = buildFlowStatus({
          completed: db.scenarioStepRepo.completedSteps(s.id),
        });
        return {
          currentStep: st.currentStep,
          completedCount: st.completedCount,
          finished: st.finished,
        };
      })(),
    }));
  });

  app.post("/api/v1/projects", async (request, reply) => {
    const body = (request.body ?? {}) as {
      name?: unknown;
      product_line_id?: unknown;
      description?: unknown;
      /** 场景诉求（第一输入，v1.4 §3.0）：一句话想搞清楚什么 */
      intent?: unknown;
      customer_hint?: unknown;
      region_hint?: unknown;
      scope_hint?: unknown;
      audience?: unknown;
      deadline?: unknown;
    };
    const name = String(body.name ?? "").trim();
    if (!name) return badRequest(reply, "项目名不能为空");
    if (name.length > 100) return badRequest(reply, "项目名不超过 100 字符");
    // 场景描述（分析锚 v1.11）：客户/行业、问题、目标与边界
    const description = String(body.description ?? "").trim().slice(0, 4000);

    // v1.10：每个场景自动带一条专属资料库（场景内上传落这里，删除场景时资料保留）；
    // 显式传 product_line_id 时沿用该库（高级用法，不标专属归属）
    let productLineId = String(body.product_line_id ?? "").trim();
    const ownLine = !productLineId;
    if (ownLine) {
      productLineId = createOwnLineForScenario(db, name);
    } else if (!db.productLineRepo.getById(productLineId)) {
      return notFound(reply, `产品线 ${productLineId} 不存在`);
    }
    const scenario = db.scenarioRepo.insert({
      name,
      description: description || null,
      product_line_id: productLineId,
      status: "进行中",
      current_stage: 0,
    });
    if (ownLine) {
      db.productLineRepo.update(productLineId, { scenario_id: scenario.id } as never);
    }

    // 场景诉求（第一输入）：有诉求才落库；同时建表1-1 锚骨架，用户进阶段 1 即可逐格确认
    const intent = String(body.intent ?? "").trim();
    if (intent || body.customer_hint || body.scope_hint) {
      upsertBrief(db, scenario.id, {
        scene_name: name,
        intent,
        customer_hint: body.customer_hint as string,
        region_hint: body.region_hint as string,
        scope_hint: body.scope_hint as string,
        audience: body.audience as string,
        deadline: body.deadline as string,
      });
    }
    ensureAnchorRows(db, scenario.id, name);
    return scenario;
  });

  // ─── 场景诉求（第一输入） ──────────────────────────────

  /** 读场景诉求；顺带保证锚骨架存在（幂等） */
  app.get("/api/v1/projects/:id/brief", async (request, reply) => {
    const { id } = request.params as { id: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);
    ensureAnchorRows(db, id, scenario.name);
    return { brief: readBrief(db, id) ?? null, anchor: readAnchorRows(db, id) };
  });

  /** 写场景诉求（upsert；`raw_text` 首次写入后不再改写，它是确认基准） */
  app.put("/api/v1/projects/:id/brief", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!db.scenarioRepo.getById(id)) return notFound(reply, `场景 ${id} 不存在`);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const intent = String(body.intent ?? "").trim();
    if (!intent) return badRequest(reply, "「想搞清楚什么」不能为空（它是本产品的第一输入）");
    if (intent.length > 500) return badRequest(reply, "「想搞清楚什么」不超过 500 字符");
    const brief = upsertBrief(db, id, {
      scene_name: String(body.scene_name ?? "").trim() || undefined,
      intent,
      customer_hint: body.customer_hint as string,
      region_hint: body.region_hint as string,
      scope_hint: body.scope_hint as string,
      audience: body.audience as string,
      deadline: body.deadline as string,
    });
    return { brief, anchor: readAnchorRows(db, id) };
  });

  // ─── 业务流程推进（v1.5 逐页推进；v1.6 起 8 步） ──────────

  /** 流程状态：每步三态（已完成/当前/可推进/未解锁）+ 就绪判定 */
  app.get("/api/v1/projects/:id/flow", async (request, reply) => {
    const { id } = request.params as { id: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);
    return getFlowState(db, scenario);
  });

  /** 完成本步（用户显式动作；就绪与否由前端按 ready 决定按钮是否可点） */
  app.post("/api/v1/projects/:id/flow/steps/:step/complete", async (request, reply) => {
    const { id, step } = request.params as { id: string; step: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);
    const n = Number(step);
    if (!Number.isInteger(n) || n < 1 || n > FLOW_LAST_STEP) {
      return badRequest(reply, `步骤号非法：${step}（应为 1-${FLOW_LAST_STEP}）`);
    }
    return completeFlowStep(db, scenario, n);
  });

  /** 回到某一步重跑：清掉该步及其后的完成标记（数据保留，场景回到进行中） */
  app.post("/api/v1/projects/:id/flow/steps/:step/reopen", async (request, reply) => {
    const { id, step } = request.params as { id: string; step: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);
    const n = Number(step);
    if (!Number.isInteger(n) || n < 1 || n > FLOW_LAST_STEP) {
      return badRequest(reply, `步骤号非法：${step}（应为 1-${FLOW_LAST_STEP}）`);
    }
    return reopenFlowStep(db, scenario, n);
  });

  /** 起草场景锚（表1-1）：诉求 + 资料库 → 12 项内容；用户确认过的行不被覆盖 */
  app.post("/api/v1/projects/:id/brief/draft", async (request, reply) => {
    const { id } = request.params as { id: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);
    const brief = readBrief(db, id);
    if (!brief) return badRequest(reply, "请先填写场景诉求（场景名称 + 想搞清楚什么）");
    const outcome = await draftAnchor(db, deps.dshClient, scenario, brief);
    return {
      rows: outcome.rows,
      open_questions: outcome.openQuestions,
      conversation_id: outcome.conversationId,
      used_llm: outcome.usedLlm,
    };
  });

  /** 锚行批量写入（表1-1 逐格编辑 / 整表确认；也可只传部分行） */
  app.put("/api/v1/projects/:id/anchor", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!db.scenarioRepo.getById(id)) return notFound(reply, `场景 ${id} 不存在`);
    const body = (request.body ?? {}) as { rows?: unknown };
    if (!Array.isArray(body.rows)) return badRequest(reply, "rows 必须是数组");
    const rows = (body.rows as Record<string, unknown>[]).map((r) => ({
      item: String(r["item"] ?? "").trim(),
      content: String(r["content"] ?? ""),
      source: (r["source"] as string | undefined) ?? null,
      source_type: (r["source_type"] as never) ?? null,
      confirm_state: (r["confirm_state"] as string | undefined) ?? null,
    }));
    // 只认表1-1 注册表里的固定项：旧客户端还可能推 12 项制的残项（拍板者/价值主张…），
    // 写进去就是界面上永远看不见却一直躺在库里、还参与派生的脏数据。
    const known = new Set(anchorFixedRows().map((r) => r.label));
    const unknown = rows.map((r) => r.item).filter((item) => item !== "" && !known.has(item));
    if (unknown.length > 0) {
      return badRequest(reply, `表1-1 没有这些项：${unknown.join("、")}`);
    }
    const written = writeAnchorRows(db, id, rows);
    syncDerivedDescription(db, id);
    return { rows: written, description: db.scenarioRepo.getById(id)?.description ?? "" };
  });

  /** 手动场景澄清（v1.12）：强制生成值得确认的问题，发进该场景的对话 */
  app.post("/api/v1/projects/:id/clarify-scenario", async (request, reply) => {
    const { id } = request.params as { id: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);
    const result = await requestScenarioClarify(db, deps.dshClient, scenario);
    if (!result.needClarification) {
      return { need_clarification: false, questions: [], note: "场景信息已充分，无需澄清" };
    }
    return {
      need_clarification: true,
      questions: result.questions,
      conversation_id: result.conversationId,
    };
  });

  // ── 场景资料来源（v1.10：专属库 + 引用通用库，分析时合并） ──

  app.get("/api/v1/projects/:id/material-sources", async (request, reply) => {
    const { id } = request.params as { id: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);
    // 默认引用（用户定调）：通用库**没有排除记录就是引用**，因此存量场景天然全勾选
    const excluded = new Set(
      db.scenarioLinkedLineRepo
        .list({ where: "scenario_id = ?", params: [id] })
        .filter((l) => Boolean(l.excluded))
        .map((l) => l.product_line_id),
    );
    const linked = db.productLineRepo
      .list({ where: "scenario_id IS NULL", orderBy: "created_at ASC" })
      .filter((l) => !excluded.has(l.id));
    return { own: db.productLineRepo.getById(scenario.product_line_id), linked };
  });

  app.put("/api/v1/projects/:id/material-sources", async (request, reply) => {
    const { id } = request.params as { id: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);
    const body = (request.body ?? {}) as { linked_line_ids?: unknown };
    const rawIds = Array.isArray(body.linked_line_ids) ? body.linked_line_ids.map(String) : [];
    const ids = [...new Set(rawIds)];
    // 只允许引用通用库（scenario_id 为空）；专属库互引没有意义
    const shared = new Set(
      db.productLineRepo.list({ where: "scenario_id IS NULL" }).map((l) => l.id),
    );
    for (const lineId of ids) {
      if (!shared.has(lineId)) {
        return badRequest(reply, `产品线 ${lineId} 不是通用资料库（专属库不可被引用）`);
      }
    }
    // 前端传的是**勾选集合**；落库落的是补集（哪些被显式取消），这样"默认引用"
    // 不需要在建场景时批量写行，存量场景也不用回填
    const checked = new Set(ids);
    for (const lineId of shared) {
      const existing = db.scenarioLinkedLineRepo
        .list({ where: "scenario_id = ? AND product_line_id = ?", params: [id, lineId] })
        .at(0);
      const excluded = checked.has(lineId) ? 0 : 1;
      if (!existing) {
        if (excluded === 1) {
          db.scenarioLinkedLineRepo.insert({
            scenario_id: id,
            product_line_id: lineId,
            excluded: 1,
          } as never);
        }
        continue;
      }
      if (Boolean(existing.excluded) !== Boolean(excluded)) {
        db.scenarioLinkedLineRepo.update(existing.id, { excluded } as never);
      }
    }
    return { scenario_id: id, linked_line_ids: ids };
  });

  app.patch("/api/v1/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { name?: unknown; status?: unknown; description?: unknown };
    const patch: Record<string, unknown> = {};
    if (body.description !== undefined) {
      patch["description"] = String(body.description).trim().slice(0, 4000) || null;
    }
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

  // 失效横幅：受影响流程步 + 涉及表
  app.get("/api/v1/projects/:id/stale", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!db.scenarioRepo.getById(id)) return notFound(reply, `场景 ${id} 不存在`);
    const staleRows = db.stageDataRepo.list({
      where: "scenario_id = ? AND is_stale = 1",
      params: [id],
    });
    const stages = [...new Set(staleRows.map((r) => r.stage))].sort((a, b) => a - b);
    const tables = [...new Set(staleRows.map((r) => String(r.table_code)))];
    /* 文案按**表 → 流程步**反查，不拿阶段号示人：
       落库阶段 0 基、界面第 n 步，两套编号不等（第 1、2 步同属阶段 1），
       写「（3、4 阶段）」用户对不上「第 4 步 能力匹配 / 第 5 步 方案与实现」。 */
    const steps = staleFlowSteps(tables);
    return {
      stages,
      tables,
      steps: steps.map((s) => s.id),
      banner: steps.length
        ? `${steps.length} 步的分析因资料变更待重算：${steps.map((s) => s.label).join("、")}`
        : null,
    };
  });

  /**
   * 资料失效「已知悉」：用户看过横幅、决定不重算 → 只清标记，不碰一行数据
   *
   * 为什么要有这个入口：标记只能靠重跑阶段或回退才能消（那两条路都会重写数据）。
   * 而"我确认过这几行、结论不受影响"是常见的判断，用户有决定权（F3），所以给一个
   * 明确的"已知悉"动作，而不是逼用户为了消掉提示去重跑一遍。
   */
  app.post("/api/v1/projects/:id/stale/ack", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!db.scenarioRepo.getById(id)) return notFound(reply, `场景 ${id} 不存在`);
    const stages = [
      ...new Set(
        db.stageDataRepo
          .list({ where: "scenario_id = ? AND is_stale = 1", params: [id] })
          .map((r) => r.stage),
      ),
    ].sort((a, b) => a - b) as StageId[];
    let cleared = 0;
    for (const stage of stages) {
      cleared += db.stageDataRepo.markStale(id, [stage], false);
    }
    return { cleared, stages };
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
  // `?step=N`：完整度按**当前步骤**的表集算（右栏"只针对当前步骤"，阶段 1 横跨第 1、2 两步）
  app.get("/api/v1/projects/:id/stages/:stage", async (request, reply) => {
    const { id, stage: stageParam } = request.params as { id: string; stage: string };
    const stage = parseStage(stageParam);
    if (stage === undefined) return badRequest(reply, `阶段编号非法: ${stageParam}`);
    if (!db.scenarioRepo.getById(id)) return notFound(reply, `场景 ${id} 不存在`);

    const rows = db.stageDataRepo.listByScenarioStage(id, stage);
    // v1.4：不再返回质量关与建议档位——改为信息完整度（缺口清单）+ 总结是否已生成。
    // gates/advice 保留为空值仅为过渡期兼容旧前端（P4 前端改造后移除）。
    const completeness = stageCompletenessOf(db, id, stage, parseStepQuery(request.query));
    // 兼容旧数据：历史 stage=7/8（老口径的交付物）按现行阶段 6 查总结（同 advance-stage 的垫片）
    const summaryReady = Boolean(
      db.stageSummaryRepo.get(id, ((stage as number) >= 7 ? 6 : stage) as InfoStageId),
    );
    return { rows, gates: [], advice: null, completeness, summary_ready: summaryReady };
  });

  // 阶段表单元格编辑（落库 + source_type 转「用户确认」）
  /**
   * 阶段信息完整度（右栏状态行 / 缺口清单）
   *
   * 替代旧「质量关 + 建议档位」：只给"还缺什么"，不给任何判定。
   */
  app.get("/api/v1/projects/:id/stages/:stage/completeness", async (request, reply) => {
    const { id, stage } = request.params as { id: string; stage: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);
    const n = parseStage(stage);
    if (n === undefined) return badRequest(reply, `阶段号非法：${stage}`);
    return stageCompletenessOf(db, id, n, parseStepQuery(request.query));
  });

  /**
   * 阶段总结文档（右栏 Tab ②）
   *
   * `?step=N`（右栏默认）：**只讲这一步**——表集限本步，不含用户诉求全文与上下游衔接
   *              （用户定调"只针对当前阶段做说明和总结，不要整理整个过程"）；
   *              缺省是阶段级归纳（交付物装配用，含诉求基准与上下游衔接）。
   * `?format=md` 直接下载 Markdown；默认返回 JSON（含完整度）。
   * `?refresh=1` 强制重新生成。
   */
  app.get("/api/v1/projects/:id/stages/:stage/summary", async (request, reply) => {
    const { id, stage } = request.params as { id: string; stage: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);
    const n = parseStage(stage);
    if (n === undefined) return badRequest(reply, `阶段号非法：${stage}`);
    const query = request.query as { format?: string; refresh?: string };
    const step = parseStepQuery(request.query);
    const opts = step === undefined ? {} : { step };
    const result =
      query.refresh === "1"
        ? generateStageSummary(db, scenario, n, opts)
        : getOrGenerateStageSummary(db, scenario, n, opts);
    if (query.format === "md") {
      return reply
        .header("content-type", "text/markdown; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="stage-${result.stage}-summary.md"`,
        )
        .send(result.markdown);
    }
    return {
      stage: result.stage,
      markdown: result.markdown,
      completeness: result.completeness,
    };
  });

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
    /* 改了这一格 → 引用这张表的下游阶段标「待重算」（如 表2-2 → 阶段 2、4）
       依据是 TABLE_DEPENDENCIES；本阶段自身不吃自己的依赖，故只标下游。 */
    const downstream = getAffectedStages(String(row.table_code));
    if (downstream.length > 0) {
      db.stageDataRepo.markStale(id, downstream, true);
    }
    return { ...updated, stale_marked_stages: downstream };
  });
}

/** 为场景创建专属资料库（v1.10）；名称唯一，重名自动加短后缀 */
function createOwnLineForScenario(db: UiRoutesDeps["db"], scenarioName: string): string {
  let lineName = `${scenarioName}·专属资料`;
  const taken = new Set(db.productLineRepo.list().map((l) => l.name));
  if (taken.has(lineName)) {
    lineName = `${lineName}-${randomUUID().slice(0, 4)}`;
  }
  const line = db.productLineRepo.insert({ name: lineName });
  return line.id;
}

/** 删场景：手动级联（无外键级联），知识库条目保留；引用关联清理，专属库及其资料保留 */
function deleteScenarioCascade(db: DbInstance, scenarioId: string) {
  db.db.transaction(() => {
    /* 消息挂在 conversation 上（不直接指向 scenario），先清掉 */
    for (const conv of db.conversationRepo.list({
      where: "scenario_id = ?",
      params: [scenarioId],
    })) {
      db.messageRepo.deleteByConversation(conv.id);
    }
    /* 其余子表统一按外键清扫；最后删场景本身 */
    sweepScenarioChildren(db, scenarioId);
    db.scenarioRepo.deleteById(scenarioId);
  })();
}

/**
 * 兜底清扫：凡外键指向 `scenario(id)` 的表，按 `scenario_id` 清干净。
 *
 * 为什么不能只写几张表：漏掉任何一张（踩过 `scenario_step` / `scenario_brief`）
 * 整个删除都会因外键约束失败——用户看到的就是「场景怎么都删不掉」。
 * 从系统表里读依赖关系，以后新增子表不必再回来改这里。
 * （只扫「直接子表」：它们的列名都是 scenario_id；孙子表挂的是别的列，另行处理。）
 */
function sweepScenarioChildren(db: DbInstance, scenarioId: string) {
  const children = db.db
    .prepare(
      `SELECT m.name AS tbl, f."from" AS col
         FROM sqlite_master m
         JOIN pragma_foreign_key_list(m.name) f
        WHERE m.type = 'table' AND f."table" = 'scenario'`,
    )
    .all() as { tbl: string; col: string }[];
  for (const child of children) {
    if (child.tbl === "scenario") continue;
    db.db.prepare(`DELETE FROM "${child.tbl}" WHERE "${child.col}" = ?`).run(scenarioId);
  }
}

// ─── 会话路由 ──────────────────────────────────────────────

function registerConversationRoutes(
  app: FastifyInstance,
  deps: UiRoutesDeps,
  converseCmd: ReturnType<typeof createConverseCommand>,
) {
  const { db, hub } = deps;
  let convSeq = 0;
  /** 场景定义对话的 SSE 流序号（与普通会话互不干扰） */
  let defSeq = 0;
  /** 会话 → 最新回复流 runId（进程存续期内 Last-Event-ID 续传用，契约 v1.5） */
  const latestConvRuns = new Map<string, string>();

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

  // ─── 场景定义（v1.5 对话式；流程第 1 步） ────────────────
  //
  // 用户定调："场景定义不该让用户一项一项填空"——因此第 1 步是**对话**：
  // 模型先给理解再提问，聊清楚后由用户点「整理成定义」落成表1-1。

  /** 定义对话状态：会话（幂等创建）+ 消息 + 当前表1-1 */
  app.get("/api/v1/projects/:id/definition", async (request, reply) => {
    const { id } = request.params as { id: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);
    ensureAnchorRows(db, id, scenario.name); // 幂等：与 GET /brief 一致，先保证 12 行锚骨架在
    // **读操作不创建会话**：只为拿对话条数就建会话，会让"看一眼第 1 步"在左栏凭空多出一个会话。
    // 会话在用户真正发第一条消息时由 POST /definition/messages 创建（ensureDefinitionConversation）。
    const existing = findDefinitionConversation(db, id);
    return {
      conversation_id: existing,
      messages: existing ? definitionMessages(db, existing) : [],
      anchor: readAnchorRows(db, id),
      brief: readBrief(db, id) ?? null,
    };
  });

  /** 发一条消息（SSE 流式）；系统提示词换成「场景定义助手」 */
  app.post("/api/v1/projects/:id/definition/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);
    const body = (request.body ?? {}) as { content?: unknown };
    const content = String(body.content ?? "").trim();
    if (!content) return badRequest(reply, "消息内容不能为空");
    const conversationId = await ensureDefinitionConversation(db, deps.dshClient, scenario);
    const runId = `${id}:definition#${++defSeq}`;
    hub.start(
      runId,
      converseCmd.sendMessage(conversationId, content, {
        system: DEFINITION_SYSTEM,
        contextPrefix: `${buildDefinitionContext(db, scenario)}\n`,
      }),
    );
    await streamEvents(hub, runId, request, reply);
  });

  /** 「整理成定义」：把对话整理成表1-1（保留用户已确认行） */
  app.post("/api/v1/projects/:id/definition/consolidate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) return notFound(reply, `场景 ${id} 不存在`);
    const conversationId = await ensureDefinitionConversation(db, deps.dshClient, scenario);
    const out = await consolidateDefinition(db, deps.dshClient, scenario, conversationId);
    // 生成后三问自检（规则 G-R8）：第 1 步也是"生成"，同样不许跳过自检。
    // 用户定调"这是生成过程的一个步骤，为什么要用户判断"→ 自动查、自动改、改不掉按实降级。
    const postcheckOutcome = await runPostcheck({
      listRows: () =>
        db.stageDataRepo.listByScenarioStage(id, 1 as never)
          .filter((r) => r.table_code === ANCHOR_TABLE_CODE)
          .map((r) => ({
            id: r.id,
            tableCode: r.table_code,
            row: r.row as InfoRow,
            source: r.source,
            sourceType: r.source_type,
          })),
      lookup: makeSourceLookup(db),
      dshClient: deps.dshClient,
      applyFix: (rowId, patch) => {
        db.stageDataRepo.update(rowId, patch);
      },
      scenarioName: scenario.name,
      stage: 1 as never,
    });
    const alignment = alignmentWithBrief(
      out.rows.map((r) => ({
        item: r.item,
        content: r.content,
        source_type: r.source_type ?? undefined,
      })),
    );
    return {
      rows: out.rows,
      alignment,
      updated: out.updated,
      skipped: out.skipped,
      open_questions: out.openQuestions,
      used_llm: out.usedLlm,
      // 模型给了但匹配不到固定项的项名：暴露出来，避免"整理后啥也没写"无从排查
      dropped: out.dropped,
      // 模型顺手推断、按"只收用户说过的"规则丢弃的项数（定义页去噪的可观测指标）
      inferred_dropped: out.inferredDropped,
      // 生成后自检结果：第 1 步也要让用户看得见"查了什么、改了什么"
      postcheck: postcheckOutcome.report,
    };
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
    latestConvRuns.set(id, runId);
    hub.start(runId, converseCmd.sendMessage(id, content));
    await streamEvents(hub, runId, request, reply);
  });

  // 会话回复流断线续传：Last-Event-ID 增量重放（同 stages/events 语义，契约 v1.5）
  app.get("/api/v1/conversations/:id/messages/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    const runId = latestConvRuns.get(id);
    if (!runId || !hub.has(runId)) {
      return notFound(reply, "该会话没有可续传的回复流");
    }
    const lastEventId =
      (request.headers["last-event-id"] as string | undefined) ??
      (request.query as { lastEventId?: string }).lastEventId ??
      null;
    await streamEvents(hub, runId, request, reply, lastEventId);
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
    const line = db.productLineRepo.insert({ name });
    return line;
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

  /**
   * 本库已导入的资料文件清单（变更表 #156）
   *
   * 用户原话「只能选择，不能删除」——先把"有哪些文件、各落了多少行"摆出来，
   * 才谈得上按文件删。聚合与匹配是纯函数（`library-materials.ts`，可单测）：
   * 来源 `文件名:页码` 取最后一个冒号前的部分当文件名，**全等**归组（`a.pdf` 不吃 `a.pdf.bak`）。
   */
  app.get("/api/v1/library/materials", async (request, reply) => {
    const lineId = String(
      (request.query as { product_line_id?: unknown } | undefined)?.product_line_id ?? "",
    ).trim();
    if (!lineId) return badRequest(reply, "需要 product_line_id");
    if (!db.productLineRepo.getById(lineId)) return notFound(reply, `产品线 ${lineId} 不存在`);
    return aggregateMaterials(lineRowRefs(db, lineId));
  });

  /**
   * 按文件删除（变更表 #156）：删掉本库中来源属于该文件的**所有行**
   *
   * 一处必须守住的边界：M1 产品行被删时，它的规格参数（M2）可能来自**别的文件**——
   * `spec_param.product_id` 是外键，硬删会撞 FK 报 500。这时不猜用户想删什么，
   * 直接说清"还剩几条规格来自其它文件，先删它们"，让用户决定。
   */
  app.delete("/api/v1/library/materials", async (request, reply) => {
    const query = (request.query ?? {}) as { product_line_id?: unknown; file?: unknown };
    const lineId = String(query.product_line_id ?? "").trim();
    const file = String(query.file ?? "").trim();
    if (!lineId) return badRequest(reply, "需要 product_line_id");
    if (!file) return badRequest(reply, "需要 file（要删除的来源文件名）");
    if (file === NO_SOURCE_FILE_LABEL) {
      return badRequest(reply, "无来源标注的行不是导入的资料文件，请逐行删除");
    }
    if (!db.productLineRepo.getById(lineId)) return notFound(reply, `产品线 ${lineId} 不存在`);

    const targets = lineRowRefs(db, lineId).filter((r) => rowBelongsToFile(r.source, file));
    if (targets.length === 0) {
      return notFound(reply, `该资料库没有来源为「${file}」的资料`);
    }
    const blocked = specRowsBlockingProductDelete(db, targets);
    if (blocked > 0) {
      return reply.code(409).send({
        error: `该文件的产品行还有 ${blocked} 条规格参数来自其它文件，先删掉那些规格再删本文件`,
      });
    }

    const tables: Record<string, number> = {};
    for (const row of targets) {
      LIBRARY_TABLES[row.code]!.repo(db).deleteById(row.id);
      deleteSourceIndex(db.db, row.id);
      tables[row.code] = (tables[row.code] ?? 0) + 1;
    }
    // 顺手标下游待重算（与单元格编辑/去重同一口径）：删了材料，已生成的分析就不再可信
    const staleMarked = markLineStale(db, lineId, [...new Set(targets.map((r) => r.code))]);
    return { file, deleted: targets.length, tables, stale_marked_stages: staleMarked };
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
    // 入口校验：必填列缺了就说清缺什么（旧实现直接落 SQL 约束 → 500，用户看不懂）
    const missing = (spec.require ?? []).filter((k) => {
      const v = values[k];
      return v === undefined || v === null || String(v).trim() === "";
    });
    if (missing.length > 0) {
      return badRequest(reply, `${code} 表必填列缺内容：${missing.join("、")}`);
    }
    const extra: Record<string, unknown> = spec.category
      ? { category: spec.category, payload: values }
      : {};
    // O 表的字段值整体入 payload；M 表字段直接是行列（不能把未知键 spread 进 insert）
    const base: Record<string, unknown> = spec.category
      ? { product_line_id: productLineId, source_type: "用户补充", ...extra }
      : spec.viaProduct
        ? { ...spec.defaults, ...values, source_type: "用户补充" }
        : { ...spec.defaults, ...values, product_line_id: productLineId, source_type: "用户补充" };
    return spec.repo(db).insert(base as never);
  });

  app.delete("/api/v1/library/rows/:code/:rowId", async (request, reply) => {
    const { code, rowId } = request.params as { code: string; rowId: string };
    const spec = LIBRARY_TABLES[code];
    if (!spec) return badRequest(reply, `表编号非法: ${code}`);
    const ok = spec.repo(db).deleteById(rowId);
    if (!ok) return notFound(reply, `${code} 表行 ${rowId} 不存在`);
    // 索引跟着业务行一起走（变更表 #156）：触发器只加了 INSERT/UPDATE，
    // 不清索引的话"来源真实性"自检会对已删材料给出假阳性
    deleteSourceIndex(db.db, rowId);
    markDependentStale(db, code, rowId);
    return { deleted: true };
  });

  /**
   * 产品去重（M1）：同一型号合并为一条——保留最早一条，缺位字段从重复条目补全，
   * 规格参数（M2）归并到保留产品，删除重复产品行（F3 下游待重算照打）。
   * 来源不丢失：保留行与归并行的来源标注原样在行上，可审计。
   */
  app.post("/api/v1/library/product-lines/:id/dedupe-products", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!db.productLineRepo.getById(id)) return notFound(reply, "产品线不存在");
    // 判定在领域层（library-dedupe），这里只按计划落库；产品行与规格行一次清完
    const report = dedupeLibrary(db, id);
    // F3 内联失效：去重会合并 M1 产品行、动 M2 规格归属 → 引用该产品线的场景标待重算
    const staleMarked = markLineStale(db, id, ["M1", "M2"]);
    return {
      groups: report.productGroups,
      products_removed: report.productsRemoved,
      specs_moved: report.specsMoved,
      specs_removed: report.specsRemoved,
      spec_exact_groups: report.specExactGroups,
      spec_near_groups: report.specNearGroups,
      merged: report.groups,
      stale_marked_stages: staleMarked,
    };
  });

  /** 产品线重命名（多资料库管理：新建见 POST，此处改名） */
  app.patch("/api/v1/library/product-lines/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { name?: unknown };
    const name = String(body.name ?? "").trim();
    if (!name) return badRequest(reply, "名称不能为空");
    const updated = db.productLineRepo.update(id, { name } as never);
    if (!updated) return notFound(reply, "产品线不存在");
    return updated;
  });

  /**
   * 删除产品线（资料库）（变更表 #156，用户原话「只能选择，不能删除」）
   *
   * 闸门按**数据风险**判，不按"这条库叫什么类型"判（变更表 #157 修正）：
   * 原实现把 `scenario_id IS NULL` 一律当"通用库"禁删，可库里根本没有"通用库"这个标记——
   * 用户自己「新建产品线」出来的库同样没有场景，于是**永远删不掉**（真机实测：
   * 删「UI复现-临时」被拒，理由是"通用资料库，不能删除"）。
   * 现在的判据只有两条，各自对应一种真实损失：
   *   ① 还有行 → 删了就把别人的分析依据抽走；
   *   ② 仍被活场景引用（`scenario.product_line_id` 归属，或 `scenario_linked_line` 未取消引用）
   *      → 删了场景就没资料库/少一份共享输入。
   * 空且没人引用的库（含用户新建的空库、指向已删场景的悬空库）可以删。
   * 拒绝一律 409 并给一句能照着做的话（与 404 区分：库在，只是现在不能删）。
   */
  app.delete("/api/v1/library/product-lines/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const line = db.productLineRepo.getById(id);
    if (!line) return notFound(reply, "产品线不存在");

    // 闸门 1：还有行 → 先删资料（清单见「已导入资料」）
    const rows = lineRowRefs(db, id);
    if (rows.length > 0) {
      return reply.code(409).send({
        error: `该资料库还有 ${rows.length} 行资料，先删资料再删库`,
      });
    }

    // 闸门 2：仍被活着的场景当**归属库**用 → 删了场景就没有资料库（外键也会拦）
    const usedBy = db.scenarioRepo.list({ where: "product_line_id = ?", params: [id] });
    if (usedBy.length > 0) {
      return reply.code(409).send({
        error: `该资料库仍是场景「${usedBy[0]!.name}」的归属库，先删除那个场景再删库`,
      });
    }

    // 闸门 3：仍被活场景当**共享输入**引用（勾选集合里没被取消）→ 删了那个场景会少一份输入
    const liveLinks = db.scenarioLinkedLineRepo
      .list({ where: "product_line_id = ?", params: [id] })
      .filter((l) => l.excluded !== 1 && Boolean(db.scenarioRepo.getById(l.scenario_id)));
    if (liveLinks.length > 0) {
      const names = liveLinks
        .map((l) => db.scenarioRepo.getById(l.scenario_id)?.name ?? l.scenario_id)
        .join("、");
      return reply.code(409).send({
        error: `该资料库仍被场景「${names}」引用为共享输入，先在那些场景的「本场景资料」里取消勾选再删库`,
      });
    }

    // 悬空的引用记录（指向已删场景/已显式取消引用）跟着库一起清，否则外键会拦
    const links = db.scenarioLinkedLineRepo.list({
      where: "product_line_id = ?",
      params: [id],
    });
    for (const link of links) db.scenarioLinkedLineRepo.deleteById(link.id);
    db.productLineRepo.deleteById(id);
    return { deleted: true, name: line.name, removed_links: links.length };
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
      ),
    };
  });
}

/**
 * 一条产品线下的**所有资料行**（跨 11 张库表），带表号与来源标注（变更表 #156）
 *
 * 范围与 `GET /library/product-lines` 的 `row_counts`、`DELETE /library/product-lines/:id`
 * 的"空线"判定**同一个集合**（都是 `LIBRARY_TABLES`），否则会出现"清单说 0 行、删库说还有 3 行"
 * 这种自相矛盾。M2 无 `product_line_id` 列，由 `lineFilter` 的子查询按产品归属。
 */
/** 库表行引用 + 必定存在的行 id（删除入口要用；聚合用的裸类型不带 id） */
type LineRowRef = MaterialRowRef & { id: string };

function lineRowRefs(db: DbInstance, productLineId: string): LineRowRef[] {
  const refs: LineRowRef[] = [];
  for (const [code, spec] of Object.entries(LIBRARY_TABLES)) {
    const { where, params } = lineFilter(spec, productLineId);
    for (const row of spec.repo(db).list({ where, params })) {
      const r = row as unknown as Record<string, unknown>;
      refs.push({ code, id: String(r["id"] ?? ""), source: r["source"] });
    }
  }
  return refs;
}

/**
 * 要删的 M1 产品行里，有多少规格参数（M2）来自**别的文件**
 *
 * 为什么必须拦：`spec_param.product_id` 是外键，删掉产品行会留下悬空规格 → SQLite 直接报错
 * （用户看到 500）。而那些规格是别的文件带进来的，不能跟着一起删。返回 0 才允许继续。
 */
function specRowsBlockingProductDelete(db: DbInstance, targets: LineRowRef[]): number {
  const products = targets.filter((t) => t.code === "M1" && t.id);
  if (products.length === 0) return 0;
  const targetIds = new Set(targets.filter((t) => t.code === "M2").map((t) => t.id));
  let blocked = 0;
  for (const product of products) {
    const specs = db.specParamRepo.list({
      where: "product_id = ?",
      params: [product.id],
    }) as unknown as Record<string, unknown>[];
    for (const spec of specs) {
      if (!targetIds.has(String(spec["id"]))) blocked += 1;
    }
  }
  return blocked;
}

/**
 * 资料行 → 它所属的产品线 id
 *
 * 为什么不能只查 `product` / `optional_material`：那两个 `getById` 只对 M1 产品行与 O*
 * 可选材料行有效；M3–M5 的行 id 在那两张表里必然查不到 → 拿不到产品线 → 一个场景都标不上。
 * 实测（变更表 #101）：改 M6 一条费率，`stage_data.is_stale` 全 0，等于"改费率"这个动作
 * 在系统里没有任何反馈。现在改成**先读这一行本身**：库表都带 `product_line_id`；
 * M2 规格书例外（`spec_param` 没有该列）→ 经 `product_id` 上溯到产品行再取产品线。
 */
function resolveProductLineId(db: DbInstance, code: string, rowId: string): string | undefined {
  const spec = LIBRARY_TABLES[code];
  if (!spec) return undefined;
  const row = spec.repo(db).getById(rowId) as unknown as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const direct = row["product_line_id"];
  if (typeof direct === "string" && direct) return direct;
  const productId = row["product_id"];
  if (typeof productId === "string" && productId) {
    const product = db.productRepo.getById(productId) as { product_line_id?: string } | undefined;
    return product?.product_line_id;
  }
  return undefined;
}

/**
 * 失效表号 → 受影响的**流程步**（去重、按步号升序）
 *
 * 落库阶段与用户看到的步号是两套编号，横幅只讲用户能对上的那一套。
 * 表号查不到步（如库表 M*）时跳过——它们不在流程轴里，不进文案。
 */
function staleFlowSteps(tables: string[]): { id: number; label: string }[] {
  const steps = new Map<number, string>();
  for (const code of tables) {
    const step = flowStepOfTable(code);
    if (step) steps.set(step.id, flowStepLabel(step));
  }
  return [...steps.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, label]) => ({ id, label }));
}

/**
 * 产品线 → **哪些场景的上下文里有它**
 *
 * 口径直接复用 `scenarioLineContext`（注入/重算/标脏同一份实现）：专属库进自己那个场景；
 * 通用库（`scenario_id IS NULL`，如「拓维产品」）默认进所有场景，除非用户在「本场景资料」
 * 里显式取消引用（`excluded = 1`）。教训（故障 #26）：这里原先只按"场景的 product_line_id"
 * 找，通用库挂着 0 个场景 → 改通用库一个场景都不标，用户体感是"改了什么都没发生"。
 */
function scenariosOfLine(db: DbInstance, productLineId: string): string[] {
  const ids: string[] = [];
  for (const scenario of db.scenarioRepo.list()) {
    if (scenarioLineContext(db, scenario).lineIds.includes(productLineId)) {
      ids.push(scenario.id);
    }
  }
  return ids;
}

/** 阶段清单 → 给定场景逐个标待重算，返回实际标记的行数 */
function markStages(db: DbInstance, scenarioIds: Iterable<string>, stages: StageId[]): void {
  for (const scenarioId of scenarioIds) {
    db.stageDataRepo.markStale(scenarioId, stages, true);
  }
}

/** 资料行变更 → 按 TABLE_DEPENDENCIES 反查受影响场景阶段并标待重算 */
function markDependentStale(db: DbInstance, code: string, rowId: string) {
  const stages = getAffectedStages(code) as StageId[];
  if (stages.length === 0) return;
  const scenarioIds = new Set<string>(
    db.scenarioMaterialRepo
      .list({ where: "ref_table = ? AND ref_id = ?", params: [code, rowId] })
      .map((ref) => ref.scenario_id),
  );
  const productLineId = resolveProductLineId(db, code, rowId);
  if (productLineId) for (const id of scenariosOfLine(db, productLineId)) scenarioIds.add(id);
  markStages(db, scenarioIds, stages);
}

/**
 * 批量改动整条产品线的资料（如「整理资料库 / 去重」）→ 同样标下游
 *
 * 为什么要有它：去重会**合并产品行、改规格归属、删重复行**，却走的是另一个端点，
 * 原先不标下游——于是"整理资料库"改了数据，界面上一声不响，与单元格编辑不一致。
 */
function markLineStale(db: DbInstance, productLineId: string, codes: string[]): StageId[] {
  const stages = [
    ...new Set(codes.flatMap((code) => getAffectedStages(code))),
  ].sort((a, b) => a - b) as StageId[];
  if (stages.length === 0) return [];
  markStages(db, scenariosOfLine(db, productLineId), stages);
  return stages;
}

// ─── 系统路由 ──────────────────────────────────────────────

function registerSystemRoutes(app: FastifyInstance, deps: UiRoutesDeps) {
  const { db } = deps;

  app.get("/api/v1/system/status", async () => {
    let database: "ok" | "error" = "ok";
    try {
      db.db.prepare("SELECT 1").get();
    } catch {
      database = "error";
    }
    const s = registrySummary();
    return {
      db: database,
      model_configured: s.configured,
      provider_count: s.providers.length,
      default_model: s.default_model,
    };
  });

  // ─── 供应商登记表（变更表 #16：应用自持模型配置，密钥只进不出） ───

  app.get("/api/v1/system/providers", async () => registrySummary());

  app.post("/api/v1/system/providers", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const modelsRaw = Array.isArray(body.models) ? body.models : [];
    const models: ProviderModelEntry[] = modelsRaw
      .map((m) => {
        if (typeof m === "string") return { id: m };
        const o = (m ?? {}) as Record<string, unknown>;
        return { id: String(o.id ?? ""), name: o.name ? String(o.name) : undefined };
      })
      .filter((m) => m.id);
    try {
      const created = upsertProvider({
        name: String(body.name ?? ""),
        base_url: String(body.base_url ?? ""),
        api_key: body.api_key === undefined ? undefined : String(body.api_key),
        models,
      });
      return created;
    } catch (err: unknown) {
      return badRequest(reply, err instanceof Error ? err.message : String(err));
    }
  });

  app.delete("/api/v1/system/providers/:name", async (request, reply) => {
    const { name } = request.params as { name?: string };
    if (!name) return badRequest(reply, "需要供应商名");
    if (!removeProvider(decodeURIComponent(name))) {
      return reply.code(404).send({ error: `未找到供应商 "${name}"` });
    }
    return { deleted: true };
  });

  app.put("/api/v1/system/providers/default", async (request, reply) => {
    const body = (request.body ?? {}) as { provider?: unknown; model?: unknown };
    try {
      return setDefaultModel({
        provider: String(body.provider ?? ""),
        model: String(body.model ?? ""),
      });
    } catch (err: unknown) {
      return badRequest(reply, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * 拉取供应商模型列表（仿 CC Switch）：填好链接 + Key 即可发现服务端模型，
   * 免手敲 ID。候选端点自动探测（裸域名→/v1/models、已带版本段→/models），
   * resolved_base_url 供表单回填修正。
   * 传 name = 用已存供应商（密钥留在服务端）；或传草稿 base_url(+api_key)。
   */
  app.post("/api/v1/system/providers/models", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    const saved = name ? loadRegistry().providers.find((p) => p.name === name) : undefined;
    if (name && !saved) {
      return reply.code(404).send({ error: `未找到供应商 "${name}"` });
    }
    const baseUrl = String(body.base_url ?? saved?.base_url ?? "").trim();
    const apiKey = String(body.api_key ?? "").trim() || saved?.api_key || "";
    if (!baseUrl) return badRequest(reply, "需要 name 或 base_url");
    try {
      return await fetchProviderModels({ base_url: baseUrl, api_key: apiKey });
    } catch (err: unknown) {
      return badRequest(reply, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * 链接质量检查：两段式（/models 探活+鉴权+延迟 → 指定模型时最小生成）。
   * 传 name = 测已存供应商（密钥留在服务端）；或传草稿 base_url(+api_key/model) 测未保存配置。
   */
  app.post("/api/v1/system/providers/test", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    const saved = name ? loadRegistry().providers.find((p) => p.name === name) : undefined;
    if (name && !saved) {
      return reply.code(404).send({ error: `未找到供应商 "${name}"` });
    }
    const baseUrl = String(body.base_url ?? saved?.base_url ?? "").trim();
    const apiKey = String(body.api_key ?? "").trim() || saved?.api_key || "";
    // 已存供应商未指定模型时，默认测其第一个模型（两段式验证到"能出字"）
    const model = String(body.model ?? "").trim() || saved?.models[0]?.id || undefined;
    if (!baseUrl) return badRequest(reply, "需要 name 或 base_url");
    try {
      return await checkProviderConnection({ base_url: baseUrl, api_key: apiKey, model });
    } catch (err: unknown) {
      return badRequest(reply, err instanceof Error ? err.message : String(err));
    }
  });

}

// 引用不直改：占位防 lint 未用告警（OptionalMaterial 用于类型面）
export type { OptionalMaterial, Scenario, StageData, Conversation };
