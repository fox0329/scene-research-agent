import { describe, it, expect } from "vitest";
import { reportChapterHeading, reportChapters } from "@scene/contract";
import type { ChapterDigest } from "@scene/infra";
import {
  buildChapterPrompt,
  buildCompressPrompt,
  buildReportPrompt,
  chapterProseBudget,
} from "./report-prompts.js";

const digest: ChapterDigest[] = reportChapters().map((c) => ({
  key: c.key,
  title: reportChapterHeading(c.key),
  markdown: `${c.label}的原料要点`,
}));

const base = {
  scenarioName: "智慧会议室",
  anchor: [{ item: "场景名称", content: "智慧会议室" }],
  chapters: digest,
  missingTables: ["表3-1 利润池"],
};

describe("报告提示词（变更表 #112 / #136）", () => {
  it("章节名与小节名原样进提示词，且章名不带序号（序号交给 Word）", () => {
    const { system } = buildReportPrompt(base);
    for (const c of reportChapters()) {
      expect(system).toContain(`## ${reportChapterHeading(c.key)}`);
      expect(system).not.toContain(`一、${c.label}`);
      for (const sec of c.sections) expect(system).toContain(sec.title);
    }
  });

  it("说明章节号由 Word 自动编号，并要求章名只写一次", () => {
    const { system } = buildReportPrompt(base);
    expect(system).toContain("章节号由 Word 文档自动编号");
    expect(system).toContain("正文与标题都不要自己写序号");
    expect(system).toContain("章名只写一次");
  });

  it("禁止正文用「一、二、」编号（会与章节层级混淆），并给出替代写法", () => {
    const { system } = buildReportPrompt(base);
    expect(system).toContain("不许再用「一、二、三、」编号");
    expect(system).toContain("价值一");
  });

  it("要求报告长出自己的方案构件，并明说「不是前面内容的总结」", () => {
    const { system, user } = buildReportPrompt(base);
    expect(user).toContain("方案构件");
    expect(user).toContain("不要写成前面内容的总结");
    // 价值是四列表格（含怎么核）——内部版那种「价值N/度量口径」段落已随 #136 退场
    for (const word of ["设计原则", "编号", "怎么核", "| 价值 | 现在 | 采用后 | 怎么核 |"]) {
      expect(system, word).toContain(word);
    }
  });

  it("只有一份口径：读者是客户的业务与 IT 负责人，不再出现两版说法", () => {
    const all = `${buildReportPrompt(base).system}\n${buildReportPrompt(base).user}`;
    expect(all).toContain("客户的业务与 IT 负责人");
    expect(all).toContain("不给决策建议");
    for (const gone of ["内部版", "对外版", "内部调研报告", "对外汇报材料", "两份"]) {
      expect(all, gone).not.toContain(gone);
    }
  });

  it("已退场的章节与构件不进提示词（无风险章、无术语表、无内部版小节）", () => {
    const { system } = buildReportPrompt(base);
    expect(system).not.toContain("主要风险点");
    expect(system).not.toContain("术语表");
    // 场景边界/典型问题/价值表在契约里就是「章下直接写」，不再有套小节标题的那一版
    expect(system).toContain("「场景边界」：**章下直接写，不要单独加 `###` 标题**");
    expect(system).toContain("「典型问题」：**章下直接写，不要单独加 `###` 标题**");
    expect(system).toContain("`### 设计原则`");
    expect(system).toContain("`### 实施要点`");
    // 价值表后面不再要求写四条边界段落（用户定稿已删，变更表 #131/#136），只剩那句禁令
    expect(system).not.toContain("表格下面**再写四条边界**");
    expect(system).toContain("**不要**再写「不替代 / 不参与 / 不承担 / 受限条件」四条边界段落");
  });

  it("原料、场景锚、缺口表都带给模型（不让它自己猜表）", () => {
    const { user } = buildReportPrompt(base);
    expect(user).toContain("智慧会议室");
    expect(user).toContain("表3-1 利润池");
    expect(user).toContain("现状");
  });

  it("重写时把上一版的硬伤清单带回去，并要求逐条规避", () => {
    const { user } = buildReportPrompt(base, "- 【泄漏内部信息】出现表号：表3-8");
    expect(user).toContain("上一次的问题");
    expect(user).toContain("表3-8");
    expect(user).toContain("不得出现决策建议措辞");
  });

  it("篇幅只有单一口径（变更表 #136：不再分内部/对外两套数字）", () => {
    const { system } = buildReportPrompt(base);
    expect(system).toContain("2500–3200");
    expect(system).not.toContain("2500–4000");
    expect(system).not.toContain("内部版每章");
  });

  it("补写与压缩提示词同样是单一口径", () => {
    const chapter = buildChapterPrompt(digest.slice(1, 2), "智慧会议室");
    expect(chapter.user).toContain("只写下面这几节");
    expect(`${chapter.system}\n${chapter.user}`).not.toContain("术语表");
    const compress = buildCompressPrompt({ title: "现状", markdown: "正文", budget: 1000, current: 1500 });
    expect(compress.system).toContain("只删不加");
    expect(compress.user).toContain("1000 字以内");
    expect(`${compress.system}\n${compress.user}`).not.toContain("内部版");
    expect(`${compress.system}\n${compress.user}`).not.toContain("对外");
  });

  it("逐章回炉线就是变更表 #136 定下的一档（不再按 kind 取值）", () => {
    expect(chapterProseBudget("status")).toBe(1000);
    expect(chapterProseBudget("problems")).toBe(300);
    expect(chapterProseBudget("solution")).toBe(1350);
    expect(chapterProseBudget("value")).toBe(200);
    expect(chapterProseBudget("next")).toBe(400);
    expect(chapterProseBudget("不存在的章")).toBe(450);
  });
});
