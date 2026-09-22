import { describe, it, expect } from "vitest";
import {
  advance,
  canAdvance,
  rollback,
  markStale,
  getRiskChain,
  STAGES,
} from "./workflow.js";
import type { StaleMark } from "./workflow.js";
import type { StageId } from "@scene/contract";

// ─── advance ─────────────────────────────────────────────────

describe("advance", () => {
  it("0→1 起步推进", () => {
    expect(advance(0)).toBe(1);
  });

  it("逐阶段推进 0→8 全链", () => {
    let stage = 0 as Parameters<typeof advance>[0];
    for (const next of [1, 2, 3, 4, 5, 6, 7, 8]) {
      stage = advance(stage);
      expect(stage).toBe(next);
    }
  });

  it("阶段 8 是终态，推进抛错", () => {
    expect(() => advance(8)).toThrow("终态");
  });

  it("非法阶段编号抛错（JS 边界防御）", () => {
    expect(() => advance(9 as never)).toThrow("非法");
    expect(() => advance(-1 as never)).toThrow("非法");
    expect(() => advance(1.5 as never)).toThrow("非法");
  });
});

// ─── canAdvance ──────────────────────────────────────────────

describe("canAdvance", () => {
  it("阶段 0-7 均可推进", () => {
    for (const stage of [0, 1, 2, 3, 4, 5, 6, 7]) {
      expect(canAdvance(stage as Parameters<typeof canAdvance>[0])).toBe(true);
    }
  });

  it("阶段 8 不可推进", () => {
    expect(canAdvance(8)).toBe(false);
  });

  it("非法阶段编号抛错", () => {
    expect(() => canAdvance(99 as never)).toThrow("非法");
  });
});

// ─── rollback ────────────────────────────────────────────────

describe("rollback", () => {
  it("回退到更早阶段，返回目标阶段", () => {
    expect(rollback(5, 2)).toBe(2);
    expect(rollback(8, 0)).toBe(0);
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
    expect(() => rollback(8, -1 as never)).toThrow("非法");
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
  it("包含 0-8 共 9 个阶段", () => {
    expect(STAGES).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
