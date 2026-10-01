/**
 * @scene/web — 第 1 步「场景定义与边界」面板（联真）
 *
 * 这一步是**定义 + 表态合流**（v1.18 把用户可见流程收成 8 步）：
 *  - 定义：在独立的「场景定义」对话里把场景聊清楚，用户点「整理成定义」落成表1-1
 *    （对话属于「新建场景」的一部分，不占流程步）
 *  - 表态：表1-1 **常驻、可就地编辑**；右栏清单只列**需要用户表态的项**
 *    （核心必确认项 ∪ 模型实际填了/推断的项，按返回数组派生，前端不假设行数）
 *
 * 口径定调（用户拍板）：
 *  - 定义要抽象，允许说不准：除核心项外都是选填，可留「待定」
 *  - **定义不卡推进**：第 1 步就绪 = 「定义已整理」，不要求逐项确认
 *  - 就绪判定与提示由服务端给出（`/flow` 的 `readyHint`），前端只显示、不复述规则
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FLOW_TOTAL, flowStep } from "@scene/contract";
import { buildChecklist } from "@scene/domain";
import { api, type ApiAnchorRow, type ApiFlowStatus } from "../api";
import { AnchorTable } from "../components/SchemaTable";
import { definitionProgress } from "../components/definition-progress";
import { FlowCompleteness } from "../components/FlowCompleteness";
import { ScenarioDefinitionDialog } from "../components/ScenarioDefinitionDialog";
import { asSourceType, type StageSnapshot } from "../components/stage-snapshot";
import { useToast } from "../components/Toast";
import { useAsync } from "../hooks/useAsync";

/** 空锚行常量：加载期复用同一引用，避免快照每次渲染都换 identity */
const EMPTY_ANCHOR: ApiAnchorRow[] = [];

export interface AnchorStepPanelProps {
  projectId: string;
  /** 场景名（定义对话弹窗标题） */
  scenarioName: string;
  flow: ApiFlowStatus;
  onChanged?: () => void;
  onFlowChanged?: () => void;
  onStageSnapshot?: (snap: StageSnapshot | null) => void;
  /** 场景澄清：模型提出需要用户回答的问题后弹出对话抽屉 */
  onOpenConversation?: (conversationId?: string) => void;
  /**
   * 外部刷新信号（自增计数）
   *
   * 新建场景时定义对话挂在 App 层（项目刚建好、面板还没被用户点开），
   * 对话里发的消息与整理结果都在本面板之外发生——靠这个信号让本面板重取定义状态。
   */
  refreshToken?: number;
}

