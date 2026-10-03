import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  FLOW_TOTAL,
  STAGE_DEFS,
  blockLabel,
  flowStep,
  rowBelongsToBlock,
  supplementColumns,
  tableDef,
  tablesOfStage,
  type InfoStageId,
} from "@scene/contract";
import { api, type ApiStagePanel, type ApiStageRow } from "../api";
import { useAsync } from "../hooks/useAsync";
import { SchemaTable, tableBlocks, tableCategories } from "../components/SchemaTable";
import {
  asSourceType,
  type StageSnapshot,
  type SupplementTable,
} from "../components/stage-snapshot";
import { useToast } from "../components/Toast";

/**
 * 阶段面板（联真，v1.4 信息版）
 *
 * 中栏（本组件的职责）——**只有信息，没有动作**（v1.20 用户定调）：
 *  - 一行表名（本步有哪些表，一行放下，不带表号）+ SchemaTable
 *  - 只放信息：进度不再进中栏（用户定调：进度看流程轴按钮上的「分析中 m:ss」，
 *    悬停可看最新一行进度），跑完自然没有任何残留
 *  - 单元格编辑落库
 *
 *  不在中栏：表1-1 场景锚（上一步的事，要回看自己回去看）、步标题、完整度、推进按钮
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
  /** 流程步骤号：右栏标题与后续动作按流程步走 */
  stepId?: number;

  /** 分析落库后自增：本组件收到变化就重取本步数据与阶段总结 */
  refreshToken?: number;
}

export const RealStagePanel: React.FC<RealStagePanelProps> = ({
  projectId,
  stage,
  stageLabel,
  onChanged,
  onStageSnapshot,
  tables,
  stepId,

  refreshToken,
}) => {
  // 右栏（完整度 / 补充说明 / 阶段总结）一律带上本步：**只针对当前步骤**
  const { status, data, error, reload } = useAsync<ApiStagePanel>(
    () => api.stagePanel(projectId, stage, stepId),
    [projectId, stage, stepId],
  );
  const { showToast } = useToast();

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
    // 块/类别只在「当前值对新表不成立」时才回落到第一个：v1.26 芯片一行后，
    // 一次点击会同时切表与切块（如「成本汇总」= 表5-5 + 汇总块），无脑重置会把用户点的块冲掉
    if (block === null || !blocks.includes(block)) setBlock(blocks[0] ?? null);
    if (category === null || !categories.includes(category)) setCategory(categories[0] ?? null);
  }, [blocks, categories, block, category]);

  /**
   * 表格芯片清单：**多子块表的每块各占一个"表"，全部排在同一个芯片行里**
   *
   * 用户定调（v1.26）：不要"表名一行 + 块名一行"的两级选择，拆成多个表格、一行显示。
   * 块的列结构本来就不同（架构块 5 列 / 接口块 4 列；成本的四块各自成表），
   * 所以这一层级的"拆分"是真实的，只是不再让用户先选表再选块。
   */
  const tableEntries = useMemo(
    () =>
      stageTables.flatMap((t) => {
        const bs = tableBlocks(t.code);
        if (bs.length <= 1) {
          return [{ key: t.code, label: t.name, code: t.code, block: null as string | null }];
        }
        const def = tableDef(t.code);
        return bs.map((b) => ({
          key: `${t.code}:${b}`,
          label: def ? blockLabel(def, b) : `${b}块`,
          code: t.code,
          block: b as string | null,
        }));
      }),
    [stageTables],
  );

  /** 本表本块的行：多子块表按块过滤（否则接口块视图会带出一排架构块的空行） */
  const activeRows = useMemo(() => {
    const mine = rows.filter((r) => r.table_code === activeTable);
    const def = activeTable ? tableDef(activeTable) : undefined;
    if (!def || !block) return mine;
    return mine.filter((r) => rowBelongsToBlock(def, block, r.row));
  }, [rows, activeTable, block]);

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

  /* 分析落库后父级把 refreshToken +1：重取本步数据与阶段总结（分析刚写完时本地还是旧快照） */
  useEffect(() => {
    if (refreshToken === undefined || refreshToken === 0) return;
    reload();
    void loadSummary(true);
  }, [refreshToken, reload, loadSummary]);

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
      onRefreshSummary: () => void loadSummary(true),
      onSupplementChange: (rowId, cell, value) => void handleCellChange(rowId, cell, value),
    };
  }, [
    data,
    rows,
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
  return (
    <>
      {/* 本步的表：表名一行（不带表号/条数）+ SchemaTable */}
      {stageTables.length > 0 ? (
        <div className="pnl">
          <div className="pnl-b">
            <div className="table-chips table-chips--single">
              {tableEntries.map((e) => {
                const active =
                  activeTable === e.code &&
                  (e.block ?? null) === (block ?? blocks[0] ?? null);
                return (
                  <button
                    key={e.key}
                    type="button"
                    className={`chip${active ? " active" : ""}`}
                    onClick={() => {
                      setActiveTable(e.code);
                      setBlock(e.block);
                    }}
                  >
                    {e.label}
                  </button>
                );
              })}
            </div>
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
