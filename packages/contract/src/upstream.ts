/**
 * 下游依赖表 —— 「哪一步该看哪些上游结论」（变更表 #225）
 *
 * ## 为什么需要这份声明
 *
 * 2026-10-20 审计（`docs/表格精简审计.md` §3.1）发现：`collectUpstreamData` 只把
 * M1–M4 + M6、可选材料与阶段1 全部行带进后续提示词，**阶段2/3/4/5 共 21 张表写完之后
 * 下游一次都没读过**。后果不是「不好看」，而是几处设计承诺直接不成立：
 *
 * - 表4-3 声称「缺口（来自表3-8）」「覆盖表3-8 每条」——生成时读不到表3-8，只能重猜；
 * - 表3-2 写「不写我方，对照在表4-4」、表4-4 写「我方与对手对照」——两边互指却彼此看不见；
 * - 表3-7 写「我们方案里怎么避」——它自己在下游不可见，「怎么避」不影响任何产出。
 *
 * ## 设计约束
 *
 * - **只给结论列**（G-0.3）：每张表只挑能影响下游判断的列，不整表灌入。
 *   例如表3-8 只给「排序/缺口描述/谁在痛/痛到什么程度」，不给「多源验证」的过程列。
 * - **只给中栏**：右栏是溯源与核实留痕（来源/证据等级/核实说明），对下游判断无用，
 *   且 `核实说明` 真实数据均长 136 字/行（共 7.1 万字），灌进去纯烧 token。
 * - **行数封顶**：同一张表最多带 N 行，按业务优先级取（如痛点取排序前 N）。
 * - **单向**：只能引用**更早阶段**的表，由单测强制（`upstream.test.ts`）。
 */

import type { InfoStageId } from "./tables.js";

/** 一条上游依赖 */
export interface UpstreamDep {
  /** 表号 */
  table: string;
  /** 只带这些列（列 key）；缺省 = 该表全部中栏列 */
  columns?: readonly string[];
  /** 行数上限（防止长表撑爆上下文） */
  maxRows: number;
  /** 这一条为什么必须带——写给维护者看，也是单测断言的依据 */
  why: string;
}

/**
 * 阶段 → 上游依赖
 *
 * 阶段内部的表互不依赖（同批并发生成），所以只列**更早**阶段的表。
 * 阶段1 与阶段0 的带法保持原状（`collectUpstreamData` 里已有专门逻辑），这里补充 2–5 的缺口。
 */
export const UPSTREAM_DEPS: Record<number, readonly UpstreamDep[]> = {
  // 阶段 2（理解商业）：阶段1 已由 collectUpstreamData 整包带入，无需在此重复
  2: [],
  // 阶段 3（能力匹配）：要用阶段2 的商业结论来判断「能不能碰」
  3: [
    {
      table: "表3-8",
      columns: ["rank", "gap", "who_hurts", "pain_level"],
      maxRows: 10,
      why: "表4-3 的「缺口（来自表3-8）」必须逐条对应；没有它，覆盖性无法保证（审计 §3.1 点名的第一条断链）",
    },
    {
      table: "表3-2",
      columns: ["key_points", "players", "position", "price_band", "fit_for"],
      maxRows: 12,
      why: "表4-4 的主要对手取自表3-2 的 players；价格带决定我方报价定位",
    },
    {
      table: "表3-5",
      columns: ["link", "who_supplies", "concentration", "substitutability", "bargaining", "supply_risk"],
      maxRows: 10,
      why: "上游被卡点决定表4-2 的参与程度（卡在别人手里的环节我们只能配合）",
    },
  ],
  // 阶段 4（方案实现）：要用阶段3 的参与判定与环节事实
  4: [
    {
      table: "表1-2",
      columns: ["link", "owner_now", "current_tool", "current_flow", "pain"],
      maxRows: 16,
      why: "方案的每一层要落到环节现状上；表4-2 号称逐环节判定，靠的就是它",
    },
    {
      table: "表4-2",
      columns: ["link", "our_role", "our_scope"],
      maxRows: 16,
      why: "我方角色决定方案边界（只能配合的环节不该出整包方案）",
    },
    {
      table: "表4-3",
      columns: ["gap_ref", "match", "our_product", "action"],
      maxRows: 16,
      why: "匹配判定为「不能做」的缺口，方案里必须留边界声明，不能装作能解",
    },
    {
      table: "表3-8",
      columns: ["gap", "acceptance"],
      maxRows: 10,
      why: "验收条件要落成方案约束与合同条款，否则这张表白填",
    },
    {
      table: "表3-8",
      columns: ["gap", "acceptance"],
      maxRows: 8,
      why: "「为什么现在能打」的具名窗口决定实施排期（表5-3 的「窗口」列）",
    },
  ],
  // 阶段 5（交付物）：报告要引前序结论，而不只是表1-1
  5: [
    {
      table: "表4-2",
      columns: ["link", "our_role", "our_scope"],
      maxRows: 16,
      why: "交付物要讲「我方以什么角色进这个场景」，这是客户最关心的一句",
    },
    {
      table: "表4-4",
      columns: ["sub_scene", "opponent", "win_loss", "entry_action"],
      maxRows: 12,
      why: "赢面要给到「对谁、强还是弱、第一件事做什么」，不给伪精度的加权总分",
    },
    {
      table: "表3-8",
      columns: ["gap", "acceptance"],
      maxRows: 10,
      why: "客户最认「同行踩过的坑我们怎么避」，交付物里必须出现",
    },
    {
      table: "表3-8",
      columns: ["rank", "gap", "who_hurts", "pain_level"],
      maxRows: 10,
      why: "需求侧证据是方案说服力的来源",
    },
  ],
};

/** 取某阶段的上游依赖（缺省空） */
export function upstreamDepsOf(stage: number): readonly UpstreamDep[] {
  return UPSTREAM_DEPS[stage] ?? [];
}

/**
 * 该依赖能否被 stage 使用
 *
 * 单向约束：只允许引用更早阶段的表。这条规则由单测强制，
 * 防止以后有人手滑写出「阶段3 依赖阶段3 的表」——那是并发死锁。
 */
export function isUpstreamAllowed(stage: InfoStageId, dep: UpstreamDep, stageOf: (code: string) => number | null): boolean {
  const s = stageOf(dep.table);
  return s !== null && s < stage;
}
