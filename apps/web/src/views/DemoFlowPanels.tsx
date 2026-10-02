/**
 * @scene/web — 演示模式第 1 步面板（无后端）
 *
 * 与联真态**同结构**（同一套类名、同一套文案）：
 *  一句话状态（就绪由本地 flow 给）+ 「确认无误」+「开始/继续场景定义对话」入口
 *  + 常驻可就地编辑的表1-1 + 全流程完整度状态行
 *
 * 口径与联真同义：用户只输入场景名称，智能体写业务画像；**确认不卡推进**，
 * 且**不显示待确认**。
 *
 * 对话在同一个 `ScenarioDefinitionDialog` 里跑，只是数据来自本地预置（`demo` 分支）。
 * 差别只在数据来源：联真走 API，演示走本地内存 + `mock/demo-flow.ts` 的示例数据。
 * 这样 E2E 在演示模式下断言的流程轴、定义对话与本步面板断言，与联真态是同一套结构。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FLOW_TOTAL, flowStep } from "@scene/contract";
import { AnchorFoldPanel } from "../components/AnchorFoldPanel";
import {
  anchorSummary,
  isDefinitionConfirmed,
  isDefinitionDrafted,
} from "../components/definition-progress";
import { FlowCompleteness } from "../components/FlowCompleteness";
import { ScenarioDefinitionDialog } from "../components/ScenarioDefinitionDialog";
import type { StageSnapshot } from "../components/stage-snapshot";
import type { ApiAnchorRow, ApiCompleteness, ApiFlowStatus } from "../api";
import { DEMO_DEFINITION_MESSAGES, demoStageSummary } from "../mock/demo-flow";

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
  /** 「确认无误」：演示态把本地表1-1 标为已确认（不卡推进） */
  onConfirmAll: () => void;
  /** 就地编辑内容（本地内存，标为「用户补充」） */
  onAnchorEdit: (index: number, content: string) => void;
  onStageSnapshot?: (snap: StageSnapshot | null) => void;
}

/**
 * 第 1 步「场景定义与边界」（演示）
 *
 * 与联真**同结构同文案**：用户只输入场景名称，智能体写业务画像；
 * 「确认无误」是一次整表确认、**不卡推进**；产品**不显示待确认**。
 * 页面只留一句状态 + 表1-1 + 两个按钮（统计卡与逐项表态清单已删除）。
 */
export const DemoFirstStep: React.FC<DemoFirstStepProps> = ({
  flow,
  anchor,
  scenarioName,
  onConsolidated,
  onConfirmAll,
  onAnchorEdit,
  onStageSnapshot,
}) => {
  const step = flowStep(1);
  const [dialogOpen, setDialogOpen] = useState(false);

  const drafted = useMemo(() => isDefinitionDrafted(anchor), [anchor]);
  const confirmed = useMemo(() => isDefinitionConfirmed(anchor), [anchor]);
  /* 演示态的对话是预置的：条数固定，入口恒为「继续」 */
  const messageCount = DEMO_DEFINITION_MESSAGES.length;
  /** 就绪与原因与联真同口径：由本地 flow 状态给 */
  const ready = flow.steps.find((s) => s.id === step.id)?.ready ?? false;
  const readyHint = flow.steps.find((s) => s.id === step.id)?.readyHint ?? "";

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
      summary: demoStageSummary(1),
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
      <div className="pnl definition-step">
        <div className="pnl-h">
          <div>
            <h2>
              第 1/{FLOW_TOTAL} 步 · {step.title}
            </h2>
            <p>{step.goal}（演示模式：对话与整理结果均为本地预置）</p>
          </div>
          <div className="pnl-actions">
            <button
              className="btn"
              type="button"
              disabled={!drafted || confirmed}
              onClick={onConfirmAll}
            >
              {confirmed ? "已确认" : "确认无误"}
            </button>
            <button className="btn primary" type="button" onClick={() => setDialogOpen(true)}>
              {messageCount > 0 ? "继续场景定义对话" : "开始场景定义对话"}
            </button>
          </div>
        </div>
        <div className="pnl-b">
          <p className="brief-hint" role="status" data-ready={ready ? "1" : "0"}>
            {confirmed
              ? "这份定义你看过了；改过哪一格，可以再点一次「确认无误」。"
              : readyHint}
          </p>
        </div>
        <div className="pnl-b flush">
          <FlowCompleteness flow={flow} />
        </div>
      </div>

      {/* 第 1 步 = 定义步：表1-1 默认展开；演示态与联真同结构 */}
      <AnchorFoldPanel
        rows={anchor as unknown as readonly Record<string, unknown>[]}
        summary={anchorSummary(anchor)}
        defaultOpen
        onCellChange={handleCellChange}
      />

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
