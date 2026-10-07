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
 *  2. **装配**：`buildReportMarkdown()` 拼头部 + 六章（模型正文优先、逐章兜底）+ 附录；
 *  3. **口径**：章节顺序、内外侧重、附录与来源索引仍由契约与代码决定，模型只写正文。
 *
 * 章节结构：
 *  - 章节由契约 `REPORT_CHAPTERS` 统一给出（同一套六章），内外之别只体现在
 *    **取哪些块、取哪些列**（内部含利润池 / 上游格局 / 竞品 / 替代方案 / 坑 / 风险，
 *    对外只留客户视角的列）；
 *  - 每章先一句**由数据算出来的导语**，再按小节给「一行一条结论」的要点（数值/对比类
 *    用表格）——不是把表 dump 出来，也不再出现「阶段 N 总结 / 一、信息摘要」这种流水账；
 *  - 「六、总结」由代码按数据汇总：事实、边界（不做什么）、风险与不确定、待补齐
 *    （对外版改为价值结论、验证与推进安排、需要贵方确认的信息）。
 *
 * 两条铁律：
 *  1. **不给决策建议**——只陈述信息、判定与缺口；
 *  2. **对外材料不含内部信息**——不出现来源、证据级、内部论据与财务口径。
 *
 * 输出纯 Markdown 字符串，不写文件。
 */

import {
  INTERNAL_APPENDIX_SECTIONS,
  REPORT_GLOSSARY,
  reportChapterHeading,
  reportChaptersOf,
  middleColumns,
  tableDef,
  type DeliverableInput,
  type ExportResult,
  type ReportBlock,
  type ReportChapter,
  type StageData,
} from "@scene/contract";

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
 * @param data 交付物输入（场景 + 阶段数据；阶段总结不再进正文）
 * @returns 两份纯 Markdown
 */
