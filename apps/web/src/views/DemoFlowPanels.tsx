/**
 * @scene/web — 演示模式第 1/2 步面板（无后端）
 *
 * 与联真态**同结构**：
 *  第 1 步 = 定义状态卡 + 「开始/继续场景定义对话」入口 + 常驻表1-1 + 全流程完整度状态行
 *            （对话在同一个 `ScenarioDefinitionDialog` 里跑，只是数据来自本地预置）
 *  第 2 步 = 可就地编辑的表1-1 + 全流程完整度状态行（确认清单在右栏）
 *
 * 差别只在数据来源：联真走 API，演示走本地内存 + `mock/demo-flow.ts` 的示例数据。
 * 这样 E2E 在演示模式下断言的流程轴、定义对话与表1-1/完整度/右栏断言，与联真态是同一套结构。
 */

import React, { useCallback, useMemo, useState } from "react";
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
  demoConfirmedL1,
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

// ─── 第 1 步：场景定义（演示） ─────────────────────────────

export const DemoDefinitionStep: React.FC<{
  flow: ApiFlowStatus;
  anchor: readonly ApiAnchorRow[];
  scenarioName: string;
  /** 整理成定义：演示态把本地表1-1 换成整理结果 */
  onConsolidated: (rows: ApiAnchorRow[]) => void;
  /** 「去第 2 步逐项确认」（第 2 步已解锁时才提供） */
  onGoToAnchorStep?: () => void;
  onStageSnapshot?: (snap: StageSnapshot | null) => void;
}> = ({ flow, anchor, scenarioName, onConsolidated, onGoToAnchorStep, onStageSnapshot }) => {
  const step = flowStep(1);
  const [dialogOpen, setDialogOpen] = useState(false);

  const filled = anchor.filter((a) => String(a.content ?? "").trim() !== "").length;
  /* 「已整理成定义」看 L1 场景本体是否已有内容（不是看表1-1 骨架有没有被投影填行） */
  const l1Labels = new Set(l1Rows().map((r) => r.label));
  const l1Filled = anchor.filter(
    (a) => l1Labels.has(a.item) && String(a.content ?? "").trim() !== "",
  ).length;
  const pending = l1Rows().length - demoConfirmedL1(anchor);
  const messageCount = DEMO_DEFINITION_MESSAGES.length;
  const ready = flow.steps.find((s) => s.id === 1)?.ready ?? false;
  const step2 = flow.steps.find((s) => s.id === 2);
  const canGoStep2 = step2 !== undefined && step2.state !== "未解锁";

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
      onAnchorAction: () => undefined,
    }),
    [flow, anchor, step.title],
  );

  React.useEffect(() => {
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
          <p className="brief-hint">
            第 1 步的就绪条件是「表1-1 已有内容」（当前：{ready ? "已就绪" : "未就绪"}），
            就绪后点上方流程轴的「完成本步，进入下一步」。
          </p>

          {l1Filled > 0 ? (
            <p className="definition-done" role="status">
              <span className="badge success">已整理成定义</span>
              <span className="brief-hint">下一步：逐项确认表格（第 2 步）</span>
              {canGoStep2 && onGoToAnchorStep ? (
                <button className="btn btn-sm" type="button" onClick={onGoToAnchorStep}>
                  去第 2 步逐项确认
                </button>
              ) : null}
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
            <h2>表1-1 场景概述 · 场景锚</h2>
            <p>全链唯一的场景定义；带 ✓ 的 {l1Rows().length} 项需你确认，第 2 步在右栏逐项确认</p>
          </div>
        </div>
        <div className="pnl-b flush">
          <AnchorTable
            rows={anchor.map((a, i) => ({ id: `anchor-${i}`, row: { ...a } }))}
            readOnly
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

// ─── 第 2 步：场景定义与边界（演示） ───────────────────────

export const DemoAnchorStep: React.FC<{
  flow: ApiFlowStatus;
  anchor: readonly ApiAnchorRow[];
  /** 确认 / 修改一项（本地内存） */
  onAnchorAction: (item: string, action: "确认" | "修改", content?: string) => void;
  /** 就地编辑内容（本地内存，标为「用户补充」） */
  onAnchorEdit: (index: number, content: string) => void;
  onStageSnapshot?: (snap: StageSnapshot | null) => void;
}> = ({ flow, anchor, onAnchorAction, onAnchorEdit, onStageSnapshot }) => {
  const step = flowStep(2);
  const confirmed = demoConfirmedL1(anchor);

  const snapshot = useMemo<StageSnapshot>(
    () => ({
      stage: 1,
      stageLabel: step.title,
      title: `第 2/${FLOW_TOTAL} 步 · ${step.title}`,
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
      onAnchorAction,
    }),
    [flow, anchor, step.title, onAnchorAction],
  );

  React.useEffect(() => {
    onStageSnapshot?.(snapshot);
    return () => onStageSnapshot?.(null);
  }, [snapshot, onStageSnapshot]);

  const handleCellChange = useCallback(
    (rowId: string, _cell: string, value: string) => {
      const index = Number(rowId.replace("anchor-", ""));
      if (Number.isFinite(index)) onAnchorEdit(index, value);
    },
    [onAnchorEdit],
  );

  return (
    <>
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>
              第 2/{FLOW_TOTAL} 步 · {step.title}
            </h2>
            <p>
              {step.goal}；带 ✓ 的 {l1Rows().length} 项需你确认（已确认 {confirmed}/{l1Rows().length}），
              右栏可逐项确认
            </p>
          </div>
        </div>
        <div className="pnl-b flush">
          <FlowCompleteness flow={flow} />
        </div>
      </div>

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表1-1 场景概述 · 场景锚（可就地编辑）</h2>
            <p>改内容即视为「用户补充」；确认一项即标「用户确认」——演示模式只改本地内存</p>
          </div>
        </div>
        <div className="pnl-b flush">
          <AnchorTable
            rows={anchor.map((a, i) => ({ id: `anchor-${i}`, row: { ...a } }))}
            onCellChange={handleCellChange}
          />
        </div>
      </div>
    </>
  );
};
