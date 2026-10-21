/**
 * @scene/domain — 交付物报告的确定性校验（变更表 #112 / #113 / #137）
 *
 * 报告正文改由模型撰写后，「不给决策建议」「对外材料不含内部信息」「章节齐全」这些
 * **不能再靠提示词自觉**——它们是产品铁律，必须落确定性层（AGENTS.md §三.5）。
 *
 * 变更表 #246（2026-10-21）：交付物**合成一份**《<场景>解决方案》（七章：现状与问题 /
 * 建设目标与思路 / 方案总体与建设内容 / 建设路径 / 工作安排 / 保障措施 / 下一步）。
 * 章节定义、别名、篇幅上下限都只有一套；`kind` 参数保留一个值，只为接口稳定。
 *
 * 判定分两档：
 *  - **硬伤**（缺章 / 缺少方案构件 / 对外泄漏内部信息 / 出现决策建议 / **断头段**）：必须重写，
 *    调用方会带着违规清单重试一次；仍不过就用确定性兜底版。
 *  - **存疑**（缺小节、手写章号、说明性套话、篇幅超上限、篇幅不足、重复、空节）：
 *    只提示，不拦。章首段不合规是硬伤（变更表 #247：判据是确定性的 ≤120 字、不列举、整句开头）。
 *
 * 变更表 #139：篇幅改由**总字数预算前置管住**——超总量时调用方"定向回炉最长的 1–2 章"（#139 补丁：
 * 触发条件是**全篇总量**，不是逐章超线；逐章预算只是提示词里的写作指引），这里只留提示，
 * **不再截断正文**，也不再因为篇幅触发整篇重写。终检的确定性补充（断头段 / 重复 / 空节 / 章首段）
 * 由 `report-review.ts` 提供，这里统一并进违规清单，保证"同一份稿子两处判定一致"。
 *
 * 变更表 #113（用户给参照件后纠偏）：「不要把报告做成前面内容的总结，而是形成自己的
 * 价值」——所以校验不只数章节，还查**方案构件**（设计原则、自建表格、编号连接关系、
 * 带度量口径的价值条目）是否真的长出来了。
 */

import { proseChars } from "./md-metrics.js";
import { deterministicReviewFindings } from "./report-review.js";
import {
  reportChapters,
  type ReportArtifact,
  type ReportKind,
  type ReportSection,
} from "@scene/contract";

export type { ReportKind };

export interface ReportViolation {
  kind:
    | "缺章"
    | "缺小节"
    | "缺少方案构件"
    | "对外泄漏内部信息"
    | "出现决策建议"
    | "正文用了章号式编号"
    | "说明性套话"

    | "说明书腔"
    | "篇幅超标"
    | "篇幅不足"
    | "悬空残句"
    | "重复"
    | "空节"
    | "章首段不合规"
    | "终检问题";
  /** 硬伤 = 必须重写 */
  hard: boolean;
  detail: string;
  /** 出处：只在**交付物终检**环节产生的违规带这个标记（变更表 #139） */
  from?: "终检";
}

export interface ReportGateReport {
  kind: ReportKind;
  /** 正文字数（不含空白） */
  chars: number;
  /** 识别到的章名 */
  chapters: string[];
  violations: ReportViolation[];
  /** 无硬伤 */
  ok: boolean;
}

/** 报告里不许出现的决策措辞（产品只给事实与判定，决定权在用户） */
const ADVICE_PATTERNS: readonly RegExp[] = [
  /建议(?:先|优先|应当|应该|采用|选择|通过|投入|采购|放弃|上马|推进)/,
  /(?:应当|应该|需要)(?:优先|尽快|立即|马上)/,
  /推荐(?:采用|选择|使用|方案)/,
  /值得(?:投入|投资|一做|做)/,
  /不建议|不如放弃|可以决定(?:上|进)/,
  /(?:我方|我们|本报告)认为(?:应该|应当|建议)/,
];

/** 对外材料不许出现的内部痕迹（内部表号、来源、核实口径、材料 id） */
const EXTERNAL_LEAK_PATTERNS: readonly RegExp[] = [
  /表\s*\d+\s*-\s*\d+/,
  /(?:来源|出处|摘自|参见|依据材料)\s*[：:]/,
  // 「缺口」单独不禁：对外稿写「能力缺口在算法与软件」是正当说法，只拦内部的信息口径
  /(?:证据级|权威性|核实结论|信息完整度|待补齐|信息缺口|证据缺口)/,
  /ingest-[0-9A-Za-z_-]+/,
];

