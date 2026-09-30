#!/usr/bin/env node
/**
 * 存量库信息模型迁移（v2.0）
 *
 * 背景：v2.0 把表定义收敛到 `packages/contract/src/tables.ts`（34 张表、8 阶段口径），
 * 与旧 00b 表集相比有合并/改名/换阶段。存量库里的旧表号与旧阶段号在新代码下
 * **不可渲染、也不被完整度检查看到**，因此需要迁移。
 *
 * 安全设计：
 *  - **默认只报告**（dry-run），不写库；`--apply` 才真正执行
 *  - 无法无损映射的行**不猜**，列出来待人工处理（宁可留给人，也不要错误合并）
 *  - 迁移在事务里执行；`--apply` 前自动备份数据库文件
 *
 * 用法：
 *   node scripts/migrate-info-model.mjs                 # 报告（读 DB_PATH 或 data/scene-master.db）
 *   node scripts/migrate-info-model.mjs --apply         # 执行（自动备份）
 *   DB_PATH=/tmp/x.db node scripts/migrate-info-model.mjs
 */

import { copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// 复用项目自己的数据层（better-sqlite3 是 @scene/infra 的依赖，从根目录解析不到）
import { createDb } from "../packages/infra/dist/index.js";
import { TABLES_BY_CODE, tablesOfStage } from "../packages/contract/dist/tables.js";

const dbPath = process.env.DB_PATH ?? "data/scene-master.db";
const apply = process.argv.includes("--apply");

/** 旧表号 → 新表号（只列可无损映射的） */
const CODE_MAP = {
  // 阶段 0：可选材料 6 张并入 1 张（按类别区分）
  O1: "可选材料",
  O2: "可选材料",
  O3: "可选材料",
  O4: "可选材料",
  O5: "可选材料",
  O6: "可选材料",
  // 阶段 1：认证差距/处置策略并入门槛表
  "表1-4": "表1-3",
  "表1-5": "表1-3",
  // 阶段 1：不能碰的环节 + 场景地图 → 场景环节地图
  "表2-8": "表1-2",
  "表2-1": "表2-3",
  // 阶段 2 合并项
  "表2-6": "表2-5",
  "表3-5": "表3-4",
  "表3-10": "表3-8",
  // 阶段 3
  "表4-2": "表3-8",
  // 阶段 4
  "表5-2": "表2-5",
  "表5-6": "表3-6",
  // 阶段 5
  "表6-2": "表6-1",
  "表6-3": null, // 计算卡片，不是表
  "表6-5": "表6-4",
  "表6-6": "表6-4",
  // 阶段 6
  "表7-2": "表7-1",
  "表7-3": "表7-1",
  // 阶段 7/8
  "表8-内部": "表7-交付内部",
  "表8-对外": "表7-交付对外",
};

/** 旧阶段号 → 新阶段号（旧 7 总结沉淀 → 新 6；旧 8 交付物 → 新 7） */
const STAGE_MAP = { 0: 0, 1: 1, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7 };

/** 新表集下每个表号归属的阶段（用于校验迁移后一致性） */
function stageOf(code) {
  for (const s of [0, 1, 2, 3, 4, 5, 6, 7]) {
    if (tablesOfStage(s).some((t) => t.code === code)) return s;
  }
  return null;
}

function main() {
  if (!existsSync(resolve(dbPath))) {
    console.error(`✗ 数据库不存在：${dbPath}`);
    process.exit(1);
  }
  console.log(`数据库：${dbPath}`);
  console.log(`模式：${apply ? "执行迁移（--apply）" : "只报告（dry-run；在副本上跑，绝不动原库）"}\n`);

  // dry-run 在副本上执行：既不动原库，又能顺带验证迁移语句
  let workPath = resolve(dbPath);
  let tmpCopy = null;
  if (!apply) {
    tmpCopy = join(tmpdir(), `scene-migrate-dry-${Date.now()}.db`);
    copyFileSync(workPath, tmpCopy);
    workPath = tmpCopy;
  }

  const instance = createDb(workPath); // 幂等迁移：确保 scenario_brief / stage_summary 等新表存在
  const db = instance.db;
  const rows = db.prepare("SELECT id, scenario_id, stage, table_code FROM stage_data").all();

  const stats = {
    known: 0,
    remap: 0,
    stageOnly: 0,
    unmappable: 0,
    alreadyNew: 0,
  };
  const unmappable = [];
  const plan = [];

  for (const r of rows) {
    const inNewSet = Boolean(TABLES_BY_CODE[r.table_code]);
    const mapped = Object.prototype.hasOwnProperty.call(CODE_MAP, r.table_code)
      ? CODE_MAP[r.table_code]
      : undefined;
    const targetStage = STAGE_MAP[r.stage];
    const stageChanged = targetStage !== undefined && targetStage !== r.stage;

    if (inNewSet) {
      stats.alreadyNew += 1;
      if (stageChanged) {
        stats.stageOnly += 1;
        plan.push({ id: r.id, code: r.table_code, from: r.stage, to: targetStage, kind: "仅阶段" });
      }
      continue;
    }
    if (mapped === null) {
      stats.unmappable += 1;
      unmappable.push({ ...r, reason: "该项在新模型中是计算卡片，不是表（应删除并改由计算得到）" });
      continue;
    }
    if (typeof mapped === "string" && TABLES_BY_CODE[mapped]) {
      stats.remap += 1;
      const to = stageOf(mapped) ?? targetStage ?? r.stage;
      plan.push({ id: r.id, code: `${r.table_code} → ${mapped}`, from: r.stage, to, kind: "表号+阶段" });
      continue;
    }
    stats.unmappable += 1;
    unmappable.push({ ...r, reason: "没有可无损映射的新表（需人工判断归属或丢弃）" });
  }

  console.log("=== 统计 ===");
  console.log(`总行数            ${rows.length}`);
  console.log(`已是新表号        ${stats.alreadyNew}${stats.stageOnly ? `（其中 ${stats.stageOnly} 行需改阶段号）` : ""}`);
  console.log(`可映射（表号/阶段）${stats.remap}`);
  console.log(`不可映射          ${stats.unmappable}`);
  console.log(`新表集内          ${stats.known}`);

  if (plan.length > 0) {
    console.log("\n=== 迁移计划（前 20 条）===");
    for (const p of plan.slice(0, 20)) {
      console.log(`  ${p.id.slice(0, 8)}  ${p.code}  阶段 ${p.from} → ${p.to}  [${p.kind}]`);
    }
    if (plan.length > 20) console.log(`  … 其余 ${plan.length - 20} 条`);
  }

  if (unmappable.length > 0) {
    console.log("\n=== 不可映射（需人工处理，脚本不猜）===");
    for (const u of unmappable.slice(0, 20)) {
      console.log(`  ${u.id.slice(0, 8)}  表号 ${u.table_code} 阶段 ${u.stage} 场景 ${u.scenario_id.slice(0, 8)}`);
      console.log(`     原因：${u.reason}`);
    }
    if (unmappable.length > 20) console.log(`  … 其余 ${unmappable.length - 20} 条`);
  }

  if (!apply) {
    console.log("\n（dry-run 结束，未写库；副本已删除）");
    db.close();
    if (tmpCopy) rmSync(tmpCopy, { force: true });
    return;
  }

  const backup = `${dbPath}.bak-${Date.now()}`;
  copyFileSync(dbPath, backup);
  console.log(`\n已备份数据库：${backup}`);

  const wdb = db;
  const tx = wdb.transaction((items) => {
    const upd = wdb.prepare("UPDATE stage_data SET table_code = ?, stage = ? WHERE id = ?");
    for (const it of items) {
      const code = it.code.includes("→") ? it.code.split("→")[1].trim() : it.code;
      upd.run(code, it.to, it.id);
    }
  });
  tx(plan);
  wdb.close();
  console.log(`✅ 已迁移 ${plan.length} 行（不可映射行保持原样，见上方清单）`);
}

main();
