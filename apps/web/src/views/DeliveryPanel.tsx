/**
 * @scene/web — 最后一步「交付物」面板
 *
 * 组装步：不需要模型分析，系统按「章节 ← 表映射」把前面各步的产出装配成两份文件：
 *  - 内部调研版（含来源、证据级、缺口）
 *  - 对外汇报版（只保留可对外的事实）
 *
 * 用户定调（2026-10-06）：「交付物阶段，不要显示一个检查清单，而是和其他阶段一样，
 * 显示具体的内容，具体来说就是两份报告，在中栏显示出来。」
 *
 * 于是中栏与其它步同形：**两行粘性表头（阶段名称 + 两份报告 chip）+ 正文**。
 * 装配是确定性的（章节 ← 表映射，不跑模型），所以正文直接展示、不必先点导出；
 * 「装配原料清单」（各步状态与产出规模）与导出路径按 G-R9（中栏说结果、来源归右栏）归右栏。
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FLOW_TOTAL, flowStep } from "@scene/contract";
import { api, type ApiFlowStatus } from "../api";
import { renderMarkdown } from "../components/StageRightPanel";
import { DELIVERY_OUTPUTS, DELIVERY_OUTPUT_HINT } from "../components/step-outputs";
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
  /** 流程轴第二行点了某个报告：`id` 变化时套用 */
  pick?: { id: number; code: string | null };
  /** 回报此刻显示的报告 → 流程轴第二行据此高亮 */
  onReportChange?: (key: string) => void;
}

/** 两份口径的名字与说明与流程轴第二行共用一个来源（见 step-outputs） */
const REPORTS = DELIVERY_OUTPUTS.map((o) => ({
  key: o.key as "internal" | "external",
  label: o.label,
  hint: DELIVERY_OUTPUT_HINT[o.key] ?? o.label,
}));

type ReportKey = (typeof REPORTS)[number]["key"];

/** 右栏：装配原料 + 导出结果（中栏只放报告正文，说明性内容归右栏） */
function deliveryNote(
  flow: ApiFlowStatus,
  paths: { internal_path: string; external_path: string } | null,
): string {
  const lines = [
    "## 装配原料",
    `前面 ${FLOW_TOTAL - 1} 步的步骤总结（每步一份）是装配原料；没有产出的步骤会在交付物里标「无信息」。`,
    "",
  ];
  for (const s of flow.steps.slice(0, FLOW_TOTAL - 1)) {
    lines.push(
      `- 第 ${s.id} 步 ${s.title}：${s.state}　${
        s.progress.expectedTables > 0
          ? `${s.progress.tablesWithData}/${s.progress.expectedTables} 张表 · ${s.progress.rows} 行`
          : "无信息表"
      }`,
    );
  }
  lines.push(
    "",
    "## 两份口径",
    "- 内部调研版：完整信息 + 来源与证据级 + 信息缺口 + 「不做什么」边界声明",
    "- 对外汇报版：只保留可对外的事实与结论，含未确认标记的内容会被剔除",
    "",
    "## 生成前提",
    "- 场景锚（表1-1）以**用户确认过的版本**为准；标「推断」的行不会被写进对外版",
    "",
    "## 导出",
  );
  if (paths) {
    lines.push(`- 内部版：\`${paths.internal_path}\``, `- 客户版：\`${paths.external_path}\``);
  } else {
    lines.push("- 还没导出。点中栏右上「生成并导出交付物」写出两份文件。");
  }
  lines.push("", "> 交付物只陈述信息与缺口，不含建议或判断——判断由使用者自己做。");
  return lines.join("\n");
}

export const DeliveryPanel: React.FC<DeliveryPanelProps> = ({
  flow,
  live,
  projectId,
  onStageSnapshot,
  onExported,
  pick,
  onReportChange,
}) => {
  const { showToast } = useToast();
  const step = flowStep(FLOW_TOTAL);
  const [tab, setTab] = useState<ReportKey>("internal");
  const [reports, setReports] = useState<{ internal: string; external: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paths, setPaths] = useState<{ internal_path: string; external_path: string } | null>(null);

  const loadReports = useCallback(async () => {
    if (!live || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.getDeliverables(projectId);
      setReports({ internal: r.internal_report, external: r.external_report });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [live, projectId]);

  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  /** 流程轴第二行点了某份报告：只在 id 变化时套用 */
  const pickId = pick?.id;
  useEffect(() => {
    if (pick?.code === "internal" || pick?.code === "external") setTab(pick.code);
  }, [pickId]); // eslint-disable-line react-hooks/exhaustive-deps

  /* 回报此刻显示的报告：流程轴第二行据此高亮 */
  useEffect(() => {
    onReportChange?.(tab);
  }, [tab, onReportChange]);

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
      stage: 6,
      stageLabel: step.title,
      title: `第 ${FLOW_TOTAL}/${FLOW_TOTAL} 步 · ${step.title}`,
      rows: [],
      completeness: null,
      summary: deliveryNote(flow, paths),
      summaryLoading: false,
      activeTable: null,
      supplements: [],
      anchor: [],
      onRefreshSummary: () => void loadReports(),
      onSupplementChange: () => undefined,
    }),
    [flow, paths, step.title, loadReports],
  );

  useEffect(() => {
    onStageSnapshot?.(snapshot);
    return () => onStageSnapshot?.(null);
  }, [snapshot, onStageSnapshot]);

  const body = reports ? (tab === "internal" ? reports.internal : reports.external) : "";

  return (
    <div className="pnl">
      {/* 动作行保留；两份报告的选择在流程轴第二行（用户定调 2026-10-06：输出物挂到阶段名下面） */}
      <div className="pnl-h">
        <div className="pnl-actions">
          <button
            className="btn primary"
            type="button"
            disabled={busy}
            onClick={() => void handleExport()}
          >
            {busy ? "生成导出中…" : "生成并导出交付物"}
          </button>
        </div>
      </div>

      <div className="pnl-b">
        {!live ? (
          <p className="brief-hint">
            演示模式：交付物由服务端按「章节 ← 表映射」装配，联真模式下这里直接显示两份报告正文。
          </p>
        ) : loading && !reports ? (
          <div className="loading-strip" role="status" aria-label="装配中" />
        ) : error ? (
          <div className="empty-state">
            <div className="empty-state-title">交付物装配失败</div>
            <div className="empty-state-desc">{error}</div>
            <button className="btn" type="button" onClick={() => void loadReports()}>
              重试
            </button>
          </div>
        ) : (
          <div className="md-body">{renderMarkdown(body)}</div>
        )}
      </div>
    </div>
  );
};
