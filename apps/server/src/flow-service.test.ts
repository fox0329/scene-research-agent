/**
 * @scene/server — 业务流程推进测试（v1.5 逐页推进）
 *
 * 覆盖三条既定规则：数据判定可用 + 用户显式推进；默认锁步（可一键解锁全部）；
 * 已完成步骤可回去重跑（清后缀标记、数据保留、场景回到进行中）。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DshClient } from "@scene/contract";
import { createDb } from "@scene/infra";
import type { DbInstance } from "@scene/infra";
import { createApp } from "./app.js";
import { createSseHub } from "./sse-hub.js";
import { getFlowState, completeFlowStep, reopenFlowStep, unlockAllFlowSteps } from "./flow-service.js";
import { ensureAnchorRows, writeAnchorRows } from "./scenario-anchor.js";

function mockDsh(): DshClient {
  return {
    createSession: vi.fn(async () => ({ sessionId: "s" })),
    prompt: vi.fn(async function* () {
      yield { type: "done" as const };
    }),
    cancel: vi.fn(async () => {}),
  } as unknown as DshClient;
}

function setup(): { db: DbInstance; scenarioId: string } {
  const db = createDb(":memory:");
  const line = db.productLineRepo.insert({ name: "感知与控制" });
  const sc = db.scenarioRepo.insert({
    name: "智慧水务",
    description: null,
    product_line_id: line.id,
    status: "进行中",
    current_stage: 0,
  });
  return { db, scenarioId: sc.id };
}

/** 把表1-1 的 6 项 L1 全标为用户确认 */
function confirmAllL1(db: DbInstance, scenarioId: string): void {
  ensureAnchorRows(db, scenarioId, "智慧水务");
  writeAnchorRows(
    db,
    scenarioId,
    [
      "客户类型/行业",
      "覆盖什么",
      "明确不含什么",
      "核心用途",
      "切入点",
      "价值主张",
    ].map((item) => ({ item, content: `${item}值`, source_type: "用户确认" as const })),
  );
}

const state = (db: DbInstance, scenarioId: string, step: number) =>
  getFlowState(db, db.scenarioRepo.getById(scenarioId)!).steps.find((s) => s.id === step)!;

describe("flow-service — 锁步与就绪", () => {
  it("全新场景：第 1 步当前且未就绪（定义还没整理），其余全锁", () => {
    const { db, scenarioId } = setup();
    const flow = getFlowState(db, db.scenarioRepo.getById(scenarioId)!);
    expect(flow.currentStep).toBe(1);
    expect(flow.completedCount).toBe(0);
    expect(flow.steps[0]!.state).toBe("当前");
    expect(flow.steps[0]!.ready).toBe(false);
    expect(flow.steps[0]!.readyHint).toContain("场景定义"); // 指向对话与「整理成定义」
    expect(flow.steps.slice(1).every((s) => s.state === "未解锁")).toBe(true);
  });

  it("第 1 步（场景定义与边界）：定义没整理时未就绪，且提示指向「场景定义」对话", () => {
    const { db, scenarioId } = setup();
    ensureAnchorRows(db, scenarioId, "智慧水务");
    const s = state(db, scenarioId, 1);
    expect(s.ready).toBe(false);
    // 定义对话属「新建场景」，不占流程步；这里必须把用户引到对话去
    expect(s.readyHint).toContain("场景定义");
    expect(s.readyHint).toContain("整理成定义");
  });

  it("第 1 步就绪 = 定义已整理（**不要求确认齐全**，核心项只在提示里点名）", () => {
    const { db, scenarioId } = setup();
    ensureAnchorRows(db, scenarioId, "智慧水务");
    expect(state(db, scenarioId, 1).ready).toBe(false);

    // 整理成定义：模型只填了 1 项 → 已整理 → **即可推进**（用户定调：定义不卡后面的流程）
    writeAnchorRows(db, scenarioId, [
      { item: "客户类型/行业", content: "市政水务集团", source_type: "用户补充" },
    ]);
    const partial = state(db, scenarioId, 1);
    expect(partial.ready).toBe(true);
    expect(partial.readyHint).toContain("定义已整理");
    expect(partial.readyHint).toContain("核心 1/2 项已确认"); // 提示但不阻断

    confirmAllL1(db, scenarioId);
    const ready = state(db, scenarioId, 1);
    expect(ready.ready).toBe(true);
    expect(ready.readyHint).toContain("核心 2/2 项已确认");

    const flow = completeFlowStep(db, db.scenarioRepo.getById(scenarioId)!, 1);
    expect(flow.currentStep).toBe(2);
    expect(flow.steps[0]!.state).toBe("已完成");
    expect(flow.steps[1]!.state).toBe("当前");
    expect(flow.steps[1]!.title).toBe("认识场景");
  });

  it("AI 推断不改变就绪（定义已整理即可推进），但会进右栏清单等用户表态", () => {
    const { db, scenarioId } = setup();
    ensureAnchorRows(db, scenarioId, "智慧水务");
    writeAnchorRows(
      db,
      scenarioId,
      ["客户类型/行业", "覆盖什么", "明确不含什么", "核心用途", "切入点", "价值主张"].map(
        (item) => ({ item, content: "x", source_type: "AI推断" as const }),
      ),
    );
    // 定义已整理 → 就绪（AI 推断也算"整理过"，用户可以选择直接往下走）
    const s1 = state(db, scenarioId, 1);
    expect(s1.ready).toBe(true);
    expect(s1.readyHint).toContain("核心 0/2 项已确认"); // 提醒还没表态，但不拦
  });

  it("第 2 步（认识场景）只要求有产出，不要求齐备", () => {
    const { db, scenarioId } = setup();
    expect(state(db, scenarioId, 2).ready).toBe(false);
    db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 1,
      table_code: "表1-2",
      row: { link: "制水", can_touch: "可以碰" },
      is_stale: false,
    });
    const s2 = state(db, scenarioId, 2);
    expect(s2.ready).toBe(true);
    expect(s2.progress.rows).toBe(1);
    expect(s2.progress.expectedTables).toBe(7);
  });

  it("完成第 2 步推进 current_stage 到 1；完成第 8 步把场景标记为已完成", () => {
    const { db, scenarioId } = setup();
    completeFlowStep(db, db.scenarioRepo.getById(scenarioId)!, 2);
    expect(db.scenarioRepo.getById(scenarioId)!.current_stage).toBe(1);

    for (const n of [1, 3, 4, 5, 6, 7, 8]) {
      completeFlowStep(db, db.scenarioRepo.getById(scenarioId)!, n);
    }
    const sc = db.scenarioRepo.getById(scenarioId)!;
    expect(sc.status).toBe("已完成");
    const flow = getFlowState(db, sc);
    expect(flow.finished).toBe(true);
  });

  it("解锁全部：未完成步骤都是「可推进」", () => {
    const { db, scenarioId } = setup();
    const flow = unlockAllFlowSteps(db, db.scenarioRepo.getById(scenarioId)!);
    expect(flow.unlockedAll).toBe(true);
    expect(flow.steps.slice(1).every((s) => s.state === "可推进")).toBe(true);
  });
});

