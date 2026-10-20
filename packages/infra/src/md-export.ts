/**
 * @scene/infra — 交付物导出（Markdown）
 *
 * 用户定调（2026-10-06）：「交付物的内容质量太差了吧，首先应该是报告，不是记录，
 * 整体章节应该是差不多了，都是场景定义、认识、存在的问题、我们的方案，能够提供的
 * 价值、总结。只是内部侧重客观、风险。外部侧重痛点、方案、价值。」
 *
 * 变更表 #112 再往前一步：正文**由模型撰写**（用户定调「要的是总结，不是罗列」——
 * 逐行搬要点仍是罗列，归纳只能靠模型读完数据后重写）。本文件因此变成三层：
 *  1. **原料与兜底**：`reportChapterDigest()` 把每章的数据按小节整理成确定性的要点版
 *     —— 同一个函数既是喂给模型的输入材料，也是模型没写成/没通过校验时该章的兜底；
 *  2. **装配**：`buildReportMarkdown()` 拼头部 + 该口径的全部章节（模型正文优先、逐章兜底）；
 *  3. **口径**：章节顺序与章名由契约决定（`reportChapters(kind)`），模型只写正文。
 *
 * 交付物口径（变更表 #137）：`kind` 决定这一份是**哪份交付物**——
 *  `solution` = <场景>解决方案（现状 / 场景与问题 / 方案 / 价值 / 下一步），
 *  `construction` = <场景>建设工作方案（建设背景与必要性 … 监管协同展望）。
 *  章名、章节数、每章的素材块全部由契约 `REPORT_CHAPTERS[kind]` 给出，本文件不维护第二份。
 *
 * 章节结构：
 *  - 章标题**不带序号**（Markdown 里也不手写「一、」）：Word 交付物由模板多级列表
 *    自动编号（1 / 1.1 / 1.1.1），增删章节自动重排；
 *  - 每章先一句**由数据算出来的导语**，再按小节给「一行一条结论」的要点（数值/对比类
 *    用表格）——不是把表 dump 出来，也不再出现「阶段 N 总结 / 一、信息摘要」这种流水账。
 *
 * 两条铁律：
 *  1. **不给决策建议**——只陈述信息、判定与缺口；
 *  2. **交付物不含内部信息**——不出现来源、证据级、内部论据与财务口径。
 *
 * 输出纯 Markdown 字符串，不写文件。
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  REPORT_KIND_LABEL,
  reportChapterHeading,
  reportChapters,
  middleColumns,
  tableDef,
  type DeliverableInput,
  type ReportBlock,
  type ReportChapter,
  type ReportKind,
  type StageData,
} from "@scene/contract";
import { hasCustomerBaseline, repairProseHeads } from "@scene/domain";

// ─── 覆盖留档 ──────────────────────────────────────────────

/**
 * 覆盖前留档：把已有文件复制到同目录 `.history/<名字>.<时间戳>.md`
 *
 * 用户会直接在交付物上改字（删章节、改措辞），而"重新生成/重新导出"必然整篇覆盖。
 * 留一份历史，手改永远不会被静默吃掉；每个文件最多保留最近 10 份。
 */
export function backupBeforeOverwrite(path: string): string | null {
  if (!existsSync(path)) return null;
  const dir = join(dirname(path), ".history");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const target = join(dir, `${basename(path, ".md")}.${stamp}.md`);
  copyFileSync(path, target);
  const kept = readdirSync(dir)
    .filter((f) => f.startsWith(`${basename(path, ".md")}.`))
    .sort()
    .reverse();
  for (const old of kept.slice(10)) rmSync(join(dir, old), { force: true });
  return target;
}


// ─── 先读后写（交付物写入保护，变更表 #131） ────────────────

