import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  STAGE_DEFS,
  supplementColumns,
  tableDef,
  tablesOfStage,
  type InfoStageId,
} from "@scene/contract";
import { buildChecklist } from "@scene/domain";
import {
  api,
  advanceStageStream,
  type ApiAnchorRow,
  type ApiStagePanel,
  type ApiStageRow,
} from "../api";
import { useAsync } from "../hooks/useAsync";
import { SchemaTable, AnchorTable, tableBlocks, tableCategories } from "../components/SchemaTable";
import { asSourceType, type StageSnapshot, type SupplementTable } from "../components/stage-snapshot";
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
}

export const RealStagePanel: React.FC<RealStagePanelProps> = ({
  projectId,
  stage,
  stageLabel,
  onChanged,
  onStageSnapshot,
}) => {
  const { status, data, error, reload } = useAsync<ApiStagePanel>(
    () => api.stagePanel(projectId, stage),
    [projectId, stage],
  );
  const { showToast } = useToast();

  const [streamLines, setStreamLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);

  /* 单元格编辑：本地即时更新 + 落库 */
  const [patched, setPatched] = useState<Record<string, ApiStageRow>>({});
  const rows = useMemo(() => (data ? data.rows.map((r) => patched[r.id] ?? r) : []), [data, patched]);

  /* 当前选中的表（表1-1 由常驻区负责，不参与切换） */
  const stageTables = useMemo(() => {
    const code = (stage === 8 ? 7 : stage) as InfoStageId;
    return tablesOfStage(code).filter((t) => t.code !== "表1-1");
  }, [stage]);
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
        const r = await api.stageSummary(projectId, stage, refresh);
        setSummary(r.markdown);
      } catch {
        setSummary(null);
      } finally {
        setSummaryLoading(false);
      }
    },
    [projectId, stage],
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

  /** 锚行确认/修改（确认状态只能由用户动作产生，模型不得自称） */
  const handleAnchorAction = useCallback(
    async (item: string, action: "确认" | "修改", content?: string) => {
      const next: ApiAnchorRow[] = anchor.map((a) =>
        a.item === item
          ? {
              ...a,
              content: content ?? a.content,
              source_type: action === "确认" ? "用户确认" : "用户补充",
              confirm_state: action === "确认" ? "用户确认" : "用户修改",
            }
          : a,
      );
      setAnchor(next);
      try {
        const r = await api.saveAnchor(projectId, next);
        setAnchor(r.rows);
        onChanged?.();
      } catch (err: unknown) {
        showToast(`确认失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [anchor, projectId, onChanged, showToast],
  );

  /* 右栏数据面：补充列（当前表的右栏补充列）+ 确认清单 */
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

    // 确认清单：L1 取自表1-1 的必确认固定行；L2 取表1-2 的环节行；L3 为待确认聚合
    const linkRows = rows
      .filter((r) => r.table_code === "表1-2")
      .map((r) => ({ ...r.row, source_type: asSourceType(r.source_type) }));
    const pendingCount = rows.filter((r) => {
      const st = String(r.source_type ?? "");
      return st !== "用户确认" && st !== "用户补充";
    }).length;
    const checklist = buildChecklist({
      anchorRows: anchor.map((a) => ({
        item: a.item,
        content: a.content,
        source_type: asSourceType(a.source_type),
      })),
      linkRows: stage === 1 ? linkRows : [],
      pendingCount,
    });

    return {
      stage,
      stageLabel,
      rows,
      completeness: data.completeness ?? null,
      summary,
      summaryLoading,
      activeTable,
      supplements,
      checklist: checklist.items.map((i) => ({
        layer: i.layer,
        tableCode: i.tableCode,
        rowKey: i.rowKey,
        label: i.label,
        state: i.state,
      })),
      anchor,
      onRefreshSummary: () => void loadSummary(true),
      onSupplementChange: (rowId, cell, value) => void handleCellChange(rowId, cell, value),
      onAnchorAction: (item, action, content) => void handleAnchorAction(item, action, content),
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
    loadSummary,
    handleCellChange,
    handleAnchorAction,
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
      for await (const ev of advanceStageStream(projectId, stage)) {
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
  }, [projectId, stage, reload, loadSummary, onChanged]);

  /* ── 三态渲染 ── */

  if (status === "loading") {
    return (
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>
              阶段 {stage} · {stageLabel}
            </h2>
            <p>正在加载信息…</p>
          </div>
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
          <div>
            <h2>
              阶段 {stage} · {stageLabel}
            </h2>
            <p>后端连接失败，本阶段数据不可用</p>
          </div>
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
      {/* 阶段头 + 完整度 */}
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>
              阶段 {stage} · {stageLabel}
            </h2>
            <p>
              {isModel
                ? `本阶段要获得的信息：${stageDefRow?.goal ?? ""}`
                : `本阶段信息由「${stageDefRow?.producedBy ?? ""}」产生，不需要模型分析`}
            </p>
          </div>
          {isModel ? (
            <button
              className="btn primary"
              type="button"
              onClick={() => void startAnalysis()}
              disabled={running}
            >
              {running ? "分析进行中…" : activeRows.length > 0 ? "重算本阶段" : "开始本阶段分析"}
            </button>
          ) : null}
        </div>
        <div className="pnl-b flush">
          <div className="completeness-bar">
            <span>
              信息完整度 {completeness?.tablesWithData ?? 0}/{completeness?.expectedTables ?? 0} 张表
              {completeness ? `（${completeness.percent}%）` : ""}
            </span>
            {completeness && completeness.gaps.length > 0 ? (
              <span className="gap-count">
                缺口 {completeness.gaps.length} 项（不阻断，右栏可看清单）
              </span>
            ) : (
              <span className="gap-none">暂无缺口</span>
            )}
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
              <p>{running ? "分析进行中，流式输出…" : "本阶段分析输出"}</p>
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

      {/* 表1-1 场景锚：常驻（全链唯一场景定义） */}
      {anchor.length > 0 ? (
        <div className="pnl">
          <div className="pnl-h">
            <div>
              <h2>表1-1 场景概述 · 场景锚（常驻）</h2>
              <p>全链唯一的场景定义；带 ✓ 的 6 项需你确认，确认后下游才当作依据（右栏可逐项确认）</p>
            </div>
          </div>
          <div className="pnl-b flush">
            <AnchorTable
              rows={anchor.map((a, i) => ({ id: `anchor-${i}`, row: { ...a } }))}
              readOnly
            />
          </div>
        </div>
      ) : null}

      {/* 阶段表：chips 切换 + SchemaTable */}
      {stageTables.length > 0 ? (
        <div className="pnl">
          <div className="pnl-h">
            <div>
              <h2>本阶段信息表</h2>
              <p>{stageTables.length} 张表；列由表定义注册表给出，中栏只放重要信息（说明类在右栏）</p>
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
              <div className="empty-state-title">本阶段没有信息表</div>
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
