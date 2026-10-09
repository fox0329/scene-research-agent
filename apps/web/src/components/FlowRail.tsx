/**
 * @scene/web — 流程进度卡（v1.5 逐页推进 / v2.9 压成一行 / 2026-10-06 恢复两行）
 *
 * 取代 v1.4 的「8 个阶段并列 tab」：阶段是**数据落库口径**，流程步才是
 * **用户看到的推进单位**。这张卡回答四件事：
 *   ① 我现在在第几步（当前位置）
 *   ② 前面走过哪些步（可点回看）
 *   ③ 这一步能不能走（`ready` + `readyHint` 由服务端数据判定给出）
 *   ④ **这一步的输出物有哪些，我现在看的是哪一个**（第二行）
 *
 * 用户定调（2026-10-06，推翻 v2.9 的「只一行」）：
 *  「将每个阶段对应的表格行移到阶段名称下面，两行显示，这样用户上下移动表格内容，
 *   表格的名称能始终显示。」「直接将阶段的内容列表，放到上面场景定义、认识场景、
 *   理解商业等几个阶段名称下面就行，用户点击某个阶段下面一行就显示该阶段的几个输出物。」
 *  → 第一行＝7 个阶段名 + 行末动作（原样）；第二行＝**当前正在看的那一步**的输出物
 *    （表/子块，交付物步是两份报告）。第二行属于**当前步**，流程轴因此恒为两行、不变高。
 *  → 输出物名字放在这里的关键理由：流程轴在中栏滚动容器 `.ws` **外面**，
 *    用户上下滚表格时它始终可见（这正是用户要解决的问题）。
 *
 * 用户两次纠正后的定调（2026-10-08，变更表 #148，作废 #147）：
 *  「不是把交付物放下来　是把解决方案　工作方案　重新生成报告　编辑　导出这些全部移上去　
 *   比如现在方案实现阶段所有的输出表格的名称不就直接在方案实现下面一行吗？」
 *  → 交付物这一步的第二行**就是别的步显示表名的那一行**：左边两份交付物的 chip、
 *    右边本步动作（生成报告 / 编辑 / 导出 Word / PPT / Markdown）。整行由 `DeliveryPanel`
 *    用 `createPortal` 渲染进 `#delivery-row-slot`（状态仍在面板里），中栏不再有这一行，
 *    #147 加的「交付物」标题行一并撤掉。
 *
 * 用户定调（v2.9，仍有效）：
 *  - 节点只放关键词（场景定义 / 认识场景 / 能力匹配 …），完整标题进 `title` 与 `aria-label`
 *  - **只放关键词**：节点显示 `short`（场景定义 / 认识场景 / 能力匹配 …），
 *    完整标题进 `title` 与 `aria-label`——**不要圆点**（"不要只有原点，保留比如
 *    场景定义、能力匹配这些关键词"／"圆点可以不用"），位置与状态靠顺序、颜色与高亮表达
 *  - 就绪提示不单独占一行，改为按钮的悬停提示
 *  - **按钮位按数据换语义**（v1.20，用户定调「中栏不放按钮，上面有下一步」）：
 *    本步还没产出 → 这个位置是「开始本步分析」（跑完停在原步，看完再点「下一步」）；
 *    已产出 → 多一个次级「重算本步」，主按钮位还给「下一步」
 *  - **八步同形**（v1.23/v1.24，用户定调「都与认识场景保持一致」「场景定义也只要重算本步、
 *    下一步就行了」）：八步的动作一律只有这两个——「重算本步」（还没产出时是「开始本步分析」）
 *    与「下一步」。**回到哪一步直接点阶段名称**（用户定调），所以流程轴上没有「回到这一步」
 *    「回到当前步」这类导航按钮
 *  - 中栏调窄：关键词**永不隐藏**，先收紧间距，实在放不下时节点条横向可滚（按钮固定在最右）
 *
 * 无障碍：`role="tablist"` + `role="tab"` + `aria-selected`，左右方向键可移动；
 * 未解锁节点不进 Tab 序列（disabled），`aria-label` 仍带「第 n 步 · 标题」。
 */

import React, { useCallback, useRef } from "react";
import type { ApiFlowStatus } from "../api";
import { DELIVERY_OUTPUT_HINT, type StepOutput } from "./step-outputs";
import { FLOW_TOTAL } from "@scene/contract";

