import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FLOW_TOTAL,
  STAGE_DEFS,
  flowStep,
  supplementColumns,
  tableDef,
  tablesOfStage,
  type InfoStageId,
} from "@scene/contract";
import {
  api,
  advanceStageStream,
  type ApiAnchorRow,
  type ApiStagePanel,
  type ApiStageRow,
} from "../api";
import { useAsync } from "../hooks/useAsync";
import { SchemaTable, tableBlocks, tableCategories } from "../components/SchemaTable";
import { AnchorFoldPanel } from "../components/AnchorFoldPanel";
import { anchorSummary } from "../components/definition-progress";
import {
  asSourceType,
  type StageSnapshot,
  type SupplementTable,
} from "../components/stage-snapshot";
import { useToast } from "../components/Toast";

/**
 * 阶段面板（联真，v1.4 信息版）
 *
 * 中栏（本组件的职责）——**只显示重要信息表格**：
 *  - 阶段头 + 信息完整度状态行（只说明缺口，不给判定）
 *  - **表1-1 场景锚常驻**（全链唯一场景定义，不随阶段切换消失）
 *  - 阶段表清单（chips 切换）+ SchemaTable（列来自注册表，默认无横向滚动）
 *  - 单元格编辑落库、阶段分析 SSE 进度
 *
 * 右栏（由 App 渲染 StageRightPanel）——补充说明 + 确认清单 + 阶段总结：
 *  本组件把 `StageSnapshot` 冒泡给父级，右栏不重复计算。
 */

interface RealStagePanelProps {
  projectId: string;
  stage: number;
  stageLabel: string;
  onChanged?: () => void;
  /** 右栏数据面（null=加载中/不可用） */
  onStageSnapshot?: (snap: StageSnapshot | null) => void;
  /** 本步表集（流程定义给出，如 `flowStep(4).tables`）；缺省 = 该阶段全部表 */
  tables?: readonly string[];
  /** 流程步骤号：头部与右栏显示「第 n/FLOW_TOTAL 步」，推进按钮也按流程步走 */
  stepId?: number;
  /** 本步是否就绪（与流程轴同一判定，避免两处按钮一个可点一个不可点） */
  ready?: boolean;
  readyHint?: string;
  /** 完成本步后通知父级重取 /flow（流程状态变化的唯一出口） */
  onFlowChanged?: () => void;
}

