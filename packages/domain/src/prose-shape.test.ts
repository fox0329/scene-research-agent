/**
 * @scene/domain — 报告正文形态测试（变更表 #138）
 *
 * 缺陷现场：压缩回炉只认「更短」与「构件不丢」，模型从句子中间删起，落盘的段落
 * 以残标点开头（真实生成物 `…construction.md` 第 7 行就是「、Teams 等云平台；…」）。
 * 这里锁住两件事：修得对（残句头切掉、正文变完整）与修得稳（幂等、不误伤合法开头）。
 */

import { describe, expect, it } from "vitest";
import { brokenProseHeads, repairProseHeads } from "./prose-shape.js";

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
