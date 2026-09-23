/**
 * @scene/infra — 交付物导出（Markdown）
 *
 * 按 00b 工作流标准 §10：
 * - 内部调研报告（3-5 页）：完整证据链
 * - 对外汇报材料（2-3 页）：价值导向，不含敏感信息
 *
 * 输出纯 Markdown 字符串，不写文件。
 */

import type {
  ExportData,
  ExportResult,
  Scenario,
  StageData,
  QualityGate,
  Knowledge,
  Capability,
} from "@scene/contract";

// ─── 常量 ──────────────────────────────────────────────────

const MATURITY_SCORES: Record<string, number> = {
  "已交付": 5,
  "组件具备": 4,
  "在研": 2,
  "规划": 1,
};

// ─── 命名规则（00b §11.5） ──────────────────────────────────

/**
 * 按 00b §11.5 生成交付物文件名
 *
 * @param scenarioName 场景名（当前未参与命名，预留扩展）
 * @param type 内部或对外
 */
export function exportFileName(
  _scenarioName: string,
  type: "internal" | "external",
): string {
  return type === "internal"
    ? "交付物-内部调研报告.md"
    : "交付物-对外汇报材料.md";
}

// ─── 主入口 ──────────────────────────────────────────────────

/**
 * 生成内部调研报告 + 对外汇报材料
 *
 * @param data 完整导出数据
 * @returns 内部报告 + 对外报告（纯 Markdown）
 */
export async function exportDeliverables(
  data: ExportData,
): Promise<ExportResult> {
  const { scenario, libraryData, stageData, qualityGates, knowledge } = data;
  const today = new Date().toISOString().slice(0, 10);

  return {
    internal_report: buildInternalReport(
      scenario, libraryData, stageData, qualityGates, knowledge, today,
    ),
    external_report: buildExternalReport(
      scenario, libraryData, stageData, today,
    ),
  };
}

// ─── 内部调研报告 ────────────────────────────────────────────

function buildInternalReport(
  scenario: Scenario,
  lib: ExportData["libraryData"],
  stageData: StageData[],
  gates: QualityGate[],
  knowledge: Knowledge[],
  today: string,
): string {
  const sections = [
    renderHeader(scenario, today),
    renderConclusion(lib),
    renderMarketOverview(stageData),
    renderCompetitiveLandscape(stageData),
    renderCapabilityMatch(lib.capabilities),
    renderSolutionSummary(lib, stageData),
    renderRiskAndPrerequisites(gates, stageData),
    renderNextSteps(stageData),
    renderEvidenceIndex(stageData, knowledge),
  ];

  return sections.join("\n\n");
}

// ─── 内部报告各章节 ──────────────────────────────────────────

function renderHeader(scenario: Scenario, today: string): string {
  return `# ${scenario.name} 场景评估 — 内部调研报告

> **产品线**：${scenario.product_line_id}
> **场景**：${scenario.name}
> **结论**：建议通过
> **日期**：${today}
> **分析人**：AI 辅助

---`;
}

function renderConclusion(lib: ExportData["libraryData"]): string {
  const hasProducts = lib.products.length > 0;
  const hasCapabilities = lib.capabilities.length > 0;
  const hasCost = lib.costRates.length > 0;

  return `## 一、结论

${hasProducts && hasCapabilities
    ? `经评估，${lib.products[0]!.name} 在目标场景中具备落地条件。`
    : "经评估，该场景具备进一步调研的条件。"}

**进入的理由：**

1. 我方产品在核心能力维度有匹配基础${hasCapabilities ? `（${lib.capabilities.length} 项能力已覆盖）` : ""}
2. 市场存在明确需求，竞争格局尚有空间${hasCost ? "，成本结构清晰" : ""}
3. 已有可复用的技术积累和交付经验

**不进入的理由：**

1. 部分细分能力仍存在缺口，需补齐后方可规模化
2. 前期投入回报周期尚需试点验证
3. 市场成熟度有限，客户教育成本不可忽视`;
}

