/**
 * @scene/server — 两阶段确认（变更表 #312，P0）
 *
 * R2（删除/去重等覆盖性操作）先返回预览与 op_id，用户确认后由
 * `confirm_operation` 执行。待确认项放内存：5 分钟过期、一次性、同会话有效。
 * 不落库是有意的——进程重启后未确认的操作自然作废，不会“幽灵执行”。
 */

import { randomUUID } from "node:crypto";

export interface PendingOperation {
  id: string;
  conversationId: string | null;
  /** 作用域键（资料库用 product line）：用户说「确认」时按作用域直接执行 */
  scopeKey: string | null;
  surface: string;
  tool: string;
  preview: string;
  expiresAt: number;
  run: () => Promise<{ note: string; operationId?: string }>;
}

const TTL_MS = 5 * 60 * 1000;
const pending = new Map<string, PendingOperation>();

export function createPending(input: {
  conversationId: string | null;
  scopeKey?: string | null;
  surface: string;
  tool: string;
  preview: string;
  run: () => Promise<{ note: string; operationId?: string }>;
}): PendingOperation {
  // 顺手清理过期项，避免长会话累积
  const now = Date.now();
  for (const [id, op] of pending) {
    if (op.expiresAt <= now) pending.delete(id);
  }
  const op: PendingOperation = {
    id: randomUUID(),
    conversationId: input.conversationId,
    scopeKey: input.scopeKey ?? null,
    surface: input.surface,
    tool: input.tool,
    preview: input.preview,
    expiresAt: now + TTL_MS,
    run: input.run,
  };
  pending.set(op.id, op);
  return op;
}

/** 取走待确认项：校验会话、过期，取走即删（一次性） */
export function takePending(
  id: string,
  conversationId: string | null,
): PendingOperation | null {
  const op = pending.get(id);
  if (!op) return null;
  if (op.expiresAt <= Date.now()) {
    pending.delete(id);
    return null;
  }
  if ((op.conversationId ?? null) !== (conversationId ?? null)) return null;
  pending.delete(id);
  return op;
}


/** 按作用域取最新待确认项（资料库「确认」快捷路径用），取走即删 */
export function takePendingByScope(scopeKey: string): PendingOperation | null {
  const now = Date.now();
  let latest: PendingOperation | null = null;
  for (const op of pending.values()) {
    if (op.scopeKey !== scopeKey) continue;
    if (op.expiresAt <= now) {
      pending.delete(op.id);
      continue;
    }
    if (!latest || op.expiresAt > latest.expiresAt) latest = op;
  }
  if (latest) pending.delete(latest.id);
  return latest;
}
