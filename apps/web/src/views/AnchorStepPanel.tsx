/**
 * @scene/web — 第 1 步「场景定义与边界」面板（联真）
 *
 * 这一步的**属主划分**（2026-09-26 用户定稿，以「燃气场站」那份定义为准）：
 *  - **用户只输入「场景名称」**；其余 5 项（场景边界 / 生产对象 / 核心生产系统 /
 *    买方类型 / 采购特征）由智能体从业务角度写出——写成一份**场景业务画像**
 *  - **「确认无误」是一次整表确认**，且**不卡推进**；产品**不显示"待确认"**
 *  - 表1-1 常驻、**可就地改**：想改哪格改哪格
 *
 * 页面只留三样东西：一句状态（服务端 `readyHint`）、表1-1、两个按钮。
 * 统计卡 / 缺口清单 / 逐项表态清单全部删除——它们要么是零信息（"0 项待表态"），
 * 要么是把智能体自己的活写成用户的待办（"6 行无来源"）。
 *
 * 就绪判定与提示由服务端给出（`/flow` 的 `readyHint`），前端只显示、不复述规则。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FLOW_TOTAL, flowStep } from "@scene/contract";
import { api, type ApiAnchorRow, type ApiFlowStatus } from "../api";
import { AnchorFoldPanel } from "../components/AnchorFoldPanel";
import {
  anchorSummary,
  isDefinitionConfirmed,
  isDefinitionDrafted,
} from "../components/definition-progress";
import { FlowCompleteness } from "../components/FlowCompleteness";
import { ScenarioDefinitionDialog } from "../components/ScenarioDefinitionDialog";
import type { StageSnapshot } from "../components/stage-snapshot";
import { useToast } from "../components/Toast";
import { useAsync } from "../hooks/useAsync";

/** 空锚行常量：加载期复用同一引用，避免快照每次渲染都换 identity */
const EMPTY_ANCHOR: ApiAnchorRow[] = [];

/** 有内容即"说过话"的行（「未提供」不算） */
function hasContent(row: ApiAnchorRow): boolean {
  const text = String(row.content ?? "").trim();
  return text !== "" && text !== "未提供";
}

export interface AnchorStepPanelProps {
  projectId: string;
  /** 场景名（定义对话弹窗标题） */
  scenarioName: string;
  flow: ApiFlowStatus;
  onChanged?: () => void;
  onFlowChanged?: () => void;
  onStageSnapshot?: (snap: StageSnapshot | null) => void;
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
  refreshToken = 0,
}) => {
  const { showToast } = useToast();
  const step = flowStep(1);
  const [dialogOpen, setDialogOpen] = useState(false);
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

  const drafted = useMemo(() => isDefinitionDrafted(anchor), [anchor]);
  const confirmed = useMemo(() => isDefinitionConfirmed(anchor), [anchor]);

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

  /**
   * 就地编辑：改过的内容即用户补充
   *
   * 同时把该行的 `confirm_state` 记为「用户修改」——内容变了，之前的整表确认
   * 对那一行不再成立（其余行不受影响）。
   */
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

  /**
   * 「确认无误」——一次整表确认
   *
   * 只写 `confirm_state`，**不动 `source_type`**：来源是溯源信息（AI提取 / AI推断 /
   * 用户补充），用户认可不等于来源变了（G-R0 来源溯源铁律）。确认后这些行可被
   * 下游当依据；下次智能体重写某行会把它退回未确认。
   */
  const handleConfirmAll = useCallback(() => {
    const rows = latest.current.anchor;
    void writeAnchor(
      rows.map((r) => (hasContent(r) ? { ...r, confirm_state: "用户确认" } : r)),
    );
    showToast("已确认这份定义；随时可以就地修改");
  }, [writeAnchor, showToast]);

  /** 整理成定义成功：表1-1 即刻更新，本步就绪随之变化 */
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
      anchor,
      anchorSummary: anchorSummary(anchor),
      onRefreshSummary: () => void loadSummary(true),
      onSupplementChange: () => undefined,
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
              className="btn"
              type="button"
              disabled={!drafted || confirmed || def.status === "loading"}
              onClick={handleConfirmAll}
            >
              {confirmed ? "已确认" : "确认无误"}
            </button>
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

          {/* 一句话状态：就绪由服务端判定并给话术；确认过就报"看过了"。
              不再有统计卡、不再复述规则、不再暴露"服务端判定"这类实现细节。 */}
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

      {/* 第 1 步 = 定义步：表1-1 默认展开，可就地编辑 */}
      <AnchorFoldPanel
        rows={anchor as unknown as readonly Record<string, unknown>[]}
        summary={anchorSummary(anchor)}
        defaultOpen
        onCellChange={handleCellChange}
      />

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
