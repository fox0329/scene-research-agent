import { describe, it, expect } from "vitest";
import {
  advance,
  canAdvance,
  rollback,
  stagesToMarkAfterRollback,
  markStale,
  getRiskChain,
  STAGES,
  getAffectedStages,
  TABLE_DEPENDENCIES,
  createStaleMark,
  hasStaleMarks,
  getStaleBanners,
  clearStaleMarks,
} from "./workflow.js";
import type { StaleMark } from "./workflow.js";
import type { StageId } from "@scene/contract";

// ─── advance ─────────────────────────────────────────────────

describe("advance", () => {
  it("0→1 起步推进", () => {
    expect(advance(0)).toBe(1);
  });

  it("逐阶段推进 0→5 全链", () => {
    let stage = 0 as Parameters<typeof advance>[0];
    for (const next of [1, 2, 3, 4, 5]) {
      stage = advance(stage);
      expect(stage).toBe(next);
    }
  });

  it("阶段 5 是终态，推进抛错", () => {
    expect(() => advance(5)).toThrow("终态");
  });

  it("非法阶段编号抛错（JS 边界防御）", () => {
    expect(() => advance(8 as never)).toThrow("非法");
    expect(() => advance(-1 as never)).toThrow("非法");
    expect(() => advance(1.5 as never)).toThrow("非法");
  });
});

// ─── canAdvance ──────────────────────────────────────────────

describe("canAdvance", () => {
  it("阶段 0-4 均可推进（阶段 5 是终态）", () => {
    for (const stage of [0, 1, 2, 3, 4]) {
      expect(canAdvance(stage as Parameters<typeof canAdvance>[0])).toBe(true);
    }
  });

  it("阶段 5 不可推进", () => {
    expect(canAdvance(5)).toBe(false);
  });

  it("非法阶段编号抛错", () => {
    expect(() => canAdvance(99 as never)).toThrow("非法");
  });
});

// ─── rollback ────────────────────────────────────────────────

describe("rollback", () => {
  it("回退到更早阶段，返回目标阶段", () => {
    expect(rollback(5, 2)).toBe(2);
    expect(rollback(5, 0)).toBe(0);
    expect(rollback(1, 0)).toBe(0);
  });

  it("回退到紧邻前一阶段", () => {
    expect(rollback(3, 2)).toBe(2);
  });

  it("目标等于当前阶段抛错", () => {
    expect(() => rollback(4, 4)).toThrow("必须早于");
  });

  it("目标晚于当前阶段抛错", () => {
    expect(() => rollback(2, 5)).toThrow("必须早于");
  });

  it("非法阶段编号抛错", () => {
    expect(() => rollback(8 as never, -1 as never)).toThrow("非法");
    expect(() => rollback(-1 as never, 0 as never)).toThrow("非法");
  });
});

// ─── markStale ───────────────────────────────────────────────

describe("markStale", () => {
  it("单个受影响阶段 — 横幅单点提示", () => {
    const mark = markStale("sc1", "M1", "p1", [4]);

    expect(mark.scenarioId).toBe("sc1");
    expect(mark.refTable).toBe("M1");
    expect(mark.refId).toBe("p1");
    expect(mark.affectedStages).toEqual([4]);
    expect(mark.banner).toBe("资料已更新，建议重算阶段 4");
  });

  it("多个受影响阶段 — 横幅按范围提示", () => {
    const mark = markStale("sc1", "capability", "c1", [2, 4, 5]);
    expect(mark.affectedStages).toEqual([2, 4, 5]);
    expect(mark.banner).toBe("资料已更新，建议重算阶段 2-5");
  });

  it("受影响阶段去重并升序", () => {
    const mark = markStale("sc1", "M2", "sp1", [5, 2, 5, 3, 2]);
    expect(mark.affectedStages).toEqual([2, 3, 5]);
  });

  it("无受影响阶段 — 横幅只提示资料更新", () => {
    const mark = markStale("sc1", "O4", "o1", []);
    expect(mark.affectedStages).toEqual([]);
    expect(mark.banner).toBe("资料已更新");
  });

  it("标识为空抛错（参数校验）", () => {
    expect(() => markStale("", "M1", "p1", [])).toThrow("场景 ID");
    expect(() => markStale("sc1", "  ", "p1", [])).toThrow("资料表名");
    expect(() => markStale("sc1", "M1", "", [])).toThrow("资料行 ID");
  });

  it("返回值可序列化（纯数据，横幅由 UI 直接呈现）", () => {
    const mark: StaleMark = markStale("sc1", "M4", "b1", [1, 2]);
    const revived = JSON.parse(JSON.stringify(mark)) as StaleMark;
    expect(revived.banner).toBe("资料已更新，建议重算阶段 1-2");
    expect(revived.affectedStages).toEqual([1, 2]);
  });
});

