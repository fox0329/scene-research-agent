/**
 * @scene/web — 第 1 步「场景定义」面板（联真）
 *
 * 用户定调：场景定义**不该让用户一项一项填空**。所以这一步不再是三段式表单，
 * 而是「定义状态卡 + 一个入口」：
 *   - 对话在独立的「场景定义」弹窗里进行（不是中栏、不是右下角抽屉）
 *   - 「整理成定义」是唯一写表入口，系统不自动增量改用户的表
 *   - 表1-1 整理出来之后，本步就绪，下一步（第 2 步）逐项确认
 *
 * 本步就绪判定（服务端）：表1-1 已有内容，即场景定义已成形。
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FLOW_TOTAL, flowStep } from "@scene/contract";
import { buildChecklist, l1Rows } from "@scene/domain";
import { api, type ApiAnchorRow, type ApiFlowStatus } from "../api";
import { AnchorTable } from "../components/SchemaTable";
import { FlowCompleteness } from "../components/FlowCompleteness";
import { ScenarioDefinitionDialog } from "../components/ScenarioDefinitionDialog";
import { asSourceType, type StageSnapshot } from "../components/stage-snapshot";
import { useToast } from "../components/Toast";
import { useAsync } from "../hooks/useAsync";

export interface DefinitionStepPanelProps {
  projectId: string;
  /** 场景名（对话弹窗标题） */
  scenarioName: string;
  flow: ApiFlowStatus;
  /** 数据变化（刷新左栏项目列表） */
  onChanged?: () => void;
  /** 就绪状态可能变化：请父级重取 /flow */
  onFlowChanged?: () => void;
  onStageSnapshot?: (snap: StageSnapshot | null) => void;
  /** 「去第 2 步逐项确认」（第 2 步已解锁时才提供） */
  onGoToAnchorStep?: () => void;
  /**
   * 外部刷新信号（自增计数）
   *
   * 新建场景时定义对话挂在 App 层（项目刚建好、面板还没被用户点开），
   * 对话里发的消息与整理结果都在本面板之外发生——靠这个信号让本面板重取定义状态。
   */
  refreshToken?: number;
}

