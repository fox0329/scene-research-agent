/**
 * @scene/web — 演示模式第 1 步面板（无后端）
 *
 * 与联真态**同结构**（同一套类名、同一套文案）：
 *  定义状态行（表1-1 已填几项 / 对话几条）+ 「开始/继续场景定义对话」入口
 *  + 常驻可就地编辑的表1-1（逐项确认在右栏）+ 全流程完整度状态行
 *
 * 对话在同一个 `ScenarioDefinitionDialog` 里跑，只是数据来自本地预置（`demo` 分支）。
 * 差别只在数据来源：联真走 API，演示走本地内存 + `mock/demo-flow.ts` 的示例数据。
 * 这样 E2E 在演示模式下断言的流程轴、定义对话与本步面板断言，与联真态是同一套结构。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FLOW_TOTAL, flowStep } from "@scene/contract";
import { l1Rows } from "@scene/domain";
import { AnchorTable } from "../components/SchemaTable";
import { FlowCompleteness } from "../components/FlowCompleteness";
import { ScenarioDefinitionDialog } from "../components/ScenarioDefinitionDialog";
import type { StageSnapshot } from "../components/stage-snapshot";
import type { ApiAnchorRow, ApiCompleteness, ApiFlowStatus } from "../api";
import {
  DEMO_DEFINITION_MESSAGES,
  demoChecklist,
  demoStageSummary,
} from "../mock/demo-flow";

/** 全流程底账 → 右栏完整度口径（与联真同形状） */
function overallCompleteness(flow: ApiFlowStatus, stage: number): ApiCompleteness {
  const expectedTables = flow.steps.reduce((n, s) => n + s.progress.expectedTables, 0);
  const tablesWithData = flow.steps.reduce((n, s) => n + s.progress.tablesWithData, 0);
  return {
    stage,
    expectedTables,
    tablesWithData,
    missingTables: [],
    gaps: [],
    percent: expectedTables > 0 ? Math.round((tablesWithData / expectedTables) * 100) : 0,
  };
}

export interface DemoFirstStepProps {
  flow: ApiFlowStatus;
  anchor: readonly ApiAnchorRow[];
  scenarioName: string;
  /** 整理成定义：演示态把本地表1-1 换成整理结果 */
  onConsolidated: (rows: ApiAnchorRow[]) => void;
  /** 确认 / 修改一项（本地内存；右栏确认清单的落点） */
  onAnchorAction: (item: string, action: "确认" | "修改", content?: string) => void;
  /** 就地编辑内容（本地内存，标为「用户补充」） */
  onAnchorEdit: (index: number, content: string) => void;
  onStageSnapshot?: (snap: StageSnapshot | null) => void;
}

/**
 * 第 1 步「场景定义与边界」（演示）
 *
 * 定义对话不占流程步：它属于「新建场景」，聊清楚后落成表1-1，确认动作在这一步完成。
 */
