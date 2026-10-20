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
  it("共 7 步，步骤号连续（用户可见步数与底层 7 阶段对齐）", () => {
    expect(FLOW_STEPS).toHaveLength(7);
    expect(FLOW_TOTAL).toBe(7);
    expect(FLOW_STEPS.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("第 1 步是场景定义与边界（表1-1），第 2 步是认识场景且不含表1-1", () => {
    expect(flowStep(1).title).toBe("场景定义与边界");
    expect(flowStep(1).tables).toEqual(["表1-1"]);
    expect(flowStep(1).kind).toBe("确认");

    const s2 = flowStep(2);
    expect(s2.title).toBe("认识场景");
    expect(s2.tables).not.toContain("表1-1");
    expect(s2.tables.length).toBe(5); // 阶段 1 共 6 张，减去场景锚（表1-2 已迁到阶段 3）
    expect(s2.kind).toBe("分析");
  });

  it("场景定义对话不占流程步（没有 stage=null 的输入步）", () => {
    // 定义对话是「新建场景」的一部分：它的结果落表1-1，在第 1 步被逐项确认
    expect(FLOW_STEPS.some((s) => s.stage === null)).toBe(false);
    expect(FLOW_STEPS.some((s) => s.key === "definition")).toBe(false);
  });

  it("步骤表集与注册表一致（不重抄表号）", () => {
    expect(flowStep(3).tables).toEqual(["表3-1", "表3-2", "表3-3", "表3-5", "表3-8"]);
    /* 2026-10-14：客户现状随能力匹配落在第 4 步（表1-2 场景环节地图）
     * 2026-10-20：表2-7 交付与运维现状已删除、表3-6 替代方案并入表3-4（变更表 #226） */
    expect(flowStep(4).tables).toEqual(["表1-2", "表4-1", "表4-2", "表4-3", "表4-4"]);
    expect(flowStep(7).tables).toEqual([]); // 交付物：文档组装，不产表
  });

  it("阶段 1 对应第 1、2 两步；其余阶段各一步", () => {
    expect(flowStepsOfStage(1).map((s) => s.id)).toEqual([1, 2]);
    expect(flowStepsOfStage(2).map((s) => s.id)).toEqual([3]);
    expect(flowStepsOfStage(6).map((s) => s.id)).toEqual([7]);
  });

  it("组装步骤不需要模型分析", () => {
    expect(isAnalysisStep(1)).toBe(false); // 确认
    expect(isAnalysisStep(2)).toBe(true);
    expect(isAnalysisStep(6)).toBe(true); // 阶段 5 价值与验证
    expect(isAnalysisStep(7)).toBe(false); // 组装：交付物
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

  it("锁步：第 3 步是当前，之后全部「未解锁」（没有解锁全部这个后门）", () => {
    const st = buildFlowStatus({ completed: [1, 2] });
    expect(st.currentStep).toBe(3);
    expect(st.steps[2]?.state).toBe("当前");
    expect(st.steps.slice(3).every((s) => s.state === "未解锁")).toBe(true);
  });

  it("全部完成：finished=true，当前停留在最后一步", () => {
    const st = buildFlowStatus({ completed: [1, 2, 3, 4, 5, 6, 7] });
    expect(st.finished).toBe(true);
    expect(st.completedCount).toBe(7);
    expect(st.currentStep).toBe(7);
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
    expect(nextStep(8)).toBeNull();
    expect(prevStep(2)).toBe(1);
    expect(prevStep(1)).toBeNull();
  });

  it("从第 n 步重跑：清掉 n 及其之后的完成标记（数据保留）", () => {
    const clear = completionToClearFrom(4);
    expect([1, 2, 3, 4, 5, 8].filter(clear)).toEqual([4, 5, 8]);
    const st = buildFlowStatus({ completed: [1, 2, 3] });
    expect(st.currentStep).toBe(4);
  });

  it("flowBrief 给左栏与进度轴用的一句话", () => {
    expect(flowBrief(buildFlowStatus({ completed: [] }))).toBe("第 1/7 步 · 场景定义与边界");
    expect(flowBrief(buildFlowStatus({ completed: [1] }))).toBe("第 2/7 步 · 认识场景");
    expect(
      flowBrief(buildFlowStatus({ completed: [1, 2, 3, 4, 5, 6, 7] })),
    ).toBe("已完成全部 7 步");
  });
});
