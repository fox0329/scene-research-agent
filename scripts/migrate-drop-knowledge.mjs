#!/usr/bin/env node
/**
 * 迁移：删掉「知识库」功能（knowledge 表）
 * 依据：变更表 #95（用户定调 2026-10-04：「知识库目前是没用的，删除这个功能吧，后面有需要再说」）
 *
 * 背景：knowledge 表建成后从未被写入（实测 0 行），生成链路也不读它——
 * 只挂了一条只读 API `GET /api/v1/knowledge` 和一个前端页面，属于死功能。
 * 代码侧已整体删除（契约/领域/基础设施/服务端路由/前端页面），这里清掉存量空表。
 *
 * 做两件事（一个事务，先快照）：
 *   1. DROP INDEX idx_knowledge_category_created
 *   2. DROP TABLE knowledge
 *
 * 用法：
 *   node scripts/migrate-drop-knowledge.mjs            # 预演，只报告不写
 *   node scripts/migrate-drop-knowledge.mjs --apply    # 先快照再写
 *   DB_PATH=/path/to.db node scripts/migrate-drop-knowledge.mjs --apply
 *
 * 注意：一个库同一时刻只能有一个写者——**先停掉应用**（46172）再跑 --apply。
 */
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotDb } from "./lib/sqlite-snapshot.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DB_PATH = process.env.DB_PATH ?? join(ROOT, "data", "scene-master.db");
const APPLY = process.argv.includes("--apply");

const require = createRequire(join(ROOT, "packages", "infra", "package.json"));
const Database = require("better-sqlite3");
const db = new Database(DB_PATH);

const exists = (name, type) =>
  db
    .prepare("select count(*) as n from sqlite_master where name = ? and type = ?")
    .get(name, type).n > 0;

const hasTable = exists("knowledge", "table");
const rows = hasTable ? db.prepare("select count(*) as n from knowledge").get().n : 0;
console.log(`库：${DB_PATH}`);
console.log(`knowledge 表：${hasTable ? "存在" : "不存在"}｜行数：${rows}`);
if (!hasTable) {
  console.log("无需迁移（表已不存在）。");
  db.close();
  process.exit(0);
}
if (!APPLY) {
  console.log("预演：将 DROP INDEX idx_knowledge_category_created + DROP TABLE knowledge（加 --apply 执行）");
  db.close();
  process.exit(0);
}

const snap = join(dirname(DB_PATH), `${basename(DB_PATH)}.snap-${new Date().toISOString().replace(/[:.]/g, "-")}`);
snapshotDb(DB_PATH, snap);
console.log(`快照：${snap}`);
db.exec(`
  DROP INDEX IF EXISTS idx_knowledge_category_created;
  DROP TABLE IF EXISTS knowledge;
`);
console.log(`已删除｜表仍存在：${exists("knowledge", "table")}｜剩余表数：${
  db.prepare("select count(*) as n from sqlite_master where type='table'").get().n
}`);
db.close();
