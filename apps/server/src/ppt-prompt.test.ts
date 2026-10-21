/**
 * @scene/server — PPT 提示词测试（变更表 #142 收尾、#144 升、#146 升：大纲质量要求 + 优化评审）
 *
 * 真跑暴露的问题：模型声明了版式却不给对应字段（`layout: "表格"` 没有 `table`），
 * 确定性层降级后就是一页只有两三条的空页。所以提示词里**必须**有这三条硬约束：
 * ① 版式与字段成套；② 每页写到 12 条以上；③ 给不出字段就用网格要点写满四块。
 * #144 再加一条：**图标清单原样给模型**（每页一个、每块一个、表头列一一对应），
 * 且写死"清单外一律兜底 `presentation`"——名字写错那处图标就没了。
 * 再加上重试提示要**点名到页**。
 * #146 再加：**大纲质量要求**（观点型标题 / 记忆点 / 信息量 / 数字可溯源 / 不重复 / 叙事顺序 /
 * 自包含 / 图标与版式，词表与阈值取自契约 `PPT_OUTLINE_QUALITY`）、**优化评审提示词**
 * （只输出 JSON、不许删内容、点对点解决问题）、以及"上一轮问题"作为反馈注入生成提示。
 * 这里锁住这些文案，免得以后改提示词又改丢。
 */

import { describe, it, expect } from "vitest";
import {
  PPT_DEFAULT_ICON,
  PPT_ICONS,
  PPT_LIMITS,
  PPT_OUTLINE_QUALITY,
  type PptIssue,
  type PptOutline,
  type PptPage,
} from "@scene/contract";
import {
  PPT_ICON_RULES,
  PPT_JSON_SPEC,
  PPT_LAYOUT_FIELD_RULES,
  PPT_OUTLINE_QUALITY_RULES,
  PPT_REVIEW_PROMPT_MARKER,
  buildPptOutlinePrompt,
  buildPptOutlineReviewPrompt,
  buildPptRetryPrompt,
} from "./ppt-prompt.js";

/** 首次提示的系统文案（模型真正读到的口径） */
const firstSystem = buildPptOutlinePrompt("solution", "智慧会议室", "# 正文").system;

/** 提示词里那段示例 JSON */
function examplePages(): PptPage[] {
  const slice = PPT_JSON_SPEC.join("\n").split("```")[1] ?? "";
  return (JSON.parse(slice) as { pages: PptPage[] }).pages;
}