function renderMarketOverview(stageData: StageData[]): string {
  const stage2 = stageData.filter((d) => d.stage === 2);
  const tableData = pickRows(stage2, "表2-1");

  const hasMarketData = tableData.length > 0;

  let tableRows: string;
  if (hasMarketData) {
    tableRows = tableData
      .map((row) => {
        const indicator = rowStr(row, "indicator", "metric", "指标");
        const value = rowStr(row, "value", "data", "数据");
        const source = rowStr(row, "source", "来源") || "待确认";
        return `| ${indicator} | ${value} | ${source} |`;
      })
      .join("\n");
  } else {
    tableRows = "| 市场规模 | 待补充 | — |\n| 年增长率 | 待补充 | — |";
  }

  return `## 二、市场概况

| 指标 | 数据 | 来源 |
|------|------|------|
${tableRows}`;
}

function renderCompetitiveLandscape(stageData: StageData[]): string {
  const stage2 = stageData.filter((d) => d.stage === 2);

  const profitData = pickRows(stage2, "表2-4");
  const solutionData = pickRows(stage2, "表2-5");
  const alternativeData = pickRows(stage2, "表2-6");

  const profitTable = profitData.length > 0
    ? buildTable(
        ["角色", "毛利率", "代表"],
        profitData.map((r) => [rowStr(r, "role", "角色"), rowStr(r, "margin", "毛利率"), rowStr(r, "representative", "代表")]),
      )
    : "| 角色 | 毛利率 | 代表 |\n|------|--------|------|\n| — | 待补充 | — |";

  const solutionTable = solutionData.length > 0
    ? buildTable(
        ["形态", "现状", "我方定位"],
        solutionData.map((r) => [rowStr(r, "form", "形态"), rowStr(r, "status", "现状"), rowStr(r, "position", "我方定位")]),
      )
    : "| 形态 | 现状 | 我方定位 |\n|------|------|----------|\n| — | 待补充 | — |";

  const alternativeTable = alternativeData.length > 0
    ? buildTable(
        ["方案", "单间成本", "得到什么", "我方优势"],
        alternativeData.map((r) => [
          rowStr(r, "name", "方案"),
          rowStr(r, "cost", "单间成本"),
          rowStr(r, "benefit", "得到什么"),
          rowStr(r, "advantage", "我方优势"),
        ]),
      )
    : "| 方案 | 单间成本 | 得到什么 | 我方优势 |\n|------|----------|----------|----------|\n| — | 待补充 | — | — |";

  return `## 三、竞争格局

### 利润分布

${profitTable}

### 主流方案形态

${solutionTable}

### 替代方案对照

${alternativeTable}`;
}

function renderCapabilityMatch(capabilities: Capability[]): string {
  if (capabilities.length === 0) {
    return `## 四、我方能力匹配

| 领域 | 能力 | 匹配判定 | 说明 |
|------|------|----------|------|
| — | — | 待评估 | — |

竞争力评分：待评估`;
  }

  const rows = capabilities.map((c) => {
    const score = MATURITY_SCORES[c.maturity] ?? 0;
    const verdict = score >= 4 ? "满足" : score >= 2 ? "部分满足" : "待补齐";
    return `| ${c.domain} | ${c.name} | ${verdict} | ${c.maturity} |`;
  });

  const totalScore = capabilities.reduce(
    (sum, c) => sum + (MATURITY_SCORES[c.maturity] ?? 0), 0,
  );

  return `## 四、我方能力匹配

| 领域 | 能力 | 匹配判定 | 说明 |
|------|------|----------|------|
${rows.join("\n")}

竞争力评分：${totalScore}/25`;
}

