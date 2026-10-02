/**
 * @scene/contract — 业务流程定义（v1.5 逐页推进）
 *
 * 背景：v1.4 把 8 个阶段并列成 tab，等于**把整套方法论摊开给用户看**——
 * 一进来面对 8 个空表格，不知道从哪下手。v1.5 改为**流程驱动**：
 * 方法论藏在流程里，用户只需要回答"现在这一步"。
 *
 * 与阶段（stage）的关系：
 *  - 阶段是**数据落库口径**（`stage_data.stage`，8 个，稳定不变）
 *  - 流程步是**用户看到的推进单位**（**8 步**）
 *  - 第 1 步（场景定义与边界）与第 2 步（认识场景）同属阶段 1，但表集不重叠：
 *    表1-1 归第 1 步，其余 7 张归第 2 步（模型分析）
 *
 * **第 1 步的属主划分**（2026-09-26 用户定稿）：
 *  - 用户只输入「场景名称」；其余 5 项由智能体从业务角度写出
 *  - 「确认无误」是**一次整表确认**，且**不卡推进**；产品不显示"待确认"
 *
 * **场景定义对话不占流程步**：它是「新建场景」的一部分（独立弹窗），
 * 聊清楚后由用户点「整理成定义」落成表1-1。
 * 这样用户可见的 8 步与底层 8 个阶段（0-7）一一对得上，不再出现两套数字。
 *
 * 因此"本步的表集"是模型输出契约的过滤依据——阶段 1 的分析**不再重复产出场景锚**。
 */

import { tablesOfStage, type InfoStageId } from "./tables.js";

/** 步骤类型——决定「完成本步」的就绪判定方式 */
export type FlowStepKind =
  /** 确认：用户逐项确认系统理解（场景锚 L1）——定义对话在新建场景时完成，不占步 */
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
   * （第 1 步定义写表1-1 与 `scenario_brief`，第 8 步交付物写文档）
   */
  stage: InfoStageId | null;
}

/** 场景锚表号（第 1 步专属） */
const ANCHOR = "表1-1";

/** 认识场景（第 2 步）= 阶段 1 减去场景锚 */
function stage1Tables(): readonly string[] {
  return tablesOfStage(1)
    .map((t) => t.code)
    .filter((c) => c !== ANCHOR);
}

/**
 * 8 步流程（用户可见的推进单位；与底层 8 个阶段**数量对齐、编号不等**：
 * 第 1、2 步同属阶段 1，第 3–8 步依次对应阶段 2–7）
 *
 * 表集全部由注册表派生——流程定义不重抄表号，避免又一处漂移。
 */
export const FLOW_STEPS: readonly FlowStep[] = [
  {
    id: 1,
    key: "anchor",
    title: "场景定义与边界",
    goal:
      "你给出场景名称，智能体从业务角度写出场景业务画像（场景边界 / 生产对象 / 核心生产系统 / 买方类型 / 采购特征）；看一眼、能改，确认即可",
    kind: "确认",
    tables: [ANCHOR],
    stage: 1,
  },
  {
    id: 2,
    key: "stage1",
    title: "认识场景",
    goal: "场景有哪些业务环节、能否参与；要素、架构、硬约束与门槛",
    kind: "分析",
    tables: stage1Tables(),
    stage: 1,
  },
  {
    id: 3,
    key: "stage2",
    title: "理解商业",
    goal: "产业链利润在哪、主流方案形态、竞品对照、没被满足的需求",
    kind: "分析",
    tables: tablesOfStage(2).map((t) => t.code),
    stage: 2,
  },
  {
    id: 4,
    key: "stage3",
    title: "能力匹配",
    goal: "我方能力底账、哪些真能解、哪些要补齐、哪些不能做",
    kind: "分析",
    tables: tablesOfStage(3).map((t) => t.code),
    stage: 3,
  },
  {
    id: 5,
    key: "stage4",
    title: "方案与实现",
    goal: "方案架构与接口、实施路径、成本估算",
    kind: "分析",
    tables: tablesOfStage(4).map((t) => t.code),
    stage: 4,
  },
  {
    id: 6,
    key: "stage5",
    title: "价值与验证",
    goal: "价值与指标、基线、验证方式；试点与验收口径",
    kind: "分析",
    tables: tablesOfStage(5).map((t) => t.code),
    stage: 5,
  },
  {
    id: 7,
    key: "stage6",
    title: "总结沉淀",
    goal: "把本场景可复用的资产与目标沉淀下来",
    kind: "分析",
    tables: tablesOfStage(6).map((t) => t.code),
    stage: 6,
  },
  {
    id: 8,
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

/** 某数据阶段对应哪些流程步（阶段 1 → 第 1、2 步） */
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
