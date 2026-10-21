/**
 * @scene/server — Fastify 服务器入口
 *
 * 端口：46172（通过 APP_PORT 环境变量可覆盖）
 * 职责：组装真实依赖（sqlite db / DSH client）+ 注册路由（见 app.ts）
 * 静态托管：WEB_DIST 指向 web 构建产物时，单端口同时提供 UI 与 API（T5.2 联真口径）。
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createDb, createDshClient } from "@scene/infra";
import { createApp } from "./app.js";

const PORT = Number(process.env["APP_PORT"] ?? 46172);
const HOST = process.env["APP_HOST"] ?? "0.0.0.0";

/** web 构建产物目录：显式 WEB_DIST 优先；否则尝试仓库内常见构建位置 */
function resolveWebDist(): string | undefined {
  const candidates = [
    process.env["WEB_DIST"],
    resolve(process.cwd(), "apps/web/dist"),
    resolve(process.cwd(), "web/dist"),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p));
}

async function main() {
  const db = createDb();
  const dshClient = createDshClient();
  const webDist = resolveWebDist();
  const app = createApp({ db, dshClient, webDist });

  /* 价格去重的一次性迁移：把结果写进启动日志（用户/排障都要能看到迁了几条、跳过几条） */
  if (db.o3PriceMigration) {
    const { migrated, skipped } = db.o3PriceMigration;
    app.log.info(
      `O3 价格 → M6 报价迁移：已归位 ${migrated} 条、跳过 ${skipped} 条` +
        (skipped > 0 ? "（跳过项因型号不在 M1/缺金额而保留在 O3）" : ""),
    );
  }

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`server listening on http://${HOST}:${PORT}`);
    app.log.info(webDist ? `已托管 web 产物：${webDist}` : "未配置 web 产物（仅 API）");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