describe("flow-service — 回到某步重跑", () => {
  it("reopen 清掉该步及其后标记、场景回到进行中、数据保留", () => {
    const { db, scenarioId } = setup();
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      completeFlowStep(db, db.scenarioRepo.getById(scenarioId)!, n);
    }
    expect(db.scenarioRepo.getById(scenarioId)!.status).toBe("已完成");

    db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 1,
      table_code: "表1-2",
      row: { link: "制水" },
      is_stale: false,
    });
    const flow = reopenFlowStep(db, db.scenarioRepo.getById(scenarioId)!, 4);
    expect(flow.currentStep).toBe(4);
    expect(flow.completedCount).toBe(3);
    expect(flow.steps.filter((s) => s.state === "已完成").map((s) => s.id)).toEqual([1, 2, 3]);
    expect(db.scenarioRepo.getById(scenarioId)!.status).toBe("进行中");
    // 数据保留
    expect(db.stageDataRepo.list({ where: "scenario_id = ?", params: [scenarioId] })).toHaveLength(1);
  });
});

describe("flow-service — 路由", () => {
  let db: DbInstance;
  let app: ReturnType<typeof createApp>;
  let scenarioId: string;

  beforeEach(() => {
    const s = setup();
    db = s.db;
    scenarioId = s.scenarioId;
    process.env.EXPORT_DIR = mkdtempSync(join(tmpdir(), "scene-export-"));
    process.env.SCENE_PROVIDERS_FILE = join(
      mkdtempSync(join(tmpdir(), "scene-providers-")),
      "providers.local.json",
    );
    app = createApp({ db, dshClient: mockDsh(), hub: createSseHub() });
  });

  it("GET /flow 返回 8 步三态", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/projects/${scenarioId}/flow` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { steps: unknown[]; currentStep: number; finished: boolean };
    expect(body.steps).toHaveLength(8);
    expect(body.currentStep).toBe(1);
    expect(body.finished).toBe(false);
  });

  it("POST complete / reopen / unlock-all 生效", async () => {
    const c1 = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/flow/steps/1/complete`,
    });
    expect(c1.statusCode).toBe(200);
    expect((c1.json() as { currentStep: number }).currentStep).toBe(2);

    const un = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/flow/unlock-all`,
    });
    expect((un.json() as { unlockedAll: boolean }).unlockedAll).toBe(true);

    const re = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/flow/steps/1/reopen`,
    });
    expect((re.json() as { completedCount: number }).completedCount).toBe(0);
  });

  it("步骤号非法 400；场景不存在 404", async () => {
    const bad = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/flow/steps/10/complete`,
    });
    expect(bad.statusCode).toBe(400);
    const nf = await app.inject({ method: "GET", url: "/api/v1/projects/nope/flow" });
    expect(nf.statusCode).toBe(404);
  });
});
