/**
 * @scene/web — 中栏面板的两行粘性表头
 *
 * 用户定调（2026-10-06）：「将每个阶段对应的表格行移到阶段名称下面，两行显示，
 * 这样用户上下移动表格内容，表格的名称能始终显示。」
 *
 *  - 第 1 行：阶段名称（第 n 步 · 能力匹配）+ 可选右侧动作
 *  - 第 2 行：本步的「表名」chip（交付物那一步放的是两份报告）
 *
 * 为什么抽成组件：联真（RealStagePanel）/ 演示（DemoStagePanel）/ 交付物（DeliveryPanel）
 * 三处结构必须一致，靠一个组件保证，而不是三份手写样式。
 */

import React from "react";

export interface PanelHeadProps {
  /** 流程步骤号（用户可见的 1–7）；缺省只显示名称 */
  stepId?: number;
  /** 阶段/步骤名称，如「能力匹配」 */
  label: string;
  /** 右侧动作区（如交付物的「生成并导出交付物」） */
  actions?: React.ReactNode;
  /** 第二行内容：表名 chip / 报告切换 chip */
  children?: React.ReactNode;
}

export const PanelHead: React.FC<PanelHeadProps> = ({ stepId, label, actions, children }) => (
  <div className="pnl-head">
    <div className="pnl-h">
      <h2>{stepId === undefined ? label : `第 ${stepId} 步 · ${label}`}</h2>
      {actions ? <div className="pnl-actions">{actions}</div> : null}
    </div>
    {children ? <div className="table-chips table-chips--single">{children}</div> : null}
  </div>
);
