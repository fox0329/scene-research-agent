/**
 * @scene/domain — resume 断点续做（M4-T4.1）
 *
 * 进程重启后，凭自有库数据（scenario / stage_data / conversation / message）
 * 对账出"项目停在哪、哪阶段要重跑、有没有悬空会话"，产出恢复计划。
 *
 * 判定逻辑全部在领域层（可单测、可审计，AGENTS §三-5）；
 * 不涉及 DB/网络，输入由应用层注入。
 *
 * 完成判定依据 advance-stage 的落库约定：
 * 每个阶段跑完会写入一条 stage=N、内容含"分析完成"的系统消息。
 */

import type {
  Scenario,
  StageId,
  StageData,
  Conversation,
  Message,
} from "@scene/contract";
import { FIRST_STAGE, LAST_STAGE } from "./workflow.js";

// ─── 公共类型 ──────────────────────────────────────────────

/** 恢复动作 */
export type ResumeAction =
  /** 全新项目：未推进且无任何分析数据 */
  | "fresh"
  /** 正常续做：从 current_stage 继续下一阶段分析 */
  | "resume"
  /** 需要重跑：存在中断或失效阶段 */
  | "rerun"
  /** 项目已完成：直接进入交付物视图 */
  | "complete";

/** 断点续做输入（均为同一 scenario 名下的数据） */
export interface ResumeInput {
  scenario: Scenario;
  /** 该场景全部阶段数据行 */
  stageRows: StageData[];
  /** 该场景全部会话 */
  conversations: Conversation[];
  /** 上述会话的全部消息 */
  messages: Message[];
}

/** 恢复计划 */
export interface ResumePlan {
  action: ResumeAction;
  /** 界面应定位到的阶段 */
  stage: StageId;
  /** 需重算阶段（中断或资料失效），升序去重 */
  needsRecompute: StageId[];
  /** 悬空会话 ID：活跃但零消息（重启前建了 DSH session 未消费） */
  danglingConversationIds: string[];
  /** 打开项目时的横幅文案 */
  banner: string;
}

// ─── 主函数 ────────────────────────────────────────────────

/**
 * 对账并产出恢复计划。
 *
 * 优先级：已完成 > 需重跑 > 续做 > 全新。
 */
export function planResume(input: ResumeInput): ResumePlan {
  const { scenario, stageRows, conversations, messages } = input;

  const danglingConversationIds = findDanglingConversations(conversations, messages);
  const needsRecompute = collectRecomputeStages(scenario, stageRows, messages);

  if (scenario.status === "已完成") {
    return {
      action: "complete",
      stage: LAST_STAGE,
      needsRecompute,
      danglingConversationIds,
      banner: `项目已完成，可直接查看交付物。${recomputeHint(needsRecompute)}`,
    };
  }

  if (needsRecompute.length > 0) {
    const first = needsRecompute[0]!;
    return {
      action: "rerun",
      stage: first,
      needsRecompute,
      danglingConversationIds,
      banner: `检测到需要重算的阶段：${needsRecompute.map((s) => `阶段 ${s}`).join("、")}。是否重算由您决定。`,
    };
  }

  if (scenario.current_stage > FIRST_STAGE || stageRows.length > 0) {
    return {
      action: "resume",
      stage: scenario.current_stage,
      needsRecompute,
      danglingConversationIds,
      banner: `项目已推进到阶段 ${scenario.current_stage}，可从阶段 ${scenario.current_stage} 继续。`,
    };
  }

  return {
    action: "fresh",
    stage: FIRST_STAGE,
    needsRecompute,
    danglingConversationIds,
    banner: "新项目，从阶段 0 开始分析。",
  };
}

// ─── 子判定 ────────────────────────────────────────────────

/**
 * 收集需重算阶段（升序去重）：
 * - 中断：有数据行但无"分析完成"系统消息（流式中途断掉）
 * - 失效：已完成但存在 is_stale 行（资料更新反查，§4.1 失效语义）
 */
export function collectRecomputeStages(
  _scenario: Scenario,
  stageRows: StageData[],
  messages: Message[],
): StageId[] {
  const set = new Set<StageId>();
  const byStage = new Map<StageId, StageData[]>();
  for (const row of stageRows) {
    const list = byStage.get(row.stage) ?? [];
    list.push(row);
    byStage.set(row.stage, list);
  }

  for (const [stage, rows] of byStage) {
    if (!isStageCompleted(messages, stage)) {
      set.add(stage); // 中断：写了数据没写完成消息
    } else if (rows.some((r) => r.is_stale)) {
      set.add(stage); // 失效：已完成但资料已过期
    }
  }

  // 有完成消息却没有数据行的阶段（理论上少见），同样提示重算
  for (const stage of STAGE_NUMBERS) {
    if (!byStage.has(stage) && isStageCompleted(messages, stage)) {
      set.add(stage);
    }
  }

  return [...set].sort((a, b) => a - b);
}

/** 阶段是否已完成：存在 stage 匹配、内容含"分析完成"的系统消息 */
export function isStageCompleted(messages: Message[], stage: StageId): boolean {
  return messages.some(
    (m) => m.role === "系统" && m.stage === stage && m.content.includes("分析完成"),
  );
}

/**
 * 悬空会话：活跃 + 已登记 DSH session + 零消息。
 * advance-stage 在 DSH 调用前登记会话、跑完后写系统消息，
 * 因此"活跃且无消息"即重启遗留、无法续用的会话。
 */
export function findDanglingConversations(
  conversations: Conversation[],
  messages: Message[],
): string[] {
  const countByConversation = new Map<string, number>();
  for (const m of messages) {
    countByConversation.set(
      m.conversation_id,
      (countByConversation.get(m.conversation_id) ?? 0) + 1,
    );
  }
  return conversations
    .filter(
      (c) =>
        c.status === "活跃" &&
        c.dsh_session_id !== "" &&
        (countByConversation.get(c.id) ?? 0) === 0,
    )
    .map((c) => c.id);
}

// ─── 内部工具 ──────────────────────────────────────────────

const STAGE_NUMBERS: readonly StageId[] = [0, 1, 2, 3, 4, 5, 6, 7, 8];

function recomputeHint(stages: StageId[]): string {
  if (stages.length === 0) return "";
  return `另有需重算阶段：${stages.map((s) => `阶段 ${s}`).join("、")}。`;
}