function renderSolutionSummary(
  lib: ExportData["libraryData"],
  stageData: StageData[],
): string {
  const stage5 = stageData.filter((d) => d.stage === 5);
  const costData = pickRows(stage5, "表5-5");

  const costTable = costData.length > 0
    ? buildTable(
        ["项", "金额"],
        costData.map((r) => [rowStr(r, "item", "项"), rowStr(r, "amount", "金额")]),
      )
    : lib.costRates.length > 0
      ? buildTable(
          ["项", "单价", "单位"],
          lib.costRates.map((c) => [c.item, String(c.rate), c.unit]),
        )
      : "| 项 | 金额 |\n|------|------|\n| — | 待补充 |";

  const costRateTable = lib.costRates.length > 0 && costData.length > 0
    ? `\n**成本参考**：\n\n${buildTable(
        ["项", "单价", "单位"],
        lib.costRates.map((c) => [c.item, String(c.rate), c.unit]),
      )}`
    : "";

  const roi = lib.costRates.length > 0
    ? "预期回收期待试点验证（C 级推断）"
    : "待补充";

  return `## 五、方案概要

**定位**：${lib.products.length > 0 ? lib.products[0]!.position_desc : "待确认"}

**架构**：基于我方现有产品能力组合，针对目标场景定制

**单间成本**：

${costTable}
${costRateTable}

**预期价值**：

| 指标 | 改善 | 用户感受 |
|------|------|----------|
| 效率提升 | 待试点补充 | — |
| 成本降低 | 待试点补充 | — |

**投资回报**：${roi}`;
}

function renderRiskAndPrerequisites(
  gates: QualityGate[],
  stageData: StageData[],
): string {
  const failedGates = gates.filter((g) => g.result === "不通过");
  const stage4 = stageData.filter((d) => d.stage === 4);
  const riskData = pickRows(stage4, "表4-5");

  const riskTable = riskData.length > 0
    ? buildTable(
        ["风险", "影响", "应对"],
        riskData.map((r) => [rowStr(r, "risk", "风险"), rowStr(r, "impact", "影响"), rowStr(r, "response", "应对")]),
      )
    : failedGates.length > 0
      ? failedGates
          .map((g) => `| ${g.title} | ${g.result} | ${g.detail} |`)
          .join("\n")
      : "| 风险 | 影响 | 应对 |\n|------|------|------|\n| — | 待评估 | — |";

  const prerequisites = gates
    .filter((g) => g.result === "不通过")
    .map((g, i) => `${i + 1}. ${g.detail || g.title}`)
    .join("\n");

  return `## 六、风险与前提条件

| 风险 | 影响 | 应对 |
|------|------|------|
${riskTable}

${prerequisites ? `进入的前提条件：\n${prerequisites}` : "进入的前提条件：\n1. 待评估"}`;
}

function renderNextSteps(stageData: StageData[]): string {
  const stage7 = stageData.filter((d) => d.stage === 7);
  const nextData = pickRows(stage7, "表7-1");

  const rows = nextData.length > 0
    ? nextData.map((r, i) =>
        `| ${i + 1} | ${rowStr(r, "task", "待办")} | ${rowStr(r, "owner", "负责方") || "待定"} | ${rowStr(r, "time", "时间") || "待定"} |`,
      ).join("\n")
    : "| 1 | 试点方案确认 | 解决方案部 | 2 周内 |\n| 2 | 首站交付 | 项目组 | 1 个月内 |\n| 3 | 效果评估与复制推广 | 管理层 | 3 个月内 |";

  return `## 七、下一步

| # | 待办 | 负责方 | 时间 |
|---|------|--------|------|
${rows}`;
}

function renderEvidenceIndex(
  stageData: StageData[],
  knowledge: Knowledge[],
): string {
  const stageGroups = new Map<number, StageData[]>();
  for (const sd of stageData) {
    const arr = stageGroups.get(sd.stage) ?? [];
    arr.push(sd);
    stageGroups.set(sd.stage, arr);
  }

  const stageNames: Record<number, string> = {
    0: "材料入库",
    1: "门槛筛查",
    2: "认识场景",
    3: "理解商业",
    4: "匹配与决策",
    5: "方案与实现",
    6: "价值与验证",
    7: "总结沉淀",
    8: "最终交付物",
  };

  const stageItems = Array.from(stageGroups.entries())
    .sort(([a], [b]) => a - b)
    .map(([stage, rows]) =>
      `- 阶段 ${stage}（${stageNames[stage] ?? "未知"}）：${rows.length} 条记录，来源 ${rows[0]?.source ?? "—"}`,
    );

  const knowledgeItems = knowledge.map(
    (k) => `- [${k.category}] ${k.content.slice(0, 50)}…（${k.source}）`,
  );

  return `## 附录：证据链索引

### 阶段数据
${stageItems.length > 0 ? stageItems.join("\n") : "- 无阶段数据"}

### 知识库引用
${knowledgeItems.length > 0 ? knowledgeItems.join("\n") : "- 无知识库条目"}`;
}

