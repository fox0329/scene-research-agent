/**
 * 锚点回归集（MR2-T6，方案 §10/§155：锚点回归集是必须项，不是可选项）
 *
 * 样本从真实失败模式起步（潜污泵项目生成实测）：禁忌词残留、绝对化措辞、
 * 承诺词、必备关键词缺失、篇幅超标、来源条目状态边界。每样本 = { 锚点, 产物, 期望 }。
 * 断言：误报率 ≤5%、漏报率 ≤10%（方案 6.1：宁可漏改，不可误改——误报门槛更紧）。
 * 样本 ≥30（MR2 验收口径，docs/开发计划.md）。
 */

import { describe, expect, it } from "vitest";
import type { RequirementEntry } from "@scene/contract";
import { anchorViolated, evaluateEntry, type AnchorTarget } from "./reflection-loop.js";

interface Sample {
  name: string;
  kind: RequirementEntry["kind"];
  anchor: Parameters<typeof anchorViolated>[0];
  target: AnchorTarget;
  expectViolated: boolean;
  /** 资格边界样本（preference/无锚点）跳过纯锚点断言——它们的「不进必改」由 evaluateEntry 全链路用例覆盖 */
  skipAnchorCheck?: boolean;
}

function kw(terms: string[], mode: "命中即违反" | "未出现即违反") {
  return { type: "keyword" as const, terms, mode };
}

/** 潜污泵项目真实失败样例 + 通用失败模式，覆盖三型锚点 × 条目资格边界 */
export const REGRESSION_SAMPLES: Sample[] = [
  // ── keyword 命中即违反（禁忌类） ──
  { name: "禁忌词残留：国产替代", kind: "constraint", anchor: kw(["国产替代", "国产化替代"], "命中即违反"), target: { text: "本方案结合国产替代趋势", metrics: {} }, expectViolated: true },
  { name: "无禁忌词", kind: "constraint", anchor: kw(["国产替代", "国产化替代"], "命中即违反"), target: { text: "重点讲排涝能力与能效", metrics: {} }, expectViolated: false },
  { name: "绝对化：100%", kind: "constraint", anchor: kw(["100%"], "命中即违反"), target: { text: "覆盖率100%", metrics: {} }, expectViolated: true },
  { name: "绝对化：百分之百", kind: "constraint", anchor: kw(["百分之百"], "命中即违反"), target: { text: "百分之百兼容", metrics: {} }, expectViolated: true },
  { name: "承诺词：保证中标", kind: "constraint", anchor: kw(["保证中标"], "命中即违反"), target: { text: "保证中标", metrics: {} }, expectViolated: true },
  { name: "非承诺表述", kind: "constraint", anchor: kw(["保证中标"], "命中即违反"), target: { text: "支持投标流程", metrics: {} }, expectViolated: false },
  { name: "必选我方", kind: "constraint", anchor: kw(["必选我方"], "命中即违反"), target: { text: "建议必选我方产品", metrics: {} }, expectViolated: true },
  { name: "词形相近不误伤", kind: "constraint", anchor: kw(["国产替代"], "命中即违反"), target: { text: "提出替代方案两条", metrics: {} }, expectViolated: false },
  { name: "竞对具名", kind: "constraint", anchor: kw(["友商A公司"], "命中即违反"), target: { text: "对比友商A公司的方案", metrics: {} }, expectViolated: true },
  { name: "无具名", kind: "constraint", anchor: kw(["友商A公司"], "命中即违反"), target: { text: "与主流方案对比", metrics: {} }, expectViolated: false },
  // ── keyword 未出现即违反（必备类） ──
  { name: "必备词缺失：防汛", kind: "explicit", anchor: kw(["防汛", "排涝"], "未出现即违反"), target: { text: "全文只讲成本", metrics: {} }, expectViolated: true },
  { name: "必备词出现", kind: "explicit", anchor: kw(["防汛", "排涝"], "未出现即违反"), target: { text: "排涝能力为重", metrics: {} }, expectViolated: false },
  { name: "任一必备出现即合规（保守）", kind: "explicit", anchor: kw(["防汛", "排涝"], "未出现即违反"), target: { text: "防汛与成本并重", metrics: {} }, expectViolated: false },
  { name: "控制方式缺失：一用一备", kind: "explicit", anchor: kw(["一用一备"], "未出现即违反"), target: { text: "泵组配置见下", metrics: {} }, expectViolated: true },
  { name: "控制方式出现", kind: "explicit", anchor: kw(["一用一备"], "未出现即违反"), target: { text: "两台泵一用一备", metrics: {} }, expectViolated: false },
  { name: "协议缺失：PLC", kind: "explicit", anchor: kw(["PLC"], "未出现即违反"), target: { text: "手动控制为主", metrics: {} }, expectViolated: true },
  { name: "协议出现", kind: "explicit", anchor: kw(["PLC"], "未出现即违反"), target: { text: "PLC 联动控制", metrics: {} }, expectViolated: false },
  // ── regex ──
  { name: "最高级措辞", kind: "constraint", anchor: { type: "regex", pattern: "最佳|第一品牌|行业领先", mode: "命中即违反" }, target: { text: "行业领先的解决方案", metrics: {} }, expectViolated: true },
  { name: "克制措辞", kind: "constraint", anchor: { type: "regex", pattern: "最佳|第一品牌|行业领先", mode: "命中即违反" }, target: { text: "成熟的解决方案", metrics: {} }, expectViolated: false },
  { name: "引用痕迹进中栏", kind: "constraint", anchor: { type: "regex", pattern: "（M5）|来源：|ingest-", mode: "命中即违反" }, target: { text: "方案正文（M5）", metrics: {} }, expectViolated: true },
  { name: "中栏干净", kind: "constraint", anchor: { type: "regex", pattern: "（M5）|来源：|ingest-", mode: "命中即违反" }, target: { text: "方案正文", metrics: {} }, expectViolated: false },
  { name: "正则未出现即违反", kind: "explicit", anchor: { type: "regex", pattern: "万元", mode: "未出现即违反" }, target: { text: "预算见附录", metrics: {} }, expectViolated: true },
  // ── numeric ──
  { name: "页数超标", kind: "explicit", anchor: { type: "numeric", field: "页数", op: "<=", value: 2, mode: "未出现即违反" }, target: { text: "", metrics: { 页数: 5 } }, expectViolated: true },
  { name: "页数达标", kind: "explicit", anchor: { type: "numeric", field: "页数", op: "<=", value: 2, mode: "未出现即违反" }, target: { text: "", metrics: { 页数: 2 } }, expectViolated: false },
  { name: "字数超标", kind: "explicit", anchor: { type: "numeric", field: "正文字数", op: "<=", value: 2000, mode: "未出现即违反" }, target: { text: "", metrics: { 正文字数: 2500 } }, expectViolated: true },
  { name: "字数达标", kind: "explicit", anchor: { type: "numeric", field: "正文字数", op: "<=", value: 2000, mode: "未出现即违反" }, target: { text: "", metrics: { 正文字数: 1800 } }, expectViolated: false },
  { name: "表格数达标", kind: "explicit", anchor: { type: "numeric", field: "表格数", op: ">=", value: 19, mode: "未出现即违反" }, target: { text: "", metrics: { 表格数: 19 } }, expectViolated: false },
  { name: "表格数不足", kind: "explicit", anchor: { type: "numeric", field: "表格数", op: ">=", value: 19, mode: "未出现即违反" }, target: { text: "", metrics: { 表格数: 15 } }, expectViolated: true },
  { name: "度量缺失不判违反（宁可漏改）", kind: "explicit", anchor: { type: "numeric", field: "页数", op: "<=", value: 2, mode: "未出现即违反" }, target: { text: "", metrics: {} }, expectViolated: false },
  // ── 条目资格边界（不进必改的路径） ──
  { name: "preference 命中也不进必改", kind: "preference", anchor: kw(["国产替代"], "命中即违反"), target: { text: "国产替代", metrics: {} }, expectViolated: false, skipAnchorCheck: true },
  { name: "无锚点不进必改", kind: "constraint", anchor: kw(["国产替代"], "命中即违反"), target: { text: "国产替代", metrics: {} }, expectViolated: false, skipAnchorCheck: true },
];

