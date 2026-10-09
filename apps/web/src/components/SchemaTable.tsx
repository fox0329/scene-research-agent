/**
 * @scene/web — SchemaTable：由**表定义注册表**驱动的表格渲染
 *
 * 为什么是适配器而不是新表格组件：
 *  - `SceneTable` 已实现自动列宽适配（单行优先）+ 逐列拖拽（只动这一列）+ 宽度留存，
 *    这两项是已批准的偏离项（变更表 #2/#19），不能另起一套
 *  - 前端原先把列名手写在 `stage-field-labels.ts`（177 行）里，与契约、提示词
 *    各写一份必然漂移；本组件改为**从注册表取列**，表定义只有唯一事实源
 *
 * 列预算约束（04 §4.3）的执行点：
 *  - 只渲染**中栏列**（元信息与长文本说明在右栏补充列，不进表格）
 *  - 长文本列**换行显示、行高随内容长**（用户定调 2026-09-26；不再截断省略）
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
import { plainText } from "./text-display";

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
  /**
   * 当前行（rowId，变更表 #150）：中栏这一行与右栏 Tab① 的对应条目同源高亮
   *
   * 受控——由阶段面板持有；换表/换块时面板清空，上一张表的高亮不会带过来。
   */
  activeRowId?: string | null;
  /** 行被点击或行内单元格获得焦点时上报（父级据此把右栏条目高亮并滚进可视） */
  onRowFocus?: (rowId: string) => void;
  /** 把当前行滚进可视：只在联动由右栏发起时为 true（发起方自己不动，避免两边互滚） */
  revealActiveRow?: boolean;
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
 * 设了 render 单元格就不再可编辑（踩过一次）。
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
 * 场景锚（表1-1）：固定行**纵向**呈现（「项 / 内容」两列）
 *
 * 这是唯一常驻表。**不显示"待确认"状态列**——用户定调「表格用户自己可以修改，
 * 不用显示待确认」：状态徽标既不复述信息，又暗示"这里有活等着你"，纯噪音。
 * 哪些行是用户该给的，由项名后的一枚 `你的输入` 标签表达（注册表 `owner` 给）。
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
  const byItem = new Map(rows.map((r) => [String(r.row["item"] ?? ""), r]));
  const editable = Boolean(onCellChange) && !readOnly;

  /**
   * 固定 6 行一律列出（注册表为准），每行带上"能不能写"的标记：
   * 库里没有对应行的（`rowId === null`）只给灰字提示，不给存不下去的控件。
   */
  const data = (def?.fixedRows ?? []).map((fixed) => {
    const r = byItem.get(fixed.label);
    return {
      rowId: (r?.id ?? null) as string | null,
      item: fixed.label,
      required: Boolean(fixed.required),
      mine: fixed.owner === "用户",
      content: cellText(r?.row["content"]),
    };
  });

  const columns: ColumnDef<(typeof data)[number]>[] = [
    {
      key: "item",
      label: "项",
      render: (_value, row) => (
        <>
          {row.item}
          {row.required ? (
            <span className="req-dot" title="必填">
              *
            </span>
          ) : null}
          {row.mine ? (
            <span className="owner-tag" title="这一项由你输入">
              你的输入
            </span>
          ) : null}
        </>
      ),
    },
    {
      key: "content",
      label: "内容",
      editable,
      multiline: true,
      placeholder: (row) => (row.mine ? "给个场景名，或直接写你想覆盖的范围" : "待智能体写"),
    },
  ];

  return (
    <SceneTable
      columns={columns}
      data={data}
      tableClassName="schema-table schema-table--anchor"
      storageKey="anchor:表1-1"
      rowEditable={(row) => editable && row.rowId !== null}
      {...(editable
        ? {
            onCellChange: (rowIndex, _key, value) => {
              const target = data[rowIndex];
              if (target?.rowId) onCellChange?.(target.rowId, "content", value);
            },
          }
        : {})}
    />
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
  const {
    tableCode,
    rows,
    block,
    category,
    onCellChange,
    activeRowId,
    onRowFocus,
    revealActiveRow,
    readOnly,
  } = props;
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
      {/* 用户定调 2026-10-09：表头只留**表名**，「表X-X」这个表号删掉——有名称就够了。
          表号仍留在契约里做内部交叉引用（报告章节映射、测试口径都用 code），只是不上界面 */}
      <div className="schema-table-title">
        {def.name}
        <span className="tier-badge">{def.tier}</span>
        <span className="row-unit">{def.rowUnit}</span>
      </div>
      <SceneTable
        columns={toColumnDefs(cols)}
        data={rows.map((r) => r.row)}
        storageKey={`schema:${tableCode}${block ? `:${block}` : ""}${category ? `:${category}` : ""}`}
        /* 联动按 rowId 对：这里的行顺序与 `data` 一一对应（同一份 rows.map） */
        rowIdOf={(_row, index) => rows[index]?.id ?? null}
        activeRowId={activeRowId}
        onRowFocus={onRowFocus}
        revealActiveRow={revealActiveRow}
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
