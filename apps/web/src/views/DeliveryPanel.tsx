/**
 * @scene/web — 最后一步「交付物」面板
 *
 * 交付物步：**正文由模型撰写**（变更表 #112，用户定调「要的是总结，不是罗列」）——模型
 * 读完全部表格后按各口径的章节骨架写出归纳正文，服务端再用确定性校验把关（章节齐、不给
 * 建议、不带内部痕迹），没写成或没过校验的章节自动用要点版兜底。
 *
 * 变更表 #136（用户定调）：「交付物不再分内部调研版和外部汇报版，直接用外部汇报版生成
 * 一个版本，就叫 XXX解决方案」。
 * 变更表 #137：交付物是**两份并列**——「<场景>解决方案」与「<场景>建设工作方案」。
 * 中栏一次只显示一份：看哪份由**流程轴第二行左边的两个 chip** 决定（`tab`），编辑与保存
 * 都只作用于当前这一份（切份即丢弃未保存的草稿，绝不把 A 的草稿写到 B）。
 *
 * 变更表 #140（用户定调）：「重新生成报告 / 编辑 / 导出这几个按钮移到上面去」「解决方案 和
 * 工作方案放左边」——两份交付物的 chip 靠左、本步动作靠右合成一行（原来挂在流程轴第二行，
 * #148 又搬了回去）。
 *
 * 变更表 #148（用户两次纠正，**#147 作废**）：「不是把交付物放下来　是把解决方案　工作方案　
 * 重新生成报告　编辑　导出这些全部移上去　比如现在方案实现阶段所有的输出表格的名称不就直接在
 * 方案实现下面一行吗？」——这两组控件搬回**流程轴第二行**（`.flow-outputs`，与别的步
 * 显示表名的是同一行）：它在中栏滚动容器 `.ws` 外面、通栏，滚正文时始终可见。
 * **状态仍留在本组件**，只是用 `createPortal` 把渲染位置搬到 `#delivery-row-slot`；
 * 容器不存在时回退为就地渲染（演示模式等，保证不炸）。中栏不再有这一行，也没有「交付物」标题行。
 *
 * 中栏显示报告正文；还没生成正式版时显示确定性要点版，并在正文上方提示"当前是要点版"。
 * 「装配原料清单」与导出路径按 G-R9 归右栏。
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { FLOW_TOTAL } from "@scene/contract";
import {
  api,
  exportPptProgressStream,
  generateDeliverablesStream,
  reconnectDeliverablesStream,
  type ApiDeliverables,
  type ApiFlowStatus,
  type DeliverableKind,
} from "../api";
import { useStageAnalysis } from "../hooks/useStageAnalysis";
import { renderMarkdown } from "../components/StageRightPanel";
import { forgetExportDir, loadExportDir, saveExportDir } from "../components/export-dir-memory";
import { DELIVERY_OUTPUTS, DELIVERY_OUTPUT_HINT } from "../components/step-outputs";
import { DELIVERY_ROW_ID } from "../components/FlowRail";
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
  /** 外部一次性选择某个交付物 chip：`id` 变化时切到 `code` 那一份 */
  pick?: { id: number; code: string | null };
  /** 回报此刻看的是哪一份（中栏顶部高亮；`shownOutput` 也据此更新） */
  onReportChange?: (key: string) => void;
}

/** 默认打开的那一份 */
const DEFAULT_TAB: DeliverableKind = "solution";

/** 交付物的名字与说明与流程轴第二行共用一个来源（见 step-outputs） */
function deliveryLabel(key: DeliverableKind): string {
  return DELIVERY_OUTPUTS.find((o) => o.key === key)?.label ?? key;
}

function deliveryHint(key: DeliverableKind): string {
  return DELIVERY_OUTPUT_HINT[key] ?? deliveryLabel(key);
}

/** 流程轴 chip 的 key → 交付物口径；不是这两份（如表号）就不该切这里的份 */
function asDeliverableKind(code: string | null | undefined): DeliverableKind | null {
  return code === "solution" || code === "construction" ? code : null;
}

/**
 * 右栏：装配原料 + 导出结果（中栏只放正文，说明性内容归右栏）
 *
 * 变更表 #149（用户定调「没有价值的删除」）：这里只留两件对用户有用的事——
 *  ① 装配原料的**统计**与"哪几步没产出（报告里会标「无信息」）"：前者是产出的规模，
 *     后者是用户需要知道的缺口；逐步的步名 + 状态与流程轴第二次重复，删
 *  ② 已导出文件的**绝对路径**（事实）
 * 删掉：两份交付物的名字与说明（流程轴 chip 的 label/title 已说）、生成前提
 * （引用的"场景锚以用户确认过的版本为准"随 v1.19 的确认动作一起失效，留着是误导）、
 * 导出文件名规则（用户点导出自然看到结果，规则是噪声）与末尾口号。
 */
