/**
 * 缺口流转单测（MR2-T5）：userGaps→澄清提醒、agentGaps→取证提示、端点透出。
 */

import { describe, expect, it } from "vitest";
import { createDb } from "@scene/infra";
import { routeGaps, gapFlowHints } from "./gap-flow.js";
import { createApp } from "./app.js";
import type { PipelineFinding } from "./reflection-pipeline.js";

function gapFinding(table: string, owner: string, detail: string): PipelineFinding {
  return {
    source: "completeness",
    level: "advisory",
    location: table,
    detail,
    raw: { gapKind: "缺表", owner },
  };
}

describe("routeGaps 分流", () => {
  it("用户缺口进澄清提醒，智能体缺口进取证提示（表号去重保序）", () => {
    const { userGaps, agentGaps, researchHints } = routeGaps([
      gapFinding("表1-2", "用户", "客户内部数据，该你拍板"),
      gapFinding("表4-1", "智能体", "能力底账尚无数据"),
      gapFinding("表4-1:缺来源", "智能体", "第二条同表缺口"),
      gapFinding("表3-1:r1", "postcheck", "非缺口发现"),
    ]);
    expect(userGaps).toHaveLength(1);
    expect(agentGaps).toHaveLength(2);
    expect(researchHints).toEqual(["表4-1"]);
  });
});

describe("gapFlowHints + 端点透出", () => {
  it("GET requirements 带 clarify_hints / research_hints", async () => {
    const db = createDb(":memory:");
    const app = createApp({ db, dshClient: {} as never });
    const sid = db.scenarioRepo.insert({ name: "t", status: "进行中", current_stage: 3 }).id;
    // 阶段 3 只填一张表的一行（缺必填列）→ 触发缺口
    db.stageDataRepo.insert({
      scenario_id: sid,
      stage: 3,
      table_code: "表3-1",
      row: { 方案: "示例" },
    } as never);

    const res = await app.inject({ method: "GET", url: `/api/v1/projects/${sid}/requirements` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      clarify_hints: { location: string; detail: string }[];
      research_hints: string[];
    };
    expect(Array.isArray(body.clarify_hints)).toBe(true);
    expect(Array.isArray(body.research_hints)).toBe(true);
    expect(body.clarify_hints.length + body.research_hints.length).toBeGreaterThan(0);
  });

  it("空阶段 → 两类提示为空数组", () => {
    const db = createDb(":memory:");
    const sid = db.scenarioRepo.insert({ name: "t", status: "进行中", current_stage: 3 }).id;
    const hints = gapFlowHints(db, sid);
    expect(hints.clarify_hints).toEqual([]);
    expect(hints.research_hints).toEqual([]);
  });

  it("不存在的场景 → 空提示不炸", () => {
    const db = createDb(":memory:");
    expect(gapFlowHints(db, "no-such")).toEqual({ clarify_hints: [], research_hints: [] });
  });
});
