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
  buildFlowStatus,
  buildStageSummary,
  checkStageCompleteness,
  type FlowReadiness,
  type InfoRow,
} from "@scene/domain";
import {
  definitionRowKey,
  definitionScopeLabels,
  draftedItems,
  isDefinitionDrafted,
} from "../components/definition-progress";
import type {
  ApiAnchorRow,
  ApiDefinitionAlignment,
  ApiDefinitionConsolidation,
  ApiDefinitionMessage,
  ApiFlowStatus,
} from "../api";

/**
 * 演示用的场景锚（表1-1）初始态
 *
 * 与新口径一致：**用户只输入了场景名称**，业务画像是智能体在「整理成定义」时写的
 * （见 `DEMO_DEFINITION_EXTRA_ROWS`）。所以初始态第 1 步未就绪——和联真的新场景一样。
 */
export const DEMO_ANCHOR: ApiAnchorRow[] = [
  { item: "场景名称", content: "智慧水务", source_type: "用户补充" },
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
      "收到，场景边界记下了：制水厂到管网末端，不含原水取水与二次供水；切入点是存量泵站改造，目的是内部判断值不值得进。你点「整理成定义」，我把它整理成表1-1 给你对照检查——说不准的先留待定也行。",
    created_at: "2026-09-25T09:33:00.000Z",
  },
];

/** 演示态用户再发一条时的本地回复（不发请求） */
export const DEMO_DEFINITION_REPLY =
  "记下了。演示模式不再请求真实模型——你随时可以点「整理成定义」，我把这段对话整理成表1-1。";

/** 演示态仍需用户回答的场景本体问题（整理结果里的 open_questions） */
const DEMO_DEFINITION_OPEN_QUESTIONS = [
  "原水取水与二次供水算不算在这个场景里？",
  "重点是新建水厂/泵站，还是存量泵站改造？",
];

/**
 * 演示态「整理成定义」补出的 5 项业务画像
 *
 * 这就是智能体的**本职工作**（用户定调「用户什么都知道还要我们干什么」）——
 * 所以演示态里它们由"整理成定义"这一步产生，而不是让用户预先填。
 */
const DEMO_DEFINITION_EXTRA_ROWS: ApiAnchorRow[] = [
  {
    item: "场景边界",
    content: "制水厂、加压泵站、供水管网与二次供水；不含原水取水",
    source_type: "AI推断",
    source: "行业通例",
  },
  {
    item: "生产对象",
    content: "加药、混凝、沉淀、过滤、消毒、加压输送与管网调度；以及计量、水质监测、漏损分析与运维",
    source_type: "AI推断",
    source: "行业通例",
  },
  {
    item: "核心生产系统",
    content: "水厂工艺装置 + 泵站 SCADA/PLC + 管网 GIS 与调度平台 + 计量与水质在线监测 + 运维工单",
    source_type: "AI推断",
    source: "行业通例",
  },
  {
    item: "买方类型",
    content: "市政水务集团、地方自来水公司、水务投资运营公司、大型园区自备水厂",
    source_type: "AI推断",
    source: "行业通例",
  },
  {
    item: "采购特征",
    content: "集团技术规范 + 集采/供应商名录 + 项目制招标；泵站改造与漏损治理形成持续预算",
    source_type: "AI推断",
    source: "行业通例",
  },
];

/**
 * 对照结论的内容与四态（按项名索引，rowKey 从注册表取，不重抄）
 *
 * 选行与联真同规则：**核心必确认项 ∪ 模型实际填了/推断的项**——所以这里只提供
 * 内容与四态，行数由 `definitionScopeLabels` 按数据现算，不写死。
 */
const DEMO_ALIGNMENT_BY_LABEL: Record<
  string,
  { content: string; alignment: ApiDefinitionAlignment["alignment"]; note?: string }
> = {
  "场景边界": { content: "制水厂、加压泵站、供水管网与二次供水；不含原水取水", alignment: "推断" },
  "生产对象": { content: "加药、混凝、沉淀、过滤、消毒、加压输送与管网调度", alignment: "推断" },
  "核心生产系统": { content: "水厂工艺装置 + 泵站 SCADA/PLC + 管网调度平台", alignment: "推断" },
  "买方类型": { content: "市政水务集团、地方自来水公司", alignment: "推断" },
  "采购特征": { content: "集团技术规范 + 集采 + 项目制招标", alignment: "推断" },
};

/** 演示态整理结果（与联真 `ApiDefinitionConsolidation` 同形状） */
export function demoDefinitionConsolidation(): ApiDefinitionConsolidation {
  const rows = [...DEMO_ANCHOR, ...DEMO_DEFINITION_EXTRA_ROWS];
  return {
    rows,
    alignment: definitionScopeLabels(rows).map((label) => {
      const hit = DEMO_ALIGNMENT_BY_LABEL[label];
      return {
        rowKey: definitionRowKey(label),
        label,
        content: hit?.content ?? "",
        alignment: hit?.alignment ?? ("待补充" as const),
        ...(hit?.note ? { note: hit.note } : {}),
      };
    }),
    updated: rows.length,
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
 * 就绪 = **智能体侧已写出业务画像**（不是"用户逐项确认完了"）：用户定调
 * 「用户确认就默认可以了」+「不用显示待确认」，所以确认不参与就绪判定。
 * 联真的就绪由服务端算，这里用本地锚数据按同一语义推导。
 */
export function demoAnchorReadiness(anchor: readonly ApiAnchorRow[]): FlowReadiness {
  const filled = draftedItems(anchor).length;
  const drafted = isDefinitionDrafted(anchor);
  return {
    ready: drafted,
    readyHint: drafted
      ? `场景业务画像已写出 ${filled} 项；看一眼，能直接改，没问题就继续`
      : "先说一句场景名称，我来写这份场景业务画像（场景边界、生产对象、核心系统、买方与采购特征）",
    progress: {
      tablesWithData: filled > 0 ? 1 : 0,
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
