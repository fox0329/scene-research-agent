/**
 * 会话可见性判定（变更表 #174）
 *
 * 背景：阶段分析不再登记会话（用户定调「场景下面不需要每个阶段生成一个会话，没有意义」），
 * 但**历史数据仍在**，而且仍是「活跃」状态。
 *
 * 因此凡是「取该场景最近一条活跃会话」的地方都必须过滤掉阶段分析会话——否则澄清问题
 * 会被写进一条左侧栏看不见的会话：用户看不到问题，也没法回答（2026-10-09 用户指出的真故障）。
 *
 * 唯一判定收在这里，避免各处各写一份 `kind` 判断而漏掉某处。
 */
import type { Conversation } from "@scene/contract";

/** 这条会话是否属于"用户能看见、能继续对话"的范围 */
export function isUserConversation(conversation: Conversation): boolean {
  return (conversation.kind ?? "用户") !== "阶段分析";
}
