#!/usr/bin/env node
/**
 * 迁移：产品资料库整理 —— 去重 + M6 内部费率骨架
 * 依据：变更表 #97（用户定调 2026-10-04：「重复的内容能不能合并？」「内部费率就算是空表
 *       也得有，不能让用户自己建表」）
 *
 * 做两件事（都在一个事务里，先快照）：
 *   1. 每个产品线：同型号产品行合并（保留在售/更早的一条，规格与缺位字段并过去）+
 *      同产品内重复规格删除（完全相同留一条；一个值包含另一个的留更完整的）
 *   2. 每个一条费率都没有的产品线：播种 14 行标准骨架（rate/工时 0、来源标「待确认」）
 *
 * 判定逻辑不在本脚本里重写——直接调服务端构建产物 `dedupeLibrary` / `seedRateSkeleton`，
 * 与接口按钮、ingest 写入路径共用同一套计划（口径不会漂移）。
 *
 * 用法：
 *   node scripts/migrate-library-cleanup.mjs            # 预演，只报告不写
 *   node scripts/migrate-library-cleanup.mjs --apply    # 先快照再写
 *   DB_PATH=/path/to.db node scripts/migrate-library-cleanup.mjs --apply
 *
 * 注意：一个库同一时刻只能有一个写者——**先停掉应用**（46172）再跑 --apply。
 */
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { snapshotDb } from "./lib/sqlite-snapshot.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DB_PATH = process.env.DB_PATH ?? join(ROOT, "data", "scene-master.db");
const APPLY = process.argv.includes("--apply");

const require = createRequire(join(ROOT, "packages", "infra", "package.json"));
const Database = require("better-sqlite3");

// 服务端构建产物（其自身 import 会从 apps/server/dist 起解析 @scene/*，无需额外 paths）
const { dedupeLibrary, seedRateSkeleton } = await import(
  pathToFileURL(join(ROOT, "apps", "server", "dist", "library-service.js")).href
);
const { createDb } = await import(
  pathToFileURL(join(ROOT, "packages", "infra", "dist", "index.js")).href
);

// 预演用只读连接先看现状（--apply 时由 createDb 走正式迁移）
const peek = new Database(DB_PATH, { readonly: true });
const lineCount = peek.prepare("select count(*) as n from product_line").get().n;
const rateRows = peek.prepare("select count(*) as n from cost_rate").get().n;
const dupGroups = peek
  .prepare(
    `select count(*) as n from (
       select product_line_id, upper(replace(replace(model, ' ', ''), char(12288), '')) as k
       from product group by product_line_id, k having count(*) > 1)`,
  )
  .get().n;
peek.close();
console.log(`库：${DB_PATH}`);
console.log(`产品线 ${lineCount} 条｜费率行 ${rateRows} 条｜同型号重复组 ${dupGroups} 组`);
if (!APPLY) {
  console.log("预演：将 ① 逐个产品线去重（产品行 + 规格行）② 无费率的产品线播种标准骨架（加 --apply 执行）");
  process.exit(0);
}

const snap = join(dirname(DB_PATH), `${basename(DB_PATH)}.snap-${new Date().toISOString().replace(/[:.]/g, "-")}`);
snapshotDb(DB_PATH, snap);
console.log(`快照：${snap}`);

const db = createDb(DB_PATH);
let removedProducts = 0;
let removedSpecs = 0;
let seeded = 0;
const lines = db.productLineRepo.list();
db.db.transaction(() => {
  for (const line of lines) {
    const r = dedupeLibrary(db, line.id);
    removedProducts += r.productsRemoved;
    removedSpecs += r.specsRemoved;
    seeded += seedRateSkeleton(db, line.id);
  }
})();
console.log(`已整理：删掉产品行 ${removedProducts} 条｜删掉重复规格 ${removedSpecs} 条｜播种费率骨架 ${seeded} 行`);
console.log(
  `现在：产品 ${db.productRepo.list().length} 条｜规格 ${db.specParamRepo.list().length} 条｜费率 ${db.costRateRepo.list().length} 条`,
);
db.db.close();
