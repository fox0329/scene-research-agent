import React, { useEffect, useMemo, useState } from "react";
import {
  FLOW_STEPS,
  FLOW_TOTAL,
  STAGE_DEFS,
  blockLabel,
  tablesOfStage,
  tableDef,
  rowBelongsToBlock,
  detailColumns,
  type InfoStageId,
} from "@scene/contract";
import { buildStageSummary, checkStageCompleteness, type InfoRow } from "@scene/domain";
import { SchemaTable, tableBlocks, tableCategories } from "../components/SchemaTable";
import { anchorSummary } from "../components/definition-progress";
import {
  asSourceType,
  type StageSnapshot,
  type SupplementTable,
} from "../components/stage-snapshot";
import type { ApiAnchorRow, ApiCompleteness } from "../api";
import { DEMO_ANCHOR, DEMO_ROWS, demoStageSummary } from "../mock/demo-flow";

/**
 * 演示模式阶段面板（无后端）
 *
 * 与联真面板**共用同一套 schema 与领域逻辑**：
 *  - 列/固定行/枚举来自 `packages/contract/src/tables.ts`
 *  - 完整度与阶段总结来自 `packages/domain`（`checkStageCompleteness` / `buildStageSummary`）
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
  /** 流程步骤号（右栏页头用「第 n/FLOW_TOTAL 步」而不是阶段号） */
  stepId?: number;
  /** 演示态场景锚（确认清单的 L1 来源） */
  anchor?: readonly ApiAnchorRow[];
  onStageSnapshot?: (snap: StageSnapshot | null) => void;
}

export const DemoStagePanel: React.FC<DemoStagePanelProps> = ({
  stage,
  tables,
  stepId,
  anchor,
  onStageSnapshot,
}) => {
  const id = (stage >= 7 ? 6 : stage) as InfoStageId;
  const def = STAGE_DEFS.find((s) => s.id === id);
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
  /** 表格芯片：多子块表每块各占一个"表"，全部排在同一行（与联真同口径，v1.26） */
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

  /** 场景锚行：联真/演示同口径（调用方给了就用，没给退回示例锚） */
  const anchorRows = anchor && anchor.length > 0 ? anchor : DEMO_ANCHOR;

  /** 右栏只针对当前步骤：完整度与总结都按**本步表集**算 */
  const stepCodes = tables && tables.length > 0 ? tables : undefined;
  const completeness = useMemo<ApiCompleteness>(
    () =>
      checkStageCompleteness({
        stage: id,
        rowsByTable,
        ...(stepCodes ? { tableCodes: stepCodes } : {}),
      }) as unknown as ApiCompleteness,
    [id, rowsByTable, stepCodes],
  );

  const summary = useMemo(
    () => demoStageSummary(id, stepId),
    [id, stepId],
  );

  const snapshot = useMemo<StageSnapshot>(() => {
    const supplements: SupplementTable[] = [];
    if (activeTable) {
      const t = tableDef(activeTable);
      const cols = t ? detailColumns(t, category ?? undefined) : [];
      const rows = (rowsByTable[activeTable] ?? []).map((r, i) => ({
        id: `${activeTable}-${i}`,
        row: r,
      }));
      if (t && cols.length > 0 && rows.length > 0) {
        supplements.push({
          tableCode: t.code,
          tableName: t.name,
          columns: cols.map((c) => ({ key: c.key, label: c.label })),
          rows,
        });
      }
    }
    const checklistAnchor = anchorRows;
    return {
      stage,
      stageLabel: def?.name ?? "",
      ...(stepId
        ? {
            title: `第 ${stepId}/${FLOW_TOTAL} 步 · ${
              FLOW_STEPS.find((s) => s.id === stepId)?.title ?? (def?.name ?? "")
            }`,
          }
        : {}),
      // 右栏「核实」段读这里的行（v1.27）：演示态也要能看到每条信息的核实结论
      rows: activeTable
        ? (rowsByTable[activeTable] ?? []).map((r, i) => ({
            id: `${activeTable}-${i}`,
            scenario_id: "demo",
            stage,
            table_code: activeTable,
            row: r as Record<string, unknown>,
            is_stale: false,
          }))
        : [],
      completeness,
      summary,
      summaryLoading: false,
      activeTable,
      supplements,
      anchor: [...checklistAnchor],
      anchorSummary: anchorSummary(checklistAnchor),
      onRefreshSummary: () => undefined,
      // 演示态的补充说明/核实同样可编辑（与联真同口径：逐格可编辑，只改本地内存）
      onSupplementChange: (rowId, cell, value) => {
        if (!activeTable) return;
        const idx = Number(String(rowId).slice(`${activeTable}-`.length));
        if (Number.isNaN(idx)) return;
        handleDemoEdit(activeTable, idx, cell, value);
      },
    };
  }, [stage, stepId, def, completeness, summary, activeTable, supplementsKey(activeTable, category), rowsByTable, id, anchorRows]);

  useEffect(() => {
    onStageSnapshot?.(snapshot);
    return () => onStageSnapshot?.(null);
  }, [snapshot, onStageSnapshot]);

  const activeDef = activeTable ? tableDef(activeTable) : undefined;

  return (
    <>
      {/* 步标题与完整度都不进中栏：标题在流程轴，完整度在右栏 */}
      {/* 表1-1 不在这一步显示（v1.20 与联真同口径：上一步的信息要回看自己回去看） */}

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
              />
            ) : null}
            {activeDef ? (
              <p className="schema-table-note">完整度规则：{activeDef.completeness.join("；")}</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
};

/** 依赖键（避免把 category 塞进 memo 依赖时每渲染都变） */
function supplementsKey(table: string | null, category: string | null): string {
  return `${table ?? ""}#${category ?? ""}`;
}
