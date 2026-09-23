/**
 * @scene/server — Fastify 应用工厂（路由注册）
 *
 * T4.1 断点续做落地的路由面：
 * - GET  /api/v1/projects/:id/resume          恢复计划（对账）
 * - POST /api/v1/projects/:id/stages/:stage/advance  启动阶段分析（SSE）
 * - GET  /api/v1/projects/:id/stages/:stage/events   断线重连（Last-Event-ID 重放）
 *
 * 依赖全部注入（db / dshClient / hub），测试可换 mock。
 */

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { DshClient, StageId } from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { planResume } from "@scene/domain";
import { createAdvanceStageCommand } from "./advance-stage.js";
import { createRollbackStageCommand } from "./rollback-stage.js";
import { createSseHub } from "./sse-hub.js";
import type { SseHub } from "./sse-hub.js";

// ─── 依赖与常量 ────────────────────────────────────────────

export interface AppDeps {
  db: DbInstance;
  dshClient: DshClient;
  hub?: SseHub;
}

/** runId 中每个"项目+阶段"只保留最新一次运行 */
const LAST_STAGE_ID: StageId = 8;

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

      const runId = `${id}:stage:${stage}#${++runSeq}`;
      latestRuns.set(`${id}:stage:${stage}`, runId);
      hub.start(
        runId,
        advanceCmd.execute({ scenarioId: id, stage }),
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

  return app;
}

// ─── 子函数 ────────────────────────────────────────────────

function parseStage(raw: string): StageId | undefined {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > LAST_STAGE_ID) return undefined;
  return n as StageId;
}

/**
 * 把 hub 订阅流写成 SSE。
 * 事件带递增 id（advance-stage 生成），客户端断开后
 * 可用 Last-Event-ID 通过 events 路由增量续传。
 */
async function streamEvents(
  hub: SseHub,
  runId: string,
  request: { raw: import("node:http").IncomingMessage },
  reply: {
    raw: import("node:http").ServerResponse;
    hijack: () => void;
  },
  lastEventId?: string | null,
): Promise<void> {
  reply.hijack();

  const iterable = hub.subscribe(runId, lastEventId ?? null);
  if (!iterable) {
    reply.raw.writeHead(404, { "Content-Type": "application/json" });
    reply.raw.end(JSON.stringify({ error: `run ${runId} 不存在` }));
    return;
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.flushHeaders();

  let closed = false;
  request.raw.on("close", () => {
    closed = true;
  });

  try {
    for await (const event of iterable) {
      if (closed) break;
      const idLine = event.id ? `id: ${event.id}\n` : "";
      reply.raw.write(`event: follow\n${idLine}data: ${JSON.stringify(event)}\n\n`);
    }
  } finally {
    if (!closed) reply.raw.end();
  }
}
