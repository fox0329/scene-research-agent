import { describe, it, expect } from "vitest";
import { reportChapterHeading, reportChaptersOf } from "@scene/contract";
import type { ChapterDigest } from "@scene/infra";
import { buildReportPrompt } from "./report-prompts.js";

const digest: ChapterDigest[] = reportChaptersOf("internal").map((c) => ({
  key: c.key,
  title: reportChapterHeading("internal", c.key),
  markdown: `${c.label}的原料要点`,
}));

const base = {
  scenarioName: "智慧会议室",
  anchor: [{ item: "场景名称", content: "智慧会议室" }],
  chapters: digest,
  missingTables: ["表3-1 利润池"],
};

describe("报告提示词（变更表 #112）", () => {
  it("章节名与小节名原样进提示词（模型按这套骨架写）", () => {
    const { system, user } = buildReportPrompt("internal", base);
    for (const c of reportChaptersOf("internal")) {
      expect(`${system}\n${user}`).toContain(reportChapterHeading("internal", c.key));
      for (const sec of c.sections) expect(system).toContain(sec.title);
    }
  });

  it("要求报告长出自己的方案构件，并明说「不是前面内容的总结」", () => {
    const { user } = buildReportPrompt("external", base);
    expect(user).toContain("方案构件");
    expect(user).toContain("不要写成前面内容的总结");
    const { system } = buildReportPrompt("external", base);
    for (const word of ["设计原则", "编号", "度量口径", "不做什么", "术语"]) {
      expect(system, word).toContain(word);
    }
  });

  it("内部版侧重客观与风险；对外版侧重痛点、方案、价值", () => {
    const internal = buildReportPrompt("internal", base);
    expect(internal.system).toContain("客观、风险");
    expect(internal.system).toContain("不给决策建议");
    const external = buildReportPrompt("external", base);
    expect(external.system).toContain("痛点、方案、价值");
    expect(external.system).toContain("不许出现");
  });

  it("原料、场景锚、缺口表都带给模型（不让它自己猜表）", () => {
    const { user } = buildReportPrompt("internal", base);
    expect(user).toContain("智慧会议室");
    expect(user).toContain("表3-1 利润池");
    expect(user).toContain("现状");
  });

  it("重写时把上一次的违规清单带回去，并要求逐条规避", () => {
    const { user } = buildReportPrompt("external", base, "- 【对外泄漏内部信息】出现内部痕迹：表3-8");
    expect(user).toContain("上一次的问题");
    expect(user).toContain("表3-8");
    expect(user).toContain("不得出现决策建议措辞");
  });

  it("两份的篇幅口径不同（内部 8–15 页 / 对外 5–8 页）", () => {
    expect(buildReportPrompt("internal", base).system).toContain("4000–8000");
    expect(buildReportPrompt("external", base).system).toContain("2500–4500");
  });
});
