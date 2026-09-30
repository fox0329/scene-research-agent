/**
 * @scene/server — 场景澄清（v1.12，用户原则落地）
 *
 * 「需要向用户澄清场景时必须通过对话提出来，不能不管场景蒙头分析。」
 *
 * 分析前置预检：场景描述缺失/含糊/含推断时，生成针对该场景的澄清问题，
 * 写入该场景的对话（用户在对话里直接回答），并中止本次分析；
 * 手动触发（场景锚条「场景澄清」）时强制生成值得确认的问题。
 *
 * 解析失败时放行（fail-open）：澄清输出异常不得阻断分析主链路。
 */

import type { DshClient, FollowEvent, Scenario, SessionHandle } from "@scene/contract";
import type { DbInstance } from "@scene/infra";

/** 场景澄清判定结果 */
export interface ClarifyOutcome {
  /** 需要向用户澄清（已把问题写进对话） */
  needClarification: boolean;
  /** 生成的澄清问题 */
  questions: string[];
  /** 问题所在会话 id（供 UI 引导） */
  conversationId?: string;
}

const CLARIFY_SYSTEM = `你是场景落地分析的预检助手。分析开始前，判断场景信息是否足以支撑严谨分析，并找出必须向用户澄清的点。

判断标准（只有「场景本体不明」才需要澄清——用户的口径：深入问题是后续阶段结合产品能力有目的调研的事，不在定义期追问答全）：
- 场景描述缺失或过短，看不出这个场景是什么
- 场景范围/边界完全不清，无法界定分析对象
以下情形【不】构成澄清理由：客户只是行业泛称、接入对象/设备清单未明确、合规细节未知、项目形态/预算未定、竞争背景空白——这些是后续各阶段有目的调研的内容，分析中如实标注「未提供/待调研」即可。

规则：
- 问题只允许问场景本体（场景具体指什么、范围边界），最多 3 个
- 只有场景本体不明才 need_clarification=true；调研类缺口不问、不拦
- 场景能看出是什么、范围大致可辨即放行（need_clarification=false）`;

const CLARIFY_FORCE_NOTE =
  "\n\n（强制模式：即使信息看似充分，也请列出至少 3 个仍值得与用户确认的问题。）";

const CLARIFY_CONTRACT: Record<string, unknown> = {
  type: "object",
  properties: {
    need_clarification: { type: "boolean" },
    questions: {
      type: "array",
      items: { type: "string" },
      description: "针对该场景的具体澄清问题（需要澄清时至少 1 条）",
    },
  },
  required: ["need_clarification", "questions"],
};

