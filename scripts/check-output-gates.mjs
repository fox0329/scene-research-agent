#!/usr/bin/env node
/**
 * 体检：按每张表的「输出门限」核一遍库里已有的行（只读）
 *
 * 用户定调 2026-10-20：「明确每个表格的生成要求，输出检查门限，一定要确保输出内容的价值。
 * 没价值的内容删除」。生成后自检已接同一套门限（postcheck 的「不达门限」），
 * 本脚本用来**看清历史数据**：哪张表、哪一行、哪条门限没过、为什么。
 *
 * 用法：
 *   node scripts/check-output-gates.mjs            # 全库体检
 *   node scripts/check-output-gates.mjs --db <路径>
 *   node scripts/check-output-gates.mjs --table 表2-2
 */
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const pnpmDir = join(process.cwd(), "node_modules", ".pnpm");
const bsq = readdirSync(pnpmDir).find((d) => d.startsWith("better-sqlite3@"));
const Database = require(join(pnpmDir, bsq, "node_modules", "better-sqlite3"));
const { evaluateGates } = require("../packages/domain/dist/output-gates.js");

const argv = process.argv.slice(2);
const dbArg = argv.indexOf("--db");
const dbPath =
  dbArg > -1 ? argv[dbArg + 1] : join(homedir(), "Library/Application Support/@scene/desktop/data/scene.db");
const onlyTable = argv.indexOf("--table") > -1 ? argv[argv.indexOf("--table") + 1] : null;

const db = new Database(dbPath, { readonly: true });
const rows = db
  .prepare("SELECT id, scenario_id, table_code, row FROM stage_data")
  .all()
  .map((r) => ({ id: r.id, scenarioId: r.scenario_id, tableCode: r.table_code, row: JSON.parse(r.row) }));

const findings = evaluateGates(rows).filter((f) => !onlyTable || f.tableCode === onlyTable);
const byTable = {};
for (const f of findings) byTable[f.tableCode] = (byTable[f.tableCode] ?? 0) + 1;

console.log(`库：${dbPath}`);
console.log(`总行数 ${rows.length}，不达门限 ${findings.length} 条`);
console.log(`按表：${Object.entries(byTable).map(([t, n]) => `${t} ${n}`).join(" / ") || "无"}\n`);
for (const f of findings) {
  console.log(`- [${f.tableCode}] ${String(f.label).slice(0, 30)}\n    ${f.gate}\n    ${f.detail}`);
}
console.log("\n（只读体检，不删数据；要删先人工确认）");