export const AnchorStepPanel: React.FC<AnchorStepPanelProps> = ({
  projectId,
  scenarioName,
  flow,
  onChanged,
  onFlowChanged,
  onStageSnapshot,
  onOpenConversation,
  refreshToken = 0,
}) => {
  const { showToast } = useToast();
  const step = flowStep(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [clarifying, setClarifying] = useState(false);
  /** 本地即时生效的锚行（确认 / 编辑 / 整理成定义后不等下一次拉取） */
  const [anchorOverride, setAnchorOverride] = useState<ApiAnchorRow[] | null>(null);

  /* 定义状态与表1-1 同源（GET /definition 一次给全：对话条数 + 锚行） */
  const def = useAsync(() => api.getDefinition(projectId), [projectId, refreshToken]);
  /* 只取稳定的 reload：把整个 def 对象放进依赖会让快照每渲染都变，进而打爆右栏重渲染 */
  const reloadDef = def.reload;
  const anchor = anchorOverride ?? def.data?.anchor ?? EMPTY_ANCHOR;
  const messageCount = def.data?.messages.length ?? 0;

  /* 外部（App 层新建场景弹窗）改动过定义 → 丢弃本地覆盖，用服务端那版 */
  useEffect(() => {
    setAnchorOverride(null);
  }, [projectId, refreshToken]);

  /**
   * 确认清单（右栏 Tab ① 的 L1 部分）
   *
   * 选行由领域层给（核心必确认项 ∪ 模型实际填了/推断的项）——前端只渲染返回数组，
   * 不假设行数；下面的进度数字也从这份清单派生。
   */
  const checklist = useMemo(
    () =>
      buildChecklist({
        anchorRows: anchor.map((a) => ({
          item: a.item,
          content: a.content,
          source_type: asSourceType(a.source_type),
        })),
      }),
    [anchor],
  );

  /** 第 1 步的两个数字口径：定义整理进度 + 需要用户表态的项（不写死行数） */
  const { filled, drafted, stanceTotal, stanceDone, stancePending } = useMemo(
    () =>
      definitionProgress(
        anchor,
        checklist.items.map((i) => ({ layer: i.layer, state: i.state })),
      ),
    [anchor, checklist],
  );

  const ready = flow.steps.find((s) => s.id === step.id)?.ready ?? false;
  /** 就绪原因由服务端给（前端不猜规则） */
  const readyHint = flow.steps.find((s) => s.id === step.id)?.readyHint ?? "";

  /**
   * 最新值经 ref 转发给稳定回调
   *
   * 快照要冒泡到右栏，identity 只能跟**数据**走：若回调依赖父级每次重渲染新建的
   * `onChanged` / `onFlowChanged`，快照就会每渲染都变、右栏跟着无限重渲染。
   */
  const latest = useRef({ anchor, projectId, onChanged, onFlowChanged, showToast, reloadDef });
  latest.current = { anchor, projectId, onChanged, onFlowChanged, showToast, reloadDef };

  /** 写锚行：确认 / 修改 / 就地编辑都走同一条落库路径 */
  const writeAnchor = useCallback(async (next: ApiAnchorRow[]) => {
    const cur = latest.current;
    setAnchorOverride(next);
    try {
      const r = await api.saveAnchor(cur.projectId, next);
      setAnchorOverride(r.rows);
      cur.onChanged?.();
      cur.onFlowChanged?.();
    } catch (err: unknown) {
      cur.showToast(`锚行保存失败：${err instanceof Error ? err.message : String(err)}`);
      cur.reloadDef();
    }
  }, []);

  const handleAnchorAction = useCallback(
    (item: string, action: "确认" | "修改", content?: string) => {
      const next = latest.current.anchor.map((a) =>
        a.item === item
          ? {
              ...a,
              content: content ?? a.content,
              source_type: action === "确认" ? "用户确认" : "用户补充",
              confirm_state: action === "确认" ? "用户确认" : "用户修改",
            }
          : a,
      );
      void writeAnchor(next);
    },
    [writeAnchor],
  );

  /** 就地编辑内容：用户改过的内容即用户补充（来源标记随内容变化） */
  const handleCellChange = useCallback(
    (rowId: string, _cell: string, value: string) => {
      const index = Number(rowId.replace("anchor-", ""));
      const rows = latest.current.anchor;
      const target = rows[index];
      if (!target || target.content === value) return;
      const next = rows.map((a, i) =>
        i === index
          ? { ...a, content: value, source_type: "用户补充", confirm_state: "用户修改" }
          : a,
      );
      void writeAnchor(next);
    },
    [writeAnchor],
  );

  const runClarify = useCallback(async () => {
    setClarifying(true);
    try {
      const r = await api.clarifyScenario(projectId);
      if (r.need_clarification) {
        onOpenConversation?.(r.conversation_id);
        showToast(`已在对话中提出 ${r.questions.length} 个场景澄清问题，请直接在对话里回答`);
      } else {
        showToast(r.note ?? "场景信息已充分，无需澄清");
      }
    } catch (err: unknown) {
      showToast(`澄清失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setClarifying(false);
    }
  }, [projectId, showToast, onOpenConversation]);

  /** 整理成定义成功：表1-1 即刻更新，本步就绪（服务端判定）随之变化 */
  const handleConsolidated = useCallback(
    (rows: ApiAnchorRow[]) => {
      setAnchorOverride(rows);
      showToast("已把这段对话整理成表1-1，请在弹窗里对照检查");
      reloadDef();
      onChanged?.();
      onFlowChanged?.();
    },
    [reloadDef, onChanged, onFlowChanged, showToast],
  );

  /** 关闭定义对话：对话条数/表1-1 可能已变，重取一次 */
  const handleDialogClose = useCallback(() => {
    setDialogOpen(false);
    reloadDef();
  }, [reloadDef]);

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
      onAnchorAction: handleAnchorAction,
    };
  }, [anchor, checklist, step.title, handleAnchorAction, summary, summaryLoading, loadSummary]);

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
            <button
              className="btn"
              type="button"
              disabled={clarifying}
              onClick={() => void runClarify()}
            >
              {clarifying ? "生成问题中…" : "场景澄清"}
            </button>
          </div>
        </div>
        <div className="pnl-b">
          {def.status === "error" ? (
            <div className="empty-state">
              <div className="empty-state-title">场景定义加载失败</div>
              <div className="empty-state-desc">{def.error}</div>
              <button className="btn" type="button" onClick={def.reload}>
                重试
              </button>
            </div>
          ) : null}
          {def.status === "loading" ? (
            <div className="loading-strip" role="status" aria-label="加载中" />
          ) : null}

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
            本步就绪（服务端判定）：{readyHint || (ready ? "已就绪" : "未就绪")}；就绪后点上方流程轴的
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
              带 ✓ 的是需要你表态的项（已表态 {stanceDone}/{stanceTotal}）；改内容即视为
              「用户补充」并立即落库，表态一项即标「用户确认」——只有这两类来源下游才当依据。
              其余项选填，可以留「待定」，后续研究再回填
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
