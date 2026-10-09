/**
 * @scene/server — Fastify 应用工厂（路由注册）
 *
 * 路由面：
 * - T4.1/T4.2：resume 对账 / advance SSE / events 断线续传 / rollback 清理
 * - M5-T5.2：UI 联真路由（registerUiRoutes，契约 v1.4 口径）+ web 静态托管（同源单端口）
 *
 * 依赖全部注入（db / dshClient / hub / webDist），测试可换 mock。
 */

import Fastify from "fastify";
import { FILE_UPLOAD_LIMIT_MB, FLOW_LAST_STEP, flowStep } from "@scene/contract";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import { existsSync } from "node:fs";
import type { DshClient, StageId } from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { planResume } from "@scene/domain";
import { createAdvanceStageCommand } from "./advance-stage.js";
import { createRollbackStageCommand } from "./rollback-stage.js";
import { createSseHub } from "./sse-hub.js";
import type { SseHub } from "./sse-hub.js";
import { parseStage, streamEvents, LAST_STAGE_ID } from "./sse-stream.js";
import { registerUiRoutes } from "./routes-ui.js";

// ─── 依赖与常量 ────────────────────────────────────────────

export interface AppDeps {
  db: DbInstance;
  dshClient: DshClient;
  hub?: SseHub;
  /** web 构建产物目录；存在则同源托管并启用 SPA 回退（M5 单端口） */
  webDist?: string;
  /**
   * 单文件上传上限（MB），缺省读契约 `FILE_UPLOAD_LIMIT_MB`（300）
   *
   * 只给测试留的口子：超限行为（413 文案 + 不留半截临时文件）必须能用小体积请求验证，
   * 不然每条用例都要造一个 300 MB 的 body。生产入口（index.ts）不传，口径仍由契约说了算。
   */
  uploadLimitMb?: number;
}

// ─── 应用工厂 ──────────────────────────────────────────────

export function createApp(deps: AppDeps): FastifyInstance {
  const { db, dshClient } = deps;
  const hub = deps.hub ?? createSseHub();
  const advanceCmd = createAdvanceStageCommand({ db, dshClient });
  const rollbackCmd = createRollbackStageCommand({ db });
  /** scenario+stage → 最新 runId */
  const latestRuns = new Map<string, string>();
  let runSeq = 0;

  const app = Fastify({
    logger: { level: process.env["LOG_LEVEL"] ?? "info" },
  });

  // ── 健康检查 ───────────────────────────────────────────
  app.get("/api/v1/health", async () => ({
    status: "ok",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
  }));

  // ── 断点续做：恢复计划 ─────────────────────────────────
  app.get("/api/v1/projects/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    const scenario = db.scenarioRepo.getById(id);
    if (!scenario) {
      return reply.code(404).send({ error: `场景 ${id} 不存在` });
    }

    const stageRows = db.stageDataRepo.list({
      where: "scenario_id = ?",
      params: [id],
    });
    const conversations = db.conversationRepo.list({
      where: "scenario_id = ?",
      params: [id],
    });
    const messages = conversations.flatMap((c) =>
      db.messageRepo.listByConversation(c.id),
    );

    return planResume({ scenario, stageRows, conversations, messages });
  });

  // ── 阶段推进：启动 + SSE 推流 ──────────────────────────
  app.post(
    "/api/v1/projects/:id/stages/:stage/advance",
    async (request, reply) => {
      const { id, stage: stageParam } = request.params as {
        id: string;
        stage: string;
      };
      const stage = parseStage(stageParam);
      if (stage === undefined) {
        return reply.code(400).send({ error: `阶段编号非法: ${stageParam}` });
      }
      if (!db.scenarioRepo.getById(id)) {
        return reply.code(404).send({ error: `场景 ${id} 不存在` });
      }

      // v1.5 流程推进：`?step=N` 时按该流程步的表集限定分析范围
      // （阶段 1 的第 2 步走"起草 + 用户确认"，第 3 步只做模型分析，不重复产出场景锚）
      const stepParam = (request.query as { step?: string }).step;
      const stepNum = stepParam === undefined ? null : Number(stepParam);
      const stepTables =
        stepNum !== null && Number.isInteger(stepNum) && stepNum >= 1 && stepNum <= FLOW_LAST_STEP
          ? flowStep(stepNum).tables
          : undefined;

      const runId = `${id}:stage:${stage}#${++runSeq}`;
      latestRuns.set(`${id}:stage:${stage}`, runId);
      hub.start(
        runId,
        advanceCmd.execute({ scenarioId: id, stage, tables: stepTables }),
      );

      await streamEvents(hub, runId, request, reply);
    },
  );

  // ── 回退清理：标记下游"待重算"（T4.2） ─────────────────
  app.post("/api/v1/projects/:id/rollback", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { targetStage?: unknown };
    const targetStage = Number(body.targetStage);
    if (!Number.isInteger(targetStage) || targetStage < 0 || targetStage > LAST_STAGE_ID) {
      return reply.code(400).send({ error: `回退目标阶段非法: ${String(body.targetStage)}` });
    }
    if (!db.scenarioRepo.getById(id)) {
      return reply.code(404).send({ error: `场景 ${id} 不存在` });
    }
    try {
      return rollbackCmd.execute({ scenarioId: id, targetStage: targetStage as StageId });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  // ── 断线重连：按 Last-Event-ID 重放 + 续流 ────────────
  app.get(
    "/api/v1/projects/:id/stages/:stage/events",
    async (request, reply) => {
      const { id, stage: stageParam } = request.params as {
        id: string;
        stage: string;
      };
      const stage = parseStage(stageParam);
      if (stage === undefined) {
        return reply.code(400).send({ error: `阶段编号非法: ${stageParam}` });
      }

      const runId = latestRuns.get(`${id}:stage:${stage}`);
      if (!runId || !hub.has(runId)) {
        return reply.code(404).send({ error: "该阶段没有可续传的分析流" });
      }

      const lastEventId =
        (request.headers["last-event-id"] as string | undefined) ??
        (request.query as { lastEventId?: string }).lastEventId ??
        null;

      await streamEvents(hub, runId, request, reply, lastEventId);
    },
  );

  // ── M5 联真路由：项目/会话/阶段/资料库/知识库/系统 ──────
  const uploadLimitMb = deps.uploadLimitMb ?? FILE_UPLOAD_LIMIT_MB;
  app.register(fastifyMultipart, {
    // 上限口径收敛到契约（FILE_UPLOAD_LIMIT_MB），前端上传前预检读同一个数（变更表 #155）
    limits: { fileSize: uploadLimitMb * 1024 * 1024 },
  });
  registerUiRoutes(app, {
    db,
    dshClient,
    hub,
    uploadLimitMb,
    /**
     * 这一步此刻是否还有分析在跑：刷新后的页面靠它继续显示"分析中"、
     * 并在跑完自动对账——不再出现"服务端早就跑完了、界面非要按 F5 才更新"（故障清单 #47）
     */
    isStageRunning: (scenarioId, stage) => {
      const runId = latestRuns.get(`${scenarioId}:stage:${stage}`);
      return runId !== undefined && hub.has(runId) && !hub.isDone(runId);
    },
  });

  // ── web 构建产物同源托管（单端口起完整应用，SPA 回退） ──
  if (deps.webDist && existsSync(deps.webDist)) {
    app.register(fastifyStatic, {
      root: deps.webDist,
      index: ["index.html"],
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "端点不存在" });
      }
      return reply.sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "未托管 web 产物（设置 WEB_DIST 启用）" });
      }
      return reply.code(404).send({ error: "端点不存在" });
    });
  }

  return app;
}