/**
 * 篇幅下限（变更表 #116 / #246）
 *
 * 合成一份后是七章、含成本与计划表，客户两份定稿正文实测 4539 / 4707 字（表格不计），
 * 合并稿下限按 2500 字给（低于它基本是没写全，但仍只提示、不阻断出稿）。
 */
export function reportMinChars(_kind: ReportKind): number {
  return 2500;
}

/**
 * 篇幅上限（变更表 #116 / #137 / #139）
 *
 * 用户定调（变更表 #139）：「文档生成可以设置一个**总的字数**，比如 2000–5000 字左右，
 * 没必要直接截断」——所以上限就是**总字数预算**这条线：超了先定向回炉最长的 1–2 章
 * （#139 补丁：总量驱动），仍超就保留、只提示；任何时候都不截断。
 * 变更表 #246 合并后只剩一档：2,500–6,000（逐章写作指引之和 5,750，留出章间浮动）。
 */
export function reportMaxChars(_kind: ReportKind): number {
  return 6000;
}

/** 自我说明 / 免责声明这类"澄清文字"（用户要求全部删掉，变更表 #116） */
const META_PATTERNS: readonly RegExp[] = [
  /不含决策建议|不给决策建议|不构成决策建议/,
  /以试点实测为准|最终以实测为准/,
  /按材料口径的测算/,
  /除特别说明外/,
  /本节出现的(?:数量|数字)/,
  /本材料只陈述|本报告只(?:汇总|陈述)/,
];

/** 章名归一：去掉「一、」这类序号，便于与模型写的标题对上 */
function chapterName(title: string): string {
  return title.replace(/^[一二三四五六七八九十]+[、.．]\s*/, "").trim();
}

/**
 * 章名同义写法 → 章 key（key 覆盖两份口径全部 12 章）
 *
 * 模型实测会写「场景概述」「场景与边界」当第一章（不照抄「场景定义」），一字不差地
 * 比对会把写好的章判成"缺章"，再退回数据要点——宁可认得出同义标题。两处顺序敏感：
 *  - 同一章内**更具体的写法排在前面**（如 background 的「建设背景与必要性」在前、「必要性」在后）；
 *  - 匹配时只在本口径自己的章里找（见 `matchChapterKey`），两份口径的章名不互相误判。
 */
const CHAPTER_ALIASES: Record<string, readonly string[]> = {
  status: ["现状", "场景定义", "场景概述", "场景与边界", "场景画像", "场景定位"],
  problems: ["场景与问题", "存在的问题", "问题", "痛点"],
  solution: ["方案", "我们的方案", "解决方案"],
  value: ["价值", "能够提供的价值", "收益"],
  next: ["下一步", "实施路径", "后续步骤"],
  background: ["建设背景与必要性", "建设背景", "背景与必要性", "必要性"],
  goals: ["建设目标与思路", "建设目标", "目标与思路", "建设思路"],
  content: ["建设内容", "建设方案", "建设范围", "总体架构与功能"],
  path: ["建设路径", "实施路径与数据采集", "数据采集与设备", "建设路径与成本"],
  schedule: ["工作安排", "建设计划", "实施计划", "进度安排"],
  safeguards: ["保障措施", "建设保障", "组织与保障"],
  outlook: ["监管协同展望", "监管协同", "协同展望", "展望"],
};

/** 正文标题 → 章 key（只认该口径自己的章节；认不出返回 null） */
export function matchChapterKey(kind: ReportKind, heading: string): string | null {
  const h = chapterName(heading);
  for (const chapter of reportChapters(kind)) {
    const words = CHAPTER_ALIASES[chapter.key] ?? [];
    if (words.some((w) => h.includes(w))) return chapter.key;
  }
  return null;
}

/** 抓出正文里的 `## ` 级标题（模型必须按这个层级写章） */
export function reportChapterHeadings(markdown: string): string[] {
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m?.[1]) out.push(chapterName(m[1]));
  }
  return out;
}

