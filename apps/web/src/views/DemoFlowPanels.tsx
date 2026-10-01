/**
 * @scene/web — 演示模式第 1/2 步面板（无后端）
 *
 * 与联真态**同结构**：
 *  第 1 步 = 三段式诉求字段 + 常驻表1-1 + 全流程完整度状态行（起草后出现对照表）
 *  第 2 步 = 可就地编辑的表1-1 + 全流程完整度状态行（确认清单在右栏）
 *
 * 差别只在数据来源：联真走 API，演示走本地内存 + `mock/demo-flow.ts` 的示例数据。
 * 这样 E2E 在演示模式下断言的流程轴与表1-1/完整度/右栏断言，与联真态是同一套结构。
 */

import React, { useCallback, useMemo, useState } from "react";
import { FLOW_TOTAL, flowStep } from "@scene/contract";
import { AnchorTable } from "../components/SchemaTable";
import { FlowCompleteness } from "../components/FlowCompleteness";
import {
  BriefAlignmentTable,
  BriefFieldGroup,
  EMPTY_BRIEF_FORM,
  type BriefForm,
} from "../components/ScenarioBriefDialog";
import type { StageSnapshot } from "../components/stage-snapshot";
import { useToast } from "../components/Toast";
import type { ApiAnchorRow, ApiCompleteness, ApiFlowStatus } from "../api";
import {
  DEMO_SCENE_NAME,
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

const DEMO_BRIEF: BriefForm = {
  ...EMPTY_BRIEF_FORM,
  scene_name: DEMO_SCENE_NAME,
  intent: "这个场景值不值得进",
  customer_hint: "市政水务集团",
  scope_hint: "只看出厂到管网",
};

const DEMO_QUESTIONS = [
  "「只看出厂到管网」——原水取水与二次供水算不算在内？",
  "切入点写的是「存量泵站改造」，是新建项目还是替换既有设备？",
];

// ─── 第 1 步：场景诉求（演示） ─────────────────────────────

export const DemoBriefStep: React.FC<{
  flow: ApiFlowStatus;
  anchor: readonly ApiAnchorRow[];
  onStageSnapshot?: (snap: StageSnapshot | null) => void;
}> = ({ flow, anchor, onStageSnapshot }) => {
  const { showToast } = useToast();
  const step = flowStep(1);
  const [form, setForm] = useState<BriefForm>(DEMO_BRIEF);
  const [drafted, setDrafted] = useState(false);

  const setField = (k: keyof BriefForm, v: string): void => setForm((prev) => ({ ...prev, [k]: v }));

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
      <div className="pnl brief-step">
        <div className="pnl-h">
          <div>
            <h2>
              第 1/{FLOW_TOTAL} 步 · {step.title}
            </h2>
            <p>{step.goal}（演示模式：诉求已预填，可直接改）</p>
          </div>
          <div className="pnl-actions">
            <button
              className="btn"
              type="button"
              onClick={() => showToast("演示模式：诉求保存仅为示意")}
            >
              保存诉求
            </button>
            <button className="btn" type="button" onClick={() => setDrafted(true)}>
              起草场景锚
            </button>
          </div>
        </div>
        <div className="pnl-b">
          <BriefFieldGroup section="name" form={form} onChange={setField} />
          <BriefFieldGroup section="intent" form={form} onChange={setField} />
          <BriefFieldGroup section="clues" form={form} onChange={setField} />
        </div>
        <div className="pnl-b flush">
          <FlowCompleteness flow={flow} />
        </div>
      </div>

      {drafted ? (
        <div className="pnl">
          <div className="pnl-h">
            <div>
              <h2>对照式确认：系统理解 vs 你的原话</h2>
              <p>标「推断」的行是系统猜的，必须由你在第 2 步确认后下游才当作依据</p>
            </div>
          </div>
          <div className="pnl-b">
            <BriefAlignmentTable rows={[...anchor]} questions={DEMO_QUESTIONS} />
          </div>
        </div>
      ) : null}

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表1-1 场景概述 · 场景锚（常驻）</h2>
            <p>全链唯一的场景定义；带 ✓ 的 6 项需你确认，第 2 步在右栏逐项确认</p>
          </div>
        </div>
        <div className="pnl-b flush">
          <AnchorTable
            rows={anchor.map((a, i) => ({ id: `anchor-${i}`, row: { ...a } }))}
            readOnly
          />
        </div>
      </div>
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
              {step.goal}；带 ✓ 的 6 项需你确认（已确认 {confirmed}/6），右栏可逐项确认
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
