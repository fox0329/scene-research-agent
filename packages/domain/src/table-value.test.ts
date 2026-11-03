import { describe, expect, it } from "vitest";
import { tableDef } from "@scene/contract";
import { isValuableCell, tableValueScore, VALUE_RATIO_FLOOR, weakCellKeys } from "./table-value.js";

describe("格子有没有实际价值（用户定调 2026-11-03）", () => {
  it("空值、纯填充词、单字答案都不算价值", () => {
    for (const bad of ["", "  ", "未知", "不适用", "未提供", "待核实", "无", "N/A", "是", "否", "高", "低"]) {
      expect(isValuableCell(bad), bad).toBe(false);
    }
  });

  it("说清了一件事就算，名词短也算（不能把「数据采集」这类能力名误判成空话）", () => {
    expect(isValuableCell("浮球与液位计分级触发")).toBe(true);
    expect(isValuableCell("机械密封寿命≥25000 小时")).toBe(true);
    expect(isValuableCell("数据采集")).toBe(true);
    expect(isValuableCell("过得了")).toBe(true);
    expect(isValuableCell(["一控二", "浮球液位"])).toBe(true);
    /* 序号/排名是有效内容，不能因为只有一个字符就判成空话 */
    expect(isValuableCell("3")).toBe(true);
  });

  it("达标线是 90%（用户定调 2026-11-03）", () => {
    expect(VALUE_RATIO_FLOOR).toBe(0.9);
  });

  it("挑出「填了但没价值」的格子，空格子不算（没有文字可染红）", () => {
    const def = tableDef("表2-4")!;
    const weak = weakCellKeys(def, {
      interaction_type: "未知",
      from_to: "是",
      method: "浮球闭合启泵",
      key_params: "",
    });
    expect(weak.sort()).toEqual(["from_to", "interaction_type"]);
  });

  it("表格评分只看中栏，占比低于底线就该降级重来", () => {
    const def = tableDef("表2-4")!;
    const thin = [{ interaction_type: "未知", from_to: "是", method: "否" }];
    expect(tableValueScore(def, thin).ratio).toBeLessThan(VALUE_RATIO_FLOOR);
    const good = [
      {
        interaction_type: "液位联动控制",
        from_to: "低浮球→1号泵",
        method: "浮球闭合直接启泵",
        key_params: "启泵液位 1.2m，停泵 0.8m",
      },
      {
        interaction_type: "平台轮换控制",
        from_to: "平台→1、2号泵",
        method: "按运行小时数轮换主备泵",
        key_params: "轮换周期 24h，故障后 5s 自投",
      },
    ];
    expect(tableValueScore(def, good).ratio).toBeGreaterThanOrEqual(VALUE_RATIO_FLOOR);
  });
});
