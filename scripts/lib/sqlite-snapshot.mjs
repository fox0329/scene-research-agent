/**
 * 数据库「一致快照」小工具（迁移脚本共用）
 *
 * 为什么需要它（2026-10-04 实跑发现）：
 *   迁移脚本原来用 `copyFileSync(db)` 在副本上做 dry-run、在 `--apply` 前做备份。
 *   但项目库跑在 **WAL 模式**下，最近的写入还在 `<db>-wal` 里没 checkpoint 进主文件——
 *   只拷主文件 = **漏读最近写的数据**。实测：用户库里表3-7 有 18 行，脚本只看到 10 行
 *   （另 8 行是当天 11:05 刚写进 WAL 的）；同样的盲区也会让"自动备份"少掉最新数据。
 *
 * 做法：用 SQLite 自己的 `VACUUM INTO <目标>` 生成单文件快照——它读的是**当前一致的库视图**
 *   （含 WAL 中已提交的事务），产出一个干净、独立、可单独打开的快照文件。
 *   比手拷 -wal/-shm 三个文件更可靠（不用关心 checkpoint 时机与文件锁）。
 *
 * 依赖解析：`better-sqlite3` 是 `@scene/infra` 的依赖，从仓库根目录解析不到，
 *   这里借 infra 的解析路径取（与 `migrate-anchor-v119.mjs` 里 createDb 的注释同一个原因）。
 */

import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// 注意用 fileURLToPath 而不是 URL.pathname：仓库路径含中文，pathname 会做百分号编码
const INFRA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/infra");
const Database = require(require.resolve("better-sqlite3", { paths: [INFRA_DIR] }));

/**
 * 把 `srcPath` 的一致快照写到 `dstPath`（含 WAL 中尚未 checkpoint 的数据）
 *
 * @param {string} srcPath 源库（可以是正在被应用使用的库：VACUUM INTO 只读源库）
 * @param {string} dstPath 目标文件（存在则先删除——VACUUM INTO 不会覆盖已有文件）
 */
export function snapshotDb(srcPath, dstPath) {
  if (!existsSync(srcPath)) throw new Error(`源库不存在：${srcPath}`);
  if (existsSync(dstPath)) rmSync(dstPath, { force: true });

  const src = new Database(srcPath, { fileMustExist: true });
  try {
    src.pragma("busy_timeout = 5000");
    src.exec(`VACUUM INTO '${dstPath.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
  return dstPath;
}
