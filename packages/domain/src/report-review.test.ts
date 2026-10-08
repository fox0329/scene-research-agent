/**
 * @scene/domain — 交付物终检的纯逻辑测试（变更表 #139）
 *
 * 终检是"模型通读 + 确定性把关"：模型给的东西一律不可信——JSON 要能解析、条目要能定位到段落、
 * 改动不许越界、构件不许变少。这里把每一道关卡单独锁住（模型侧的编排在
 * `apps/server/src/report-review.test.ts`）。
 */

import { describe, expect, it } from "vitest";
import {
  MAX_REVIEW_ISSUES,
  chapterBlocks,
  deterministicReviewFindings,
  duplicateSentences,
  fixAccepted,
  leadParagraphProblems,
  parseReviewIssues,
  parseUnresolved,
  stubSections,
} from "./report-review.js";

const MD = [
  "## 建设背景与必要性",
  "",
  "智慧会议室分散在总部与各园区，跨地域协同靠云平台。",
  "",
  "## 建设目标与思路",
  "",
  "### 总体目标",
  "",
  "以统一预约与自动就绪为总体目标，覆盖总部与各园区的会议室，把开会前的准备时间压到最低。",
].join("\n");

describe("parseReviewIssues — 终检 JSON 的解析与校验", () => {
  it("严格 JSON：字段齐全、锚点定位得到 → 全部采纳", () => {
    const raw = JSON.stringify({
      issues: [
        {
          chapter: "建设背景与必要性",
          anchor: "智慧会议室分散在总部",
          type: "章首不自足",
          note: "没有点明处境",
        },
      ],
    });
    const r = parseReviewIssues(raw, MD);
    expect(r.error).toBeUndefined();
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.type).toBe("章首不自足");
    expect(r.dropped).toBe(0);
  });

  it("允许 ```json 围栏与前后寒暄", () => {
    const raw = ['好的，我读完了：', "```json", '{"issues":[]}', "```"].join("\n");
    const r = parseReviewIssues(raw, MD);
    expect(r.error).toBeUndefined();
    expect(r.issues).toEqual([]);
  });

  it("缺字段 / 类型不认 / 锚点定位不到 → 逐条丢弃", () => {
    const raw = JSON.stringify({
      issues: [
        { chapter: "建设背景与必要性", type: "重复", note: "缺 anchor" },
        { chapter: "建设背景与必要性", anchor: "智慧会议室分散在总部", type: "风格不好", note: "类型不认" },
        { chapter: "建设背景与必要性", anchor: "这句正文里根本没有", type: "重复", note: "定位不到" },
        { anchor: "智慧会议室分散在总部", type: "重复", note: "缺 chapter" },
        { chapter: "建设背景与必要性", anchor: "智慧会议室分散在总部", type: "重复", note: "" },
        { chapter: "建设背景与必要性", anchor: "跨地域协同靠云平台", type: "重复", note: "这条是好的" },
      ],
    });
    const r = parseReviewIssues(raw, MD);
    expect(r.error).toBeUndefined();
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.note).toBe("这条是好的");
    expect(r.dropped).toBe(5);
  });

  it(`超过 ${MAX_REVIEW_ISSUES} 条的只留前 ${MAX_REVIEW_ISSUES} 条，其余算丢弃`, () => {
    const issues = Array.from({ length: MAX_REVIEW_ISSUES + 3 }, () => ({
      chapter: "建设背景与必要性",
      anchor: "智慧会议室分散在总部",
      type: "重复",
      note: "重复",
    }));
    const r = parseReviewIssues(JSON.stringify({ issues }), MD);
    expect(r.issues).toHaveLength(MAX_REVIEW_ISSUES);
    expect(r.dropped).toBe(3);
  });

  it("不是 JSON / 缺少 issues 数组 → error（调用方据此跳过终检，不阻断出稿）", () => {
    expect(parseReviewIssues("这几处我改了。", MD).error).toBeTruthy();
    expect(parseReviewIssues('{"foo":1}', MD).error).toBeTruthy();
    // 空数组是"没问题"，不是错误
    expect(parseReviewIssues('{"issues":[]}', MD).error).toBeUndefined();
  });
});

describe("parseUnresolved — 复查结论", () => {
  it("认得出仍存疑的条目；解析不了返回 null", () => {
    expect(parseUnresolved('{"unresolved":[{"anchor":"甲","note":"还读不通"}]}')).toEqual([
      { anchor: "甲", note: "还读不通" },
    ]);
    expect(parseUnresolved('{"unresolved":[]}')).toEqual([]);
    expect(parseUnresolved("解决了两处")).toBeNull();
    expect(parseUnresolved('{"other":1}')).toBeNull();
  });
});

describe("duplicateSentences — 跨章重复句", () => {
  it("同一句 ≥20 字的话出现在两个不同章 → 算重复", () => {
    const md = [
      "## 现状",
      "",
      "现场巡检仍靠人工记录，数据分散在三个系统里，统计口径对不上。",
      "",
      "## 方案",
      "",
      "现场巡检仍靠人工记录，数据分散在三个系统里，统计口径对不上。",
      "",
      "本方案按三层架构推进。",
    ].join("\n");
    expect(duplicateSentences(md)).toHaveLength(1);
  });

  it("同章内重复、或句子太短、或只在表格里 → 都不算", () => {
    const sameChapter = [
      "## 现状",
      "",
      "现场巡检仍靠人工记录，数据分散在三个系统里，统计口径对不上。",
      "",
      "现场巡检仍靠人工记录，数据分散在三个系统里，统计口径对不上。",
    ].join("\n");
    expect(duplicateSentences(sameChapter)).toEqual([]);

    const tooShort = ["## 现状", "", "管控重心转向事前预防。", "", "## 方案", "", "管控重心转向事前预防。"].join(
      "\n",
    );
    expect(duplicateSentences(tooShort)).toEqual([]);

    const inTable = [
      "## 现状",
      "",
      "| 层次 | 说明 |",
      "|---|---|",
      "| 现场巡检仍靠人工记录，数据分散在三个系统里 | 现状 |",
      "",
      "## 方案",
      "",
      "| 层次 | 说明 |",
      "|---|---|",
      "| 现场巡检仍靠人工记录，数据分散在三个系统里 | 方案 |",
    ].join("\n");
    expect(duplicateSentences(inTable)).toEqual([]);
  });
});

