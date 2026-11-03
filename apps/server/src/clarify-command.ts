/**
 * @scene/server — maybe-clarify（MR3-T2，方案 6.2）
 *
 * 阈值裁决（领域层）→ 命中才调 LLM 生成候选问题 → 答案存在性检查（画像 2-gram +
 * 调研来源标题）→ 存在则丢弃（答案就在手边的提问比不问更糟）→ 通过则作为普通
 * 系统消息注入右栏会话，至多 1 个。「别再问」用 interaction_event 记 clarify_mute
 * （零迁移），静音后本场景不再自动问。
 */

import type { DshClient } from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { answerExistsInProfile, isSameDimension, shouldAskClarify, type ClarifyReason } from "@scene/domain";
import { listRequirements, recordInteractionEvent } from "./requirement-profile.js";

const RECENT_WINDOW = 3;

export interface ClarifyDeps {
  db: DbInstance;
  dshClient: DshClient;
}

export interface ClarifyOutcome {
  asked: boolean;
  /** 不问的原因（可观测） */
  reason?: "muted" | "threshold" | "answer-exists" | "no-conversation" | "generate-failed";
  reasons?: ClarifyReason[];
  question?: string;
}

export interface ClarifyCommand {
  maybeClarify(input: { scenarioId: string; conversationId?: string | null }): Promise<ClarifyOutcome>;
  mute(scenarioId: string): void;
  isMuted(scenarioId: string): boolean;
}

