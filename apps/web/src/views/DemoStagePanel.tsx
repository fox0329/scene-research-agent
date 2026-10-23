import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  tablesOfStage,
  tableDef,
  tableDisplayName,
  rowBelongsToBlock,
  type InfoStageId,
} from "@scene/contract";
import type { InfoRow } from "@scene/domain";
import { SchemaTable, tableBlocks, tableCategories } from "../components/SchemaTable";
import type { StageSnapshot } from "../components/stage-snapshot";
import { DEMO_ROWS, demoStageBrief, demoStageSummary } from "../mock/demo-flow";

/**
 * 演示模式阶段面板（无后端）
 *
 * 与联真面板**共用同一套 schema 与领域逻辑**：
 *  - 列/固定行/枚举来自 `packages/contract/src/tables.ts`
 *  - 阶段总结来自 `packages/domain`（`buildStageSummary` / `buildStageBrief`）
 * 因此演示态与联真态的结构一致，E2E 断言的交互规范同样成立——这也是删除
 * 9 个手写 mock 面板（约 1.7k 行）后仍能验收的原因。
 *
 * v1.5：本面板只负责「某一步的表集」——`tables` 由流程定义给出（第 2-7 步），
 * 推进按钮上移到 `FlowRail`（全局唯一推进入口）。
 */

export interface DemoStagePanelProps {
  stage: number;
  /** 本步表集（流程定义给出）；缺省 = 该阶段全部表 */
  tables?: readonly string[];
  /** 流程步骤号：本步总结按流程步取（阶段 1 横跨第 1、2 两步） */
  stepId?: number;
  onStageSnapshot?: (snap: StageSnapshot | null) => void;
  /** 流程轴第二行点了某个输出物：`id` 变化时套用（与联真同口径） */
  pick?: { id: number; code: string | null; block: string | null };
  /** 回报此刻显示的表/块 → 流程轴第二行据此高亮 */
  onTableChange?: (code: string | null, block: string | null) => void;
}

export const DemoStagePanel: React.FC<DemoStagePanelProps> = ({
  stage,
  tables,
  stepId,
  onStageSnapshot,
  pick,
  onTableChange,
}) => {
  const id = (stage >= 6 ? 5 : stage) as InfoStageId;
  const stageTables = useMemo(() => {
    const all = tablesOfStage(id).filter((t) => t.code !== "表1-1");
    return tables ? all.filter((t) => tables.includes(t.code)) : all;
  }, [id, tables]);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  /** 演示态编辑：只改本地内存（无后端），保证交互规范（逐格可编辑）在演示态同样成立 */
  const [edits, setEdits] = useState<Record<string, Record<string, unknown>>>({});
  const [block, setBlock] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);

  useEffect(() => {
    const first = stageTables[0]?.code ?? null;
    setActiveTable((prev) => (prev && stageTables.some((t) => t.code === prev) ? prev : first));
  }, [stageTables]);

  const blocks = useMemo(() => (activeTable ? tableBlocks(activeTable) : []), [activeTable]);
  /** 流程轴第二行点了某个输出物：只在 id 变化时套用（与联真同口径） */
  const pickId = pick?.id;
  useEffect(() => {
    if (!pick || pick.code === null) return;
    setActiveTable(pick.code);
    setBlock(pick.block);
  }, [pickId]); // eslint-disable-line react-hooks/exhaustive-deps

  /* 回报此刻显示的表/块：流程轴第二行据此高亮 */
  useEffect(() => {
    onTableChange?.(activeTable, block);
  }, [activeTable, block, onTableChange]);

  /* 中栏当前行（只服务中栏自己的高亮；右栏补充说明条目已删，联动随之下线） */
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const focusRow = useCallback((rowId: string) => setActiveRowId(rowId), []);
  useEffect(() => {
    setActiveRowId(null);
  }, [stage, stepId, activeTable, block, category]);

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

  const rowsByTable = useMemo(() => {
    const out: Record<string, InfoRow[]> = {};
    for (const t of tablesOfStage(id)) {
      const base = DEMO_ROWS[t.code] ?? [];
      out[t.code] = base.map((r, i) => ({ ...r, ...(edits[`${t.code}-${i}`] ?? {}) }));
    }
    return out;
  }, [id, edits]);

  const handleDemoEdit = (tableCode: string, index: number, cell: string, value: string): void => {
    const key = `${tableCode}-${index}`;
    setEdits((prev) => ({ ...prev, [key]: { ...(prev[key] ?? {}), [cell]: value } }));
  };

  const summary = useMemo(
    () => demoStageSummary(id, stepId),
    [id, stepId],
  );

  /** 右栏只针对当前步骤：要点按**本步表集**推导（与联真同一套规则） */
  const brief = useMemo(() => demoStageBrief(id, stepId), [id, stepId]);

  const snapshot = useMemo<StageSnapshot>(
    () => ({
      summary,
      summaryLoading: false,
      brief,
      ...(stepId !== undefined && activeTable
        ? {
            artifact: {
              step: stepId,
              type: "table" as const,
              id: activeTable,
              block,
              title: tableDisplayName(activeTable),
            },
          }
        : {}),
      onRefreshSummary: () => undefined,
    }),
    [summary, brief, stepId, activeTable, block],
  );

  useEffect(() => {
    onStageSnapshot?.(snapshot);
    return () => onStageSnapshot?.(null);
  }, [snapshot, onStageSnapshot]);

  const activeDef = activeTable ? tableDef(activeTable) : undefined;

  return (
    <>
      {/* 完整度不进中栏（在右栏）；阶段名称进中栏并随滚动固定（用户定调 2026-10-06） */}
      {/* 表1-1 不在这一步显示（v1.20 与联真同口径：上一步的信息要回看自己回去看） */}

      {stageTables.length > 0 ? (
        <div className="pnl">
          <div className="pnl-b">
            {/* 表名/子块已挪到流程轴第二行（与联真同口径）；这里只留 payload 类别筛选 */}
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
                rows={(rowsByTable[activeTable] ?? [])
                  .map((r, i) => ({ id: `${activeTable}-${i}`, row: r }))
                  .filter((r) =>
                    activeDef && block ? rowBelongsToBlock(activeDef, block, r.row) : true,
                  )}
                block={block ?? undefined}
                category={category ?? undefined}
                onCellChange={(rowId, cell, value) => {
                  const index = Number(rowId.split("-").pop());
                  if (Number.isFinite(index)) handleDemoEdit(activeTable, index, cell, value);
                }}
                activeRowId={activeRowId}
                onRowFocus={(rowId) => focusRow(rowId)}
              />
            ) : null}
            {/* 完整度规则是生成时的内部约束，界面不显示（用户定调 2026-10-20） */}
          </div>
        </div>
      ) : null}
    </>
  );
};
