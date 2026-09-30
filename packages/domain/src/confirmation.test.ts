import { describe, it, expect } from "vitest";
import {
  confirmStateOf,
  usableDownstream,
  applyConfirmation,
  buildChecklist,
  alignmentWithBrief,
  pendingConfirmationCount,
  l1Rows,
  ALIGNMENT_CONFLICT_NOTE,
  type InfoRow,
} from "./confirmation.js";

const confirmed = (o: Record<string, unknown>): InfoRow => ({ ...o, source: "用户", source_type: "用户确认" });
const inferred = (o: Record<string, unknown>): InfoRow => ({ ...o, source_type: "AI推断" });
const extracted = (o: Record<string, unknown>): InfoRow => ({ ...o, source: "《白皮书》p.1", source_type: "AI提取" });

describe("confirmation — 状态机", () => {
  it("状态由 source_type 推导，显式 confirm_state 优先", () => {
    expect(confirmStateOf({ source_type: "用户确认" })).toBe("用户确认");
    expect(confirmStateOf({ source_type: "用户补充" })).toBe("用户修改");
    expect(confirmStateOf({ source_type: "AI推断" })).toBe("待确认");
    expect(confirmStateOf({ source_type: "AI提取" })).toBe("系统推断");
    expect(confirmStateOf({})).toBe("系统推断");
    expect(confirmStateOf({ source_type: "AI提取", confirm_state: "用户否决" })).toBe("用户否决");
  });

  it("只有用户确认/用户补充可被下游当依据", () => {
    expect(usableDownstream({ source_type: "用户确认" })).toBe(true);
    expect(usableDownstream({ source_type: "用户补充" })).toBe(true);
    expect(usableDownstream({ source_type: "AI提取", source: "x" })).toBe(false);
    expect(usableDownstream({ source_type: "AI推断" })).toBe(false);
    expect(usableDownstream({})).toBe(false);
  });

  it("applyConfirmation：确认 → 用户确认；修改 → 用户补充并覆盖内容；否决 → 用户否决", () => {
    const base: InfoRow = { item: "客户类型", content: "水务集团", source_type: "AI提取", source: "《招标》p.2" };
    expect(applyConfirmation(base, "确认").source_type).toBe("用户确认");
    const edited = applyConfirmation(base, "修改", { content: "市政水务集团（含排水）" });
    expect(edited.source_type).toBe("用户补充");
    expect(edited.content).toBe("市政水务集团（含排水）");
    const vetoed = applyConfirmation(base, "否决");
    expect(vetoed.confirm_state).toBe("用户否决");
    expect(vetoed.source_type).toBeNull();
    // 纯函数：不改原行
    expect(base.source_type).toBe("AI提取");
  });
});

describe("confirmation — L1 必确认项来自注册表", () => {
  it("表1-1 的 L1 必确认行为 6 项且与注册表一致", () => {
    const keys = l1Rows().map((r) => r.key);
    expect(keys).toEqual([
      "customer_type",
      "scope_in",
      "scope_out",
      "use_case",
      "entry_point",
      "value_proposition",
    ]);
  });
});

describe("confirmation — 确认清单", () => {
  it("空输入时：L1 六项全待确认", () => {
    const c = buildChecklist({});
    expect(c.required).toBe(6);
    expect(c.confirmed).toBe(0);
    expect(c.allDone).toBe(false);
    expect(c.items.every((i) => i.layer === "L1")).toBe(true);
  });

  it("L2 按环节拆出「能否参与」「我方角色」两项", () => {
    const c = buildChecklist({
      linkRows: [extracted({ link: "制水" }), extracted({ link: "输配" })],
    });
    const l2 = c.items.filter((i) => i.layer === "L2");
    expect(l2).toHaveLength(4);
    expect(l2[0]?.rowKey).toBe("制水 · 能否参与");
    expect(l2[1]?.rowKey).toBe("制水 · 我方角色");
    // L1 6 + L2 4 = 10
    expect(c.required).toBe(10);
  });

  it("待确认清单作为 L3 聚合项计入", () => {
    const c = buildChecklist({ pendingCount: 3 });
    const l3 = c.items.filter((i) => i.layer === "L3");
    expect(l3).toHaveLength(1);
    expect(l3[0]?.label).toContain("3 项");
    expect(c.required).toBe(7);
  });

  it("用户确认 L1 后计入 confirmed；全确认则 allDone", () => {
    const labels = l1Rows().map((r) => r.label);
    const anchorRows = labels.map((label) => confirmed({ item: label, content: "x" }));
    const c = buildChecklist({ anchorRows });
    expect(c.confirmed).toBe(6);
    expect(c.allDone).toBe(true);
  });

  it("内容为「未提供」的行不算已确认", () => {
    const anchorRows = l1Rows().map((r) => confirmed({ item: r.label, content: "未提供" }));
    const c = buildChecklist({ anchorRows });
    expect(c.confirmed).toBe(0);
  });
});