export const RealStagePanel: React.FC<RealStagePanelProps> = ({
  projectId,
  stage,
  stageLabel,
  onChanged,
  onStageSnapshot,
  tables,
  stepId,
  ready,
  readyHint,
  onFlowChanged,
}) => {
  // 右栏（完整度 / 补充说明 / 阶段总结）一律带上本步：**只针对当前步骤**
  const { status, data, error, reload } = useAsync<ApiStagePanel>(
    () => api.stagePanel(projectId, stage, stepId),
    [projectId, stage, stepId],
  );
  const { showToast } = useToast();

  /** 完成本步并前进：**导航动作**，不是判断——信息不齐备也不阻断（缺口只在右栏提示） */
  const completeStep = useCallback(async () => {
    try {
      if (stepId !== undefined) {
        const next = await api.completeFlowStep(projectId, stepId);
        showToast(`已完成第 ${stepId} 步，进入第 ${next.currentStep} 步`);
        onFlowChanged?.();
        return;
      }
      const project = await api.decide(projectId, stage, "继续");
      showToast(`已进入阶段 ${project.current_stage}（信息缺口可在右栏随时回看）`);
      onChanged?.();
    } catch (err: unknown) {
      showToast(`推进失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [projectId, stage, stepId, showToast, onChanged, onFlowChanged]);

  const [streamLines, setStreamLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);

  /* 单元格编辑：本地即时更新 + 落库 */
  const [patched, setPatched] = useState<Record<string, ApiStageRow>>({});
  const rows = useMemo(() => (data ? data.rows.map((r) => patched[r.id] ?? r) : []), [data, patched]);

  /* 当前选中的表（表1-1 由常驻区负责，不参与切换）；传了 tables 时只渲染本步表集 */
  const stageTables = useMemo(() => {
    const code = (stage === 8 ? 7 : stage) as InfoStageId;
    const all = tablesOfStage(code).filter((t) => t.code !== "表1-1");
    return tables ? all.filter((t) => tables.includes(t.code)) : all;
  }, [stage, tables]);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  useEffect(() => {
    if (activeTable && stageTables.some((t) => t.code === activeTable)) return;
    const withData = stageTables.find((t) => rows.some((r) => r.table_code === t.code));
    setActiveTable((withData ?? stageTables[0])?.code ?? null);
  }, [stageTables, rows, activeTable]);

  /* 子块 / payload 类别选择 */
  const [block, setBlock] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const blocks = useMemo(() => (activeTable ? tableBlocks(activeTable) : []), [activeTable]);
  const categories = useMemo(
    () => (activeTable ? tableCategories(activeTable) : []),
    [activeTable],
  );
  useEffect(() => {
    setBlock(blocks[0] ?? null);
    setCategory(categories[0] ?? null);
  }, [blocks, categories]);

  /* 场景锚（表1-1）：常驻，独立于阶段表 */
  const [anchor, setAnchor] = useState<ApiAnchorRow[]>([]);
  useEffect(() => {
    let alive = true;
    void api
      .getBrief(projectId)
      .then((r) => {
        if (alive) setAnchor(r.anchor);
      })
      .catch(() => {
        /* 诉求未填时静默：中栏仍可用 */
      });
    return () => {
      alive = false;
    };
  }, [projectId, stage]);

  /* 阶段总结 */
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const loadSummary = useCallback(
    async (refresh = false) => {
      setSummaryLoading(true);
      try {
        const r = await api.stageSummary(projectId, stage, refresh, stepId);
        setSummary(r.markdown);
      } catch {
        setSummary(null);
      } finally {
        setSummaryLoading(false);
      }
    },
    [projectId, stage, stepId],
  );
  useEffect(() => {
    void loadSummary(false);
  }, [loadSummary]);

  const handleCellChange = useCallback(
    async (rowId: string, cell: string, value: string) => {
      const row = rows.find((r) => r.id === rowId);
      if (row && String(row.row[cell] ?? "") === value) return;
      setPatched((prev) => {
        const base = prev[rowId] ?? rows.find((r) => r.id === rowId);
        if (!base) return prev;
        return { ...prev, [rowId]: { ...base, row: { ...base.row, [cell]: value } } };
      });
      try {
        const updated = await api.patchStageCell(projectId, rowId, cell, value);
        setPatched((prev) => ({ ...prev, [rowId]: updated }));
        onChanged?.();
      } catch (err: unknown) {
        showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [projectId, rows, onChanged, showToast],
  );

  /* 右栏数据面：补充列（当前表的右栏补充列） */
  const snapshot = useMemo<StageSnapshot | null>(() => {
    if (!data) return null;

    const supplements: SupplementTable[] = [];
    if (activeTable) {
      const def = tableDef(activeTable);
      const cols = def ? supplementColumns(def, category ?? undefined) : [];
      const tRows = rows.filter((r) => r.table_code === activeTable);
      if (def && cols.length > 0 && tRows.length > 0) {
        supplements.push({
          tableCode: def.code,
          tableName: def.name,
          columns: cols.map((c) => ({ key: c.key, label: c.label })),
          rows: tRows.map((r) => ({
            id: r.id,
            row: r.row,
            sourceType: r.source_type,
            source: r.source,
            evidenceLevel: r.evidence_level,
            authority: r.source_authority,
          })),
        });
      }
    }

    /** 中栏表1-1 折叠态摘要 */
    const anchorStats = anchorSummary(anchor);

    return {
      stage,
      stageLabel,
      ...(stepId !== undefined
        ? { title: `第 ${stepId}/${FLOW_TOTAL} 步 · ${flowStep(stepId).title}` }
        : {}),
      rows,
      completeness: data.completeness ?? null,
      summary,
      summaryLoading,
      activeTable,
      supplements,
      anchor,
      anchorSummary: anchorStats,
      onRefreshSummary: () => void loadSummary(true),
      onSupplementChange: (rowId, cell, value) => void handleCellChange(rowId, cell, value),
    };
  }, [
    data,
    rows,
    anchor,
    summary,
    summaryLoading,
    activeTable,
    category,
    stage,
    stageLabel,
    stepId,
    loadSummary,
    handleCellChange,
  ]);

  useEffect(() => {
    onStageSnapshot?.(snapshot);
    return () => onStageSnapshot?.(null);
  }, [snapshot, onStageSnapshot]);

  const startAnalysis = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setStreamLines(["已发起阶段分析…"]);
    try {
      for await (const ev of advanceStageStream(projectId, stage, stepId)) {
        if (ev.type === "progress") {
          setStreamLines((prev) => [...prev, String(ev.text ?? "分析中…")].slice(-8));
        } else if (ev.type === "error") {
          setStreamLines((prev) => [...prev, `【错误】${String(ev.message ?? "")}`].slice(-8));
        } else if (ev.type === "done") {
          setStreamLines((prev) => [...prev, "【完成】分析结果已落库，右栏已生成阶段总结"].slice(-8));
          reload();
          void loadSummary(true);
          void api
            .getBrief(projectId)
            .then((r) => setAnchor(r.anchor))
            .catch(() => undefined);
          onChanged?.();
          // **必须重取流程状态**：本步就绪是服务端按数据算的，分析刚落库时父级那份
          // flow 还是旧的（ready=false）——不刷的话「完成本步」会一直禁用，
          // 用户只能刷新页面才能往下走（存量 bug，一直藏在"走查静默跳过分析段"后面）。
          onFlowChanged?.();
        }
      }
    } catch (err: unknown) {
      setStreamLines((prev) => [
        ...prev,
        `【错误】${err instanceof Error ? err.message : String(err)}`,
      ]);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [projectId, stage, stepId, reload, loadSummary, onChanged, onFlowChanged]);

  /* ── 三态渲染 ── */

  if (status === "loading") {
    return (
      <div className="pnl">
        <div className="pnl-h">
          <p className="pnl-note">正在加载信息…</p>
        </div>
        <div className="pnl-b">
          <div className="loading-strip" role="status" aria-label="加载中" />
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="pnl">
        <div className="pnl-h">
          <p className="pnl-note">本步数据暂时取不到</p>
          <button className="btn" type="button" onClick={reload}>
            重试
          </button>
        </div>
        <div className="pnl-b">
          <div className="empty-state">
            <div className="empty-state-title">加载失败</div>
            <div className="empty-state-desc">{error}</div>
          </div>
        </div>
      </div>
    );
  }

  const completeness = data?.completeness;
  const activeDef = activeTable ? tableDef(activeTable) : undefined;
  const activeRows = rows.filter((r) => r.table_code === activeTable);
  const stageDefRow = STAGE_DEFS.find((s) => s.id === (stage === 8 ? 7 : stage));
  const staleCount = rows.filter((r) => r.is_stale).length;
  const isModel = stageDefRow?.producedBy === "模型分析";

  return (
    <>
      {/* 本步只有「本步的表格 + 该步的动作」：步标题与就绪提示在流程轴，完整度在右栏 */}
      <div className="pnl">
        <div className="pnl-h">
          <div className="pnl-actions">
            {isModel ? (
              <button
                className="btn primary"
                type="button"
                onClick={() => void startAnalysis()}
                disabled={running}
              >
                {running ? "分析进行中…" : activeRows.length > 0 ? "重算本步分析" : "开始本步分析"}
              </button>
            ) : null}
            {/* 导航动作（与流程轴同一判定：缺口不阻断，但"本步还没有产出"不该被跳过） */}
            <button
              className="btn"
              type="button"
              onClick={() => void completeStep()}
              disabled={running || ready === false}
              title={readyHint ?? "导航动作：信息缺口不阻断，缺口可在右栏随时回看"}
            >
              完成本步，进入下一步
            </button>
            {/* 资料失效提示留在这里（它只跟本步数据有关；完整度与缺口清单在右栏） */}
            {staleCount > 0 ? <span className="badge warning">{staleCount} 行资料待重算</span> : null}
          </div>
        </div>
      </div>

      {/* 分析进度流 */}
      {streamLines.length > 0 ? (
        <div className="pnl">
          <div className="pnl-h">
            <div>
              <h2>阶段分析进度</h2>
              <p>{running ? "分析进行中，流式输出…" : "本步分析输出"}</p>
            </div>
          </div>
          <div className="pnl-b">
            <ul className="cl">
              {streamLines.map((line, i) => (
                <li key={i} className="cli">
                  <div>
                    <div className="cd">{line}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {/* 表1-1 场景锚：常驻但第 2–8 步默认折叠（一行摘要，点开才铺全文） */}
      {anchor.length > 0 ? (
        <AnchorFoldPanel
          rows={anchor as unknown as readonly Record<string, unknown>[]}
          summary={anchorSummary(anchor)}
        />
      ) : null}

      {/* 阶段表：chips 切换 + SchemaTable */}
      {stageTables.length > 0 ? (
        <div className="pnl">
          <div className="pnl-h">
            <div>
              <h2>{stepId !== undefined ? "本步信息表" : "本阶段信息表"}</h2>
            </div>
          </div>
          <div className="pnl-b">
            <div className="table-chips">
              {stageTables.map((t) => {
                const n = rows.filter((r) => r.table_code === t.code).length;
                return (
                  <button
                    key={t.code}
                    type="button"
                    className={`chip${activeTable === t.code ? " active" : ""}`}
                    onClick={() => setActiveTable(t.code)}
                  >
                    {t.code} {t.name}
                    <span className="chip-n">{n}</span>
                  </button>
                );
              })}
            </div>

            {blocks.length > 1 ? (
              <div className="table-chips sub">
                {blocks.map((b) => (
                  <button
                    key={b}
                    type="button"
                    className={`chip${block === b ? " active" : ""}`}
                    onClick={() => setBlock(b)}
                  >
                    {b}块
                  </button>
                ))}
              </div>
            ) : null}
            {categories.length > 0 ? (
              <div className="table-chips sub">
                {categories.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`chip${category === c ? " active" : ""}`}
                    onClick={() => setCategory(c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
            ) : null}

            {activeTable ? (
              <SchemaTable
                tableCode={activeTable}
                rows={activeRows.map((r) => ({ id: r.id, row: r.row }))}
                block={block ?? undefined}
                category={category ?? undefined}
                onCellChange={(rowId, cell, value) => void handleCellChange(rowId, cell, value)}
              />
            ) : null}

            {activeDef ? (
              <p className="schema-table-note">完整度规则：{activeDef.completeness.join("；")}</p>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="pnl">
          <div className="pnl-b">
            <div className="empty-state">
              <div className="empty-state-title">本步没有信息表</div>
              <div className="empty-state-desc">
                交付物由系统按「章节 ← 表映射」装配，不需要模型分析；可在右栏查看阶段总结。
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