export function createClarifyCommand(deps: ClarifyDeps): ClarifyCommand {
  const { db } = deps;

  function isMuted(scenarioId: string): boolean {
    const row = db.db
      .prepare("SELECT COUNT(*) AS n FROM interaction_event WHERE scenario_id = ? AND action = 'clarify_mute'")
      .get(scenarioId) as { n: number };
    return row.n > 0;
  }

  /** 冲突对：pending_review 条目中同维度成对（同维度反向 = 用户改口未裁决） */
  function conflictPairs(entries: { id: string; kind: string; status: string; text: string }[]): [string, string][] {
    const pending = entries.filter((e) => e.status === "pending_review");
    const pairs: [string, string][] = [];
    for (let i = 0; i < pending.length; i++) {
      for (let j = i + 1; j < pending.length; j++) {
        if (pending[i]!.kind === pending[j]!.kind && isSameDimension(pending[i]!.text, pending[j]!.text)) {
          pairs.push([pending[i]!.text, pending[j]!.text]);
        }
      }
    }
    return pairs;
  }

  /** 近 N 条事件里的纠偏序 */
  function recentCorrections(scenarioId: string): ("rewrite" | "undo")[] {
    const rows = db.db
      .prepare(
        "SELECT action FROM interaction_event WHERE scenario_id = ? AND action IN ('rewrite', 'undo') ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(scenarioId, RECENT_WINDOW) as { action: string }[];
    return rows.map((r) => r.action as "rewrite" | "undo");
  }

  /** 答案存在性第二路：调研来源标题里找（材料库全文索引的轻量代理） */
  function answerExistsInResearch(question: string): boolean {
    const rows = db.db
      .prepare("SELECT title FROM research_source WHERE scenario_id = ? LIMIT 200")
      .all(question ? scenarioIdOfQuestion : "") as { title: string }[];
    return rows.some((r) => r.title && questionIncludes(question, r.title));
  }

  // 闭包内共享（answerExistsInResearch 需要 scenarioId）
  let scenarioIdOfQuestion = "";

  function questionIncludes(question: string, title: string): boolean {
    const t = title.replace(/[\s，,。.、；;：:"'「」]/gu, "");
    for (let i = 0; i + 2 <= t.length; i++) {
      if (question.includes(t.slice(i, i + 2))) return true;
    }
    return false;
  }

  return {
    isMuted,

    mute(scenarioId) {
      recordInteractionEvent(db, {
        scenario_id: scenarioId,
        surface: "ui",
        action: "clarify_mute",
        target: "scenario",
      });
    },

    async maybeClarify({ scenarioId, conversationId }) {
      if (isMuted(scenarioId)) return { asked: false, reason: "muted" };
      scenarioIdOfQuestion = scenarioId;

      const entries = listRequirements(db, scenarioId);
      const askedRows = db.db
        .prepare("SELECT COUNT(*) AS n FROM interaction_event WHERE scenario_id = ? AND action = 'clarify'")
        .get(scenarioId) as { n: number };
      const decision = shouldAskClarify({
        conflictPairs: conflictPairs(entries),
        missingDimensions: entries.filter((e) => e.kind === "dimension_gap" && e.status === "active").map((e) => e.text),
        recentCorrections: recentCorrections(scenarioId),
        askedCount: askedRows.n,
        muted: false,
      });
      if (!decision.shouldAsk) return { asked: false, reason: "threshold", reasons: decision.reasons };

      const question = await generateQuestion(deps.dshClient, decision.reasons, entries.map((e) => e.text));
      if (!question) return { asked: false, reason: "generate-failed", reasons: decision.reasons };

      // 答案存在性检查（确定性）：画像 or 调研来源已有答案 → 丢弃不问。
      // dimension_gap 条目本身是「缺」的信号不是答案，排除出比对集。
      const answerableEntries = entries.filter((e) => e.kind !== "dimension_gap");
      if (answerExistsInProfile(question, answerableEntries) || answerExistsInResearch(question)) {
        return { asked: false, reason: "answer-exists", reasons: decision.reasons };
      }

      if (!conversationId) return { asked: false, reason: "no-conversation", reasons: decision.reasons };
      db.messageRepo.insert({
        conversation_id: conversationId,
        role: "系统",
        content: `${question}\n（回答后我会记入需求画像；不想被自动提问，可在需求画像面板点「别再问」）`,
      } as never);
      recordInteractionEvent(db, {
        scenario_id: scenarioId,
        surface: "conversation",
        action: "clarify",
        target: conversationId,
        detail: { question },
      });
      return { asked: true, reasons: decision.reasons, question };
    },
  };
}

const CLARIFY_SYSTEM = `你是需求澄清器。按触发原因生成**一个**澄清问题，问用户最关键的那个未决点。
输出 JSON：{"question":"一句话问题"}
规则：一句话、具体到可回答（不给开放式泛问）；如果触发原因是用户连续纠偏，问「你到底想要哪种」；
不要问画像里已有答案的事。`;

async function generateQuestion(dshClient: DshClient, reasons: ClarifyReason[], entryTexts: string[]): Promise<string | null> {
  const reasonLabel: Record<ClarifyReason, string> = {
    conflict: "画像条目存在冲突对（同维度两种说法）",
    "dimension-gap": "必填维度缺失 ≥2",
    correction: "用户连续纠偏（rewrite/undo）",
  };
  const user = [
    `触发原因：${reasons.map((r) => reasonLabel[r]).join("；")}`,
    "现行画像条目：",
    ...entryTexts.slice(0, 12).map((t) => `- ${t}`),
  ].join("\n");
  try {
    const session = await dshClient.createSession({ title: "澄清提问" });
    let out = "";
    for await (const ev of dshClient.prompt(session, {
      system: CLARIFY_SYSTEM,
      user,
      outputContract: { type: "json" },
    })) {
      const e = ev as { type: string; text?: string };
      if (e.type === "text" && e.text) out += e.text;
    }
    await dshClient.cancel(session);
    const start = out.indexOf("{");
    const end = out.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(out.slice(start, end + 1)) as { question?: unknown };
    return typeof parsed.question === "string" && parsed.question.trim().length > 0 ? parsed.question.trim() : null;
  } catch {
    return null; // 生成失败不阻断会话
  }
}