describe("stubSections — 空节", () => {
  it("小节正文不足 30 字 → 报该小节名", () => {
    const md = [
      "### 组织保障",
      "",
      "成立领导小组。",
      "",
      "### 制度保障",
      "",
      "建立数据采集与管理办法、作业标准与考核细则，明确各岗位职责与执行口径，并按季度复盘修订。",
    ].join("\n");
    expect(stubSections(md)).toEqual(["组织保障"]);
  });

  it("没有 `###` 小节 → 空数组", () => {
    expect(stubSections("## 建设背景与必要性\n\n直接写正文，没有小节标题。")).toEqual([]);
  });
});

describe("leadParagraphProblems / deterministicReviewFindings — 章首段与整篇终检", () => {
  it("逐章看第一段：不点名的章不报，被砍成半句的章报出来", () => {
    const md = [
      "## 建设背景与必要性",
      "",
      "多园区由 IT、弱电运维（常含外包）与厂商支持；纪要手工或录音转写。",
      "",
      "## 建设目标与思路",
      "",
      "以统一预约与自动就绪为总体目标，覆盖总部与各园区。",
    ].join("\n");
    const problems = leadParagraphProblems(md);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.chapter).toBe("建设背景与必要性");
    expect(problems[0]!.reason).toBe("以分号列举开头");
  });

  it("整篇终检：断头段是硬伤，重复 / 空节 / 章首段是提示", () => {
    const md = [
      "## 建设背景与必要性",
      "",
      "、Teams 等云平台；多园区由 IT 支持。",
      "",
      "## 建设内容",
      "",
      "### 总体架构",
      "",
      "短。",
      "",
      "| 层次 | 组成 | 作用 |",
      "|---|---|---|",
      "| 主链 | PLC | 控制闭环 |",
    ].join("\n");
    const kinds = deterministicReviewFindings(md).map((f) => f.kind);
    expect(kinds).toContain("悬空残句");
    expect(kinds).toContain("章首段不合规");
    expect(kinds).toContain("空节");
    const broken = deterministicReviewFindings(md).find((f) => f.kind === "悬空残句")!;
    expect(broken.hard).toBe(true);
    expect(deterministicReviewFindings(md).find((f) => f.kind === "章首段不合规")!.hard).toBe(false);
  });

  it("干净的整篇 → 一条确定性发现都没有", () => {
    expect(deterministicReviewFindings(MD)).toEqual([]);
  });

  it("chapterBlocks 只按 `## ` 切章，`###` 归到所属章", () => {
    const blocks = chapterBlocks(MD);
    expect(blocks.map((b) => b.title)).toEqual(["建设背景与必要性", "建设目标与思路"]);
    expect(blocks[1]!.body).toContain("### 总体目标");
  });
});

describe("fixAccepted — 终检改动的四道关卡", () => {
  const before = [
    "## 建设背景与必要性",
    "",
    "这句前后矛盾的话要改掉。",
    "",
    "第二段是结论，逐字不许动；这段话还有一些铺垫与说明，用来把这一段的字数撑起来，避免判定被字数波动干扰。",
    "",
    "第三段也是结论，逐字不许动；同样补足一些说明文字，让段落长度稳定一些，方便断言。",
  ].join("\n");
  const anchors = ["这句前后矛盾的话要改掉"];

  it("只改被点名的段落 → 采纳", () => {
    const after = before.replace(
      "这句前后矛盾的话要改掉。",
      "本方案以感知与研判两条主线覆盖关键环节，管控重心转向事前预防。",
    );
    const r = fixAccepted({ before, after, anchors, missingBefore: [], missingAfter: [] });
    expect(r.reason).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it("动了没被点名的段落 → 不采纳", () => {
    const after = before
      .replace("这句前后矛盾的话要改掉。", "本方案以感知与研判两条主线覆盖关键环节。")
      .replace("第二段是结论，逐字不许动", "第二段被顺手润色了");
    const r = fixAccepted({ before, after, anchors, missingBefore: [], missingAfter: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("没被点名");
  });

  it("字数变化超过 ±25% → 不采纳", () => {
    const after = before.replace("这句前后矛盾的话要改掉。", "这一句被改得很长。".repeat(30));
    const r = fixAccepted({ before, after, anchors, missingBefore: [], missingAfter: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("±25%");
  });

  it("改后章首段仍不合格 → 不采纳", () => {
    const after = before.replace("这句前后矛盾的话要改掉。", "多园区由 IT 与厂商支持；纪要手工转写。");
    const r = fixAccepted({ before, after, anchors, missingBefore: [], missingAfter: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("章首段");
  });

  it("改后方案构件变少 → 不采纳；改后是空的也不采纳", () => {
    const r = fixAccepted({
      before,
      after: before.replace("这句前后矛盾的话要改掉。", "本方案以感知与研判两条主线覆盖关键环节。"),
      anchors,
      missingBefore: ["自建表格"],
      missingAfter: ["自建表格", "设计原则"],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("构件");
    expect(
      fixAccepted({ before, after: "   ", anchors, missingBefore: [], missingAfter: [] }).ok,
    ).toBe(false);
  });
});
