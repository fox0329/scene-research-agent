/**
 * @scene/server — 应用命令分发（v1.17，用户原则落地）
 *
 * 「应用内的对话要能完成任何应用可以完成的事——智能体必须懂业务流、会操作。」
 *
 * converse 的模型在回复中输出【执行命令】{json} 块 → 本模块解析并执行对应
 * 应用能力（阶段分析/导出/去重/场景澄清），结果作为系统消息回写对话。
 *
 * 命令清单（新增能力在此登记，同步更新 converse 提示词的操作手册）：
 * - advance_stage：跑指定（或当前）阶段分析
 * - export_deliverables：导出双口径交付物
 * - dedupe_products：产品去重（同型号合并）
 * - clarify_scenario：发起场景澄清
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DshClient, Scenario } from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { exportDeliverables, exportFileName } from "@scene/infra";
import { collectStageSummaries } from "./stage-summary-service.js";
import { createAdvanceStageCommand } from "./advance-stage.js";
import { requestScenarioClarify } from "./scenario-clarify.js";

/** 解析出的命令 */
export interface ParsedCommand {
  command: string;
  params: Record<string, unknown>;
}

/**
 * 从模型回复中提取【执行命令】块。
 * @returns clean 为剥离命令块后的正文；command 缺省表示纯对话
 */
export function parseCommandBlock(text: string): { clean: string; command?: ParsedCommand } {
  const match = text.match(/【执行命令】\s*(\{[\s\S]*?\})\s*$/);
  if (!match?.[1]) return { clean: text };
  const clean = text.slice(0, match.index).trimEnd();
  try {
    const parsed = JSON.parse(match[1]) as { command?: unknown; params?: unknown };
    if (typeof parsed.command === "string" && parsed.command) {
      return {
        clean,
        command: {
          command: parsed.command,
          params: (parsed.params ?? {}) as Record<string, unknown>,
        },
      };
    }
  } catch {
    /* 非法命令块：按纯文本处理 */
  }
  return { clean };
}

/** 产品去重（同型号合并，保留最早一条；规格参数归并、F3 照打） */
export function dedupeProducts(
  db: DbInstance,
  productLineId: string,
): { groups: number; productsRemoved: number; specsMoved: number; merged: { model: string; removed: number }[] } {
  const products = db.productRepo.list({
    where: "product_line_id = ?",
    params: [productLineId],
    orderBy: "created_at ASC",
  });
  const groups = new Map<string, typeof products>();
  for (const p of products) {
    const key = p.model.trim().toLowerCase();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }
  const merged: { model: string; removed: number }[] = [];
  let productsRemoved = 0;
  let specsMoved = 0;
  for (const [, list] of groups) {
    if (list.length < 2) continue;
    const [first, ...dupes] = list;
    const keep = first!;
    const patch: Record<string, unknown> = {};
    if (!keep.former_name) {
      const f = dupes.find((d) => d.former_name);
      if (f) patch["former_name"] = f.former_name;
    }
    if (!keep.position_desc) {
      const f = dupes.find((d) => d.position_desc);
      if (f) patch["position_desc"] = f.position_desc;
    }
    if (Object.keys(patch).length) db.productRepo.update(keep.id, patch as never);
    for (const d of dupes) {
      for (const sp of db.specParamRepo.list({ where: "product_id = ?", params: [d.id] })) {
        db.specParamRepo.update(sp.id, { product_id: keep.id } as never);
        specsMoved++;
      }
      db.productRepo.deleteById(d.id);
      productsRemoved++;
    }
    merged.push({ model: keep.model, removed: dupes.length });
  }
  return { groups: merged.length, productsRemoved, specsMoved, merged };
}

/** 执行应用命令，返回可直接写进对话的结果文案 */
export async function executeAppCommand(
  db: DbInstance,
  dshClient: DshClient,
  scenario: Scenario,
  cmd: ParsedCommand,
): Promise<string> {
  switch (cmd.command) {
    case "advance_stage": {
      const stage = Number(cmd.params.stage ?? scenario.current_stage);
      // 阶段是**数据口径**（8 个，0-7），不是用户可见的 8 流程步：
      // 命令跑的是"阶段分析"，用户界面按流程步推进（第 1、2 步同属阶段 1）
      if (!Number.isInteger(stage) || stage < 0 || stage > 7) {
        return `【执行结果】阶段编号非法：${cmd.params.stage ?? "（空）"}（应为 0-7）`;
      }
      const advance = createAdvanceStageCommand({ db, dshClient });
      let rowsWritten = 0;
      let errored = "";
      for await (const ev of advance.execute({ scenarioId: scenario.id, stage: stage as never })) {
        if (ev.type === "done") {
          rowsWritten = Number((ev as { rowsWritten?: unknown }).rowsWritten ?? 0);
        }
        if (ev.type === "error") errored = String((ev as { message?: unknown }).message ?? "");
      }
      if (errored) return `【执行结果】阶段 ${stage} 分析未完成：${errored}`;
      return `【执行结果】阶段 ${stage} 分析完成：共 ${rowsWritten} 行产出。可在当前流程步的表里逐表审阅，右栏已生成阶段总结。`;
    }

    case "export_deliverables": {
      const stageRows = db.stageDataRepo.list({ where: "scenario_id = ?", params: [scenario.id] });
      // v1.4：交付物由阶段总结文档装配（内部报告正文）+ 表数据（对外材料章节 ← 表映射）
      const result = await exportDeliverables({
        scenario,
        stageSummaries: collectStageSummaries(db, scenario),
        stageData: stageRows,
      });
      const outDir = process.env["EXPORT_DIR"] ?? join(process.cwd(), "exports");
      mkdirSync(outDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      const internalPath = join(outDir, exportFileName(scenario.name, "internal", date));
      const externalPath = join(outDir, exportFileName(scenario.name, "external", date));
      writeFileSync(internalPath, result.internal_report, "utf-8");
      writeFileSync(externalPath, result.external_report, "utf-8");
      return `【执行结果】交付物已导出（双口径）：\n内部调研报告 ${internalPath}\n对外汇报材料 ${externalPath}`;
    }

    case "dedupe_products": {
      const r = dedupeProducts(db, scenario.product_line_id);
      return `【执行结果】产品去重完成：合并 ${r.groups} 组，删除 ${r.productsRemoved} 条重复产品，归并 ${r.specsMoved} 行规格参数。`;
    }

    case "clarify_scenario": {
      const r = await requestScenarioClarify(db, dshClient, scenario);
      return r.needClarification
        ? `【执行结果】已在对话中提出 ${r.questions.length} 个场景澄清问题（见上方消息），回答后场景定义会自动更新。`
        : "【执行结果】场景信息已充分，无需澄清。";
    }

    default:
      return `【执行结果】未知命令：${cmd.command}（当前支持 advance_stage / export_deliverables / dedupe_products / clarify_scenario）`;
  }
}
