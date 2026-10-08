/**
 * @scene/domain — 报告正文形态测试（变更表 #138 / #139）
 *
 * 缺陷现场（#138）：压缩回炉只认「更短」与「构件不丢」，模型从句子中间删起，落盘的段落
 * 以残标点开头（真实生成物 `…construction.md` 第 7 行就是「、Teams 等云平台；…」）。
 * 这里锁住两件事：修得对（残句头切掉、正文变完整）与修得稳（幂等、不误伤合法开头）。
 *
 * 变更表 #139：篇幅改为"超标的章整章回炉重写"，压缩链路退场；本模块新增
 * `firstProseParagraph`（第一段正文）与 `leadParagraphIssue`（章首段是不是总纲）。
 */

import { describe, expect, it } from "vitest";
import {
  brokenProseHeads,
  repairProseHeads,
  firstProseParagraph,
  leadParagraphIssue,
} from "./prose-shape.js";

describe("brokenProseHeads — 认断头段", () => {
  it("认得出以残标点开头的正文段落，并返回原文片段", () => {
    const para = "、Teams 等云平台；多园区由 IT、弱电运维（常含外包）与厂商支持；纪要手工。";
    expect(brokenProseHeads(`## 建设背景与必要性\n\n${para}\n\n下一段是好的。`)).toEqual([para]);
  });

  it("正常段落、标题、表格行、分隔线、引用都不算断头段", () => {
    const md = [
      "# 、标题不算正文",
      "",
      "这是正常的正文段落。",
      "",
      "| 、列 | 值 |",
      "|---|---|",
      "| a | b |",
      "",
      "---",
      "",
      "> 、引用行不算正文",
    ].join("\n");
    expect(brokenProseHeads(md)).toEqual([]);
  });

  it("「（一）正文」这类合法开头不误伤（（、「、*、- 都不是残标点）", () => {
    const md = ["（一）先说明边界。", "", "「引号开头」也是合法写法。", "", "- 列表行。", "", "* 星号列表。"].join(
      "\n",
    );
    expect(brokenProseHeads(md)).toEqual([]);
    expect(repairProseHeads(md)).toEqual({ markdown: md, repaired: 0 });
  });

  it("段内的列表行不影响判定：只看该段首字符", () => {
    const md = "本段结论如下：\n- 第一条；\n- 第二条。";
    expect(brokenProseHeads(md)).toEqual([]);
    expect(repairProseHeads(md).repaired).toBe(0);
  });
});

describe("repairProseHeads — 切掉残句头", () => {
  it("残句头切到第一个句末标点（含），后面的正文保留", () => {
    const { markdown, repaired } = repairProseHeads("、Teams 等云平台；多园区由 IT 支持。");
    expect(markdown).toBe("多园区由 IT 支持。");
    expect(repaired).toBe(1);
  });

  it("句末标点就在段尾 → 只剥掉开头的残标点串，整段不丢", () => {
    expect(repairProseHeads("，下一句。")).toEqual({ markdown: "下一句。", repaired: 1 });
    expect(repairProseHeads("：只有一句。")).toEqual({ markdown: "只有一句。", repaired: 1 });
  });

  it("切完什么都不剩 → 丢掉这一段，段落之间的空行结构不乱", () => {
    const md = "前一段完好。\n\n、，；\n\n后一段完好。";
    expect(repairProseHeads(md)).toEqual({
      markdown: "前一段完好。\n\n后一段完好。",
      repaired: 1,
    });
    // 断头段在末尾时也不留悬空空行
    expect(repairProseHeads("前一段完好。\n\n、。").markdown).toBe("前一段完好。");
  });

  it("只修断头段：标题、表格、分隔线、引用与正常段落一字不动", () => {
    const md = [
      "## 建设背景与必要性",
      "",
      "、Teams 等云平台；多园区由 IT 支持。",
      "",
      "正常的结论句一字不动。",
      "",
      "| 、表头 | 值 |",
      "|---|---|",
      "| a | b |",
      "",
      "---",
      "",
      "> 、引用一字不动",
    ].join("\n");
    const { markdown, repaired } = repairProseHeads(md);
    expect(repaired).toBe(1);
    expect(markdown).toBe(md.replace("、Teams 等云平台；", ""));
    expect(markdown).toContain("正常的结论句一字不动。");
    expect(markdown).toContain("| 、表头 | 值 |");
    expect(markdown).toContain("> 、引用一字不动");
  });

  it("计数正确：两处断头段就是 2", () => {
    const md = "、第一句残；修好第一句。\n\n中间正常。\n\n，第二句残；修好第二句。";
    const { markdown, repaired } = repairProseHeads(md);
    expect(repaired).toBe(2);
    expect(markdown).toBe("修好第一句。\n\n中间正常。\n\n修好第二句。");
  });

  it("幂等：修完再修一次 repaired = 0，正文不变", () => {
    const md = "、Teams 等云平台；多园区由 IT 支持。\n\n，下一句。\n\n、，；\n\n正常段落。";
    const once = repairProseHeads(md);
    // 两处切残句头 + 一处切完为空丢掉 = 3
    expect(once.repaired).toBe(3);
    expect(repairProseHeads(once.markdown)).toEqual({ markdown: once.markdown, repaired: 0 });
  });

  it("没有断头段时原样返回（含空串与多空行）", () => {
    expect(repairProseHeads("")).toEqual({ markdown: "", repaired: 0 });
    const md = "第一段。\n\n第二段。";
    expect(repairProseHeads(md)).toEqual({ markdown: md, repaired: 0 });
  });
});