function deliveryNote(
  flow: ApiFlowStatus,
  paths: { files: string[] } | null,
  docxPaths: string[] = [],
  pptPaths: string[] = [],
): string {
  // 装配原料 = 前面各步的步骤总结；没有任何产出的步骤会在交付物里标「无信息」
  const sources = flow.steps.slice(0, FLOW_TOTAL - 1);
  const hasTables = sources.filter((s) => s.progress.expectedTables > 0);
  const done = hasTables.filter((s) => s.progress.tablesWithData > 0);
  const tablesWithData = hasTables.reduce((n, s) => n + s.progress.tablesWithData, 0);
  const tablesTotal = hasTables.reduce((n, s) => n + s.progress.expectedTables, 0);
  const rowsTotal = hasTables.reduce((n, s) => n + s.progress.rows, 0);
  const empty = sources.filter(
    (s) => s.progress.expectedTables === 0 || s.progress.tablesWithData === 0,
  );

  const lines = [
    "## 装配原料",
    `前面 ${FLOW_TOTAL - 1} 步的步骤总结（每步一份）是装配原料。`,
    `- 已产出：${done.length}/${sources.length} 步 · ${tablesWithData}/${tablesTotal} 张表 · ${rowsTotal} 行`,
    empty.length > 0
      ? `- 没有产出的步骤会在交付物里标「无信息」：${empty.map((s) => `第 ${s.id} 步 ${s.title}`).join("、")}`
      : "- 前面各步都有产出",
    "",
    "## 导出",
  ];
  const md = paths?.files ?? [];
  for (const p of md) lines.push(`- Markdown：\`${p}\``);
  for (const p of docxPaths) lines.push(`- Word：\`${p}\``);
  for (const p of pptPaths) lines.push(`- PPT：\`${p}\``);
  if (md.length === 0 && docxPaths.length === 0 && pptPaths.length === 0) {
    lines.push("- 还没有导出过文件");
  }
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
  /** 当前在看哪一份（变更表 #137）：两份都是正式交付物，中栏一次只显示一份 */
  const [tab, setTab] = useState<DeliverableKind>(DEFAULT_TAB);
  /** 两份一起取回：切份只换显示，不再发请求 */
  const [reports, setReports] = useState<ApiDeliverables["reports"] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 已导出的 Markdown 文件（右栏展示） */
  const [mdPaths, setMdPaths] = useState<{ files: string[] } | null>(null);
  /** 已导出的 Word 文件（右栏展示） */
  const [docxPaths, setDocxPaths] = useState<string[]>([]);
  const [busyWord, setBusyWord] = useState(false);
  /** 已导出的 PPT 文件（右栏展示；导出失败也不清空——已有产物不该被一次失败抹掉） */
  const [pptPaths, setPptPaths] = useState<string[]>([]);
  const [busyPpt, setBusyPpt] = useState(false);
  /** PPT 导出的当前阶段文案（进度通道推来的，直接顶在按钮上） */
  const [pptPhase, setPptPhase] = useState<string | null>(null);
  /** 手动填路径那一行是给哪次导出用的（Word / PPT 共用一套选目录） */
  const [dirPurpose, setDirPurpose] = useState<"word" | "ppt">("word");
  /** 弹不出系统对话框时，回退到让用户手填路径（null = 不显示） */
  const [manualDir, setManualDir] = useState<string | null>(null);
  /** 正在编辑的草稿（变更表 #135）：保存后清空，切份或取消即丢弃 */
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * 流程轴第二行里那个容器（变更表 #148）：两组控件 portal 到那儿去
   *
   * 用 layout effect 取（赶在首帧之前，免得先在中栏闪一下再跳上去）；容器不存在
   * （演示模式 / 流程轴没画这一行）时保持 null → 就地渲染，保证不炸。
   */
  const [railRow, setRailRow] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setRailRow(document.getElementById(DELIVERY_ROW_ID));
  }, []);

  const loadReports = useCallback(async () => {
    if (!live || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.getDeliverables(projectId);
      setReports(r.reports);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [live, projectId]);

  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  const current = reports?.[tab] ?? null;
  /** true = 模型撰写的正式版；false = 确定性要点版（提示引导生成） */
  const generated = current?.generated ?? false;
  const body = current?.markdown ?? "";
  const label = deliveryLabel(tab);

  /**
   * 外部一次性选择（`pick`）→ 切到那一份
   *
   * **切份即丢弃未保存的草稿**：草稿属于上一份，留着会被下一次保存写到另一份上去。
   * 点的是当前这一份则不动草稿（那不算切换）。
   */
  useEffect(() => {
    const next = asDeliverableKind(pick?.code);
    if (next === null || next === tab) return;
    setDraft(null);
    setTab(next);
  }, [pick, tab]);

  /* 回报此刻看的是哪一份（中栏顶部 chip 自己就是高亮来源，这里只为外部对账） */
  useEffect(() => {
    onReportChange?.(tab);
  }, [onReportChange, tab]);

  /** 中栏顶部点交付物 chip：与外部 `pick` 同一条规则——切份丢弃未保存的草稿 */
  const handlePickReport = useCallback(
    (next: DeliverableKind) => {
      if (next === tab) return;
      setDraft(null);
      setTab(next);
    },
    [tab],
  );

  /**
   * 报告生成 = 一次长跑（几分钟），复用「本步分析」的运行态：
   * 进度行、时长、断线续连、收尾对账全都一样，只把开流方式换成报告生成。
   * 一趟生成**两份**，所以不分当前看的是哪份。
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
    showToast(
      `开始生成两份交付物：模型会读完前面所有表格，一次写出「${deliveryLabel("solution")}」与「${deliveryLabel("construction")}」（约几分钟）`,
    );
    gen.start();
  }, [live, projectId, showToast, gen]);

  const handleExport = useCallback(async () => {
    if (!live || !projectId) {
      showToast("演示模式：交付物导出仅在实时数据模式可用");
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.exportDeliverables(projectId);
      setMdPaths({ files: r.files });
      const head = `已导出 Markdown：${r.files.join("、")}`;
      showToast(r.notice ? `${head}；${r.notice}` : head);
      onExported?.();
    } catch (err: unknown) {
      showToast(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [live, projectId, busy, showToast, onExported]);

  /** 保存中栏改过的正文 → 写回**当前这一份**（服务端先读后写留档） */
  const handleSave = useCallback(async () => {
    if (!projectId || draft === null) return;
    setSaving(true);
    try {
      const r = await api.saveDeliverable(projectId, tab, draft);
      const head = `已保存「${label}」`;
      showToast(r.notice ? `${head}；${r.notice}` : head);
      setDraft(null);
      await loadReports();
    } catch (err: unknown) {
      showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [projectId, tab, label, draft, showToast, loadReports]);

  /** 选文件夹（弹系统对话框）→ 把两份报告按模版写成 Word */
  const exportWordInto = useCallback(
    async (dir: string) => {
      if (!projectId) return;
      setBusyWord(true);
      try {
        const r = await api.exportDocx(projectId, dir);
        const all = [...r.files, ...r.unchanged];
        setDocxPaths(all);
        // 变更表 #151：真的写出过文件才记这个目录（抛错与取消都走不到这里）
        if (all.length > 0) saveExportDir(projectId, dir);
        // 一次两份：toast 回显写出的文件路径（全都没改动时说清是"已是最新"）
        const head =
          r.files.length > 0
            ? `Word 已导出：${all.join("、")}`
            : `Word 已是最新（未改动）：${all.join("、")}`;
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

  /**
   * 把当前这一份交付物排成 PPT（变更表 #141）
   *
   * 比 Word 慢（多一次模型调用 + 逐页渲染 + 转档，1–3 分钟），所以**先订阅进度、再发导出**：
   * 按钮上直接显示阶段文案（正在梳理大纲 / 渲染第 N 页 / 正在转成 PPTX），
   * 失败或 notice 时原因原样提示、按钮恢复可点，且**不清空已有产物**。
   */
  const exportPptInto = useCallback(
    async (dir: string) => {
      if (!projectId) return;
      const run = `ppt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const abort = new AbortController();
      setBusyPpt(true);
      setPptPhase(null);
      const progress = (async () => {
        try {
          for await (const event of exportPptProgressStream(projectId, run, abort.signal)) {
            const message = typeof event.message === "string" ? event.message : "";
            if (message !== "") setPptPhase(message.replace(/^PPT：/, ""));
          }
        } catch {
          // 进度断了不影响导出本身：结果仍以 POST 的返回为准
        }
      })();
      try {
        const r = await api.exportPptx(projectId, dir, tab, run);
        const all = [...r.files, ...r.unchanged];
        if (all.length > 0) setPptPaths(all);
        // 变更表 #151：PPT 导出失败也只回 notice（不抛错），所以按"有没有产物"记目录——
        // `all.length === 0`（PPT 未导出）不算成功，不许覆盖上次的目录
        if (all.length > 0) saveExportDir(projectId, dir);
        const head =
          all.length === 0
            ? "PPT 未导出"
            : r.files.length > 0
              ? `PPT 已导出：${all.join("、")}`
              : `PPT 已是最新（未改动）：${all.join("、")}`;
        showToast(r.notice ? `${head}；${r.notice}` : head);
        onExported?.();
      } catch (err: unknown) {
        showToast(`导出 PPT 失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        abort.abort();
        setBusyPpt(false);
        setPptPhase(null);
      }
      void progress;
    },
    [projectId, tab, showToast, onExported],
  );

  /**
   * 选文件夹（弹系统对话框）→ 按用途落到 Word / PPT 两条导出链
   *
   * 两条链共用同一套「系统对话框 + 弹不出时手填路径」；取消不打扰，弹不出对话框才回退。
   */
  const pickDirThen = useCallback(
    async (purpose: "word" | "ppt") => {
      if (!live || !projectId) {
        showToast("演示模式：交付物导出仅在实时数据模式可用");
        return;
      }
      if (busyWord || busyPpt) return;
      setDirPurpose(purpose);
      const setBusy = purpose === "ppt" ? setBusyPpt : setBusyWord;
      setBusy(true);
      let dir: string | null = null;
      try {
        // 变更表 #151：上次成功导出的目录作为系统对话框的默认起点（服务端仍会再校验一遍）
        dir = (await api.pickExportFolder(projectId, loadExportDir(projectId) || undefined)).dir;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        showToast(message);
        // 取消就不打扰；弹不出对话框（非 macOS / 无权限）才回退到手填路径——手填那行预填上次的目录
        if (!message.includes("取消")) setManualDir((cur) => cur ?? loadExportDir(projectId));
      } finally {
        setBusy(false);
      }
      if (dir) await (purpose === "ppt" ? exportPptInto(dir) : exportWordInto(dir));
    },
    [live, projectId, busyWord, busyPpt, showToast, exportPptInto, exportWordInto],
  );

  /** 手填路径那一行：按当初点的是哪次导出落到对应的链上 */
  const exportIntoManualDir = useCallback(() => {
    const dir = manualDir?.trim() ?? "";
    if (dir === "") return;
    void (dirPurpose === "ppt" ? exportPptInto(dir) : exportWordInto(dir));
  }, [manualDir, dirPurpose, exportPptInto, exportWordInto]);

  const snapshot = useMemo<StageSnapshot>(
    () => ({
      rows: [],
      completeness: null,
      summary: deliveryNote(flow, mdPaths, docxPaths, pptPaths),
      summaryLoading: false,
      activeTable: null,
      // 交付物步没有信息表，也就没有可联动的行（右栏只有阶段总结一个 Tab）
      activeRowId: null,
      activeRowOrigin: null,
      supplements: [],
      onRefreshSummary: () => void loadReports(),
      onSupplementChange: () => undefined,
      onRowFocus: () => undefined,
    }),
    [flow, mdPaths, docxPaths, pptPaths, loadReports],
  );

  useEffect(() => {
    onStageSnapshot?.(snapshot);
    return () => onStageSnapshot?.(null);
  }, [snapshot, onStageSnapshot]);

  /**
   * 两组控件（变更表 #148）：左边两份交付物的 chip，右边本步动作
   *
   * 抽成变量是因为它有两个落点——正常情况 portal 到流程轴第二行，容器不存在时就地渲染。
   * 状态与 handler 全在本组件，渲染位置搬家不改一行行为。
   */
  const reportChips = (
    <div className="pnl-actions" role="group" aria-label="交付物">
      {/* 两份交付物：放行首（用户定调「解决方案 和 工作方案放左边」）。名字取契约
          `REPORT_KIND_LABEL`（与报告标题、导出文件名同源），`active` 高亮当前这一份，
          点一下切份（切份丢弃草稿） */}
      {DELIVERY_OUTPUTS.map((o) => (
        <button
          key={o.key}
          type="button"
          className={`chip${tab === o.key ? " active" : ""}`}
          title={deliveryHint(o.key)}
          aria-pressed={tab === o.key}
          onClick={() => handlePickReport(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );

  const stepActions = (
    <div className="pnl-actions pnl-actions--end">
      {/* 用户定调 2026-10-09：进行中的按钮**只留一个短标签**，不要把进度/耗时写进标签——
          标签一变宽就把按钮挤换行。详细进度放 title（悬停可见），信息不丢、宽度不变 */}
      <button
        className="btn primary"
        type="button"
        disabled={gen.running}
        title={gen.running ? `正在撰写报告…已用 ${gen.elapsedLabel}` : undefined}
        onClick={handleGenerate}
      >
        {gen.running
          ? "撰写中"
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
            {saving ? "保存中" : "保存"}
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
        disabled={busyWord || busyPpt}
        title={busyWord ? "正在导出 Word 文档…" : undefined}
        onClick={() => void pickDirThen("word")}
      >
        {busyWord ? "导出中" : "导出Word文档"}
      </button>
      {/* PPT（变更表 #141）：点一下全自动排中间页（5–10 页、无封面尾页）；等待期显示阶段文案 */}
      <button
        className="btn"
        type="button"
        disabled={busyPpt || busyWord}
        title={pptPhase ?? "按 B 站蓝色模版排中间页：5–10 页，不要封面与尾页，突出问题、方案与价值"}
        onClick={() => void pickDirThen("ppt")}
      >
        {busyPpt ? "导出中" : "导出PPT文档"}
      </button>
      <button
        className="btn"
        type="button"
        disabled={busy}
        title={busy ? "正在导出 Markdown…" : undefined}
        onClick={() => void handleExport()}
      >
        {busy ? "导出中" : "导出 Markdown"}
      </button>
    </div>
  );

  return (
    <div className="pnl">
      {/* 变更表 #148（用户两次纠正，**#147 作废**）：两份交付物的 chip 与本步动作渲染到
          **流程轴第二行**（别的步显示表名的那一行，`.flow-outputs`）——它在中栏滚动容器
          `.ws` 外面、通栏，滚正文时始终可见，这正是用户要的"移上去"。
          状态仍在本组件，只是渲染位置搬过去（createPortal）；容器不存在时就地渲染兜底。
          #147 加的「交付物」标题行（`.pnl-h--stack` + `<h2>交付物</h2>` + `.pnl-h-row`）一并撤掉 */}
      {railRow ? (
        createPortal(
          <>
            {reportChips}
            {stepActions}
          </>,
          railRow,
        )
      ) : (
        <div className="pnl-h flow-outputs">
          {reportChips}
          {stepActions}
        </div>
      )}

      {/* 手填导出目录那一行（变更表 #133）：只在弹不出系统对话框、用户手动导出时出现，
          属于面板局部，留在中栏。变更表 #151：打开时预填上次成功导出的目录（按项目记） */}
      {manualDir !== null ? (
        <div className="pnl-h">
          <div className="pnl-actions dir-row">
            <input
              className="settings-input"
              type="text"
              value={manualDir}
              placeholder="文件夹绝对路径，例如 /Users/you/Documents/报告"
              aria-label="导出文件夹路径"
              onChange={(e) => {
                const next = e.target.value;
                setManualDir(next);
                // 用户自己把这一行清空 = 以用户为准：忘掉记忆，下次不再拿旧值兜他
                if (next.trim() === "") forgetExportDir(projectId);
              }}
            />
            <button
              className="btn"
              type="button"
              disabled={busyWord || busyPpt || manualDir.trim() === ""}
              onClick={exportIntoManualDir}
            >
              导出到该路径
            </button>
            <button className="btn" type="button" onClick={() => setManualDir(null)}>
              收起
            </button>
          </div>
        </div>
      ) : null}

      <div className="pnl-b">
        {!live ? (
          <p className="brief-hint">
            演示模式：两份交付物（解决方案 / 建设工作方案）由服务端按「章节 ← 表映射」装配，
            联真模式下这里直接显示报告正文。
          </p>
        ) : loading && reports === null ? (
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
                当前是「{label}」的「要点版」（系统按章节 ← 表映射直接搬的数据要点，只是一份提纲）。
                点上方「生成报告」，模型会读完全部表格后一次写出两份交付物的归纳正文。
              </p>
            ) : null}
            {draft !== null ? (
              <textarea
                className="report-editor"
                aria-label={`${label}正文（Markdown）`}
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
