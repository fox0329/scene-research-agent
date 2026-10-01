/**
 * @scene/web — text-display 单测（元说明兜底剥离 + 截断）
 *
 * 口径来自用户投诉：老数据里的「（用户未明说，按行业通行情况推断）」这类元说明
 * 不该出现在渲染结果里；确认清单不该重复整段内容。
 */

import { describe, expect, it } from "vitest";
import { clipText, plainText, stripMetaNotes } from "./text-display";

describe("stripMetaNotes", () => {
  it("剥掉「用户未明说」式注解并清理残留标点", () => {
    expect(stripMetaNotes("水厂中控室值班人员（用户未明说，按行业通行情况推断）")).toBe(
      "水厂中控室值班人员",
    );
  });

  it("注解在句中：剥掉后不留双标点与悬空空格", () => {
    expect(stripMetaNotes("不含排水一条线（用户未明说，按行业通行情况推断）。")).toBe(
      "不含排水一条线。",
    );
  });

  it("剥掉「由助手/系统/AI 推断」各类注解", () => {
    expect(stripMetaNotes("范围由助手按行业情况推断（由助手推断）")).toBe("范围由助手按行业情况推断");
    expect(stripMetaNotes("按行业惯例给出（系统推断）")).toBe("按行业惯例给出");
    expect(stripMetaNotes("用量（AI推断）按峰值算")).toBe("用量按峰值算");
  });

  it("整段括号只有元说明词时也剥掉（如「（系统推断）」）", () => {
    expect(stripMetaNotes("由保险赔付（系统推断）")).toBe("由保险赔付");
    expect(stripMetaNotes("由保险赔付（系统自动生成）")).toBe("由保险赔付（系统自动生成）");
  });

  it("嵌套/相邻注解反复剥离到稳定，不留空括号", () => {
    expect(stripMetaNotes("结论（A（用户未明说，按行业推断）B）成立")).toBe("结论（AB）成立");
    expect(stripMetaNotes("甲（用户未明说，按行业推断）（系统推断）乙")).toBe("甲乙");
  });

  it("不误伤正常括号（无元说明关键词的注解原样保留）", () => {
    expect(stripMetaNotes("以园区工业水厂为主（含平台公司运营的水厂）")).toBe(
      "以园区工业水厂为主（含平台公司运营的水厂）",
    );
    expect(stripMetaNotes("CT33：-40~+85℃（宽温）")).toBe("CT33：-40~+85℃（宽温）");
  });

  it("纯注解 → 空串（展示层由调用方兜底）", () => {
    expect(stripMetaNotes("（用户未明说，按行业通行情况推断）")).toBe("");
  });
});

describe("clipText", () => {
  it("不超长时原样返回（含剥注解）", () => {
    expect(clipText("现场数据采集（系统推断）", 40)).toBe("现场数据采集");
  });

  it("超长时截断到上限并加省略号", () => {
    const out = clipText("甲".repeat(60), 40);
    expect(out).toBe(`${"甲".repeat(40)}…`);
  });

  it("截断点落在括号内时补齐右括号", () => {
    const out = clipText(`前十四个字凑一凑${"乙".repeat(20)}（说明文字很长很长很长很长）`, 40);
    expect(out.endsWith("…")).toBe(true);
    expect((out.match(/（/gu) ?? []).length).toBe((out.match(/）/gu) ?? []).length);
  });
});

describe("plainText", () => {
  it("把 null/undefined 归一成空串", () => {
    expect(plainText(null)).toBe("");
    expect(plainText(undefined)).toBe("");
    expect(plainText(12)).toBe("12");
  });
});
