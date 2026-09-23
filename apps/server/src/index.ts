/**
 * @scene/server — Fastify 服务器入口
 *
 * 端口：4081（通过 APP_PORT 环境变量可覆盖）
 * 职责：组装真实依赖（sqlite db / DSH client）+ 注册路由（见 app.ts）
 */

import { createDb, createDshClient } from "@scene/infra";
import { createApp } from "./app.js";

const PORT = Number(process.env["APP_PORT"] ?? 4081);
const HOST = process.env["APP_HOST"] ?? "0.0.0.0";

async function main() {
  const db = createDb();
  const dshClient = createDshClient();
  const app = createApp({ db, dshClient });

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`server listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
