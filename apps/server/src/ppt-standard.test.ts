import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PPT_CAUTIONS,
  PPT_GATE_CODES,
  PPT_GATE_THRESHOLDS,
  PPT_GENERATION_RULES,
  PPT_LAYOUT_STANDARDS,
  PPT_MODEL_CAUTIONS,
  PPT_OUTLINE_QUALITY,
  PPT_LAYOUTS,
  PPT_TEMPLATE_SUMMARY,
} from "@scene/contract";

/** 仓库根（本文件在 apps/server/src 下） */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** 扫一份源码里所有 `code: "…"` 字面量（门禁判出来的取值） */
function codesIn(relative: string): string[] {
  const src = readFileSync(`${repoRoot}${relative}`, "utf8");
  return [...src.matchAll(/code: "([^"]+)"/g)].map((m) => m[1]!);
}

describe("PPT 生成标准（产品内唯一事实源）", () => {
  it("生成要求：id 唯一、规则与理由都不为空、条数够覆盖结构/叙事/密度/真实性", () => {
    const ids = PPT_GENERATION_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["pages", "narrative", "density", "variety", "cover", "truth", "textbox"]));
    for (const r of PPT_GENERATION_RULES) {
      expect(r.rule.length, r.id).toBeGreaterThan(4);
      expect(r.why.length, r.id).toBeGreaterThan(4);
    }
  });

  it("版式标准覆盖全部布局（渲染器加版式，标准里必须跟着登记）", () => {
    expect(PPT_LAYOUT_STANDARDS.map((l) => l.layout).sort()).toEqual([...PPT_LAYOUTS].sort());
    for (const l of PPT_LAYOUT_STANDARDS) {
      expect(l.geometry.length, l.layout).toBeGreaterThan(10);
      expect(l.capacity.length, l.layout).toBeGreaterThan(4);
      expect(l.reads.length, l.layout).toBeGreaterThan(4);
    }
  });

  it("门限总表覆盖两份门禁源码里的每一个 code（加了判据不登记 → 这里红）", () => {
    const emitted = new Set([...codesIn("packages/infra/src/ppt-quality.ts"), ...codesIn("packages/domain/src/ppt-outline.ts")]);
    const documented = new Set(PPT_GATE_CODES);
    const missing = [...emitted].filter((c) => !documented.has(c));
    expect(missing, `这些 code 判得出来但没写进 PPT_GATE_THRESHOLDS：${missing.join("、")}`).toEqual([]);
    // 反向：标准里登记了、代码里却没人判（改名/删判据后留下的僵尸条目）
    const stale = [...documented].filter((c) => !emitted.has(c) && c !== "页面太空");
    expect(stale, `这些 code 写在标准里但代码里已经没有：${stale.join("、")}`).toEqual([]);
  });

  it("每条门限都有判定线与处置动作，层级只有大纲/版面两种", () => {
    for (const g of PPT_GATE_THRESHOLDS) {
      expect(g.threshold.length, g.code).toBeGreaterThan(3);
      expect(g.action.length, g.code).toBeGreaterThan(3);
      expect(["outline", "render"]).toContain(g.layer);
    }
    expect(PPT_GATE_THRESHOLDS.filter((g) => g.layer === "outline").length).toBeGreaterThan(8);
    expect(PPT_GATE_THRESHOLDS.filter((g) => g.layer === "render").length).toBeGreaterThan(8);
  });

  it("注意事项：模型只拿能影响生成的那几条；渲染/工程边界不喂给模型", () => {
    const model = PPT_CAUTIONS.filter((c) => c.model);
    expect(model.length).toBeGreaterThanOrEqual(3);
    expect(PPT_MODEL_CAUTIONS).toEqual(model.map((c) => c.note));
    for (const c of PPT_CAUTIONS) expect(c.note.length, c.id).toBeGreaterThan(10);
    // 用户定调的文本框中立边界必须在标准里，但不需要模型知道
    expect(PPT_CAUTIONS.find((c) => c.id === "one-box")?.model).toBe(false);
  });

  it("模版摘要与冻结的门限一致（改阈值不改这条 → 红）", () => {
    expect(PPT_TEMPLATE_SUMMARY).toContain("24pt");
    expect(PPT_TEMPLATE_SUMMARY).toContain("11.25pt");
    expect(PPT_TEMPLATE_SUMMARY).toContain("NN / MM");
    expect(PPT_TEMPLATE_SUMMARY).toContain("29–57");
    expect(PPT_OUTLINE_QUALITY.minLayoutVariety).toBe(4);
  });
});