// ─── 对外汇报材料 ────────────────────────────────────────────

function buildExternalReport(
  scenario: Scenario,
  lib: ExportData["libraryData"],
  stageData: StageData[],
  today: string,
): string {
  const sections = [
    renderExternalHeader(scenario, today),
    renderExternalPositioning(lib),
    renderExternalProblems(stageData),
    renderExternalHighlights(lib, stageData),
    renderExternalScenarios(stageData),
    renderExternalROI(lib, stageData),
    renderExternalWhyUs(lib),
    renderExternalNextSteps(),
  ];

  return sections.join("\n\n");
}

// ─── 对外报告各章节 ──────────────────────────────────────────

function renderExternalHeader(scenario: Scenario, today: string): string {
  return `# ${scenario.name} 方案 — 对外汇报材料

> **汇报对象**：领导/客户/合作伙伴
> **核心信息**：${scenario.name}场景落地解决方案
> **日期**：${today}

---`;
}

function renderExternalPositioning(lib: ExportData["libraryData"]): string {
  const productName = lib.products.length > 0 ? lib.products[0]!.name : "我方方案";

  return `## 一句话定位

${productName}面向${lib.products.length > 0 ? lib.products[0]!.position_desc : "目标场景"}，提供从方案设计到落地交付的全链路支撑。`;
}

function renderExternalProblems(stageData: StageData[]): string {
  const stage1 = stageData.filter((d) => d.stage === 1);
  const barrierData = pickRows(stage1, "表1-3");

  const rows = barrierData.length > 0
    ? barrierData
        .map((r) =>
          `| ${rowStr(r, "barrier", "障碍", "pain")} | ${rowStr(r, "currentStatus", "现状", "status")} | ${rowStr(r, "solution", "我方方案", "strategy")} |`,
        )
        .join("\n")
    : "| 效率低 | 传统人工方式，周期长 | 自动化方案，周期缩短 |\n| 成本高 | 大量重复投入 | 模块化复用，降低边际成本 |\n| 质量不稳 | 依赖个人经验 | 标准化流程，质量可控 |\n| 数据断裂 | 信息孤岛 | 全链路数据贯通 |";

  return `## 解决什么问题

| 痛点 | 现状 | 我们怎么解决 |
|------|------|--------------|
${rows}`;
}

function renderExternalHighlights(
  lib: ExportData["libraryData"],
  _stageData: StageData[],
): string {
  const caps = lib.capabilities.filter((c) => c.maturity === "已交付" || c.maturity === "组件具备");
  const highlights = caps.slice(0, 4);

  if (highlights.length === 0) {
    return `## 方案亮点

**1. 成熟方案——快速落地**
基于已有成功案例，方案经过充分验证。

**2. 模块化——按需组合**
根据实际需求灵活组合，避免过度投入。

**3. 全链路——覆盖完整**
从方案到交付到运维，提供完整支撑。

**4. 数据驱动——持续优化**
通过数据反馈持续优化方案效果。`;
  }

  const items = highlights.map(
    (c, i) => `**${i + 1}. ${c.name}——${c.maturity}**
${c.description}`,
  );

  return `## 方案亮点

${items.join("\n\n")}`;
}

function renderExternalScenarios(stageData: StageData[]): string {
  const stage3 = stageData.filter((d) => d.stage === 3);
  const scenarioData = pickRows(stage3, "表3-1");

  const rows = scenarioData.length > 0
    ? scenarioData
        .slice(0, 4)
        .map((r) =>
          `| ${rowStr(r, "scenario", "场景")} | ${rowStr(r, "customer", "典型客户")} | ${rowStr(r, "value", "价值")} |`,
        )
        .join("\n")
    : "| 核心场景 | 典型行业客户 | 效率提升 + 成本降低 |\n| 扩展场景 | 相关行业客户 | 能力复用 + 快速复制 |\n| 试点场景 | 意向客户 | 验证价值 + 树立标杆 |\n| 复制场景 | 同类客户 | 模板化交付 + 规模化 |";

  return `## 适用场景

| 场景 | 典型客户 | 价值 |
|------|----------|------|
${rows}`;
}

