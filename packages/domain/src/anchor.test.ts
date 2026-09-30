import { describe, it, expect } from "vitest";
import type { ScenarioBrief, AnchorRow } from "@scene/contract";
import {
  anchorFixedRows,
  anchorRequiredRows,
  anchorConfirmRows,
  buildAnchorSkeleton,
  anchorFromBrief,
  briefDraftHints,
  descriptionFromAnchor,
  anchorCompletion,
  mergeAnchorRows,
} from "./anchor.js";

const brief = (o: Partial<ScenarioBrief> = {}): ScenarioBrief => ({
  scenario_id: "s1",
  scene_name: "智慧水务",
  intent: "想搞清楚这个场景值不值得进",
  customer_hint: "市政水务集团",
  region_hint: "华东某市",
  scope_hint: "只看出厂到管网",
  audience: "给领导看",
  deadline: "两周",
  raw_text: "智慧水务 想搞清楚值不值得进",
  created_at: "2026-09-25T00:00:00.000Z",
  updated_at: "2026-09-25T00:00:00.000Z",
  ...o,
});

describe("anchor — 固定行取自注册表", () => {
  it("表1-1 有 12 个固定行，必填 9 个，L1 必确认 6 个", () => {
    expect(anchorFixedRows()).toHaveLength(12);
    expect(anchorRequiredRows()).toHaveLength(9);
    expect(anchorConfirmRows()).toHaveLength(6);
    expect(anchorConfirmRows().map((r) => r.key)).toEqual([
      "customer_type",
      "scope_in",
      "scope_out",
      "use_case",
      "entry_point",
      "value_proposition",
    ]);
  });
});

describe("anchor — 骨架与预填", () => {
  it("骨架 12 行，仅场景名称填好且标用户补充", () => {
    const rows = buildAnchorSkeleton("智慧水务");
    expect(rows).toHaveLength(12);
    const name = rows.find((r) => r.item === "场景名称");
    expect(name?.content).toBe("智慧水务");
    expect(name?.source_type).toBe("用户补充");
    expect(rows.filter((r) => r.content !== "").length).toBe(1);
  });

  it("用户诉求只预填可直接对应的三项，其余留给起草", () => {
    const rows = anchorFromBrief(brief());
    expect(rows.map((r) => r.item)).toEqual(["客户类型/行业", "覆盖什么", "核心用途"]);
    expect(rows.every((r) => r.source === "用户诉求")).toBe(true);
    expect(rows.every((r) => r.source_type === "用户补充")).toBe(true);
  });

  it("线索为空的项不预填", () => {
    const rows = anchorFromBrief(brief({ customer_hint: null, scope_hint: "  " }));
    expect(rows.map((r) => r.item)).toEqual(["核心用途"]);
  });

  it("起草线索为一段人话，且不含系统推测", () => {
    const hints = briefDraftHints(brief()).join("\n");
    expect(hints).toContain("场景名称：智慧水务");
    expect(hints).toContain("用户想搞清楚什么");
    expect(hints).toContain("客户/行业线索");
    expect(hints).not.toContain("推断");
  });
});

describe("anchor — 派生展示缓存", () => {
  it("按固定行顺序拼接非空内容", () => {
    const rows: AnchorRow[] = [
      { item: "核心用途", content: "漏损监测" },
      { item: "客户类型/行业", content: "市政水务集团" },
      { item: "明确不含什么", content: "" },
      { item: "覆盖什么", content: "制水到输配" },
    ];
    expect(descriptionFromAnchor(rows)).toBe(
      ["客户类型/行业：市政水务集团", "覆盖什么：制水到输配", "核心用途：漏损监测"].join("\n"),
    );
  });

  it("「未提供」视为空，不写进缓存", () => {
    expect(descriptionFromAnchor([{ item: "客户类型/行业", content: "未提供" }])).toBe("");
  });
});

describe("anchor — 完成度", () => {
  it("统计必填缺失与 L1 未确认", () => {
    const rows: AnchorRow[] = [
      { item: "客户类型/行业", content: "市政水务集团", source_type: "用户确认" },
      { item: "覆盖什么", content: "制水到输配", source_type: "AI提取" },
      { item: "明确不含什么", content: "" },
    ];
    const c = anchorCompletion(rows);
    expect(c.required).toBe(9);
    expect(c.filled).toBe(2);
    expect(c.missing).toContain("明确不含什么");
    expect(c.unconfirmed).toContain("覆盖什么"); // AI提取 未确认
    expect(c.unconfirmed).not.toContain("客户类型/行业");
    expect(c.unconfirmed).toHaveLength(5);
  });

  it("全填且确认后无缺失、无未确认", () => {
    const rows = anchorRequiredRows().map((r) => ({
      item: r.label,
      content: "x",
      source_type: "用户确认" as const,
    }));
    const confirmOnly = anchorConfirmRows()
      .filter((r) => !r.required)
      .map((r) => ({ item: r.label, content: "y", source_type: "用户确认" as const }));
    const c = anchorCompletion([...rows, ...confirmOnly]);
    expect(c.filled).toBe(9);
    expect(c.missing).toEqual([]);
    expect(c.unconfirmed).toEqual([]);
  });
});

describe("anchor — 合并（用户确认优先）", () => {
  it("系统重算不覆盖用户确认过的行", () => {
    const existing: AnchorRow[] = [
      { item: "客户类型/行业", content: "市政水务集团（含排水）", source_type: "用户确认" },
      { item: "覆盖什么", content: "旧值", source_type: "AI提取" },
    ];
    const incoming: AnchorRow[] = [
      { item: "客户类型/行业", content: "系统新值", source_type: "AI提取" },
      { item: "覆盖什么", content: "系统新值", source_type: "AI提取" },
    ];
    const merged = mergeAnchorRows(existing, incoming);
    expect(merged.find((r) => r.item === "客户类型/行业")?.content).toBe("市政水务集团（含排水）");
    expect(merged.find((r) => r.item === "覆盖什么")?.content).toBe("系统新值");
  });

  it("缺失的固定行补空行，保持 12 行与顺序", () => {
    const merged = mergeAnchorRows([], [{ item: "核心用途", content: "x" }]);
    expect(merged).toHaveLength(12);
    expect(merged[0]?.item).toBe("场景名称");
  });

  it("用户补充（A 级证据）同样不被覆盖", () => {
    const merged = mergeAnchorRows(
      [{ item: "切入点", content: "存量改造", source_type: "用户补充" }],
      [{ item: "切入点", content: "系统值", source_type: "AI提取" }],
    );
    expect(merged.find((r) => r.item === "切入点")?.content).toBe("存量改造");
  });
});
