import { describe, it, expect } from "vitest";
import {
  judgeMatch,
  scoreCompetitiveness,
  prioritizeSubScenes,
} from "./capability-match.js";
import type {
  CompetitivenessDimension,
  SubScene,
} from "./capability-match.js";

// ─── judgeMatch ────────────────────────────────────────────────

describe("judgeMatch", () => {
  it("A 级证据 + 已交付能力 → 真能解", () => {
    expect(judgeMatch("视频结构化", { maturity: "已交付" }, "A")).toBe("真能解");
  });

  it("B 级证据 + 组件具备能力 → 真能解", () => {
    expect(judgeMatch("人脸识别", { maturity: "组件具备" }, "B")).toBe("真能解");
  });

  it("A 级证据 + 在研能力 → 条件能解", () => {
    expect(judgeMatch("边缘推理", { maturity: "在研" }, "A")).toBe("条件能解");
  });

  it("B 级证据 + 规划能力 → 条件能解", () => {
    expect(judgeMatch("多模态融合", { maturity: "规划" }, "B")).toBe("条件能解");
  });

  it("C 级证据 + 已交付能力 → 条件能解（能力有但证据不足）", () => {
    expect(judgeMatch("视频结构化", { maturity: "已交付" }, "C")).toBe("条件能解");
  });

  it("C 级证据 + 在研能力 → 不能承诺", () => {
    expect(judgeMatch("量子计算", { maturity: "在研" }, "C")).toBe("不能承诺");
  });

  it("D 级证据 → 不能承诺（G-R2：D 必须删除）", () => {
    expect(judgeMatch("任意能力", { maturity: "已交付" }, "D")).toBe("不能承诺");
    expect(judgeMatch("任意能力", { maturity: "规划" }, "D")).toBe("不能承诺");
  });

  it("空缺口描述抛错", () => {
    expect(() => judgeMatch("", { maturity: "已交付" }, "A")).toThrow("需求缺口描述不能为空");
    expect(() => judgeMatch("  ", { maturity: "已交付" }, "A")).toThrow("需求缺口描述不能为空");
  });
});

// ─── scoreCompetitiveness ──────────────────────────────────────

describe("scoreCompetitiveness", () => {
  const fullScores: CompetitivenessDimension[] = [
    { dimension: "技术", score: 5 },
    { dimension: "价格", score: 4 },
    { dimension: "生态", score: 5 },
    { dimension: "服务", score: 4 },
    { dimension: "品牌", score: 4 },
  ];

  it("5 维度满分 25 分 → 强", () => {
    const result = scoreCompetitiveness(fullScores);
    expect(result.totalScore).toBe(22);
    expect(result.level).toBe("强");
  });

  it("全部 5 分 → 总分 25 → 强", () => {
    const max: CompetitivenessDimension[] = DIMENSIONS.map((d) => ({
      dimension: d,
      score: 5,
    }));
    expect(scoreCompetitiveness(max).totalScore).toBe(25);
    expect(scoreCompetitiveness(max).level).toBe("强");
  });

  it("总分 12 → 中", () => {
    const mid: CompetitivenessDimension[] = [
      { dimension: "技术", score: 3 },
      { dimension: "价格", score: 3 },
      { dimension: "生态", score: 2 },
      { dimension: "服务", score: 2 },
      { dimension: "品牌", score: 2 },
    ];
    const result = scoreCompetitiveness(mid);
    expect(result.totalScore).toBe(12);
    expect(result.level).toBe("中");
  });

  it("总分 11 → 弱", () => {
    const low: CompetitivenessDimension[] = [
      { dimension: "技术", score: 3 },
      { dimension: "价格", score: 2 },
      { dimension: "生态", score: 2 },
      { dimension: "服务", score: 2 },
      { dimension: "品牌", score: 2 },
    ];
    const result = scoreCompetitiveness(low);
    expect(result.totalScore).toBe(11);
    expect(result.level).toBe("弱");
  });

  it("全部 1 分 → 总分 5 → 弱", () => {
    const min: CompetitivenessDimension[] = DIMENSIONS.map((d) => ({
      dimension: d,
      score: 1,
    }));
    expect(scoreCompetitiveness(min).totalScore).toBe(5);
    expect(scoreCompetitiveness(min).level).toBe("弱");
  });

  it("维度数量不足 5 个抛错", () => {
    expect(() =>
      scoreCompetitiveness([{ dimension: "技术", score: 5 }]),
    ).toThrow("竞争力维度数量应为 5");
  });

  it("维度数量超过 5 个抛错", () => {
    const extra = [...fullScores, { dimension: "额外", score: 3 }];
    expect(() => scoreCompetitiveness(extra)).toThrow("竞争力维度数量应为 5");
  });

  it("分数越界（<1 或 >5 或非整数）抛错", () => {
    expect(() =>
      scoreCompetitiveness([
        { dimension: "技术", score: 0 },
        ...fullScores.slice(1),
      ]),
    ).toThrow("评分必须为 1-5 的整数");

    expect(() =>
      scoreCompetitiveness([
        ...fullScores.slice(0, 4),
        { dimension: "品牌", score: 6 },
      ]),
    ).toThrow("评分必须为 1-5 的整数");

    expect(() =>
      scoreCompetitiveness([
        ...fullScores.slice(0, 4),
        { dimension: "品牌", score: 3.5 },
      ]),
    ).toThrow("评分必须为 1-5 的整数");
  });
});

