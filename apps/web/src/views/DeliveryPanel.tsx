/**
 * @scene/web — 最后一步「交付物」面板
 *
 * 交付物步：**报告正文由模型撰写**（变更表 #112，用户定调「要的是总结，不是罗列」）——
 * 模型读完全部表格后按六章（场景定义 / 场景认识 / 存在的问题 / 我们的方案 / 能够提供的价值 /
 * 总结）写出归纳正文，服务端再用确定性校验把关（六章齐、不给建议、对外不带内部信息），
 * 没写成或没过校验的章节自动用要点版兜底。
 *
 *  - 内部调研报告：侧重客观与风险（含来源索引与覆盖概览附录）
 *  - 对外汇报材料：侧重痛点、方案、价值（不含内部痕迹）
 *
 * 用户定调（2026-10-06）：「交付物阶段，不要显示一个检查清单，而是和其他阶段一样，
 * 显示具体的内容，具体来说就是两份报告，在中栏显示出来。」
 *
 * 中栏显示报告正文（两份口径的切换在流程轴第二行）；还没生成正式版时显示确定性要点版，
 * 并在正文上方提示"当前是要点版"。「装配原料清单」与导出路径按 G-R9 归右栏。
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FLOW_TOTAL, flowStep } from "@scene/contract";
import { api, generateDeliverablesStream, reconnectDeliverablesStream, type ApiFlowStatus } from "../api";
import { useStageAnalysis } from "../hooks/useStageAnalysis";
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
  docxPaths: string[] = [],
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
    lines.push(`- Markdown 内部版：\`${paths.internal_path}\``, `- Markdown 客户版：\`${paths.external_path}\``);
  }
  if (docxPaths.length > 0) {
    for (const p of docxPaths) lines.push(`- Word：\`${p}\``);
  } else if (!paths) {
    lines.push("- 还没导出。点中栏右上「导出到文件」选一个文件夹，写出两份 Word。");
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
  /** true = 模型撰写的正式版；false = 确定性要点版（提示引导生成） */
  const [generated, setGenerated] = useState(false);
  const [paths, setPaths] = useState<{ internal_path: string; external_path: string } | null>(null);
  /** 已导出的 Word 文件（右栏展示） */
  const [docxPaths, setDocxPaths] = useState<string[]>([]);
  const [busyWord, setBusyWord] = useState(false);
  /** 弹不出系统对话框时，回退到让用户手填路径（null = 不显示） */
  const [manualDir, setManualDir] = useState<string | null>(null);

  const loadReports = useCallback(async () => {
    if (!live || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.getDeliverables(projectId);
      setReports({ internal: r.internal_report, external: r.external_report });
      setGenerated(r.generated);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [live, projectId]);

  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  /**
   * 报告生成 = 一次长跑（两份合计几分钟），复用「本步分析」的运行态：
   * 进度行、时长、断线续连、收尾对账全都一样，只把开流方式换成报告生成。
   */
  const gen = useStageAnalysis({
    projectId: projectId ?? "",
    stage: 6,
    stepId: FLOW_TOTAL,
    openStream: (lastEventId, signal) => {
      const sink = { lastId: lastEventId };
      return lastEventId === null
        ? generateDeliverablesStream(projectId ?? "", sink, signal)
        : reconnectDeliverablesStream(projectId ?? "", lastEventId, sink, signal);
    },
    onSettled: () => void loadReports(),
    onError: (message) => showToast(`生成报告失败：${message}`),
  });

  const handleGenerate = useCallback(() => {
    if (!live || !projectId) {
      showToast("演示模式：报告生成仅在实时数据模式可用");
      return;
    }
    showToast("开始生成报告：模型会读完前面所有表格，按六章写出归纳正文（约几分钟）");
    gen.start();
  }, [live, projectId, showToast, gen]);

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

  /** 选文件夹（弹系统对话框）→ 把两份报告按模版写成 Word */
  const exportWordInto = useCallback(
    async (dir: string) => {
      if (!projectId) return;
      setBusyWord(true);
      try {
        const r = await api.exportDocx(projectId, dir);
        const all = [...r.files, ...r.unchanged];
        setDocxPaths(all);
        const head = r.files.length > 0 ? `Word 已导出到 ${dir}` : `Word 已是最新（未改动）：${dir}`;
        showToast(r.notice ? `${head}；${r.notice}` : head);
        onExported?.();
      } catch (err: unknown) {
        showToast(`导出 Word 失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusyWord(false);
      }
    },
    [projectId, showToast, onExported],
  );

  const handleExportWord = useCallback(async () => {
    if (!live || !projectId) {
      showToast("演示模式：交付物导出仅在实时数据模式可用");
      return;
    }
    if (busyWord) return;
    setBusyWord(true);
    let dir: string | null = null;
    try {
      dir = (await api.pickExportFolder(projectId)).dir;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(message);
      // 取消就不打扰；弹不出对话框（非 macOS / 无权限）才回退到手填路径
      if (!message.includes("取消")) setManualDir((cur) => cur ?? "");
    } finally {
      setBusyWord(false);
    }
    if (dir) await exportWordInto(dir);
  }, [live, projectId, busyWord, showToast, exportWordInto]);

  const snapshot = useMemo<StageSnapshot>(
    () => ({
      stage: 6,
      stageLabel: step.title,
      title: `第 ${FLOW_TOTAL}/${FLOW_TOTAL} 步 · ${step.title}`,
      rows: [],
      completeness: null,
      summary: deliveryNote(flow, paths, docxPaths),
      summaryLoading: false,
      activeTable: null,
      supplements: [],
      anchor: [],
      onRefreshSummary: () => void loadReports(),
      onSupplementChange: () => undefined,
    }),
    [flow, paths, docxPaths, step.title, loadReports],
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
            disabled={gen.running}
            onClick={handleGenerate}
          >
            {gen.running
              ? `撰写中… ${gen.elapsedLabel}`
              : generated
                ? "重新生成报告"
                : "生成报告"}
          </button>
          <button
            className="btn"
            type="button"
            disabled={busyWord}
            onClick={() => void handleExportWord()}
          >
            {busyWord ? "导出中…" : "导出到文件"}
          </button>
          <button className="btn" type="button" disabled={busy} onClick={() => void handleExport()}>
            {busy ? "导出中…" : "导出 Markdown"}
          </button>
        </div>
        {manualDir !== null ? (
          <div className="pnl-actions dir-row">
            <input
              className="settings-input"
              type="text"
              value={manualDir}
              placeholder="文件夹绝对路径，例如 /Users/you/Documents/报告"
              aria-label="导出文件夹路径"
              onChange={(e) => setManualDir(e.target.value)}
            />
            <button
              className="btn"
              type="button"
              disabled={busyWord || manualDir.trim() === ""}
              onClick={() => void exportWordInto(manualDir.trim())}
            >
              导出到该路径
            </button>
            <button className="btn" type="button" onClick={() => setManualDir(null)}>
              收起
            </button>
          </div>
        ) : null}
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
          <>
            {gen.running ? (
              <div className="report-progress" role="status" aria-label="报告生成进度">
                {gen.streamLines.slice(-3).map((line, i) => (
                  <div key={`${i}-${line}`} className="report-progress-line">
                    {line}
                  </div>
                ))}
              </div>
            ) : null}
            {!generated && !gen.running ? (
              <p className="brief-hint">
                当前是「要点版」（系统按章节 ← 表映射直接搬的数据要点，只是一份提纲）。
                点右上「生成报告」，模型会读完全部表格后按六章写出归纳正文——
                内部版侧重客观与风险，对外版侧重痛点、方案与价值。
              </p>
            ) : null}
            <div className="md-body">{renderMarkdown(body)}</div>
          </>
        )}
      </div>
    </div>
  );
};
