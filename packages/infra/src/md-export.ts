/**
 * @scene/infra — 交付物导出（Markdown）
 *
 * v1.4 重写（对应 04 §八）：
 *  - **内部调研报告** = 各阶段总结文档装配 + 附录（来源索引、信息覆盖概览）
 *  - **对外汇报材料** = 章节 ← 表映射，**只渲染中栏列**
 *    （元信息「来源 / 证据级 / 权威性」都在右栏补充列，因此天然不出现在对外材料里）
 *
 * 两条铁律：
 *  1. **不给决策建议**——旧实现里的「结论：建议通过」「具备落地条件」等
 *     全部移除（产品不给决策建议；但每条信息必须带模型自己的核实判定）
 *  2. **对外材料不含内部信息**——不渲染竞品身份表与利润池表，不出现证据级标签
 *
 * 输出纯 Markdown 字符串，不写文件。
 */

import {
  deliverableSections,
  middleColumns,
  middleColumnsByBlock,
  tableDef,
  type DeliverableInput,
  type ExportResult,
  type StageData,
} from "@scene/contract";

/** 对外材料**禁止**引用的表（含竞品身份或我方内部财务口径） */
const EXTERNAL_FORBIDDEN_TABLES: readonly string[] = [
  "表3-1", // 利润池（我方内部财务视角）
  "表3-4", // 竞争对手对照（含竞品身份）
  "表3-6", // 替代方案对照（含竞品身份）
  "表3-7", // 失败反模式（内部复盘）
  "表3-8", // 没被满足的需求（含痛点判断与交叉验证）
];

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
  return type === "internal" ? "内部调研报告.md" : "对外汇报材料.md";
}

// ─── 主入口 ────────────────────────────────────────────────

/**
 * 生成交付物（内部调研报告 + 对外汇报材料）
 *
 * @param data 交付物输入（场景 + 阶段总结 + 阶段数据）
 * @returns 两份纯 Markdown
 */
export async function exportDeliverables(data: DeliverableInput): Promise<ExportResult> {
  const today = data.generatedAt ?? new Date().toISOString().slice(0, 10);
  return {
    internal_report: buildInternalReport(data, today),
    external_report: buildExternalReport(data, today),
  };
}

/** 依场景锚（表1-1）取一个可读的副标题：客户类型 + 覆盖范围 */
function anchorLine(stageData: readonly StageData[]): string {
  const rows = stageData.filter((r) => r.table_code === "表1-1");
  const get = (item: string): string =>
    String(rows.find((r) => String(r.row["item"]) === item)?.row["content"] ?? "").trim();
  // 副标题用业务画像里最能定位场景的两项（新口径：客户类型已不在表1-1）
  const parts = [get("场景边界"), get("买方类型")].filter((s) => s && s !== "未提供");
  return parts.join(" ｜ ");
}

// ─── 内部调研报告 ──────────────────────────────────────────

function buildInternalReport(data: DeliverableInput, today: string): string {
  const { scenario, stageSummaries, stageData } = data;
  const sub = anchorLine(stageData);
  const sections: string[] = [];

  sections.push(
    [
      `# ${scenario.name} 场景调研 — 内部调研报告`,
      "",
      `> **场景**：${scenario.name}${sub ? `（${sub}）` : ""}`,
      `> **生成日期**：${today}`,
      "> **文档性质**：**每条信息都带核实结论**（准不准 · 客不客观 · 为什么）；只给可核实的判定与事实，**不给决策建议**——该不该进由使用者自己定。",
      "",
      "---",
    ].join("\n"),
  );

  if (stageSummaries.length === 0) {
    sections.push("## 正文\n\n（尚无阶段总结——先完成阶段分析，本文档会自动装配）");
  } else {
    for (const s of stageSummaries) {
      sections.push(`# 第 ${s.stage} 部分 · ${s.title}\n\n${s.markdown.trim()}`);
    }
  }

  for (const sec of deliverableSections("internal")) {
    if (sec.key === "sources") sections.push(renderSourceIndex(sec.title, stageData, sec.note));
    if (sec.key === "coverage") sections.push(renderCoverage(sec.title, stageData, sec.note));
  }

  return sections.join("\n\n---\n\n");
}

/** 附录 A：来源索引（按表汇总来源） */
function renderSourceIndex(
  title: string,
  stageData: readonly StageData[],
  note?: string,
): string {
  const byTable = new Map<string, Map<string, number>>();
  for (const r of stageData) {
    const src = String(r.source ?? "").trim();
    if (!src) continue;
    const inner = byTable.get(r.table_code) ?? new Map<string, number>();
    inner.set(src, (inner.get(src) ?? 0) + 1);
    byTable.set(r.table_code, inner);
  }
  const lines: string[] = [`## ${title}`, ""];
  if (note) lines.push(`> ${note}`, "");
  if (byTable.size === 0) {
    lines.push("（暂无带来源的信息）");
    return lines.join("\n");
  }
  for (const [code, sources] of byTable) {
    const name = tableDef(code)?.name ?? "";
    lines.push(`### ${code}${name ? " " + name : ""}`, "");
    for (const [src, n] of sources) lines.push(`- ${src}（${n} 条）`);
    lines.push("");
  }
  return lines.join("\n");
}

