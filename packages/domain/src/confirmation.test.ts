import { describe, it, expect } from "vitest";
import {
  confirmStateOf,
  usableDownstream,
  applyConfirmation,
  anchorRows1_1,
  alignmentWithBrief,
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
    const base: InfoRow = { item: "场景边界", content: "门站、调压站/箱", source_type: "AI推断" };
    expect(applyConfirmation(base, "确认").source_type).toBe("用户确认");
    const edited = applyConfirmation(base, "修改", { content: "门站、调压站/箱（含 LNG 储备站）" });
    expect(edited.source_type).toBe("用户补充");
    expect(edited.content).toBe("门站、调压站/箱（含 LNG 储备站）");
    const vetoed = applyConfirmation(base, "否决");
    expect(vetoed.confirm_state).toBe("用户否决");
    expect(vetoed.source_type).toBeNull();
    // 纯函数：不改原行
    expect(base.source_type).toBe("AI推断");
  });
});

describe("confirmation — 表1-1 固定行来自注册表", () => {
  it("收敛到 6 项业务画像，且不再有「必确认项」这个概念", () => {
    expect(anchorRows1_1().map((r) => r.key)).toEqual([
      "scene_name",
      "scene_boundary",
      "production_object",
      "core_systems",
      "buyer_type",
      "procurement",
    ]);
    // @ts-expect-error confirmRequired 字段已删除（属主改为 owner）
    expect(anchorRows1_1()[0]?.confirmRequired).toBeUndefined();
  });
});

describe("confirmation — 对照（以用户诉求为基准）", () => {
  it("四态分类：一致 / 系统补充 / 推断", () => {
    const items = alignmentWithBrief([
      confirmed({ item: "场景名称", content: "智慧水务" }),
      extracted({ item: "场景边界", content: "制水到输配" }),
      inferred({ item: "生产对象", content: "自来水" }),
    ]);
    const byKey = Object.fromEntries(items.map((i) => [i.rowKey, i]));
    expect(byKey["scene_name"]?.alignment).toBe("一致");
    expect(byKey["scene_boundary"]?.alignment).toBe("系统补充");
    expect(byKey["production_object"]?.alignment).toBe("推断");
  });

  it("用户负责的行永远列出（空着就提示是他的活）", () => {
    const items = alignmentWithBrief([]);
    expect(items.map((i) => i.rowKey)).toEqual(["scene_name"]);
    expect(items[0]?.alignment).toBe("待补充");
  });

  it("智能体侧没内容的行不打扰用户", () => {
    const items = alignmentWithBrief([inferred({ item: "买方类型", content: "城燃集团" })]);
    expect(items.map((i) => i.rowKey)).toEqual(["scene_name", "buyer_type"]);
  });

  it("推断态不再写成「需要用户确认」，而是「可直接改」", () => {
    const items = alignmentWithBrief([inferred({ item: "买方类型", content: "城燃集团" })]);
    const it = items.find((i) => i.rowKey === "buyer_type");
    expect(it?.note).toContain("可直接改");
    expect(it?.note).not.toContain("需用户确认");
  });

  it("指出「冲突」需语义判断，不由纯函数假定", () => {
    expect(ALIGNMENT_CONFLICT_NOTE).toContain("语义判断");
    expect(ALIGNMENT_CONFLICT_NOTE).toContain("对话确认");
  });

  it("系统补充态带来源说明", () => {
    const items = alignmentWithBrief([extracted({ item: "采购特征", content: "集团集采" })]);
    const it = items.find((i) => i.rowKey === "procurement");
    expect(it?.note).toContain("来源");
  });
});
