import { describe, it, expect } from "vitest";
import { DELIVERY_OUTPUTS, railOutputsOf, stepOutputs } from "./step-outputs.js";

/**
 * 流程轴第二行与中栏共用同一份「本步输出物」口径（变更表 #111）。
 * 这里锁住三条：单块表一项、多子块表按块拆项、交付物步**不从这份表清单来**
 * （它没有表；两份交付物与本步动作由 DeliveryPanel portal 到流程轴第二行，变更表 #148）
 * ——写歪了就会出现「轴上点了 A、中栏显示 B」。
 */
describe("stepOutputs（本步输出物口径）", () => {
  it("普通表：一表一项，label 用表名", () => {
    const list = stepOutputs(["表4-3", "表4-4"]);
    expect(list.map((o) => o.key)).toEqual(["表4-3", "表4-4"]);
    expect(list[0]).toMatchObject({ code: "表4-3", block: null });
    expect(list[0]!.label.length).toBeGreaterThan(0);
  });

  it("多子块表：每块各占一项，key 带块名（与中栏 v1.26 口径一致）", () => {
    // 表5-1 有架构块 / 接口块
    const list = stepOutputs(["表5-1"]);
    expect(list.length).toBeGreaterThan(1);
    expect(list.every((o) => o.code === "表5-1")).toBe(true);
    expect(list.every((o) => o.block !== null && o.key === `表5-1:${o.block}`)).toBe(true);
    // 名字互不相同（用户靠它区分架构块 / 接口块）
    expect(new Set(list.map((o) => o.label)).size).toBe(list.length);
  });

  it("未知表号是编程错误：契约层直接抛（不静默降级，免得轴上点了中栏却没有）", () => {
    expect(() => stepOutputs(["不存在的表"])).toThrow();
  });

  it("交付物步：没有表 → 这份清单为空（两份交付物由面板 portal 到流程轴第二行，变更表 #148）", () => {
    expect(railOutputsOf(7, [], 7)).toEqual([]);
  });

  it("交付物这两份仍有唯一定义，且名字取契约（面板据此画 chip，变更表 #137 / #148）", () => {
    expect(DELIVERY_OUTPUTS.map((o) => o.key)).toEqual(["solution", "construction"]);
    expect(DELIVERY_OUTPUTS.map((o) => o.label)).toEqual(["解决方案", "建设工作方案"]);
    expect(DELIVERY_OUTPUTS.every((o) => o.code === null)).toBe(true);
  });

  it("分析步：按流程定义的表集展开，不含报告", () => {
    const list = railOutputsOf(4, ["表4-3", "表4-4"], 7);
    expect(list.map((o) => o.key)).toEqual(["表4-3", "表4-4"]);
  });
});
