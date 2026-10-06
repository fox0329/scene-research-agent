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
 *  - 交付物步：不是表，而是两份报告（内部调研版 / 对外汇报版）
 *
 * 为什么抽出来：流程轴第二行与中栏面板必须**指同一批东西**，靠一个函数保证，
 * 而不是两处各写一套（写歪了就会出现"轴上点了 A、中栏显示 B"）。
 */

import { blockLabel, tableDef } from "@scene/contract";
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

/** 交付物这一步的输出物：两份报告（不是表） */
export const DELIVERY_OUTPUTS: readonly StepOutput[] = [
  { key: "internal", label: "内部调研版", code: null, block: null },
  { key: "external", label: "对外汇报版", code: null, block: null },
];

/** 报告输出物的说明（流程轴 hover 与中栏 chip 共用） */
export const DELIVERY_OUTPUT_HINT: Record<string, string> = {
  internal: "完整信息 + 来源与证据级 + 信息缺口 + 「不做什么」边界声明",
  external: "只保留可对外的事实与结论，含未确认标记的内容会被剔除",
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

/** 一步的输出物：交付物步是两份报告，其余步按流程定义的表集展开 */
export function stepOutputsOf(stepId: number, tables: readonly string[], totalSteps: number): StepOutput[] {
  return stepId === totalSteps ? [...DELIVERY_OUTPUTS] : stepOutputs(tables);
}
