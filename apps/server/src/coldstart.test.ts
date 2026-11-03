/**
 * 冷启动注入单测（MR3-T3）：用户级条目透明注入、空集不注水、移除后消失。
 */

import { describe, expect, it } from "vitest";
import { createDb } from "@scene/infra";
import { buildColdstartBlock, coldstartBlockFor } from "./coldstart.js";
import { insertRequirement, updateRequirement } from "./requirement-profile.js";
import type { RequirementEntry } from "@scene/contract";

function entry(partial: Partial<RequirementEntry> = {}): RequirementEntry {
  return {
    id: "u1",
    scenario_id: null,
    origin_scenario_id: "s0",
    scope: "user",
    kind: "preference",
    text: "总是关心成本",
    check_anchor: null,
    status: "active",
    confidence: "用户原话",
    sources: [],
    artifact_refs: [],
    created_at: "2026-11-04T00:00:00.000Z",
    updated_at: "2026-11-04T00:00:00.000Z",
    ...partial,
  };
}

describe("buildColdstartBlock（MR3-T3）", () => {
  it("用户级条目注入：条目文本 + 移除入口标注", () => {
    const block = buildColdstartBlock([entry(), entry({ id: "u2", text: "习惯两页纸" })]);
    expect(block).toContain("总是关心成本");
    expect(block).toContain("习惯两页纸");
    expect(block).toContain("用户级偏好");
    expect(block).toContain("移除");
  });

  it("场景级条目不注入（只注用户级）", () => {
    const block = buildColdstartBlock([entry({ scope: "scene", scenario_id: "s1", origin_scenario_id: null })]);
    expect(block).toBe("");
  });

  it("dismissed/superseded 用户级条目不注入", () => {
    expect(buildColdstartBlock([entry({ status: "dismissed" })])).toBe("");
    expect(buildColdstartBlock([entry({ status: "superseded" })])).toBe("");
  });

  it("空集 → 空串（不注水上下文）", () => {
    expect(buildColdstartBlock([])).toBe("");
  });
});

describe("coldstartBlockFor（查库链路）", () => {
  it("dismiss 用户级条目后注入消失（可移除闭环）", () => {
    const db = createDb(":memory:");
    const sid = db.scenarioRepo.insert({ name: "t", status: "进行中", current_stage: 3 }).id;
    const id = insertRequirement(db, {
      scenario_id: null,
      origin_scenario_id: sid,
      scope: "user",
      kind: "preference",
      text: "总是关心成本",
      check_anchor: null,
      confidence: "用户原话",
      sources: [],
    }).id;
    expect(coldstartBlockFor(db, sid)).toContain("总是关心成本");
    updateRequirement(db, id, { status: "dismissed" });
    expect(coldstartBlockFor(db, sid)).toBe("");
  });

  it("不存在的场景 → 空串不炸", () => {
    const db = createDb(":memory:");
    expect(coldstartBlockFor(db, "no-such")).toBe("");
  });
});