export const DemoFirstStep: React.FC<DemoFirstStepProps> = ({
  flow,
  anchor,
  scenarioName,
  onConsolidated,
  onAnchorAction,
  onAnchorEdit,
  onStageSnapshot,
}) => {
  const step = flowStep(1);
  const [dialogOpen, setDialogOpen] = useState(false);

  const filled = anchor.filter((a) => String(a.content ?? "").trim() !== "").length;
  const l1 = l1Rows();
  const confirmedL1 = anchor.filter((a) => {
    if (!l1.some((r) => r.label === a.item)) return false;
    const st = String(a.source_type ?? "");
    return st === "用户确认" || st === "用户补充";
  }).length;
  const pending = l1.length - confirmedL1;
  /* 「已整理成定义」看 L1 场景本体是否已有内容（不是看表1-1 骨架有没有被投影填行） */
  const l1Filled = anchor.filter(
    (a) => l1.some((r) => r.label === a.item) && String(a.content ?? "").trim() !== "",
  ).length;
  /* 演示态的对话是预置的：条数固定，入口恒为「继续」 */
  const messageCount = DEMO_DEFINITION_MESSAGES.length;
  /** 就绪与原因与联真同口径：由本地 flow 状态给（第 1 步 = L1 六项全部确认） */
  const readyHint = flow.steps.find((s) => s.id === step.id)?.readyHint ?? "";

  /** 回调经 ref 转发：快照 identity 只跟数据走（与联真同因） */
  const latest = useRef({ anchor, onAnchorAction, onAnchorEdit });
  latest.current = { anchor, onAnchorAction, onAnchorEdit };

  const handleAnchorActionStable = useCallback(
    (item: string, action: "确认" | "修改", content?: string) =>
      latest.current.onAnchorAction(item, action, content),
    [],
  );

  const handleCellChange = useCallback((rowId: string, _cell: string, value: string) => {
    const index = Number(rowId.replace("anchor-", ""));
    if (Number.isFinite(index)) latest.current.onAnchorEdit(index, value);
  }, []);

  const snapshot = useMemo<StageSnapshot>(
    () => ({
      stage: 1,
      stageLabel: step.title,
      title: `第 1/${FLOW_TOTAL} 步 · ${step.title}`,
      rows: [],
      completeness: overallCompleteness(flow, 1),
      summary: demoStageSummary(1),
      summaryLoading: false,
      activeTable: "表1-1",
      supplements: [],
      checklist: demoChecklist(anchor),
      anchor: [...anchor],
      onRefreshSummary: () => undefined,
      onSupplementChange: () => undefined,
      onAnchorAction: handleAnchorActionStable,
    }),
    [flow, anchor, step.title, handleAnchorActionStable],
  );

  useEffect(() => {
    onStageSnapshot?.(snapshot);
    return () => onStageSnapshot?.(null);
  }, [snapshot, onStageSnapshot]);

  return (
    <>
      <div className="pnl definition-step">
        <div className="pnl-h">
          <div>
            <h2>
              第 1/{FLOW_TOTAL} 步 · {step.title}
            </h2>
            <p>{step.goal}（演示模式：对话与整理结果均为本地预置）</p>
          </div>
          <div className="pnl-actions">
            <button className="btn primary" type="button" onClick={() => setDialogOpen(true)}>
              {messageCount > 0 ? "继续场景定义对话" : "开始场景定义对话"}
            </button>
          </div>
        </div>
        <div className="pnl-b">
          <div className="definition-status">
            <div className="definition-stat">
              <span className="definition-stat-n">{filled}</span>
              <span className="definition-stat-l">项已有内容</span>
            </div>
            <div className="definition-stat">
              <span className="definition-stat-n">{pending}</span>
              <span className="definition-stat-l">项待确认</span>
            </div>
            <div className="definition-stat">
              <span className="definition-stat-n">{messageCount}</span>
              <span className="definition-stat-l">条对话</span>
            </div>
          </div>

          <p className="brief-hint">
            在对话里把场景聊清楚，然后点「整理成定义」——系统只在那一刻把对话整理成表1-1，
            不会自动改你已经确认过的行。
          </p>
          <p className="brief-hint" role="status">
            本步就绪（演示态与联真同口径）：{readyHint}；就绪后点上方流程轴的
            「完成本步，进入下一步」。
          </p>

          {l1Filled > 0 ? (
            <p className="definition-done" role="status">
              <span className="badge success">已整理成定义</span>
              <span className="brief-hint">下一步：在下方表1-1 里逐项确认场景本体</span>
            </p>
          ) : null}
        </div>
        <div className="pnl-b flush">
          <FlowCompleteness flow={flow} />
        </div>
      </div>

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表1-1 场景概述 · 场景锚（可就地编辑）</h2>
            <p>
              带 ✓ 的 {l1.length} 项需你确认（已确认 {confirmedL1}/{l1.length}）；改内容即视为「用户补充」，
              确认一项即标「用户确认」——演示模式只改本地内存
            </p>
          </div>
        </div>
        <div className="pnl-b flush">
          <AnchorTable
            rows={anchor.map((a, i) => ({ id: `anchor-${i}`, row: { ...a } }))}
            onCellChange={handleCellChange}
          />
        </div>
      </div>

      {/* 演示态：同一个定义对话弹窗，只是不发请求（demo 分支用本地预置对话与整理结果） */}
      <ScenarioDefinitionDialog
        open={dialogOpen}
        projectId="demo"
        scenarioName={scenarioName}
        demo
        onClose={() => setDialogOpen(false)}
        onConsolidated={onConsolidated}
      />
    </>
  );
};
