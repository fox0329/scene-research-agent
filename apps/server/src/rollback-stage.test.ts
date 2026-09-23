/**
 * @scene/server — rollback-stage command 测试（M4-T4.2）
 *
 * 覆盖：回退标记下游待重算、目标阶段保留、current_stage 回写、
 * 非法回退抛错、多场景隔离抽查。
 */

import { describe, it, expect, vi } from "vitest";
import type { Scenario, StageData, StageId } from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { createRollbackStageCommand } from "./rollback-stage.js";

// ─── 最小 mock Db ──────────────────────────────────────────

function createMockDb(scenarios: Scenario[], rows: StageData[]): DbInstance {
  const scenarioStore = [...scenarios];
  const rowStore = [...rows];
  return {
    db: {} as never,
    productLineRepo: {} as never,
    productRepo: {} as never,
    specParamRepo: {} as never,
    capabilityRepo: {} as never,
    boundaryRepo: {} as never,
    limitationRepo: {} as never,
    costRateRepo: {} as never,
    optionalMaterialRepo: {} as never,
    conversationRepo: {} as never,
    messageRepo: {} as never,
    qualityGateRepo: {} as never,
    scenarioRepo: {
      list: vi.fn(() => [...scenarioStore]),
      getById: vi.fn((id: string) => scenarioStore.find((s) => s.id === id)),
      insert: vi.fn(),
      update: vi.fn((id: string, patch: Partial<Scenario>) => {
        const idx = scenarioStore.findIndex((s) => s.id === id);
        if (idx < 0) return undefined;
        scenarioStore[idx] = { ...scenarioStore[idx]!, ...patch };
        return scenarioStore[idx];
      }),
      deleteById: vi.fn(),
    },
    stageDataRepo: {
      list: vi.fn(() => [...rowStore]),
      insert: vi.fn(),
      listByScenarioStage: vi.fn(),
      markStale: vi.fn((_sid: string, stages: StageId[], isStale: boolean) => {
        let changes = 0;
        rowStore.forEach((r, i) => {
          if (r.scenario_id === _sid && stages.includes(r.stage)) {
            rowStore[i] = { ...r, is_stale: isStale };
            changes++;
          }
        });
        return changes;
      }),
      deleteByScenarioStage: vi.fn(),
    },
  } as unknown as DbInstance;
}

function scenario(overrides: Partial<Scenario>): Scenario {
  return {
    id: "sc-1",
    name: "项目",
    product_line_id: "pl-1",
    status: "进行中",
    current_stage: 4,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function row(scenarioId: string, stage: StageId): StageData {
  return {
    id: `row-${scenarioId}-${stage}`,
    scenario_id: scenarioId,
    stage,
    table_code: "表1-1",
    row: { x: 1 },
    is_stale: false,
    created_at: "",
    updated_at: "",
  } as StageData;
}

// ─── 回退主流程 ────────────────────────────────────────────

describe("createRollbackStageCommand", () => {
  it("回退 4→2：下游 3、4 标待重算，目标及更早阶段保留，current_stage 回写 2", () => {
    const rows = [1, 2, 3, 4].map((s) => row("sc-1", s as StageId));
    const db = createMockDb([scenario({})], rows);
    const cmd = createRollbackStageCommand({ db });

    const result = cmd.execute({ scenarioId: "sc-1", targetStage: 2 as StageId });

    expect(result.toStage).toBe(2);
    expect(result.markedStages).toEqual([3, 4]);
    expect(result.markedRows).toBe(2);
    expect(result.banner).toContain("由您决定");

    const after = db.stageDataRepo.list();
    expect(after.find((r) => r.stage === 2)!.is_stale).toBe(false); // 目标保留
    expect(after.find((r) => r.stage === 1)!.is_stale).toBe(false);
    expect(after.find((r) => r.stage === 3)!.is_stale).toBe(true);
    expect(after.find((r) => r.stage === 4)!.is_stale).toBe(true);
    expect(db.scenarioRepo.getById("sc-1")!.current_stage).toBe(2);
  });

  it("回退到 0：下游 1..4 全标记", () => {
    const rows = [0, 1, 2, 3, 4].map((s) => row("sc-1", s as StageId));
    const db = createMockDb([scenario({})], rows);
    const result = createRollbackStageCommand({ db }).execute({
      scenarioId: "sc-1",
      targetStage: 0,
    });
    expect(result.markedStages).toEqual([1, 2, 3, 4]);
    expect(result.markedRows).toBe(4);
    expect(db.stageDataRepo.list().find((r) => r.stage === 0)!.is_stale).toBe(false);
  });

  it("目标不早于当前阶段 → 抛错且不改数据", () => {
    const rows = [row("sc-1", 3)];
    const db = createMockDb([scenario({})], rows);
    const cmd = createRollbackStageCommand({ db });

    expect(() => cmd.execute({ scenarioId: "sc-1", targetStage: 4 as StageId })).toThrow(
      /必须早于/,
    );
    expect(() => cmd.execute({ scenarioId: "sc-1", targetStage: 5 as StageId })).toThrow();
    expect(db.stageDataRepo.list()[0]!.is_stale).toBe(false);
    expect(db.scenarioRepo.getById("sc-1")!.current_stage).toBe(4);
  });

  it("场景不存在 → 抛错", () => {
    const db = createMockDb([], []);
    expect(() =>
      createRollbackStageCommand({ db }).execute({
        scenarioId: "nope",
        targetStage: 1,
      }),
    ).toThrow(/不存在/);
  });

  it("多场景隔离抽查：回退场景 A 不影响场景 B 数据", () => {
    const rows = [
      row("sc-1", 3),
      row("sc-1", 4),
      row("sc-2", 3), // 同阶段号，属另一场景
      row("sc-2", 4),
    ];
    const db = createMockDb(
      [scenario({}), scenario({ id: "sc-2", current_stage: 4 })],
      rows,
    );

    createRollbackStageCommand({ db }).execute({
      scenarioId: "sc-1",
      targetStage: 2 as StageId,
    });

    const after = db.stageDataRepo.list();
    expect(after.filter((r) => r.scenario_id === "sc-1").every((r) => r.is_stale)).toBe(true);
    expect(after.filter((r) => r.scenario_id === "sc-2").every((r) => !r.is_stale)).toBe(true);
    expect(db.scenarioRepo.getById("sc-2")!.current_stage).toBe(4);
  });
});
