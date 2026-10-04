#!/usr/bin/env node
/**
 * 迁移：删掉「总结沉淀」阶段（老阶段 6）的存量数据，并把交付物阶段 7 → 6
 * 依据：04-业务过程重定义 v1.31 / 变更表 #92（用户定调：「总结沉淀我看没什么价值」）
 *
 * 做三件事（都在一个事务里，先快照）：
 *   1. 删掉 stage=6 的旧表7-1「资产回写」行（该表已从注册表删除）
 *   2. scenario.current_stage = 7 → 6（交付物阶段由 7 收到 6）
 *   3. scenario_step 里第 8 步（老交付物）→ 第 7 步；第 7 步（老总结沉淀）的行丢弃
 *
 * 用法：
 *   node scripts/migrate-drop-stage6.mjs            # 预演，只报告不写
 *   node scripts/migrate-drop-stage6.mjs --apply    # 先快照再写
 *   DB_PATH=/path/to.db node scripts/migrate-drop-stage6.mjs --apply
 *
 * 注意：一个库同一时刻只能有一个写者——**先停掉应用**（46172）再跑 --apply。
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotDb } from "./lib/sqlite-snapshot.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DB_PATH = process.env.DB_PATH ?? join(ROOT, "data", "scene-master.db");
const APPLY = process.argv.includes("--apply");

// 经 packages/infra 解析 better-sqlite3（项目依赖装在那里）
const require = createRequire(join(ROOT, "packages", "infra", "package.json"));
const Database = require("better-sqlite3");

const db = new Database(DB_PATH, { readonly: !APPLY });
db.pragma("journal_mode = WAL");

const count = (sql, ...args) => db.prepare(sql).get(...args).n;

const legacyRows = count("select count(*) n from stage_data where stage = 6");
const legacyTables = db
  .prepare("select distinct table_code from stage_data where stage = 6")
  .all()
  .map((r) => r.table_code);
const atDelivery = count("select count(*) n from scenario where current_stage = 7");
const stepRows = db
  .prepare("select step, count(*) n from scenario_step group by step order by step")
  .all();

console.log(`库：${DB_PATH}`);
console.log(`① stage=6 的存量行：${legacyRows} 行${legacyTables.length ? `（表：${legacyTables.join("、")}）` : ""}`);
console.log(`② current_stage=7（交付物）的场景：${atDelivery} 个 → 将改为 6`);
console.log(`③ scenario_step 现有步号分布：${stepRows.map((r) => `${r.step}:${r.n}`).join(" ") || "（空）"}`);

if (!APPLY) {
  console.log("\n预演结束（未写入）。确认无误后加 --apply 执行；执行前请先停掉应用。");
  db.close();
  process.exit(0);
}

if (legacyRows > 0 && legacyTables.some((c) => c !== "表7-1")) {
  console.error(`\n✗ 阶段 6 里出现了预期外的表（${legacyTables.join("、")}）——拒绝自动删除，请人工确认。`);
  db.close();
  process.exit(1);
}

const snap = `${DB_PATH}.snap-${new Date().toISOString().replace(/[:.]/g, "-")}`;
snapshotDb(DB_PATH, snap);
console.log(`\n已快照：${snap}`);

const run = db.transaction(() => {
  const del = db.prepare("delete from stage_data where stage = 6").run();
  const scen = db.prepare("update scenario set current_stage = 6 where current_stage = 7").run();
  // scenario_step：老第 7 步（总结沉淀）删除，老第 8 步（交付物）降到第 7 步
  let steps = { removed: 0, shifted: 0 };
  try {
    steps.removed = db.prepare("delete from scenario_step where step = 7").run().changes;
    steps.shifted = db.prepare("update scenario_step set step = 7 where step = 8").run().changes;
  } catch {
    /* 老库可能没有这张表 */
  }
  return { rows: del.changes, scenarios: scen.changes, steps };
});

const r = run();
console.log(`已删除表7-1 行：${r.rows}`);
console.log(`已改 current_stage 7 → 6：${r.scenarios} 个场景`);
console.log(`scenario_step：删第 7 步 ${r.steps.removed} 行、第 8 步降为第 7 步 ${r.steps.shifted} 行`);
db.close();
