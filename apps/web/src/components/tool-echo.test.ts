import { describe, expect, it } from "vitest";
import { stripToolEcho } from "./tool-echo";

describe("stripToolEcho — 过程信息不进气泡（#320）", () => {
  it("工具参数 JSON 整段删除，只留确认语", () => {
    const text = '{"instruction":"压缩","section":"现状"}\n\n已优化「现状」：100 → 80 字。';
    expect(stripToolEcho(text)).toBe("已优化「现状」：100 → 80 字。");
  });

  it("纯过程 JSON 清成空串，气泡不渲染", () => {
    expect(stripToolEcho('{"table":"M1","updates":[{"match":{}}]}')).toBe("");
  });

  it("普通业务 JSON 与正文不受影响", () => {
    expect(stripToolEcho("结论如下\n{\"a\":1}")).toContain('{"a":1}');
  });
});
