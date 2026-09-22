/**
 * @scene/server — Fastify 服务器骨架
 *
 * 端口：4081（通过 APP_PORT 环境变量可覆盖）
 * 职责：REST API + SSE + 静态文件服务
 */

import Fastify from "fastify";

const PORT = Number(process.env["APP_PORT"] ?? 4081);
const HOST = process.env["APP_HOST"] ?? "0.0.0.0";

async function main() {
  const app = Fastify({
    logger: {
      level: process.env["LOG_LEVEL"] ?? "info",
    },
  });

  // ── 健康检查 ───────────────────────────────────────────
  app.get("/api/v1/health", async () => {
    return { status: "ok", version: "0.1.0", timestamp: new Date().toISOString() };
  });

  // ── TODO: 注册路由 ─────────────────────────────────────
  // library routes  (资料库 CRUD + ingest)
  // project routes (项目 + 阶段推进)
  // conversation routes (会话 + 消息 + SSE)
  // knowledge routes (知识查询)
  // system routes  (DSH 探活 + 设置)

  // ── 启动 ───────────────────────────────────────────────
  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`server listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
