import { describe, it, expect } from "vitest";
import { REPORT_CHAPTERS } from "@scene/contract";
import { checkReport, reportChapterHeadings } from "./report-gate.js";

/** 六章齐全的样板正文 */
function fullText(extra = ""): string {
  return REPORT_CHAPTERS.map((c) => `## ${c.title}\n\n这是${c.title}的归纳正文。`).join("\n\n") + extra;
}

describe("报告确定性校验（变更表 #112）", () => {
  it("六章齐全 / 无建议措辞 → 通过", () => {
    const r = checkReport("external", fullText("边界写明不承接统一数据平台。"));
    expect(r.ok).toBe(true);
    expect(r.chapters.length).toBe(6);
  });

  it("缺章是硬伤（模型漏写一章不能就这么交付）", () => {
    const text = fullText().replace("## 五、能够提供的价值", "## 五、随便写点什么");
    const r = checkReport("internal", text);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.kind === "缺章" && v.hard)).toBe(true);
  });

  it("出现决策建议是硬伤（产品只给事实，决定权在用户）", () => {
    const r = checkReport("internal", fullText("我方建议优先投入试点。"));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.kind === "出现决策建议")).toBe(true);
  });

  it("对外材料出现内部表号 / 来源 / 证据级 → 硬伤", () => {
    for (const leak of ["见 表3-8", "来源：客户台账", "证据级 A", "信息缺口 3 条", "ingest-123-4.pdf"]) {
      const r = checkReport("external", fullText(`参考资料 ${leak}`));
      expect(r.ok, leak).toBe(false);
      expect(r.violations.some((v) => v.kind === "对外泄漏内部信息"), leak).toBe(true);
    }
  });

  it("「能力缺口」是正当说法，不算对外泄漏（只有信息缺口这类内部口径才算）", () => {
    const r = checkReport("external", fullText("主要缺口在算法与软件，需与伙伴配合。"));
    expect(r.violations.some((v) => v.kind === "对外泄漏内部信息")).toBe(false);
  });

  it("同样的内部痕迹放在内部版不算违规（内部版本来就带来源与核实）", () => {
    const r = checkReport("internal", fullText("见表3-8，来源：客户台账；证据级 A。"));
    expect(r.violations.some((v) => v.kind === "对外泄漏内部信息")).toBe(false);
  });

  it("内部版缺风险或边界：只提示不拦", () => {
    const r = checkReport("internal", fullText("本报告只写场景与方案。"));
    const v = r.violations.find((x) => x.kind === "缺风险或边界");
    expect(v?.hard).toBe(false);
  });

  it("篇幅不足只提示，不当硬伤", () => {
    const r = checkReport("external", fullText());
    const v = r.violations.find((x) => x.kind === "篇幅不足");
    expect(v?.hard).toBe(false);
    expect(r.ok).toBe(true);
  });

  it("章名识别忽略序号与多余空格", () => {
    expect(reportChapterHeadings("## 一、场景定义 \n### 小节\n##场景名")).toEqual(["场景定义"]);
  });
});
