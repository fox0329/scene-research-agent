/**
 * @scene/web — 第 1 步「场景定义与边界」面板（联真）
 *
 * **中栏只有表1-1**（场景概述）。这一步的属主划分（2026-09-26 用户定稿）：
 *  - **用户只输入「场景名称」**；其余 5 项（场景边界 / 生产对象 / 核心生产系统 /
 *    买方类型 / 采购特征）由智能体从业务角度写出——写成一份**场景业务画像**
 *  - 表1-1 常驻、**可就地改**：改哪格就改哪格，改过即算用户补充
 *
 * 用户定调"中栏只重点显示场景概述这个表格，其他的都不要干扰"，因此这一步删掉了：
 * 步标题 + 引导语（与流程轴上的同一句话重复）、就绪状态行、信息完整度条、
 * 「确认无误」按钮（确认动作改为"就地编辑即确认"，不再有整表确认这个来回）。
 * 让智能体写出画像的「场景定义对话」入口在**流程轴**上（第 1 步的运行按钮，v1.23 用户定调
 * 「都与认识场景保持一致」）——中栏不留按钮，只放表。
 *
 * 就绪判定与提示由服务端给出（`/flow` 的 `readyHint`），只在流程轴上显示一次。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onDataChanged } from "../data-events";
import { api, type ApiAnchorRow } from "../api";
import { AnchorFoldPanel } from "../components/AnchorFoldPanel";
import { anchorSummary } from "../components/definition-progress";
import { ScenarioDefinitionDialog } from "../components/ScenarioDefinitionDialog";
import type { StageBriefView, StageSnapshot } from "../components/stage-snapshot";
import { useToast } from "../components/Toast";
import { useAsync } from "../hooks/useAsync";

/** 空锚行常量：加载期复用同一引用，避免快照每次渲染都换 identity */
const EMPTY_ANCHOR: ApiAnchorRow[] = [];

export interface AnchorStepPanelProps {
  projectId: string;
  /** 场景名（定义对话弹窗标题） */
  scenarioName: string;
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
  /** 场景定义对话弹窗的开合（入口在流程轴，状态由 ProjectView 持有） */
  definitionOpen?: boolean;
  onDefinitionOpenChange?: (open: boolean) => void;
}

export const AnchorStepPanel: React.FC<AnchorStepPanelProps> = ({
  projectId,
  scenarioName,
  onChanged,
  onFlowChanged,
  onStageSnapshot,
  refreshToken = 0,
  definitionOpen = false,
  onDefinitionOpenChange,
}) => {
  const { showToast } = useToast();
  const dialogOpen = definitionOpen;
  const setDialogOpen = useCallback(
    (open: boolean) => onDefinitionOpenChange?.(open),
    [onDefinitionOpenChange],
  );
  /** 本地即时生效的锚行（编辑 / 整理成定义后不等下一次拉取） */
  const [anchorOverride, setAnchorOverride] = useState<ApiAnchorRow[] | null>(null);

  /* 定义状态与表1-1 同源（GET /definition 一次给全：对话条数 + 锚行） */
  const def = useAsync(() => api.getDefinition(projectId), [projectId, refreshToken]);
  /* 只取稳定的 reload：把整个 def 对象放进依赖会让快照每渲染都变，进而打爆右栏重渲染 */
  const reloadDef = def.reload;
  const anchor = anchorOverride ?? def.data?.anchor ?? EMPTY_ANCHOR;

  /* 外部（App 层新建场景弹窗）改动过定义 → 丢弃本地覆盖，用服务端那版 */
  useEffect(() => {
    setAnchorOverride(null);
  }, [projectId, refreshToken]);

  /**
   * 最新值经 ref 转发给稳定回调
   *
   * 快照要冒泡到右栏，identity 只能跟**数据**走：若回调依赖父级每次重渲染新建的
   * `onChanged` / `onFlowChanged`，快照就会每渲染都变、右栏跟着无限重渲染。
   */
  const latest = useRef({ anchor, projectId, onChanged, onFlowChanged, showToast, reloadDef });
  latest.current = { anchor, projectId, onChanged, onFlowChanged, showToast, reloadDef };

  /** 写锚行：就地编辑走这条落库路径 */
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
   * `source_type` 记「用户补充」（这不是判断，是溯源事实：谁写进去的）。
   */
  const handleCellChange = useCallback(
    (rowId: string, _cell: string, value: string) => {
      const index = Number(rowId.replace("anchor-", ""));
      const rows = latest.current.anchor;
      const target = rows[index];
      if (!target || target.content === value) return;
      const next = rows.map((a, i) =>
        i === index ? { ...a, content: value, source_type: "用户补充" } : a,
      );
      void writeAnchor(next);
    },
    [writeAnchor],
  );

  /** 整理成定义成功：表1-1 即刻更新 */
  const handleConsolidated = useCallback(
    (rows: ApiAnchorRow[]) => {
      setAnchorOverride(rows);
      showToast("已把这段对话整理成表1-1");
      reloadDef();
      onChanged?.();
      onFlowChanged?.();
    },
    [reloadDef, onChanged, onFlowChanged, showToast],
  );

  /** 关闭定义对话：对话条数/表1-1 可能已变，重取一次 */
  /** #315：右栏对话改表后，锚表立即重取 */
  useEffect(() => {
    return onDataChanged(() => reloadDef());
  }, [reloadDef]);

  const handleDialogClose = useCallback(() => {
    setDialogOpen(false);
    reloadDef();
  }, [reloadDef]);

  const handleFinished = useCallback(() => {
    onChanged?.();
    onFlowChanged?.();
  }, [onChanged, onFlowChanged]);
  /* 右栏要点：来源地址 + 结论提醒（阶段总结已下线，#304） */
  const [briefLoading, setBriefLoading] = useState(false);
  const [brief, setBrief] = useState<StageBriefView | null>(null);
  const loadBrief = useCallback(async () => {
    setBriefLoading(true);
    try {
      const b = await api.stageBrief(projectId, 1, 1);
      setBrief(b.brief);
    } catch {
      setBrief(null);
    } finally {
      setBriefLoading(false);
    }
  }, [projectId]);
  useEffect(() => {
    void loadBrief();
  }, [loadBrief]);


  const snapshot = useMemo<StageSnapshot | null>(() => {
    return {
      briefLoading,
      brief,
      artifact: {
        step: 1,
        type: "anchor",
        id: "表1-1",
        block: null,
        title: "场景定义与边界",
        revision: anchor.map((row) => `${row.item}=${row.content}`).join("\u0001"),
      },
      onRefreshBrief: () => void loadBrief(),
    };
  }, [projectId, briefLoading, brief, loadBrief]);

  useEffect(() => {
    onStageSnapshot?.(snapshot);
    return () => onStageSnapshot?.(null);
  }, [snapshot, onStageSnapshot]);

  return (
    <>
      {/* 中栏只有这一张表：场景概述（表1-1），默认可就地编辑 */}
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
