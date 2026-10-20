/**
 * 阶段 2 收成 5 张表的一次性数据迁移（变更表 #237）
 *
 * 做的事：3-2 leader→players 并补 price_band、3-3 payer+budget_item→budget、
 * 3-8 按字符重合度吸收 3-7 的坑（avoid_in_design→acceptance），删 3-4/3-7/3-9 的行。
 * 跑之前必须先 `VACUUM INTO` 备份（脚本不改库存外的任何东西，也不自动备份）。
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const D = require("better-sqlite3");
const dbPath = process.env.HOME + "/Library/Application Support/@scene/desktop/data/scene.db";
const db = new D(dbPath);
const count = (code) => db.prepare("SELECT COUNT(*) c FROM stage_data WHERE table_code=?").get(code).c;
const before = {};
for (const c of ["表3-1","表3-2","表3-3","表3-4","表3-5","表3-7","表3-8","表3-9"]) before[c] = count(c);

const rows = db.prepare("SELECT id, scenario_id, table_code, row FROM stage_data WHERE table_code LIKE '表3-%'").all();
const byTable = {};
for (const r of rows) (byTable[r.table_code] ??= []).push({ ...r, o: JSON.parse(r.row) });

function bigrams(s) {
  const t = String(s ?? "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function overlap(a, b) {
  const A = bigrams(a), B = bigrams(b);
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / Math.max(1, Math.min(A.size, B.size));
}
function normPosition(v) {
  if (["扩张","稳定","收缩"].includes(v)) return v;
  return v === "主导" ? "扩张" : "未知";
}
function normProcurement(v) {
  const s = String(v ?? "");
  for (const k of ["单一来源","竞争性磋商","框架协议","集采目录","直接采购","邀请招标","公开招标"]) if (s.includes(k)) return k;
  return "未知";
}

const update = db.prepare("UPDATE stage_data SET row=?, updated_at=? WHERE id=?");
const now = () => new Date().toISOString();

const tx = db.transaction(() => {
  for (const r of byTable["表3-2"] ?? []) {
    const o = { ...r.o };
    if (!o.players) o.players = o.leader ?? "";
    if (!o.price_band) {
      const m = String(o.fit_for ?? "").match(/预算([^，。；]{2,20})/);
      o.price_band = m ? `未获取（适用条件写「预算${m[1]}」，缺成交价样本）` : "未获取（缺该类项目的成交价样本）";
    }
    o.position = normPosition(o.position);
    delete o.leader;
    delete o.our_entry;
    update.run(JSON.stringify(o), now(), r.id);
  }

  for (const r of byTable["表3-3"] ?? []) {
    const o = { ...r.o };
    if (!o.budget) o.budget = `${o.payer ?? "未提及"}｜${o.budget_item ?? "未提及"}`;
    o.procurement_method = normProcurement(o.procurement_method);
    delete o.payer;
    delete o.budget_item;
    update.run(JSON.stringify(o), now(), r.id);
  }

  const used = new Set();
  for (const r of byTable["表3-8"] ?? []) {
    const o = { ...r.o };
    const pits = (byTable["表3-7"] ?? []).filter((p) => p.scenario_id === r.scenario_id && !used.has(p.id));
    let best = null, bestScore = 0;
    for (const p of pits) {
      const score = overlap(o.gap, p.o.pitfall);
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (best && bestScore >= 0.1) {
      used.add(best.id);
      const p = best.o;
      o.acceptance ??= String(p.avoid_in_design ?? "").slice(0, 60);
      o.symptom ??= p.symptom;
      o.root_cause ??= p.root_cause;
      o.consequence ??= p.consequence;
    }
    if (!o.acceptance) o.acceptance = "待补：客户验收口径（这条缺口签约时用哪句话验）";
    update.run(JSON.stringify(o), now(), r.id);
  }

  return db.prepare("DELETE FROM stage_data WHERE table_code IN ('表3-4','表3-7','表3-9')").run().changes;
});

const changed = tx();
const after = {};
for (const c of ["表3-1","表3-2","表3-3","表3-5","表3-8"]) after[c] = count(c);
console.log("迁移前:", before);
console.log("删除行数:", changed);
console.log("迁移后:", after, "剩余3-4/3-7/3-9:", ["表3-4","表3-7","表3-9"].map(count).join(","));
