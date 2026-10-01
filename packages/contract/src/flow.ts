/**
 * @scene/contract — 业务流程定义（v1.5 逐页推进）
 *
 * 背景：v1.4 把 8 个阶段并列成 tab，等于**把整套方法论摊开给用户看**——
 * 一进来面对 8 个空表格，不知道从哪下手。v1.5 改为**流程驱动**：
 * 方法论藏在流程里，用户只需要回答"现在这一步"。
 *
 * 与阶段（stage）的关系：
 *  - 阶段是**数据落库口径**（`stage_data.stage`，8 个，稳定不变）
 *  - 流程步是**用户看到的推进单位**（9 步）
 *  - 第 2 步（场景定义与边界）与第 3 步（认识场景）同属阶段 1，但表集不重叠：
 *    表1-1 归第 2 步（诉求起草 + 用户确认），其余 7 张归第 3 步（模型分析）
 *
 * 因此"本步的表集"是模型输出契约的过滤依据——阶段 1 的分析**不再重复产出场景锚**。
 */

import { tablesOfStage, type InfoStageId } from "./tables.js";

/** 步骤类型——决定「完成本步」的就绪判定方式 */
export type FlowStepKind =
  /** 输入：用户填诉求 */
  | "输入"
  /** 确认：用户逐项确认系统理解（场景锚 L1） */
  | "确认"
  /** 分析：模型按表定义产出信息 */
  | "分析"
  /** 组装：系统装配交付物 */
  | "组装";

export interface FlowStep {
  /** 步骤号（1 起，用户可见） */
  id: number;
  /** 稳定键（接口与状态机用） */
  key: string;
  /** 用户看到的标题 */
  title: string;
  /** 这一步要获得什么（一句话） */
  goal: string;
  kind: FlowStepKind;
  /** 本步展示/产出的表号（输入与组装步骤为空） */
  tables: readonly string[];
  /**
   * 数据落库阶段；`null` = 本步不写 `stage_data`
   * （第 1 步诉求写 `scenario_brief`，第 9 步交付物写文档）
   */
  stage: InfoStageId | null;
}

/** 场景锚表号（第 2 步专属） */
const ANCHOR = "表1-1";

/** 认识场景（第 3 步）= 阶段 1 减去场景锚 */
function stage1Tables(): readonly string[] {
  return tablesOfStage(1)
    .map((t) => t.code)
    .filter((c) => c !== ANCHOR);
}

/**
 * 9 步流程（用户可见的推进单位）
 *
 * 表集全部由注册表派生——流程定义不重抄表号，避免又一处漂移。
 */
export const FLOW_STEPS: readonly FlowStep[] = [
  {
    id: 1,
    key: "brief",
    title: "场景诉求",
    goal: "说清要梳理什么场景、想搞清楚什么",
    kind: "输入",
    tables: [],
    stage: null, // 诉求落 scenario_brief，不进 stage_data
  },
  {
    id: 2,
    key: "anchor",
    title: "场景定义与边界",
    goal: "确认系统理解的场景本体：客户是谁、覆盖什么、明确不含什么",
    kind: "确认",
    tables: [ANCHOR],
    stage: 1,
  },
  {
    id: 3,
    key: "stage1",
    title: "认识场景",
    goal: "场景有哪些业务环节、能否参与；要素、架构、硬约束与门槛",
    kind: "分析",
    tables: stage1Tables(),
    stage: 1,
  },
  {
    id: 4,
    key: "stage2",
    title: "理解商业",
    goal: "产业链利润在哪、主流方案形态、竞品对照、没被满足的需求",
    kind: "分析",
    tables: tablesOfStage(2).map((t) => t.code),
    stage: 2,
  },
  {
    id: 5,
    key: "stage3",
    title: "能力匹配",
    goal: "我方能力底账、哪些真能解、哪些要补齐、哪些不能做",
    kind: "分析",
    tables: tablesOfStage(3).map((t) => t.code),
    stage: 3,
  },
  {
    id: 6,
    key: "stage4",
    title: "方案与实现",
    goal: "方案架构与接口、实施路径、成本估算",
    kind: "分析",
    tables: tablesOfStage(4).map((t) => t.code),
    stage: 4,
  },
  {
    id: 7,
    key: "stage5",
    title: "价值与验证",
    goal: "价值与指标、基线、验证方式；试点与验收口径",
    kind: "分析",
    tables: tablesOfStage(5).map((t) => t.code),
    stage: 5,
  },
  {
    id: 8,
    key: "stage6",
    title: "总结沉淀",
    goal: "把本场景可复用的资产与目标沉淀下来",
    kind: "分析",
    tables: tablesOfStage(6).map((t) => t.code),
    stage: 6,
  },
  {
    id: 9,
    key: "delivery",
    title: "交付物",
    goal: "输出内部调研报告与对外汇报材料",
    kind: "组装",
    tables: [],
    stage: 7,
  },
];

/** 流程总步数 */
export const FLOW_TOTAL = FLOW_STEPS.length;

/** 最后一步（完成它 = 场景完成） */
export const FLOW_LAST_STEP = FLOW_STEPS.length;

/** 按步骤号取定义（越界抛错，避免静默返回 undefined） */
export function flowStep(id: number): FlowStep {
  const s = FLOW_STEPS.find((x) => x.id === id);
  if (!s) throw new Error(`未知流程步骤：${id}（共 ${FLOW_TOTAL} 步）`);
  return s;
}

/** 按稳定键取定义 */
export function flowStepByKey(key: string): FlowStep | undefined {
  return FLOW_STEPS.find((s) => s.key === key);
}

/** 某数据阶段对应哪些流程步（阶段 1 → 第 2、3 步；输入步骤不计入任何阶段） */
export function flowStepsOfStage(stage: InfoStageId): readonly FlowStep[] {
  return FLOW_STEPS.filter((s) => s.stage === stage);
}

/** 本步对应的落库阶段（不写 stage_data 的步骤返回 null） */
export function stageOfFlowStep(id: number): InfoStageId | null {
  return flowStep(id).stage;
}

/** 是否是需要模型分析的步骤 */
export function isAnalysisStep(id: number): boolean {
  return flowStep(id).kind === "分析";
}
