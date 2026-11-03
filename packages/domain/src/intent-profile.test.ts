/**
 * intent-profile 领域层单测（MR1-T3，用例矩阵见 docs/开发计划.md「领域层用例矩阵」）
 *
 * 覆盖九例：相似合并 / 冲突取代 / 置信铁律 / 黑名单 / undo 信号 / 并发手编赢 /
 * 升级判定 / 降级溯源（repo 侧已测，这里测归一化口径）/ dimension_gap 不加列。
 */

import { describe, expect, it } from "vitest";
import type { RequirementEntry } from "@scene/contract";
import {
  applyUserEditWins,
  buildDimensionGapEntry,
  isBlacklisted,
  normRequirementText,
  resolveIncoming,
  requirementSimilarity,
  undoReviewTargets,
  upgradeCandidates,
} from "./intent-profile.js";

function entry(partial: Partial<RequirementEntry>): RequirementEntry {
  return {
    id: "e1",
    scenario_id: "sc-1",
    origin_scenario_id: null,
    scope: "scene",
    kind: "explicit",
    text: "篇幅两页纸",
    check_anchor: null,
    status: "active",
    confidence: "用户原话",
    sources: [{ type: "message", ref: "m1", snippet: "两页纸" }],
    artifact_refs: [],
    created_at: "2026-11-03T10:00:00.000Z",
    updated_at: "2026-11-03T10:00:00.000Z",
    ...partial,
  };
}

describe("归一化与相似度", () => {
  it("全半角/空白/标点/大小写归一后同文", () => {
    expect(normRequirementText("篇幅：两页纸！")).toBe(normRequirementText("篇幅两页纸"));
    expect(normRequirementText("No 国产替代")).toBe(normRequirementText("no国产替代"));
  });

  it("同义不同文相似度高、无关句相似度低", () => {
    expect(requirementSimilarity("篇幅控制在两页纸以内", "篇幅两页纸以内")).toBeGreaterThanOrEqual(0.4);
    expect(requirementSimilarity("篇幅两页纸", "重点讲防汛能力")).toBeLessThan(0.4);
  });
});

describe("抽取条目处置判定", () => {
  it("相似合并：同义不同文合并一条，来源追加", () => {
    const existing = entry({ id: "old", sources: [{ type: "message", ref: "m1", snippet: "两页纸" }] });
    const incoming = entry({
      id: "new",
      text: "篇幅控制在两页纸以内",
      sources: [{ type: "message", ref: "m2", snippet: "篇幅两页以内" }],
      updated_at: "2026-11-03T11:00:00.000Z",
    });
    const out = resolveIncoming(incoming, { existing: [existing], dismissedTexts: [] });
    expect(out.action).toBe("merged");
    if (out.action === "merged") {
      expect(out.entry.id).toBe("old"); // 以旧条目为底
      expect(out.entry.sources.map((s) => s.ref).sort()).toEqual(["m1", "m2"]); // 来源追加
    }
  });

  it("冲突取代：正面后接负面，新条目进 superseded 分支并带旧条目 id", () => {
    const existing = entry({ id: "old", text: "篇幅两页纸", confidence: "用户原话" });
    const incoming = entry({
      id: "new",
      text: "篇幅不要两页纸，要五页",
      confidence: "用户原话",
      updated_at: "2026-11-03T11:00:00.000Z",
    });
    const out = resolveIncoming(incoming, { existing: [existing], dismissedTexts: [] });
    expect(out.action).toBe("superseded");
    if (out.action === "superseded") {
      expect(out.entry.id).toBe("new");
      expect(out.supersededIds).toEqual(["old"]);
    }
  });

  it("数值冲突：同主题数字变了也算取代", () => {
    const existing = entry({ text: "预算控制在 50 万以内", confidence: "用户原话" });
    const incoming = entry({ text: "预算控制在 80 万以内", confidence: "用户原话" });
    const out = resolveIncoming(incoming, { existing: [existing], dismissedTexts: [] });
    expect(out.action).toBe("superseded");
  });

  it("置信铁律：AI推断不顶用户原话，即使语义相反", () => {
    const existing = entry({ text: "篇幅两页纸", confidence: "用户原话" });
    const incoming = entry({ text: "篇幅不要两页纸", confidence: "AI推断" });
    const out = resolveIncoming(incoming, { existing: [existing], dismissedTexts: [] });
    expect(out.action).toBe("rejected");
    if (out.action === "rejected") expect(out.reason).toBe("low-confidence");
  });

  it("黑名单：dismissed 同文新事件不再抽回", () => {
    const incoming = entry({ text: "用户不要的条目！" });
    const out = resolveIncoming(incoming, {
      existing: [],
      dismissedTexts: ["用户不要的条目"],
    });
    expect(out.action).toBe("rejected");
    if (out.action === "rejected") expect(out.reason).toBe("blacklisted");
  });

  it("无关话题：新增独立条目", () => {
    const existing = entry({ text: "篇幅两页纸" });
    const incoming = entry({ text: "重点讲防汛能力", kind: "explicit" });
    const out = resolveIncoming(incoming, { existing: [existing], dismissedTexts: [] });
    expect(out.action).toBe("kept");
  });

  it("不同 kind 不算同维度（preference 与 explicit 互不合并）", () => {
    const existing = entry({ kind: "explicit", text: "篇幅两页纸" });
    const incoming = entry({ kind: "preference", text: "篇幅两页纸" });
    const out = resolveIncoming(incoming, { existing: [existing], dismissedTexts: [] });
    expect(out.action).toBe("kept");
  });
});

