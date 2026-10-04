#!/usr/bin/env node
/**
 * 表3-7「失败反模式 → 同行踩过的坑」存量迁移（v1.29）
 *
 * 背景（用户 2026-10-04 验收阶段 2）：
 *   「理解商业里面的失败反模式我认为价值不大，不够直观」
 *   → 表名是研发黑话、列是分析腔（失败原因 / 根因 / 对方案设计的含义）。
 *   改成直观三列：坑（现场会发生什么）/ 后果（钱·工期·安全）/ 我们方案里怎么避（可验收硬指标）。
 *
 * 为什么需要这个脚本：
 *   表里已经躺着内容（用户库里 2 个场景共 18 行），列键一改，旧内容就**既不渲染也不参与完整度**
 *   ——那等于把用户已有的信息变成看不见的脏数据。本脚本把语义等价的旧值搬进新列。
 *
 * 映射（**只做语义等价且目标为空时的搬运，不猜**）：
 *   failure_reason    → pitfall          （失败原因 就是"坑"）
 *   design_implication→ avoid_in_design  （对方案设计的含义 就是"我们方案里怎么避"）
 *   symptom / root_cause / no / source   → 键名不变，留在右栏（不动）
 *   **consequence（后果）没有对应旧值**：旧口径根本没记后果，留空等第 3 步重跑补齐
 *   ——不拿"失败原因"或"根因"去冒充后果，那是编数据。
 *
 * 安全设计（与 `migrate-anchor-v119.mjs` 同规格）：
 *  - **默认只报告**（dry-run 在副本上跑，绝不动原库）；`--apply` 才写库并自动备份
 *  - 目标列已有内容时不覆盖；全部改动在一个事务里
 *
 * 用法：
 *   node scripts/migrate-table37-pits.mjs            # 报告（读 DB_PATH 或 data/scene-master.db）
 *   node scripts/migrate-table37-pits.mjs --apply    # 执行（自动备份）
 *   DB_PATH=/tmp/x.db node scripts/migrate-table37-pits.mjs
 */

import { copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDb } from "../packages/infra/dist/index.js";
import { snapshotDb } from "./lib/sqlite-snapshot.mjs";

const dbPath = process.env.DB_PATH ?? "data/scene-master.db";
const apply = process.argv.includes("--apply");
const TABLE = "表3-7";

/** 旧键 → 新键（语义等价；目标已有内容时不覆盖） */
const RENAME = {
  failure_reason: "pitfall",
  design_implication: "avoid_in_design",
};

/** 旧口径没有的键：不造假，留空（报告里点名要重跑补齐） */
const NEW_KEYS = ["pitfall", "consequence", "avoid_in_design"];

function main() {
  if (!existsSync(resolve(dbPath))) {
    console.error(`✗ 数据库不存在：${dbPath}`);
    process.exit(1);
  }
  console.log(`数据库：${dbPath}`);
  console.log(`模式：${apply ? "执行迁移（--apply）" : "只报告（dry-run；在副本上跑，绝不动原库）"}\n`);

  let workPath = resolve(dbPath);
  let tmpCopy = null;
  if (!apply) {
    tmpCopy = join(tmpdir(), `scene-table37-dry-${Date.now()}.db`);
    // 必须用一致快照：直接拷主文件会漏掉 WAL 里还没落盘的最近写入
    snapshotDb(workPath, tmpCopy);
    workPath = tmpCopy;
  }

  const instance = createDb(workPath);
  const db = instance.db;

  const rows = db
    .prepare("SELECT id, scenario_id, row, source FROM stage_data WHERE table_code = ? ORDER BY scenario_id, id")
    .all(TABLE);

  const plan = [];
  for (const r of rows) {
    let parsed;
    try {
      parsed = JSON.parse(r.row);
    } catch {
      continue; // 行不是 JSON：不是本脚本的事，跳过（迁移脚本不做数据修复）
    }
    const patch = {};
    for (const [from, to] of Object.entries(RENAME)) {
      const value = String(parsed[from] ?? "").trim();
      if (value === "") continue;
      if (String(parsed[to] ?? "").trim() !== "") continue; // 目标已有内容 → 不动
      patch[to] = value;
    }
    if (Object.keys(patch).length === 0) continue;
    plan.push({ id: r.id, scenarioId: r.scenario_id, patch, before: parsed });
  }

  const missingConsequence = rows.length - rows.filter((r) => {
    try {
      return String(JSON.parse(r.row).consequence ?? "").trim() !== "";
    } catch {
      return false;
    }
  }).length;

  console.log("=== 统计 ===");
  console.log(`表3-7 总行数            ${rows.length}`);
  console.log(`需要搬列的行            ${plan.length}`);
  console.log(`缺「后果」待重跑补齐    ${missingConsequence} 行（旧口径没记后果，脚本不拿别的列冒充）`);

  console.log("\n=== 迁移计划 ===");
  for (const p of plan) {
    console.log(`  场景 ${p.scenarioId.slice(0, 8)}  行 ${p.id.slice(0, 8)}`);
    for (const [k, v] of Object.entries(p.patch)) {
      console.log(`    · ${Object.keys(RENAME).find((x) => RENAME[x] === k)} → ${k}：${String(v).slice(0, 50)}`);
    }
  }

  if (plan.length === 0) {
    console.log("\n✅ 无需迁移：表3-7 各行都已是新列口径（或新列已有内容）");
  }

  if (!apply) {
    console.log("\n（dry-run 结束，未写库；副本已删除）");
    db.close();
    if (tmpCopy) rmSync(tmpCopy, { force: true });
    return;
  }

  const backup = `${dbPath}.bak-${Date.now()}`;
  snapshotDb(dbPath, backup);
  console.log(`\n已备份数据库：${backup}`);

  const tx = db.transaction(() => {
    const upd = db.prepare("UPDATE stage_data SET row = ?, updated_at = ? WHERE id = ?");
    const now = new Date().toISOString();
    for (const p of plan) {
      upd.run(JSON.stringify({ ...p.before, ...p.patch }), now, p.id);
    }
  });
  tx();

  console.log(`✅ 迁移完成：${plan.length} 行已搬列（旧键保留在右栏，未删除）`);
  console.log(`   下一步：重跑第 3 步（阶段 2）让智能体补「后果」列——脚本不做这件事。`);
  db.close();
}

main();
