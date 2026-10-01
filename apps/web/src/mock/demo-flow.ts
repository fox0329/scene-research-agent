/**
 * @scene/web — 演示模式的流程数据（无后端）
 *
 * 演示态与联真态**共用同一套流程口径**：
 *  - 8 步定义来自 `@scene/contract` 的 `FLOW_STEPS`（不重抄表号/标题）
 *  - 状态推导用 `@scene/domain` 的 `buildFlowStatus`（不重写状态机）
 *  - 只有"就绪判定的数据从哪来"不同：联真是服务端算好的，这里是本地示例数据
 *
 * 这样 E2E 在演示模式下断言的流程轴行为，与联真态是同一份逻辑。
 */

import { FLOW_STEPS, STAGE_DEFS, tablesOfStage, type InfoStageId } from "@scene/contract";
import {
  buildChecklist,
  buildFlowStatus,
  buildStageSummary,
  checkStageCompleteness,
  l1Rows,
  type FlowReadiness,
  type InfoRow,
} from "@scene/domain";
import { asSourceType, type ChecklistViewItem } from "../components/stage-snapshot";
import type {
  ApiAnchorRow,
  ApiDefinitionAlignment,
  ApiDefinitionConsolidation,
  ApiDefinitionMessage,
  ApiFlowStatus,
} from "../api";

/** 演示用的场景锚（表1-1） */
export const DEMO_ANCHOR: ApiAnchorRow[] = [
  { item: "场景名称", content: "智慧水务", source_type: "用户补充" },
  { item: "客户类型/行业", content: "市政水务集团", source_type: "用户确认" },
  { item: "覆盖什么", content: "只看出厂到管网", source_type: "AI提取" },
  { item: "核心用途", content: "想搞清楚这个场景值不值得进", source_type: "用户确认" },
  { item: "切入点", content: "存量泵站改造", source_type: "AI推断" },
];

// ─── 场景定义对话（演示态：本地预置对话与本地「整理成定义」结果） ──

/**
 * 演示态定义对话（预置到"模型已经给过理解、问过问题、用户答过一轮"）
 *
 * 与联真同结构：role 只有 用户 / 系统，模型先给理解再提 ≤3 个场景本体问题。
 */
export const DEMO_DEFINITION_MESSAGES: ApiDefinitionMessage[] = [
  {
    id: "demo-def-1",
    role: "系统",
    content:
      "我的理解：你想判断「智慧水务」这个场景值不值得进、怎么进。范围看起来是制水厂到管网末端这一段，客户是市政水务集团。\n\n想先确认三件事：\n1. 原水取水和二次供水算不算在这个场景里？\n2. 你的角色是替代现有系统，还是补一块它没有的能力？\n3. 这次是想先做判断，还是要直接出给客户看的材料？",
    created_at: "2026-09-25T09:30:00.000Z",
  },
  {
    id: "demo-def-2",
    role: "用户",
    content:
      "原水和二次供水先不算，只看制水厂到管网。我们做的是存量泵站改造，补调度和漏损这块能力，先做内部判断。",
    created_at: "2026-09-25T09:32:00.000Z",
  },
  {
    id: "demo-def-3",
    role: "系统",
    content:
      "收到，场景边界记下了：制水厂到管网末端，不含原水取水与二次供水；切入点是存量泵站改造，目的是内部判断值不值得进。你点「整理成定义」，我把它整理成表1-1 给你逐项确认。",
    created_at: "2026-09-25T09:33:00.000Z",
  },
];

/** 演示态用户再发一条时的本地回复（不发请求） */
export const DEMO_DEFINITION_REPLY =
  "记下了。演示模式不再请求真实模型——你随时可以点「整理成定义」，我把这段对话整理成表1-1。";

/** 演示态仍需用户回答的场景本体问题（整理结果里的 open_questions） */
const DEMO_DEFINITION_OPEN_QUESTIONS = [
  "「只看出厂到管网」——原水取水与二次供水算不算在内？",
  "切入点写的是「存量泵站改造」，是新建项目还是替换既有设备？",
];

/** 演示态「整理成定义」补齐的表1-1 行（在预置锚上补两条推断行） */
const DEMO_DEFINITION_EXTRA_ROWS: ApiAnchorRow[] = [
  { item: "明确不含什么", content: "原水取水与二次供水", source_type: "AI推断" },
  { item: "价值主张", content: "用漏损率下降换运维成本", source_type: "AI推断" },
];

/** 六项对照结论的内容与四态（按 label 索引，rowKey 从注册表取，不重抄） */
const DEMO_ALIGNMENT_BY_LABEL: Record<
  string,
  { content: string; alignment: ApiDefinitionAlignment["alignment"]; note?: string }
