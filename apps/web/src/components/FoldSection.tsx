/**
 * @scene/web — FoldSection：页面级折叠块（纯前端 state，不持久化）
 *
 * 为什么抽成一个件：中栏表1-1 与右栏阶段总结都要"默认收起 + 一行摘要 + 展开"，
 * 两处若各写一套按钮/aria 必然漂移。这里只负责**壳**：
 *  - 折叠/展开一定用 `<button>`，`aria-expanded` / `aria-controls` 齐备（键盘可达）
 *  - 摘要文案由调用方给（本件不猜口径）
 *  - 展开内容由调用方渲染，收起时**不挂载**（中栏大表的渲染成本随之省掉）
 */

import React, { useId, useState } from "react";

export interface FoldSectionProps {
  /** 标题（折叠态与展开态同一处显示，保持位置稳定） */
  title: React.ReactNode;
  /** 折叠态摘要 —— 一行说完"里面有什么" */
  summary: React.ReactNode;
  /** 初始是否展开（组件内 state，不持久化） */
  defaultOpen?: boolean;
  /** 展开后的内容 */
  children: React.ReactNode;
  /** 展开/收起按钮文案（缺省「展开」/「收起」） */
  expandLabel?: string;
  collapseLabel?: string;
}

export const FoldSection: React.FC<FoldSectionProps> = ({
  title,
  summary,
  defaultOpen = false,
  children,
  expandLabel = "展开",
  collapseLabel = "收起",
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  return (
    <div className="fold-block">
      <div className="fold-head">
        <div className="fold-title">{title}</div>
        <button
          type="button"
          className="btn-mini fold-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? collapseLabel : expandLabel}
        </button>
      </div>
      {open ? (
        <div id={bodyId}>{children}</div>
      ) : (
        <p className="fold-summary">{summary}</p>
      )}
    </div>
  );
};
