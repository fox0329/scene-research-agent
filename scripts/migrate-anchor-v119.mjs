#!/usr/bin/env node
/**
 * 表1-1 场景概述「12 项填空 → 6 项业务画像」存量迁移（v1.19）
 *
 * 背景（用户定调 2026-09-26）：
 *   "用户只负责输入场景名称，智能体只负责从业务角度说清楚场景的范围"
 *   "拍板者、使用者、付费者这些信息都应该是用户提供的吗？用户什么都知道还要我们干什么？"
 *
 * 于是表1-1 从「12 项逐项让用户填」收敛成「6 项业务画像」：
 *   场景名称（用户输入） / 场景边界 / 生产对象 / 核心生产系统 / 买方类型 / 采购特征
 * 「拍板者 / 使用者 / 付费者」搬到表3-3「购买路径与采购机制」（那里本来就是按客户类型逐行查的地方）。
 *
 * 存量库里那些旧项现在**既不渲染、也不参与完整度检查**，属于躺在库里的脏数据——
 * 本脚本把它们按下面的映射搬走，并把搬不动的列出来交给人判断。
 *
 * 安全设计（与 `migrate-info-model.mjs` 同规格）：
 *  - **默认只报告**（dry-run 在副本上跑，绝不动原库）；`--apply` 才写库并自动备份
 *  - **映射不猜**：只做"语义等价且目标为空"的搬运，其余一律列进报告
 *  - 全部改动在事务里；`--apply` 前 `copyFileSync` 备份成 `<db>.bak-<ts>`
 *
 * 用法：
 *   node scripts/migrate-anchor-v119.mjs              # 报告（读 DB_PATH 或 data/scene-master.db）
 *   node scripts/migrate-anchor-v119.mjs --apply      # 执行（自动备份）
 *   DB_PATH=/tmp/x.db node scripts/migrate-anchor-v119.mjs
 */

import { copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// 复用项目自己的数据层（better-sqlite3 是 @scene/infra 的依赖，从根目录解析不到）
import { createDb } from "../packages/infra/dist/index.js";
import { snapshotDb } from "./lib/sqlite-snapshot.mjs";
import { TABLES_BY_CODE } from "../packages/contract/dist/tables.js";

const dbPath = process.env.DB_PATH ?? "data/scene-master.db";
const apply = process.argv.includes("--apply");

const ANCHOR = "表1-1";
const NEW_ANCHOR_ITEMS = (TABLES_BY_CODE[ANCHOR]?.fixedRows ?? []).map((r) => r.label);

/** 旧项 → 新项（表1-1 内部同义搬运；目标已有内容时不覆盖） */
const ANCHOR_SAME_TABLE = {
  "覆盖什么": "场景边界",
  客户类型: "买方类型",
  "客户类型/行业": "买方类型",
  客户行业: "买方类型",
};

/** 旧项 → 表3-3 列（拍板者/使用者/付费者的新家） */
const TO_TABLE_3_3 = {
  拍板者: "decision_maker",
  决策人: "decision_maker",
  使用者: "user_role",
  使用方: "user_role",
  付费者: "payer",
  付款方: "payer",
};

/** 旧项 → brief.intent（用户诉求，本来就是"想搞清楚什么"） */
const TO_BRIEF_INTENT = ["核心用途", "场景用途"];

/** 旧项 → 表3-2 的 our_entry（我方切入点，只在目标行为空时补） */
const TO_TABLE_3_2_ENTRY = ["切入点", "切入环节"];

/**
 * 搬不动的旧项 → 去处说明（**不自动迁移**，列进报告）
 *
 * 判断依据：目标表的行粒度与它不一致，一对一塞进去就是造假数据。
 */
const NOT_MIGRATED = {
  "核心业务流程":
    "表1-2「场景环节地图」是按环节多行的表，一条描述无法摊成「行」——请在第 2 步重跑分析补齐",
  价值主张:
    "表6-1「价值与指标」是按「一项收益/指标」多行的表，需要基线/指标/怎么测才能成行——请在第 5 步补",
  明确不含什么:
    "内容会**并入「场景边界」**（写成「；不含 X」）；如需单列「不做什么」，请在第 5 步的边界声明里给出",
};

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
    tmpCopy = join(tmpdir(), `scene-anchor-dry-${Date.now()}.db`);
    snapshotDb(workPath, tmpCopy); // 一致快照：只拷主文件会漏掉 WAL 里未落盘的写入
    workPath = tmpCopy;
  }

  const instance = createDb(workPath);
  const db = instance.db;

  const allAnchor = db
    .prepare(
      "SELECT id, scenario_id, row FROM stage_data WHERE table_code = ? ORDER BY scenario_id, id",
    )
    .all(ANCHOR);

  /** scenario_id → { item → row } */
  const byScenario = new Map();
  for (const r of allAnchor) {
    const parsed = JSON.parse(r.row);
    const item = String(parsed.item ?? "").trim();
    if (!item) continue;
    if (!byScenario.has(r.scenario_id)) byScenario.set(r.scenario_id, []);
    byScenario.get(r.scenario_id).push({ id: r.id, item, content: String(parsed.content ?? "") });
  }

  const plan = [];
  const leftovers = [];

  for (const [scenarioId, rows] of byScenario) {
    const get = (item) => rows.find((r) => r.item === item);
    const stale = rows.filter((r) => !NEW_ANCHOR_ITEMS.includes(r.item));
    if (stale.length === 0) continue;

    const moves = [];
    for (const old of stale) {
      const target = ANCHOR_SAME_TABLE[old.item];
      if (!target) continue;
      const existing = get(target);
      if (existing && existing.content.trim() !== "") continue; // 目标已有内容，不覆盖
      if (old.content.trim() === "") continue;
      moves.push({ kind: "锚内改名", from: old.item, to: target, id: existing?.id ?? old.id });
    }

    // 「明确不含什么」并入「场景边界」
    const scopeOut = stale.find((r) => r.item === "明确不含什么");
    const boundaryOld = stale.find((r) => r.item === "覆盖什么");
    const boundaryExisting = get("场景边界");
    if (scopeOut && scopeOut.content.trim() !== "") {
      const base =
        boundaryExisting?.content.trim() || boundaryOld?.content.trim() || "";
      // 旧内容常常自己就带"不含/不包含"前缀，先剥掉再拼，免得出"；不含 不含二次供水"
      const bare = scopeOut.content.trim().replace(/^(明确)?不(包含|包括|含|做|涉及)\s*/, "").trim();
      const sep = /^[A-Za-z0-9]/.test(bare) ? " " : "";
      const merged = base ? `${base}；不含${sep}${bare}` : `不含${sep}${bare}`;
      moves.push({
        kind: "并入边界",
        from: "明确不含什么",
        to: "场景边界",
        id: boundaryExisting?.id ?? boundaryOld?.id ?? scopeOut.id,
        content: merged,
      });
    }

    // 拍板者/使用者/付费者 → 表3-3
    const roles = {};
    for (const old of stale) {
      const col = TO_TABLE_3_3[old.item];
      if (col && old.content.trim() !== "") roles[col] = old.content.trim();
    }

    const briefIntent = stale.filter(
      (r) => TO_BRIEF_INTENT.includes(r.item) && r.content.trim() !== "",
    );
    const entryPoint = stale.filter(
      (r) => TO_TABLE_3_2_ENTRY.includes(r.item) && r.content.trim() !== "",
    );

    plan.push({ scenarioId, moves, roles, briefIntent, entryPoint, stale });

    const empty = stale.filter((x) => x.content.trim() === "").length;
    if (empty > 0) plan.push; // 占位，统计在下面汇总
    for (const s of stale) {
      if (s.content.trim() === "") continue; // 空行直接删，不算"需人工判断"
      if (ANCHOR_SAME_TABLE[s.item] || s.item === "明确不含什么") continue;
      if (TO_TABLE_3_3[s.item]) continue;
      if (TO_BRIEF_INTENT.includes(s.item)) continue;
      if (TO_TABLE_3_2_ENTRY.includes(s.item)) continue;
      leftovers.push({ scenarioId, item: s.item, content: s.content, reason: NOT_MIGRATED[s.item] });
    }
  }

  const staleAll = plan.reduce((n, p) => n + p.stale.length, 0);
  const emptyRows = plan.reduce(
    (n, p) => n + p.stale.filter((x) => x.content.trim() === "").length,
    0,
  );
  console.log("=== 统计 ===");
  console.log(`含旧项的场次数        ${plan.length}（旧项行合计 ${staleAll} 行）`);
  console.log(`锚内改名 / 并入边界   ${plan.reduce((n, p) => n + p.moves.length, 0)}`);
  console.log(`→ 表3-3 角色字段      ${plan.reduce((n, p) => n + Object.keys(p.roles).length, 0)}`);
  console.log(`→ 场景诉求(意图)      ${plan.reduce((n, p) => n + p.briefIntent.length, 0)}`);
  console.log(`→ 表3-2 我方切入点    ${plan.reduce((n, p) => n + p.entryPoint.length, 0)}`);
  console.log(`空行清理（直接删）    ${emptyRows}`);
  console.log(`有内容但需人工判断    ${leftovers.length}`);
  console.log("\n注：表1-1 新增的「生产对象 / 核心生产系统 / 采购特征」3 行不在此脚本写入——");
  console.log("    应用会在第 1 步读到表1-1 时按注册表自动补齐骨架（空内容，等智能体写）。");

  console.log("\n=== 迁移计划 ===");
  for (const p of plan) {
    console.log(`  场景 ${p.scenarioId.slice(0, 8)}  旧项 ${p.stale.length} 个`);
    for (const m of p.moves) {
      console.log(`    · ${m.from} → ${m.to}${m.content ? `（含"不含"合并）` : ""}`);
    }
    if (Object.keys(p.roles).length > 0) {
      console.log(`    · 角色 → 表3-3：${Object.keys(p.roles).join(" / ")}`);
    }
    if (p.briefIntent.length > 0) console.log("    · 意图 → 场景诉求");
    if (p.entryPoint.length > 0) console.log("    · 切入点 → 表3-2 我方切入点");
    console.log("    · 其余旧项行删除（内容见下方「需人工判断」清单）");
  }

  if (leftovers.length > 0) {
    console.log("\n=== 需人工判断（脚本不猜）===");
    for (const l of leftovers) {
      console.log(`  场景 ${l.scenarioId.slice(0, 8)}  旧项「${l.item}」= ${l.content.slice(0, 60)}`);
      console.log(`     去处：${l.reason}`);
    }
  }

  if (plan.length === 0) {
    console.log("\n✅ 无需迁移：所有场次的表1-1 都已是新 6 项口径");
  }

  if (!apply) {
    console.log("\n（dry-run 结束，未写库；副本已删除）");
    db.close();
    if (tmpCopy) rmSync(tmpCopy, { force: true });
    return;
  }

  const now = new Date().toISOString();
  const backup = `${dbPath}.bak-${Date.now()}`;
  snapshotDb(dbPath, backup); // 备份也走快照，否则备份里少最新数据
  console.log(`\n已备份数据库：${backup}`);

  const tx = db.transaction(() => {
    for (const p of plan) {
      // ① 锚内改名 / 并入边界
      const upd = db.prepare("UPDATE stage_data SET row = ? WHERE id = ?");
      for (const m of p.moves) {
        const current = db.prepare("SELECT row FROM stage_data WHERE id = ?").get(m.id);
        const parsed = JSON.parse(current.row);
        const content =
          m.content ?? p.stale.find((s) => s.item === m.from)?.content ?? parsed.content;
        upd.run(
          JSON.stringify({
            ...parsed,
            item: m.to,
            content,
            source: "表1-1 迁移",
            source_type: "用户补充",
          }),
          m.id,
        );
      }

      // ② 拍板者/使用者/付费者 → 表3-3（有行就补空列，没有就新建一行）
      if (Object.keys(p.roles).length > 0) {
        const found = db
          .prepare(
            "SELECT id, row FROM stage_data WHERE scenario_id = ? AND table_code = '表3-3' LIMIT 1",
          )
          .get(p.scenarioId);
        const anchorBuyer =
          p.stale.find((s) => s.item === "买方类型" || s.item === "客户类型/行业")?.content ?? "";
        if (found) {
          const parsed = JSON.parse(found.row);
          const next = { ...parsed };
          for (const [k, v] of Object.entries(p.roles)) {
            if (!String(next[k] ?? "").trim()) next[k] = v;
          }
          next.source = next.source || "表1-1 迁移";
          db.prepare("UPDATE stage_data SET row = ? WHERE id = ?").run(
            JSON.stringify(next),
            found.id,
          );
        } else {
          db.prepare(
            "INSERT INTO stage_data (id, scenario_id, stage, table_code, row, source_type, created_at, updated_at) VALUES (?, ?, 2, '表3-3', ?, '用户补充', ?, ?)",
          ).run(
            `mig-${p.scenarioId.slice(0, 8)}-${Date.now().toString(36)}`,
            p.scenarioId,
            JSON.stringify({
              customer_type: anchorBuyer || "（待补：客户类型）",
              ...p.roles,
              default_choice: "",
              budget_item: "",
              source: "表1-1 迁移",
            }),
            now,
            now,
          );
        }
      }

      // ③ 核心用途 → 场景诉求（只补空缺）
      const intentRow = p.briefIntent[0];
      if (intentRow) {
        const brief = db
          .prepare("SELECT scenario_id, intent FROM scenario_brief WHERE scenario_id = ?")
          .get(p.scenarioId);
        if (brief) {
          if (!String(brief.intent ?? "").trim()) {
            db.prepare("UPDATE scenario_brief SET intent = ?, updated_at = ? WHERE scenario_id = ?").run(
              intentRow.content,
              now,
              p.scenarioId,
            );
          }
        } else {
          // scenario_brief 的主键就是 scenario_id；raw_text/scene_name 都是 NOT NULL
          const name =
            db.prepare("SELECT name FROM scenario WHERE id = ?").get(p.scenarioId)?.name ?? "";
          db.prepare(
            "INSERT INTO scenario_brief (scenario_id, scene_name, intent, raw_text, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)",
          ).run(p.scenarioId, name, intentRow.content, now, now);
        }
      }

      // ④ 切入点 → 表3-2 第一行的 our_entry（只补空缺）
      const entryRow = p.entryPoint[0];
      if (entryRow) {
        const t32 = db
          .prepare(
            "SELECT id, row FROM stage_data WHERE scenario_id = ? AND table_code = '表3-2' ORDER BY id",
          )
          .all(p.scenarioId);
        for (const r of t32) {
          const parsed = JSON.parse(r.row);
          if (String(parsed.our_entry ?? "").trim()) continue;
          parsed.our_entry = entryRow.content;
          db.prepare("UPDATE stage_data SET row = ? WHERE id = ?").run(JSON.stringify(parsed), r.id);
          break;
        }
      }

      // ⑤ 删除表1-1 里已不在新表定义中的旧项行
      const del = db.prepare("DELETE FROM stage_data WHERE id = ?");
      const movedIds = new Set(p.moves.map((m) => m.id));
      for (const s of p.stale) {
        if (movedIds.has(s.id)) continue;
        del.run(s.id);
      }

      // ⑥ 补齐注册表里还缺的行（空内容，等智能体写）——让库里口径与表定义一致，
      //    不依赖"用户下次打开第 1 步时应用自愈"
      const present = new Set(
        db
          .prepare("SELECT row FROM stage_data WHERE scenario_id = ? AND table_code = ?")
          .all(p.scenarioId, ANCHOR)
          .map((r) => JSON.parse(r.row).item),
      );
      for (const [i, label] of NEW_ANCHOR_ITEMS.entries()) {
        if (present.has(label)) continue;
        db.prepare(
          "INSERT INTO stage_data (id, scenario_id, stage, table_code, row, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?)",
        ).run(
          `mig-anchor-${p.scenarioId.slice(0, 8)}-${i}-${Date.now().toString(36)}`,
          p.scenarioId,
          ANCHOR,
          JSON.stringify({ item: label, content: "" }),
          now,
          now,
        );
      }
    }
  });
  tx();
  db.close();
  console.log(`✅ 已迁移 ${plan.length} 个场次的表1-1（需人工判断的 ${leftovers.length} 项见上方清单）`);
}

main();
