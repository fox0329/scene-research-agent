/**
 * stage-summary — 阶段总结文档生成（对应 04 §五）
 *
 * 每份总结**围绕一个范围**展开**不给决策建议**（是否该进由用户自己定），
 * 但**每条信息都必须带核实判定**（准确吗·客观吗·为什么——v1.27 用户定调）：
 *  - `scope: "step"`（右栏默认，v2.9）：**只讲本步**——表集限本步、不含用户诉求全文、
 *    不含上下游衔接（用户定调："右栏的补充说明和阶段总结只针对当前阶段做说明和总结，
 *    不要整理整个过程"）
 *  - `scope: "stage"`（交付物装配用）：阶段级归纳，开头带诉求基准、结尾带上下游衔接
 *
 * 关键设计：**确定性生成**——由阶段信息行 + 完整度报告 + 注册表推导，
 * 不需要 LLM（更稳、可测、零成本）。LLM 只用于可选润色，不是必需路径。
 */

import {
  STAGE_DEFS,
  TABLES,
  flowStep,
  middleColumns,
  stageDef,
  tableDef,
  tablesOfStage,
  type InfoStageId,
  type TableDef,
} from "@scene/contract";
import { gapsToSummaryLines, isEmptyValue, type InfoRow, type StageCompleteness } from "./completeness.js";

export interface StageSummaryInput {
  stage: InfoStageId;
  /**
   * 本份总结覆盖的表集（缺省 = 本阶段全部表）
   *
   * 右栏按**当前步骤**传本步表集：阶段 1 横跨第 1、2 两步（表1-1 归第 1 步），
   * 不限定表集就会在第 2 步的总结里再讲一遍场景定义。
   */
  tableCodes?: readonly string[];
  /**
   * 步骤号（右栏口径）：给了就用**本步的标题与目标**做抬头与摘要首句，
   * 抬头从「阶段 1 · 认识场景」变成「第 2 步 · 认识场景」
   */
  step?: number;
  /**
   * 总结范围（v2.9）
   *
   * - `step`（右栏默认）：只讲本步——跳过用户诉求全文与「上下游衔接」
   * - `stage`（交付物装配）：阶段级归纳，含诉求基准与上下游衔接
   */
  scope?: "step" | "stage";
  scenarioName: string;
  /** 产品线名（可缺） */
  productLineName?: string;
  /** 表号 → 行 */
  rowsByTable: Readonly<Record<string, readonly InfoRow[] | undefined>>;
  /** 完整度报告（由 checkStageCompleteness 产出） */
  completeness: StageCompleteness;
  /** 用户诉求原文（第一输入，作为文档开头的基准） */
  briefRawText?: string;
  /** 生成时间（可注入，便于测试） */
  generatedAt?: string;
}

/** 取一行里第一个非空业务值（用于给行起名——行标识） */
function firstValue(row: InfoRow, keys: readonly string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (!isEmptyValue(v)) return String(v).trim();
  }
  return "";
}

/** 取一行里最多 n 个非空业务值（用于关键信息清单的取值样例，比只有标识更有信息量） */
function valuesOf(row: InfoRow, keys: readonly string[], n = 2): string {
  const out: string[] = [];
  for (const k of keys) {
    const v = row[k];
    if (!isEmptyValue(v)) out.push(String(v).trim());
    if (out.length >= n) break;
  }
  return out.join("·");
}

/**
 * 权威性分布的文案（第一、第四节共用）
 *
 * v1.27 修：第四节原来只印 T1-T4，漏了「未标」——当整阶段都没标权威性时，
 * 第四节会显示「T1 0 / T2 0 / T3 0 / T4 0；不同来源共 3 个」，自相矛盾。
 */
function authoritySummary(dist: Record<string, number>, unit = ""): string {
  const parts = (["T1", "T2", "T3", "T4"] as const).map((k) => `${k} ${dist[k]}${unit}`);
  if (dist["未标"]) parts.push(`未标 ${dist["未标"]}${unit}`);
  return parts.join(" / ");
}

/** 来源权威性分布（T1-T4） */
function authorityDistribution(rows: readonly InfoRow[]): Record<string, number> {
  const dist: Record<string, number> = { T1: 0, T2: 0, T3: 0, T4: 0, 未标: 0 };
  for (const row of rows) {
    const a = String(row["source_authority"] ?? row["authority"] ?? "").trim();
    dist[a in dist ? a : "未标"] = (dist[a in dist ? a : "未标"] ?? 0) + 1;
  }
  return dist;
}

/** 一行信息 + 它属于哪张表（保证起名/取列时用对表） */
interface RowEntry {
  code: string;
  row: InfoRow;
}

