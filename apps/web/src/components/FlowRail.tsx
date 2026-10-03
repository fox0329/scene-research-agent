/**
 * @scene/web — 流程进度卡（v1.5 逐页推进 / v2.9 压成一行）
 *
 * 取代 v1.4 的「8 个阶段并列 tab」：阶段是**数据落库口径**，流程步才是
 * **用户看到的推进单位**。这张卡回答三件事：
 *   ① 我现在在第几步（当前位置）
 *   ② 前面走过哪些步（可点回看）
 *   ③ 这一步能不能走（`ready` + `readyHint` 由服务端数据判定给出）
 *
 * 用户定调（v2.9）：
 *  - **只一行显示**：8 个节点 + 行末一个「下一步」按钮，不再有第二行提示、
 *    不再有「解锁全部步骤」（这个功能不需要）
 *  - **只放关键词**：节点显示 `short`（场景定义 / 认识场景 / 能力匹配 …），
 *    完整标题进 `title` 与 `aria-label`——**不要圆点**（"不要只有原点，保留比如
 *    场景定义、能力匹配这些关键词"／"圆点可以不用"），位置与状态靠顺序、颜色与高亮表达
 *  - 就绪提示不单独占一行，改为按钮的悬停提示
 *  - **按钮位按数据换语义**（v1.20，用户定调「中栏不放按钮，上面有下一步」）：
 *    本步还没产出 → 这个位置是「开始本步分析」（跑完停在原步，看完再点「下一步」）；
 *    已产出 → 多一个次级「重算本步」，主按钮位还给「下一步」
 *  - **八步同形**（v1.23，用户定调「都与认识场景保持一致」）：第 1 步（确认步）的运行入口
 *    以前挂在中栏（「场景定义对话」按钮 + 「回到这一步重跑」提示条），现与其它 7 步完全同形：
 *    同一个位置、同一套按钮、同一套说法；回看历史步时多一个「回到这一步」（清完成标记）
 *  - 中栏调窄：关键词**永不隐藏**，先收紧间距，实在放不下时节点条横向可滚（按钮固定在最右）
 *
 * 无障碍：`role="tablist"` + `role="tab"` + `aria-selected`，左右方向键可移动；
 * 未解锁节点不进 Tab 序列（disabled），`aria-label` 仍带「第 n 步 · 标题」。
 */

import React, { useCallback, useRef } from "react";
import type { ApiFlowStatus } from "../api";

/** 流程轴上的运行按钮（八步同形） */
export interface RailRunAction {
  running: boolean;
  elapsedLabel: string;
  /** 本步已有产出：主按钮位让给「下一步」，运行按钮降为次级「重算本步」 */
  ready: boolean;
  /** hover 说明（就绪提示只在流程轴出现，不占第二行） */
  hint: string;
  /** hover 覆盖：第 1 步要说清"点了会打开场景定义对话" */
  title?: string;
  /** 运行中的最新一行进度（只在当前步显示，回看历史步不显示） */
  progress?: string;
  onStart: () => void;
}

export interface FlowRailProps {
  status: ApiFlowStatus;
  activeStep: number;
  busy: boolean;
  onSelectStep: (id: number) => void;
  onComplete: () => void;
  /** 运行本步（分析步 = 跑模型；第 1 步 = 打开场景定义对话） */
  run?: RailRunAction;
  /** 回看历史步时才有：回到这一步重跑（清该步及其后的完成标记，数据保留） */
  reopen?: { title: string; onStart: () => void };
}

/** 步骤状态 → 节点样式后缀 */
const STATE_CLASS: Record<string, string> = {
  已完成: "done",
  当前: "current",
  可推进: "ready",
  未解锁: "locked",
};

export const FlowRail: React.FC<FlowRailProps> = ({
  status,
  activeStep,
  onSelectStep,
  onComplete,
  busy = false,
  run,
  reopen,
}) => {
  const nodeRefs = useRef<Record<number, HTMLButtonElement | null>>({});

  const current = status.steps.find((s) => s.id === status.currentStep) ?? status.steps[0];
  const reviewing = activeStep !== status.currentStep;

  /** 左右方向键在可点节点间移动（Tab 组键盘规范） */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const selectable = status.steps.filter((s) => s.state !== "未解锁");
      const at = selectable.findIndex((s) => s.id === activeStep);
      if (at < 0) return;
      const next = selectable[at + (e.key === "ArrowRight" ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      onSelectStep(next.id);
      nodeRefs.current[next.id]?.focus();
    },
    [status.steps, activeStep, onSelectStep],
  );

  return (
    <div className="flow-rail">
      {/* 节点条：只放 tab（ARIA：tablist 里不放普通按钮）；放不下时它自己横滚 */}
      <div className="flow-nodes" role="tablist" aria-label="业务流程步骤" onKeyDown={handleKeyDown}>
        {status.steps.map((s) => {
          const locked = s.state === "未解锁";
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === activeStep}
              ref={(el) => {
                nodeRefs.current[s.id] = el;
              }}
              className={`flow-node flow-node--${STATE_CLASS[s.state] ?? "ready"}`}
              disabled={locked}
              title={`第 ${s.id} 步 · ${s.title}：${s.goal}`}
              aria-label={`第 ${s.id} 步 · ${s.title}（${s.state}）`}
              onClick={() => onSelectStep(s.id)}
            >
              {/* 关键词（简化标题）；完整标题在 title / aria-label 里 */}
              <span className="flow-node-tt">{s.short}</span>
            </button>
          );
        })}

      </div>

      {/* 行末动作：就绪提示进 title（不占第二行）；按钮不进 tablist，也不随节点滚动 */}
      <div className="flow-actions">
          {/* 已有产出：运行按钮降为次级「重算本步」，主按钮位还给「下一步」 */}
          {run?.ready ? (
            <button
              className="btn"
              type="button"
              disabled={busy || run.running}
              title={run.running ? (run.progress ?? "分析进行中…") : (run.title ?? "本步已经跑过一次：想换一版就重算（结果会覆盖本步表格）")}
              onClick={run.onStart}
            >
              {run.running ? `分析中 ${run.elapsedLabel}` : "重算本步"}
            </button>
          ) : null}

          {run && !run.ready ? (
            <button
              className="btn primary"
              type="button"
              disabled={busy || run.running}
              title={run.running ? (run.progress ?? "分析进行中…") : (run.title ?? `${run.hint}——跑完停在这一步，看完结果再点「下一步」`)}
              onClick={run.onStart}
            >
              {run.running ? `分析中 ${run.elapsedLabel}` : "开始本步分析"}
            </button>
          ) : (
            <button
              className="btn primary"
              type="button"
              disabled={busy || reviewing || !current?.ready}
              title={
                reviewing
                  ? `正在回看第 ${activeStep} 步；先回到当前步再推进`
                  : (current?.readyHint ?? "")
              }
              onClick={onComplete}
            >
              下一步
            </button>
          )}

          {/* 回看历史步：回到这一步重跑（清该步及其后的完成标记，数据保留） */}
          {reopen ? (
            <button className="btn" type="button" disabled={busy} title={reopen.title} onClick={reopen.onStart}>
              回到这一步
            </button>
          ) : null}
          {reviewing ? (
            <button className="btn" type="button" onClick={() => onSelectStep(status.currentStep)}>
              回到当前步
            </button>
          ) : null}
      </div>
    </div>
  );
};
