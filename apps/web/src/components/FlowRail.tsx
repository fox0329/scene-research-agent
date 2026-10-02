/**
 * @scene/web — 流程进度轴（v1.5 逐页推进）
 *
 * 取代 v1.4 的「8 个阶段并列 tab」：阶段是**数据落库口径**，流程步才是
 * **用户看到的推进单位**。这条轴回答三件事：
 *   ① 我现在在第几步（当前位置）
 *   ② 前面走过哪些步（可点回看）
 *   ③ 这一步能不能走（`ready` + `readyHint` 由服务端数据判定给出）
 *
 * 三条既定规则的落点：
 *  - 「完成本步」是**导航动作**，不是判断：信息缺口只在 hint 里提示，不阻断
 *  - 默认锁步：未解锁节点 `disabled`，另给「解锁全部步骤」
 *  - 已完成步骤可点回看（重跑按钮在该步面板里）
 *
 * 无障碍：`role="tablist"` + `role="tab"` + `aria-selected`，左右方向键可移动，
 * 未解锁节点不进 Tab 序列（disabled）。
 */

import React, { useCallback, useRef } from "react";
import type { ApiFlowStatus } from "../api";

export interface FlowRailProps {
  status: ApiFlowStatus;
  /** 当前正在看的步骤（可能是回看的已完成步骤） */
  activeStep: number;
  onSelectStep: (step: number) => void;
  /** 完成「当前步」并前进（就绪判定由 status 给出） */
  onComplete: () => void;
  onUnlockAll: () => void;
  /** 请求进行中：动作按钮禁用，避免重复提交 */
  busy?: boolean;
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
  onUnlockAll,
  busy = false,
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
      <div
        className="flow-nodes"
        role="tablist"
        aria-label="业务流程步骤"
        onKeyDown={handleKeyDown}
      >
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
              title={`${s.title}：${s.goal}`}
              aria-label={`第 ${s.id} 步 · ${s.title}（${s.state}）`}
              onClick={() => onSelectStep(s.id)}
            >
              <span className="flow-node-no" aria-hidden="true">
                {s.state === "已完成" ? "✓" : s.id}
              </span>
              <span className="flow-node-tt">{s.title}</span>
              {locked ? (
                <span className="flow-node-lock" aria-hidden="true">
                  🔒
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* 当前步就绪提示：缺什么直接说，不作为阻断 */}
      {current ? (
        <p className="flow-hint" role="status">
          <span className="flow-hint-step">
            第 {current.id}/{status.steps.length} 步 · {current.title}
          </span>
          {reviewing ? (
            <span className="flow-hint-text">
              正在回看第 {activeStep} 步；当前应做的是第 {current.id} 步
            </span>
          ) : (
            <span className="flow-hint-text">{current.readyHint}</span>
          )}
        </p>
      ) : null}

      <div className="flow-actions">
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
          完成本步，进入下一步
        </button>
        {reviewing ? (
          <button className="btn" type="button" onClick={() => onSelectStep(status.currentStep)}>
            回到当前步（第 {status.currentStep} 步）
          </button>
        ) : null}
        <button
          className="btn"
          type="button"
          disabled={busy || status.unlockedAll}
          title={
            status.unlockedAll
              ? "已解锁全部步骤，可直接点任一节点"
              : "不想按顺序走？解锁后可直接点任意步骤"
          }
          onClick={onUnlockAll}
        >
          {status.unlockedAll ? "已解锁全部步骤" : "解锁全部步骤"}
        </button>
      </div>
    </div>
  );
};
