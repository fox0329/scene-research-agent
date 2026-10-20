#!/usr/bin/env node
/**
 * 体检：库里已有的行还值不值得留（只读，默认不删）
 *
 * 用户定调 2026-10-20：「同时要确认表格内容是否真有价值，进入表格的内容要确认价值」。
 * 新生成的内容已由自检拦截（postcheck 的「约束不成立」「行无价值」），
 * 本脚本只用来**看清历史数据里有多少行不达标**，删不删由人决定。
 *
 * 用法：
 *   node scripts/check-table-value.mjs                 # 体检真实库（只读）
 *   node scripts/check-table-value.mjs --db <路径>     # 体检指定库
 */
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
/* pnpm 把依赖装在 .pnpm 下、根 node_modules 里没有扁平副本，所以按目录找一次（不写死版本号） */
const { readdirSync } = await import("node:fs");
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

const argDb = process.argv.indexOf("--db");
const dbPath =
  argDb > -1
    ? process.argv[argDb + 1]
    : join(homedir(), "Library/Application Support/@scene/desktop/data/scene.db");

const db = new Database(dbPath, { readonly: true });
const defs = new Map((Array.isArray(TABLES) ? TABLES : Object.values(TABLES)).map((t) => [t.code, t]));
const rows = db.prepare("SELECT table_code, row FROM stage_data").all();

const weak = [];
for (const r of rows) {
  const def = defs.get(r.table_code);
  if (!def) continue;
  const o = JSON.parse(r.row);
  if (r.table_code === "表2-5") {
    const c = judgeConstraint(o);
    if (!c.isConstraint) {
      weak.push({ table: r.table_code, label: String(o.constraint_item ?? "").slice(0, 30), why: c.failures.join("；"), to: c.suggestTable ?? "" });
      continue;
    }
  }
  const v = judgeRowValue(middleColumns(def).map((c) => o[c.key]));
  if (!v.hasValue) weak.push({ table: r.table_code, label: "（整行）", why: v.reason ?? "", to: "" });
}

console.log(`库：${dbPath}`);
console.log(`总行数 ${rows.length}，不达标 ${weak.length} 行\n`);
for (const w of weak) console.log(`- [${w.table}] ${w.label}\n    ${w.why}${w.to ? `\n    去向：${w.to}` : ""}`);
console.log("\n（只读体检，不会删数据；要删请人工确认后再处理）");
