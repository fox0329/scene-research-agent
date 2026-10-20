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
  it("31 张表每张都有门限，不许漏", () => {
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
        for (const c of cols) if (!keys.has(c)) bad.push(`${code}.${c}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("跨表引用的目标列也真实存在", () => {
    const bad: string[] = [];
    for (const [code, gates] of Object.entries(TABLE_GATES)) {
      for (const g of gates) {
        if (g.kind !== "cross-ref") continue;
        const target = tableDef(g.table);
        if (!target.columns.some((c) => c.key === g.target)) bad.push(`${code}→${g.table}.${g.target}`);
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

  it("不同场景复用同一能力不算重复（跨场景去重会误杀）", () => {
    const f = evaluateGates([
      { ...row("表4-1", { ability: "多协议设备接入", maturity: "已交付" }, "a"), scenarioId: "s1" },
      { ...row("表4-1", { ability: "多协议设备接入", maturity: "已交付" }, "b"), scenarioId: "s2" },
    ]);
    expect(f).toEqual([]);
  });

  it("表4-5 权重合计只有 90 → 点名", () => {
    const f = evaluateGates([
      row("表4-5", { dimension: "老机取数", weight: 25, score: 3, basis: "YS-GW2100 旁路取数" }),
      row("表4-5", { dimension: "算法口径", weight: 20, score: 2, basis: "自研 OEE 引擎" }),
      row("表4-5", { dimension: "交付窗口", weight: 20, score: 4, basis: "周末停线窗口交付" }),
      row("表4-5", { dimension: "合规", weight: 15, score: 4, basis: "私有化部署" }),
      row("表4-5", { dimension: "加分项", weight: 10, score: 3, basis: "视觉质检在路线图" }),
    ]);
    expect(f.some((x) => x.gate.includes("权重合计"))).toBe(true);
  });

  it("表4-5 写了「综合赢面（加权总分）」派生行 → 点名，且不计入合计", () => {
    const f = evaluateGates([
      row("表4-5", { dimension: "老机取数", weight: 100, score: 3, basis: "YS-GW2100" }),
      row("表4-5", { dimension: "综合赢面（加权总分）", weight: 100, score: 3.15, basis: "加权计算" }),
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

  it("表3-7 规避措施写「注意风险」→ 点名；写进合同条款 → 达标", () => {
    const bad = evaluateGates([row("表3-7", { pitfall: "老机协议不开放", consequence: "取不到数", avoid_in_design: "注意风险" })]);
    expect(bad.some((x) => x.detail.includes("空话"))).toBe(true);
    const ok = evaluateGates([
      row("表3-7", {
        pitfall: "老机协议不开放",
        consequence: "取不到数，返工 3 人月、延期 2 周",
        avoid_in_design: "合同写明进场首周完成全厂点表核对并双方签字",
      }),
    ]);
    expect(ok).toEqual([]);
  });

  it("表6-1 预期写「显著提升」→ 点名；写「提升 15%」→ 达标", () => {
    expect(
      evaluateGates([row("表6-1", { benefit: "OEE", metric: "OEE 提升", expected: "显著提升", how_to_measure: "按班次统计", user_feeling: "班组长：不用再手抄" })]).some(
        (x) => x.gate.includes("数值"),
      ),
    ).toBe(true);
    expect(
      evaluateGates([row("表6-1", { benefit: "OEE", metric: "OEE 提升", expected: "提升 15 个百分点", how_to_measure: "按班次统计", user_feeling: "班组长：不用再手抄" })]),
    ).toEqual([]);
  });

  it("整行占位词 → 硬伤「行必须有实质内容」", () => {
    const f = evaluateGates([row("表5-4", { item: "交付", content: "未提供", sla: "待补" })]);
    expect(f.some((x) => x.severity === "硬伤")).toBe(true);
  });

  it("表6-4 缺成功判据/验收口径 → 覆盖度点名", () => {
    const f = evaluateGates([
      row("表6-4", { kind: "试点范围", content: "1 个车间、28 台设备、12 名用户" }),
      row("表6-4", { kind: "试点时长", content: "连续 3 个月" }),
      row("表6-4", { kind: "成功判据", content: "OEE 提升 ≥10 个百分点，按班次统计，生产经理签字" }),
      row("表6-4", { kind: "验收口径", content: "按连续 3 个月数据可用率 ≥99% 验收，客户设备部签字" }),
    ]);
    expect(f).toEqual([]);
    const f2 = evaluateGates([row("表6-4", { kind: "试点范围", content: "1 个车间、28 台设备" })]);
    expect(f2.some((x) => x.gate.includes("成功判据"))).toBe(true);
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