describe("undo 信号与并发", () => {
  it("undo 只打待复核引用，不生成条目", () => {
    const a = entry({ id: "a", artifact_refs: ["row-1"] });
    const b = entry({ id: "b", artifact_refs: ["row-2"] });
    const hints = undoReviewTargets([a, b], ["row-1"]);
    expect(hints).toEqual([{ entryId: "a", reason: "undo" }]);
  });

  it("并发：手编与抽取同时写 → 手编赢，抽取只追加来源", () => {
    const current = entry({
      id: "c",
      text: "用户手编的口径",
      status: "active",
      sources: [{ type: "message", ref: "m1", snippet: "旧来源" }],
      artifact_refs: ["row-1"],
    });
    const merged = applyUserEditWins(
      current,
      [{ type: "message", ref: "m9", snippet: "抽取新来源" }],
      ["row-2"],
    );
    expect(merged.text).toBe("用户手编的口径"); // 文本不被抽取覆盖
    expect(merged.status).toBe("active");
    expect(merged.sources.map((s) => s.ref)).toEqual(["m1", "m9"]);
    expect(merged.artifact_refs).toEqual(["row-1", "row-2"]);
  });
});

describe("升级判定与 dimension_gap", () => {
  it("升级：同文 ≥2 场景 active 进候选；确认前 scope 不变（函数只判定不改写）", () => {
    const a = entry({ id: "a", scenario_id: "s1", text: "重点讲防汛" });
    const b = entry({ id: "b", scenario_id: "s2", text: "重点讲防汛" });
    const c = entry({ id: "c", scenario_id: "s1", text: "只出现一次" });
    const dismissed = entry({ id: "d", scenario_id: "s3", text: "重点讲防汛", status: "superseded" });
    const candidates = upgradeCandidates([a, b, c, dismissed]);
    expect(candidates.map((e) => e.id)).toEqual(["a"]);
    expect(candidates[0]!.scope).toBe("scene"); // 确认前 scope 不动
  });

  it("用户级条目不参与升级判定（它已经升级过了）", () => {
    const user = entry({ id: "u", scope: "user", scenario_id: null, text: "重点讲防汛" });
    expect(upgradeCandidates([user])).toEqual([]);
  });

  it("dimension_gap 条目：锚点空、出处空，不产生任何加列动作", () => {
    const gap = buildDimensionGapEntry(
      entry({ id: "g", kind: "explicit", check_anchor: { type: "keyword", terms: ["x"], mode: "命中即违反" }, artifact_refs: ["row-1"] }),
      { type: "message", ref: "m1", snippet: "没提成本" },
    );
    expect(gap.kind).toBe("dimension_gap");
    expect(gap.check_anchor).toBeNull();
    expect(gap.artifact_refs).toEqual([]); // 恒空 → 不会有改表动作
    expect(gap.sources).toHaveLength(1);
  });
});

describe("isBlacklisted 边界", () => {
  it("标点与全半角差异不影响黑名单命中", () => {
    expect(isBlacklisted("不提国产替代", ["不提：国产替代！"])).toBe(true);
    expect(isBlacklisted("不提国产替代", ["不提国产化替代"])).toBe(false);
  });
});
