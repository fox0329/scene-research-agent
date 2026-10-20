/**
 * output-gates 测试 ——「每张表都有门限，且门限判得对」
 *
 * 用户定调（2026-10-20）：「明确每个表格的生成要求，输出检查门限，一定要确保输出内容的价值。
 * 没价值的内容删除」。用例尽量取自真实库，避免为了测试好看而编数据。
 */

import { describe, expect, it } from "vitest";
import { TABLES, middleColumns, tableDef } from "@scene/contract";
import { TABLE_GATES, gatesOf } from "@scene/contract";
import { evaluateGates, type GateRow } from "./output-gates.js";

const tableCodes = TABLES.map((t) => t.code);

describe("门限登记完整性（契约层）", () => {
  it("28 张表每张都有门限，不许漏", () => {
    const missing = tableCodes.filter((code) => gatesOf(code).length === 0);
    expect(missing).toEqual([]);
  });

  it("门限引用的列都真实存在（key 打错会让门限永远静默通过）", () => {
    const bad: string[] = [];
    for (const [code, gates] of Object.entries(TABLE_GATES)) {
      const def = tableDef(code);
      /* 一张表可能装多种 payload（可选材料 O1–O6），payload 里的列也算真实列 */
      const keys = new Set([
        ...def.columns.map((c) => c.key),
        ...Object.values(def.payloads ?? {}).flatMap((cols) => cols.map((c) => c.key)),
      ]);
      for (const g of gates) {
        const cols: string[] =
          "columns" in g ? [...g.columns] : "column" in g ? [g.column] : [];
        if ("when" in g && g.when) cols.push(g.when.column);
        /* where.column 属于源表，在「跨表引用的目标列」用例里校验 */
        if (g.kind === "cross-coverage") cols.push(...g.targetColumns);
        if (g.kind === "absence-hint") cols.push(g.column);
        for (const c of cols) if (!keys.has(c)) bad.push(`${code}.${c}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("跨表引用的目标列也真实存在", () => {
    const bad: string[] = [];
    for (const [code, gates] of Object.entries(TABLE_GATES)) {
      for (const g of gates) {
        if (g.kind === "cross-ref") {
          const target = tableDef(g.table);
          if (!target.columns.some((c) => c.key === g.target)) bad.push(`${code}→${g.table}.${g.target}`);
        }
        if (g.kind === "cross-coverage" || g.kind === "cross-sum") {
          const target = tableDef(g.table);
          const col = g.kind === "cross-coverage" ? g.sourceColumn : g.sourceColumn;
          if (!target.columns.some((c) => c.key === col)) bad.push(`${code}→${g.table}.${col}`);
          if (g.where && !target.columns.some((c) => c.key === g.where!.column)) {
            bad.push(`${code}→${g.table}.${g.where.column}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("每条门限都有一句人话（要进提示词与文档）", () => {
    for (const gates of Object.values(TABLE_GATES)) {
      for (const g of gates) expect(g.text.length).toBeGreaterThan(4);
    }
  });
});

describe("evaluateGates — 真实缺陷能被点名", () => {
  const row = (tableCode: string, fields: Record<string, unknown>, id = "r1"): GateRow => ({
    id,
    tableCode,
    row: fields,
  });

  it("表2-2 供应商写「行业主流厂商」→ 不达标", () => {
    const f = evaluateGates([
      row("表2-2", {
        element_name: "工业网关",
        element_type: "硬件",
        function: "协议转换与数据上传",
        vendor: "行业主流厂商",
        price_range: "单台千元级至万元级",
      }),
    ]);
    expect(f.some((x) => x.gate.includes("供应商"))).toBe(true);
  });

  it("表2-2 供应商具名（华铸精机、德控自动化）→ 达标", () => {
    const f = evaluateGates([
      row("表2-2", {
        element_name: "压铸机",
        element_type: "硬件",
        function: "压铸成型",
        vendor: "华铸精机、德控自动化、MoxaLink",
        price_range: "单台百万元级至千万元级",
      }),
    ]);
    expect(f).toEqual([]);
  });

  it("表4-1 同一能力在同一场景重复登记 → 点名", () => {
    const f = evaluateGates([
      { ...row("表4-1", { ability: "多协议设备接入", maturity: "已交付" }, "a"), scenarioId: "s1" },
      { ...row("表4-1", { ability: "多协议设备接入", maturity: "已交付" }, "b"), scenarioId: "s1" },
    ]);
    expect(f.filter((x) => x.gate.includes("重复登记")).length).toBe(2);
  });

  it("表3-1 两条「器件（…）」是不同环节，不算重复（去重看整格原文）", () => {
    const f = evaluateGates([
      row("表3-1", { link: "器件（在线仪表与传感器）", gross_margin: "40%–60%（测算）", representative: "聚光科技、力合科技" }),
      row("表3-1", { link: "器件（PLC/DCS 控制器）", gross_margin: "30%–45%（测算）", representative: "西门子、施耐德" }),
    ]);
    expect(f.filter((x) => x.gate.includes("环节不许重复"))).toEqual([]);
  });

  it("不同场景复用同一能力不算重复（跨场景去重会误杀）", () => {
    const f = evaluateGates([
      { ...row("表4-1", { ability: "多协议设备接入", maturity: "已交付" }, "a"), scenarioId: "s1" },
      { ...row("表4-1", { ability: "多协议设备接入", maturity: "已交付" }, "b"), scenarioId: "s2" },
    ]);
    expect(f).toEqual([]);
  });

  it("表4-4 首打顺序重复 → 点名（不再有权重伪精度）", () => {
    const f = evaluateGates([
      row("表4-4", { sub_scene: "整机厂联网", value_density: "高", opponent: "海康", win_loss: "强", entry_action: "先做 2 条线试点", rank: 1 }),
      row("表4-4", { sub_scene: "园区多厂", value_density: "中", opponent: "客户现状（自建）", win_loss: "平", entry_action: "联合投标 1 次", rank: 1 }),
    ]);
    expect(f.some((x) => x.gate.includes("首打顺序不许重复"))).toBe(true);
  });

  it("表4-4 写了「综合赢面（加权总分）」派生行 → 点名", () => {
    const f = evaluateGates([
      row("表4-4", { sub_scene: "整机厂联网", value_density: "高", opponent: "海康", win_loss: "强", entry_action: "先做 2 条线试点", rank: 1 }),
      row("表4-4", { sub_scene: "综合赢面（加权总分）", value_density: "高", opponent: "海康", win_loss: "强", entry_action: "加权计算 1 次", rank: 2 }),
    ]);
    expect(f.some((x) => x.detail.includes("派生值"))).toBe(true);
  });

  it("表2-4 关系两端须是表2-2 的要素（对不上就点名）", () => {
    const f = evaluateGates([
      { ...row("表2-2", { element_name: "工业网关", element_type: "硬件", function: "采集", vendor: "德控自动化", price_range: "千元级" }), scenarioId: "s1" },
      { ...row("表2-4", { interaction_type: "数据采集", from_to: "压铸机 → 不存在的东西", method: "OPC UA" }, "m1"), scenarioId: "s1" },
    ]);
    expect(f.some((x) => x.gate.includes("关系两端"))).toBe(true);
  });

  it("表3-8 验收条件写「注意风险」→ 点名；写进合同条款 → 达标", () => {
    const bad = evaluateGates([row("表3-8", { rank: "1", gap: "老机协议不开放", who_hurts: "设备工程师", pain_level: "高", current_alternative: "人工抄表", acceptance: "注意风险" })]);
    expect(bad.some((x) => x.detail.includes("空话"))).toBe(true);
    const ok = evaluateGates([
      row("表3-8", {
        rank: "1",
        gap: "老机协议不开放，OEE 靠人工抄表",
        who_hurts: "设备工程师",
        pain_level: "高",
        current_alternative: "人工抄表",
        acceptance: "合同写明进场首周完成全厂点表核对并双方签字",
        consequence: "取不到数，返工 3 人月、延期 2 周",
      }),
    ]);
    expect(ok).toEqual([]);
  });

  it("整行占位词 → 硬伤「行必须有实质内容」", () => {
    const f = evaluateGates([row("表5-4", { item: "交付", content: "未提供", sla: "待补" })]);
    expect(f.some((x) => x.severity === "硬伤")).toBe(true);
  });

});

describe("跨表门限（2026-10-20 用户定调「所有的输出都应该有门限卡住」）", () => {
  const row = (tableCode: string, id: string, fields: Record<string, unknown>): GateRow => ({
    id,
    tableCode,
    row: fields,
    scenarioId: "s1",
  });
  const hit = (findings: { gate: string }[], needle: string): number =>
    findings.filter((f) => f.gate.includes(needle)).length;

  it("表5-1 漏掉「高价值」细分会被点名", () => {
    const rows: GateRow[] = [
      row("表4-4", "a", { sub_scene: "曝气系统溶解氧按需调节与曝气能耗优化", value_density: "高", opponent: "未知（无竞品情报）", win_loss: "未知", entry_action: "先做试点", rank: "1" }),
      row("表5-1", "b", { layer: "平台层", components: "设备管理平台", interface: "OPC UA", integration: "南向采集", boundary: "不做施工总包" }),
    ];
    const f = evaluateGates(rows);
    expect(hit(f, "方案里必须有对应层")).toBe(1);
  });

  it("方案里覆盖到该细分时不点名（中文标签允许括注与修饰）", () => {
    const rows: GateRow[] = [
      row("表4-4", "a", { sub_scene: "曝气系统溶解氧按需调节与曝气能耗优化", value_density: "高", opponent: "未知（无竞品情报）", win_loss: "未知", entry_action: "先做试点", rank: "1" }),
      row("表5-1", "b", { layer: "控制层", components: "曝气系统变频与溶解氧闭环", interface: "OPC UA", integration: "南向采集", boundary: "不做施工总包" }),
    ];
    expect(hit(evaluateGates(rows), "方案里必须有对应层")).toBe(0);
  });

  it("表5-3 人天少写一半会被点名（两套账）", () => {
    const rows: GateRow[] = [
      row("表4-3", "g1", { gap_ref: "缺口甲", match: "需补齐", our_product: "YS-EC3200", action: "补算法，估算 60–90 人天" }),
      row("表4-3", "g2", { gap_ref: "缺口乙", match: "真能解", our_product: "YS-GW2100", action: "旁路接入交付" }),
      row("表5-3", "p1", { item: "边缘采集", content: "装网关", window: "第 1–2 周", man_days: "30", rollback: "拆除网关，1 天恢复" }),
    ];
    const f = evaluateGates(rows);
    expect(hit(f, "处置人天")).toBe(1);
    expect(f.find((x) => x.gate.includes("处置人天"))?.detail).toContain("两套账");
  });

  it("人天在同一量级时不点名", () => {
    const rows: GateRow[] = [
      row("表4-3", "g1", { gap_ref: "缺口甲", match: "需补齐", our_product: "YS-EC3200", action: "补算法，估算 60–90 人天" }),
      row("表5-3", "p1", { item: "边缘采集", content: "装网关", window: "第 1–2 周", man_days: "70", rollback: "拆除网关，1 天恢复" }),
    ];
    expect(hit(evaluateGates(rows), "处置人天")).toBe(0);
  });

  it("整表没有否定判定时只提示、不阻断", () => {
    const mk = (role: string): GateRow =>
      row("表4-2", `r${role}`, { link: "曝气控制", our_role: role, our_scope: "做采集，不做 PLC 程序" });
    const noNegative = evaluateGates([mk("辅助"), mk("替代"), mk("辅助"), mk("辅助"), mk("外围")]);
    expect(hit(noNegative, "没有一行「不参与」")).toBe(1);
    expect(noNegative.find((f) => f.gate.includes("没有一行「不参与」"))?.severity).toBe("存疑");
    const withNegative = evaluateGates([mk("辅助"), mk("替代"), mk("辅助"), mk("辅助"), mk("不参与")]);
    expect(hit(withNegative, "没有一行「不参与」")).toBe(0);
  });
});

describe("判定口径自检", () => {
  it("中栏列都能取到（门限只判中栏，不把右栏溯源留痕算进价值）", () => {
    for (const t of TABLES) {
      const mids = middleColumns(t);
      expect(mids.length).toBeGreaterThan(0);
    }
  });
});
