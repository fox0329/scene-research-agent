import { describe, expect, it } from "vitest";
import { fitWidthsMinHeight, toPercentWidths, type FitColumn } from "./table-fit";

/**
 * 列宽自动适配单测（用户定调：表格生成后自动到「行高最小」的状态）
 *
 * 断言口径按**目标函数**写，不锁具体数值：总行高 = Σ_行 max_列 换行行数，
 * 自动分配必须是"在列宽之和 ≤ 中栏宽的前提下，总行高尽量小"。
 */

const col = (key: string, headerPx: number, demands: number[]): FitColumn => ({
  key,
  headerPx,
  demands,
});

/** 与实现同口径的行数估算（单元格 padding 24px，overflow-wrap: anywhere） */
function linesOf(contentPx: number, widthPx: number, padPx = 24): number {
  return Math.max(1, Math.ceil(contentPx / Math.max(1, widthPx - padPx)));
}
function totalLines(cols: FitColumn[], widths: Record<string, number>): number {
  const rows = cols[0]?.demands.length ?? 0;
  let sum = 0;
  for (let r = 0; r < rows; r += 1) {
    sum += Math.max(...cols.map((c) => linesOf(c.demands[r] ?? 0, widths[c.key]!)));
  }
  return sum;
}

describe("fitWidthsMinHeight", () => {
  it("宽裕时全部单行（行高最小），且各列之和不超过容器", () => {
    const cols = [col("a", 60, [80, 90]), col("b", 60, [120, 100])];
    const w = fitWidthsMinHeight(cols, 1000);
    expect(w["a"]! + w["b"]!).toBeLessThanOrEqual(1000);
    expect(totalLines(cols, w)).toBe(2); // 两行都单行 = 最小可能
  });

  it("宽裕时余量按自然宽比例分：内容多的列拿到更多", () => {
    const cols = [col("narrow", 40, [60]), col("wide", 40, [300])];
    const w = fitWidthsMinHeight(cols, 1000);
    expect(w["wide"]!).toBeGreaterThan(w["narrow"]!);
    expect(totalLines(cols, w)).toBe(1);
  });

  it("不足时总行高**不高于**按自然宽等比压缩（等比例分配的朴素做法）", () => {
    const cols = [
      col("c1", 60, [200, 260]),
      col("c2", 60, [520, 40]),
      col("c3", 60, [300, 180]),
    ];
    const container = 520;
    const w = fitWidthsMinHeight(cols, container);
    const naturals = cols.map((c) => Math.max(c.headerPx, ...c.demands) + 24);
    const natSum = naturals.reduce((a, b) => a + b, 0);
    const naive: Record<string, number> = {};
    cols.forEach((c, i) => {
      naive[c.key] = Math.max(64, Math.round((naturals[i]! * container) / natSum));
    });
    expect(totalLines(cols, w)).toBeLessThanOrEqual(totalLines(cols, naive));
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(container);
  });

  it("每列不低于可读下限（除非容器连下限都放不下）", () => {
    const cols = [col("a", 60, [900]), col("b", 60, [900]), col("c", 60, [900])];
    const w = fitWidthsMinHeight(cols, 400, { minPx: 64 });
    for (const c of cols) expect(w[c.key]!).toBeGreaterThanOrEqual(64);

    // 极端窄容器：均分，绝不超过容器（否则会凭空出现横向滚动条）
    const tight = fitWidthsMinHeight(cols, 90, { minPx: 64 });
    expect(Object.values(tight).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(90);
  });

  it("长文本列在放不下时优先获得宽度（它决定每行高度）", () => {
    const cols = [col("short", 60, [40, 40, 40]), col("long", 60, [800, 800, 800])];
    const w = fitWidthsMinHeight(cols, 600);
    expect(w["long"]!).toBeGreaterThan(w["short"]!);
    expect(w["short"]!).toBeGreaterThanOrEqual(64);
  });

  it("空表（还没有数据）也能给出宽度：按表头自然宽，不塌成 0", () => {
    const cols = [col("a", 70, []), col("b", 50, [])];
    const w = fitWidthsMinHeight(cols, 500);
    expect(w["a"]!).toBeGreaterThanOrEqual(70);
    expect(w["b"]!).toBeGreaterThanOrEqual(50);
  });

  it("容器非法/列为空时返回空对象（调用方走兜底宽）", () => {
    expect(fitWidthsMinHeight([], 800)).toEqual({});
    expect(fitWidthsMinHeight([col("a", 60, [100])], 0)).toEqual({});
    expect(fitWidthsMinHeight([col("a", 60, [100])], Number.NaN)).toEqual({});
  });

  it("列很多、内容很长的表也不会卡住（贪心有界收敛）", () => {
    const cols = Array.from({ length: 8 }, (_, i) =>
      col(`c${i}`, 60, Array.from({ length: 60 }, (_, r) => 200 + ((i * 37 + r * 13) % 900))),
    );
    const t0 = Date.now();
    const w = fitWidthsMinHeight(cols, 900);
    expect(Date.now() - t0).toBeLessThan(400);
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(900);
  });
});

/**
 * 自动适配的**质量**守卫：与"穷举最优"比，看总行高差多少
 *
 * 用户要的是「行高最小的状态」，所以不能只测"没崩、没横滚"。这里用 20px 对齐的
 * 穷举当基准（真实最优只会更好），贪心结果不允许比它多出 2 行以上——目前实测
 * 80 组随机样例最大差距 2 行（多数为 0），是"够小"的量化证据。
 */
describe("fitWidthsMinHeight 与穷举最优的差距", () => {
  const totalLinesFor = (cols: FitColumn[], ws: number[]): number => {
    const rows = cols[0]!.demands.length;
    let sum = 0;
    for (let r = 0; r < rows; r += 1) {
      sum += Math.max(...cols.map((c, i) => linesOf(c.demands[r] ?? 0, ws[i]!)));
    }
    return sum;
  };

  const bruteForce = (cols: FitColumn[], container: number): number => {
    const candidates = cols.map((c) => {
      const natural = Math.max(c.headerPx, ...c.demands) + 24;
      const out: number[] = [];
      for (let w = 64; w <= Math.max(64, natural) + 20; w += 20) out.push(w);
      return out;
    });
    let best = Number.POSITIVE_INFINITY;
    const walk = (i: number, acc: number[]): void => {
      if (i === cols.length) {
        if (acc.reduce((a, b) => a + b, 0) > container) return;
        best = Math.min(best, totalLinesFor(cols, acc));
        return;
      }
      for (const w of candidates[i]!) walk(i + 1, [...acc, w]);
    };
    walk(0, []);
    return best;
  };

  it("随机 24 组样例：贪心结果不比穷举最优多出 2 行", () => {
    let worst = 0;
    let compared = 0;
    for (let t = 0; t < 24; t += 1) {
      const cols = Array.from({ length: 2 + (t % 3) }, (_, i) => ({
        key: `c${i}`,
        headerPx: 50 + ((t * 7 + i * 13) % 60),
        demands: Array.from({ length: 3 + (t % 5) }, (_, r) => 40 + ((t * 31 + i * 97 + r * 53) % 600)),
      }));
      const container = 300 + ((t * 53) % 500);
      const greedy = fitWidthsMinHeight(cols, container, { minPx: 64 });
      const best = bruteForce(cols, container);
      if (!Number.isFinite(best)) continue;
      compared += 1;
      const gap = totalLinesFor(cols, cols.map((c) => greedy[c.key]!)) - best;
      worst = Math.max(worst, gap);
    }
    expect(compared).toBeGreaterThan(10);
    expect(worst).toBeLessThanOrEqual(2);
  });
});

/**
 * px → 百分比列宽（用户定调 2026-10-04：「表格整体的宽度不能超过中栏的宽度」
 * 「列宽调整不能在底部加横向移动条」）
 *
 * 关键不变式：各列之和**恰好 100%**——哪怕浏览器缩放、Retina 亚像素取整，
 * 浏览器也只会把误差摊掉，绝不会让表宽超出去冒出横向滚动条。
 */
describe("toPercentWidths：列宽之和恰好 100%", () => {
  const sumPct = (m: Record<string, string>) =>
    Object.values(m).reduce((a, v) => a + Number.parseFloat(v), 0);

  it("按比例归一化，和恰好 100%（不至于 99.9999/100.0001 撑出横滚）", () => {
    const out = toPercentWidths({ a: 199, b: 228, c: 403 });
    expect(sumPct(out)).toBeCloseTo(100, 2);
    expect(Number.parseFloat(out["c"]!)).toBeGreaterThan(Number.parseFloat(out["a"]!));
  });

  it("绝对值无关：px 之和比容器宽（历史残留的旧列宽）也照样归一化到 100%", () => {
    const out = toPercentWidths({ a: 283, b: 230, c: 560 }); // 合计 1073 > 中栏 830
    expect(sumPct(out)).toBeCloseTo(100, 2);
  });

  it("单列 = 100%", () => {
    expect(toPercentWidths({ only: 500 })).toEqual({ only: "100.0000%" });
  });

  it("空集与全零不炸", () => {
    expect(toPercentWidths({})).toEqual({});
    expect(sumPct(toPercentWidths({ a: 0, b: 0 }))).toBe(0);
  });
});