describe("首次提示 —— 硬约束在文案里", () => {
  it("版式与字段成套：表格→table、流程阶段→stages、分层架构→layers 都点名", () => {
    expect(PPT_LAYOUT_FIELD_RULES.join("\n")).toContain("版式与字段必须成套");
    expect(firstSystem).toContain("写 `表格` ⇒ **必须**同时给合规 `table`");
    expect(firstSystem).toContain(`写 \`流程阶段\` ⇒ **必须**给 ${PPT_LIMITS.stages.min}–${PPT_LIMITS.stages.max} 个 \`stages\``);
    expect(firstSystem).toContain("每个都要有 `head` 与 `note`");
    expect(firstSystem).toContain("`分层架构` ⇒ **必须**给");
  });

  it("拿不准就用网格要点写满，别交空页（反例逐字在文案里）", () => {
    expect(firstSystem).toContain(`拿不准就一律用 \`网格要点\` 写满 ${PPT_LIMITS.blocks.count} 块`);
    expect(firstSystem).toContain("不要交一页只有两三条的空页");
  });

  it("每页 ≥12 条短句、不许编造数字、不写内部痕迹", () => {
    expect(firstSystem).toContain(`一页至少 ${PPT_LIMITS.targetSentencesPerPage} 条有效短句`);
    expect(firstSystem).toContain("空页、只有两三条的大页一律不合格");
    expect(firstSystem).toContain("不许编造");
    expect(firstSystem).toContain("不许出现「待客户提供」");
  });

  it("示例 JSON 里给了填满的「流程阶段」页与「表格」页（字段与限额对齐契约）", () => {
    const pages = examplePages();
    const flow = pages.find((p) => p.layout === "流程阶段")!;
    expect(flow.stages.length).toBeGreaterThanOrEqual(PPT_LIMITS.stages.min);
    for (const s of flow.stages) {
      expect(s.head).not.toBe("");
      expect(s.note).not.toBe(""); // 每个阶段都要有说明
      expect(Array.from(s.head).length).toBeLessThanOrEqual(PPT_LIMITS.stages.headChars);
      expect(Array.from(s.note).length).toBeLessThanOrEqual(PPT_LIMITS.stages.noteChars);
    }
    const table = pages.find((p) => p.layout === "表格")!;
    expect(table.table).not.toBeNull(); // 声明了表格就必须带 table
    expect(table.table!.rows.length).toBeGreaterThanOrEqual(4); // 示例是填满的，不许一行两列
    expect(table.table!.head.length).toBeLessThanOrEqual(PPT_LIMITS.table.maxCols);
    for (const row of table.table!.rows) expect(row).toHaveLength(table.table!.head.length);
  });

  it("示例里的每一页都过得了字段限额（模型照着抄不会超限）", () => {
    for (const p of examplePages()) {
      expect(Array.from(p.kicker).length).toBeLessThanOrEqual(PPT_LIMITS.kickerChars);
      expect(Array.from(p.title).length).toBeLessThanOrEqual(PPT_LIMITS.titleChars);
      expect(Array.from(p.highlight).length).toBeLessThanOrEqual(PPT_LIMITS.highlightChars);
      expect((p.chips ?? []).length).toBeLessThanOrEqual(PPT_LIMITS.chips.max);
    }
  });
});

describe("首次提示 —— 图标（#144）", () => {
  it("白名单**原样**贴在提示词里（模型只能从这 47 个里挑）", () => {
    for (const name of PPT_ICONS) expect(firstSystem, `清单里少了 ${name}`).toContain(name);
    expect(PPT_ICON_RULES.join("\n")).toContain(PPT_ICONS.join("、"));
    // 一个字母都不许改：整份清单是连续的一串
    expect(firstSystem).toContain(PPT_ICONS.join("、"));
  });

  it("写死兜底与「不许自创名字」，并说清每处该给几个图标", () => {
    expect(firstSystem).toContain(`选不出就用 \`${PPT_DEFAULT_ICON}\``);
    expect(firstSystem).toContain("不许自创名字");
    expect(firstSystem).toContain("每一页给一个 `icon`");
    expect(firstSystem).toContain("`table.icons` 与表头列一一对应");
    expect(firstSystem).toContain("一个字母都不要改");
  });

  it("按意思挑的对义提示在文案里（台账→file-text、网络→network、风险→alert-triangle）", () => {
    expect(firstSystem).toContain("台账/清单→file-text");
    expect(firstSystem).toContain("网络→network");
    expect(firstSystem).toContain("风险→alert-triangle");
  });

  it("示例 JSON 里每页 / 每块 / 每阶段都带图标，且名字都在白名单内", () => {
    const pages = examplePages();
    for (const p of pages) {
      expect(PPT_ICONS as readonly string[], `${p.layout} 页缺 icon`).toContain(p.icon);
      // 示例里每页只写自己用到的字段，缺的那些按空数组过（真实返回也一样）
      for (const b of p.blocks ?? []) expect(PPT_ICONS as readonly string[]).toContain(b.icon);
      for (const c of p.columns ?? []) expect(PPT_ICONS as readonly string[]).toContain(c.icon);
      for (const s of p.stages ?? []) expect(PPT_ICONS as readonly string[]).toContain(s.icon);
      for (const l of p.layers ?? []) expect(PPT_ICONS as readonly string[]).toContain(l.icon);
      for (const c of p.cards ?? []) expect(PPT_ICONS as readonly string[]).toContain(c.icon);
      if (p.table) {
        expect(p.table.icons).toHaveLength(p.table.head.length); // 与表头列一一对应
        for (const name of p.table.icons) expect(PPT_ICONS as readonly string[]).toContain(name);
      }
    }
  });
});

