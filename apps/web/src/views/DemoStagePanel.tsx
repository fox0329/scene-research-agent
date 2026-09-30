import React, { useEffect, useMemo, useState } from "react";
import {
  STAGE_DEFS,
  tablesOfStage,
  tableDef,
  supplementColumns,
  type InfoStageId,
} from "@scene/contract";
import { buildChecklist, buildStageSummary, checkStageCompleteness, type InfoRow } from "@scene/domain";
import { AnchorTable, SchemaTable, tableBlocks, tableCategories } from "../components/SchemaTable";
import { asSourceType, type StageSnapshot, type SupplementTable } from "../components/stage-snapshot";
import type { ApiAnchorRow, ApiCompleteness } from "../api";

/**
 * 演示模式阶段面板（无后端）
 *
 * 与联真面板**共用同一套 schema 与领域逻辑**：
 *  - 列/固定行/枚举来自 `packages/contract/src/tables.ts`
 *  - 完整度与阶段总结来自 `packages/domain`（`checkStageCompleteness` / `buildStageSummary`）
 * 因此演示态与联真态的结构一致，E2E 断言的交互规范同样成立——这也是删除
 * 9 个手写 mock 面板（约 1.7k 行）后仍能验收的原因。
 */

const DEMO_ANCHOR: ApiAnchorRow[] = [
  { item: "场景名称", content: "智慧水务", source_type: "用户补充" },
  { item: "客户类型/行业", content: "市政水务集团", source_type: "用户确认" },
  { item: "覆盖什么", content: "只看出厂到管网", source_type: "AI提取" },
  { item: "核心用途", content: "想搞清楚这个场景值不值得进", source_type: "用户确认" },
  { item: "切入点", content: "存量泵站改造", source_type: "AI推断" },
];

/** 演示行：键必须存在于该表定义中（否则会被渲染成空列） */
const DEMO_ROWS: Record<string, InfoRow[]> = {
  M1: [
    { model: "IPC-3000", name: "边缘控制器", status: "在售", category: "控制类" },
    { model: "SEN-200", name: "压力变送器", status: "在售", category: "感知类" },
  ],
  M3: [
    { domain: "设备接入", name: "Modbus/OPC-UA 接入", maturity: "已交付", note: "支持 20+ 协议" },
  ],
  "表1-2": [
    {
      link: "制水",
      is_digital: "可以联网采集",
      can_touch: "可以碰",
      our_role: "辅助",
      description: "加药与过滤环节的数据采集",
    },
    {
      link: "输配",
      is_digital: "可以联网采集",
      can_touch: "可以碰",
      our_role: "替代",
      description: "管网调度与漏损分析",
    },
    {
      link: "原水取水",
      is_digital: "必须物理隔离",
      can_touch: "不能碰",
      our_role: "不参与",
      description: "水源安全相关，不介入",
    },
  ],
  "表1-3": [
    {
      barrier_type: "技术",
      barrier_name: "等保三级",
      criteria: "GB/T 22239",
      current_status: "过得了",
      judgment: "过得了",
    },
    {
      barrier_type: "行业准入",
      barrier_name: "计量器具型式批准",
      criteria: "CPA 认证",
      current_status: "绕道",
      judgment: "绕道",
    },
  ],
  "表3-1": [{ link: "视频监控", gross_margin: "35%", representative: "行业头部厂商" }],
  "表3-2": [
    {
      form: "一体化平台",
      key_points: "软硬一体、统一运维",
      leader: "头部厂商",
      position: "主导",
      our_entry: "从边缘分析切入",
    },
  ],
  "表4-1": [
    { capability: "设备接入", level: "已具备", evidence: "M3 能力清单", gap: "无" },
  ],
  "表5-1": [
    {
      layer: "边缘层",
      components: "边缘网关 + 协议转换",
      interface: "Modbus/OPC-UA",
      integration: "对接现有 SCADA",
      boundary: "不承担安全责任",
    },
  ],
  "表6-1": [
    {
      benefit: "降低漏损率",
      metric: "漏损率",
      baseline: "18%",
      expected: "12%",
      how_to_measure: "分区计量（DMA）",
      user_feeling: "水费与投诉下降",
      evidence_level: "C",
    },
  ],
  "表7-1": [
    {
      target: "内部能力沉淀",
      content: "沉淀水务行业方案模板与报价基线",
      basis: "阶段 2 表3-8 需求缺口",
    },
  ],
};

export interface DemoStagePanelProps {
  stage: number;
  onStageSnapshot?: (snap: StageSnapshot | null) => void;
}

export const DemoStagePanel: React.FC<DemoStagePanelProps> = ({ stage, onStageSnapshot }) => {
  const id = (stage === 8 ? 7 : stage) as InfoStageId;
  const def = STAGE_DEFS.find((s) => s.id === id);
  const stageTables = useMemo(
    () => tablesOfStage(id).filter((t) => t.code !== "表1-1"),
    [id],
  );
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
    const checklist = buildChecklist({
      anchorRows: DEMO_ANCHOR.map((a) => ({
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
      })),
      anchor: DEMO_ANCHOR,
      onRefreshSummary: () => undefined,
      onSupplementChange: () => undefined,
      onAnchorAction: () => undefined,
    };
  }, [stage, def, completeness, summary, activeTable, supplementsKey(activeTable, category), rowsByTable, id]);

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
              阶段 {stage} · {def?.name ?? ""}
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
            {completeness.gaps.length > 0 ? (
              <span className="gap-count">缺口 {completeness.gaps.length} 项（不阻断）</span>
            ) : (
              <span className="gap-none">暂无缺口</span>
            )}
          </div>
        </div>
      </div>

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表1-1 场景概述 · 场景锚（常驻）</h2>
            <p>全链唯一的场景定义；带 ✓ 的 6 项需你确认</p>
          </div>
        </div>
        <div className="pnl-b flush">
          <AnchorTable
            rows={DEMO_ANCHOR.map((a, i) => ({ id: `anchor-${i}`, row: { ...a } }))}
            readOnly
          />
        </div>
      </div>

      {stageTables.length > 0 ? (
        <div className="pnl">
          <div className="pnl-h">
            <div>
              <h2>本阶段信息表</h2>
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