/**
 * 写文件前**必须先读**：确认当前状态，再决定要不要改。
 *
 * 三种情形：
 *  1. 文件不存在 → 写，并记指纹；
 *  2. 内容与"应用上次写出的内容"**逐字节相同** → 什么都不做（连 mtime 都不动）；
 *  3. 内容不同：
 *     - 与应用上次写出的指纹一致（只是应用自己写过、这次内容变了）→ 留档后覆盖；
 *     - 指纹不一致（**文件被手改过**）→ **不动用户的文件**，新内容另存为
 *       `<名字> (应用版 YYYYMMDD-HHMMSS).md`，并给出提示。
 *
 * 用户手改过的交付物，任何一次生成/导出都不可能再静默覆盖它。
 */
export interface SafeWriteResult {
  /** 内容实际落在哪个文件里（被手改时是另存名） */
  path: string;
  /** 有没有真的写盘（内容相同则不写） */
  written: boolean;
  /** 是否覆盖了原文件 */
  overwritten: boolean;
  /** 需要告诉用户的话（被手改时） */
  notice?: string;
}

/** 应用上次写出的内容指纹存放在同目录 `.state/`，不污染交付物目录 */
function fingerprintPath(path: string): string {
  return join(dirname(path), ".state", `${basename(path)}.sha256`);
}

function sha256(payload: string | Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

export function safeWriteFile(path: string, content: string): SafeWriteResult {
  return safeWrite(path, Buffer.from(content, "utf8"));
}

/** 同 safeWriteFile，但写二进制（导出 Word 用）；指纹算法一致，同一个文件两种调用可互认 */
export function safeWriteFileBytes(path: string, bytes: Uint8Array): SafeWriteResult {
  return safeWrite(path, Buffer.from(bytes));
}

function safeWrite(path: string, payload: Buffer): SafeWriteResult {
  const fp = fingerprintPath(path);
  const next = sha256(payload);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, payload);
    recordFingerprint(fp, next);
    return { path, written: true, overwritten: false };
  }
  const current = sha256(readFileSync(path));
  if (current === next) return { path, written: false, overwritten: false }; // 一模一样：不碰文件
  const recorded = existsSync(fp) ? readFileSync(fp, "utf8").trim() : "";
  if (recorded === current) {
    backupBeforeOverwrite(path);
    writeFileSync(path, payload);
    recordFingerprint(fp, next);
    return { path, written: true, overwritten: true };
  }
  // 被手改过：保住用户的版本，新内容另存
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const ext = basename(path).includes(".") ? `.${basename(path).split(".").pop() as string}` : "";
  const alt = join(dirname(path), `${basename(path, ext)} (应用版 ${stamp})${ext}`);
  writeFileSync(alt, payload);
  recordFingerprint(fingerprintPath(alt), next);
  return {
    path: alt,
    written: true,
    overwritten: false,
    notice: `${basename(path)} 被手改过，已保留你的版本；新版本另存为 ${alt}`,
  };
}

function recordFingerprint(fp: string, value: string): void {
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, `${value}\n`, "utf8");
}

// ─── 命名规则（00b §11.5） ──────────────────────────────────

/**
 * 取报告自己的生成日期，取不到再用兜底日期。
 * 变更表 #134 起日期写在标题里（`# <场景> <报告类型> <日期>`）；
 * 老报告（#134 之前）的封面 `> **生成日期**：YYYY-MM-DD` 仍认，保证老文件导出文件名不变。
 */