export async function exportDeliverables(data: DeliverableInput): Promise<ExportResult> {
  const today = data.generatedAt ?? new Date().toISOString().slice(0, 10);
  return {
    internal_report: buildReportMarkdown(data, today, "internal"),
    external_report: buildReportMarkdown(data, today, "external"),
  };
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

/** 依场景锚（表1-1）取一个可读的副标题：边界 + 买方类型 */
function anchorLine(stageData: readonly StageData[]): string {
  const rows = stageData.filter((r) => r.table_code === "表1-1");
  const get = (item: string): string =>
    String(rows.find((r) => String(r.row["item"]) === item)?.row["content"] ?? "").trim();
  const parts = [get("场景边界"), get("买方类型")].filter((s) => s && s !== "未提供");
  return truncate(parts.join(" ｜ "), 80);
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
  "表2-3": (r) => `**${cell(r.layer)}**：${segs([["包含", r.components], ["接口", r.interface]])}`,
  "表2-5": (r) => `**${cell(r.constraint_item)}**：${segs([["要求", r.required_value], ["适用", r.standard_no]])}`,
  "表2-7": (r) => `**${cell(r.item)}**：${cell(r.status)}`,
  "表3-1": (r) => `**${cell(r.link)}**：毛利率 ${cell(r.gross_margin)}${r.representative ? `（代表 ${cell(r.representative)}）` : ""}`,
  "表3-2": (r) => `**${cell(r.form)}**：${segs([["", r.key_points], ["主导者", r.leader], ["适用", r.fit_for]])}`,
  "表3-3": (r) => `**${cell(r.customer_type)}**：${segs([["拍板", r.decision_maker], ["使用", r.user_role], ["付费", r.payer], ["预算科目", r.budget_item]])}`,
  "表3-4": (r) => `**${cell(r.dimension)}**：A ${cell(r.competitor_a)} ｜ B ${cell(r.competitor_b)}${blank(r.competitor_c) ? "" : ` ｜ C ${cell(r.competitor_c)}`}`,
  "表3-5": (r) => `**${cell(r.link)}**：${segs([["供给方", r.who_supplies], ["集中度", r.concentration], ["可替代性", r.substitutability], ["卡点", r.supply_risk]])}`,
  "表3-6": (r) => `**${cell(r.alternative)}**：${segs([["客户得到", r.customer_gets], ["单位成本", r.unit_cost], ["什么条件下选它", r.chosen_when]])}`,
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
function chapterLead(
  chapter: ReportChapter,
  kind: "internal" | "external",
  stageData: readonly StageData[],
): string {
  const links = countRows(stageData, "表1-2");
  const elements = countRows(stageData, "表2-2");
  const pains = valuesOf(stageData, "表1-2", "pain").length;
  const gaps = countRows(stageData, "表3-8");
  const participate = valuesOf(stageData, "表4-2", "can_touch");
  const benefits = countRows(stageData, "表6-1");
  const withBaseline = stageData.filter(
    (r) => r.table_code === "表6-1" && !blank(r.row["baseline"]),
  ).length;
  switch (chapter.key) {
    case "scene":
      return "先说清在讲哪个场景、边界划在哪里——后面所有内容都以这个范围为准。";
    case "understand":
      return `本场景拆出 ${links} 个业务环节、${elements} 个场景要素；现状做法与系统连接方式如下。`;
    case "problems":
      return pains > 0 || gaps > 0
        ? `现场层面的问题 ${pains} 处；${gaps} 条需求今天还没被满足（谁在痛、痛到什么程度逐条列出）。`
        : "本节汇总现场做法里暴露的问题与门槛要求。";
    case "solution":
      return `我方可在 ${participate.length > 0 ? participate.join(" / ") : "待判定"} 的环节参与；下面对照每条需求说明给什么产品、边界在哪。`;
    case "value":
      return benefits > 0
        ? `${benefits} 条收益对应指标已经写清；其中 ${withBaseline} 条有基线（${benefits - withBaseline} 条基线待补，不构成结论）。`
        : "本节列出收益与对应指标、验证方式，以及试点与验收口径。";
    case "summary":
      return kind === "internal"
        ? "下面是本次调研的事实汇总、边界声明、风险与待补齐清单。"
        : "下面是本方案的价值结论、验证安排，以及需要贵方确认的信息。";
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

  const all = middleColumns(t).filter((c) => c.key !== t.groupBy);
  const cols = block.cols ? all.filter((c) => block.cols!.includes(c.key)) : all;
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

/**
 * 「客观与风险」章的兜底正文（只内部版有）
 *
 * 变更表 #124：用户定调「别列证据，只说风险点」——这里不再摆数据状态与来源统计，
 * 只按"缺什么输入 → 影响什么"给出风险点；真正的风险表述由模型写。
 */
function renderRisks(stageData: readonly StageData[]): string {
  const verdict = (r: StageData): string => String(r.row["verification_verdict"] ?? "");
  const shaky = stageData.filter(
    (r) => verdict(r).includes("单一来源") || verdict(r).includes("无法核实") || verdict(r).includes("有反证"),
  ).length;
  const veto = valuesOf(stageData, "表1-3", "veto_holder");

  const out: string[] = ["### 主要风险点", ""];
  out.push(
    "- **本客户侧输入缺失**：会议室清单、既有设备台账、预约与使用数据、分项能耗、故障工单、信创目录对照项、试点判据阈值都还没有——价值幅度与验收判据暂时只能按行业通例量级设计，进方案前需要客户侧补齐。",
  );
  if (shaky > 0) {
    out.push(
      "- **部分结论只能当假设**：存在仅有单一来源或无法核实的信息，属行业通行认识而非本客户事实，落地前必须现场验证。",
    );
  }
  out.push(
    "- **现场条件可能改变可行边界**：点位、承重、既有设备接口、网络与供电任一项不成立，部分房间只能做状态监测，无法纳入统一控制。",
    "- **门槛未过之前方案与报价不作数**" + (veto.length > 0 ? `：${veto.join("、")}任一方否决都会推翻当前技术路径或商务结构。` : "。"),
    "- **交付依赖客户与第三方**：网络、供电、装修收口与既有系统接口分别由客户网络部门、物业与装修总包、原系统厂商负责，任一方延期都会顺延工期。",
    "- **设备纳管能力有上限**：部分需求只能辅助或外围配合；老旧封闭协议设备与不开放接口的设备只能旁路监测，控制覆盖率随现场设备能力浮动。",
  );
  return out.join("\n").trim();
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
  kind: "internal" | "external",
  stageData: readonly StageData[],
  opts: DigestOptions = {},
): ChapterDigest[] {
  const isInternal = kind === "internal";
  return reportChaptersOf(kind).map((chapter) => {
    const blocks = isInternal ? chapter.internal : chapter.external;
    const parts: string[] = [];
    const lead = chapterLead(chapter, kind, stageData);
    if (lead) parts.push(lead, "");
    if (chapter.key === "risk") {
      parts.push(renderRisks(stageData));
    } else {
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
  }).concat(
    isInternal
      ? []
      : [
          {
            key: "glossary",
            title: REPORT_GLOSSARY.external,
            /* 素材留空：术语表由模型撰写，写不出来就不出这一节（不许拿提示文字当正文） */
            markdown: "",
          },
        ],
  );
}

/** 组装一份报告（模型正文优先，逐章兜底） */
export function buildReportMarkdown(
  data: DeliverableInput,
  today: string,
  kind: "internal" | "external",
): string {
  const digests = new Map(reportChapterDigest(kind, data.stageData).map((d) => [d.key, d]));
  const model = new Map((data.chapters ?? []).map((c) => [c.key, c.markdown.trim()]));
  return buildReport(
    data,
    today,
    kind,
    (key) => model.get(key) ?? digests.get(key)?.markdown ?? "",
  );
}

/**
 * 组装一份报告
 *
 * @param bodyOf 每章正文的来源（模型正文 → 该章兜底），由 `buildReportMarkdown` 注入
 */
function buildReport(
  data: DeliverableInput,
  today: string,
  kind: "internal" | "external",
  bodyOf: (key: string) => string,
): string {
  const { scenario, stageData } = data;
  const sub = anchorLine(stageData);
  const isInternal = kind === "internal";

  // 封面只留身份信息（场景 + 生成日期）：口径说明、免责声明这类澄清文字用户要求全部删掉
  const head = isInternal
    ? [
        `# ${scenario.name} 场景调研报告`,
        "",
        `> **场景**：${scenario.name}${sub ? `（${sub}）` : ""}`,
        `> **生成日期**：${today}`,
      ]
    : [
        `# ${scenario.name} 解决方案`,
        "",
        `> **场景**：${scenario.name}${sub ? `（${sub}）` : ""}`,
        `> **日期**：${today}`,
      ];

  const sections: string[] = [head.join("\n")];

  for (const chapter of reportChaptersOf(kind)) {
    const body: string[] = [`## ${reportChapterHeading(kind, chapter.key)}`, ""];
    const text = stripEchoedTitle(bodyOf(chapter.key).trim(), chapter.label);
    body.push(text || "（本节内容待补）");
    sections.push(body.join("\n").trimEnd());
  }

  for (const sec of INTERNAL_APPENDIX_SECTIONS) {
    if (sec.key === "coverage") sections.push(renderCoverage(sec.title, stageData));
  }
  // 术语表只对外，由模型撰写（认不出的术语不硬编）；模型没写就不出现这一节，不造假
  const glossary = bodyOf("glossary").trim();
  if (glossary) {
    sections.push([`## ${REPORT_GLOSSARY.external}`, "", glossary].join("\n"));
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

/**
 * 去掉正文开头重复的章标题
 *
 * 实测模型会在 `## 一、现状` 之后又把「一、现状」当正文第一行抄一遍——同一章名连着出现两次，
 * 读者以为是排版错误。装配时只删这一行重复标题，其余正文一字不动。
 */
export function stripEchoedTitle(body: string, label: string): string {
  const lines = body.split("\n");
  const i = lines.findIndex((l) => l.trim() !== "");
  if (i < 0) return body;
  if (normTitle(lines[i]!) !== normTitle(label)) return body;
  lines.splice(i, 1);
  return lines.join("\n").trim();
}

/**
 * 附录 A：来源与覆盖（逐表给行数、有来源行数、主要来源）
 *
 * 原先分成「来源索引」「信息覆盖概览」两张（各自都有 36 行 × 若干来源），内容重叠且占版面；
 * 用户要精要（变更表 #119）→ 合成一张表：来源只列前两条 + 「等 N 处」。
 */
function renderCoverage(title: string, stageData: readonly StageData[]): string {
  const byTable = new Map<string, { rows: number; sourced: number; sources: Map<string, number> }>();
  for (const r of stageData) {
    const cur = byTable.get(r.table_code) ?? { rows: 0, sourced: 0, sources: new Map<string, number>() };
    cur.rows += 1;
    const src = String(r.source ?? "").trim();
    if (src !== "") {
      cur.sourced += 1;
      cur.sources.set(src, (cur.sources.get(src) ?? 0) + 1);
    }
    byTable.set(r.table_code, cur);
  }
  const lines: string[] = [`## ${title}`, ""];
  lines.push("| 表号 | 表名 | 行数 | 有来源 | 主要来源 |", "|---|---|---|---|---|");
  if (byTable.size === 0) {
    lines.push("| — | — | 0 | 0 | — |");
    return lines.join("\n");
  }
  for (const [code, v] of byTable) {
    const top = [...v.sources.entries()].sort((a, b) => b[1] - a[1]);
    const shown = top.slice(0, 2).map(([src, n]) => `${cell(src)}（${n} 条）`);
    const more = top.length > 2 ? ` 等 ${top.length} 处` : "";
    lines.push(
      `| ${code} | ${tableDef(code)?.name ?? ""} | ${v.rows} | ${v.sourced} | ${
        shown.length > 0 ? shown.join("、") + more : "—"
      } |`,
    );
  }
  return lines.join("\n");
}
