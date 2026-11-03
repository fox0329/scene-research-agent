/**
 * @scene/server — 用户级冷启动注入（MR3-T3，方案 §一/§三）
 *
 * 新场景从第一句话起，用户级画像（scope=user）透明注入对话上下文——用户不必做任何
 * 事，条目自动生效；注入文本标注来源与移除入口（透明）。可移除 = 画像卡既有的
 * 降级（demote）/关闭（dismiss）操作，移除后下次注入即消失。
 */

import type { RequirementEntry } from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { listRequirements } from "./requirement-profile.js";

export function buildColdstartBlock(entries: readonly RequirementEntry[]): string {
  const userEntries = entries.filter((e) => e.scope === "user" && e.status === "active");
  if (userEntries.length === 0) return ""; // 空注入不占上下文
  return [
    "【用户级偏好——跨场景自动生效】",
    ...userEntries.map((e) => `- ${e.text}`),
    "（以上来自用户级需求画像；用户可在「需求画像」面板降级或移除任一条目）",
    "",
  ].join("\n");
}

/** 场景的用户级注入块（查库 + 组装） */
export function coldstartBlockFor(db: DbInstance, scenarioId: string): string {
  try {
    return buildColdstartBlock(listRequirements(db, scenarioId));
  } catch {
    return ""; // 注入失败不阻断对话
  }
}
