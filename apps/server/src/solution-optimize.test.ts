/**
 * @scene/server — 解决方案对话优化测试（#303）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DshClient, FollowEvent, Scenario } from "@scene/contract";
import { createDb } from "@scene/infra";
import { createSolutionOptimizer } from "./solution-optimize.js";
import { saveReportFile } from "./report-service.js";

let dir: string;
let oldDeliverableDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "solution-opt-"));
  oldDeliverableDir = process.env.DELIVERABLE_DIR;
  process.env.DELIVERABLE_DIR = dir;
});

afterEach(() => {
  if (oldDeliverableDir === undefined) delete process.env.DELIVERABLE_DIR;
  else process.env.DELIVERABLE_DIR = oldDeliverableDir;
  rmSync(dir, { recursive: true, force: true });
});

function seed(db: ReturnType<typeof createDb>): Scenario {
  return db.scenarioRepo.insert({
    name: "地铁能源管控",
    description: "",
    status: "进行中",
    current_stage: 3,
  } as never);
}

function mockDsh(reply: string | string[]): DshClient {
  const pieces = Array.isArray(reply) ? reply : [reply];
  return {
    createSession: async () => ({ sessionId: "s" }),
    prompt: async function* (): AsyncGenerator<FollowEvent> {
      for (const p of pieces) yield { type: "text", text: p };
      yield { type: "done" };
    },
    cancel: async () => {},
  };
}

const REPORT = `# 地铁能源管控解决方案

## 一、场景理解

站厅照明与环控是能耗大头，改造空间明确。

## 二、总体架构

采用分层架构：感知层、平台层、应用层。
`;

describe("createSolutionOptimizer", () => {
  it("按指令改写并落回同一份报告", async () => {
    const db = createDb(":memory:");
    const scenario = seed(db);
    const file = saveReportFile(scenario, "solution", REPORT).path;
    const next = REPORT.replace("改造空间明确。", "改造空间明确，收益可测算。").replace("## 二、总体架构\n\n", "");
    const opt = createSolutionOptimizer({ db, dshClient: mockDsh(next) });
    const result = await opt.optimize(scenario.id, "精简到只留要点");
    expect(result.after).toBeGreaterThan(0);
    expect(readFileSync(file, "utf8")).toContain("收益可测算");
    expect(result.note).toContain("优化解决方案");
  });

  it("没有正式版报告时明确报错，不静默生成", async () => {
    const db = createDb(":memory:");
    const scenario = seed(db);
    const opt = createSolutionOptimizer({ db, dshClient: mockDsh(REPORT) });
    await expect(opt.optimize(scenario.id, "简化")).rejects.toThrow(/生成报告/);
  });

  it("改写结果缺标题或篇幅异常时拒绝落盘", async () => {
    const db = createDb(":memory:");
    const scenario = seed(db);
    const file = saveReportFile(scenario, "solution", REPORT).path;
    const opt = createSolutionOptimizer({ db, dshClient: mockDsh("没有标题的散句。") });
    await expect(opt.optimize(scenario.id, "简化")).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(REPORT);

    const tiny = createSolutionOptimizer({
      db,
      dshClient: mockDsh("# 标题\n\n一句话。"),
    });
    await expect(tiny.optimize(scenario.id, "大幅压缩")).rejects.toThrow(/篇幅/);
    expect(readFileSync(file, "utf8")).toBe(REPORT);
  });
});