export function reportDateOf(markdown: string, fallback: string): string {
  const title = markdown.match(/^#\s+.*?(\d{4}-\d{2}-\d{2})\s*$/m);
  if (title?.[1]) return title[1];
  const cover = markdown.match(/>\s*\*\*(?:生成)?日期\*\*：\s*(\d{4}-\d{2}-\d{2})/);
  return cover?.[1] ?? fallback;
}

/** 报告类型名（标题与文件名共用）——直接从契约取，不在本文件维护第二份文案 */
export function reportTypeName(kind: ReportKind): string {
  return REPORT_KIND_LABEL[kind];
}

/**
 * 交付物文件名：**场景名称 + 报告类型名**（变更表 #136/#137）
 *
 * 用户定调（2026-10-07）：「交付物不再分内部调研版和外部汇报版，直接用外部汇报版
 * 生成一个版本，就叫 XXX解决方案」——所以是 `智慧会议室解决方案.md`；
 * 变更表 #137 再加一份 `智慧会议室建设工作方案.md`。两份都不带日期。
 */
export function exportFileName(scenarioName: string, kind: ReportKind): string {
  const safe = scenarioName.replace(/[/\\:*?"<>|]/g, "_").trim();
  return `${safe}${reportTypeName(kind)}.md`;
}

// ─── 主入口 ────────────────────────────────────────────────

/**
 * 生成交付物（按口径装配一份纯 Markdown）
 *
 * @param data 交付物输入（场景 + 阶段数据；阶段总结不进正文）
 * @param kind 交付物口径（`solution` / `construction`，变更表 #137）
 */
export async function exportDeliverables(data: DeliverableInput, kind: ReportKind): Promise<string> {
  return buildReportMarkdown(data, kind);
}

// ─── 取数小工具 ────────────────────────────────────────────

const blank = (v: unknown): boolean => {
  const s = Array.isArray(v) ? v.join("") : String(v ?? "");
  return s.trim() === "" || s.trim() === "未提供" || s.trim() === "—";
};

const cell = (v: unknown): string => {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join("、");
  return String(v ?? "").trim();
};

/** 长句截断：报告一行一条，长段落压成一句话（完整内容在系统内表格里） */
function truncate(v: unknown, max = 70): string {
  const s = cell(v).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 每个要点块的条数上限：报告要收口，明细留在系统内表格 */
const MAX_BULLETS = 12;

/** 把「标签：值」拼起来，空值整段丢掉（报告里不该出现空标签） */
function segs(parts: readonly (readonly [string, unknown])[]): string {
  return parts
    .filter(([, v]) => !blank(v))
    .map(([label, v]) => (label ? `${label}${cell(v)}` : cell(v)))
    .join("；");
}

/** 一张表在给定列下的「部门/环节」标签，用于导语与计数文案 */
function countRows(stageData: readonly StageData[], code: string): number {
  return stageData.filter((r) => r.table_code === code).length;
}

/** 取某表某列的去重非空值 */
function valuesOf(stageData: readonly StageData[], code: string, col: string): string[] {
  const out = new Set<string>();
  for (const r of stageData) {
    if (r.table_code !== code) continue;
    const v = cell(r.row[col]);
    if (v && v !== "未提供") out.add(v);
  }
  return [...out];
}

// ─── 每张表的「一行一条」模板（报告味就在这里） ──────────────

/**
 * 表的要点模板：把结构化单元格组织成一句人话
 *
 * 为什么不做通用「标签：值」拼接：那就是记录。这里的模板按表的语义组织句子
 * （谁在做 → 用什么 → 怎么做 / 痛点 → 谁在痛 → 痛到什么程度），并**丢掉空字段**。
 */
const ROW_TEXT: Record<string, (r: Record<string, unknown>) => string> = {
  "表1-1": (r) => `**${cell(r.item)}**：${cell(r.content)}`,
  "表1-2": (r) => `**${cell(r.link)}** — ${segs([["现在由", truncate(r.owner_now, 30)], ["用", truncate(r.current_tool, 46)], ["做法：", truncate(r.current_flow, 60)]])}`,
  "表2-2": (r) => `**${cell(r.element_name)}**${r.element_type ? `（${cell(r.element_type)}）` : ""}：${segs([["", truncate(r.function, 44)], ["量级", truncate(r.price_range, 26)]])}`,
  "表2-5": (r) => `**${cell(r.constraint_item)}**：${segs([["要求", r.required_value], ["适用", r.standard_no]])}`,
  "表3-1": (r) => `**${cell(r.link)}**：毛利率 ${cell(r.gross_margin)}${r.representative ? `（代表 ${cell(r.representative)}）` : ""}`,
  "表3-2": (r) => `**${cell(r.form)}**：${segs([["", r.key_points], ["主导者", r.leader], ["适用", r.fit_for]])}`,
  "表3-3": (r) => `**${cell(r.customer_type)}**：${segs([["拍板", r.decision_maker], ["使用", r.user_role], ["付费", r.payer], ["预算科目", r.budget_item]])}`,
  "表3-4": (r) => `**${cell(r.dimension)}**：A ${cell(r.competitor_a)} ｜ B ${cell(r.competitor_b)}${blank(r.competitor_c) ? "" : ` ｜ C ${cell(r.competitor_c)}`}`,
  "表3-5": (r) => `**${cell(r.link)}**：${segs([["供给方", r.who_supplies], ["集中度", r.concentration], ["可替代性", r.substitutability], ["卡点", r.supply_risk]])}`,
  "表3-7": (r) => `**${truncate(r.pitfall, 40)}** → ${segs([["后果", truncate(r.consequence, 40)], ["方案里怎么避", truncate(r.avoid_in_design, 50)]])}`,
  "表3-8": (r) => `${r.rank ? `${cell(r.rank)}. ` : ""}**${truncate(r.gap, 60)}**${r.pain_level ? `（痛度：${cell(r.pain_level)}）` : ""} —— 谁在痛：${truncate(r.who_hurts, 30)}；现有替代：${truncate(r.current_alternative, 40)}${blank(r.cross_validation) ? "" : `；验证：${truncate(r.cross_validation, 20)}`}`,
  "表3-9": (r) => `**${cell(r.trend)}**：${segs([["驱动", r.driver], ["影响", r.impact], ["窗口", r.window]])}`,
  "表4-2": (r) => `**${cell(r.link)}**：${cell(r.can_touch)}${blank(r.our_role) ? "" : ` ｜ 我方角色：${truncate(r.our_role, 24)}`}${blank(r.role_reason) ? "" : ` ｜ 依据：${truncate(r.role_reason, 60)}`}`,
  "表4-3": (r) => `**${truncate(r.gap_ref, 46)}** → ${cell(r.match)}：${truncate(r.our_product, 46)}${blank(r.boundary_note) ? "" : `（边界：${truncate(r.boundary_note, 46)}）`}${blank(r.risk) ? "" : `（风险：${truncate(r.risk, 40)}）`}`,
  "表5-1": (r) => `**${cell(r.layer) || cell(r.interface_name)}**：${segs([["组件", truncate(r.components, 50)], ["接口", truncate(r.interface, 40)], ["对接", truncate(r.integration, 40)], ["协议", truncate(r.protocol, 30)], ["边界", truncate(r.boundary, 50)]])}`,
  "表5-3": (r) => `**${cell(r.item)}**：${truncate(r.content, 60)}${segs([["窗口", r.window], ["人天", r.man_days], ["回退", r.rollback]]) ? `（${segs([["窗口", r.window], ["人天", r.man_days], ["回退", r.rollback]])}）` : ""}`,
  "表5-4": (r) => `**${cell(r.item)}**：${truncate(r.content, 60)}${blank(r.sla) ? "" : `（SLA：${truncate(r.sla, 30)}）`}`,
  "表6-4": (r) => `**${cell(r.kind)}**：${truncate(r.content, 70)}`,
};

/** 章节导语：由数据算，不写空话 */
function chapterLead(chapter: ReportChapter, stageData: readonly StageData[]): string {
  const links = countRows(stageData, "表1-2");
  const elements = countRows(stageData, "表2-2");
  const pains = valuesOf(stageData, "表1-2", "pain").length;
  const gaps = countRows(stageData, "表3-8");
  const participate = valuesOf(stageData, "表4-2", "can_touch");
  const benefits = countRows(stageData, "表6-1");
  /**
   * 有基线的条数按 `hasCustomerBaseline` 算（不是"非空"）
   *
   * 真机事实（变更表 #153）：基线列里全是「未提供（本客户材料未含）」这类补白，
   * 按"非空"数出来是"条条有基线"——把缺口说成了成绩。写"未提供"就必须如实数成没有基线，
   * 否则这条导语本身就是在编。
   */
  const withBaseline = stageData.filter(
    (r) => r.table_code === "表6-1" && hasCustomerBaseline(r.row["baseline"]),
  ).length;
  switch (chapter.key) {
    case "status":
      return links > 0
        ? `本场景拆出 ${links} 个业务环节、${elements} 个场景要素；现状做法与系统连接方式如下。`
        : "";
    case "problems":
      return pains > 0 || gaps > 0
        ? `现场层面的问题 ${pains} 处；${gaps} 条需求今天还没被满足。`
        : "";
    case "solution":
      return `我方可在 ${participate.length > 0 ? participate.join(" / ") : "待判定"} 的环节参与；下面对照每条需求说明给什么产品、边界在哪。`;
    case "value":
      return benefits > 0
        ? `${benefits} 条收益对应指标已经写清；其中 ${withBaseline} 条有基线。`
        : "";
    default:
      return "";
  }
}

// ─── 渲染 ──────────────────────────────────────────────────

/** 一张块渲染成 Markdown（要点或表格）；无数据返回空串 */
function renderBlock(
  block: ReportBlock,
  stageData: readonly StageData[],
  full = false,
): string {
  const t = tableDef(block.code);
  if (!t) return "";
  const rows = stageData.filter((r) => r.table_code === block.code);
  if (rows.length === 0) return "";

  /**
   * 取列：**显式列出的 key 从全部列里取，不按中栏/右栏过滤**（变更表 #153）
   *
   * 章节映射（`REPORT_CHAPTERS` 的 `cols`）声明的是"这一章要讲这张表的哪几个侧面"，
   * 与列在界面上摆哪一栏无关。第 5 阶段表6-1 的「基线」已挪到右栏补充说明——
   * 若这里仍按 `middleColumns` 过滤，报告的价值章就会**静默丢掉基线**（用户看不到基线，
   * 也看不到"基线未提供"的如实说明），所以这里改按映射里写明的 key 取。
   * 没写 `cols` 时才退回"该表全部中栏列"（其余表的老口径不变）。
   */
  const midCols = middleColumns(t).filter((c) => c.key !== t.groupBy);
  const cols = block.cols
    ? t.columns.filter((c) => c.key !== t.groupBy && block.cols!.includes(c.key))
    : midCols;
  const label = (key: string): string => cols.find((c) => c.key === key)?.label ?? key;

  const out: string[] = [`### ${block.heading}`, ""];
  if (block.as === "table") {
    const headers = cols.map((c) => c.label);
    const body = rows.map((r) => {
      const cells = cols.map((c) => {
        const v = cell(r.row[c.key]).replace(/\|/g, "/").replace(/\n/g, " ");
        return v === "" || v === "未提供" ? "—" : v;
      });
      return `| ${cells.join(" | ")} |`;
    });
    out.push(`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...body, "");
  } else {
    const tmpl = ROW_TEXT[block.code];
    const seen = new Set<string>();
    const bullets: string[] = [];
    for (const r of rows) {
      const text = (tmpl ? tmpl(r.row) : segs(cols.map((c) => [label(c.key) + "：", r.row[c.key]] as const))).trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      bullets.push(text);
    }
    if (full) {
      out.push(`（共 ${bullets.length} 条，已全部列出）`);
      for (const b of bullets) out.push(`- ${b}`);
      out.push("");
      return out.join("\n").trim();
    }
    for (const b of bullets.slice(0, MAX_BULLETS)) out.push(`- ${b}`);
    out.push("");
  }
  return out.join("\n").trimEnd();
}

export interface ChapterDigest {
  key: string;
  title: string;
  /** 该章的确定性内容（含 `### 小节`，不含 `## 章名`） */
  markdown: string;
}

/**
 * 每章的确定性内容（原料 + 兜底）
 *
 * 同时供两处使用：① 作为模型撰写正文时的输入材料（分章给数据，模型不用自己找表）；
 * ② 模型漏写某章或该章没过确定性校验时，用它顶上。两处同源，报告不会出现"模型写的
 * 章与要点版口径不一致"。
 *
 * @param kind 交付物口径——章节按 `reportChapters(kind)` 走，两份交付物的章节各归各的
 */
export interface DigestOptions {
  /**
   * true = 交给模型当撰写原料
   *
   * 要点版给人看，截断到 8 条是好事；但给模型时**绝不能截断**——模型看不到全量
   * 就会在报告里写"原料只展开了 8 条、其余待补"（实测出现），凭空造出一个缺口。
   */
  full?: boolean;
}

export function reportChapterDigest(
  kind: ReportKind,
  stageData: readonly StageData[],
  opts: DigestOptions = {},
): ChapterDigest[] {
  return reportChapters(kind).map((chapter) => {
    const blocks = chapter.blocks;
    const parts: string[] = [];
    const lead = chapterLead(chapter, stageData);
    if (lead) parts.push(lead, "");
    {
      let rendered = 0;
      for (const b of blocks) {
        const md = renderBlock(b, stageData, opts.full === true);
        if (md) {
          parts.push(md, "");
          rendered += 1;
        }
      }
      // 一整章都没数据时要明说缺哪些表（导语已经写了，所以不能拿 parts.length 判空）
      if (rendered === 0) {
        parts.push(`（本节信息待补充：${blocks.map((b) => b.code).join("、") || "—"}）`);
      }
    }
    return {
      key: chapter.key,
      title: reportChapterHeading(kind, chapter.key),
      markdown: parts.join("\n").trim(),
    };
  });
}

/** 组装一份报告（模型正文优先，逐章兜底） */
export function buildReportMarkdown(data: DeliverableInput, kind: ReportKind): string {
  const digests = new Map(reportChapterDigest(kind, data.stageData).map((d) => [d.key, d]));
  // 空串（模型这一章没写出来）等同没写：回落该章的要点版 digest。
  // 不这么判会掉进「`""` 不是 nullish」的坑——缺章最后渲染成「（本节内容待补）」而不是兜底正文。
  const model = new Map(
    (data.chapters ?? []).map((c) => [c.key, c.markdown.trim()] as const).filter(([, md]) => md !== ""),
  );
  return buildReport(data, kind, (key) => model.get(key) ?? digests.get(key)?.markdown ?? "");
}

/**
 * 组装一份报告
 *
 * @param kind 交付物口径：决定一级标题的报告类型名与正文有哪几章
 * @param bodyOf 每章正文的来源（模型正文 → 该章兜底），由 `buildReportMarkdown` 注入
 */
function buildReport(data: DeliverableInput, kind: ReportKind, bodyOf: (key: string) => string): string {
  const { scenario } = data;

  // 封面只有一行报告名（变更表 #134，用户定稿逐字要求）：
  // 场景名与日期都在标题里，再写「场景 / 生成日期」两行引用块是重复（精要优先：一个事实只说一次）
  const sections: string[] = [`# ${scenario.name}${reportTypeName(kind)}`];

  for (const chapter of reportChapters(kind)) {
    const body: string[] = [`## ${reportChapterHeading(kind, chapter.key)}`, ""];
    // 兜最后一道（变更表 #138）：无论正文来自模型初稿、回炉稿还是历史文件，
    // 落盘前都过一遍断头段修复——装配是唯一出口，出口干净，交付物就不会带半句话。
    const text = repairProseHeads(stripEchoedTitle(bodyOf(chapter.key).trim(), chapter.label)).markdown;
    body.push(text || "（本节内容待补）");
    sections.push(body.join("\n").trimEnd());
  }

  return sections.join("\n\n---\n\n");
}

/** 归一化标题：去 `#`、去「一、」序号、去括号补充、去粗体标记 */
function normTitle(text: string): string {
  return text
    .replace(/^#+\s*/, "")
    .replace(/^[一二三四五六七八九十]+[、.．]\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/[（(].*?[)）]\s*$/, "")
    .trim();
}

/** 模型爱在正文里重抄章名时省掉的修饰（「建设背景与必要性」→「背景与必要性」） */
const TITLE_PREFIXES = ["建设", "工作", "本章", "方案", "实施"] as const;

/** 章名的尾巴修饰（「建设背景与必要性章」「建设背景与必要性部分」） */
const TITLE_SUFFIXES = ["章", "部分"] as const;

/** 「长度 ≤ N 字且被章名包含」才算回声标题的上限（防误伤正常正文首段） */
const ECHOED_TITLE_MAX_CHARS = 12;

/** 一次最多连剥两段回声标题（模型偶尔连抄两遍；剥多了会吃掉正常正文） */
const MAX_ECHOED_LINES = 2;

/** 去掉前导修饰与结尾「章 / 部分」后的各种形态（可能连着两层，如「建设工作方案」） */
function affixStripped(text: string): string[] {
  const out: string[] = [];
  let cur = text;
  for (const suf of TITLE_SUFFIXES) {
    if (cur.length > suf.length && cur.endsWith(suf)) {
      cur = cur.slice(0, -suf.length);
      out.push(cur);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const pre of TITLE_PREFIXES) {
      if (cur.length > pre.length && cur.startsWith(pre)) {
        cur = cur.slice(pre.length);
        out.push(cur);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** 章名的全部近似形态（原样 + 去修饰 + 去编号/去尾部「章」） */
function labelForms(label: string): string[] {
  const base = normTitle(label);
  const forms = new Set<string>([base, ...affixStripped(base)]);
  for (const f of [...forms]) {
    const deord = f.replace(/^第\s*[一二三四五六七八九十\d]+\s*[章部分节]\s*/, "");
    if (deord !== "" && deord !== f) forms.add(deord);
  }
  return [...forms];
}

/** 正文首段可能的形态（去编号、去尾部「章 / 部分」、去前导修饰后仍要看一遍） */
function candidateForms(line: string): string[] {
  const t = normTitle(line);
  if (t === "") return [];
  const out = new Set<string>([t, ...affixStripped(t)]);
  const deord = t.replace(/^第\s*[一二三四五六七八九十\d]+\s*[章部分节]\s*/, "");
  if (deord !== "") {
    out.add(deord);
    for (const f of affixStripped(deord)) out.add(f);
  }
  const detrail = t.replace(/[章部分]$/, "");
  if (detrail !== "") out.add(detrail);
  return [...out];
}

/**
 * 这一行是不是"回声标题"（模型把章名当正文第一段又抄了一遍）
 *
 * 只认**近似章名**，四条任一即可：等于章名 / 等于去掉「建设·工作·本章·方案·实施」前缀与
 * 末尾「章·部分」的形态 / ≤12 字且被章名包含（「背景与必要性」⊂「建设背景与必要性」）/
 * 形如「XX章」「一、XX」（去章号后仍满足上面任一条）。
 * 「现状特征与提升空间」这种小节名**不算**——它不被任何章名包含，删掉就是吃正文。
 */
export function isEchoedTitle(line: string, label: string): boolean {
  const forms = labelForms(label);
  for (const c of candidateForms(line)) {
    if (forms.includes(c)) return true;
    if (c.replace(/\s/g, "").length <= ECHOED_TITLE_MAX_CHARS && forms.some((f) => f.includes(c))) {
      return true;
    }
  }
  return false;
}

/**
 * 去掉正文开头重复的章标题（变更表 #139 补丁）
 *
 * 实测模型会在 `## 一、现状` 之后又把章名当正文第一行抄一遍，而且**抄得不完整**：
 * 真实生成物的第 1 章首段就是孤零零一句「背景与必要性」（原章名「建设背景与必要性」）。
 * 老实现只剥"完全等于章名"的首行，于是这 6 个字被当成章首段（读者看到的第一句话）。
 * 现在按"近似章名"剥，**最多连剥两段**，其余正文一字不动；对已剥干净的正文再剥一次不变。
 */
export function stripEchoedTitle(body: string, label: string): string {
  const lines = body.split("\n");
  let stripped = 0;
  while (stripped < MAX_ECHOED_LINES) {
    const i = lines.findIndex((l) => l.trim() !== "");
    if (i < 0 || !isEchoedTitle(lines[i]!, label)) break;
    lines.splice(i, 1);
    stripped += 1;
  }
  return stripped === 0 ? body : lines.join("\n").trim();
}
