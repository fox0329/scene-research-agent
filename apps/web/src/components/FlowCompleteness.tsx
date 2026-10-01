/**
 * @scene/web — 全流程信息完整度状态行（v1.5）
 *
 * 用户看到的推进单位是「第 n/8 步」，但信息底账是**全流程**的：
 * 这条状态行把每一步的表集产出汇总成一句话，让用户随时知道"现在手里有多少信息"。
 * 只说明数量，不给判定（与右栏完整度口径一致）。
 */

import React from "react";
import type { ApiFlowStatus } from "../api";

export const FlowCompleteness: React.FC<{ flow: ApiFlowStatus }> = ({ flow }) => {
  const expected = flow.steps.reduce((n, s) => n + s.progress.expectedTables, 0);
  const withData = flow.steps.reduce((n, s) => n + s.progress.tablesWithData, 0);
  const rows = flow.steps.reduce((n, s) => n + s.progress.rows, 0);
  const percent = expected > 0 ? Math.round((withData / expected) * 100) : 0;

  return (
    <div className="completeness-bar">
      <span>
        信息完整度 {withData}/{expected} 张表（全流程 {percent}%）
      </span>
      <span className="gap-count">
        第 {flow.currentStep}/{flow.steps.length} 步 · 已完成 {flow.completedCount} 步
      </span>
      <span className="gap-none">{rows} 行信息已落库</span>
    </div>
  );
};
