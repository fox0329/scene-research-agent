/**
 * @scene/web — SchemaTable：由**表定义注册表**驱动的表格渲染
 *
 * 为什么是适配器而不是新表格组件：
 *  - `SceneTable` 已实现自动列宽适配（单行优先）+ 列宽拖拽 + 宽度留存，
 *    这两项是已批准的偏离项（变更表 #2/#19），不能另起一套
 *  - 前端原先把列名手写在 `stage-field-labels.ts`（177 行）里，与契约、提示词
 *    各写一份必然漂移；本组件改为**从注册表取列**，表定义只有唯一事实源
 *
 * 列预算约束（04 §4.3）的执行点：
 *  - 只渲染**中栏列**（元信息与长文本说明在右栏补充列，不进表格）
 *  - 长文本列默认截断 + `title` 悬浮看全文，控件行高
 *  - 多子块表**按块**渲染（块间列不同，不能拼成一张表）
 *  - 「项 / 内容」纵向表（表1-1 场景锚）单独渲染，带确认状态
 */

import React, { useMemo } from "react";
import {
  middleColumns,
  middleColumnsByBlock,
  tableDef,
  type TableColumn,
} from "@scene/contract";
import { SceneTable, type ColumnDef } from "./SceneTable.js";

/** 一行数据（注册表列定义作用在 `row` 上，行 id 用于回写） */
export interface SchemaRow {
  id: string;
  row: Record<string, unknown>;
  source_type?: string | null;
  source?: string | null;
}

export interface SchemaTableProps {
  tableCode: string;
  rows: SchemaRow[];
  /** 多子块表的块名（如「架构」/「接口」） */
  block?: string;
  /** payload 类别（可选材料：O1认证 … O6交付与生态） */
  category?: string;
  /** 单元格编辑（行 id + 列字段 + 新值） */
  onCellChange?: (rowId: string, cell: string, value: string) => void;
  readOnly?: boolean;
}

/** 单元格取值 → 单行展示文本（数组用顿号连接） */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => String(v)).join("、");
  return String(value);
}

/**
 * 由注册表列定义生成 SceneTable 的 ColumnDef
 *
 * 注意：**不能给可编辑列设 `render`**——`SceneTable` 里 render 分支优先于 editable，
 * 设了 render 单元格就不再可编辑（踩过一次）。单行省略改由样式 + `title` 承担。
 */
function toColumnDefs(cols: readonly TableColumn[]): ColumnDef<Record<string, unknown>>[] {
  return cols.map((c) => ({
    key: c.key,
    label: c.label,
    editable: true,
  }));
}

/** 取该表在给定块 / 类别下的中栏列 */
function middleColsOf(
  tableCode: string,
  block?: string,
  category?: string,
): readonly TableColumn[] {
  const def = tableDef(tableCode);
  if (!def) return [];
  if (def.payloads && category) return middleColumns(def, category);
  if (def.columns.some((c) => c.block)) {
    const byBlock = middleColumnsByBlock(def);
    if (block && byBlock[block]) return byBlock[block]!;
  }
  return middleColumns(def, category);
}

/** 该表的分块名清单（非块表返回空数组） */
export function tableBlocks(tableCode: string): string[] {
  const def = tableDef(tableCode);
  if (!def || !def.columns.some((c) => c.block)) return [];
  return Object.keys(middleColumnsByBlock(def));
}

/** 该表的 payload 类别清单（非 payload 表返回空数组） */
export function tableCategories(tableCode: string): string[] {
  const def = tableDef(tableCode);
  return def?.payloads ? Object.keys(def.payloads) : [];
}

/**
 * 场景锚（表1-1）：固定行**纵向**呈现（「项 / 内容」两列 + 确认状态）
 *
 * 这是唯一常驻表，也是确认机制的 L1 对象（带 ✓ = 核心必确认项，
 * 选行由注册表的 `confirmRequired` 给，前端不假设项数）。
 */
