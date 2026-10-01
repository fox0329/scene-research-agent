/**
 * @scene/web — 表1-1「场景锚」中栏块（可折叠）
 *
 * 为什么折叠：表1-1 是**全链唯一场景定义**，理应常驻；但除第 1 步外，每一步都把
 * 12 行长段落铺一遍就是纯噪音（用户投诉"整个页面大量无效信息"的量化大头）。
 *
 * 口径：
 *  - **第 1 步（场景定义与边界）默认展开**——那一步就是来定义/表态的
 *  - **第 2–8 步默认折叠**——折叠态只给一行摘要（已填几项、核心几项已确认）
 *  - 折叠只记在组件 state（不持久化）；**展开后仍可就地编辑/确认**，能力不丢
 *  - 折叠/展开一定是 `<button>`，`aria-expanded` 正确（键盘可达）
 */

import React, { useId, useState } from "react";
import { AnchorTable } from "./SchemaTable";
import { anchorFoldSummary, type AnchorSummary } from "./definition-progress";

export interface AnchorFoldPanelProps {
  /** 锚行（联真 = 服务端行；演示 = 本地行） */
  rows: readonly Record<string, unknown>[];
  summary: AnchorSummary;
  /** 第 1 步传 true（默认展开）；第 2–8 步缺省折叠 */
  defaultOpen?: boolean;
  /** 就地编辑（联真落库 / 演示改内存）；不传即只读 */
  onCellChange?: (rowId: string, cell: string, value: string) => void;
}

/** 标题右侧的说明（展开/折叠都在，位置不跳） */
const HEAD_NOTE =
  "全链唯一的场景定义；带 ✓ 的是需要你表态的项，其余项可选填、可留「待定」（右栏可表态）";

export const AnchorFoldPanel: React.FC<AnchorFoldPanelProps> = ({
  rows,
  summary,
  defaultOpen = false,
  onCellChange,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const editable = Boolean(onCellChange);

  return (
    <div className="pnl">
      <div className="pnl-h">
        <div>
          <h2>表1-1 场景概述 · 场景锚{editable ? "（可就地编辑）" : "（常驻）"}</h2>
          <p>{HEAD_NOTE}</p>
        </div>
        <button
          type="button"
          className="btn-mini fold-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "收起" : "展开"}
        </button>
      </div>
      {open ? (
        <div className="pnl-b flush" id={bodyId}>
          <AnchorTable
            rows={rows.map((row, i) => ({ id: `anchor-${i}`, row: { ...row } }))}
            {...(editable && onCellChange ? { onCellChange } : { readOnly: true })}
          />
        </div>
      ) : (
        <p className="fold-summary">{anchorFoldSummary(summary)}</p>
      )}
    </div>
  );
};
