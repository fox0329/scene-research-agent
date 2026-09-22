import { describe, it, expect } from "vitest";
import {
  runGate,
  sampleSources,
  decideAdvice,
  GATE_CHECK_TITLES,
  MIN_SAMPLE_SIZE,
} from "./gate.js";
import type { GateCheckInput, GateCheckResult } from "./gate.js";
import type { StageId } from "@scene/contract";

// ─── 工厂函数 ─────────────────────────────────────────────────

/** 生成 n 项全部通过的检查输入 */
function makePassingChecks(n: number): GateCheckInput[] {
  return Array.from({ length: n }, () => ({ result: "通过" as const }));
}

// ─── 检查项数与 00b 标准一致 ─────────────────────────────────

describe("GATE_CHECK_TITLES 与 00b 标准一致", () => {
  it("各阶段检查项数：0=无、1=10、2=9、3=8、4=7、5=6、6=7、7/8=无", () => {
    const expected: Record<StageId, number> = {
      0: 0,
      1: 10,
      2: 9,
      3: 8,
      4: 7,
      5: 6,
      6: 7,
      7: 0,
      8: 0,
    };
    for (const stage of [0, 1, 2, 3, 4, 5, 6, 7, 8] as StageId[]) {
      expect(GATE_CHECK_TITLES[stage]).toHaveLength(expected[stage]);
    }
  });

  it("有质量关的阶段末项均为来源抽查（G-R3）", () => {
    for (const stage of [1, 2, 3, 4, 5, 6] as StageId[]) {
      const titles = GATE_CHECK_TITLES[stage];
      expect(titles[titles.length - 1]).toBe("来源抽查至少 3 条通过");
    }
  });

  it("G-R3 最少抽查条数为 3", () => {
    expect(MIN_SAMPLE_SIZE).toBe(3);
  });
});

// ─── runGate ─────────────────────────────────────────────────

describe("runGate", () => {
  it("阶段 1 需要 10 项检查并按顺序编号", () => {
    const results = runGate(1, makePassingChecks(10));

    expect(results).toHaveLength(10);
    expect(results[0]!.itemNo).toBe("1");
    expect(results[9]!.itemNo).toBe("10");
  });

  it("标题留空时回填该阶段标准检查项标题", () => {
    const results = runGate(1, makePassingChecks(10));
    expect(results[0]!.title).toBe(
      "阶段 0 材料已完成度评估，缺失项已标注风险",
    );
    expect(results[9]!.title).toBe("来源抽查至少 3 条通过");
  });

  it("自定义标题保留，不回填标准标题", () => {
    const results = runGate(
      2,
      makePassingChecks(9).map((c, i) =>
        i === 0 ? { ...c, title: "自定义检查项" } : c,
      ),
    );
    expect(results[0]!.title).toBe("自定义检查项");
    expect(results[1]!.title).toBe(
      "能说出用户得到什么服务（分角色），且映射到实现载体",
    );
  });

  it("isPassed 按结果计算，isCritical/hasAlternativePath/detail 有默认值", () => {
    const results = runGate(3, [
      { result: "通过" },
      { result: "不通过" },
      ...makePassingChecks(6),
    ]);

    expect(results[0]!.isPassed).toBe(true);
    expect(results[1]!.isPassed).toBe(false);
    expect(results[1]!.isCritical).toBe(false);
    expect(results[1]!.hasAlternativePath).toBe(false);
    expect(results[1]!.detail).toBe("");
  });

  it("未检不算通过", () => {
    const results = runGate(
      4,
      makePassingChecks(7).map((c, i) => (i === 3 ? { result: "未检" as const } : c)),
    );
    expect(results[3]!.result).toBe("未检");
    expect(results[3]!.isPassed).toBe(false);
  });

  it("检查项数不足时抛错", () => {
    expect(() => runGate(1, makePassingChecks(9))).toThrow("需要 10 项");
  });

  it("检查项数超出时抛错", () => {
    expect(() => runGate(5, makePassingChecks(7))).toThrow("需要 6 项");
  });

  it("无质量关的阶段（0/7/8）传空数组返回空结果", () => {
    for (const stage of [0, 7, 8] as StageId[]) {
      expect(runGate(stage, [])).toEqual([]);
    }
  });

  it("无质量关的阶段传入检查项抛错", () => {
    expect(() => runGate(0, makePassingChecks(1))).toThrow("需要 0 项");
    expect(() => runGate(8, makePassingChecks(3))).toThrow("需要 0 项");
  });

  it("每个有质量关的阶段都能以对应项数跑通（全口径）", () => {
    const counts: Record<number, number> = { 1: 10, 2: 9, 3: 8, 4: 7, 5: 6, 6: 7 };
    for (const [stageStr, count] of Object.entries(counts)) {
      const stage = Number(stageStr) as StageId;
      const results = runGate(stage, makePassingChecks(count));
      expect(results.every((r) => r.isPassed)).toBe(true);
    }
  });
});

// ─── sampleSources ───────────────────────────────────────────

