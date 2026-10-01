/**
 * @scene/web — 演示模式第 1 步面板（无后端）
 *
 * 与联真态**同结构**（同一套类名、同一套文案）：
 *  定义状态行（表1-1 已填几项 / 待你表态几项 / 对话几条）+ 「开始/继续场景定义对话」入口
 *  + 常驻可就地编辑的表1-1（表态在右栏）+ 全流程完整度状态行
 *
 * 口径与联真同义：**定义整理过就能往下走**（第 1 步就绪 = 定义已整理），
 * 需要表态的项按返回数组派生，前端不假设行数。
 *
 * 对话在同一个 `ScenarioDefinitionDialog` 里跑，只是数据来自本地预置（`demo` 分支）。
 * 差别只在数据来源：联真走 API，演示走本地内存 + `mock/demo-flow.ts` 的示例数据。
 * 这样 E2E 在演示模式下断言的流程轴、定义对话与本步面板断言，与联真态是同一套结构。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FLOW_TOTAL, flowStep } from "@scene/contract";
import { AnchorTable } from "../components/SchemaTable";
import { definitionProgress } from "../components/definition-progress";
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
 * 定义对话不占流程步：它属于「新建场景」，聊清楚后落成表1-1，需要表态的项在右栏；
 * 但**表态与否都不卡推进**——整理过就能往下走。
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

  /* 确认清单与联真同源（领域层 buildChecklist）——行数按返回数组，不写死 */
  const checklist = useMemo(() => demoChecklist(anchor), [anchor]);
  const { filled, drafted, stanceTotal, stanceDone, stancePending } = useMemo(
    () =>
      definitionProgress(
        anchor,
        checklist.map((i) => ({ layer: i.layer, state: i.state })),
      ),
    [anchor, checklist],
  );
  /* 演示态的对话是预置的：条数固定，入口恒为「继续」 */
  const messageCount = DEMO_DEFINITION_MESSAGES.length;
  /** 就绪与原因与联真同口径：由本地 flow 状态给（第 1 步 = 定义已整理） */
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
      checklist,
      anchor: [...anchor],
      onRefreshSummary: () => undefined,
      onSupplementChange: () => undefined,
      onAnchorAction: handleAnchorActionStable,
    }),
    [flow, anchor, step.title, handleAnchorActionStable, checklist],
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
              <span className="definition-stat-n">{stancePending}</span>
              <span className="definition-stat-l">项场景本体待表态</span>
            </div>
            <div className="definition-stat">
              <span className="definition-stat-n">{messageCount}</span>
              <span className="definition-stat-l">条对话</span>
            </div>
          </div>

          <p className="brief-hint">
            在对话里把场景聊清楚，然后点「整理成定义」——系统只在那一刻把对话整理成表1-1，
            不会自动改你已经确认过的行。说不准的项先空着或写「待定」都可以。
          </p>
          <p className="brief-hint" role="status">
            本步就绪（演示态与联真同口径）：{readyHint}；就绪后点上方流程轴的
            「完成本步，进入下一步」。
          </p>

          {drafted ? (
            <p className="definition-done" role="status">
              <span className="badge success">已整理成定义</span>
              <span className="brief-hint">
                定义整理过就能往下走；需要你表态的是右栏那 {stanceTotal} 项（已表态 {stanceDone}/
                {stanceTotal}），其余留「待定」，后续研究补全
              </span>
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
              带 ✓ 的是需要你表态的项（已表态 {stanceDone}/{stanceTotal}）；改内容即视为「用户补充」，
              表态一项即标「用户确认」——演示模式只改本地内存；其余项选填，可以留「待定」
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
