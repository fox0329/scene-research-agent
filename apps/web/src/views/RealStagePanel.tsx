import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  rowBelongsToBlock,
  detailColumns,
  tableDef,
  tablesOfStage,
  type InfoStageId,
} from "@scene/contract";
import { api, type ApiStagePanel, type ApiStageRow } from "../api";
import { useAsync } from "../hooks/useAsync";
import { SchemaTable, tableBlocks, tableCategories } from "../components/SchemaTable";
import type {
  RowLinkOrigin,
  StageSnapshot,
  SupplementTable,
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
  onChanged?: () => void;
  /** 右栏数据面（null=加载中/不可用） */
  onStageSnapshot?: (snap: StageSnapshot | null) => void;
  /** 本步表集（流程定义给出，如 `flowStep(4).tables`）；缺省 = 该阶段全部表 */
  tables?: readonly string[];
  /** 流程步骤号：本步数据与本步总结都按流程步取（阶段 1 横跨第 1、2 两步） */
  stepId?: number;

  /** 分析落库后自增：本组件收到变化就重取本步数据与阶段总结 */
  refreshToken?: number;

  /** 流程轴第二行点了某个输出物：`id` 变化时套用（外部选择），null 表示没点过 */
  pick?: { id: number; code: string | null; block: string | null };
  /** 回报本组件此刻显示的表/块 → 流程轴第二行据此高亮 */
  onTableChange?: (code: string | null, block: string | null) => void;
}

export const RealStagePanel: React.FC<RealStagePanelProps> = ({
  projectId,
  stage,
  onChanged,
  onStageSnapshot,
  tables,
  stepId,

  refreshToken,
  pick,
  onTableChange,
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
    const code = (stage >= 7 ? 6 : stage) as InfoStageId;
    const all = tablesOfStage(code).filter((t) => t.code !== "表1-1");
    return tables ? all.filter((t) => tables.includes(t.code)) : all;
  }, [stage, tables]);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  useEffect(() => {
    if (activeTable && stageTables.some((t) => t.code === activeTable)) return;
    const withData = stageTables.find((t) => rows.some((r) => r.table_code === t.code));
    setActiveTable((withData ?? stageTables[0])?.code ?? null);
  }, [stageTables, rows, activeTable]);

  /**
   * 流程轴第二行点了某个输出物：套用到本组件
   *
   * 只在 `pick.id` 变化时套用——用户在中栏自己切块（或本组件自动回落到有数据的表）时，
   * 不能被上一次的外部选择拉回去。块的回落交给下面那个既有 effect（pick.block 为空时取首块）。
   */
  const pickId = pick?.id;
  useEffect(() => {
    if (!pick || pick.code === null) return;
    setActiveTable(pick.code);
    setBlock(pick.block);
  }, [pickId]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // 一次点击会同时切表与切块（如「接口清单」= 表5-1 + 接口块），无脑重置会把用户点的块冲掉
    if (block === null || !blocks.includes(block)) setBlock(blocks[0] ?? null);
    if (category === null || !categories.includes(category)) setCategory(categories[0] ?? null);
  }, [blocks, categories, block, category]);

  /* 回报此刻显示的表/块：流程轴第二行据此高亮（用户在中栏自己切块也会跟着变） */
  useEffect(() => {
    onTableChange?.(activeTable, block);
  }, [activeTable, block, onTableChange]);

  /**
   * 中栏 ↔ 右栏的行联动（变更表 #150）
   *
   * 只有一个 `activeRowId`：中栏表格行与右栏 Tab① 的条目按**同一个 rowId** 高亮，所以
   * 两边不会各说各话。`origin` 是防抖用的发起方标记——**只滚发起方的对面**：
   * 中栏点的行才去滚右栏，右栏点的字段才去滚中栏；发起方自己纹丝不动，
   * 于是 A→B→A 的互相滚动不成立（右栏自己滚动也不会反过来改中栏的选中行）。
   */
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [activeRowOrigin, setActiveRowOrigin] = useState<RowLinkOrigin | null>(null);
  const focusRow = useCallback((rowId: string, origin: RowLinkOrigin) => {
    setActiveRowId(rowId);
    setActiveRowOrigin(origin);
  }, []);
  /* 换表/换块/换类别/换步骤：上一张表的当前行不许带到新表上（新表里没有这个 rowId） */
  useEffect(() => {
    setActiveRowId(null);
    setActiveRowOrigin(null);
  }, [stage, stepId, activeTable, block, category]);

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
      const cols = def ? detailColumns(def, category ?? undefined) : [];
      const tRows = rows.filter((r) => r.table_code === activeTable);
      if (def && cols.length > 0 && tRows.length > 0) {
        supplements.push({
          tableCode: def.code,
          tableName: def.name,
          columns: cols.map((c) => ({ key: c.key, label: c.label })),
          rows: tRows.map((r) => ({ id: r.id, row: r.row })),
        });
      }
    }

    return {
      rows,
      completeness: data.completeness ?? null,
      summary,
      summaryLoading,
      activeTable,
      activeRowId,
      activeRowOrigin,
      supplements,
      onRefreshSummary: () => void loadSummary(true),
      onSupplementChange: (rowId, cell, value) => void handleCellChange(rowId, cell, value),
      onRowFocus: focusRow,
    };
  }, [
    data,
    rows,
    summary,
    summaryLoading,
    stage,
    activeTable,
    activeRowId,
    activeRowOrigin,
    category,
    loadSummary,
    handleCellChange,
    focusRow,
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
            {/* 表名/子块已挪到流程轴第二行（用户定调 2026-10-06：不要让表名随表格滚走）；
                这里只留本表自己的 payload 类别筛选 */}
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
                activeRowId={activeRowId}
                /* 中栏发起的联动：右栏去滚；右栏发起的：由中栏把这一行滚进可视 */
                revealActiveRow={activeRowOrigin === "right"}
                onRowFocus={(rowId) => focusRow(rowId, "mid")}
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
