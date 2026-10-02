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
    product_line_id: own.id,
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
    const m1 = data["M1_产品型号"] ?? [];
    expect(m1.length).toBeGreaterThanOrEqual(1);
    expect(m1.some((r) => String(r["data_scope"]).startsWith("主库"))).toBe(true);
  });

  it("同一型号在多库出现时去重，且本场景优先", () => {
    const { db, scenarioId } = setup();
    const sc = db.scenarioRepo.getById(scenarioId)!;
    const data = collectUpstreamData(db, sc, 3) as Record<string, Record<string, unknown>[]>;
    const m1 = data["M1_产品型号"] ?? [];
    const ipc = m1.filter((r) => r["model"] === "IPC-3000");
    expect(ipc).toHaveLength(1);
    expect(ipc[0]![ "data_scope"]).toBe("本场景");
    expect(ipc[0]!["name"]).toBe("边缘控制器（水务定制）");
  });

  it("每行都带来源标注（主库/本场景可区分）", () => {
    const { db, scenarioId } = setup();
    const sc = db.scenarioRepo.getById(scenarioId)!;
    const data = collectUpstreamData(db, sc, 3) as Record<string, Record<string, unknown>[]>;
    for (const key of ["M1_产品型号", "M2_规格参数", "M3_能力清单", "M4_边界声明"]) {
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
    const scopes = (data["M1_产品型号"] ?? []).map((r) => String(r["data_scope"]));
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
    const scopes = (data["M1_产品型号"] ?? []).map((r) => String(r["data_scope"]));
    expect(scopes).toContain("主库：公司产品库");
    expect(data["M1_产品型号"]?.map((r) => r["model"])).toContain("SEN-200");
  });
});
