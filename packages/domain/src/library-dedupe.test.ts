import { describe, expect, it } from "vitest";
import {
  matchExistingProduct,
  normalizeModel,
  normalizeValue,
  planProductMerge,
  planSpecDedupe,
} from "./library-dedupe.js";

describe("normalizeModel：型号归一", () => {
  it("去掉所有空白（含全角）、统一大写", () => {
    expect(normalizeModel("  在鸿 7885平板 ")).toBe("在鸿7885平板");
    expect(normalizeModel("在鸿　7885平板")).toBe("在鸿7885平板");
    expect(normalizeModel("ct15")).toBe("CT15");
    expect(normalizeModel(null)).toBe("");
  });
});

describe("planProductMerge：同型号重复行合并（用户定调：重复的内容要合并）", () => {
  const p = (id: string, model: string, status: string, created_at: string) => ({ id, model, status, created_at });

  it("同型号两行：保留在售行，删待确认行（哪怕待确认更早）", () => {
    const plan = planProductMerge([
      p("a", "CT15", "待确认", "2026-09-24T00:44"),
      p("b", "CT15", "在售", "2026-09-23T14:42"),
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.keepId).toBe("b");
    expect(plan[0]!.removeIds).toEqual(["a"]);
  });

  it("同状态同型号：留创建更早的，结果稳定可复现", () => {
    const plan = planProductMerge([
      p("x", "在鸿三防平板", "待确认", "2026-09-23T10:00"),
      p("y", "在鸿三防平板", "待确认", "2026-09-23T11:00"),
    ]);
    expect(plan[0]!.keepId).toBe("x");
    expect(plan[0]!.removeIds).toEqual(["y"]);
  });

  it("型号写法不同（空格差异）也算同一型号", () => {
    const plan = planProductMerge([
      p("a", "在鸿7885平板", "待确认", "2026-09-23T10:00"),
      p("b", "在鸿 7885平板", "待确认", "2026-09-23T11:00"),
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.removeIds).toEqual(["b"]);
  });

  it("空型号不参与合并（不同产品都可能没写型号）", () => {
    const plan = planProductMerge([p("a", "", "待确认", "1"), p("b", "  ", "待确认", "2")]);
    expect(plan).toEqual([]);
  });

  it("不重复的型号不产生计划", () => {
    expect(planProductMerge([p("a", "CT15", "在售", "1"), p("b", "CT31", "在售", "2")])).toEqual([]);
  });
});

describe("matchExistingProduct：写入前匹配已有产品（ingest 不再造重复行）", () => {
  const rows = [
    { id: "a", model: "CT15", status: "在售", created_at: "2026-09-23T14:42" },
    { id: "b", model: "CT15", status: "待确认", created_at: "2026-09-24T00:44" },
  ];
  it("材料里的型号能匹配到已有行（含归一化差异）", () => {
    expect(matchExistingProduct(rows, "ct15")?.id).toBe("a");
    expect(matchExistingProduct(rows, " CT15 ")?.id).toBe("a");
  });
  it("资料库里没有的型号 → 返回 undefined（该新建）", () => {
    expect(matchExistingProduct(rows, "CT99")).toBeUndefined();
    expect(matchExistingProduct(rows, "")).toBeUndefined();
  });
});

describe("planSpecDedupe：同产品内规格去重", () => {
  const s = (id: string, cls: string, name: string, value: string) => ({
    id,
    product_id: "p1",
    param_class: cls,
    param_name: name,
    value,
    created_at: "2026-09-23T10:00",
  });

  it("完全相同（类别+名称+值）→ 留最早一条", () => {
    const plan = planSpecDedupe([
      s("1", "外观结构", "安装方式", "导轨安装"),
      s("2", "外观结构", "安装方式", "导轨安装"),
      s("3", "外观结构", "安装方式", "导轨安装"),
    ]);
    expect(plan.dropIds).toEqual(["2", "3"]);
    expect(plan.exactGroups).toBe(2);
  });

  it("同键近重复（一个值包含另一个）→ 留更完整的那句", () => {
    const plan = planSpecDedupe([
      s("long", "功耗", "电源", "DC24V/1A，支持9-36V宽电压输入，支持电源防反接"),
      s("short", "功耗", "电源", "DC24V/1A，支持9-36V宽电压输入"),
    ]);
    expect(plan.dropIds).toEqual(["short"]);
    expect(plan.nearGroups).toBe(1);
  });

  it("值互相冲突不算重复（两条都留，交由来去分辨）", () => {
    const plan = planSpecDedupe([
      s("a", "环境参数", "工作温度", "-10~50℃"),
      s("b", "环境参数", "工作温度", "-20~60℃"),
    ]);
    expect(plan.dropIds).toEqual([]);
  });

  it("不同名称即使值一样也不合并（不同参数各说各的）", () => {
    const plan = planSpecDedupe([
      s("a", "接口", "USB", "2 路"),
      s("b", "接口", "串口", "2 路"),
    ]);
    expect(plan.dropIds).toEqual([]);
  });

  it("值前后空白差异视为相同", () => {
    const plan = planSpecDedupe([
      s("a", "机械特性", "机械结构", "钣金"),
      s("b", "机械特性", "机械结构", " 钣金 "),
    ]);
    expect(plan.dropIds).toEqual(["b"]);
  });
});

describe("normalizeValue", () => {
  it("去首尾空白并折叠中间空白", () => {
    expect(normalizeValue(" DC24V/1A， 支持9-36V ")).toBe("DC24V/1A， 支持9-36V");
    expect(normalizeValue(null)).toBe("");
  });
});
