/**
 * @scene/server — 反思重写路由（MR2-T4）：触发差分 + 用户确认应用
 *
 * POST /projects/:id/refine：跑管线 → 必改 → 单次重写 → 返回行级差分（不落库）。
 * POST /projects/:id/refine/apply：用户确认后写回格子（两道关卡第二道）+ 记 edit_cell 埋点。
 * 手动「按需求重写」不受 flag 限制（红线：flag 只关自动反思）。
 */

import type { FastifyInstance } from "fastify";
import type { DbInstance } from "@scene/infra";
import { recordInteractionEvent } from "./requirement-profile.js";
import { createRefineCommand, type CellDiff } from "./refine-output.js";

export function registerRefineRoutes(app: FastifyInstance, db: DbInstance, dshClient: import("@scene/contract").DshClient): void {
  const refineCmd = createRefineCommand({ db, dshClient });

  app.post("/api/v1/projects/:id/refine", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { stage?: number; tableCodes?: string[] };
    const stage = Number(body.stage ?? 0);
    if (!Number.isInteger(stage) || stage < 1) {
      return reply.code(400).send({ error: "stage 必须是正整数" });
    }
    // 阶段归一（MR2-T4 修正）：业务流阶段 0-8，表数据只落 0-5；交付物阶段（6+）的
    // 表数据留在 5，反思重写按 5 查——否则阶段 6+ 永远「没有表格数据」
    const dataStage = Math.min(stage, 5);
    return refineCmd.refine({
      scenarioId: id,
      stage: dataStage as never,
      ...(body.tableCodes !== undefined ? { tableCodes: body.tableCodes } : {}),
    });
  });

  app.post("/api/v1/projects/:id/refine/apply", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { diffs?: CellDiff[] };
    const diffs = Array.isArray(body.diffs) ? body.diffs : [];
    if (diffs.length === 0) return reply.code(400).send({ error: "没有要应用的差分" });

    let applied = 0;
    for (const d of diffs) {
      const row = db.stageDataRepo.getById(d.rowId);
      if (!row || row.scenario_id !== id) continue;
      const nextRow = { ...(row.row as Record<string, unknown>), [d.cell]: d.newValue };
      db.stageDataRepo.update(d.rowId, { row: nextRow as never });
      // 埋点：差分应用 = 用户确认的格子编辑（edit_cell，target 带 refine 前缀便于区分来源）
      recordInteractionEvent(db, {
        scenario_id: id,
        surface: "ui",
        action: "edit_cell",
        target: `refine:${d.tableCode}:${d.rowId}:${d.cell}`,
        detail: { oldValue: d.oldValue, newValue: d.newValue },
      });
      applied++;
    }
    return { applied, ignored: diffs.length - applied };
  });
}
