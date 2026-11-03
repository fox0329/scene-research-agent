/**
 * reflection-loop 领域层单测（MR2-T1，用例矩阵见 docs/开发计划.md「reflection-loop」）
 *
 * 覆盖五例：constraint 命中必改 / preference 与无锚点不进必改 / 复查仍违反如实报告不触发第三轮 /
 * 三路必改项并成一份清单 / dismissed 锚点即刻失效。另覆盖锚点三型 × 三 mode 边界。
 */

import { describe, expect, it } from "vitest";
import type { RequirementEntry } from "@scene/contract";
import {
  anchorViolated,
  decideRound,
  evaluateEntries,
  evaluateEntry,
  excludeDismissed,
  mergeFindings,
  type AnchorTarget,
} from "./reflection-loop.js";

function entry(partial: Partial<RequirementEntry> = {}): RequirementEntry {
  return {
    id: "e1",
    scenario_id: "s1",
    origin_scenario_id: null,
    scope: "scene",
    kind: "constraint",
    text: "不提国产替代",
    check_anchor: { type: "keyword", terms: ["国产", "替代"], mode: "命中即违反" },
    status: "active",
    confidence: "用户原话",
    sources: [],
    artifact_refs: [],
    created_at: "2026-11-04T00:00:00.000Z",
    updated_at: "2026-11-04T00:00:00.000Z",
    ...partial,
  };
}

const target = (text: string, metrics: Record<string, number> = {}): AnchorTarget => ({ text, metrics });

describe("锚点判定（三型 × 模式）", () => {
  it("keyword 命中即违反：出现禁忌词 = 违反", () => {
    expect(anchorViolated(
      { type: "keyword", terms: ["国产", "替代"], mode: "命中即违反" },
      target("方案中提及国产化替代路径"),
    )).toBe(true);
    expect(anchorViolated(
      { type: "keyword", terms: ["国产", "替代"], mode: "命中即违反" },
      target("重点在商用厨电"),
    )).toBe(false);
  });

  it("keyword 未出现即违反：要求的词没出现 = 违反；任一出现即合规（保守）", () => {
    const anchor = { type: "keyword" as const, terms: ["防汛", "排涝"], mode: "未出现即违反" as const };
    expect(anchorViolated(anchor, target("全文只讲成本"))).toBe(true);
    expect(anchorViolated(anchor, target("排涝能力是重点"))).toBe(false);
  });

  it("regex：命中/未出现两模式；非法正则不判违反", () => {
    expect(anchorViolated(
      { type: "regex", pattern: "国产|替代", mode: "命中即违反" },
      target("提到替代"),
    )).toBe(true);
    expect(anchorViolated(
      { type: "regex", pattern: "防汛", mode: "未出现即违反" },
      target("全文无关"),
    )).toBe(true);
    expect(anchorViolated(
      { type: "regex", pattern: "([", mode: "命中即违反" },
      target("任意文本"),
    )).toBe(false);
  });

  it("numeric：按度量值与 op 判定；度量缺失不判违反", () => {
    const anchor = { type: "numeric" as const, field: "正文字数", op: "<=" as const, value: 2000, mode: "命中即违反" as const };
    expect(anchorViolated(anchor, target("", { 正文字数: 1800 }))).toBe(false);
    expect(anchorViolated(anchor, target("", { 正文字数: 2500 }))).toBe(true);
    expect(anchorViolated(anchor, target("", {}))).toBe(false);
  });
});

describe("条目必改判定（用例矩阵）", () => {
  it("constraint 锚点命中 → 必改", () => {
    const v = evaluateEntry(entry(), target("方案提及国产替代"));
    expect(v).not.toBeNull();
    expect(v!.detail).toContain("国产");
  });

  it("explicit 未体现（未出现即违反）→ 必改", () => {
    const e = entry({
      kind: "explicit",
      text: "篇幅两页纸",
      check_anchor: { type: "numeric", field: "页数", op: "<=", value: 2, mode: "未出现即违反" },
    });
    const v = evaluateEntry(e, target("", { 页数: 5 }));
    expect(v).not.toBeNull();
    expect(v!.detail).toContain("页数");
  });

  it("preference 即使有锚点也不进必改（建议级）", () => {
    const e = entry({ kind: "preference" });
    expect(evaluateEntry(e, target("提到国产替代"))).toBeNull();
  });

  it("无锚点条目不进必改（零必改直接过）", () => {
    expect(evaluateEntry(entry({ check_anchor: null }), target("提到国产替代"))).toBeNull();
  });

  it("dismissed / superseded 条目锚点失效", () => {
    expect(evaluateEntry(entry({ status: "dismissed" }), target("国产替代"))).toBeNull();
    expect(evaluateEntry(entry({ status: "superseded" }), target("国产替代"))).toBeNull();
  });

  it("全量比对：多条目产出有序清单", () => {
    const a = entry({ id: "a" });
    const b = entry({ id: "b", check_anchor: { type: "keyword", terms: ["降价"], mode: "命中即违反" } });
    const violations = evaluateEntries([a, b], target("国产替代，并建议降价"));
    expect(violations.map((v) => v.entryId)).toEqual(["a", "b"]);
  });
});

describe("分轮停止（用例矩阵：复查仍违反如实报告）", () => {
  const v = entry();
  const violations = evaluateEntries([v], target("国产替代"));

  it("第 1 轮有违反 → 修订一轮", () => {
    expect(decideRound(1, violations)).toEqual({ action: "revise", round: 2 });
  });

  it("第 2 轮仍有违反 → 停止并如实报告（不触发第三轮）", () => {
    const decision = decideRound(2, violations);
    expect(decision.action).toBe("stop");
    if (decision.action === "stop") {
      expect(decision.reason).toBe("max-rounds");
      expect(decision.remaining).toHaveLength(1);
    }
  });

  it("复查干净 → stop/clean", () => {
    expect(decideRound(2, [])).toEqual({ action: "stop", reason: "clean", remaining: [] });
  });
});

describe("三路必改项合并（用例矩阵：一次差分）", () => {
  it("同条目同锚点交叉报告去重，不同条目保留", () => {
    const a = evaluateEntries([entry({ id: "a" })], target("国产替代"));
    const b = evaluateEntries([entry({ id: "a" }), entry({ id: "b", check_anchor: { type: "keyword", terms: ["降价"], mode: "命中即违反" } })], target("国产替代，建议降价"));
    const merged = mergeFindings(a, b, []);
    expect(merged).toHaveLength(2);
    expect(merged.map((v) => v.entryId).sort()).toEqual(["a", "b"]);
  });
});

describe("dismissed 过滤", () => {
  it("黑名单条目即刻失效，active 保留", () => {
    const kept = excludeDismissed(
      [entry({ id: "a" }), entry({ id: "b", status: "dismissed" })],
      new Set(["b"]),
    );
    expect(kept.map((e) => e.id)).toEqual(["a"]);
  });
});