// ─── getRiskChain ────────────────────────────────────────────

describe("getRiskChain", () => {
  it("按阶段升序收集 0 到当前阶段的全部风险", () => {
    const risks = new Map<StageId, string[]>([
      [0, ["M4 为空"]],
      [1, ["认证缺失"]],
      [2, ["协议未实测"]],
    ]);
    expect(getRiskChain(risks)).toEqual(["M4 为空", "认证缺失", "协议未实测"]);
  });

  it("同名风险跨阶段只保留首次出现（继承不重复）", () => {
    const risks = new Map<StageId, string[]>([
      [0, ["M4 为空", "成本只有行业均值"]],
      [1, ["M4 为空"]],
      [2, ["成本只有行业均值", "新增风险"]],
    ]);
    expect(getRiskChain(risks)).toEqual(["M4 为空", "成本只有行业均值", "新增风险"]);
  });

  it("中间阶段缺失不阻断继承", () => {
    const risks = new Map<StageId, string[]>([
      [0, ["风险A"]],
      [3, ["风险B"]],
    ]);
    expect(getRiskChain(risks)).toEqual(["风险A", "风险B"]);
  });

  it("当前阶段取映射中的最大阶段编号", () => {
    // 阶段 1 的风险应包含；阶段 5（大于 map 内最大 4）不存在，不参与
    const risks = new Map<StageId, string[]>([
      [1, ["风险1"]],
      [4, ["风险4"]],
    ]);
    expect(getRiskChain(risks)).toEqual(["风险1", "风险4"]);
  });

  it("空映射返回空数组", () => {
    expect(getRiskChain(new Map())).toEqual([]);
  });

  it("某阶段风险列表为空数组时跳过该阶段", () => {
    const risks = new Map<StageId, string[]>([
      [0, []],
      [1, ["风险B"]],
    ]);
    expect(getRiskChain(risks)).toEqual(["风险B"]);
  });
});

// ─── 常量 ────────────────────────────────────────────────────