describe("firstProseParagraph — 取第一段正文（变更表 #139）", () => {
  it("跳过 `#` 标题、表格、`---` 与引用，返回第一段正文", () => {
    const md = [
      "# 智慧会议室建设工作方案",
      "",
      "## 建设背景与必要性",
      "",
      "| 层次 | 组成 | 作用 |",
      "|---|---|---|",
      "| 主链 | PLC | 控制闭环 |",
      "",
      "---",
      "",
      "> 引用行不算正文",
      "",
      "智慧会议室分散在总部与各园区，跨地域协同靠云平台。",
      "",
      "第二段不该被取到。",
    ].join("\n");
    expect(firstProseParagraph(md)).toBe("智慧会议室分散在总部与各园区，跨地域协同靠云平台。");
  });

  it("章级用法：跳过 `###` 小节标题，取该章第一段话", () => {
    const md = ["### 现状特征与提升空间", "", "三个特征决定天花板。", "", "第二段。"].join("\n");
    expect(firstProseParagraph(md)).toBe("三个特征决定天花板。");
  });

  it("段内多行原样保留（按空行分段）", () => {
    const md = "# 标题\n\n第一行\n第二行\n\n下一段。";
    expect(firstProseParagraph(md)).toBe("第一行\n第二行");
  });

  it("空串与只有标题 / 只有表格时返回空串", () => {
    expect(firstProseParagraph("")).toBe("");
    expect(firstProseParagraph("# 只有标题\n\n## 还是没有正文")).toBe("");
    expect(firstProseParagraph("| 列 | 值 |\n|---|---|\n| a | b |")).toBe("");
    expect(firstProseParagraph("---\n\n> 只有引用")).toBe("");
  });

  it("与 repairProseHeads 配套：修好的断头段就是可取到的第一段正文", () => {
    const broken = "## 建设背景与必要性\n\n、Teams 等云平台；多园区由 IT 支持。";
    expect(firstProseParagraph(repairProseHeads(broken).markdown)).toBe("多园区由 IT 支持。");
  });
});

describe("leadParagraphIssue — 章首段是不是总纲（变更表 #139）", () => {
  it("完整、自足、不超过 120 字的总纲段合格", () => {
    expect(leadParagraphIssue("智慧会议室分散在总部与各园区，跨地域协同靠云平台。")).toBeNull();
    expect(leadParagraphIssue("现场巡检今天仍靠人工记录，数据分散在三个系统里。")).toBeNull();
    // 空段落不在这里报（交给「缺章 / 缺小节」）
    expect(leadParagraphIssue("")).toBeNull();
    expect(leadParagraphIssue("   ")).toBeNull();
  });

  it("超过 120 字 → 报「超过 120 字」", () => {
    const long = "本段说明现场处境。" + "补充说明现场情况与处置口径".repeat(12);
    expect(leadParagraphIssue(long)).toContain("超过 120 字");
  });

  it("以分号列举开头（第一个分句一收尾就是「；」）→ 报「分号列举」", () => {
    expect(leadParagraphIssue("多园区由 IT、弱电运维（常含外包）与厂商支持；纪要手工或录音转写。")).toBe(
      "以分号列举开头",
    );
  });

  it("以残标点开头（半句开头）→ 报「半句开头」", () => {
    expect(leadParagraphIssue("、Teams 等云平台；多园区由 IT 支持。")).toBe("以残标点开头（半句开头）");
    expect(leadParagraphIssue("，下一句。")).toBe("以残标点开头（半句开头）");
  });

  it("首句用逗号断开、后面才出现分号的总纲段不误伤", () => {
    expect(
      leadParagraphIssue("智慧会议室分散在总部与各园区，跨地域协同靠云平台；多园区由 IT 支持。"),
    ).toBeNull();
  });
});
