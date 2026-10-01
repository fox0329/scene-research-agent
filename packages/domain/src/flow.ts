/**
 * flow — 业务流程推进状态机（v1.5 逐页推进）
 *
 * 三条既定规则的落点：
 *  1. **数据判定可用 + 用户显式推进**：本模块只算"能不能点『完成本步』"（`ready`），
 *     不做"自动完成"——走不走由用户点（与「不齐备不阻断」一致：门槛在**流程步进**上，
 *     不在**信息完备度**上）。
 *  2. **默认锁步**：第 n 步未完成则第 n+1 步处于「未解锁」；`unlockedAll` 可一键解锁全部。
 *  3. **已完成步骤可回看/重跑**：状态由"已完成集合"推导，回退只需从集合里去掉后缀。
 *
 * 纯函数、无 IO——就绪判定所需的数据由服务端算好传入。
 */

import { FLOW_STEPS, FLOW_TOTAL, type FlowStep, type FlowStepKind } from "@scene/contract";

/** 步骤状态（用户可见） */
export type FlowStepState =
  /** 已完成 */
  | "已完成"
  /** 当前应做的那一步（第一个未完成） */
  | "当前"
  /** 已解锁但还没轮到（解锁全部时会出现） */
  | "可推进"
  /** 前一步未完成，锁着 */
  | "未解锁";

/** 本步表的产出情况（进度展示用） */
export interface FlowStepProgress {
  tablesWithData: number;
  expectedTables: number;
  rows: number;
}

/** 服务端算好的就绪判定 */
export interface FlowReadiness {
  ready: boolean;
  /** 未就绪时缺什么（人话，直接显示给用户） */
  readyHint: string;
  progress?: FlowStepProgress;
}

export interface FlowStepStatus {
  id: number;
  key: string;
  title: string;
  goal: string;
  kind: FlowStepKind;
  state: FlowStepState;
  /** 「完成本步」是否可点（数据判定） */
  ready: boolean;
  readyHint: string;
  progress: FlowStepProgress;
}

export interface FlowStatus {
  steps: readonly FlowStepStatus[];
  /** 当前应做步骤号（全部完成时为最后一步号） */
  currentStep: number;
  completedCount: number;
  unlockedAll: boolean;
  finished: boolean;
}

const EMPTY_PROGRESS: FlowStepProgress = { tablesWithData: 0, expectedTables: 0, rows: 0 };

/**
 * 推导流程状态
 *
 * @param input.completed 已完成的步骤号（顺序无关，越界/重复会被规范掉）
 * @param input.unlockedAll 是否已「解锁全部步骤」
 * @param input.readiness 每步的就绪判定（缺省视为未就绪）
 * @param input.steps 流程定义（缺省用 FLOW_STEPS，便于测试注入）
 */
export function buildFlowStatus(input: {
  completed: readonly number[];
  unlockedAll?: boolean;
  readiness?: Readonly<Record<number, FlowReadiness>>;
  steps?: readonly FlowStep[];
}): FlowStatus {
  const steps = input.steps ?? FLOW_STEPS;
  const unlockedAll = input.unlockedAll === true;
  const validIds = new Set(steps.map((s) => s.id));
  const done = new Set(input.completed.filter((id) => validIds.has(id)));

  const firstUndone = steps.find((s) => !done.has(s.id));
  const currentStep = firstUndone ? firstUndone.id : (steps[steps.length - 1]?.id ?? 1);

  const statuses: FlowStepStatus[] = steps.map((s) => {
    const isDone = done.has(s.id);
    // 锁步判定：前面每一步都完成才算解锁（解锁全部时全解锁）
    const prevAllDone = steps.filter((x) => x.id < s.id).every((x) => done.has(x.id));
    const state: FlowStepState = isDone
      ? "已完成"
      : s.id === currentStep
        ? "当前"
        : unlockedAll || prevAllDone
          ? "可推进"
          : "未解锁";
    const r = input.readiness?.[s.id];
    return {
      id: s.id,
      key: s.key,
      title: s.title,
      goal: s.goal,
      kind: s.kind,
      state,
      ready: isDone ? true : (r?.ready ?? false),
      readyHint: isDone ? "本步已完成" : (r?.readyHint ?? "尚未就绪"),
      progress: r?.progress ?? EMPTY_PROGRESS,
    };
  });

  return {
    steps: statuses,
    currentStep,
    completedCount: done.size,
    unlockedAll,
    finished: done.size === steps.length,
  };
}

/** 下一步（已是最后一步返回 null） */
export function nextStep(id: number): number | null {
  return id < FLOW_TOTAL ? id + 1 : null;
}

/** 上一步（已是第一步返回 null） */
export function prevStep(id: number): number | null {
  return id > 1 ? id - 1 : null;
}

/**
 * 从第 n 步重跑时要清掉的完成标记
 *
 * 「可随时回到任一已完成步骤重跑并更新交付物」——重跑第 n 步意味着
 * 第 n 步及其之后的完成状态都不再成立（数据保留，由既有的失效/重算语义处理）。
 */
export function completionToClearFrom(stepId: number): (id: number) => boolean {
  return (id: number) => id >= stepId;
}

/** 流程状态 → 一句话概览（左栏场景列表与顶部进度轴用） */
export function flowBrief(status: FlowStatus): string {
  if (status.finished) return `已完成全部 ${FLOW_TOTAL} 步`;
  const cur = status.steps.find((s) => s.id === status.currentStep);
  return `第 ${status.currentStep}/${FLOW_TOTAL} 步 · ${cur?.title ?? ""}`;
}
