/**
 * 入库去重工具（一次性维护脚本，可复用）
 *
 * 背景：同一批材料被多次上传（如中断重传）时，同内容会以不同来源名
 * （ingest-<时间戳>-<序号>.<ext>）重复入库。本脚本按文件内容 MD5 配对
 * 副本，每个内容组保留最新一次入库的副本，删除其余副本的行。
 *
 * 删除走 `DELETE /api/v1/library/rows/:code/:id` 接口而非裸 SQL，
 * 以复用行级来源失效（F3）的下游待重算标记逻辑。
 *
 * 用法（仓库根目录）：
 *   node scripts/dedupe-ingest.mjs          # 演练：只打印清理计划
 *   node scripts/dedupe-ingest.mjs --apply  # 执行删除
 *
 * 环境变量：DB_PATH（默认 data/scene-master.db）、SCENE_API（默认 http://localhost:4081/api/v1）
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/infra/package.json", import.meta.url));
const Database = require("better-sqlite3");

const APPLY = process.argv.includes("--apply");
const DB_PATH = process.env.DB_PATH ?? "data/scene-master.db";
const API = process.env.SCENE_API ?? "http://localhost:4081/api/v1";

/** 资料表 → 表编号（O 表按行的 category） */
const TABLES = {
  product: "M1",
  spec_param: "M2",
  capability: "M3",
  boundary: "M4",
  limitation: "M5",
  cost_rate: "M6",
};

/** 来源标注 "文件名:页码" → 临时文件名 */
function tempNameOf(source) {
  const s = String(source);
  const i = s.lastIndexOf(":");
  return i > 0 ? s.slice(0, i) : s;
}

// ── 1. 临时文件按内容哈希分组 ─────────────────────────────
const byHash = new Map();
for (const f of readdirSync(tmpdir()).filter((n) => n.startsWith("ingest-"))) {
  const p = join(tmpdir(), f);
  const md5 = createHash("md5").update(readFileSync(p)).digest("hex");
  const mtime = statSync(p).mtimeMs;
  if (!byHash.has(md5)) byHash.set(md5, []);
  byHash.get(md5).push({ name: f, mtime });
}

// ── 2. 每个来源名名下的行（表 + 行 id + 表编号） ─────────
const rowsBySource = new Map();
const addRow = (temp, row) => {
  if (!rowsBySource.has(temp)) rowsBySource.set(temp, []);
  rowsBySource.get(temp).push(row);
};
{
  const db = new Database(DB_PATH, { readonly: true });
  for (const [table, code] of Object.entries(TABLES)) {
    try {
      for (const r of db.prepare(`SELECT id, source FROM ${table} WHERE source IS NOT NULL`).all()) {
        addRow(tempNameOf(r.source), { code, id: r.id });
      }
    } catch (e) {
      console.error(`（跳过 ${table}：${e.message}）`);
    }
  }
  try {
    for (const r of db
      .prepare("SELECT id, source, category FROM optional_material WHERE source IS NOT NULL")
      .all()) {
      // category 存储形如「O6生态」，表编号取前缀 O1-O6
      const code = String(r.category ?? "").match(/^O[1-6]/)?.[0] ?? "O1";
      addRow(tempNameOf(r.source), { code, id: r.id });
    }
  } catch (e) {
    console.error(`（跳过 optional_material：${e.message}）`);
  }
  db.close();
}

// ── 3. 清理计划：同哈希且≥2 个副本有行 → 留最新 mtime，删其余 ──
const plan = [];
for (const [md5, members] of byHash) {
  const withRows = members.filter((m) => (rowsBySource.get(m.name)?.length ?? 0) > 0);
  if (withRows.length < 2) continue;
  withRows.sort((a, b) => b.mtime - a.mtime);
  const [keep, ...drop] = withRows;
  plan.push({ md5: md5.slice(0, 8), keep, drop });
}

if (plan.length === 0) {
  console.log("没有重复副本，无需清理。");
  process.exit(0);
}

let totalDrop = 0;
for (const g of plan) {
  const keepN = rowsBySource.get(g.keep.name).length;
  console.log(`\n[内容 ${g.md5}] 保留 ${g.keep.name}（${keepN} 行，最新）`);
  for (const d of g.drop) {
    const n = rowsBySource.get(d.name).length;
    totalDrop += n;
    console.log(`  删除 ${d.name}：${n} 行`);
  }
}
console.log(`\n合计计划删除 ${totalDrop} 行（${plan.length} 组重复）。${APPLY ? "" : "（演练，加 --apply 执行）"}`);

// ── 4. 执行：走行删除接口（带 F3 下游待重算标记） ─────────
if (!APPLY) process.exit(0);

let deleted = 0;
let failed = 0;
for (const g of plan) {
  for (const d of g.drop) {
    for (const row of rowsBySource.get(d.name)) {
      try {
        const res = await fetch(`${API}/library/rows/${row.code}/${row.id}`, { method: "DELETE" });
        if (res.ok) deleted++;
        else failed++;
      } catch {
        failed++;
      }
    }
  }
}
console.log(`执行完成：删除 ${deleted} 行${failed ? `，失败 ${failed} 行` : ""}。`);