describe("STAGES 常量", () => {
  it("包含 0-5 共 6 个阶段（价值验证阶段已删除）", () => {
    expect(STAGES).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

// ─── 表间依赖反查 ────────────────────────────────────────────

describe("getAffectedStages", () => {
  it("M1 产品清单 → 阶段 3,4（对照文档：阶段3 匹配候选池、阶段4 硬件成本）", () => {
    expect(getAffectedStages("M1")).toEqual([3, 4]);
  });

  it("M5 已知限制 → 阶段 4（实施风险；验收约束随价值验证阶段删除）", () => {
    expect(getAffectedStages("M5")).toEqual([4]);
  });

  it("表3-6 替代方案 → 阶段 4", () => {
    expect(getAffectedStages("表3-6")).toEqual([4]);
  });

  it("M6 内部费率已整张删除 → 反查空数组（不再假报阶段 4）", () => {
    expect(getAffectedStages("M6")).toEqual([]);
  });

  it("未知表名 → 空数组", () => {
    expect(getAffectedStages("未知表")).toEqual([]);
  });

  it("**所有取值都是合法的阶段 id**（0 基、且落在流程真实存在的 1–6 阶段内）", () => {
    // 这条是给"人话（从 1 起）被当成 id（从 0 起）"那次错位上的锁：
    // 阶段 0 是资料库自身、7 没有对应阶段，出现就说明又有人按 1 基填了
    for (const [table, stages] of Object.entries(TABLE_DEPENDENCIES)) {
      for (const stage of stages) {
        expect(stage, `${table} 的依赖阶段 ${stage}`).toBeGreaterThanOrEqual(1);
        expect(stage, `${table} 的依赖阶段 ${stage}`).toBeLessThanOrEqual(6);
      }
    }
  });
});

describe("createStaleMark", () => {
  it("M1 更新 → 自动反查到阶段 3,4", () => {
    const mark = createStaleMark("S1", "M1", "P1");
    expect(mark.affectedStages).toEqual([3, 4]);
    expect(mark.banner).toContain("阶段 3-4");
  });

  it("未知表名 → 无受影响阶段", () => {
    const mark = createStaleMark("S1", "未知表", "X1");
    expect(mark.affectedStages).toEqual([]);
    expect(mark.banner).toBe("资料已更新");
  });
});

describe("hasStaleMarks", () => {
  const marks: StaleMark[] = [
    { scenarioId: "S1", refTable: "M1", refId: "P1", affectedStages: [4, 5], banner: "test" },
    { scenarioId: "S2", refTable: "M2", refId: "P2", affectedStages: [5], banner: "test" },
  ];

  it("有失效标记 → true", () => {
    expect(hasStaleMarks(marks, "S1")).toBe(true);
  });

  it("无失效标记 → false", () => {
    expect(hasStaleMarks(marks, "S3")).toBe(false);
  });
});

describe("getStaleBanners", () => {
  const marks: StaleMark[] = [
    { scenarioId: "S1", refTable: "M1", refId: "P1", affectedStages: [4, 5], banner: "资料已更新，建议重算阶段 4-5" },
    { scenarioId: "S1", refTable: "M2", refId: "P2", affectedStages: [5], banner: "资料已更新，建议重算阶段 5" },
    { scenarioId: "S2", refTable: "M3", refId: "P3", affectedStages: [4], banner: "资料已更新，建议重算阶段 4" },
  ];

  it("返回指定场景的所有横幅（去重）", () => {
    const banners = getStaleBanners(marks, "S1");
    expect(banners).toHaveLength(2);
    expect(banners).toContain("资料已更新，建议重算阶段 4-5");
    expect(banners).toContain("资料已更新，建议重算阶段 5");
  });

  it("无失效标记 → 空数组", () => {
    expect(getStaleBanners(marks, "S3")).toEqual([]);
  });
});

describe("clearStaleMarks", () => {
  const marks: StaleMark[] = [
    { scenarioId: "S1", refTable: "M1", refId: "P1", affectedStages: [4, 5], banner: "test1" },
    { scenarioId: "S1", refTable: "M2", refId: "P2", affectedStages: [5], banner: "test2" },
    { scenarioId: "S2", refTable: "M3", refId: "P3", affectedStages: [4], banner: "test3" },
  ];

  it("清除指定场景的所有标记", () => {
    const result = clearStaleMarks(marks, "S1");
    expect(result).toHaveLength(1);
    expect(result[0]!.scenarioId).toBe("S2");
  });

  it("清除指定场景的指定表标记", () => {
    const result = clearStaleMarks(marks, "S1", "M1");
    expect(result).toHaveLength(2);
    expect(result.some((m) => m.refTable === "M1")).toBe(false);
    expect(result.some((m) => m.refTable === "M2")).toBe(true);
  });

  it("不影响其他场景的标记", () => {
    const result = clearStaleMarks(marks, "S1");
    expect(result.some((m) => m.scenarioId === "S2")).toBe(true);
  });
});

// ─── stagesToMarkAfterRollback（T4.2 回退清理） ────────────

describe("stagesToMarkAfterRollback", () => {
  it("回退 1→4：下游 2..4 全部待重算，目标阶段自身不含", () => {
    expect(stagesToMarkAfterRollback(1 as StageId, 4 as StageId)).toEqual([2, 3, 4]);
  });

  it("相邻回退 3→4：只标记阶段 4", () => {
    expect(stagesToMarkAfterRollback(3 as StageId, 4 as StageId)).toEqual([4]);
  });

  it("target>=current 返回空（非法回退由 rollback() 抛错兜底）", () => {
    expect(stagesToMarkAfterRollback(4 as StageId, 4 as StageId)).toEqual([]);
    expect(stagesToMarkAfterRollback(5 as StageId, 4 as StageId)).toEqual([]);
  });

  it("回退到 0：全下游 1..8", () => {
    const result = stagesToMarkAfterRollback(0 as StageId, 8 as StageId);
    expect(result).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
