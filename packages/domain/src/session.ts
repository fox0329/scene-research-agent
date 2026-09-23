/**
 * session — 会话管理
 *
 * 职责：会话生命周期（创建/归档/删除）、消息管理、DSH session 映射。
 * 规则：一个 conversation 对应一个 DSH session。
 *
 * 本模块为纯函数（零 IO）：标题/归档/删除等判定规则落在确定性层，
 * 可单测、可审计（设计规则 5）；存在性检查、消息写入等 IO 编排
 * 由应用层 converse command 负责。
 */

// ─── 常量 ─────────────────────────────────────────────────

/** 会话标题最大长度（字符） */
export const SESSION_TITLE_MAX = 50;

/** 会话状态：活跃 */
export const SESSION_STATUS_ACTIVE = "活跃" as const;

/** 会话状态：已归档 */
export const SESSION_STATUS_ARCHIVED = "已归档" as const;

// ─── 公共接口 ─────────────────────────────────────────────

/**
 * 校验会话标题：非空且 ≤50 字符。
 *
 * 空白检查与长度检查均基于去除首尾空白后的文本，
 * 与 normalizeConversationTitle 的规范化口径一致。
 *
 * @param title 待校验标题
 * @returns 合法返回 true
 */
export function validateSessionTitle(title: string): boolean {
  const normalized = title.trim();
  return normalized.length > 0 && normalized.length <= SESSION_TITLE_MAX;
}

/**
 * 是否可归档：只有「活跃」状态的会话可归档，已归档不可重复归档。
 *
 * @param status 会话状态
 * @returns 活跃返回 true
 */
export function canArchive(status: string): boolean {
  return status === SESSION_STATUS_ACTIVE;
}

/**
 * 是否可直接删除：无消息的会话可直接删，有消息的需用户确认后才能删。
 *
 * 确认动作由应用层响应用户决定后传入，本函数只做规则判定。
 *
 * @param hasMessages 会话是否已有消息
 * @returns 无消息返回 true（可直接删）
 */
export function canDelete(hasMessages: boolean): boolean {
  return !hasMessages;
}

/**
 * 标题规范化：去除首尾空白并截断到 50 字符。
 *
 * @param raw 原始标题
 * @returns 规范化后的标题（纯空白输入返回空串）
 */
export function normalizeConversationTitle(raw: string): string {
  return raw.trim().slice(0, SESSION_TITLE_MAX);
}

/**
 * normalizeTitle — normalizeConversationTitle 的别名，保持向后兼容。
 */
export const normalizeTitle = normalizeConversationTitle;