export const DefinitionStepPanel: React.FC<DefinitionStepPanelProps> = ({
  projectId,
  scenarioName,
  flow,
  onChanged,
  onFlowChanged,
  onStageSnapshot,
  onGoToAnchorStep,
  refreshToken = 0,
}) => {
  const { showToast } = useToast();
  const step = flowStep(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  /** 定位对话整理后的表1-1（本地即时生效，不等下一次拉取） */
  const [anchorOverride, setAnchorOverride] = useState<ApiAnchorRow[] | null>(null);

  const def = useAsync(() => api.getDefinition(projectId), [projectId, refreshToken]);
  const anchor = anchorOverride ?? def.data?.anchor ?? [];
  const messageCount = def.data?.messages.length ?? 0;

  const ready = flow.steps.find((s) => s.id === 1)?.ready ?? false;
  /** 就绪原因由服务端给（前端不猜规则） */
  const readyHint = flow.steps.find((s) => s.id === 1)?.readyHint ?? "";
  const step2 = flow.steps.find((s) => s.id === 2);
  const canGoStep2 = step2 !== undefined && step2.state !== "未解锁";

  /**
   * 表1-1 内容摘要：几项已填 / 几项待确认（L1 六项）
   *
   * `l1Filled` 才是"已整理成定义"的判据：新建项目时表1-1 骨架会把场景名填上，
   * 但那只是投影，不代表场景本体聊清楚过。
   */
  const { filled, l1Filled, pending } = useMemo(() => {
    const l1Labels = new Set(l1Rows().map((r) => r.label));
    const filledCount = anchor.filter((a) => String(a.content ?? "").trim() !== "").length;
    const l1FilledCount = anchor.filter(
      (a) => l1Labels.has(a.item) && String(a.content ?? "").trim() !== "",
    ).length;
    const checklist = buildChecklist({
      anchorRows: anchor.map((a) => ({
        item: a.item,
        content: a.content,
        source_type: asSourceType(a.source_type),
      })),
    });
    return {
      filled: filledCount,
      l1Filled: l1FilledCount,
      pending: l1Rows().length - checklist.confirmed,
    };
  }, [anchor]);

  /** 整理成定义成功：表1-1 即刻更新，本步就绪（服务端判定）随之变化 */
  const handleConsolidated = useCallback(
    (rows: ApiAnchorRow[]) => {
      setAnchorOverride(rows);
      showToast("已把这段对话整理成表1-1，请在弹窗里对照检查");
      def.reload();
      onChanged?.();
      onFlowChanged?.();
    },
    [def, onChanged, onFlowChanged, showToast],
  );

  /** 关闭定义对话：对话条数/表1-1 可能已变，重取一次 */
  const handleDialogClose = useCallback(() => {
    setDialogOpen(false);
    def.reload();
  }, [def]);

  const handleFinished = useCallback(() => {
    onChanged?.();
    onFlowChanged?.();
  }, [onChanged, onFlowChanged]);

  /* 右栏 Tab ② 的阶段总结：每一步都要有（用户定调"每阶段一份总结文档供参考"） */
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const loadSummary = useCallback(
    async (refresh = false) => {
      setSummaryLoading(true);
      try {
        const r = await api.stageSummary(projectId, 1, refresh);
        setSummary(r.markdown);
      } catch {
        setSummary(null);
      } finally {
        setSummaryLoading(false);
      }
    },
    [projectId],
  );
  useEffect(() => {
    void loadSummary(false);
  }, [loadSummary]);

  const snapshot = useMemo<StageSnapshot | null>(() => {
    const checklist = buildChecklist({
      anchorRows: anchor.map((a) => ({
        item: a.item,
        content: a.content,
        source_type: asSourceType(a.source_type),
      })),
    });
    return {
      stage: 1,
      stageLabel: step.title,
      title: `第 1/${FLOW_TOTAL} 步 · ${step.title}`,
      rows: [],
      completeness: null,
      summary,
      summaryLoading,
      activeTable: "表1-1",
      supplements: [],
      checklist: checklist.items.map((i) => ({
        layer: i.layer,
        tableCode: i.tableCode,
        rowKey: i.rowKey,
        label: i.label,
        state: i.state,
      })),
      anchor,
      onRefreshSummary: () => void loadSummary(true),
      onSupplementChange: () => undefined,
      onAnchorAction: () => undefined,
    };
  }, [anchor, step.title, summary, summaryLoading, loadSummary]);

  useEffect(() => {
    onStageSnapshot?.(snapshot);
    return () => onStageSnapshot?.(null);
  }, [snapshot, onStageSnapshot]);

  const dialogLabel = messageCount > 0 ? "继续场景定义对话" : "开始场景定义对话";

  return (
    <>
      <div className="pnl definition-step">
        <div className="pnl-h">
          <div>
            <h2>
              第 1/{FLOW_TOTAL} 步 · {step.title}
            </h2>
            <p>{step.goal}</p>
          </div>
          <div className="pnl-actions">
            <button
              className="btn primary"
              type="button"
              disabled={def.status === "loading"}
              onClick={() => setDialogOpen(true)}
            >
              {dialogLabel}
            </button>
          </div>
        </div>
        <div className="pnl-b">
          {def.status === "loading" ? (
            <div className="loading-strip" role="status" aria-label="加载中" />
          ) : null}
          {def.status === "error" ? (
            <div className="empty-state">
              <div className="empty-state-title">场景定义加载失败</div>
              <div className="empty-state-desc">{def.error}</div>
              <button className="btn" type="button" onClick={def.reload}>
                重试
              </button>
            </div>
          ) : null}

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
            第 1 步的就绪条件由表1-1 决定（当前：{readyHint || (ready ? "已就绪" : "未就绪")}），
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

      <ScenarioDefinitionDialog
        open={dialogOpen}
        projectId={projectId}
        scenarioName={scenarioName}
        onClose={handleDialogClose}
        onConsolidated={handleConsolidated}
        onFinished={handleFinished}
      />
    </>
  );
};