function renderExternalROI(
  lib: ExportData["libraryData"],
  stageData: StageData[],
): string {
  const stage6 = stageData.filter((d) => d.stage === 6);
  const roiData = pickRows(stage6, "表6-3");

  if (roiData.length > 0) {
    const rows = roiData.map((r) =>
      `| ${rowStr(r, "item", "项")} | ${rowStr(r, "value", "data", "数据")} |`,
    );
    return `## 投入与回报

| 项 | 数据 |
|------|------|
${rows.join("\n")}`;
  }

  const hasCost = lib.costRates.length > 0;
  const investment = hasCost
    ? `根据成本结构估算，首站投入约 ${lib.costRates.reduce((s, c) => s + c.rate, 0).toLocaleString()} 元`
    : "试点后补充";

  return `## 投入与回报

| 项 | 数据 |
|------|------|
| 首站投入 | ${investment} |
| 交付周期 | 试点后补充 |
| 预期节省 | 试点后补充 |
| 回收周期 | 试点后补充 |`;
}

function renderExternalWhyUs(lib: ExportData["libraryData"]): string {
  const matureCaps = lib.capabilities.filter(
    (c) => c.maturity === "已交付" || c.maturity === "组件具备",
  );
  const boundaries = lib.boundaries;
  const totalCapabilities = lib.capabilities.length;

  const advantages: Array<{ dimension: string; detail: string }> = [];

  if (totalCapabilities > 0) {
    advantages.push({
      dimension: "能力覆盖",
      detail: `${totalCapabilities} 项核心能力，${matureCaps.length} 项已交付`,
    });
  }
  if (boundaries.length > 0) {
    advantages.push({
      dimension: "边界清晰",
      detail: "明确能力范围，不承诺超出能力的事",
    });
  }
  if (lib.costRates.length > 0) {
    advantages.push({
      dimension: "成本透明",
      detail: "基于真实项目数据的成本模型",
    });
  }
  if (lib.products.length > 0) {
    advantages.push({
      dimension: "产品成熟",
      detail: `${lib.products[0]!.name}已具备完整交付能力`,
    });
  }

  if (advantages.length === 0) {
    return `## 为什么是我们

| 维度 | 我们的优势 |
|------|------------|
| 技术积累 | 深耕目标场景，核心能力成熟 |
| 交付经验 | 有同类场景的成功交付记录 |
| 服务支撑 | 全链路服务，从方案到运维 |
| 持续演进 | 持续投入研发，能力不断升级 |`;
  }

  const rows = advantages
    .map((a) => `| ${a.dimension} | ${a.detail} |`)
    .join("\n");

  return `## 为什么是我们

| 维度 | 我们的优势 |
|------|------------|
${rows}`;
}

function renderExternalNextSteps(): string {
  return `## 下一步

1. **需求对接**（1 周内）：深入了解具体场景需求，确认方案范围
2. **方案定制**（2 周内）：输出定制化方案设计与报价
3. **试点启动**（1 个月内）：启动首站试点，验证效果

**联系人**：待填写`;
}

// ─── 工具函数 ──────────────────────────────────────────────────

/** 从阶段数据中提取指定表的行数据 */
function pickRows(stageData: StageData[], tableCode: string): Array<Record<string, unknown>> {
  return stageData
    .filter((d) => d.table_code === tableCode)
    .map((d) => d.row);
}

/** 从行数据中提取字符串值 */
function rowStr(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/** 生成 Markdown 表格 */
function buildTable(headers: string[], rows: string[][]): string {
  const headerLine = `| ${headers.join(" | ")} |`;
  const separator = `|${headers.map(() => "------").join("|")}|`;
  const dataLines = rows.map((r) => `| ${r.join(" | ")} |`);
  return [headerLine, separator, ...dataLines].join("\n");
}
