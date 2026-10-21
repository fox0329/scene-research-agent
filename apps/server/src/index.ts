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
import { auditLibrary } from "./library-audit.js";

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

  /* 数据安全：启动备份/待恢复的实况必须进日志（备份失败不阻断启动，但要能排障） */
  if (db.dbBackup.dir) {
    app.log.info(`数据备份目录：${db.dbBackup.dir}`);
  }
  if (db.dbBackup.startupBackup) {
    app.log.info(`启动前已自动备份数据库：${db.dbBackup.startupBackup}`);
  }
  if (db.dbBackup.restoredFrom) {
    app.log.info(
      `已应用待恢复备份 ${db.dbBackup.restoredFrom}` +
        (db.dbBackup.preRestoreBackup
          ? `（恢复前旧库已备份为 ${db.dbBackup.preRestoreBackup}）`
          : ""),
    );
  }
  for (const warning of db.dbBackup.warnings) {
    app.log.warn(`数据备份/恢复告警：${warning}`);
  }

  /* 价格去重的一次性迁移：把结果写进启动日志（用户/排障都要能看到迁了几条、跳过几条） */
  if (db.o3PriceMigration) {
    const { migrated, skipped } = db.o3PriceMigration;
    app.log.info(
      `存量价格记录 → 报价迁移：已归位 ${migrated} 条、跳过 ${skipped} 条` +
        (skipped > 0 ? "（跳过项因型号不在产品清单/缺金额而保留在历史记录）" : ""),
    );
  }

  /* 存量资料按新标准体检：**只打只读预览日志，不改数据**（改数据必须用户点「按新标准体检」） */
  try {
    const preview = auditLibrary(db);
    app.log.info(
      `存量资料体检（只读）：扫描 ${preview.scanned} 行、C 级 ${preview.evidence.C}、` +
        `缺页码 ${preview.unlocatable.length} 行、冲突 ${preview.conflicts.length} 组` +
        "（不改数据；POST /api/v1/library/reaudit 才会降级）",
    );
  } catch (err) {
    // 体检是排障增强，不是启动前置条件；坏库不该让服务起不来
    app.log.warn(`存量资料体检预览失败：${err instanceof Error ? err.message : String(err)}`);
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
