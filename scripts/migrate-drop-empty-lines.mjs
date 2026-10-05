#!/usr/bin/env node
/**
 * 迁移：清掉空的产品资料线（E2E / 验收脚本跑出来的残留）
 * 依据：变更表 #98（用户定调 2026-10-04：「清掉空的测试产品线」）
 *
 * 为什么会有这些线：v1.10 起「每个场景自动带一条专属资料库，删场景时资料保留」，
 * 于是 E2E 与验收脚本建的场景删掉后，专属库留下来成了空线——实测 29 条里 26 条是这样。
 *
 * **可删的判定（全自动、可复核）**：一条线的 `product_line_id` 在**任何**表里都没有引用
 *   ① 无资产（product / capability / boundary / limitation / optional_material）
 *   ② 无场景引用（scenario.product_line_id、scenario_linked_line 通用库引用）
 *   ③ 除标准费率骨架外无自有数据（骨架是系统给的占位，随线一起删）
 * 判定不写死表名清单：动态扫库中所有带 `product_line_id` 的表，将来新增表也不会漏。
 *
 * 用法：
 *   node scripts/migrate-drop-empty-lines.mjs            # 预演：列出会删哪几条、为什么留哪几条
 *   node scripts/migrate-drop-empty-lines.mjs --apply    # 先快照再删
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

/** 除费率骨架外的所有带 product_line_id 的表（骨架随线删，不计入"有数据"） */
const tables = db
  .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'")
  .all()
  .map((r) => r.name)
  .filter((t) => t !== "cost_rate")
  .filter((t) => db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === "product_line_id"));

/** 一条线在各表里的引用数 */
function refCounts(lineId) {
  const out = {};
  for (const t of tables) {
    out[t] = db.prepare(`select count(*) n from ${t} where product_line_id = ?`).get(lineId).n;
  }
  return out;
}

const lines = db.prepare("select id, name from product_line order by created_at asc").all();
const droppable = [];
const kept = [];
for (const line of lines) {
  const refs = refCounts(line.id);
  const busy = Object.entries(refs).filter(([, n]) => n > 0);
  const rates = db.prepare("select count(*) n from cost_rate where product_line_id = ?").get(line.id).n;
  if (busy.length === 0) droppable.push({ ...line, rates });
  else kept.push({ ...line, busy, rates });
}

console.log(`库：${DB_PATH}`);
console.log(`产品线 ${lines.length} 条｜可删 ${droppable.length} 条｜保留 ${kept.length} 条`);
console.log("\n保留（有引用，删了会断链）：");
for (const k of kept) {
  console.log(`  · ${k.name}｜${k.busy.map(([t, n]) => `${t} ${n}`).join("、")}｜费率 ${k.rates}`);
}
console.log("\n可删（无任何引用）：");
for (const d of droppable) console.log(`  · ${d.name}（含费率骨架 ${d.rates} 行）`);

if (!APPLY) {
  console.log("\n预演结束（加 --apply 执行：先快照，再删线及其费率骨架）");
  db.close();
  process.exit(0);
}
db.close();

const snap = join(
  dirname(DB_PATH),
  `${basename(DB_PATH)}.snap-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
snapshotDb(DB_PATH, snap);
console.log(`\n快照：${snap}`);

const write = new Database(DB_PATH);
write.transaction(() => {
  for (const d of droppable) {
    write.prepare("delete from cost_rate where product_line_id = ?").run(d.id);
    write.prepare("delete from product_line where id = ?").run(d.id);
  }
})();
const left = write.prepare("select count(*) n from product_line").get().n;
write.close();
console.log(`已删 ${droppable.length} 条空线，现存产品线 ${left} 条`);
