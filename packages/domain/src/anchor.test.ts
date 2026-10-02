import { describe, it, expect } from "vitest";
import type { ScenarioBrief, AnchorRow } from "@scene/contract";
import {
  anchorFixedRows,
  anchorRequiredRows,
  anchorUserRows,
  anchorAgentRows,
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
  it("表1-1 收敛到 6 项业务画像，必填 2 项，只有「场景名称」是用户的活", () => {
    expect(anchorFixedRows().map((r) => r.key)).toEqual([
      "scene_name",
      "scene_boundary",
      "production_object",
      "core_systems",
      "buyer_type",
      "procurement",
    ]);
    expect(anchorRequiredRows().map((r) => r.key)).toEqual(["scene_name", "scene_boundary"]);
    // 属主：用户只输入场景名称，其余 5 项由智能体从业务角度写
    expect(anchorUserRows().map((r) => r.key)).toEqual(["scene_name"]);
    expect(anchorAgentRows().map((r) => r.key)).toEqual([
      "scene_boundary",
      "production_object",
      "core_systems",
      "buyer_type",
      "procurement",
    ]);
  });

  it("拍板者/使用者/付费者已不在表1-1（留给表3-3 按客户类型研究）", () => {
    const labels = anchorFixedRows().map((r) => r.label);
    expect(labels).not.toContain("拍板者");
    expect(labels).not.toContain("使用者");
    expect(labels).not.toContain("付费者");
  });
});

describe("anchor — 骨架与预填", () => {
  it("骨架 6 行，仅场景名称填好且标用户补充", () => {
    const rows = buildAnchorSkeleton("智慧水务");
    expect(rows).toHaveLength(6);
    const name = rows.find((r) => r.item === "场景名称");
    expect(name?.content).toBe("智慧水务");
    expect(name?.source_type).toBe("用户补充");
    expect(rows.filter((r) => r.content !== "").length).toBe(1);
  });

  it("用户诉求只预填「场景边界」，其余 4 项必须由智能体写", () => {
    const rows = anchorFromBrief(brief());
    expect(rows.map((r) => r.item)).toEqual(["场景边界"]);
    expect(rows.every((r) => r.source === "用户诉求")).toBe(true);
    expect(rows.every((r) => r.source_type === "用户补充")).toBe(true);
  });

  it("范围线索为空时用意图兜底", () => {
    const rows = anchorFromBrief(brief({ scope_hint: null }));
    expect(rows.map((r) => r.content)).toEqual(["想搞清楚这个场景值不值得进"]);
  });

  it("两者都空则不预填", () => {
    const rows = anchorFromBrief(brief({ scope_hint: "  ", intent: "  " }));
    expect(rows).toEqual([]);
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
      { item: "买方类型", content: "城燃集团" },
      { item: "生产对象", content: "天然气接收与调压" },
      { item: "采购特征", content: "" },
      { item: "场景边界", content: "门站、调压站/箱" },
    ];
    expect(descriptionFromAnchor(rows)).toBe(
      ["场景边界：门站、调压站/箱", "生产对象：天然气接收与调压", "买方类型：城燃集团"].join("\n"),
    );
  });

  it("「未提供」视为空，不写进缓存", () => {
    expect(descriptionFromAnchor([{ item: "买方类型", content: "未提供" }])).toBe("");
  });
});

describe("anchor — 完成度", () => {
  it("必填缺失与「用户该给的还没给」分开统计", () => {
    const rows: AnchorRow[] = [
      { item: "场景名称", content: "智慧水务", source_type: "用户补充" },
      { item: "场景边界", content: "", source_type: "AI推断" },
      { item: "生产对象", content: "自来水" },
    ];
    const c = anchorCompletion(rows);
    expect(c.required).toBe(2);
    expect(c.filled).toBe(1);
    expect(c.missing).toEqual(["场景边界"]);
    // 场景名称已给 → 用户没有欠的；范围没写是智能体的活
    expect(c.userInputMissing).toEqual([]);
  });

  it("场景名称空着才算用户欠的", () => {
    const c = anchorCompletion([{ item: "场景边界", content: "门站" }]);
    expect(c.userInputMissing).toEqual(["场景名称"]);
  });

  it("全填后无缺失、用户无欠项", () => {
    const rows = anchorRequiredRows().map((r) => ({ item: r.label, content: "x" }));
    const c = anchorCompletion(rows);
    expect(c.filled).toBe(2);
    expect(c.missing).toEqual([]);
    expect(c.userInputMissing).toEqual([]);
  });
});

describe("anchor — 合并（用户确认优先）", () => {
  it("系统重算不覆盖用户确认过的行", () => {
    const existing: AnchorRow[] = [
      { item: "场景边界", content: "门站、调压站/箱（含 LNG 储备站）", source_type: "用户确认" },
      { item: "生产对象", content: "旧值", source_type: "AI推断" },
    ];
    const incoming: AnchorRow[] = [
      { item: "场景边界", content: "系统新值", source_type: "AI推断" },
      { item: "生产对象", content: "系统新值", source_type: "AI推断" },
    ];
    const merged = mergeAnchorRows(existing, incoming);
    expect(merged.find((r) => r.item === "场景边界")?.content).toBe("门站、调压站/箱（含 LNG 储备站）");
    expect(merged.find((r) => r.item === "生产对象")?.content).toBe("系统新值");
  });

  it("缺失的固定行补空行，保持 6 行与顺序", () => {
    const merged = mergeAnchorRows([], [{ item: "采购特征", content: "x" }]);
    expect(merged).toHaveLength(6);
    expect(merged[0]?.item).toBe("场景名称");
  });

  it("用户补充（A 级证据）同样不被覆盖", () => {
    const merged = mergeAnchorRows(
      [{ item: "买方类型", content: "地方燃气公司", source_type: "用户补充" }],
      [{ item: "买方类型", content: "系统值", source_type: "AI推断" }],
    );
    expect(merged.find((r) => r.item === "买方类型")?.content).toBe("地方燃气公司");
  });
});