> = {
  "客户类型/行业": { content: "市政水务集团", alignment: "一致" },
  "覆盖什么": {
    content: "制水厂到管网末端",
    alignment: "系统补充",
    note: "来源：DEMO 水务场景资料",
  },
  "明确不含什么": {
    content: "原水取水与二次供水",
    alignment: "推断",
    note: "系统推断，需用户确认",
  },
  "核心用途": { content: "判断这个场景值不值得进", alignment: "一致" },
  "切入点": {
    content: "存量泵站改造",
    alignment: "推断",
    note: "系统推断，需用户确认",
  },
  "价值主张": {
    content: "用漏损率下降换运维成本",
    alignment: "推断",
    note: "系统推断，需用户确认",
  },
};

/** 演示态整理结果（与联真 `ApiDefinitionConsolidation` 同形状） */
export function demoDefinitionConsolidation(): ApiDefinitionConsolidation {
  return {
    rows: [...DEMO_ANCHOR, ...DEMO_DEFINITION_EXTRA_ROWS],
    alignment: l1Rows().map((fixed) => {
      const hit = DEMO_ALIGNMENT_BY_LABEL[fixed.label];
      return {
        rowKey: fixed.key,
        label: fixed.label,
        content: hit?.content ?? "",
        alignment: hit?.alignment ?? ("待补充" as const),
        ...(hit?.note ? { note: hit.note } : {}),
      };
    }),
    updated: 6,
    skipped: 0,
    open_questions: [...DEMO_DEFINITION_OPEN_QUESTIONS],
  };
}

/** 演示行：键必须存在于该表定义中（否则会被渲染成空列） */
export const DEMO_ROWS: Record<string, InfoRow[]> = {
  M1: [
    { model: "IPC-3000", name: "边缘控制器", status: "在售", category: "控制类" },
    { model: "SEN-200", name: "压力变送器", status: "在售", category: "感知类" },
  ],
  M3: [
    { domain: "设备接入", name: "Modbus/OPC-UA 接入", maturity: "已交付", note: "支持 20+ 协议" },
  ],
  "表1-2": [
    {
      link: "制水",
      is_digital: "可以联网采集",
      can_touch: "可以碰",
      our_role: "辅助",
      description: "加药与过滤环节的数据采集",
    },
    {
      link: "输配",
      is_digital: "可以联网采集",
      can_touch: "可以碰",
      our_role: "替代",
      description: "管网调度与漏损分析",
    },
    {
      link: "原水取水",
      is_digital: "必须物理隔离",
      can_touch: "不能碰",
      our_role: "不参与",
      description: "水源安全相关，不介入",
    },
  ],
  "表1-3": [
    {
      barrier_type: "技术",
      barrier_name: "等保三级",
      criteria: "GB/T 22239",
      current_status: "过得了",
      judgment: "过得了",
    },
    {
      barrier_type: "行业准入",
      barrier_name: "计量器具型式批准",
      criteria: "CPA 认证",
      current_status: "绕道",
      judgment: "绕道",
    },
  ],
  "表3-1": [{ link: "视频监控", gross_margin: "35%", representative: "行业头部厂商" }],
  "表3-2": [
    {
      form: "一体化平台",
      key_points: "软硬一体、统一运维",
      leader: "头部厂商",
      position: "主导",
      our_entry: "从边缘分析切入",
    },
  ],
  "表4-1": [{ capability: "设备接入", level: "已具备", evidence: "M3 能力清单", gap: "无" }],
  "表5-1": [
    {
      layer: "边缘层",
      components: "边缘网关 + 协议转换",
      interface: "Modbus/OPC-UA",
      integration: "对接现有 SCADA",
      boundary: "不承担安全责任",
    },
  ],
  "表6-1": [
    {
      benefit: "降低漏损率",
      metric: "漏损率",
      baseline: "18%",
      expected: "12%",
      how_to_measure: "分区计量（DMA）",
      user_feeling: "水费与投诉下降",
      evidence_level: "C",
    },
  ],
  "表7-1": [
    {
      target: "内部能力沉淀",
      content: "沉淀水务行业方案模板与报价基线",
      basis: "阶段 2 表3-8 需求缺口",
    },
  ],
};

/** 某表集在演示数据下的产出规模（与联真 `progress` 同形状） */
export function demoProgress(tables: readonly string[]): {
  tablesWithData: number;
  expectedTables: number;
  rows: number;
} {
  let tablesWithData = 0;
  let rows = 0;
  for (const code of tables) {
    const list = DEMO_ROWS[code] ?? [];
    if (list.length > 0) tablesWithData += 1;
    rows += list.length;
  }
  return { tablesWithData, expectedTables: tables.length, rows };
}

