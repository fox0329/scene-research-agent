/**
 * @scene/server — 资料合并与来源区分测试（v1.5 / v2.9）
 *
 * 用户决策：产品资料是**全局基础设施**（上传一次全场景共用）；单个场景也能提自己的
 * 产品资料，**与主库存储隔离**；分析时**默认合并、来源可区分**、同一型号**本场景优先**。
 *
 * v2.9 起「通用库引用」是**默认全引用 + 可显式取消**（用户定调："新建项目，默认直接引用
 * 基础产品资料（默认勾选），除非用户取消勾选"）——表里没有行 = 引用，`excluded = 1` = 不引用。
 */

import { describe, it, expect } from "vitest";
import { createDb } from "@scene/infra";
import { collectUpstreamData } from "./advance-stage.js";

/** 产品行必填字段补齐（launch_date / position_desc 非空） */
const prod = (
  product_line_id: string,
  model: string,
  name: string,
): Parameters<ReturnType<typeof createDb>["productRepo"]["insert"]>[0] =>
  ({
    product_line_id,
    model,
    name,
    status: "在售",
    launch_date: "2025-01-01",
    position_desc: "主力型号",
  }) as never;

function setup() {
  const db = createDb(":memory:");
  // 主库（基础设施：scenario_id 为 NULL）
  const global = db.productLineRepo.insert({ name: "公司产品库" });
  db.productRepo.insert(prod(global.id, "SEN-200", "压力变送器"));
  db.productRepo.insert(prod(global.id, "IPC-3000", "边缘控制器"));

  // 场景 + 专属库（只有 IPC-3000，但型号与主库重复：应本场景优先）
  const own = db.productLineRepo.insert({ name: "智慧水务（本场景）" });
  const sc = db.scenarioRepo.insert({
    name: "智慧水务",
    description: null,
    status: "进行中",
    current_stage: 1,
  });
  db.productLineRepo.update(own.id, { scenario_id: sc.id } as never);
  db.productRepo.insert(prod(own.id, "IPC-3000", "边缘控制器（水务定制）"));
  return { db, scenarioId: sc.id, globalId: global.id, ownId: own.id };
}

describe("collectUpstreamData — 通用库默认引用、可逐个取消", () => {
  it("新建场景不做任何操作，默认就能看到主库产品", () => {
    const { db, scenarioId } = setup();
    const sc = db.scenarioRepo.getById(scenarioId)!;
    const data = collectUpstreamData(db, sc, 3) as Record<string, Record<string, unknown>[]>;
    const m1 = data["产品清单"] ?? [];
    expect(m1.length).toBeGreaterThanOrEqual(1);
    expect(m1.some((r) => String(r["data_scope"]).startsWith("主库"))).toBe(true);
  });

  it("同一型号在多库出现时去重，且本场景优先", () => {
    const { db, scenarioId } = setup();
    const sc = db.scenarioRepo.getById(scenarioId)!;
    const data = collectUpstreamData(db, sc, 3) as Record<string, Record<string, unknown>[]>;
    const m1 = data["产品清单"] ?? [];
    const ipc = m1.filter((r) => r["model"] === "IPC-3000");
    expect(ipc).toHaveLength(1);
    expect(ipc[0]![ "data_scope"]).toBe("本场景");
    expect(ipc[0]!["name"]).toBe("边缘控制器（水务定制）");
  });

  it("每行都带来源标注（主库/本场景可区分）", () => {
    const { db, scenarioId } = setup();
    const sc = db.scenarioRepo.getById(scenarioId)!;
    const data = collectUpstreamData(db, sc, 3) as Record<string, Record<string, unknown>[]>;
    for (const key of ["产品清单", "规格书", "能力清单", "边界与限制"]) {
      for (const row of data[key] ?? []) {
        expect(typeof row["data_scope"], key).toBe("string");
      }
    }
  });

  it("取消勾选（excluded = 1）= 这个通用库不参与本场景分析", () => {
    const { db, scenarioId, globalId } = setup();
    const sc = db.scenarioRepo.getById(scenarioId)!;
    db.scenarioLinkedLineRepo.insert({
      scenario_id: scenarioId,
      product_line_id: globalId,
      excluded: 1,
    } as never);
    const data = collectUpstreamData(db, sc, 3) as Record<string, Record<string, unknown>[]>;
    const scopes = (data["产品清单"] ?? []).map((r) => String(r["data_scope"]));
    // 主库被排除后，只剩本场景那条（IPC-3000 定制）
    expect(scopes.every((s) => !s.startsWith("主库"))).toBe(true);
    expect(scopes).toContain("本场景");
  });

  it("取消后又勾回来（excluded = 0）= 重新参与合并", () => {
    const { db, scenarioId, globalId } = setup();
    const sc = db.scenarioRepo.getById(scenarioId)!;
    const rel = db.scenarioLinkedLineRepo.insert({
      scenario_id: scenarioId,
      product_line_id: globalId,
      excluded: 1,
    } as never);
    db.scenarioLinkedLineRepo.update(rel.id, { excluded: 0 } as never);
    const data = collectUpstreamData(db, sc, 3) as Record<string, Record<string, unknown>[]>;
    const scopes = (data["产品清单"] ?? []).map((r) => String(r["data_scope"]));
    expect(scopes).toContain("主库：公司产品库");
    expect(data["产品清单"]?.map((r) => r["model"])).toContain("SEN-200");
  });
});