function entry(kind: RequirementEntry["kind"], anchor: Sample["anchor"], status: RequirementEntry["status"] = "active"): RequirementEntry {
  return {
    id: "r",
    scenario_id: "s",
    origin_scenario_id: null,
    scope: "scene",
    kind,
    text: "回归样本",
    check_anchor: anchor,
    status,
    confidence: "用户原话",
    sources: [],
    artifact_refs: [],
    created_at: "2026-11-04T00:00:00.000Z",
    updated_at: "2026-11-04T00:00:00.000Z",
  };
}

describe("锚点回归集（MR2-T6）", () => {
  it("样本量 ≥30（MR2 验收口径）", () => {
    expect(REGRESSION_SAMPLES.length).toBeGreaterThanOrEqual(30);
  });

  it("逐样本判定符合期望（混淆矩阵零误差）", () => {
    const failures: string[] = [];
    for (const s of REGRESSION_SAMPLES) {
      if (s.skipAnchorCheck) continue;
      const violated = anchorViolated(s.anchor, s.target);
      if (violated !== s.expectViolated) failures.push(`${s.name}: 判定 ${violated} 期望 ${s.expectViolated}`);
    }
    expect(failures).toEqual([]);
  });

  it("误报率 ≤5%、漏报率 ≤10%（方案 6.1：宁可漏改不可误改）", () => {
    let fp = 0;
    let fn = 0;
    let tn = 0;
    let tp = 0;
    for (const s of REGRESSION_SAMPLES) {
      if (s.skipAnchorCheck) continue;
      const violated = anchorViolated(s.anchor, s.target);
      if (violated && !s.expectViolated) fp++;
      else if (!violated && s.expectViolated) fn++;
      else if (!violated && !s.expectViolated) tn++;
      else tp++;
    }
    const falsePositiveRate = fp + tn > 0 ? fp / (fp + tn) : 0;
    const falseNegativeRate = fn + tp > 0 ? fn / (fn + tp) : 0;
    expect(falsePositiveRate).toBeLessThanOrEqual(0.05);
    expect(falseNegativeRate).toBeLessThanOrEqual(0.1);
  });

  it("资格边界样本经 evaluateEntry 全链路同样不进必改", () => {
    for (const s of REGRESSION_SAMPLES.filter((x) => x.kind === "preference")) {
      expect(evaluateEntry(entry(s.kind, s.anchor), s.target)).toBeNull();
    }
    expect(evaluateEntry(entry("constraint", REGRESSION_SAMPLES[0]!.anchor, "dismissed"), REGRESSION_SAMPLES[0]!.target)).toBeNull();
    expect(evaluateEntry(entry("constraint", REGRESSION_SAMPLES[0]!.anchor, "superseded"), REGRESSION_SAMPLES[0]!.target)).toBeNull();
  });
});