describe("sampleSources", () => {
  const sources = ["白皮书.pdf#3", "规格书.pdf:12", "年报.pdf#5", "标准.pdf:1", "案例集.pdf#8"];

  it("空来源返回空数组", () => {
    expect(sampleSources([], 3)).toEqual([]);
  });

  it("采样量小于 3 时按 G-R3 下限取 3 条", () => {
    const sampled = sampleSources(sources, 1);
    expect(sampled).toHaveLength(3);
    for (const s of sampled) {
      expect(sources).toContain(s);
    }
  });

  it("来源不足 3 条时全量返回", () => {
    expect(sampleSources(["a.pdf:1", "b.pdf:2"], 3)).toHaveLength(2);
    expect(sampleSources(["a.pdf:1"], 5)).toEqual(["a.pdf:1"]);
  });

  it("采样量大于等于来源数时全量返回", () => {
    const sampled = sampleSources(sources, 10);
    expect(sampled).toHaveLength(sources.length);
    for (const s of sources) {
      expect(sampled).toContain(s);
    }
  });

  it("按给定采样量抽查且元素来自来源列表", () => {
    const sampled = sampleSources(sources, 4);
    expect(sampled).toHaveLength(4);
    for (const s of sampled) {
      expect(sources).toContain(s);
    }
  });

  it("相同引用去重后再采样", () => {
    const withDupes = ["a.pdf:1", "a.pdf:1", "b.pdf:2", "c.pdf:3", "d.pdf:4"];
    const sampled = sampleSources(withDupes, 3, () => 0);
    // 去重后 4 条唯一引用，采 3 条，互不重复
    expect(sampled).toHaveLength(3);
    expect(new Set(sampled).size).toBe(sampled.length);
    expect(["a.pdf:1", "b.pdf:2", "c.pdf:3", "d.pdf:4"]).toEqual(
      expect.arrayContaining(sampled),
    );
  });

  it("空白引用被过滤", () => {
    const sampled = sampleSources(["", "  ", "a.pdf:1"], 3);
    expect(sampled).toEqual(["a.pdf:1"]);
  });

  it("注入确定性 rng 时结果可复现（依赖注入可测）", () => {
    // 恒 0 的 rng：洗牌每次把 i 位换到 0 位，结果确定
    const first = sampleSources(sources, 3, () => 0);
    const second = sampleSources(sources, 3, () => 0);
    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
  });

  it("不修改入参数组（纯函数）", () => {
    const input = [...sources];
    sampleSources(sources, 2);
    expect(sources).toEqual(input);
  });
});

// ─── decideAdvice ────────────────────────────────────────────

describe("decideAdvice", () => {
  function makeResults(overrides: Array<Partial<GateCheckResult>>): GateCheckResult[] {
    return overrides.map((o, i) => ({
      itemNo: String(i + 1),
      title: `检查项${i + 1}`,
      result: "通过",
      isPassed: true,
      isCritical: false,
      hasAlternativePath: false,
      detail: "",
      ...o,
    }));
  }

  it("全部通过 → 建议通过", () => {
    const results = makeResults([{ result: "通过" }, { result: "通过" }]);
    expect(decideAdvice(results)).toBe("建议通过");
  });

  it("空结果列表 → 建议通过（无失败项）", () => {
    expect(decideAdvice([])).toBe("建议通过");
  });

  it("有不通过但非关键项 → 建议有条件通过", () => {
    const results = makeResults([
      { result: "通过" },
      { result: "不通过", isPassed: false, hasAlternativePath: true },
    ]);
    expect(decideAdvice(results)).toBe("建议有条件通过");
  });

  it("非关键项不通过且无替代路径 → 仍为建议有条件通过（需补齐前提）", () => {
    const results = makeResults([
      { result: "不通过", isPassed: false },
      { result: "通过" },
    ]);
    expect(decideAdvice(results)).toBe("建议有条件通过");
  });

  it("未检 → 建议有条件通过", () => {
    const results = makeResults([{ result: "未检", isPassed: false }, { result: "通过" }]);
    expect(decideAdvice(results)).toBe("建议有条件通过");
  });

  it("关键项不通过 → 建议不通过", () => {
    const results = makeResults([
      { result: "通过" },
      { result: "不通过", isPassed: false, isCritical: true },
      { result: "通过" },
    ]);
    expect(decideAdvice(results)).toBe("建议不通过");
  });

  it("关键项未检不构成阻止（仅关键项不通过才阻止）", () => {
    const results = makeResults([
      { result: "未检", isPassed: false, isCritical: true },
    ]);
    expect(decideAdvice(results)).toBe("建议有条件通过");
  });

  it("关键项不通过优先于其他不通过项", () => {
    const results = makeResults([
      { result: "不通过", isPassed: false, hasAlternativePath: true },
      { result: "不通过", isPassed: false, isCritical: true },
    ]);
    expect(decideAdvice(results)).toBe("建议不通过");
  });

  it("runGate + decideAdvice 组合：阶段 1 全过 → 建议通过", () => {
    const results = runGate(1, makePassingChecks(10));
    expect(decideAdvice(results)).toBe("建议通过");
  });

  it("runGate + decideAdvice 组合：阶段 2 来源抽查不过且关键 → 建议不通过", () => {
    const checks = makePassingChecks(9).map((c, i) =>
      i === 8 ? { ...c, result: "不通过" as const, isCritical: true } : c,
    );
    const results = runGate(2, checks);
    expect(decideAdvice(results)).toBe("建议不通过");
  });
});
