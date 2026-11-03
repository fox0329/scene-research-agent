/**
 * RequirementProfilePanel 组件测试（MR1-T5）
 *
 * 条目渲染走纯函数导出（renderToStaticMarkup 不跑 useEffect，数据加载由端点测试覆盖）：
 * 断言徽标/来源展开/升级降级按钮/Token 类名——「不藏深」的呈现口径。
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApiRequirementEntry } from "../api";
import { renderProfileEntry } from "./RequirementProfilePanel";

function entry(partial: Partial<ApiRequirementEntry> = {}): ApiRequirementEntry {
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
    sources: [{ type: "message", ref: "m1", snippet: "不要提国产替代的事" }],
    artifact_refs: [],
    created_at: "2026-11-04T00:00:00.000Z",
    updated_at: "2026-11-04T00:00:00.000Z",
    ...partial,
  };
}

describe("RequirementProfilePanel 条目渲染", () => {
  it("文本、类型/置信/作用域徽标全部可见", () => {
    const html = renderToStaticMarkup(
      renderProfileEntry(entry(), { expanded: false }),
    );
    expect(html).toContain("不提国产替代");
    expect(html).toContain("禁忌");
    expect(html).toContain("原话");
    expect(html).toContain("场景");
  });

  it("来源展开：用户原话片段直接可见（不藏深）", () => {
    const html = renderToStaticMarkup(
      renderProfileEntry(entry(), { expanded: true }),
    );
    expect(html).toContain("不要提国产替代的事");
  });

  it("场景条目给升级按钮、用户级条目给降级按钮", () => {
    const sceneHtml = renderToStaticMarkup(
      renderProfileEntry(entry(), { expanded: false }),
    );
    expect(sceneHtml).toContain("升级");
    const userHtml = renderToStaticMarkup(
      renderProfileEntry(entry({ scope: "user", scenario_id: null }), { expanded: false }),
    );
    expect(userHtml).toContain("降级");
    expect(userHtml).toContain("全局");
  });

  it("确认态：关闭按钮变「确认关闭？」二次确认", () => {
    const html = renderToStaticMarkup(
      renderProfileEntry(entry(), { expanded: false, confirmingId: "e1" }),
    );
    expect(html).toContain("确认关闭？");
  });

  it("非 active 状态如实展示（superseded 不冒充有效条目）", () => {
    const html = renderToStaticMarkup(
      renderProfileEntry(entry({ status: "superseded" }), { expanded: false }),
    );
    expect(html).toContain("superseded");
  });

  it("Token 合规：组件不写内联视觉值（样式一律走 CSS var()）", () => {
    const html = renderToStaticMarkup(
      renderProfileEntry(entry(), { expanded: true }),
    );
    expect(html).toContain("rp-entry");
    expect(html).toContain("rp-sources");
    expect(html).not.toContain("style=");
  });
});
