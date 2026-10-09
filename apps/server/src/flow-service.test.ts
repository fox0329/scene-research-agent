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
import { getFlowState, completeFlowStep, reopenFlowStep } from "./flow-service.js";
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
  db.productLineRepo.insert({ name: "感知与控制" });
  const sc = db.scenarioRepo.insert({
    name: "智慧水务",
    description: null,
    status: "进行中",
    current_stage: 0,
  });
  return { db, scenarioId: sc.id };
}

/** 智能体侧 5 项业务画像（就绪判定只看这 5 项写没写出来） */
const BUSINESS_PORTRAIT = ["场景边界", "生产对象", "核心生产系统", "买方类型", "采购特征"];

const state = (db: DbInstance, scenarioId: string, step: number) =>
  getFlowState(db, db.scenarioRepo.getById(scenarioId)!).steps.find((s) => s.id === step)!;

describe("flow-service — 锁步与就绪", () => {
  it("全新场景：第 1 步当前且未就绪（业务画像还没写出），其余全锁", () => {
    const { db, scenarioId } = setup();
    const flow = getFlowState(db, db.scenarioRepo.getById(scenarioId)!);
    expect(flow.currentStep).toBe(1);
    expect(flow.completedCount).toBe(0);
    expect(flow.steps[0]!.state).toBe("当前");
    expect(flow.steps[0]!.ready).toBe(false);
    // 用户只需要给个场景名，写画像的是智能体——提示是"我来写"，不是"你来填"
    expect(flow.steps[0]!.readyHint).toContain("场景名称");
    expect(flow.steps[0]!.readyHint).toContain("画像");
    expect(flow.steps.slice(1).every((s) => s.state === "未解锁")).toBe(true);
  });

  it("第 1 步（场景定义与边界）：画像没写出时未就绪，提示是智能体主动领活", () => {
    const { db, scenarioId } = setup();
    ensureAnchorRows(db, scenarioId, "智慧水务");
    const s = state(db, scenarioId, 1);
    expect(s.ready).toBe(false);
    // 只有「场景名称」（骨架预填）不算画出画像
    expect(s.readyHint).toContain("先说一句场景名称");
    // 提示里点名的是**智能体要写的 5 项**，不能反过来问用户要细节
    expect(s.readyHint).toContain("场景边界");
    expect(s.readyHint).toContain("采购特征");
  });

  it("整份定义全是「（待研究）」占位 = 没写出画像（变更表 #171：占位不是信息）", () => {
    const { db, scenarioId } = setup();
    ensureAnchorRows(db, scenarioId, "智慧医院");
    writeAnchorRows(db, scenarioId, [
      { item: "场景边界", content: "（待研究）——需先确定场景名称，才能框定包含哪些场所/环节", source_type: "AI推断" },
      { item: "生产对象", content: "（待研究）", source_type: "AI推断" },
      { item: "核心生产系统", content: "待定：场景确定后按其工艺过程与配套安全、运维展开", source_type: "AI推断" },
    ]);
    const s = state(db, scenarioId, 1);
    // 占位符不是信息：否则"空定义"会被判成"已写出 3 项"，界面显示就绪、下游照跑
    expect(s.ready).toBe(false);
    expect(s.readyHint).toContain("先说一句场景名称");
  });

  it("第 1 步就绪 = 智能体写出业务画像（**不要求用户逐项确认**）", () => {
    const { db, scenarioId } = setup();
    ensureAnchorRows(db, scenarioId, "智慧水务");
    expect(state(db, scenarioId, 1).ready).toBe(false);

    // 智能体只写出 1 项 → 已写出画像 → **即可推进**（用户定调：定义不卡后面的流程）
    writeAnchorRows(db, scenarioId, [
      { item: "场景边界", content: "市政水厂、加压泵站、二次供水", source_type: "AI推断" },
    ]);
    const partial = state(db, scenarioId, 1);
    expect(partial.ready).toBe(true);
    expect(partial.readyHint).toContain("场景业务画像已写出 1 项");
    expect(partial.readyHint).toContain("没问题就继续");

    const flow = completeFlowStep(db, db.scenarioRepo.getById(scenarioId)!, 1);
    expect(flow.currentStep).toBe(2);
    expect(flow.steps[0]!.state).toBe("已完成");
    expect(flow.steps[1]!.state).toBe("当前");
    expect(flow.steps[1]!.title).toBe("认识场景");
  });

  it("没点「确认无误」也照样就绪（确认不卡推进），且提示里不出现「待确认」", () => {
    const { db, scenarioId } = setup();
    ensureAnchorRows(db, scenarioId, "智慧水务");
    writeAnchorRows(
      db,
      scenarioId,
      BUSINESS_PORTRAIT.map((item) => ({
        item,
        content: "x",
        source_type: "AI推断" as const,
      })),
    );
    const s1 = state(db, scenarioId, 1);
    expect(s1.ready).toBe(true);
    expect(s1.readyHint).toContain("已写出 5 项");
    // 用户定调「不用显示待确认」——就绪话术里也不许出现这个词
    expect(s1.readyHint).not.toContain("待确认");
    expect(s1.readyHint).not.toContain("已确认");
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

  it("完成第 2 步推进 current_stage 到 1；完成第 7 步把场景标记为已完成", () => {
    const { db, scenarioId } = setup();
    completeFlowStep(db, db.scenarioRepo.getById(scenarioId)!, 2);
    expect(db.scenarioRepo.getById(scenarioId)!.current_stage).toBe(1);

    for (const n of [1, 3, 4, 5, 6, 7]) {
      completeFlowStep(db, db.scenarioRepo.getById(scenarioId)!, n);
    }
    const sc = db.scenarioRepo.getById(scenarioId)!;
    expect(sc.status).toBe("已完成");
    const flow = getFlowState(db, sc);
    expect(flow.finished).toBe(true);
  });

  it("锁步：未完成步不进「可推进」，也无法跳过（没有解锁全部这个后门）", () => {
    const { db, scenarioId } = setup();
    const flow = getFlowState(db, db.scenarioRepo.getById(scenarioId)!);
    expect(flow.steps.slice(1).every((s) => s.state === "未解锁")).toBe(true);
  });
});

describe("flow-service — 回到某步重跑", () => {
  it("reopen 清掉该步及其后标记、场景回到进行中、数据保留", () => {
    const { db, scenarioId } = setup();
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
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

  it("GET /flow 返回 7 步三态", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/projects/${scenarioId}/flow` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { steps: unknown[]; currentStep: number; finished: boolean };
    expect(body.steps).toHaveLength(7);
    expect(body.currentStep).toBe(1);
    expect(body.finished).toBe(false);
  });

  it("POST complete / reopen 生效", async () => {
    const c1 = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/flow/steps/1/complete`,
    });
    expect(c1.statusCode).toBe(200);
    expect((c1.json() as { currentStep: number }).currentStep).toBe(2);

    // 解锁全部端点已删除（用户定调不需要这个功能）
    const un = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/flow/unlock-all`,
    });
    expect(un.statusCode).toBe(404);

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
