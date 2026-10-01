/**
 * @scene/web — 最后一步「交付物」面板
 *
 * 组装步：不需要模型分析，系统按「章节 ← 表映射」把前面各步的产出装配成两份文件：
 *  - 内部调研版（含来源、证据级、缺口）
 *  - 对外汇报版（只保留可对外的事实）
 *
 * 中栏列出每一步的完成状态与产出规模；右栏是交付物说明（同一套右栏结构）。
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FLOW_TOTAL, flowStep } from "@scene/contract";
import { api, type ApiFlowStatus } from "../api";
import { FlowCompleteness } from "../components/FlowCompleteness";
import type { StageSnapshot } from "../components/stage-snapshot";
import { useToast } from "../components/Toast";

export interface DeliveryPanelProps {
  flow: ApiFlowStatus;
  /** 联真模式才能真的落盘导出；演示模式只说明 */
  live: boolean;
  projectId?: string | null;
  onStageSnapshot?: (snap: StageSnapshot | null) => void;
  /** 导出完成（刷新项目列表：场景可能已标记完成） */
  onExported?: () => void;
}

const DELIVERY_NOTE = [
  "## 交付物说明",
  "这一步由系统**装配**，不需要模型分析：章节 ← 表映射是确定的，谁也别再编一遍。",
  "",
  "### 两份口径",
  "- 内部调研版：完整信息 + 来源与证据级 + 信息缺口 + 「不做什么」边界声明",
  "- 对外汇报版：只保留可对外的事实与结论，含未确认标记的内容会被剔除",
  "",
  "### 生成前提",
  `- 前面 ${FLOW_TOTAL - 1} 步的步骤总结（每步一份）是装配原料；没有产出的步骤会在交付物里标「无信息」`,
  "- 场景锚（表1-1）以**用户确认过的版本**为准；标「推断」的行不会被写进对外版",
  "",
  "> 交付物只陈述信息与缺口，不含建议或判断——判断由使用者自己做。",
].join("\n");

export const DeliveryPanel: React.FC<DeliveryPanelProps> = ({
  flow,
  live,
  projectId,
  onStageSnapshot,
  onExported,
}) => {
  const { showToast } = useToast();
  const step = flowStep(FLOW_TOTAL);
  const [busy, setBusy] = useState(false);
  const [paths, setPaths] = useState<{ internal_path: string; external_path: string } | null>(null);

  const handleExport = useCallback(async () => {
    if (!live || !projectId) {
      showToast("演示模式：交付物导出仅在实时数据模式可用");
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.exportDeliverables(projectId);
      setPaths(r);
      showToast(`双口径导出完成：内部版 ${r.internal_path}；客户版 ${r.external_path}`);
      onExported?.();
    } catch (err: unknown) {
      showToast(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [live, projectId, busy, showToast, onExported]);

  const snapshot = useMemo<StageSnapshot>(
    () => ({
      stage: 7,
      stageLabel: step.title,
      title: `第 ${FLOW_TOTAL}/${FLOW_TOTAL} 步 · ${step.title}`,
      rows: [],
      completeness: null,
      summary: DELIVERY_NOTE,
      summaryLoading: false,
      activeTable: null,
      supplements: [],
      checklist: [],
      anchor: [],
      onRefreshSummary: () => undefined,
      onSupplementChange: () => undefined,
      onAnchorAction: () => undefined,
    }),
    [step.title],
  );

  useEffect(() => {
    onStageSnapshot?.(snapshot);
    return () => onStageSnapshot?.(null);
  }, [snapshot, onStageSnapshot]);

  return (
    <>
      <div className="pnl delivery-panel">
        <div className="pnl-h">
          <div>
            <h2>
              第 {FLOW_TOTAL}/{FLOW_TOTAL} 步 · {step.title}
            </h2>
            <p>{step.goal}；本步由系统按「章节 ← 表映射」装配，不需要模型分析</p>
          </div>
          <div className="pnl-actions">
            <button className="btn primary" type="button" disabled={busy} onClick={() => void handleExport()}>
              {busy ? "生成导出中…" : "生成并导出交付物"}
            </button>
          </div>
        </div>
        <div className="pnl-b flush">
          <FlowCompleteness flow={flow} />
        </div>
        <div className="pnl-b">
          <ol className="delivery-steps">
            {flow.steps.map((s) => (
              <li key={s.id} className={`delivery-step delivery-step--${s.state}`}>
                <span className="delivery-step-no">{s.state === "已完成" ? "✓" : s.id}</span>
                <span className="delivery-step-tt">{s.title}</span>
                <span className="delivery-step-state">{s.state}</span>
                <span className="delivery-step-rows">
                  {s.progress.expectedTables > 0
                    ? `${s.progress.tablesWithData}/${s.progress.expectedTables} 张表 · ${s.progress.rows} 行`
                    : "无信息表"}
                </span>
              </li>
            ))}
          </ol>

          {paths ? (
            <div className="delivery-paths" role="status">
              <div>
                <span className="badge primary">内部版</span>
                <code>{paths.internal_path}</code>
              </div>
              <div>
                <span className="badge primary">客户版</span>
                <code>{paths.external_path}</code>
              </div>
            </div>
          ) : (
            <p className="brief-hint">
              还没导出。生成后这里会给出两份文件的服务端路径（内部调研版 / 对外汇报版）。
            </p>
          )}
        </div>
      </div>
    </>
  );
};
