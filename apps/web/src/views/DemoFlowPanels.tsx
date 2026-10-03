/**
 * @scene/web — 演示模式第 1 步面板（无后端）
 *
 * 与联真态**同结构**（同一套类名、同一套文案）：中栏只有一张可就地编辑的表1-1，
 * 表头右侧一个「场景定义对话」入口。步标题、引导语、就绪状态行、完整度条、
 * 「确认无误」按钮都不再出现在中栏（用户定调"只重点显示场景概述这个表格"）。
 *
 * 口径与联真同义：用户只输入场景名称，智能体写业务画像；**不显示待确认**。
 *
 * 对话在同一个 `ScenarioDefinitionDialog` 里跑，只是数据来自本地预置（`demo` 分支）。
 * 差别只在数据来源：联真走 API，演示走本地内存 + `mock/demo-flow.ts` 的示例数据。
 * 这样 E2E 在演示模式下断言的流程轴、定义对话与本步面板断言，与联真态是同一套结构。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FLOW_TOTAL, flowStep } from "@scene/contract";
import { AnchorFoldPanel } from "../components/AnchorFoldPanel";
import { anchorSummary } from "../components/definition-progress";
import { ScenarioDefinitionDialog } from "../components/ScenarioDefinitionDialog";
import type { StageSnapshot } from "../components/stage-snapshot";
import type { ApiAnchorRow, ApiCompleteness, ApiFlowStatus } from "../api";
import { demoStageSummary } from "../mock/demo-flow";

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
  /** 就地编辑内容（本地内存，标为「用户补充」） */
  onAnchorEdit: (index: number, content: string) => void;
  onStageSnapshot?: (snap: StageSnapshot | null) => void;
  /** 场景定义对话弹窗的开合（入口在流程轴，状态由 ProjectView 持有） */
  definitionOpen?: boolean;
  onDefinitionOpenChange?: (open: boolean) => void;
}

/**
 * 第 1 步「场景定义与边界」（演示）
 *
 * 与联真**同结构同文案**：中栏只有表1-1；对话入口在**流程轴**上（八步同形）。
 */
export const DemoFirstStep: React.FC<DemoFirstStepProps> = ({
  flow,
  anchor,
  scenarioName,
  onConsolidated,
  onAnchorEdit,
  onStageSnapshot,
  definitionOpen = false,
  onDefinitionOpenChange,
}) => {
  const step = flowStep(1);


  /** 回调经 ref 转发：快照 identity 只跟数据走（与联真同因） */
  const latest = useRef({ onAnchorEdit });
  latest.current = { onAnchorEdit };

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
      summary: demoStageSummary(1, 1),
      summaryLoading: false,
      activeTable: "表1-1",
      supplements: [],
      anchor: [...anchor],
      anchorSummary: anchorSummary(anchor),
      onRefreshSummary: () => undefined,
      onSupplementChange: () => undefined,
    }),
    [flow, anchor, step.title],
  );

  useEffect(() => {
    onStageSnapshot?.(snapshot);
    return () => onStageSnapshot?.(null);
  }, [snapshot, onStageSnapshot]);

  return (
    <>
      {/* 第 1 步 = 定义步：表1-1 默认展开；演示态与联真同结构 */}
      <AnchorFoldPanel
        rows={anchor as unknown as readonly Record<string, unknown>[]}
        summary={anchorSummary(anchor)}
        defaultOpen
        onCellChange={handleCellChange}
      />

      {/* 演示态：同一个定义对话弹窗，只是不发请求（demo 分支用本地预置对话与整理结果） */}
      <ScenarioDefinitionDialog
        open={definitionOpen}
        projectId="demo"
        scenarioName={scenarioName}
        demo
        onClose={() => onDefinitionOpenChange?.(false)}
        onConsolidated={onConsolidated}
      />
    </>
  );
};
