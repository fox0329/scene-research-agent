/**
 * @scene/server — 场景定义起草（v1.13，用户原则落地）
 *
 * 「不能让用户自己大段输入场景描述——系统应主动生成定义让用户确认；
 *   梳理在对话里完成，沉淀为后续分析的基础。」
 *
 * 建场景只输名字 → 本模块基于场景名 + 资料库摘要起草场景定义（客户/问题/
 * 目标/边界）+ 待确认点 → 写入场景描述（分析锚立即生效）并连同待确认点
 * 发进「场景梳理」对话，用户在对话里确认/修正（converse 侧解析
 * 【场景定义 vN】块自动回写描述）。
 */

import type { DshClient, Scenario, SessionHandle } from "@scene/contract";
import type { DbInstance } from "@scene/infra";

/** 起草结果 */
export interface DraftOutcome {
  description: string;
  openQuestions: string[];
  conversationId: string;
}

const DRAFT_SYSTEM = `你是场景定义起草助手。根据场景名称起草一份「场景本位」的定义作为分析锚。

铁律：定义里禁止出现任何具体产品、型号、厂商或技术方案（用户还没说用什么产品）——
场景定义只回答「这个场景长什么样、范围在哪」；用什么产品来打是后续「匹配决策」阶段的结论，绝不预设。

只写两段：
- 场景长什么样：谁在这个场景里（客户/行业）、场景里有什么、日常怎么运转
- 场景范围：包含哪些环节/对象；边界（不包含什么）
铁律：不写「要解决的问题」「目标」「痛点」——那是后面阶段结合产品能力有目的调研的内容，定义期不展开。

要求：具体但不编造；总长 300 字以内。
待确认点只允许问「场景本体」问题（这个场景具体指什么、范围边界在哪）——最多 2 个；
客户细节、接入设备清单、合规要求、项目形态等深入问题一律不问：那些是后续阶段结合产品能力有目的地调研的内容，定义期不预设、不追问答全。`;

const DRAFT_CONTRACT: Record<string, unknown> = {
  type: "object",
  properties: {
    description: { type: "string", description: "四段式场景定义（客户与行业/要解决的问题/目标/边界）" },
    open_questions: { type: "array", items: { type: "string" } },
  },
  required: ["description", "open_questions"],
};

function parseDraft(text: string): { description: string; open_questions: string[] } | null {
  const candidates = [text.trim()];
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (block?.[1]) candidates.push(block[1].trim());
  const start = text.indexOf("{");
  if (start >= 0) candidates.push(text.slice(start));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as { description?: unknown; open_questions?: unknown };
      if (typeof parsed.description === "string" && parsed.description.trim()) {
        return {
          description: parsed.description.trim(),
          open_questions: Array.isArray(parsed.open_questions) ? parsed.open_questions.map(String) : [],
        };
      }
    } catch {
      /* 下一个候选 */
    }
  }
  return null;
}

/**
 * 起草场景定义：生成 → 存描述 → 发进「场景梳理」对话（含待确认点）。
 * LLM 失败时降级为引导用户口头描述（定义留待对话沉淀），不阻断建场景。
 */
export async function draftScenarioDefinition(
  db: DbInstance,
  dshClient: DshClient,
  scenario: Scenario,
): Promise<DraftOutcome> {
  let description = "";
  let openQuestions: string[] = [];
  try {
    const session: SessionHandle = await dshClient.createSession({
      title: `场景定义起草 · ${scenario.name}`,
    });
    let fullText = "";
    for await (const ev of dshClient.prompt(session, {
      system: DRAFT_SYSTEM,
      user: `场景名称：${scenario.name}\n\n请起草场景本位的定义（不提任何产品与方案）。`,
      outputContract: DRAFT_CONTRACT,
    })) {
      if (ev.type === "text") fullText += (ev as { type: "text"; text: string }).text;
    }
    const parsed = parseDraft(fullText);
    if (parsed) {
      description = parsed.description;
      openQuestions = parsed.open_questions;
    }
  } catch {
    /* 降级：描述留空，对话里引导 */
  }

  if (description) {
    db.scenarioRepo.update(scenario.id, { description } as never);
  }

  // 「场景梳理」对话：找现有的，没有则建
  let conversation = db.conversationRepo
    .list({ where: "scenario_id = ? AND status = ?", params: [scenario.id, "活跃"] })
    .find((c) => c.title === "场景梳理");
  if (!conversation) {
    const handle = await dshClient.createSession({ title: "场景梳理" });
    conversation = db.conversationRepo.insert({
      scenario_id: scenario.id,
      title: "场景梳理",
      status: "活跃",
      dsh_session_id: handle.sessionId,
    });
  }

  const content = description
    ? [
        `【场景定义草稿】已根据「${scenario.name}」与资料库起草如下定义，并设为分析锚：`,
        "",
        description,
        "",
        ...(openQuestions.length
          ? ["请确认的仅是场景本体（如有出入直接说，我更新定义）：", ...openQuestions.map((q, i) => `${i + 1}. ${q}`), ""]
          : []),
        "场景没大问题就可以直接跑阶段分析了——客户细节、接入对象、合规等深入问题不在这里追问，由后续阶段结合产品能力有目的地调研。要改定义随时在对话里说。",
      ].join("\n")
    : [
        `【场景定义草稿】起草暂时不可用。请用几句话描述「${scenario.name}」场景：`,
        "客户是谁、要解决什么问题、目标是什么、边界在哪（不做什么）。",
        "我会把你的描述整理成正式场景定义，作为后续全部分析的基础。",
      ].join("\n");
  db.messageRepo.insert({ conversation_id: conversation.id, role: "系统", content });

  return { description, openQuestions, conversationId: conversation.id };
}