/** 小节标题（`###` 级） */
function subHeadings(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((l) => /^###\s+(.+?)\s*$/.exec(l)?.[1])
    .filter((x): x is string => typeof x === "string")
    .map((t) => chapterName(t.replace(/^[0-9.]+\s*/, "")));
}

/** markdown 表格块数（按分隔行 |---|---| 计） */
function markdownTableCount(markdown: string): number {
  return markdown
    .split("\n")
    .filter((l) => /^\|(?:\s*:?-{2,}:?\s*\|)+$/.test(l.trim())).length;
}

const ARTIFACT_LABEL: Record<ReportArtifact, string> = {
  table: "自建表格",
  "numbered-connections": "带编号的连接关系",
  principles: "设计原则",
};

/** 每种构件的存在性判据（宁可宽松，只拦"完全没长出来"） */
const ARTIFACT_CHECKS: Record<ReportArtifact, (md: string, tables: number) => boolean> = {
  // 要的是"报告自己画了表"：架构 / 职责对照 / 选型 / 步骤这类，至少三张（全文计数，宁宽）
  table: (_md, tables) => tables >= 3,
  "numbered-connections": (md) =>
    /[①②③④⑤⑥⑦⑧⑨⑩]/.test(md) || /(?:^|\n)\s*\|\s*\d+\s*\|/.test(md),
  // 「原则一/原则二」编号算；模型也常写成「### 设计原则」+ 若干条，只要小节下有内容也算
  principles: (md) => /原则\s*[一二三四五1-5]/.test(md) || sectionHasBullets(md, "原则", 2),
};

/** 某个小节标题下是否有至少 n 条非空内容（模型常把编号换成小节 + 条目） */
function sectionHasBullets(markdown: string, keyword: string, n: number): boolean {
  const lines = markdown.split("\n");
  const at = lines.findIndex((l) => /^#{3,4}\s/.test(l) && l.includes(keyword));
  if (at < 0) return false;
  let count = 0;
  for (let i = at + 1; i < lines.length; i++) {
    if (/^#{1,4}\s/.test(lines[i]!)) break;
    if (lines[i]!.trim() !== "") count += 1;
  }
  return count >= n;
}

/** 哪些方案构件完全没长出来（硬伤：报告不能只是素材的复述） */
function missingArtifacts(
  markdown: string,
  sections: readonly ReportSection[],
  chapterArtifacts: readonly ReportArtifact[] = [],
  chapterLabel = "",
): string[] {
  const tables = markdownTableCount(markdown);
  const out: string[] = [];
  for (const sec of sections) {
    for (const a of sec.artifacts ?? []) {
      if (!ARTIFACT_CHECKS[a](markdown, tables)) {
        out.push(`${ARTIFACT_LABEL[a]}（在「${sec.title}」里）`);
      }
    }
  }
  for (const a of chapterArtifacts) {
    if (!ARTIFACT_CHECKS[a](markdown, tables)) {
      out.push(chapterLabel ? `${ARTIFACT_LABEL[a]}（在「${chapterLabel}」章里）` : ARTIFACT_LABEL[a]);
    }
  }
  return out;
}

/**
 * 某一章还缺哪些方案构件
 *
 * 用途：交付物终检的采纳判据——模型"只改被点名的段落"时偶尔会顺手把整节删掉，
 * 用它对改动前后做守恒检查：**不许让构件变少**（缺构件是硬伤，比病句严重）。
 */
export function missingChapterArtifacts(
  kind: ReportKind,
  chapterKey: string,
  markdown: string,
): string[] {
  const chapter = reportChapters(kind).find((c) => c.key === chapterKey);
  if (!chapter) return [];
  return missingArtifacts(markdown, chapter.sections, chapter.artifacts, chapter.label);
}

/** 切出某一章的正文（含标题行），用于按章做口吻检查 */
/** 小节是否写了（认小节名，也认同义关键词） */
function sectionWritten(sec: ReportSection, subs: readonly string[]): boolean {
  const name = chapterName(sec.title);
  if (subs.some((h) => h.includes(name) || name.includes(h))) return true;
  return (sec.keywords ?? []).some((k) => subs.some((h) => h.includes(k)));
}

/** 哪些小节没单独成节（只提示：换个说法或并进本章导语都不算缺陷） */
function missingSections(
  sections: readonly ReportSection[],
  subs: readonly string[],
): string[] {
  return sections
    .filter((sec) => !sec.noHeading)
    .filter((sec) => !sectionWritten(sec, subs))
    .map((sec) => `「${sec.title}」`);
}

/** 一份报告的确定性校验（交付物只有一份七章《解决方案》）#246 */
export function checkReport(kind: ReportKind, markdown: string): ReportGateReport {
  const text = markdown.replace(/\s/g, "");
  const chapters = reportChapterHeadings(markdown);
  const subs = subHeadings(markdown);
  const violations: ReportViolation[] = [];
  const defs = reportChapters(kind);
  const minChars = reportMinChars(kind);
  const maxChars = reportMaxChars(kind);

  const written = new Set(chapters.map((h) => matchChapterKey(kind, h)).filter((k) => k !== null));
  const missing = defs.filter((c) => !written.has(c.key)).map((c) => c.label);
  if (missing.length > 0) {
    violations.push({ kind: "缺章", hard: true, detail: `缺少章节：${missing.join("、")}` });
  } else {
    // 章节齐了才查小节与构件：缺章时先补章，别一次甩一堆问题给模型
    const sections = defs.flatMap((c) => c.sections);
    const miss = defs.flatMap((c) => missingArtifacts(markdown, c.sections, c.artifacts, c.label));
    if (miss.length > 0) {
      violations.push({
        kind: "缺少方案构件",
        hard: true,
        detail: `报告要有自己的方案构件（不是把素材复述一遍），当前缺：${miss.join("、")}`,
      });
    }
    const missSec = missingSections(sections, subs);
    if (missSec.length > 0) {
      violations.push({
        kind: "缺小节",
        hard: false,
        detail: `这几节没单独成节（内容若已并进本章导语即可忽略）：${missSec.join("、")}`,
      });
    }
  }

  {
    const leaks = EXTERNAL_LEAK_PATTERNS.flatMap((re) => markdown.match(re) ?? []);
    if (leaks.length > 0) {
      violations.push({
        kind: "对外泄漏内部信息",
        hard: true,
        detail: `出现内部痕迹：${[...new Set(leaks)].slice(0, 5).join("、")}`,
      });
    }
  }

  const advice = ADVICE_PATTERNS.flatMap((re) => markdown.match(re) ?? []);
  if (advice.length > 0) {
    violations.push({
      kind: "出现决策建议",
      hard: true,
      detail: `出现决策措辞：${[...new Set(advice)].slice(0, 5).join("、")}`,
    });
  }


  // 正文里再用「一、二、」当条目编号，会和章号混在一起（用户实测：把「**二、按预约…**」看成又开了一章）
  const numbered = markdown.match(/^\s*\*\*[一二三四五六七八九十]+、/gm) ?? [];
  if (numbered.length > 0) {
    violations.push({
      kind: "正文用了章号式编号",
      hard: false,
      detail: `正文有 ${numbered.length} 处用「一、二、」当条目编号，与章节层级混淆；分条改用「价值一 / 第一 / 其一」`,
    });
  }

  const meta = META_PATTERNS.flatMap((re) => markdown.match(re) ?? []);
  if (meta.length > 0) {
    violations.push({
      kind: "说明性套话",
      hard: false,
      detail: `有 ${meta.length} 处澄清/免责式说明（如「${[...new Set(meta)].slice(0, 3).join("」「")}」），直接删掉——口径写在数字旁边就够`,
    });
  }


  // 注意：`text` 去掉了所有空白（表格行首的 `|` 信息也没了），篇幅必须按**原始 markdown** 的正文算
  const prose = proseChars(markdown);
  if (prose > maxChars) {
    // 变更表 #139 补丁：这里**只提示**。超总量已经在出稿前用"定向回炉最长的 1–2 章"处理过；
    // 若还升为硬伤，会再触发一次**整篇重写**（慢，而且常常更差）。截断一律不做。
    violations.push({
      kind: "篇幅超标",
      hard: false,
      detail: `正文（表格不计）${prose} 字，超过 ${maxChars} 字总上限——把并列事实合并成结论、把细节留给表格，不许截断内容`,
    });
  }

  if (prose < minChars) {
    violations.push({
      kind: "篇幅不足",
      hard: false,
      detail: `正文（表格不计）${prose} 字，低于 ${minChars} 字下限（可能被截断或写得太简）`,
    });
  }

  // 终检的确定性补充（变更表 #139）：断头段（硬伤）/ 跨章重复 / 空节 / 章首段不合规。
  // 与终检环节共用同一份实现，避免"checkReport 说没问题、终检又说不合格"两头打架。
  violations.push(...deterministicReviewFindings(markdown));

  return { kind, chars: text.length, chapters, violations, ok: violations.every((v) => !v.hard) };
}

/** 给重试用的违规清单（拼进提示词） */
export function reportViolationsBrief(report: ReportGateReport): string {
  return report.violations.map((v) => `- 【${v.kind}】${v.detail}`).join("\n");
}
