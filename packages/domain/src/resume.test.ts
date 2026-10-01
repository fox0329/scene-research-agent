/**
 * @scene/domain — resume 断点续做测试
 *
 * 覆盖：四种恢复动作、中断/失效阶段识别、悬空会话、横幅文案。
 */

import { describe, it, expect } from "vitest";
import type {
  Scenario,
  StageData,
  Conversation,
  Message,
  StageId,
} from "@scene/contract";
import {
  planResume,
  collectRecomputeStages,
  isStageCompleted,
  findDanglingConversations,
} from "./resume.js";

// ─── 构造工具 ──────────────────────────────────────────────

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: "sc-1",
    name: "测试项目",
    product_line_id: "pl-1",
    status: "进行中",
    current_stage: 0,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeStageRow(
  stage: StageId,
  overrides: Partial<StageData> = {},
): StageData {
  return {
    id: `row-${stage}-${Math.random().toString(36).slice(2, 8)}`,
    scenario_id: "sc-1",
    stage,
    table_code: "表1-1",
    row: { x: 1 },
    is_stale: false,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as StageData;
}

function makeConversation(
  id: string,
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    id,
    scenario_id: "sc-1",
    title: `阶段分析 ${id}`,
    status: "活跃",
    dsh_session_id: `dsh-${id}`,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function doneMessage(stage: StageId, conversationId = "c-1"): Message {
  return {
    id: `m-${stage}-${conversationId}`,
    conversation_id: conversationId,
    role: "系统",
    content: `阶段 ${stage} 分析完成。共 3 条数据。`,
    stage,
    created_at: "2026-09-01T00:00:00.000Z",
  };
}

// ─── planResume：动作判定 ─────────────────────────────────

describe("planResume 动作判定", () => {
  it("全新项目 → fresh，定位阶段 0", () => {
    const plan = planResume({
      scenario: makeScenario(),
      stageRows: [],
      conversations: [],
      messages: [],
    });
    expect(plan.action).toBe("fresh");
    expect(plan.stage).toBe(0);
    expect(plan.banner).toContain("阶段 0");
  });

  it("已推进且各阶段有完成消息 → resume，定位 current_stage", () => {
    const plan = planResume({
      scenario: makeScenario({ current_stage: 2 }),
      stageRows: [makeStageRow(0), makeStageRow(1)],
      conversations: [makeConversation("c-0"), makeConversation("c-1")],
      messages: [doneMessage(0, "c-0"), doneMessage(1, "c-1")],
    });
    expect(plan.action).toBe("resume");
    expect(plan.stage).toBe(2);
    expect(plan.needsRecompute).toEqual([]);
    expect(plan.banner).toContain("阶段 2");
  });

  it("有数据行但无完成消息（中断）→ rerun，定位最早中断阶段", () => {
    const plan = planResume({
      scenario: makeScenario({ current_stage: 2 }),
      stageRows: [makeStageRow(0), makeStageRow(1), makeStageRow(1)],
      conversations: [makeConversation("c-0"), makeConversation("c-1")],
      messages: [doneMessage(0, "c-0")], // 阶段 1 中断
    });
    expect(plan.action).toBe("rerun");
    expect(plan.stage).toBe(1);
    expect(plan.needsRecompute).toEqual([1]);
    expect(plan.banner).toContain("重算");
    expect(plan.banner).toContain("由您决定");
  });

  it("已完成但含失效行 → rerun", () => {
    const plan = planResume({
      scenario: makeScenario({ current_stage: 3 }),
      stageRows: [
        makeStageRow(0),
        makeStageRow(1),
        makeStageRow(2, { is_stale: true }),
      ],
      conversations: [],
      messages: [doneMessage(0), doneMessage(1), doneMessage(2)],
    });
    expect(plan.action).toBe("rerun");
    expect(plan.stage).toBe(2);
    expect(plan.needsRecompute).toEqual([2]);
  });

  it("多个需重算阶段 → 升序去重，定位最早一个", () => {
    const plan = planResume({
      scenario: makeScenario({ current_stage: 4 }),
      stageRows: [
        makeStageRow(1, { is_stale: true }),
        makeStageRow(0), // 无完成消息
        makeStageRow(3),
      ],
      conversations: [],
      messages: [doneMessage(1), doneMessage(3)],
    });
    expect(plan.action).toBe("rerun");
    expect(plan.stage).toBe(0);
    expect(plan.needsRecompute).toEqual([0, 1]);
  });

  it("项目已完成 → complete，优先于其他动作", () => {
    const plan = planResume({
      scenario: makeScenario({ status: "已完成", current_stage: 7 }),
      stageRows: [makeStageRow(3)], // 阶段 3 无完成消息，但项目已完成
      conversations: [],
      messages: [],
    });
    expect(plan.action).toBe("complete");
    expect(plan.stage).toBe(7); // 交付物=阶段 7（老 9 阶段口径的 8 已收窄）
    expect(plan.needsRecompute).toEqual([3]);
    expect(plan.banner).toContain("已完成");
    expect(plan.banner).toContain("阶段 3");
  });

  it("current_stage>0 但无任何行 → resume（用户手动推进过）", () => {
    const plan = planResume({
      scenario: makeScenario({ current_stage: 1 }),
      stageRows: [],
      conversations: [],
      messages: [],
    });
    expect(plan.action).toBe("resume");
    expect(plan.stage).toBe(1);
  });
});

// ─── 子判定函数 ────────────────────────────────────────────

describe("collectRecomputeStages", () => {
  it("空数据 → 空列表", () => {
    expect(collectRecomputeStages(makeScenario(), [], [])).toEqual([]);
  });

  it("有完成消息但无数据行 → 也提示重算", () => {
    expect(collectRecomputeStages(makeScenario(), [], [doneMessage(2)])).toEqual([2]);
  });

  it("正常完成阶段不进列表", () => {
    const result = collectRecomputeStages(
      makeScenario(),
      [makeStageRow(0)],
      [doneMessage(0)],
    );
    expect(result).toEqual([]);
  });
});

describe("isStageCompleted", () => {
  it("用户消息或内容不匹配不算完成", () => {
    const msg: Message = {
      id: "m-x",
      conversation_id: "c-1",
      role: "用户",
      content: "阶段 0 分析完成。",
      stage: 0,
      created_at: "2026-09-01T00:00:00.000Z",
    };
    expect(isStageCompleted([msg], 0)).toBe(false);
    const sysOther: Message = {
      ...msg,
      role: "系统",
      content: "开始分析",
    };
    expect(isStageCompleted([sysOther], 0)).toBe(false);
  });
});

describe("findDanglingConversations", () => {
  it("活跃 + 有 session + 零消息 → 悬空", () => {
    const ids = findDanglingConversations(
      [
        makeConversation("c-1"),
        makeConversation("c-2"),
        makeConversation("c-3", { status: "已归档" }),
      ],
      [{ ...doneMessage(0), conversation_id: "c-2" }],
    );
    expect(ids).toEqual(["c-1"]);
  });

  it("无 dsh_session_id 的会话不算悬空", () => {
    const ids = findDanglingConversations(
      [makeConversation("c-1", { dsh_session_id: "" })],
      [],
    );
    expect(ids).toEqual([]);
  });
});

// ─── planResume：悬空会话透传 ─────────────────────────────

describe("planResume 悬空会话对账", () => {
  it("恢复计划携带悬空会话 ID 列表", () => {
    const plan = planResume({
      scenario: makeScenario({ current_stage: 2 }),
      stageRows: [makeStageRow(0), makeStageRow(1)],
      conversations: [
        makeConversation("c-0"),
        makeConversation("c-1"),
        makeConversation("c-crash"), // 重启遗留
      ],
      messages: [
        doneMessage(0, "c-0"),
        doneMessage(1, "c-1"),
      ],
    });
    expect(plan.action).toBe("resume");
    expect(plan.danglingConversationIds).toEqual(["c-crash"]);
  });
});
