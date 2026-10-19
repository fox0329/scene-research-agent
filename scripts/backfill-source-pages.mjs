#!/usr/bin/env node
/**
 * backfill-source-pages — 给存量材料补「页级原文」（变更表 #212 / 故障清单 #80）
 *
 * 背景：`source_fts.content` 存的是业务字段拼接，拿它核「该页确有这句话」
 * 等于自证。修法是入库时把原文按页存进 `source_page`，但**存量材料没有原文**——
 * 不补的话，老库上的核对永远走降级路径（还是自证）。
 *
 * 本脚本做的事：从业务表里收集所有出处 → 拆出文件名 → 在本机找到原件 →
 * 重新解析 → 按页写入 `source_page`。
 *
 * 设计原则：
 *   - **幂等**：同一文件同一页重复写只覆盖，不累积
 *   - **只增不改业务数据**：只写 `source_page`，不碰任何业务表
 *   - **找不到原件要如实报**，不猜、不跳过不说
 *   - 默认 dry-run，加 `--write` 才落库；落库前自动备份 DB
 *
 * 用法：
 *   node scripts/backfill-source-pages.mjs                 # 只看会做什么
 *   node scripts/backfill-source-pages.mjs --write         # 真落库（先备份）
 *   node scripts/backfill-source-pages.mjs --write --db <路径>
 *   node scripts/backfill-source-pages.mjs --write --root ~/Downloads --root 推广/素材/demo资料
 */

import { createRequire } from "node:module";
import { readFileSync, existsSync, statSync, copyFileSync, readdirSync } from "node:fs";
import { basename, join, extname, resolve } from "node:path";
import { homedir } from "node:os";

const require = createRequire(import.meta.url);
const Database = require("../node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/lib/index.js");

// ─── 参数 ────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DB_PATH =
  argOf("--db") ??
  join(homedir(), "Library/Application Support/@scene/desktop/data/scene.db");

/** 默认搜索根：项目 demo 素材 + 用户常见下载/文档目录 */
const DEFAULT_ROOTS = [
  resolve(process.cwd(), "推广/素材/demo资料"),
  resolve(process.cwd(), "推广/素材"),
  join(homedir(), "Downloads"),
  join(homedir(), "Documents"),
  join(homedir(), "Desktop"),
];
const ROOTS = argv.reduce((acc, a, i) => {
  if (a === "--root" && argv[i + 1]) acc.push(resolve(argv[i + 1]));
  return acc;
}, [...DEFAULT_ROOTS]);

/** 只处理这些格式（parseDocument 支持的） */
const SUPPORTED = new Set([".pdf", ".docx", ".xlsx", ".pptx"]);

// ─── 工具 ────────────────────────────────────────────────────

const say = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);

/** 从出处串拆出文件名（与 packages/infra 的 splitFileRef 同规则） */
function fileNameOf(source) {
  const r = String(source ?? "").trim();
  if (!r || /^[a-z][a-z0-9+.-]*:\/\//i.test(r)) return null;
  const byExt = /^(.+?\.(?:pdf|docx|xlsx|pptx|md|markdown|txt|csv|html?|json))\s*[:：]([^]*)$/i.exec(r);
  if (byExt) return byExt[1].trim();
  return r;
}

/**
 * 在搜索根里递归找同名文件
 *
 * 限制深度与跳过 node_modules：用户目录可能很大，深搜会卡很久。
 */
function findFile(fileName, maxDepth = 4) {
  for (const root of ROOTS) {
    if (!existsSync(root)) continue;
    const hit = walk(root, fileName, 0, maxDepth);
    if (hit) return hit;
  }
  return null;
}

function walk(dir, target, depth, maxDepth) {
  if (depth > maxDepth) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null; // 无权限的目录直接跳过
  }
  // 先看当前层文件，再下钻目录（同层命中更快）
  for (const e of entries) {
    if (e.isFile() && e.name === target) return join(dir, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const hit = walk(join(dir, e.name), target, depth + 1, maxDepth);
    if (hit) return hit;
  }
  return null;
}

/** 收集业务表里所有出处 */
function collectSources(db) {
  const tables = [
    "product",
    "spec_param",
    "capability",
    "boundary",
    "limitation",
    "optional_material",
  ];
  const out = new Set();
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    if (!cols.includes("source")) continue;
    for (const r of db
      .prepare(`SELECT DISTINCT source FROM ${t} WHERE source IS NOT NULL AND source != ''`)
      .all()) {
      const s = String(r.source).trim();
      if (s) out.add(s);
    }
  }
  return [...out];
}