/** 汇总本阶段全部行，并保留表的归属 */
function allEntries(input: StageSummaryInput, tables: readonly TableDef[]): RowEntry[] {
  const out: RowEntry[] = [];
  for (const t of tables) {
    for (const row of input.rowsByTable[t.code] ?? []) out.push({ code: t.code, row });
  }
  return out;
}

/** 核实结论的五个取值（顺序：从最强到最弱） */
export const VERIFICATION_VERDICTS = [
  "已核实",
  "交叉一致",
  "行业通例",
  "单一来源",
  "无法核实",
  "有反证",
] as const;

/** 取一行的核实结论；早期数据没有该列时算「未核」 */
export function verificationVerdict(row: Record<string, unknown>): string {
  const v = String(row["verification_verdict"] ?? "").trim();
  return v === "" ? "未核" : v;
}

/** 本份总结覆盖的表（按给定顺序；`tableCodes` 缺省 = 本阶段全部表） */
function tablesFor(input: StageSummaryInput): TableDef[] {
  if (!input.tableCodes) return [...tablesOfStage(input.stage)];
  return input.tableCodes
    .map((c) => tableDef(c))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));
}


/** 给一行起个可读标签（用**它自己那张表**的中栏列） */
function labelOf(entry: RowEntry): string {
  const keys = middleColumns(tableDef(entry.code)).map((c) => c.key);
  return firstValue(entry.row, keys) || "(未命名条目)";
}

/**
 * 生成阶段总结文档（Markdown，六段骨架）
 *
 * 骨架：一、信息摘要 ｜ 二、关键信息清单 ｜ 三、说明与方法口径
 *       四、核实结论 ｜ 五、待补齐信息
 *       （**步骤级**到此为止；**阶段级**再加 六、上下游衔接）
 */
