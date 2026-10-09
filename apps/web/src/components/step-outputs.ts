/**
 * @scene/web — 一步的「输出物」清单（流程轴第二行与中栏共用同一口径）
 *
 * 用户定调（2026-10-06）：「将每个阶段对应的表格行移到阶段名称下面，两行显示，
 * 这样用户上下移动表格内容，表格的名称能始终显示。」「直接将阶段的内容列表，放到上面
 * 场景定义、认识场景、理解商业等几个阶段名称下面就行，用户点击某个阶段下面一行就显示
 * 该阶段的几个输出物。」
 *
 * 于是「输出物 = 这一步行里要产出的东西」：
 *  - 分析步：流程定义 `flowStep(n).tables` 里的表；**多子块表的每块各占一项**
 *    （与中栏 v1.26 的口径一致：架构块 / 接口块各自成"表"，列结构本来就不同）
 *  - 交付物步：不是表，而是**两份**客户端可读的正式交付物——「<场景>解决方案」
 *    与「<场景>建设工作方案」（变更表 #136 / #137）。这两份的 chip 与本步动作一起挂在
 *    **流程轴第二行**（变更表 #148，作废 #147 的"移到中栏"）——由 `DeliveryPanel` 用
 *    `createPortal` 渲染进 `#delivery-row-slot`，所以 `railOutputsOf` 在这一步仍返回空
 *    （这一行的内容不从 `StepOutput` 来，而是面板自己的状态）。
 *
 * 为什么抽出来：流程轴第二行与中栏面板必须**指同一批东西**，靠一个函数保证，
 * 而不是两处各写一套（写歪了就会出现"轴上点了 A、中栏显示 B"）。
 */

import { REPORT_KIND_LABEL, blockLabel, tableDef } from "@scene/contract";
import type { DeliverableKind } from "../api";
import { tableBlocks } from "./SchemaTable";

/** 流程轴第二行 / 中栏共用的输出物口径 */
export interface StepOutput {
  /** 唯一键：表输出物 = 表号（多块表带块名），报告输出物 = 报告 key */
  key: string;
  /** 用户看到的名字（表名 / 表名·块名 / 报告名） */
  label: string;
  /** 表号；报告输出物为 null */
  code: string | null;
  /** 多子块表的块名；单块表与报告为 null */
  block: string | null;
}

/** 交付物这一步的输出物：`key` 直接是交付物口径（solution / construction） */
export interface DeliveryOutput extends StepOutput {
  key: DeliverableKind;
}

/**
 * 交付物这一步的输出物：**两份**（变更表 #137）
 *
 * 名字取自契约 `REPORT_KIND_LABEL`——它同时是报告的一级标题与文件名前缀，
 * 这里写死就会与导出出来的文件名对不上。
 */
export const DELIVERY_OUTPUTS: readonly DeliveryOutput[] = [
  { key: "solution", label: REPORT_KIND_LABEL.solution, code: null, block: null },
  { key: "construction", label: REPORT_KIND_LABEL.construction, code: null, block: null },
];

/** 两份交付物的说明（流程轴第二行 chip 与面板共用）：各一句话说清这份讲什么 */
export const DELIVERY_OUTPUT_HINT: Record<string, string> = {
  solution: "现状 / 场景与问题 / 方案 / 价值 / 下一步——给客户看的「怎么解决」",
  construction: "建设背景 / 目标 / 内容 / 路径 / 安排 / 保障——给客户看的「怎么建」",
};

/** 表集 → 输出物清单（多子块表按块拆项，与中栏 v1.26 口径一致） */
export function stepOutputs(tables: readonly string[]): StepOutput[] {
  return tables.flatMap((code) => {
    const def = tableDef(code);
    const blocks = tableBlocks(code);
    if (blocks.length <= 1) {
      return [{ key: code, label: def?.name ?? code, code, block: null as string | null }];
    }
    return blocks.map((b) => ({
      key: `${code}:${b}`,
      label: def ? blockLabel(def, b) : `${b}块`,
      code,
      block: b as string | null,
    }));
  });
}

/**
 * 流程轴第二行要画的**表类**输出物（变更表 #140 / #148）
 *
 * 交付物这一步返回空：它没有表，第二行的内容（两份交付物 + 本步动作）由 `DeliveryPanel`
 * 自己 portal 进去——不是"轴上不画"，而是**不从这份表清单来**。其余步与 `stepOutputs`
 * 完全一致——表名挂在阶段名下面、滚表格时始终可见（2026-10-06 用户定调，这条不变）。
 */
export function railOutputsOf(stepId: number, tables: readonly string[], totalSteps: number): StepOutput[] {
  return stepId === totalSteps ? [] : stepOutputs(tables);
}
