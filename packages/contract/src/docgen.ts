/**
 * @scene/contract — 表定义文档生成器（纯函数）
 *
 * 目的：**消除 `05-表格定义总表.md` 与 `tables.ts` 两处人工维护的漂移风险**——
 * 05 的逐表定义与汇总校验由本模块从注册表生成，只有「通用约定」（规则）与
 * 「取消与合并清单 / 新旧对照 / 版本记录」（历史）保留人工撰写。
 *
 * 组成：`05 = preamble(手写) + renderTables(生成) + appendix(手写) + renderSummary(生成) + version(手写)`
 */

import {
  blockLabel,
  TABLES,
  STAGE_DEFS,
  ENUMS,
  MIDDLE_COLUMN_BUDGET,
  middleColumnsByBlock,
  effectiveMiddleMax,
  type TableColumn,
  type TableDef,
  type InfoStageId,
} from "./tables.js";

// ─── 渲染助手 ──────────────────────────────────────────────

function typeLabel(c: TableColumn): string {
  if (c.enum) return ENUMS[c.enum].join(" / ");
  switch (c.type) {
    case "number":
      return "数值";
    case "date":
      return "日期";
    case "ref":
      return `引用 ${c.refTable ?? "其他表"}`;
    case "longText":
      return "文本（长）";
    default:
      return "文本";
  }
}

function requiredLabel(c: TableColumn): string {
  if (c.required) return "✔";
  if (c.requiredWhen) return `条件✔（${c.requiredWhen}）`;
  return "";
}

function columnTable(cols: readonly TableColumn[]): string {
  const withNote = cols.some((c) => Boolean(c.note));
  const head = withNote
    ? "| 字段 | 中文表头 | 必填 | 枚举/类型 | 栏位 | 说明 |\n|---|---|---|---|---|---|"
    : "| 字段 | 中文表头 | 必填 | 枚举/类型 | 栏位 |\n|---|---|---|---|---|";
  const rows = cols.map((c) => {
    const base = `| \`${c.key}\` | ${c.label} | ${requiredLabel(c)} | ${typeLabel(c)} | ${c.slot} |`;
    return withNote ? `${base} ${c.note ?? ""} |` : base;
  });
  return [head, ...rows].join("\n");
}

function stageNames(stages: readonly InfoStageId[] | undefined): string {
  if (!stages || stages.length === 0) return "—";
  return stages.map((s) => `阶段 ${s}`).join("、");
}

/** 中栏列摘要文本（用于栏位分配行） */
function middleSummary(t: TableDef, category?: string): string {
  const payload = category && t.payloads ? (t.payloads[category] ?? []) : [];
  const cols = [...t.columns, ...payload].filter(
    (c) => c.slot === "中栏" && c.key !== t.groupBy,
  );
  const labels = cols.map((c) => (c.type === "longText" ? `${c.label}·截断` : c.label));
  return `中栏 ${cols.length} 列（${labels.join(" / ")}）`;
}

function supplementSummary(t: TableDef, category?: string): string {
  const payload = category && t.payloads ? (t.payloads[category] ?? []) : [];
  const cols = [...t.columns, ...payload].filter((c) => c.slot === "右栏补充");
  return cols.length ? `右栏补充：${cols.map((c) => c.label).join("、")}` : "右栏补充：—";
}

/** 单张表的栏位分配行（块表 / payload 表分别列出） */
function slotAllocation(t: TableDef): string {
  if (t.payloads) {
    const parts = Object.keys(t.payloads).map(
      (cat) => `${cat} → ${middleSummary(t, cat)}`,
    );
    return `${parts.join("；")} ｜${supplementSummary(t)}`;
  }
  if (t.columns.some((c) => c.block)) {
    const byBlock = middleColumnsByBlock(t);
    const parts = Object.entries(byBlock).map(([b, cols]) => {
      const labels = cols.map((c) => (c.type === "longText" ? `${c.label}·截断` : c.label));
      return `${b} ${cols.length} 列（${labels.join(" / ")}）`;
    });
    return `${parts.join("；")} ｜${supplementSummary(t)}`;
  }
  return `${middleSummary(t)} ｜${supplementSummary(t)}`;
}

// ─── 单张表渲染 ────────────────────────────────────────────

function renderTable(t: TableDef): string {
  const L: string[] = [];
  const badges: string[] = [];
  if (t.pinned) badges.push("**= 场景锚**，全链唯一场景定义");
  const badge = badges.length ? `（${badges.join("；")}）` : "";

  L.push(`### ${t.code} ${t.name} ｜\`${t.tier}\`${badge}`);
  L.push("");
  L.push(`- **目的**：${t.purpose} ｜**行粒度**：${t.rowUnit}`);
  if (t.groupBy) L.push(`- **分组维度**：\`${t.groupBy}\`（不进列，按它分组渲染）`);
  L.push(`- **栏位分配**：${slotAllocation(t)}`);
  L.push("");

  if (t.fixedRows) {
    L.push("- **固定行（「项 / 内容」纵向呈现）**");
    L.push("");
    L.push("| 项 | 必填 | 内容属主 | 说明 |");
    L.push("|---|---|---|---|");
    for (const r of t.fixedRows) {
      L.push(`| ${r.label} | ${r.required ? "✔" : ""} | ${r.owner ?? "智能体"} | ${r.note ?? ""} |`);
    }
    L.push("");
    L.push("- **列**");
    L.push("");
    L.push(columnTable(t.columns));
    L.push("");
  } else if (t.payloads) {
    L.push("- **列（通用）**");
    L.push("");
    L.push(columnTable(t.columns));
    L.push("");
    L.push(`- **payload（1 张表 ${Object.keys(t.payloads).length} 种形状，按类别切换）**`);
    L.push("");
    for (const [cat, cols] of Object.entries(t.payloads)) {
      L.push(`**${cat}**`);
      L.push("");
      L.push(columnTable(cols));
      L.push("");
    }
  } else if (t.columns.some((c) => c.block)) {
    const byBlock = middleColumnsByBlock(t);
    for (const [block, cols] of Object.entries(byBlock)) {
      L.push(`- **${blockLabel(t, block)}**`);
      L.push("");
      L.push(columnTable(cols));
      L.push("");
    }
    const sup = t.columns.filter((c) => c.slot === "右栏补充");
    if (sup.length) {
      L.push("- **右栏补充列**");
      L.push("");
      L.push(columnTable(sup));
      L.push("");
    }
  } else {
    L.push("- **列**");
    L.push("");
    L.push(columnTable(t.columns));
    L.push("");
  }

  L.push(`- **完整度规则**：${t.completeness.map((c, i) => `${i + 1}. ${c}`).join("；")}`);
  L.push(`- **被谁引用**：${stageNames(t.consumedBy)}`);
  L.push("");
  return L.join("\n");
}