export function AnchorTable({
  rows,
  onCellChange,
  readOnly,
}: {
  rows: SchemaRow[];
  onCellChange?: (rowId: string, cell: string, value: string) => void;
  readOnly?: boolean;
}): React.ReactElement {
  const def = tableDef("表1-1");
  const confirmItems = new Set(
    (def?.fixedRows ?? []).filter((r) => r.confirmRequired).map((r) => r.label),
  );
  const byItem = new Map(rows.map((r) => [String(r.row["item"] ?? ""), r]));

  const stateOf = (r: SchemaRow | undefined): { text: string; tone: string } => {
    if (!r) return { text: "未填", tone: "muted" };
    const st = String(r.source_type ?? "");
    if (st === "用户确认") return { text: "已确认", tone: "ok" };
    if (st === "用户补充") return { text: "已补充", tone: "ok" };
    if (st === "AI推断") return { text: "待确认", tone: "warn" };
    return { text: "待确认", tone: "warn" };
  };

  return (
    <table className="schema-table schema-table--anchor">
      <thead>
        <tr>
          <th style={{ width: "32%" }}>项</th>
          <th>内容</th>
          <th style={{ width: "88px" }}>状态</th>
        </tr>
      </thead>
      <tbody>
        {(def?.fixedRows ?? []).map((fixed) => {
          const r = byItem.get(fixed.label);
          const state = stateOf(r);
          const mustConfirm = confirmItems.has(fixed.label);
          return (
            <tr key={fixed.key} className={mustConfirm ? "anchor-row--confirm" : undefined}>
              <td>
                {fixed.label}
                {fixed.required ? <span className="req-dot" title="必填">*</span> : null}
                {mustConfirm ? <span className="confirm-dot" title="需用户确认">✓</span> : null}
              </td>
              <td>
                {readOnly || !r ? (
                  <span className="cell-truncate" title={cellText(r?.row["content"])}>
                    {cellText(r?.row["content"]) || "—"}
                  </span>
                ) : (
                  <input
                    className="cell-input"
                    value={cellText(r.row["content"])}
                    onChange={(e) => onCellChange?.(r.id, "content", e.target.value)}
                    placeholder="未提供"
                  />
                )}
              </td>
              <td>
                <span className={`state-badge state-badge--${state.tone}`}>{state.text}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * 注册表驱动的表格
 *
 * - 「项/内容」纵向表 → `AnchorTable`
 * - 多子块表 → 每块一张表（无数据的块不渲染）
 * - 普通表 → 限制在中栏列内渲染
 */
export function SchemaTable(props: SchemaTableProps): React.ReactElement | null {
  const { tableCode, rows, block, category, onCellChange, readOnly } = props;
  const def = useMemo(() => tableDef(tableCode), [tableCode]);

  if (!def) {
    return <p className="empty-hint">未在表定义注册表中找到「{tableCode}」</p>;
  }
  if (def.fixedRows) {
    return <AnchorTable rows={rows} onCellChange={onCellChange} readOnly={readOnly} />;
  }

  const cols = middleColsOf(tableCode, block, category);
  if (cols.length === 0) {
    return <p className="empty-hint">{tableCode} 暂无中栏列定义</p>;
  }
  if (rows.length === 0) {
    return <p className="empty-hint">本表暂无数据</p>;
  }

  const showGroupHeader = Boolean(def.groupBy);
  return (
    <div className="schema-table-wrap">
      <div className="schema-table-title">
        <strong>{def.code}</strong> {def.name}
        <span className="tier-badge">{def.tier}</span>
        <span className="row-unit">{def.rowUnit}</span>
      </div>
      <SceneTable
        columns={toColumnDefs(cols)}
        data={rows.map((r) => r.row)}
        storageKey={`schema:${tableCode}${block ? `:${block}` : ""}${category ? `:${category}` : ""}`}
        onCellChange={
          readOnly || !onCellChange
            ? undefined
            : (rowIndex, key, value) => {
                const target = rows[rowIndex];
                if (target) onCellChange(target.id, key, value);
              }
        }
      />
      {showGroupHeader ? (
        <p className="schema-table-note">按「{def.groupBy}」分组，分组键不进列</p>
      ) : null}
    </div>
  );
}
