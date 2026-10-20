import { describe, it, expect } from "vitest";
import { middleColumns, tableDef, TABLES } from "./tables.js";
import { UPSTREAM_DEPS, upstreamDepsOf, isUpstreamAllowed } from "./upstream.js";

const allDeps = Object.entries(UPSTREAM_DEPS).flatMap(([stage, deps]) =>
  deps.map((d) => ({ stage: Number(stage), dep: d })),
);

describe("上游依赖表 UPSTREAM_DEPS", () => {
  it("引用的表都存在", () => {
    for (const { dep } of allDeps) {
      expect(tableDef(dep.table as never), `${dep.table} 不存在`).toBeTruthy();
    }
  });

  it("引用的列都存在，且只取中栏列（右栏是溯源留痕，不进提示词）", () => {
    for (const { dep } of allDeps) {
      const def = tableDef(dep.table as never)!;
      const keys = new Set(def.columns.map((c) => c.key));
      const middle = new Set(middleColumns(def).map((c) => c.key));
      for (const col of dep.columns ?? []) {
        expect(keys.has(col), `${dep.table}.${col} 不存在`).toBe(true);
        expect(middle.has(col), `${dep.table}.${col} 不是中栏列`).toBe(true);
      }
    }
  });

  it("单向：只能引用更早阶段的表（同阶段会并发死锁）", () => {
    const stageOf = (code: string) => tableDef(code as never)?.stage ?? null;
    for (const { stage, dep } of allDeps) {
      expect(
        isUpstreamAllowed(stage as never, dep, stageOf),
        `阶段${stage} 不能依赖 ${dep.table}（阶段${stageOf(dep.table)}）`,
      ).toBe(true);
    }
  });

  it("每张被依赖的表都写了 why（否则后人不知道为什么带它）", () => {
    for (const { dep } of allDeps) {
      expect(dep.why.length, `${dep.table} 缺 why`).toBeGreaterThan(8);
    }
  });

  it("行数封顶必须为正且不超过 20（防止整表灌入烧上下文）", () => {
    for (const { dep } of allDeps) {
      expect(dep.maxRows).toBeGreaterThan(0);
      expect(dep.maxRows).toBeLessThanOrEqual(20);
    }
  });

  it("阶段 3–6 都必须有上游依赖（链路不能是空的）", () => {
    for (const stage of [3, 4, 5, 6]) {
      expect(upstreamDepsOf(stage).length, `阶段${stage} 没有上游依赖`).toBeGreaterThan(0);
    }
  });

  it("阶段 3 必须依赖表3-8：表4-3 声称「覆盖表3-8 每条」", () => {
    const deps = upstreamDepsOf(3);
    expect(deps.some((d) => d.table === "表3-8")).toBe(true);
  });

  it("阶段 5 必须依赖表4-3：收益只能挂在判「真能解」的缺口上", () => {
    expect(upstreamDepsOf(5).some((d) => d.table === "表4-3")).toBe(true);
  });

  it("不带冗余元数据列（核实说明/证据等级/来源）", () => {
    const banned = new Set(["verification", "verification_verdict", "evidence_level", "authority", "source"]);
    for (const { dep } of allDeps) {
      for (const col of dep.columns ?? []) {
        expect(banned.has(col), `${dep.table} 带了元数据列 ${col}`).toBe(false);
      }
    }
  });

  it("依赖的表号在表定义里唯一（防止写错表号却碰巧存在）", () => {
    const codes = TABLES.map((t) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