/** 附录 B：信息覆盖概览（行数 + 有来源行数） */
function renderCoverage(
  title: string,
  stageData: readonly StageData[],
  note?: string,
): string {
  const byTable = new Map<string, { rows: number; sourced: number }>();
  for (const r of stageData) {
    const cur = byTable.get(r.table_code) ?? { rows: 0, sourced: 0 };
    cur.rows += 1;
    if (String(r.source ?? "").trim() !== "") cur.sourced += 1;
    byTable.set(r.table_code, cur);
  }
  const lines: string[] = [`## ${title}`, ""];
  if (note) lines.push(`> ${note}`, "");
  lines.push("| 表号 | 表名 | 行数 | 有来源行数 |", "|---|---|---|---|");
  if (byTable.size === 0) {
    lines.push("| — | — | 0 | 0 |");
    return lines.join("\n");
  }
  for (const [code, v] of byTable) {
    lines.push(`| ${code} | ${tableDef(code)?.name ?? ""} | ${v.rows} | ${v.sourced} |`);
  }
  return lines.join("\n");
}

// ─── 对外汇报材料 ──────────────────────────────────────────

function buildExternalReport(data: DeliverableInput, today: string): string {
  const { scenario, stageData } = data;
  const sub = anchorLine(stageData);
  const sections: string[] = [];

  sections.push(
    [
      `# ${scenario.name} 场景方案 — 汇报材料`,
      "",
      `> **场景**：${scenario.name}${sub ? `（${sub}）` : ""}`,
      `> **日期**：${today}`,
      "",
      "---",
    ].join("\n"),
  );

  for (const sec of deliverableSections("external")) {
    const body: string[] = [`## ${sec.title}`, ""];
    if (sec.note) body.push(`> ${sec.note}`, "");
    let rendered = 0;
    for (const code of sec.tables) {
      if (EXTERNAL_FORBIDDEN_TABLES.includes(code)) continue;
      const md = renderTableMiddle(code, stageData);
      if (md) {
        rendered += 1;
        body.push(md, "");
      }
    }
    if (rendered === 0) body.push("（本节信息待补充）");
    sections.push(body.join("\n"));
  }

  sections.push(
    [
      "---",
      "",
      "> 本材料只呈现信息与安排，不含结论性建议；如需进一步确认，请与对接人核对。",
    ].join("\n"),
  );

  return sections.join("\n\n");
}

/**
 * 渲染一张表的**中栏列**为 Markdown 表格
 *
 * 只取中栏列是刻意的：来源、证据级、权威性都在右栏补充列，
 * 对外材料因此天然不含内部治理信息。
 */
function renderTableMiddle(code: string, stageData: readonly StageData[]): string {
  const t = tableDef(code);
  if (!t) return "";
  const rows = stageData.filter((r) => r.table_code === code);
  if (rows.length === 0) return "";

  // 多子块表（如方案架构与接口）块间列不同，必须按块分别渲染——不能把各块列拼成一张表
  const groups: { label: string; cols: readonly { key: string; label: string }[] }[] =
    t.columns.some((c) => c.block)
      ? Object.entries(middleColumnsByBlock(t)).map(([label, cols]) => ({ label, cols }))
      : [{ label: "", cols: middleColumns(t) }];

  const blocks: string[] = [];
  for (const g of groups) {
    const cols = g.cols.filter((c) => c.key !== t.groupBy);
    if (cols.length === 0) continue;
    // 该块没有任何数据就跳过（避免出现一张全空的块表）
    const hasData = rows.some((r) =>
      cols.some((c) => {
        const v = r.row[c.key];
        return Array.isArray(v) ? v.length > 0 : String(v ?? "").trim() !== "";
      }),
    );
    if (!hasData) continue;

    const headers = cols.map((c) => c.label);
    const title = `**${code} ${t.name}${g.label ? `（${g.label}块）` : ""}**`;
    const body = rows.map((r) => {
      const cells = cols.map((c) => {
        const v = r.row[c.key];
        const text = Array.isArray(v) ? v.join("、") : String(v ?? "").trim();
        return text.replace(/\|/g, "/").replace(/\n/g, " ") || "—";
      });
      return `| ${cells.join(" | ")} |`;
    });
    blocks.push(
      [title, "", `| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...body].join("\n"),
    );
  }
  return blocks.join("\n\n");
}