/**
 * 演示态第 1 步「场景定义与边界」就绪口径（与联真同义）
 *
 * 定义对话不占流程步：对话聊清楚只把表1-1 写出来，**还要用户逐项确认 L1 六项**
 * 才算这一步就绪。联真的就绪由服务端算，这里用本地锚数据按同一语义推导。
 */
export function demoAnchorReadiness(anchor: readonly ApiAnchorRow[]): FlowReadiness {
  const l1 = l1Rows();
  const confirmed = l1.filter((r) => {
    const row = anchor.find((a) => a.item === r.label);
    const st = String(row?.source_type ?? "");
    return st === "用户确认" || st === "用户补充";
  }).length;
  const missing = l1.length - confirmed;
  return {
    ready: missing === 0,
    readyHint: missing === 0 ? "L1 六项已全部确认" : `还有 ${missing} 项场景本体未确认`,
    progress: {
      tablesWithData: anchor.length > 0 ? 1 : 0,
      expectedTables: 1,
      rows: anchor.length,
    },
  };
}

/** 演示态流程状态（本地内存推导；「完成本步」只是往 completed 里加一步） */
export function buildDemoFlowStatus(input: {
  completed: readonly number[];
  unlockedAll: boolean;
  anchor: readonly ApiAnchorRow[];
}): ApiFlowStatus {
  const readiness: Record<number, FlowReadiness> = {};
  for (const step of FLOW_STEPS) {
    if (step.kind === "确认") {
      readiness[step.id] = demoAnchorReadiness(input.anchor);
    } else if (step.kind === "分析") {
      const p = demoProgress(step.tables);
      readiness[step.id] = {
        ready: p.rows > 0,
        readyHint: p.rows > 0 ? `本步已有 ${p.rows} 行信息（演示数据）` : "本步还没有产出",
        progress: p,
      };
    } else {
      readiness[step.id] = { ready: true, readyHint: "可生成并导出交付物" };
    }
  }

  const status = buildFlowStatus({
    completed: input.completed,
    unlockedAll: input.unlockedAll,
    readiness,
  });
  return {
    steps: status.steps.map((s) => ({ ...s })),
    currentStep: status.currentStep,
    completedCount: status.completedCount,
    unlockedAll: status.unlockedAll,
    finished: status.finished,
  };
}

/** 演示态确认清单（右栏 Tab ①，与联真同结构） */
export function demoChecklist(anchor: readonly ApiAnchorRow[]): ChecklistViewItem[] {
  return buildChecklist({
    anchorRows: anchor.map((a) => ({
      item: a.item,
      content: a.content,
      source_type: asSourceType(a.source_type),
    })),
    linkRows: DEMO_ROWS["表1-2"] ?? [],
  }).items.map((i) => ({
    layer: i.layer,
    tableCode: i.tableCode,
    rowKey: i.rowKey,
    label: i.label,
    state: i.state,
  }));
}

/** 演示态 L1 已确认数（面板提示用） */
export function demoConfirmedL1(anchor: readonly ApiAnchorRow[]): number {
  return buildChecklist({
    anchorRows: anchor.map((a) => ({
      item: a.item,
      content: a.content,
      source_type: asSourceType(a.source_type),
    })),
  }).confirmed;
}

/** 演示态阶段总结（六段骨架；右栏 Tab ② 与联真同结构） */
export function demoStageSummary(stage: InfoStageId): string {
  const rowsByTable: Record<string, InfoRow[]> = {};
  for (const t of tablesOfStage(stage)) rowsByTable[t.code] = DEMO_ROWS[t.code] ?? [];
  rowsByTable["表1-1"] = DEMO_ANCHOR.map((a) => ({ item: a.item, content: a.content }));
  return buildStageSummary({
    stage,
    scenarioName: "智慧水务",
    productLineName: "感知与控制",
    rowsByTable,
    completeness: checkStageCompleteness({ stage, rowsByTable }),
    briefRawText: "场景名称：智慧水务\n想搞清楚什么：这个场景值不值得进",
    generatedAt: "2026-09-25",
  });
}

/** 场景名（演示） */
export const DEMO_SCENE_NAME = "智慧水务";

/** 阶段名（演示态标题里用） */
export function demoStageLabel(stage: InfoStageId): string {
  return STAGE_DEFS.find((s) => s.id === stage)?.name ?? "";
}
