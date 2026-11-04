/**
 * clarify-policy 单测（MR3-T1，方案 6.2 阈值裁决口径）
 *
 * 覆盖：三触发源各自命中、会话上限拦、别再问拦、答案存在性丢弃、关键词抽取。
 */

import { describe, expect, it } from "vitest";
import {
  answerExistsInProfile,
  extractKeywords,
  shouldAskClarify,
  type ClarifyContext,
} from "./clarify-policy.js";

function ctx(partial: Partial<ClarifyContext> = {}): ClarifyContext {
  return {
    conflictPairs: [],
    missingDimensions: [],
    recentCorrections: [],
    askedCount: 0,
    muted: false,
    ...partial,
  };
}

describe("阈值裁决（方案 6.2）", () => {
  it("冲突对 ≥1 → 问（原因 conflict）", () => {
    const d = shouldAskClarify(ctx({ conflictPairs: [["预算最小化", "上高端配置"]] }));
    expect(d.shouldAsk).toBe(true);
    expect(d.reasons).toEqual(["conflict"]);
  });

  it("维度缺失 ≥2 → 问（原因 dimension-gap）；缺 1 个不问", () => {
    expect(shouldAskClarify(ctx({ missingDimensions: ["只有缺一个"] })).shouldAsk).toBe(false);
    const d = shouldAskClarify(ctx({ missingDimensions: ["缺a", "缺b"] }));
    expect(d.shouldAsk).toBe(true);
    expect(d.reasons).toEqual(["dimension-gap"]);
  });

  it("近 3 轮纠偏 ≥2 → 问（原因 correction）：纠偏比维度缺失更值得问", () => {
    const d = shouldAskClarify(ctx({ recentCorrections: ["rewrite", "undo"] }));
    expect(d.shouldAsk).toBe(true);
    expect(d.reasons).toEqual(["correction"]);
  });

  it("会话已问 2 次 → 拦（即使有冲突对）", () => {
    const d = shouldAskClarify(ctx({ conflictPairs: [["a", "b"]], askedCount: 2 }));
    expect(d.shouldAsk).toBe(false);
  });

  it("用户选「别再问」→ 拦", () => {
    const d = shouldAskClarify(ctx({ conflictPairs: [["a", "b"]], muted: true }));
    expect(d.shouldAsk).toBe(false);
  });

  it("多触发源并报", () => {
    const d = shouldAskClarify(
      ctx({
        conflictPairs: [["a", "b"]],
        missingDimensions: ["x", "y"],
        recentCorrections: ["undo", "rewrite", "undo"],
      }),
    );
    expect(d.reasons).toEqual(["conflict", "dimension-gap", "correction"]);
  });

  it("无触发源 → 不问", () => {
    expect(shouldAskClarify(ctx()).shouldAsk).toBe(false);
  });
});

describe("答案存在性检查（评审修订 + #365 覆盖率修正）", () => {
  it("问题与条目高重合（覆盖率达标）→ 答案已存在 → 丢弃", () => {
    expect(
      answerExistsInProfile("预算控制在 50 万以内这样可以吗？", [
        { text: "预算控制在 50 万以内" },
      ]),
    ).toBe(true);
  });

  it("单 2-gram 偶然命中不判存在（#365：覆盖率阈值 max(3, 40%)）", () => {
    // 条目 10 个 2-gram，问句只含「对比」一个 → 不拦
    expect(
      answerExistsInProfile("两版思路你想对比哪方面？", [
        { text: "每张表都要有巡检耗时对比" },
      ]),
    ).toBe(false);
  });

  it("画像查不到 → 不丢（材料库侧由应用层补查）", () => {
    expect(
      answerExistsInProfile("数据要接进哪个平台？", [
        { text: "重点讲防汛" },
      ]),
    ).toBe(false);
  });

  it("提不出关键词的问题不算答案已存在", () => {
    expect(answerExistsInProfile("??", [])).toBe(false);
  });
});

describe("关键词抽取", () => {
  it("去停用词、短词过滤、截断 6 个", () => {
    const kws = extractKeywords("请问预算大概是多少？数据要接进哪个平台还是本地部署？");
    expect(kws).not.toContain("请问");
    expect(kws).not.toContain("多少");
    expect(kws.length).toBeLessThanOrEqual(6);
    expect(kws.some((k) => k.includes("预算"))).toBe(true);
  });
});