describe("confirmation — 对照式确认（以用户诉求为基准）", () => {
  it("四态分类：一致 / 系统补充 / 推断 / 待补充", () => {
    const items = alignmentWithBrief([
      confirmed({ item: "客户类型/行业", content: "市政水务集团" }),
      extracted({ item: "覆盖什么", content: "制水到输配" }),
      inferred({ item: "核心用途", content: "漏损监测" }),
      confirmed({ item: "明确不含什么", content: "未提供" }),
    ]);
    const byKey = Object.fromEntries(items.map((i) => [i.rowKey, i]));
    expect(byKey["customer_type"]?.alignment).toBe("一致");
    expect(byKey["scope_in"]?.alignment).toBe("系统补充");
    expect(byKey["use_case"]?.alignment).toBe("推断");
    expect(byKey["scope_out"]?.alignment).toBe("待补充");
    expect(byKey["entry_point"]?.alignment).toBe("待补充"); // 表里没有该行
  });

  it("只对 L1 六项做对照，不扩散到全表", () => {
    expect(alignmentWithBrief([])).toHaveLength(6);
  });

  it("指出「冲突」需语义判断，不由纯函数假定", () => {
    expect(ALIGNMENT_CONFLICT_NOTE).toContain("语义判断");
    expect(ALIGNMENT_CONFLICT_NOTE).toContain("对话确认");
  });

  it("系统补充态带来源说明", () => {
    const items = alignmentWithBrief([extracted({ item: "切入点", content: "存量改造" })]);
    const it = items.find((i) => i.rowKey === "entry_point");
    expect(it?.note).toContain("来源");
  });
});

describe("confirmation — 待确认清单计数", () => {
  it("统计有内容但未确认的行", () => {
    const n = pendingConfirmationCount({
      "表1-1": [confirmed({ item: "客户类型", content: "x" }), extracted({ item: "覆盖什么", content: "y" })],
      "表1-2": [inferred({ link: "制水", can_touch: "可以碰" })],
    });
    expect(n).toBe(2); // extracted + inferred；confirmed 不计
  });

  it("空内容行不计入", () => {
    const n = pendingConfirmationCount({ "表1-1": [extracted({ item: "客户类型", content: "" })] });
    expect(n).toBe(0);
  });

  it("只有结构键（标识列）不算有内容——规则取自注册表", () => {
    // 表1-2 的第一个中栏列是 link；表7-1 的第一个中栏列是 target
    expect(pendingConfirmationCount({ "表1-2": [extracted({ link: "制水" })] })).toBe(0);
    expect(pendingConfirmationCount({ "表7-1": [extracted({ target: "产品路线图" })] })).toBe(0);
    // 补上任意一个数据列即计入
    expect(pendingConfirmationCount({ "表1-2": [extracted({ link: "制水", can_touch: "可以碰" })] })).toBe(1);
  });

  it("与完整度检查联动：计数可作为 pendingConfirmations 传入", () => {
    const rows = { "表7-1": [extracted({ target: "产品路线图", content: "需求 A", basis: "阶段 2" })] };
    expect(pendingConfirmationCount(rows)).toBe(1);
  });
});