describe("重试提示 —— 点名到页", () => {
  const reason = "第 5 页只有 2 条（每页请写到 12 条以上）";
  const retry = buildPptRetryPrompt("solution", "智慧会议室", reason);

  it("把上一次卡在哪、要改什么逐字写进 system 与 user", () => {
    expect(retry.system).toContain(reason);
    expect(retry.user).toContain(reason);
    expect(retry.system).toContain("这次必须改掉的三件事");
    // #145：版面检查的内容类问题（图标不足 / 重点不突出）也要能在这一次重试里被修掉
    expect(retry.system).toContain("每处内容都要有图标、每页都要有重点");
    expect(retry.system).toContain(`每一页都写到 ${PPT_LIMITS.targetSentencesPerPage} 条以上有效短句`);
    expect(retry.system).toContain("不要再交一页只有两三条的空页");
    expect(retry.system).toContain("版式与字段必须成套"); // 重试也带上成套规则
    // 重试是整页重发，图标清单必须一起带上（否则新写的块只能回落兜底图标）
    expect(retry.system).toContain(PPT_ICONS.join("、"));
    expect(retry.system).toContain("不许自创名字");
  });

  it("没给原因时退回「解析不出来」的口径（旧路径不变）", () => {
    const plain = buildPptRetryPrompt("solution", "智慧会议室");
    expect(plain.system).toContain("上一次的输出无法解析为 JSON");
    expect(plain.user).toContain("## PPT：上一次的大纲不合要求，只按格式重发一次");
    expect(plain.user).toContain("只输出 JSON。");
  });
});

// ─── 大纲质量要求（变更表 #146） ──────────────────────────────

describe("首次提示 —— 大纲质量要求（#146）", () => {
  it("八条明确要求逐条在 system 里（不是几条原则）", () => {
    expect(PPT_OUTLINE_QUALITY_RULES.join("\n")).toContain("大纲质量要求");
    expect(firstSystem).toContain("### 1. 标题必须是观点，不是章节名");
    expect(firstSystem).toContain("### 2. 每页都要有记忆点");
    expect(firstSystem).toContain("### 3. 每页都要写满");
    expect(firstSystem).toContain("### 4. 数字只能来自报告正文");
    expect(firstSystem).toContain("### 5. 不许两页说同一件事");
    expect(firstSystem).toContain("### 6. 顺序：问题 → 方案 → 价值");
    expect(firstSystem).toContain("### 7. 自包含");
    expect(firstSystem).toContain("### 8. 图标与版式成套");
    expect(firstSystem).toContain("### 常见错误（❌ → ✅）");
  });

  it("词表与阈值取自契约（改契约就改提示词，两处不会走偏）", () => {
    expect(firstSystem).toContain(PPT_OUTLINE_QUALITY.weakTitleWords.slice(0, 8).join("、"));
    expect(firstSystem).toContain(`≤ ${PPT_OUTLINE_QUALITY.highlightChars} 字`);
    expect(firstSystem).toContain(`至少 ${PPT_OUTLINE_QUALITY.minSentencesPerPage} 条有效短句`);
    expect(firstSystem).toContain(
      `不许出现「${PPT_OUTLINE_QUALITY.selfContainedBanned.slice(0, 4).join(" / ")}`,
    );
  });

  it("观点型标题给了正反例（❌ 项目概述 → ✅ 一句判断）", () => {
    expect(firstSystem).toContain("❌「项目概述」「背景」「现状」「小结」「设备清单」");
    expect(firstSystem).toContain("✅「四条硬规则管住现场」");
    expect(firstSystem).toContain("❌ 标题写「项目概述」 → ✅ 标题写「四条硬规则管住现场」");
  });

  it("结构上到不了 12 条的版式写死「把字段写满」（判据才可满足）", () => {
    expect(firstSystem).toContain("`流程阶段` 每个阶段都要有 `note`（5 段 10 条）");
    expect(firstSystem).toContain("`数据卡片` 给满 4 张（8 条）");
  });

  it("重试提示也带全套质量要求", () => {
    const retry = buildPptRetryPrompt("solution", "智慧会议室", "第 5 页只有 2 条");
    expect(retry.system).toContain("### 4. 数字只能来自报告正文");
    expect(retry.system).toContain("标题必须是观点");
  });

  it("上一轮的问题作为反馈进生成的 system（没有就不加这一节）", () => {
    const issues: PptIssue[] = [
      { page: 3, code: "信息量不足", detail: "只有 6 条有效短句，少于 12 条" },
      { page: 5, code: "数字不在正文", detail: "数字「47」在报告正文里找不到" },
    ];
    const withFeedback = buildPptOutlinePrompt("solution", "智慧会议室", "# 正文", issues).system;
    expect(withFeedback).toContain("## 上一轮的问题（这一轮必须点对点改掉，别再犯）");
    expect(withFeedback).toContain("- 第 3 页信息量不足：只有 6 条有效短句，少于 12 条");
    expect(withFeedback).toContain("- 第 5 页数字不在正文：数字「47」在报告正文里找不到");
    expect(buildPptRetryPrompt("solution", "智慧会议室", "空页", issues).system).toContain(
      "- 第 3 页信息量不足",
    );
    expect(firstSystem).not.toContain("上一轮的问题");
  });
});

