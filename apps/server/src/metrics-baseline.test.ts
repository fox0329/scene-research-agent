/**
 * 指标基线计算单测（MR2-T6）：归一化分母、refine 应用计数、undo/rewrite 计数。
 */

import { describe, expect, it } from "vitest";
import { createDb, type DbInstance } from "@scene/infra";
import { computeReflectionMetrics } from "./metrics-baseline.js";
import { recordInteractionEvent } from "./requirement-profile.js";

function buildDbWithEvents(): { db: DbInstance; sid: string } {
  const db = createDb(":memory:");
  const sid = db.scenarioRepo.insert({ name: "t", status: "进行中", current_stage: 3 }).id;
  db.stageDataRepo.insert({ scenario_id: sid, stage: 3, table_code: "表3-1", row: { 方案: "x" } } as never);
  db.stageDataRepo.insert({ scenario_id: sid, stage: 3, table_code: "表3-1", row: { 方案: "y" } } as never);
  recordInteractionEvent(db, { scenario_id: sid, surface: "ui", action: "edit_cell", target: "refine:表3-1:r1:方案" });
  recordInteractionEvent(db, { scenario_id: sid, surface: "ui", action: "undo", target: "表3-1:r1" });
  recordInteractionEvent(db, { scenario_id: sid, surface: "conversation", action: "rewrite", target: "stage:3" });
  return { db, sid };
}

describe("computeReflectionMetrics（MR2-T6）", () => {
  it("按产物数归一化：2 产物 / 1 refine 应用 / 2 undo+rewrite", () => {
    const { db } = buildDbWithEvents();
    const m = computeReflectionMetrics(db);
    expect(m.products).toBe(2);
    expect(m.refineApplyRate).toBe(0.5);
    expect(m.undoRewriteRate).toBe(1);
  });

  it("edit_cell 不带 refine 前缀不计入反思指标（普通手编不是重写）", () => {
    const { db, sid } = buildDbWithEvents();
    recordInteractionEvent(db, { scenario_id: sid, surface: "ui", action: "edit_cell", target: "表3-1:r1:方案" });
    const m = computeReflectionMetrics(db);
    expect(m.refineApplyRate).toBe(0.5);
  });

  it("空库：零产物零频次不炸", () => {
    const db = createDb(":memory:");
    const m = computeReflectionMetrics(db);
    expect(m.products).toBe(0);
    expect(m.refineApplyRate).toBe(0);
    expect(m.undoRewriteRate).toBe(0);
    expect(m.clarifyRepeatCount).toBe(0);
  });
});
