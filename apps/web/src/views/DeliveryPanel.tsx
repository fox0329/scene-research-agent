/**
 * @scene/web — 最后一步「交付物」面板
 *
 * 交付物步：**正文由模型撰写**（变更表 #112，用户定调「要的是总结，不是罗列」）——模型
 * 读完全部表格后按五章（现状 / 场景与问题 / 方案 / 价值 / 下一步）写出归纳正文，服务端
 * 再用确定性校验把关（章节齐、不给建议、不带内部痕迹），没写成或没过校验的章节自动用
 * 要点版兜底。
 *
 * 变更表 #136（用户定调）：「交付物不再分内部调研版和外部汇报版，直接用外部汇报版生成
 * 一个版本，就叫 XXX解决方案」——面板只剩这一份，不再有口径切换。
 *
 * 中栏显示报告正文；还没生成正式版时显示确定性要点版，并在正文上方提示"当前是要点版"。
 * 「装配原料清单」与导出路径按 G-R9 归右栏。
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

/** 交付物的名字与说明与流程轴第二行共用一个来源（见 step-outputs） */
const REPORT = DELIVERY_OUTPUTS[0]!;
const REPORT_HINT = DELIVERY_OUTPUT_HINT[REPORT.key] ?? REPORT.label;

/** 右栏：装配原料 + 导出结果（中栏只放报告正文，说明性内容归右栏） */
function deliveryNote(
  flow: ApiFlowStatus,
  paths: { path: string } | null,
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
    "## 报告是什么",
    `- ${REPORT.label}：${REPORT_HINT}`,
    "",
    "## 生成前提",
    "- 场景锚（表1-1）以**用户确认过的版本**为准；标「推断」的行不会被写进交付物",
    "",
    "## 导出",
  );
  if (paths) {
    lines.push(`- Markdown：\`${paths.path}\``);
  }
  if (docxPaths.length > 0) {
    for (const p of docxPaths) lines.push(`- Word：\`${p}\``);
  } else if (!paths) {
    lines.push("- 还没导出。点中栏右上「导出到文件」选一个文件夹，写出 Word。");
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
  const [report, setReport] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** true = 模型撰写的正式版；false = 确定性要点版（提示引导生成） */
  const [generated, setGenerated] = useState(false);
  const [paths, setPaths] = useState<{ path: string } | null>(null);
  /** 已导出的 Word 文件（右栏展示） */
  const [docxPaths, setDocxPaths] = useState<string[]>([]);
  const [busyWord, setBusyWord] = useState(false);
  /** 弹不出系统对话框时，回退到让用户手填路径（null = 不显示） */
  const [manualDir, setManualDir] = useState<string | null>(null);
  /** 正在编辑的草稿（变更表 #135）：保存后清空，取消即丢弃 */
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadReports = useCallback(async () => {
    if (!live || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.getDeliverables(projectId);
      setReport(r.solution_report);
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
   * 报告生成 = 一次长跑（几分钟），复用「本步分析」的运行态：
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
    showToast("开始生成报告：模型会读完前面所有表格，按五章写出归纳正文（约几分钟）");
    gen.start();
  }, [live, projectId, showToast, gen]);

  /* 回报此刻显示的交付物：流程轴第二行据此高亮（只有一份，恒定它） */
  useEffect(() => {
    onReportChange?.(REPORT.key);
  }, [onReportChange]);

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
      showToast(`已导出：${r.path}`);
      onExported?.();
    } catch (err: unknown) {
      showToast(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [live, projectId, busy, showToast, onExported]);

  /** 保存中栏改过的正文 → 写回应用（服务端先读后写留档） */
  const handleSave = useCallback(async () => {
    if (!projectId || draft === null) return;
    setSaving(true);
    try {
      const r = await api.saveDeliverable(projectId, draft);
      showToast(r.notice ? `已保存（${r.notice}）` : "已保存");
      setDraft(null);
      await loadReports();
    } catch (err: unknown) {
      showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [projectId, draft, showToast, loadReports]);

  /** 选文件夹（弹系统对话框）→ 把报告按模版写成 Word */
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

  const body = report ?? "";

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
          {draft !== null ? (
            <>
              <button
                className="btn primary"
                type="button"
                disabled={saving || draft.trim() === ""}
                onClick={() => void handleSave()}
              >
                {saving ? "保存中…" : "保存"}
              </button>
              <button className="btn" type="button" disabled={saving} onClick={() => setDraft(null)}>
                取消
              </button>
            </>
          ) : (
            <button
              className="btn"
              type="button"
              disabled={!live || body === ""}
              onClick={() => setDraft(body)}
            >
              编辑
            </button>
          )}
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
            演示模式：交付物由服务端按「章节 ← 表映射」装配，联真模式下这里直接显示报告正文。
          </p>
        ) : loading && report === null ? (
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
                点右上「生成报告」，模型会读完全部表格后按五章写出归纳正文：
                现状 / 场景与问题 / 方案 / 价值 / 下一步。
              </p>
            ) : null}
            {draft !== null ? (
              <textarea
                className="report-editor"
                aria-label="报告正文（Markdown）"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            ) : (
              <div className="md-body">{renderMarkdown(body)}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
