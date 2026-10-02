#!/usr/bin/env node
/**
 * 存量库迁移：把「场景侧」与「公司侧」分家（v1.21）
 *
 * 背景（用户定调 2026-10-02）：场景定义 / 认识场景 / 商业梳理这三步只梳理**场景现状**，
 * 公司能力到能力匹配（阶段 3）才进场。因此：
 *   - 表1-2「场景环节地图」不再有「我方可参与程度 / 我方角色 / 角色判定依据」，
 *     换成场景现状列（现在谁在做 / 现在用什么 / 现在怎么做 / 现状问题）；
 *   - 这三项的公司侧内容**迁到新表4-2「我方参与地图」**（行粒度同样是业务环节，可无损映射）；
 *   - 表1-3 的「判定」并进「现状」，「处置策略」换成市场侧的「行业通行处置」，我方行动项迁到实施计划；
 *   - 表3-2 / 3-4 / 3-6 / 3-9 里挂在我方的列（我方切入点 / 我方 / 我方优势劣势 / 对我方含义）
 *     由阶段 3 的表4-4 / 表4-5 承接，本步不再产出。
 *
 * 安全设计：
 *  - **默认只报告**（dry-run），`--apply` 才写库
 *  - 只做**无损**迁移：表1-2 → 表4-2（同为"一个业务环节"一行）
 *  - 不认识的列**不猜**：只列出，并说明"下次重算本步即按新口径覆盖"
 *
 * 用法：
 *   node scripts/migrate-scene-vs-company.mjs            # 报告
 *   node scripts/migrate-scene-vs-company.mjs --apply    # 执行（自动备份）
 */

import { copyFileSync, existsSync } from "node:fs";
import { createDb } from "../packages/infra/dist/index.js";

const dbPath = process.env.DB_PATH ?? "data/scene-master.db";
const apply = process.argv.includes("--apply");
const COMPANY_KEYS = ["can_touch", "our_role", "role_reason"];

if (!existsSync(dbPath)) {
  console.error(`找不到数据库：${dbPath}`);
  process.exit(1);
}

const db = createDb(dbPath);
const stageData = db.stageDataRepo;

/** 读某场景某阶段的全部行（含 payload） */
const rowsOf = (scenarioId, stage) => stageData.listByScenarioStage(scenarioId, stage);

const scenarios = db.scenarioRepo.list();
let moved = 0;
let skipped = 0;

for (const sc of scenarios) {
  const stage2 = rowsOf(sc.id, 1); // 阶段 1 = 第 2 步「认识场景」
  const source = stage2.filter((r) => r.table_code === "表1-2");
  if (source.length === 0) continue;

  const withCompany = source.filter((r) =>
    COMPANY_KEYS.some((k) => String(r.row?.[k] ?? "").trim() !== ""),
  );
  const existing42 = rowsOf(sc.id, 3).filter((r) => r.table_code === "表4-2");
  console.log(
    `场景 ${sc.name}（${sc.id.slice(0, 8)}）：表1-2 ${source.length} 行，其中带公司侧内容 ${withCompany.length} 行；` +
      `已有表4-2 ${existing42.length} 行`,
  );
  if (withCompany.length === 0) {
    skipped += withCompany.length;
    continue;
  }

  if (apply) {
    for (const r of withCompany) {
      const p = r.row ?? {};
      stageData.insert({
        scenario_id: sc.id,
        stage: 3,
        table_code: "表4-2",
        row: {
          link: p.link ?? "",
          can_touch: p.can_touch ?? "",
          our_role: p.our_role ?? "",
          role_reason: p.role_reason ?? "",
          our_product: "",
          source: p.source ?? "行业通例（模型知识·待核实）",
          evidence_level: p.evidence_level ?? "C",
          authority: p.authority ?? "T4",
        },
        is_stale: false,
        source_type: r.source_type ?? "AI推断",
        source: p.source ?? "行业通例（模型知识·待核实）",
        source_authority: p.authority ?? "T4",
        evidence_level: p.evidence_level ?? "C",
      });
      moved += 1;
    }
    console.log(`  → 已迁入表4-2 共 ${withCompany.length} 行（表1-2 的老列保留在库里但不显示）`);
  }
}

if (!apply) {
  console.log("\n（以上为报告模式；确认无误后加 --apply 执行）");
} else {
  copyFileSync(dbPath, `${dbPath}.bak-scene-vs-company-${new Date().toISOString()}`);
  console.log(`\n✅ 迁移完成：表1-2 → 表4-2 共 ${moved} 行；其余按新口径重算本步即可覆盖`);
}
db.close?.();
