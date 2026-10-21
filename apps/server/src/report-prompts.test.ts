import { describe, it, expect } from "vitest";
import { reportChapterHeading, reportChapters } from "@scene/contract";
import type { ReportKind } from "@scene/contract";
import type { ChapterDigest } from "@scene/infra";
import { reportMaxChars, reportMinChars } from "@scene/domain";
import {
  buildChapterPrompt,
  buildReportPrompt,
  chapterProseBudget,
} from "./report-prompts.js";

const KIND: ReportKind = "solution";

/** 确定性原料（与 `reportChapterDigest()` 同构：章 key + 章名 + 该章素材） */
const digest: ChapterDigest[] = reportChapters(KIND).map((c) => ({
  key: c.key,
  title: reportChapterHeading(KIND, c.key),
  markdown: `${c.label}的原料要点`,
}));

const base = {
  scenarioName: "智慧会议室",
  anchor: [{ item: "场景名称", content: "智慧会议室" }],
  chapters: digest,
  missingTables: ["表3-1 利润池"],
};

describe("交付物提示词（变更表 #246：一份《<场景>解决方案》，七章）", () => {
  it("七章名与小节名原样进提示词，且章名不带序号（序号交给 Word）", () => {
    const { system } = buildReportPrompt(KIND, base);
    for (const c of reportChapters(KIND)) {
      expect(system).toContain(`## ${reportChapterHeading(KIND, c.key)}`);
      expect(system).not.toContain(`一、${c.label}`);
      for (const sec of c.sections) expect(system).toContain(sec.title);
    }
    expect(system).toContain("章节号由 Word 文档自动编号");
    expect(system).toContain("正文与标题都不要自己写序号");
    expect(system).toContain("章名只写一次");
  });

  it("报告名带口径：任务句里是《智慧会议室解决方案》", () => {
    const { user } = buildReportPrompt(KIND, base);
    expect(user).toContain("《智慧会议室解决方案》");
    expect(user).toContain("不要写成前面内容的总结");
    expect(user).toContain("里程碑计划表");
    expect(user).toContain("新增设备清单");
    expect(user).toContain("主辅职责对照");
  });

  it("要长出自己的方案构件（原则 / 表格 / 编号连接），且不再有价值观表", () => {
    const { system } = buildReportPrompt(KIND, base);
    expect(system).toContain("`### 设计原则`");
    expect(system).toContain("`### 实施要点`");
    expect(system).toContain("原则一 / 原则二 / 原则三");
    expect(system).not.toContain("| 价值 | 现在 | 采用后 | 怎么核 |");
    expect(system).not.toContain("价值表");
  });

  it("价值从「解决了什么问题」讲，不要求数字（变更表 #246 用户定调）", () => {
    const { system } = buildReportPrompt(KIND, base);
    expect(system).toContain("价值不一定要有数字");
    expect(system).toContain("解决了什么问题");
    expect(system).toContain("不编幅度、不编金额");
  });

  it("不给决策建议，也不许编材料里没有的数字", () => {
    const { system } = buildReportPrompt(KIND, base);
    expect(system).toContain("不给决策建议");
    expect(system).toContain("客户没给的数字不许编");
    expect(system).toContain("待现场勘查确定");
    expect(system).toContain("禁止编造具体金额或台数");
  });

  it("已退场的章节与口径不进提示词（无风险章、无术语表、无内部版、无建设工作方案）", () => {
    const all = `${buildReportPrompt(KIND, base).system}\n${buildReportPrompt(KIND, base).user}`;
    for (const gone of ["主要风险点", "术语表", "内部版", "对外版", "建设工作方案", "价值和度量"]) {
      expect(all, gone).not.toContain(gone);
    }
  });

  it("篇幅只有一套：正文 2,500–6,000 字、目标 5,700 字左右", () => {
    const { system } = buildReportPrompt(KIND, base);
    expect(system).toContain("2,500–6,000");
    expect(system).toContain("目标 5,700 字左右");
    expect(system).not.toContain("2500–3200");
    expect(system).not.toContain("2,000–5,000");
    expect([reportMinChars(KIND), reportMaxChars(KIND)]).toEqual([2500, 6000]);
  });

  it("逐章预算之和不超过总上限（7 档 = 5,750 ≤ 6,000）", () => {
    const sum = reportChapters(KIND).reduce((acc, c) => acc + chapterProseBudget(KIND, c.key), 0);
    expect(sum).toBe(5_750);
    expect(sum).toBeLessThanOrEqual(reportMaxChars(KIND));
    expect(chapterProseBudget(KIND, "不存在的章")).toBe(450);
  });

  it("章首段规则进通用硬规则（报告与补写提示词都在）", () => {
    const report = buildReportPrompt(KIND, base).system;
    expect(report).toContain("每章第一段是本章总纲");
    expect(report).toContain("不以分号列举或半句开头");
    expect(report).toContain("不超过 120 字");
    const chapter = buildChapterPrompt(KIND, digest.slice(0, 1), "智慧会议室");
    expect(chapter.system).toContain("每章第一段是本章总纲");
    expect(chapter.user).toContain("第一段是本章总纲");
  });

  it("补写提示词带口径名与章序号，并重申该章预算", () => {
    const chapter = buildChapterPrompt(KIND, digest.slice(2, 3), "智慧会议室");
    expect(chapter.user).toContain("《智慧会议室解决方案》");
    expect(chapter.user).toContain("第 3 章「方案总体与建设内容」");
    expect(chapter.user).toContain("本章正文预算不超过 1900 字");
    expect(chapter.user).toContain("只写下面这几节");
  });

  it("硬规则在位的九条（不是总结 / 结论降调 / 不写免责 / 不记流水账 / 不写表号）", () => {
    const { system } = buildReportPrompt(KIND, base);
    for (const rule of [
      "这是方案，不是前面内容的总结",
      "每条结论必须立得住",
      "写不出来的就说缺",
      "说人话",
      "数字要带口径",
      "不许写自我说明与免责声明",
      "不许记流水账",
      "不许再用「一、二、三、」编号",
      "正文里不写文件名、页码、内部表号",
    ]) {
      expect(system, rule).toContain(rule);
    }
  });

  it("重写时把上一版的硬伤清单带回去，并要求逐条规避", () => {
    const { user } = buildReportPrompt(KIND, base, "- 【泄漏内部信息】出现表号：表3-8");
    expect(user).toContain("上一次的问题");
    expect(user).toContain("表3-8");
    expect(user).toContain("不得出现决策建议措辞");
    expect(user).toContain("金额与台数不许编");
  });

  it("原料、场景锚、缺表清单都带给模型（不让它自己猜表）", () => {
    const { user } = buildReportPrompt(KIND, base);
    expect(user).toContain("智慧会议室");
    expect(user).toContain("表3-1 利润池");
    expect(user).toContain("现状与问题的原料要点");
  });
});