describe("优化评审提示 —— 只输出 JSON、不许删内容、点对点解决（#146）", () => {
  const outline: PptOutline = { pages: [] };
  const issues: PptIssue[] = [{ page: 3, code: "信息量不足", detail: "只有 6 条有效短句，少于 12 条" }];
  const review = buildPptOutlineReviewPrompt({
    kind: "solution",
    scenarioName: "智慧会议室",
    outline,
    issues,
    round: 2,
  });

  it("改稿纪律三条写死：只输出 JSON、不许删内容、点对点解决", () => {
    expect(review.system).toContain("只输出优化后的完整 JSON");
    expect(review.system).toContain("不要解释、不要 Markdown 围栏、不要前后缀");
    expect(review.system).toContain("不许删内容");
    expect(review.system).toContain("页数不得减少");
    expect(review.system).toContain("必须点对点解决下面列出的每一条问题");
  });

  it("system 里带全套质量要求 + schema 示例 + 图标白名单（改稿不能跑偏）", () => {
    expect(review.system).toContain("标题必须是观点");
    expect(review.system).toContain("至少 16 条有效短句");
    expect(review.system).toContain("版式与字段必须成套");
    expect(review.system).toContain(PPT_ICONS.join("、"));
    expect(review.system).toContain("五页完整示例");
    expect(review.system).toContain("不要 Markdown 代码围栏");
  });

  it("user 里带原大纲 JSON、问题清单、轮次与「只输出 JSON」", () => {
    expect(review.user).toContain(PPT_REVIEW_PROMPT_MARKER);
    expect(review.user).toContain("## 待优化的大纲（第 2 轮，JSON）");
    expect(review.user).toContain(JSON.stringify(outline));
    expect(review.user).toContain("## 必须解决的问题（共 1 条，逐条改掉）");
    expect(review.user).toContain("- 第 3 页信息量不足：只有 6 条有效短句，少于 12 条");
    expect(review.user.trimEnd().endsWith("只输出 JSON。")).toBe(true);
  });

  it("没有问题清单时也要求整体过一遍（第一轮就走的通道）", () => {
    const clean = buildPptOutlineReviewPrompt({
      kind: "solution",
      scenarioName: "智慧会议室",
      outline,
      issues: [],
      round: 1,
    });
    expect(clean.user).toContain("（上一轮没有判出问题）");
    expect(clean.user).toContain("整体按上面的《大纲质量要求》再过一遍");
  });
});
