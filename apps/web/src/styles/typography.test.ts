/**
 * 字号阶回归（v0.7.1 UI 专项）
 *
 * 用户实测反馈：「右栏的字体比中栏表格的字体还大」「中栏的阶段字体有点小」。
 * 这类问题不该靠人每次盯截图：把"层级必须成立"写成断言——
 *   表格正文 ≥ 13px；右栏来源/提醒 ≤ 表格正文；阶段名 ≥ 13px；页面标题 ≥ 20px。
 *
 * 只读 CSS 源码，不依赖浏览器：改 token 或关键规则时立刻失败。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");

const tokens = read("tokens.css");
const app = read("app.css");

function token(name: string): number {
  const m = tokens.match(new RegExp(`--${name}:\\s*([0-9.]+)px`, "u"));
  expect(m, `缺少字号 token --${name}`).not.toBeNull();
  return Number(m![1]);
}

describe("字号阶", () => {
  it("token 单调且满足最小可读性", () => {
    const scale = ["t2x", "tx", "txs", "ts", "tmd", "tb", "tl"].map(token);
    expect(scale).toEqual([...scale].sort((a, b) => a - b));
    expect(token("txs")).toBeGreaterThanOrEqual(13);
    expect(token("tl")).toBeGreaterThanOrEqual(20);
  });

  it("表格正文 ≥ 13px，表头小于正文但 ≥ 12px", () => {
    expect(app).toMatch(/table\s*\{[^}]*font-size:\s*var\(--txs\)/su);
    const tableBody = token("txs");
    const tableHead = token("t2x");
    expect(tableBody).toBeGreaterThanOrEqual(13);
    expect(tableHead).toBeGreaterThanOrEqual(12);
    expect(tableHead).toBeLessThan(tableBody);
  });

  it("右栏来源/提醒不得大于表格正文", () => {
    const block = app.match(/\.summary-sources,\s*\n\.summary-advice\s*\{[^}]*\}/u)?.[0] ?? "";
    expect(block).toContain("font-size: var(--txs)");
    const empty = app.match(/\.summary-empty\s*\{[^}]*\}/u)?.[0] ?? "";
    expect(empty).toContain("font-size: var(--txs)");
    expect(token("txs")).toBeLessThanOrEqual(token("ts"));
  });

  it("表标题与阶段名有独立档位，不被压成微标签", () => {
    expect(app).toMatch(/\.schema-table-title\s*\{[^}]*font-size:\s*var\(--tmd\)/su);
    expect(app).toMatch(/\.badge\.step-badge\s*\{[^}]*font-size:\s*var\(--txs\)/su);
    expect(app).toMatch(/\.flow-node\s*\{[^}]*font-size:\s*var\(--txs\)/su);
  });
});
