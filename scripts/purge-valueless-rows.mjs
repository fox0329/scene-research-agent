#!/usr/bin/env node
/**
 * 清理库里「不达标」的行（表2-5 的不可执行约束 + 全表无价值行）
 *
 * 用户定调 2026-10-20：「没用的内容删除」——判定口径与线上自检完全一致
 * （`constraint-check.ts` / `value-check.ts`），所以这里删的正是自检会拦的那批，
 * 不会另立一套标准。
 *
 * 默认 dry-run，只列不删；加 --apply 才真删，删前自动在同目录备份
 * `scene.db.bak-<时间戳>`（SQLite backup，含 WAL 内容，可直接回滚）。
 *
 * 用法：
 *   node scripts/purge-valueless-rows.mjs                 # 只看
 *   node scripts/purge-valueless-rows.mjs --apply         # 真删
 *   node scripts/purge-valueless-rows.mjs --db <路径>      # 指定库
 */
import { readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const require = createRequire(import.meta.url);
const pnpmDir = join(process.cwd(), "node_modules", ".pnpm");
const bsq = readdirSync(pnpmDir).find((d) => d.startsWith("better-sqlite3@"));
if (!bsq) {
  console.error("找不到 better-sqlite3（先在仓库根跑 pnpm install）");
  process.exit(1);
}
const Database = require(join(pnpmDir, bsq, "node_modules", "better-sqlite3"));
const { judgeConstraint } = require("../packages/domain/dist/constraint-check.js");
const { judgeRowValue } = require("../packages/domain/dist/value-check.js");
const { middleColumns, TABLES } = require("../packages/contract/dist/index.js");
const { evaluateGates } = require("../packages/domain/dist/output-gates.js");

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const dbArg = argv.indexOf("--db");
const dbPath =
  dbArg > -1 ? argv[dbArg + 1] : join(homedir(), "Library/Application Support/@scene/desktop/data/scene.db");

if (!existsSync(dbPath)) {
  console.error(`库不存在：${dbPath}`);
  process.exit(1);
}

/* 备份必须**成功之后**才允许删：用 VACUUM INTO（同步、且带上 WAL 里未落盘的内容）。
   早先用 `db.backup()`（异步）没 await，连接先关掉、备份失败，脚本却继续删了数据——
   这类"备份失败还照删"的路径不能留。 */
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const backupPath = join(dirname(dbPath), `scene.db.bak-${stamp}`);
if (apply) {
  if (existsSync(backupPath)) {
    console.error(`备份文件已存在，拒绝覆盖：${backupPath}`);
    process.exit(1);
  }
  const src = new Database(dbPath);
  try {
    src.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  } catch (err) {
    console.error(`备份失败，已中止（未删任何数据）：${err instanceof Error ? err.message : String(err)}`);
    src.close();
    process.exit(1);
  }
  src.close();
  console.log(`已备份：${backupPath}\n`);
}

const db = new Database(dbPath);
const defs = new Map((Array.isArray(TABLES) ? TABLES : Object.values(TABLES)).map((t) => [t.code, t]));
const rows = db.prepare("SELECT id, table_code, row FROM stage_data").all();

/* 派生行（合计/总分/综合赢面）由门限判定：它们不是发现，删掉不影响任何结论——
   合计由门限核对，不需要单独占一行 */
const derivedIds = new Set(
  evaluateGates(
    rows.map((r) => ({ id: r.id, scenarioId: r.scenario_id, tableCode: r.table_code, row: JSON.parse(r.row) })),
  )
    .filter((f) => f.kind === "no-aggregate-row")
    .map((f) => f.rowId),
);

const doomed = [];
for (const r of rows) {
  const def = defs.get(r.table_code);
  if (!def) continue;
  const o = JSON.parse(r.row);
  if (derivedIds.has(r.id)) {
    doomed.push({ id: r.id, table: r.table_code, label: String(Object.values(o)[0] ?? ""), why: "派生行（合计/总分）：不是发现，合计由门限核对" });
    continue;
  }
  if (r.table_code === "表2-5") {
    const c = judgeConstraint(o);
    if (!c.isConstraint) {
      doomed.push({ id: r.id, table: r.table_code, label: String(o.constraint_item ?? ""), why: c.failures.join("；") });
      continue;
    }
  }
  const v = judgeRowValue(middleColumns(def).map((c) => o[c.key]));
  if (!v.hasValue) doomed.push({ id: r.id, table: r.table_code, label: String(o[row[c.key] ?? "item"] ?? "（整行）"), why: v.reason ?? "" });
}

console.log(`库：${dbPath}`);
console.log(`总行数 ${rows.length}，待清理 ${doomed.length} 行\n`);
for (const d of doomed) console.log(`- [${d.table}] ${d.label.slice(0, 34)}\n    ${d.why}`);

if (!doomed.length) {
  console.log("\n没有需要清理的行。");
  db.close();
  process.exit(0);
}
if (!apply) {
  console.log("\n（dry-run，未删。确认后加 --apply 执行）");
  db.close();
  process.exit(0);
}

const del = db.prepare("DELETE FROM stage_data WHERE id = ?");
const tx = db.transaction((items) => {
  for (const d of items) del.run(d.id);
});
tx(doomed);

const left = db.prepare("SELECT COUNT(*) c FROM stage_data").get().c;
const integrity = db.pragma("integrity_check")[0]?.integrity_check ?? "unknown";
console.log(`\n已删除 ${doomed.length} 行；剩余 ${left} 行；完整性检查：${integrity}`);
db.close();
