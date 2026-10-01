#!/usr/bin/env node
/**
 * 表1-1（场景概述）存量正文清洗
 *
 * 背景：用户投诉「整个页面大量的无效信息」——真实数据里表1-1 的正文混着三类噪音：
 *  ① **元说明注解**：如"（用户未明说，按行业通行情况推断）""（对话中由助手按行业通行情况推断…）"
 *     —— 谁说的应该由 `source_type`/`source` 字段表达，不该写进正文
 *  ② **旧推断残留**：`source_type = AI推断` 的行（用户从未说过），新规则只收"用户说过的"
 *  ③ **超长段落**：单格 88–115 字的枚举段落，定义表要的是"一眼看懂的一句话"
 *
 * 安全设计（沿用 migrate-info-model 的约定）：
 *  - **默认只报告**（dry-run），不写库；`--apply` 才真正执行
 *  - `--apply` 前自动备份数据库文件
 *  - 只动 `表1-1`，只做"去噪"，不改写用户自己写的判断（用户确认/用户补充的内容保留）
 *
 * 用法：
 *   node scripts/clean-anchor-notes.mjs              # 报告（读 DB_PATH 或 data/scene-master.db）
 *   node scripts/clean-anchor-notes.mjs --apply      # 执行（自动备份）
 */

import { copyFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createDb } from "../packages/infra/dist/index.js";
import {
  compressCell,
  stripMetaNotes,
  DEFINITION_CELL_MAX_CHARS,
} from "../apps/server/dist/scenario-definition.js";
import { readAnchorRows, writeAnchorRows, syncDerivedDescription } from "../apps/server/dist/scenario-anchor.js";

const require = createRequire(import.meta.url);

const dbPath = process.env.DB_PATH ?? "data/scene-master.db";
const apply = process.argv.includes("--apply");
const ANCHOR = "表1-1";

if (!existsSync(dbPath)) {
  console.error(`数据库不存在：${dbPath}`);
  process.exit(1);
}

/** 备份（--apply 前） */
if (apply) {
  const backup = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(dbPath, backup);
  console.log(`已备份：${backup}\n`);
}

const db = createDb(dbPath);
const scenarios = db.scenarioRepo.list();

let touchedScenarios = 0;
let notesStripped = 0;
let staleCleared = 0;
let compressed = 0;

for (const scenario of scenarios) {
  const rows = readAnchorRows(db, scenario.id);
  if (rows.length === 0) continue;

  // **列残留检测**：行 JSON 里的 source_type 可能已被清成 null，但 stage_data.source_type
  // 列还留着旧值（"空内容 + AI推断"自相矛盾）。这类必须一并写一次把它清掉。
  const columnStale = db.stageDataRepo
    .list({ where: "scenario_id = ? AND table_code = ?", params: [scenario.id, ANCHOR] })
    .filter(
      (r) =>
        String(r.row?.["content"] ?? "").trim() === "" &&
        (r.source_type ?? null) !== null,
    );

  const notes = [];
  const cleared = [];
  const long = [];
  const next = rows.map((row) => {
    const item = String(row.item ?? "");
    const content = String(row.content ?? "");
    if (!item) return row;
    if (row.source_type === "AI推断") {
      cleared.push({ item, content });
      return { item, content: "" };
    }
    const denoised = stripMetaNotes(content);
    if (denoised !== content) notes.push({ item, before: content, after: denoised });
    const compact = compressCell(denoised);
    if (compact !== denoised) long.push({ item, before: denoised.length, after: compact.length });
    return { ...row, item, content: compact };
  });

  if (notes.length === 0 && cleared.length === 0 && long.length === 0 && columnStale.length === 0) continue;
  touchedScenarios++;
  console.log(`══ ${scenario.name}（${scenario.id.slice(0, 8)}）`);
  for (const n of notes) {
    console.log(`  · 剥元说明 [${n.item}]`);
    console.log(`      旧：${n.before}`);
    console.log(`      新：${n.after}`);
  }
  for (const c of cleared) {
    console.log(`  · 清旧推断 [${c.item}]：${c.content.slice(0, 60)}${c.content.length > 60 ? "…" : ""}`);
  }
  for (const l of long) console.log(`  · 压缩超长 [${l.item}]：${l.before} → ${l.after} 字`);
  console.log();

  for (const r of columnStale) {
    console.log(`  · 清空来源列 [${String(r.row?.["item"] ?? "?")}]：内容已空但列仍标 ${r.source_type}`);
  }
  notesStripped += notes.length;
  staleCleared += cleared.length;
  compressed += long.length;

  if (apply) {
    writeAnchorRows(db, scenario.id, next);
    syncDerivedDescription(db, scenario.id);
  }
}

console.log("─".repeat(60));
console.log(
  `涉及场景 ${touchedScenarios} 个 · 剥元说明 ${notesStripped} 处 · 清旧推断 ${staleCleared} 处 · 压缩超长 ${compressed} 处`,
);
console.log(
  apply
    ? "✅ 已写入（表1-1 与派生的场景描述已更新）"
    : `（dry-run：未写库。确认无误后执行：node scripts/clean-anchor-notes.mjs --apply）`,
);
if (typeof require !== "function") void require; // 保持依赖声明一致（预留）
