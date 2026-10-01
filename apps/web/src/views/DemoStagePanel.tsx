import React, { useEffect, useMemo, useState } from "react";
import {
  FLOW_STEPS,
  FLOW_TOTAL,
  STAGE_DEFS,
  tablesOfStage,
  tableDef,
  supplementColumns,
  type InfoStageId,
} from "@scene/contract";
import { buildChecklist, buildStageSummary, checkStageCompleteness, type InfoRow } from "@scene/domain";
import { SchemaTable, tableBlocks, tableCategories } from "../components/SchemaTable";
import { AnchorFoldPanel } from "../components/AnchorFoldPanel";
import { anchorSummary } from "../components/definition-progress";
import {
  asSourceType,
  checklistContent,
  type StageSnapshot,
  type SupplementTable,
} from "../components/stage-snapshot";
import type { ApiAnchorRow, ApiCompleteness } from "../api";
import { DEMO_ANCHOR, DEMO_ROWS } from "../mock/demo-flow";

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
  const id = (stage === 8 ? 7 : stage) as InfoStageId;
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

  const blocks = activeTable ? tableBlocks(activeTable) : [];
  const categories = activeTable ? tableCategories(activeTable) : [];
  useEffect(() => {
    setBlock(blocks[0] ?? null);
    setCategory(categories[0] ?? null);
  }, [blocks, categories]);

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

  const completeness = useMemo<ApiCompleteness>(
    () => checkStageCompleteness({ stage: id, rowsByTable }) as unknown as ApiCompleteness,
    [id, rowsByTable],
  );

  const summary = useMemo(
    () =>
      buildStageSummary({
        stage: id,
        scenarioName: "智慧水务",
        productLineName: "感知与控制",
        rowsByTable,
        completeness: checkStageCompleteness({ stage: id, rowsByTable }),
        briefRawText: "场景名称：智慧水务\n想搞清楚什么：这个场景值不值得进",
        generatedAt: "2026-09-25",
      }),
    [id, rowsByTable],
  );

  const snapshot = useMemo<StageSnapshot>(() => {
    const supplements: SupplementTable[] = [];
    if (activeTable) {
      const t = tableDef(activeTable);
      const cols = t ? supplementColumns(t, category ?? undefined) : [];
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
    const checklist = buildChecklist({
      anchorRows: checklistAnchor.map((a) => ({
        item: a.item,
        content: a.content,
        source_type: asSourceType(a.source_type),
      })),
      linkRows: id === 1 ? (rowsByTable["表1-2"] ?? []) : [],
      pendingCount: 2,
    });
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
      rows: [],
      completeness,
      summary,
      summaryLoading: false,
      activeTable,
      supplements,
      checklist: checklist.items.map((i) => ({
        layer: i.layer,
        tableCode: i.tableCode,
        rowKey: i.rowKey,
        label: i.label,
        state: i.state,
        content: checklistContent(i.tableCode, i.rowKey, checklistAnchor),
      })),
      anchor: [...checklistAnchor],
      anchorSummary: anchorSummary(checklistAnchor),
      onRefreshSummary: () => undefined,
      onSupplementChange: () => undefined,
      onAnchorAction: () => undefined,
    };
  }, [stage, stepId, def, completeness, summary, activeTable, supplementsKey(activeTable, category), rowsByTable, id, anchorRows]);

  useEffect(() => {
    onStageSnapshot?.(snapshot);
    return () => onStageSnapshot?.(null);
  }, [snapshot, onStageSnapshot]);

  const activeDef = activeTable ? tableDef(activeTable) : undefined;

  return (
    <>
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>
              {stepId ? `第 ${stepId}/${FLOW_TOTAL} 步 · ` : `阶段 ${stage} · `}
              {stepId ? (FLOW_STEPS.find((s) => s.id === stepId)?.title ?? def?.name ?? "") : def?.name ?? ""}
            </h2>
            <p>演示模式：结构、列定义与完整度口径与联真一致（数据为示例）</p>
          </div>
        </div>
        <div className="pnl-b flush">
          <div className="completeness-bar">
            <span>
              信息完整度 {completeness.tablesWithData}/{completeness.expectedTables} 张表（
              {completeness.percent}%）
            </span>
            {/* 100% 时不再同时喊「缺口 N 项」（自相矛盾） */}
            {completeness.percent >= 100 ? (
              <span className="gap-none">信息齐全</span>
            ) : completeness.gaps.length > 0 ? (
              <span className="gap-count">{completeness.gaps.length} 项缺口（不阻断）</span>
            ) : (
              <span className="gap-none">暂无缺口</span>
            )}
          </div>
        </div>
      </div>

      {/* 表1-1 与联真同结构：第 2–8 步默认折叠成一行摘要 */}
      <AnchorFoldPanel
        rows={anchorRows as unknown as readonly Record<string, unknown>[]}
        summary={anchorSummary(anchorRows)}
      />

      {stageTables.length > 0 ? (
        <div className="pnl">
          <div className="pnl-h">
            <div>
              <h2>本步信息表</h2>
              <p>{stageTables.length} 张表；列由表定义注册表给出，中栏只放重要信息</p>
            </div>
          </div>
          <div className="pnl-b">
            <div className="table-chips">
              {stageTables.map((t) => (
                <button
                  key={t.code}
                  type="button"
                  className={`chip${activeTable === t.code ? " active" : ""}`}
                  onClick={() => setActiveTable(t.code)}
                >
                  {t.code} {t.name}
                  <span className="chip-n">{(rowsByTable[t.code] ?? []).length}</span>
                </button>
              ))}
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
                rows={(rowsByTable[activeTable] ?? []).map((r, i) => ({
                  id: `${activeTable}-${i}`,
                  row: r,
                }))}
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
