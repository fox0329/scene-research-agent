/**
 * @scene/server — 反思优化模块 API + feature flag（MR1-T6）
 *
 * 三个端点：GET 列表（含升级候选）/ PATCH 手编（用户编辑赢）/ DELETE 关闭进黑名单。
 * flag：SCENE_REFLECTION_ENABLED 非 "1" 时抽取管道整体不挂（红线：MR2 差分样本
 * 评审通过前自动反思保持关闭）；端点本身始终可用——关 flag 只是停自动抽取，
 * 用户手动管理画像不受影响。
 */

import type { FastifyInstance } from "fastify";
import type { DbInstance } from "@scene/infra";
import {
  demoteToScene,
  listRequirements,
  listUpgradeCandidates,
  updateRequirement,
} from "./requirement-profile.js";
import { gapFlowHints } from "./gap-flow.js";

/** flag 读取：默认开（2026-11-04 用户定调，真机四场景验证通过后）；显式 "0" 可关 */
export function isReflectionEnabled(): boolean {
  return process.env.SCENE_REFLECTION_ENABLED !== "0";
}

export function registerRequirementRoutes(app: FastifyInstance, db: DbInstance): void {
  app.get("/api/v1/projects/:id/requirements", async (request) => {
    const { id } = request.params as { id: string };
    return {
      entries: listRequirements(db, id),
      upgrade_candidates: listUpgradeCandidates(db),
      // 缺口流转（MR2-T5）：userGaps → 澄清提醒；agentGaps → 取证提示（复用既有研究入口）
      ...gapFlowHints(db, id),
    };
  });

  app.patch("/api/v1/requirements/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const patch = request.body as Parameters<typeof updateRequirement>[2];
    // 用户手编永远赢：PATCH 直接覆盖（并发保护在 repo 读取-覆写链路）
    const updated = updateRequirement(db, id, patch);
    if (!updated) return reply.code(404).send({ error: "条目不存在" });
    return updated;
  });

  app.delete("/api/v1/requirements/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    // 关闭 = 进黑名单（dismissed）：同文不再被抽回
    const updated = updateRequirement(db, id, { status: "dismissed" });
    if (!updated) return reply.code(404).send({ error: "条目不存在" });
    return updated;
  });

  app.post("/api/v1/requirements/:id/demote/:scenarioId", async (request, reply) => {
    const { id, scenarioId } = request.params as { id: string; scenarioId: string };
    const updated = demoteToScene(db, id, scenarioId);
    if (!updated) return reply.code(404).send({ error: "条目不存在" });
    return updated;
  });
}