// ─── prioritizeSubScenes ──────────────────────────────────────

describe("prioritizeSubScenes", () => {
  const scenes: SubScene[] = [
    { id: "S1", name: "园区安防", valueDensity: 50, fitness: 80, entryDifficulty: 3, maturity: 7 },
    { id: "S2", name: "工业质检", valueDensity: 100, fitness: 60, entryDifficulty: 8, maturity: 4 },
    { id: "S3", name: "智慧零售", valueDensity: 30, fitness: 90, entryDifficulty: 2, maturity: 9 },
  ];

  it("返回结果按优先级分数降序排列", () => {
    const results = prioritizeSubScenes(scenes);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.priorityScore).toBeLessThanOrEqual(results[i - 1]!.priorityScore);
    }
  });

  it("rank 从 1 开始连续递增", () => {
    const results = prioritizeSubScenes(scenes);
    expect(results[0]!.rank).toBe(1);
    expect(results[1]!.rank).toBe(2);
    expect(results[2]!.rank).toBe(3);
  });

  it("所有场景都包含在结果中", () => {
    const results = prioritizeSubScenes(scenes);
    expect(results).toHaveLength(3);
    const ids = results.map((r) => r.sceneId);
    expect(ids).toContain("S1");
    expect(ids).toContain("S2");
    expect(ids).toContain("S3");
  });

  it("高价值 + 高契合 + 低难度 + 高成熟度 → 排第一", () => {
    const best: SubScene = {
      id: "BEST",
      name: "最佳场景",
      valueDensity: 200,
      fitness: 95,
      entryDifficulty: 1,
      maturity: 10,
    };
    const results = prioritizeSubScenes([best, ...scenes]);
    expect(results[0]!.sceneId).toBe("BEST");
  });

  it("单个场景返回 rank=1", () => {
    const results = prioritizeSubScenes([scenes[0]!]);
    expect(results).toHaveLength(1);
    expect(results[0]!.rank).toBe(1);
  });

  it("空列表抛错", () => {
    expect(() => prioritizeSubScenes([])).toThrow("子场景列表不能为空");
  });

  it("所有维度相同的场景分数相同", () => {
    const sameScenes: SubScene[] = [
      { id: "A", name: "场景A", valueDensity: 50, fitness: 70, entryDifficulty: 5, maturity: 5 },
      { id: "B", name: "场景B", valueDensity: 50, fitness: 70, entryDifficulty: 5, maturity: 5 },
    ];
    const results = prioritizeSubScenes(sameScenes);
    expect(results[0]!.priorityScore).toBe(results[1]!.priorityScore);
  });

  it("优先级分数在 0-1 范围内", () => {
    const results = prioritizeSubScenes(scenes);
    for (const r of results) {
      expect(r.priorityScore).toBeGreaterThanOrEqual(0);
      expect(r.priorityScore).toBeLessThanOrEqual(1);
    }
  });
});

// 辅助常量
const DIMENSIONS = ["技术", "价格", "生态", "服务", "品牌"];