export function buildStageSummary(input: StageSummaryInput): string {
  const def = stageDef(input.stage);
  const scope = input.scope ?? "stage";
  const tables = tablesFor(input);
  const entries = allEntries(input, tables);
  const rows = entries.map((e) => e.row);
  const dist = authorityDistribution(rows);
  const generatedAt = input.generatedAt ?? new Date().toISOString().slice(0, 10);
  const L: string[] = [];

  // 文档头（右栏按步骤时抬头写「第 n 步」，不用底层阶段名——用户看的单位是步）
  const stepDef = input.step === undefined ? undefined : flowStep(input.step);
  L.push(
    stepDef
      ? `# 第 ${input.step} 步 · ${stepDef.title} — 总结`
      : `# 阶段 ${input.stage} · ${def.name} — 总结`,
  );
  L.push("");
  L.push(
    `> 场景：${input.scenarioName}${input.productLineName ? ` ｜ 产品线：${input.productLineName}` : ""} ｜ 生成时间：${generatedAt} ｜ 信息完整度：${input.completeness.tablesWithData}/${input.completeness.expectedTables} 张表齐备（${input.completeness.percent}%）`,
  );
  if (scope !== "step" && input.briefRawText) {
    L.push(">");
    L.push("> **用户诉求（第一输入，唯一基准）**：");
    for (const line of input.briefRawText.split("\n")) L.push(`> ${line}`);
  }
  L.push("");

  // 一、信息摘要
  const assumptions = entries.filter((e) => String(e.row["evidence_level"] ?? "") === "C");
  const inferred = entries.filter((e) => String(e.row["source_type"] ?? "") === "AI推断");
  L.push("## 一、信息摘要");
  L.push("");
  L.push(
    stepDef ? `本步要获得的信息是：${stepDef.goal}` : `本阶段要获得的信息是：${def.goal}`,
  );
  L.push("");
  L.push(
    `共获得 **${tables.length} 张表 / ${rows.length} 行**信息（其中 ${input.completeness.tablesWithData} 张表已有数据）；` +
      `来源分布 ${authoritySummary(dist)}；` +
      `标注为 C 级假设的条目 ${assumptions.length} 条、系统推断条目 ${inferred.length} 条。`,
  );
  L.push("");

  // 二、关键信息清单
  L.push("## 二、关键信息清单");
  L.push("");
  if (rows.length === 0) {
    L.push(stepDef ? "（本步尚无信息，见第五节待补清单）" : "（本阶段尚无信息，见第五节待补清单）");
  } else {
    for (const t of tables) {
      const tRows = input.rowsByTable[t.code] ?? [];
      if (tRows.length === 0) {
        L.push(`- **${t.code} ${t.name}**：尚无数据`);
        continue;
      }
      const keys = middleColumns(t).map((c) => c.key).slice(0, 3);
      const sample = tRows
        .slice(0, 3)
        .map((r) => valuesOf(r, keys))
        .filter((s) => s !== "");
      L.push(
        `- **${t.code} ${t.name}**：${tRows.length} 行${sample.length ? `——${sample.join("；")}${tRows.length > 3 ? " …" : ""}` : ""}`,
      );
    }
  }
  L.push("");

  // 三、说明与方法口径
  L.push("## 三、说明与方法口径");
  L.push("");
  L.push("- 口径：数值型字段按材料原值录入，未做换算；价格类为材料所示口径（含税/年份以材料为准）。");
  if (assumptions.length > 0) {
    L.push(`- **C 级假设（${assumptions.length} 条，按 G-R2 不作结论；核实结论见第四节）**：`);
    for (const e of assumptions.slice(0, 10)) {
      L.push(`  - ${e.code}｜${labelOf(e)}`);
    }
  } else {
    L.push("- C 级假设：无。");
  }
  if (inferred.length > 0) {
    L.push(`- **系统推断（${inferred.length} 条，模型按行业通例补的；核实结论见第四节）**：`);
    for (const e of inferred.slice(0, 10)) {
      L.push(`  - ${e.code}｜${labelOf(e)}`);
    }
  } else {
    L.push("- 系统推断：无。");
  }
  L.push("");

  // 四、核实结论（v1.27：每条信息都带核实判定——准不准、客不客观、为什么）
  L.push("## 四、核实结论");
  L.push("");
  const sources = [...new Set(rows.map((r) => String(r["source"] ?? "").trim()).filter((s) => s !== ""))];
  if (rows.length === 0) {
    L.push(
      stepDef ? "（本步尚无信息，见第五节待补清单）" : "（本阶段尚无信息，见第五节待补清单）",
    );
  } else {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const v = verificationVerdict(r);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const unverified = counts.get("未核") ?? 0;
    L.push(
      `- 核实分布：${VERIFICATION_VERDICTS.map((v) => `${v} ${counts.get(v) ?? 0} 条`).join(" / ")}` +
        (unverified > 0 ? ` ／ 未核 ${unverified} 条（早期数据未带核实列）` : ""),
    );
    for (const [verdict, tail] of [
      ["有反证", "材料之间冲突，冲突点写在核实说明里"],
      ["无法核实", "本客户事实缺材料、或材料冲突到判不了——**不能当结论用**"],
    ] as const) {
      const list = entries.filter((e) => verificationVerdict(e.row) === verdict);
      if (list.length === 0) continue;
      L.push(`- **${verdict}（${list.length} 条）：${tail}**：`);
      for (const e of list.slice(0, 10)) L.push(`  - ${e.code}｜${labelOf(e)}`);
      if (list.length > 10) L.push(`  - （其余 ${list.length - 10} 条见各表）`);
    }
    L.push("- 每条信息的核实理由（**准确**：对得上哪份材料、能否复算；**客观**：事实还是推断、谁的口径、有无利益相关方；**为什么**：凭什么采信、哪里不确定）见各表「核实说明」列。");
    if (sources.length > 0) {
      L.push(
        `- 来源分布：${authoritySummary(dist, " 条")}；不同来源共 ${sources.length} 个`,
      );
    } else {
      L.push("- 来源分布：本步尚未带来源的信息（来源是硬要求，见第五节待补清单）");
    }
  }
  L.push("");

  // 五、待补齐信息（缺口分属主：用户的活 vs 智能体的待办）
  L.push("## 五、待补齐信息");
  L.push("");
  for (const line of gapsToSummaryLines(input.completeness)) L.push(line);
  L.push("");

  // 六、上下游衔接（**只在阶段级/交付物装配时给**：右栏按步骤总结时不讲整个过程）
  if (scope !== "step") {
    L.push("## 六、上下游衔接");
    L.push("");
    L.push(`- 本阶段产出：${tables.map((t) => t.code).join("、") || "（无信息表）"}`);
    const downstream = new Map<InfoStageId, string[]>();
    for (const t of tables) {
      for (const s of t.consumedBy ?? []) {
        const list = downstream.get(s);
        if (list) list.push(t.code);
        else downstream.set(s, [t.code]);
      }
    }
    for (const [s, codes] of [...downstream.entries()].sort((a, b) => a[0] - b[0])) {
      const name = STAGE_DEFS.find((x) => x.id === s)?.name ?? `阶段 ${s}`;
      L.push(`  - 阶段 ${s} · ${name} 会引用：${[...new Set(codes)].join("、")}`);
    }
    const upstream = TABLES.filter(
      (t) => t.stage < input.stage && (t.consumedBy ?? []).includes(input.stage),
    ).map((t) => t.code);
    L.push(`- 上游依据：${upstream.join("、") || "（无跨阶段依赖）"}`);
    L.push("");
  }
  L.push("---");
  L.push("");
  L.push(
    "> 本文档每条信息都带**核实结论**（准不准 · 客不客观 · 为什么）；只给可核实的事实与判定，**不给决策建议**——该不该进由你自己定。",
  );
  L.push("");
  return L.join("\n");
}