/**
 * 阶段 2 之后的上游结论必须真的进下游（变更表 #225）
 *
 * 审计（docs/表格精简审计.md §3.1）发现原来只带 M 库表与阶段1，导致
 * 表4-3 声称「覆盖表3-8 每条」却读不到表3-8。这些用例锁住接线。
 */
describe("collectUpstreamData — 阶段 2/3 的结论进下游", () => {
  /** 造一条 stage_data 行（跳过 repo 类型约束，直接写库） */
  function putRow(
    db: ReturnType<typeof createDb>,
    scenarioId: string,
    stage: number,
    tableCode: string,
    row: Record<string, unknown>,
  ) {
    db.db
      .prepare(
        `INSERT INTO stage_data (id, scenario_id, stage, table_code, row, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        `${tableCode}-${Math.random().toString(36).slice(2)}`,
        scenarioId,
        stage,
        tableCode,
        JSON.stringify(row),
        new Date().toISOString(),
        new Date().toISOString(),
      );
  }

  function withRows() {
    const { db, scenarioId } = setup();
    putRow(db, scenarioId, 2, "表3-8", {
      rank: "1",
      gap: "压铸机数据接口封闭，OEE 无法自动归集",
      who_hurts: "设备部",
      pain_level: "高",
      verification: "这段是右栏留痕，不该进提示词",
    });
    putRow(db, scenarioId, 2, "表3-2", { form: "整线交付", key_points: "交付整线，不含运维", players: "海康、大华", position: "扩张", price_band: "80–150 万元/线（项目成交）", fit_for: "10 条以上产线" });
    putRow(db, scenarioId, 3, "表4-2", { link: "设备联网", can_touch: "可以碰", our_role: "替代" });
    return { db, scenarioId };
  }

  it("阶段 3 能看到表3-8 的缺口（表4-3 的覆盖性靠它）", () => {
    const { db, scenarioId } = withRows();
    const sc = db.scenarioRepo.getById(scenarioId)!;
    const data = collectUpstreamData(db, sc, 3) as Record<string, Record<string, unknown>[]>;
    expect(data["表3-8"]?.length).toBe(1);
    expect(String(data["表3-8"]![0]!["gap"])).toContain("接口封闭");
  });

  it("阶段 3 能看到表3-2 的形态与玩家（表4-5 的对照对象池）", () => {
    const { db, scenarioId } = withRows();
    const sc = db.scenarioRepo.getById(scenarioId)!;
    const data = collectUpstreamData(db, sc, 3) as Record<string, Record<string, unknown>[]>;
    expect(data["表3-2"]?.[0]?.["players"]).toBe("海康、大华");
  });

  it("右栏留痕（核实说明）不进上游，省上下文", () => {
    const { db, scenarioId } = withRows();
    const sc = db.scenarioRepo.getById(scenarioId)!;
    const data = collectUpstreamData(db, sc, 3) as Record<string, Record<string, unknown>[]>;
    expect(data["表3-8"]![0]).not.toHaveProperty("verification");
  });

  it("阶段 4 能看到表4-2 的参与判定（方案边界靠它）", () => {
    const { db, scenarioId } = withRows();
    const sc = db.scenarioRepo.getById(scenarioId)!;
    const data = collectUpstreamData(db, sc, 4) as Record<string, Record<string, unknown>[]>;
    expect(data["表4-2"]?.[0]?.["our_role"]).toBe("替代");
  });

  it("阶段 2 不拿阶段 3 的表（单向）", () => {
    const { db, scenarioId } = withRows();
    const sc = db.scenarioRepo.getById(scenarioId)!;
    const data = collectUpstreamData(db, sc, 2) as Record<string, unknown[]>;
    expect(data["表4-2"]).toBeUndefined();
    expect(data["表3-8"]).toBeUndefined();
  });
});
