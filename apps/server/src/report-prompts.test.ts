import { describe, it, expect } from "vitest";
import { reportChapterHeading, reportChaptersOf } from "@scene/contract";
import type { ChapterDigest } from "@scene/infra";
import { buildReportPrompt, chapterProseBudget } from "./report-prompts.js";

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
      for (const sec of c.sections.filter((x) => x.only === undefined || x.only === "internal"))
        expect(system).toContain(sec.title);
    }
  });

  it("要求章名只写一次（不许在正文里再抄一遍）", () => {
    const { system } = buildReportPrompt("internal", base);
    expect(system).toContain("章名只写一次");
  });

  it("禁止正文用「一、二、」编号（会与章号混淆），并给出替代写法", () => {
    const { system } = buildReportPrompt("internal", base);
    expect(system).toContain("不许再用「一、二、三、」编号");
    expect(system).toContain("价值一");
  });

  it("要求报告长出自己的方案构件，并明说「不是前面内容的总结」", () => {
    const { user } = buildReportPrompt("external", base);
    expect(user).toContain("方案构件");
    expect(user).toContain("不要写成前面内容的总结");
    const { system } = buildReportPrompt("external", base);
    // 对外价值是四列表格（含怎么核），不是内部那种「价值N/度量口径」段落（变更表 #129）
    for (const word of ["设计原则", "编号", "怎么核", "不替代", "术语"]) {
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

  it("只出现本口径的小节：内部不写门槛与合规/实施要点，对外不写能力边界，且同名小节不重复", () => {
    const int = buildReportPrompt("internal", base).system;
    // 不能用「门槛与合规」四个字断言：风险章的六类风险里正当提到它
    expect(int).not.toContain("行业准入");
    expect(int).not.toContain("回退路径");
    expect(int).not.toContain("场景在业务中的位置");
    // 内部价值是段落式：不给四列表头；「怎么核」四字会作为"不许写"的禁令正当出现
    expect(int).not.toContain("| 价值 | 现在 | 采用后 | 怎么核 |");
    expect(int).toContain("现状特征与提升空间");
    expect(int).toContain("能力边界");
    expect(int).toContain("价值一");
    const ext = buildReportPrompt("external", base).system;
    expect(ext).toContain("门槛与合规");
    expect(ext).toContain("实施要点");
    expect(ext).not.toContain("能力边界");
    expect(ext).toContain("| 价值 | 现在 | 采用后 | 怎么核 |");
    // 同一内容两份口径写法不同：内部有小节标题，对外是"章下直接写"
    expect(int).toContain("`### 场景边界`");
    expect(int).toContain("`### 典型问题`");
    expect(ext).toContain("「场景边界」：**章下直接写，不要单独加 `###` 标题**");
    expect(ext).toContain("「典型问题」：**章下直接写，不要单独加 `###` 标题**");
  });

  it("两份的篇幅口径不同，且都按用户定稿实测校准（内部 2500–4000 / 对外 2500–3200）", () => {
    expect(buildReportPrompt("internal", base).system).toContain("2500–4000");
    // 变更表 #131：对外定稿正文 2644 字（删掉门槛与合规、边界、附录之后）
    expect(buildReportPrompt("external", base).system).toContain("2500–3200");
  });

  it("逐章回炉线不低于用户定稿的实测篇幅（否则一生成就被压改）", () => {
    // 变更表 #131 对外定稿实测：现状 888 / 问题 169 / 方案 1203 / 价值 9 / 下一步 251
    expect(chapterProseBudget("external", "status")).toBeGreaterThan(888);
    expect(chapterProseBudget("external", "solution")).toBeGreaterThan(1203);
    expect(chapterProseBudget("external", "problems")).toBeGreaterThan(169);
    expect(chapterProseBudget("external", "value")).toBeGreaterThan(9);
    expect(chapterProseBudget("external", "next")).toBeGreaterThan(251);
  });
});