// ─── 逐阶段渲染（§二 ~ §八） ───────────────────────────────

const STAGE_CHAPTER: Readonly<Record<number, string>> = {
  0: "## 二、阶段 0 · 材料解析与入库",
  1: "## 三、阶段 1 · 认识场景（含门槛与合规）",
  2: "## 四、阶段 2 · 理解商业",
  3: "## 五、阶段 3 · 能力匹配",
  4: "## 六、阶段 4 · 方案与实现",
  5: "## 七、阶段 5 · 价值与验证",
  6: "## 八、阶段 6 · 总结沉淀",
};

export function renderTables(): string {
  const out: string[] = [];
  for (const s of STAGE_DEFS) {
    const tables = TABLES.filter((t) => t.stage === s.id);
    if (tables.length === 0) continue;
    out.push(`${STAGE_CHAPTER[s.id]}——${tables.length} 张信息表`);
    out.push("");
    out.push(`> **本阶段要获得什么信息**：${s.goal}`);
    out.push(">");
    out.push(`> **右栏总结文档**：${s.summaryTitle}（六段骨架见 §一 1.6）`);
    out.push("");
    for (const t of tables) out.push(renderTable(t));
    out.push("---");
    out.push("");
  }
  return out.join("\n");
}

// ─── 汇总校验（§十一，计数自动计算） ───────────────────────

export function renderSummary(): string {
  const L: string[] = [];
  const tierCount = (tier: string): number => TABLES.filter((t) => t.tier === tier).length;

  L.push("## 十一、汇总校验");
  L.push("");
  L.push("> 本节的数字由 `packages/contract/src/tables.ts` 自动计算，请勿手改（改了会被单测抓出来）。");
  L.push("");
  L.push("| 项 | 数量 |");
  L.push("|---|---|");
  L.push("| 00b 表总数 | 63 |");
  L.push(`| **保留** | **${TABLES.length}** |`);
  L.push(`| 合并或取消 | ${63 - TABLES.length} |`);
  L.push(`| 其中 \`重要\`（中栏表格，逐格校对） | **${tierCount("重要")}** |`);
  L.push(`| 其中 \`支撑\`（中栏折叠，抽查来源） | **${tierCount("支撑")}** |`);
  L.push(`| 其中 \`过程\`（归右栏阶段总结文档） | **${tierCount("过程")}** |`);
  L.push("");
  L.push("**逐阶段分布**");
  L.push("");
  L.push("| 阶段 | 重要 | 支撑 | 过程 | 中栏列预算 | 小计 |");
  L.push("|---|---|---|---|---|---|");
  for (const s of STAGE_DEFS) {
    const ts = TABLES.filter((t) => t.stage === s.id);
    if (ts.length === 0) continue;
    const c = (tier: string): number => ts.filter((t) => t.tier === tier).length;
    const maxMid = Math.max(...ts.map((t) => effectiveMiddleMax(t)));
    L.push(`| 阶段 ${s.id} · ${s.name} | ${c("重要")} | ${c("支撑")} | ${c("过程")} | ≤${MIDDLE_COLUMN_BUDGET}（实际最大 ${maxMid}） | **${ts.length}** |`);
  }
  const total = (tier: string): number => tierCount(tier);
  L.push(`| **合计** | **${total("重要")}** | **${total("支撑")}** | **${total("过程")}** | — | **${TABLES.length}** |`);
  L.push("");
  L.push(
    `**用户实际负担**：逐格校对 **${total("重要")} 张**；抽查 **${total("支撑")} 张**；不看 **${total("过程")} 张**（归入右栏总结文档）。`,
  );
  L.push("");
  L.push(
    `**列预算**：中栏列数上限 **${MIDDLE_COLUMN_BUDGET} 列**；元信息列（source / evidence_level / authority）与长文本一律进右栏补充。`,
  );
  L.push("");
  return L.join("\n");
}

// ─── 组装 ──────────────────────────────────────────────────

/** 组装完整文档：preamble(手写) + 逐表(生成) + appendix(手写) + 汇总(生成) + version(手写) */
export function composeTableDoc(parts: {
  preamble: string;
  appendix: string;
  version: string;
}): string {
  return [
    parts.preamble.replace(/\s+$/, ""),
    "",
    renderTables().replace(/\s+$/, ""),
    "",
    parts.appendix.replace(/\s+$/, ""),
    "",
    renderSummary().replace(/\s+$/, ""),
    "",
    parts.version.replace(/\s+$/, ""),
    "",
  ].join("\n");
}
