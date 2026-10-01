import { describe, it, expect } from "vitest";
import { FLOW_STEPS, FLOW_TOTAL, flowStep, flowStepsOfStage, isAnalysisStep } from "@scene/contract";
import {
  buildFlowStatus,
  nextStep,
  prevStep,
  completionToClearFrom,
  flowBrief,
  type FlowReadiness,
} from "./flow.js";

const notReady = (readyHint = "还没有产出"): FlowReadiness => ({ ready: false, readyHint });

describe("flow — 流程定义（取自注册表）", () => {
  it("共 9 步，步骤号连续", () => {
    expect(FLOW_STEPS).toHaveLength(9);
    expect(FLOW_TOTAL).toBe(9);
    expect(FLOW_STEPS.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("第 2 步是场景定义与边界（表1-1），第 3 步是认识场景且不含表1-1", () => {
    expect(flowStep(2).title).toBe("场景定义与边界");
    expect(flowStep(2).tables).toEqual(["表1-1"]);
    expect(flowStep(2).kind).toBe("确认");

    const s3 = flowStep(3);
    expect(s3.title).toBe("认识场景");
    expect(s3.tables).not.toContain("表1-1");
    expect(s3.tables.length).toBe(7); // 阶段 1 共 8 张，减去场景锚
    expect(s3.kind).toBe("分析");
  });

  it("步骤表集与注册表一致（不重抄表号）", () => {
    expect(flowStep(4).tables).toEqual(["表3-1", "表3-2", "表3-3", "表3-4", "表3-6", "表3-7", "表3-8", "表3-9"]);
    expect(flowStep(8).tables).toEqual(["表7-1"]);
    expect(flowStep(9).tables).toEqual([]);
  });

  it("阶段 1 对应第 2、3 两步；其余阶段各一步", () => {
    expect(flowStepsOfStage(1).map((s) => s.id)).toEqual([2, 3]);
    expect(flowStepsOfStage(2).map((s) => s.id)).toEqual([4]);
    expect(flowStepsOfStage(7).map((s) => s.id)).toEqual([9]);
    // 第 1 步诉求落 scenario_brief，不写 stage_data，因此不属于任何阶段
    expect(flowStep(1).stage).toBeNull();
    expect(flowStepsOfStage(1).some((s) => s.id === 1)).toBe(false);
  });

  it("输入与组装步骤不需要模型分析", () => {
    expect(isAnalysisStep(1)).toBe(false);
    expect(isAnalysisStep(2)).toBe(false);
    expect(isAnalysisStep(3)).toBe(true);
    expect(isAnalysisStep(9)).toBe(false);
  });

  it("越界步骤号抛明确错误", () => {
    expect(() => flowStep(10)).toThrow(/未知流程步骤/);
  });
});

describe("flow — 锁步推进", () => {
  it("全新场景：第 1 步当前，其余全部未解锁", () => {
    const st = buildFlowStatus({ completed: [] });
    expect(st.currentStep).toBe(1);
    expect(st.steps[0]?.state).toBe("当前");
    expect(st.steps.slice(1).every((s) => s.state === "未解锁")).toBe(true);
    expect(st.finished).toBe(false);
    expect(st.completedCount).toBe(0);
  });

  it("完成第 1 步后：第 2 步变当前，第 3 步仍锁", () => {
    const st = buildFlowStatus({ completed: [1] });
    expect(st.currentStep).toBe(2);
    expect(st.steps[0]?.state).toBe("已完成");
    expect(st.steps[1]?.state).toBe("当前");
    expect(st.steps[2]?.state).toBe("未解锁");
  });

  it("解锁全部：未完成步骤都是「可推进」，当前仍是第一个未完成", () => {
    const st = buildFlowStatus({ completed: [1, 2], unlockedAll: true });
    expect(st.currentStep).toBe(3);
    expect(st.steps[2]?.state).toBe("当前");
    expect(st.steps.slice(3).every((s) => s.state === "可推进")).toBe(true);
    expect(st.unlockedAll).toBe(true);
  });

  it("全部完成：finished=true，当前停留在最后一步", () => {
    const st = buildFlowStatus({ completed: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    expect(st.finished).toBe(true);
    expect(st.completedCount).toBe(9);
    expect(st.currentStep).toBe(9);
    expect(st.steps.every((s) => s.state === "已完成")).toBe(true);
  });

  it("乱序/重复/越界的完成记录会被规范化", () => {
    const st = buildFlowStatus({ completed: [3, 1, 1, 99] });
    expect(st.completedCount).toBe(2);
    // 第 2 步未完成 → 第 3 步虽在记录里但状态由集合推导，第 1 步完成后第 2 步是当前
    expect(st.currentStep).toBe(2);
    expect(st.steps[0]?.state).toBe("已完成");
  });
});

describe("flow — 就绪判定（数据判定可用，用户点完成）", () => {
  it("就绪与状态独立：未就绪的当前步仍可查看，但按钮不可点", () => {
    const st = buildFlowStatus({
      completed: [],
      readiness: { 1: notReady("请填写「想搞清楚什么」") },
    });
    expect(st.steps[0]?.state).toBe("当前");
    expect(st.steps[0]?.ready).toBe(false);
    expect(st.steps[0]?.readyHint).toContain("想搞清楚什么");
  });

  it("已完成的步骤恒为 ready（不再提示缺什么）", () => {
    const st = buildFlowStatus({ completed: [1], readiness: { 1: notReady() } });
    expect(st.steps[0]?.ready).toBe(true);
    expect(st.steps[0]?.readyHint).toBe("本步已完成");
  });

  it("进度数据透传（表数与行数）", () => {
    const st = buildFlowStatus({
      completed: [1],
      readiness: {
        2: { ready: false, readyHint: "还有 4 项未确认", progress: { tablesWithData: 1, expectedTables: 1, rows: 12 } },
      },
    });
    expect(st.steps[1]?.progress).toEqual({ tablesWithData: 1, expectedTables: 1, rows: 12 });
  });

  it("缺省就绪信息：未就绪 + 泛化提示", () => {
    const st = buildFlowStatus({ completed: [] });
    expect(st.steps[0]?.ready).toBe(false);
    expect(st.steps[0]?.readyHint).toBe("尚未就绪");
    expect(st.steps[0]?.progress).toEqual({ tablesWithData: 0, expectedTables: 0, rows: 0 });
  });
});

describe("flow — 导航与回退", () => {
  it("next/prev 边界", () => {
    expect(nextStep(1)).toBe(2);
    expect(nextStep(9)).toBeNull();
    expect(prevStep(2)).toBe(1);
    expect(prevStep(1)).toBeNull();
  });

  it("从第 n 步重跑：清掉 n 及其之后的完成标记（数据保留）", () => {
    const clear = completionToClearFrom(4);
    expect([1, 2, 3, 4, 5, 9].filter(clear)).toEqual([4, 5, 9]);
    const st = buildFlowStatus({ completed: [1, 2, 3] });
    expect(st.currentStep).toBe(4);
  });

  it("flowBrief 给左栏与进度轴用的一句话", () => {
    expect(flowBrief(buildFlowStatus({ completed: [] }))).toBe("第 1/9 步 · 场景定义");
    expect(flowBrief(buildFlowStatus({ completed: [1] }))).toBe("第 2/9 步 · 场景定义与边界");
    expect(
      flowBrief(buildFlowStatus({ completed: [1, 2, 3, 4, 5, 6, 7, 8, 9] })),
    ).toBe("已完成全部 9 步");
  });
});
