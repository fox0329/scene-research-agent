/**
 * @scene/server — 资料库对话（变更表 #305）
 *
 * 右栏「资料助手」：围绕一条产品线的资料库回答问题、接收上传。
 * 会话持久化复用 conversation/message 表：kind='资料库会话'，scenario_id 存**产品线 id**
 * （该字段在库页语境下是"作用域 id"，不做外键；删除产品线时由删除流程清理）。
 */

import { existsSync } from "node:fs";
import type { Conversation, Message } from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { SESSION_STATUS_ACTIVE } from "@scene/domain";

export const LIBRARY_KIND = "资料库会话" as const;

export const LIBRARY_SYSTEM_PROMPT = `你是「场景通」的资料助手，服务于当前产品线的资料库。
规则：
1. 只围绕资料库回答：有哪些材料、覆盖哪些表、还缺什么；需要事实时以给出的资料清单为准。
2. 用户上传文件 / 贴链接 / 给绝对路径时，告诉他会入库；落库动作由界面按钮完成，你不需要假装执行。
3. 不要编造材料名、页码或数据；没有就直说「资料库里没有」。
4. 输出纯文本，不要用「**」「##」这类 Markdown 符号；保持简洁。`;

/** 取（或建）一条产品线的资料库会话；并发首建由 list 复查兜底 */
export function ensureLibraryConversation(db: DbInstance, lineId: string): Conversation {
  const found = db.conversationRepo.list({
    where: "scenario_id = ? AND kind = ?",
    params: [lineId, LIBRARY_KIND],
    orderBy: "created_at ASC",
  })[0];
  if (found) return found;
  const line = db.productLineRepo.getById(lineId);
  const created = db.conversationRepo.insert({
    scenario_id: lineId,
    title: `资料助手 · ${line?.name ?? lineId}`,
    status: SESSION_STATUS_ACTIVE,
    kind: LIBRARY_KIND,
    scope_type: "legacy",
    purpose: "library",
  } as never);
  return created;
}

export function readLibraryThread(
  db: DbInstance,
  lineId: string,
): { conversation_id: string | null; messages: Message[] } {
  const found = db.conversationRepo.list({
    where: "scenario_id = ? AND kind = ?",
    params: [lineId, LIBRARY_KIND],
    orderBy: "created_at ASC",
  })[0];
  if (!found) return { conversation_id: null, messages: [] };
  return { conversation_id: found.id, messages: db.messageRepo.listByConversation(found.id) };
}

/**
 * 资料库现状 → 提示词上下文：产品线名、材料清单、各表行数。
 * 只给清单与计数，不灌原文；需要细节时用户在对话里问，再针对性回答。
 */
export function buildLibraryContext(db: DbInstance, lineId: string): string {
  const line = db.productLineRepo.getById(lineId);
  const lines: string[] = [
    "【当前资料库】",
    `产品线：${line?.name ?? lineId}`,
  ];
  try {
    const docs = db.db
      .prepare(
        `SELECT source AS name FROM source_fts
         WHERE source IS NOT NULL AND source <> ''
         GROUP BY source ORDER BY MAX(rowid) DESC LIMIT 20`,
      )
      .all() as Array<{ name: string }>;
    if (docs.length > 0) {
      lines.push("", "【已入库材料（最近 20 份）】");
      for (const doc of docs) lines.push(`- ${doc.name}`);
    } else {
      lines.push("", "【已入库材料】", "（还没有材料）");
    }
  } catch {
    lines.push("", "【已入库材料】", "（索引暂不可用）");
  }
  const stat = [
    `产品 ${db.productRepo.list().length}`,
    `能力 ${db.capabilityRepo.list().length}`,
    `边界 ${db.boundaryRepo.list().length}`,
    `限制 ${db.limitationRepo.list().length}`,
  ];
  lines.push("", `【库内规模】${stat.join(" · ")}`);
  lines.push("", "回答要求：以以上清单为准；没有的信息写「资料库里没有」。");
  return `${lines.join("\n")}\n\n`;
}

/** 从对话里解析「要入库的地址」：http(s) 链接或已存在的绝对路径 */
export function parseMaterialTarget(text: string): string | null {
  const urlish = text.match(/https?:\/\/\S+/u);
  if (urlish) return urlish[0];
  for (const token of text.split(/\s+/u)) {
    const candidate = token.replace(/^["'（(]+|["'）)]+$/gu, "");
    if (candidate.startsWith("/") && existsSync(candidate)) return candidate;
  }
  return null;
}