/** 备份 DB（连同 -wal/-shm，否则备份可能是旧快照） */
function backupDb(dbPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${dbPath}.backup-${stamp}`;
  copyFileSync(dbPath, dest);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, dest + suffix);
  }
  return dest;
}

// ─── 主流程 ──────────────────────────────────────────────────

async function main() {
  if (!existsSync(DB_PATH)) {
    warn(`找不到数据库：${DB_PATH}`);
    warn("用 --db <路径> 指定，或先启动一次应用让它建库。");
    process.exitCode = 1;
    return;
  }

  const { parseDocument } = await import("../packages/infra/dist/doc-parser.js");
  const { upsertSourcePages } = await import("../packages/infra/dist/source-index.js");

  let db;
  if (WRITE) {
    const backup = backupDb(DB_PATH);
    say(`已备份数据库 → ${basename(backup)}\n`);
    db = new Database(DB_PATH);
    // 老库没有 source_page 表：跑一遍建库 SQL 补齐
    //
    // 直接执行 001_init.sql（全部 `CREATE ... IF NOT EXISTS`，幂等），
    // 而不是调内部 `runMigrations`（未导出，脚本不该依赖私有实现）。
    const sqlPath = resolve(process.cwd(), "packages/infra/dist/sql/001_init.sql");
    if (!existsSync(sqlPath)) {
      warn(`找不到建库 SQL：${sqlPath}（先跑 pnpm --filter @scene/infra build）`);
      process.exitCode = 1;
      return;
    }
    db.exec(readFileSync(sqlPath, "utf8"));
  } else {
    db = new Database(DB_PATH, { readonly: true });
  }

  say(`数据库：${DB_PATH}`);
  say(`模式：${WRITE ? "写入" : "只读预演（加 --write 才落库）"}\n`);

  const sources = collectSources(db);
  const byFile = new Map();
  for (const s of sources) {
    const f = fileNameOf(s);
    if (!f) continue;
    byFile.set(f, (byFile.get(f) ?? 0) + 1);
  }

  say(`业务表出处 ${sources.length} 条，涉及材料 ${byFile.size} 个\n`);

  const skipped = [];
  const missing = [];
  const done = [];

  for (const [file, count] of byFile) {
    if (!SUPPORTED.has(extname(file).toLowerCase())) {
      skipped.push({ file, count, why: "格式不支持解析（非 pdf/docx/xlsx/pptx）" });
      continue;
    }
    const path = findFile(file);
    if (!path) {
      missing.push({ file, count, why: "本机找不到同名原件" });
      continue;
    }
    try {
      const parsed = await parseDocument(path);
      const pages = parsed.pages ?? [];
      if (pages.length === 0) {
        skipped.push({ file, count, why: "解析成功但没有逐页文本" });
        continue;
      }
      const written = WRITE ? upsertSourcePages(db, file, pages) : pages.filter((p) => String(p.text ?? "").trim() !== "").length;
      done.push({ file, count, pages: pages.length, written, path });
      say(`  ✓ ${file}`);
      say(`      ${pages.length} 页，${WRITE ? `写入 ${written} 页` : `将写入 ${written} 页`}  ← ${path}`);
    } catch (e) {
      skipped.push({ file, count, why: `解析失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  // ── 汇总 ──
  say("\n" + "─".repeat(60));
  say(`可回填：${done.length} 个文件`);
  if (missing.length) {
    say(`\n找不到原件：${missing.length} 个（这些材料的核对仍走降级路径）`);
    for (const m of missing) say(`  ✗ ${m.file}（${m.count} 条出处）— ${m.why}`);
    say("  提示：把原件放到 推广/素材/demo资料 或任一 --root 目录后重跑。");
  }
  if (skipped.length) {
    say(`\n跳过：${skipped.length} 个`);
    for (const s of skipped) say(`  - ${s.file}（${s.count} 条）— ${s.why}`);
  }

  if (WRITE) {
    const total = db.prepare("SELECT COUNT(*) c FROM source_page").get().c;
    say(`\nsource_page 现有 ${total} 页原文。`);
  } else {
    say("\n这是预演。确认无误后加 --write 落库（会自动备份）。");
  }
  db.close();
}

main().catch((e) => {
  warn(e);
  process.exitCode = 1;
});
