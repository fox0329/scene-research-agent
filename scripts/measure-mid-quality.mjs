#!/usr/bin/env node
/**
 * 中栏质量测量（v1.32 起）
 *
 * 为什么有这个脚本：用户对中栏的定调是「**要说价值，说结果**」（G-R9），
 * 这是可以量化的——一个格子里的**引用痕迹**和**字数**都能数出来。
 * 改口径前后用同一把尺子量，避免"感觉好点了"这种自述。
 *
 * 判据与自检同源（`packages/domain` 的 `hasMidCitation` / `MID_CELL_MAX_CHARS`），
 * 不另写一套正则——否则量的是另一回事。
 *
 * 用法：
 *   node scripts/measure-mid-quality.mjs                  # 全部场景
 *   node scripts/measure-mid-quality.mjs 智慧会议室        # 按场景名（模糊匹配）
 *   node scripts/measure-mid-quality.mjs <scenarioId>
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "package.json"));

const { TABLES_BY_CODE, middleColumns } = require(
  path.join(ROOT, "packages/contract/dist/tables.js"),
);
const { hasMidCitation, MID_CELL_MAX_CHARS } = require(
  path.join(ROOT, "packages/domain/dist/postcheck.js"),
);

const DB = process.env.DB_PATH ?? path.join(ROOT, "data/scene-master.db");
const needle = process.argv[2] ?? "";

const infraRequire = createRequire(path.join(ROOT, "packages/infra/package.json"));
const Database = infraRequire("better-sqlite3");
const db = new Database(DB, { readonly: true });

const scenarios = db
  .prepare("select id, name, current_stage from scenario order by name")
  .all()
  .filter((s) => needle === "" || s.name.includes(needle) || s.id === needle);

if (scenarios.length === 0) {
  console.error(`没有匹配的场景：${needle || "(全部)"}`);
  process.exit(1);
}

let grand = { cells: 0, cited: 0, long: 0 };
for (const sc of scenarios) {
  console.log(`\n══ 场景：${sc.name}（阶段 ${sc.current_stage}）`);
  const rows = db
    .prepare("select table_code, row from stage_data where scenario_id = ?")
    .all(sc.id);
  const byTable = new Map();
  for (const r of rows) {
    const list = byTable.get(r.table_code) ?? [];
    list.push(JSON.parse(r.row));
    byTable.set(r.table_code, list);
  }
  let tot = { cells: 0, cited: 0, long: 0 };
  for (const [code, list] of [...byTable.entries()].sort()) {
    const def = TABLES_BY_CODE[code];
    if (!def) continue;
    const keys = middleColumns(def).map((c) => c.key);
    let cells = 0;
    let cited = 0;
    let long = 0;
    for (const row of list) {
      for (const k of keys) {
        const v = row[k];
        if (typeof v !== "string" || v.trim() === "") continue;
        cells++;
        if (hasMidCitation(v)) cited++;
        if (v.trim().length > MID_CELL_MAX_CHARS) long++;
      }
    }
    tot.cells += cells;
    tot.cited += cited;
    tot.long += long;
    const pct = (n) => (cells === 0 ? "—" : `${Math.round((n / cells) * 100)}%`);
    console.log(
      `  ${code} ${def.name}：${list.length} 行｜中栏格 ${cells}｜夹带出处 ${cited}（${pct(cited)}）｜超 ${MID_CELL_MAX_CHARS} 字 ${long}（${pct(long)}）`,
    );
  }
  const pct = (n) => (tot.cells === 0 ? "—" : `${Math.round((n / tot.cells) * 100)}%`);
  console.log(
    `  ── 合计：中栏格 ${tot.cells}｜夹带出处 ${tot.cited}（${pct(tot.cited)}）｜超 ${MID_CELL_MAX_CHARS} 字 ${tot.long}（${pct(tot.long)}）`,
  );
  grand = {
    cells: grand.cells + tot.cells,
    cited: grand.cited + tot.cited,
    long: grand.long + tot.long,
  };
}
if (scenarios.length > 1) {
  const pct = (n) => (grand.cells === 0 ? "—" : `${Math.round((n / grand.cells) * 100)}%`);
  console.log(
    `\n══ 全部场景合计：中栏格 ${grand.cells}｜夹带出处 ${grand.cited}（${pct(grand.cited)}）｜超 ${MID_CELL_MAX_CHARS} 字 ${grand.long}（${pct(grand.long)}）`,
  );
}
db.close();