/** 从模型输出提取 JSON（容错：整段 / ```json 块 / 首个 { 起） */
function parseClarify(text: string): { need_clarification: boolean; questions: string[] } | null {
  const candidates = [text.trim()];
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (block?.[1]) candidates.push(block[1].trim());
  const start = text.indexOf("{");
  if (start >= 0) candidates.push(text.slice(start));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as { need_clarification?: unknown; questions?: unknown };
      if (typeof parsed.need_clarification === "boolean" && Array.isArray(parsed.questions)) {
        return {
          need_clarification: parsed.need_clarification,
          questions: parsed.questions.map(String).filter((q) => q.trim().length > 0),
        };
      }
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

/**
 * 场景预检：判定是否需要澄清；需要则生成问题并写进该场景的对话。
 *
 * @param force - true=强制生成确认问题（手动触发）
 */
export async function runScenarioClarify(
  db: DbInstance,
  dshClient: DshClient,
  scenario: Scenario,
  force = false,
): Promise<ClarifyOutcome> {
  // 已有待回答的澄清问题：不重复生成（防问题刷屏），直接沿用现有问题拦下分析
  if (!force) {
    const pending = findPendingQuestions(db, scenario.id);
    if (pending) return pending;
  }

  const user = [
    `场景名称：${scenario.name}`,
    `场景描述：${scenario.description?.trim() || "（未提供）"}`,
    force ? CLARIFY_FORCE_NOTE : "",
    "",
    "请判断该场景信息是否足以支撑分析，输出 JSON。",
  ].join("\n");

  let needClarification = false;
  let questions: string[] = [];
  try {
    const session: SessionHandle = await dshClient.createSession({
      title: `场景澄清 · ${scenario.name}`,
    });
    let fullText = "";
    for await (const ev of dshClient.prompt(session, {
      system: CLARIFY_SYSTEM,
      user,
      outputContract: CLARIFY_CONTRACT,
    })) {
      if (ev.type === "text") fullText += (ev as { type: "text"; text: string }).text;
      if (ev.type === "error") return { needClarification: false, questions: [] }; // fail-open
    }
    const parsed = parseClarify(fullText);
    if (!parsed) return { needClarification: false, questions: [] }; // fail-open
    needClarification = parsed.need_clarification && parsed.questions.length > 0;
    questions = parsed.questions;
    // 强制模式下模型判定“充分”但没给问题：不阻断，仅提示无需澄清
    if (force && questions.length === 0) needClarification = false;
  } catch {
    return { needClarification: false, questions: [] }; // fail-open
  }

  if (!needClarification) return { needClarification: false, questions: [] };

  // 写进该场景的对话（复用最近活跃会话；没有则创建「场景澄清」会话）
  let conversation = db.conversationRepo
    .list({ where: "scenario_id = ? AND status = ?", params: [scenario.id, "活跃"], orderBy: "created_at DESC" })[0];
  if (!conversation) {
    const handle = await dshClient.createSession({ title: "场景澄清" });
    conversation = db.conversationRepo.insert({
      scenario_id: scenario.id,
      title: "场景澄清",
      status: "活跃",
      dsh_session_id: handle.sessionId,
    });
  }
  const content = [
    "【场景澄清】开始/继续阶段分析前，请先澄清以下问题——直接在对话里逐条回答；",
    "回答后点场景锚「编辑描述」把要点并入场景描述，再重跑分析。",
    "",
    ...questions.map((q, i) => `${i + 1}. ${q}`),
  ].join("\n");
  db.messageRepo.insert({
    conversation_id: conversation.id,
    role: "系统",
    content,
  });

  return { needClarification: true, questions, conversationId: conversation.id };
}

/** 手动触发的澄清（供路由用）：强制生成确认问题 */
export async function requestScenarioClarify(
  db: DbInstance,
  dshClient: DshClient,
  scenario: Scenario,
): Promise<ClarifyOutcome> {
  return runScenarioClarify(db, dshClient, scenario, true);
}

/** 供 advance 流复用的提示事件构造 */
export function clarifyAbortEvent(questions: number, stage: number): FollowEvent {
  return {
    type: "error",
    message:
      `场景信息不足或含推断点，已在对话中提出 ${questions} 个澄清问题——请在对话里回答，` +
      `并把要点补充到场景描述后重跑阶段 ${stage} 分析。`,
  };
}

/**
 * 找已在对话中但未被回答的澄清问题（最新一条【场景澄清】之后没有用户回复）。
 * 命中则沿用现有问题拦下分析，不重复生成。
 */
function findPendingQuestions(db: DbInstance, scenarioId: string): ClarifyOutcome | null {
  const conversations = db.conversationRepo.list({
    where: "scenario_id = ? AND status = ?",
    params: [scenarioId, "活跃"],
    orderBy: "created_at DESC",
  });
  for (const c of conversations) {
    const messages = db.messageRepo.listByConversation(c.id);
    let clarifyIdx = -1;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      if (
        m.role === "系统" &&
        (m.content.startsWith("【场景澄清】") || m.content.startsWith("【场景定义草稿】"))
      ) {
        clarifyIdx = i;
      }
    }
    if (clarifyIdx < 0) continue;
    const answeredAfter = messages
      .slice(clarifyIdx + 1)
      .some((m) => m.role === "用户");
    if (answeredAfter) continue;
    const questions = (messages[clarifyIdx]!.content.match(/^\d+\.\s+(.+)$/gm) ?? [])
      .map((line) => line.replace(/^\d+\.\s+/, ""));
    return {
      needClarification: true,
      questions: questions.length > 0 ? questions : ["（见对话中的待回答澄清问题）"],
      conversationId: c.id,
    };
  }
  return null;
}