/** 交付物这一步的第二行落点：整行由 `DeliveryPanel` 用 `createPortal` 渲染进来（变更表 #148） */
export const DELIVERY_ROW_ID = "delivery-row-slot";

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
  /** 第二行：当前正在看的那一步的输出物（表/子块）。
      交付物这一步不从这里来——它的第二行由 `DeliveryPanel` portal 进来（变更表 #148） */
  outputs?: readonly StepOutput[];
  /** 第二行高亮哪一项：中栏此刻显示的那个 */
  activeOutputKey?: string | null;
  onSelectOutput?: (o: StepOutput) => void;
}

/** 输出物 chip 的悬停说明：报告用它自己的口径说明，表就用表名
    （用户定调 2026-10-09：表号不上界面，「有名称就够了」，悬停里也不再带表号） */
function outputHint(o: StepOutput): string {
  if (o.code === null) return DELIVERY_OUTPUT_HINT[o.key] ?? o.label;
  return o.label;
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
  outputs,
  activeOutputKey,
  onSelectOutput,
}) => {
  const nodeRefs = useRef<Record<number, HTMLButtonElement | null>>({});

  const current = status.steps.find((s) => s.id === status.currentStep) ?? status.steps[0];
  const reviewing = activeStep !== status.currentStep;
  /** 交付物这一步：第二行放的不是表名，而是两份交付物与本步动作（由 DeliveryPanel portal 进来） */
  const isDelivery = activeStep === FLOW_TOTAL;
  /** 第二行什么时候出现：有输出物，或者就是交付物这一步（它没有表，但这一行有东西要放） */
  const showOutputs = isDelivery || (outputs?.length ?? 0) > 0;

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
      {/* 第一行：阶段名（tablist）+ 行末动作 */}
      <div className="flow-rail-top">
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
                title={
                  run.running
                    ? /* 刷新后重新接上的运行没有本地计时（elapsedLabel 为空），此时不硬凑"已用" */
                      `${run.progress ?? "分析进行中…"}${run.elapsedLabel ? `（已用 ${run.elapsedLabel}）` : ""}`
                    : (run.title ?? "本步已经跑过一次：想换一版就重算（结果会覆盖本步表格）")
                }
                onClick={run.onStart}
              >
                {run.running ? "分析中" : "重算本步"}
              </button>
            ) : null}

            {run && !run.ready ? (
              <button
                className="btn primary"
                type="button"
                disabled={busy || run.running}
                title={
                  run.running
                    ? /* 刷新后重新接上的运行没有本地计时（elapsedLabel 为空），此时不硬凑"已用" */
                      `${run.progress ?? "分析进行中…"}${run.elapsedLabel ? `（已用 ${run.elapsedLabel}）` : ""}`
                    : (run.title ?? `${run.hint}——跑完停在这一步，看完结果再点「下一步」`)
                }
                onClick={run.onStart}
              >
                {run.running ? "分析中" : "开始本步分析"}
              </button>
            ) : (
              <button
                className="btn primary"
                type="button"
                disabled={busy || reviewing || !current?.ready}
                title={
                  reviewing
                    ? `正在回看第 ${activeStep} 步；点流程轴上的「${current?.short ?? ""}」回到当前步即可推进`
                    : (current?.readyHint ?? "")
                }
                onClick={onComplete}
              >
                {/* 最后一步（交付物）没有"下一个"可去：点它就是**完成交付物**（变更表 #178）。
                   以前一律写「下一步」，用户看不出这一步靠什么收尾——项目就卡在 6/7，
                    交付物那格永远是"当前"（蓝）而不是"已完成"（绿）。 */}
                {current?.kind === "组装" ? "完成交付物" : "下一步"}
              </button>
            )}

      </div>
      </div>

      {/* 第二行：当前正在看的那一步的输出物。流程轴在滚动容器 .ws 外面 →
          用户上下滚表格时这一行始终可见（这正是用户要的"表格的名称能始终显示"）。
          没有输出物的步不占这一行；**交付物这一步例外**（变更表 #148）：它没有表，
          但这一行要放「两份交付物 + 本步动作」，整行由 `DeliveryPanel` 用 createPortal
          渲染进这个容器（状态仍留在面板里，见 DeliveryPanel）。 */}
      {showOutputs ? (
        <div
          className="flow-outputs"
          aria-label={isDelivery ? "交付物与动作" : `第 ${activeStep} 步的输出物`}
        >
          {isDelivery ? (
            <div className="flow-outputs-row" id={DELIVERY_ROW_ID} />
          ) : (
            outputs?.map((o) => (
              <button
                key={o.key}
                type="button"
                className={`chip${activeOutputKey === o.key ? " active" : ""}`}
                title={outputHint(o)}
                aria-pressed={activeOutputKey === o.key}
                onClick={() => onSelectOutput?.(o)}
              >
                {o.label}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
};
