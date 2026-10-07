/**
 * @scene/domain — 交付物报告的确定性校验（变更表 #112 / #113）
 *
 * 报告正文改由模型撰写后，「不给决策建议」「对外材料不含内部信息」「章节齐全」这些
 * **不能再靠提示词自觉**——它们是产品铁律，必须落确定性层（AGENTS.md §三.5）。
 *
 * 判定分两档：
 *  - **硬伤**（缺章 / 缺少方案构件 / 对外泄漏内部信息 / 出现决策建议）：必须重写，调用方
 *    会带着违规清单重试一次；仍不过就用确定性兜底版。
 *  - **存疑**（内部版缺风险与边界、篇幅明显不足）：只提示，不拦。
 *
 * 变更表 #113（用户给参照件后纠偏）：「不要把报告做成前面内容的总结，而是形成自己的
 * 价值」——所以校验不只数章节，还查**方案构件**（设计原则、自建表格、编号连接关系、
 * 带度量口径的价值条目、边界、术语表）是否真的长出来了。
 */

import { proseChars } from "./md-metrics.js";
import {
  reportChaptersOf,
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
    | "缺风险或边界"
    | "缺术语表"
    | "正文用了章号式编号"
    | "说明性套话"
    | "价值写成缺口清单"
    | "说明书腔"
    | "篇幅超标"
    | "篇幅不足";
  /** 硬伤 = 必须重写 */
  hard: boolean;
  detail: string;
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

/** 两份报告的最低字数（对应"内部 5–8 页 / 对外 3–5 页"的精要口径，变更表 #116） */
export const REPORT_MIN_CHARS: Record<ReportKind, number> = { internal: 1800, external: 1200 };

/** 正文字数上限（超过就是没归纳，用户要精要：变更表 #116） */
export const REPORT_MAX_CHARS: Record<ReportKind, number> = { internal: 6000, external: 4500 };

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
 * 章名同义写法 → 章 key
 *
 * 模型实测会写「场景概述」「场景与边界」当第一章（不照抄「场景定义」），一字不差地
 * 比对会把写好的章判成"缺章"，再退回数据要点——宁可认得出同义标题。顺序敏感：
 * 更具体的写法排在前面。
 */
const CHAPTER_ALIASES: readonly (readonly [string, readonly string[]])[] = [
  ["status", ["现状", "场景定义", "场景概述", "场景与边界", "场景画像", "场景定位"]],
  ["problems", ["场景与问题", "存在的问题", "问题", "痛点"]],
  ["solution", ["方案", "我们的方案", "解决方案"]],
  ["value", ["价值", "能够提供的价值", "收益"]],
  ["risk", ["客观与风险", "风险与不确定", "客观与不确定"]],
  ["next", ["下一步", "实施路径", "后续步骤"]],
  ["glossary", ["术语表", "术语"]],
];

/** 正文标题 → 章 key（认不出返回 null） */
export function matchChapterKey(heading: string): string | null {
  const h = chapterName(heading);
  for (const [key, words] of CHAPTER_ALIASES) {
    if (words.some((w) => h.includes(w))) return key;
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

/** markdown 表格块数（按分隔行 |---|---| 计，术语表也算一块） */
function markdownTableCount(markdown: string): number {
  return markdown
    .split("\n")
    .filter((l) => /^\|(?:\s*:?-{2,}:?\s*\|)+$/.test(l.trim())).length;
}

const ARTIFACT_LABEL: Record<ReportArtifact, string> = {
  table: "自建表格",
  "numbered-connections": "带编号的连接关系",
  principles: "设计原则",
  "value-with-metric": "带度量口径的价值条目",
  boundary: "边界声明",
  glossary: "术语表",
  "risk-list": "风险点（至少 3 条）",
};

/** 每种构件的存在性判据（宁可宽松，只拦"完全没长出来"） */
const ARTIFACT_CHECKS: Record<ReportArtifact, (md: string, tables: number) => boolean> = {
  // 要的是"报告自己画了表"：架构 / 职责对照 / 选型 / 步骤这类，至少三张
  table: (_md, tables) => tables >= 3,
  "numbered-connections": (md) =>
    /[①②③④⑤⑥⑦⑧⑨⑩]/.test(md) || /(?:^|\n)\s*\|\s*\d+\s*\|/.test(md),
  // 「原则一/原则二」编号算；压缩后常写成「### 设计原则」+ 若干条，只要小节下有内容也算
  principles: (md) => /原则\s*[一二三四五1-5]/.test(md) || sectionHasBullets(md, "原则", 2),
  "value-with-metric": (md) => /(?:指标|口径|度量|怎么测|可度量)/.test(md),
  boundary: (md) => /(?:不替代|不参与|不承担|不做|不在本方案范围)/.test(md),
  glossary: (md) => /术语/.test(md),
  // 风险章只写风险点：至少 3 条（风险 / 不确定 / 前置条件 / 依赖 / 否决 这类），不给数据统计
  "risk-list": (md) =>
    (md.match(/(?:^|\n)\s*(?:[-*|]|\*\*)?[^\n]{0,40}(?:风险|不确定|前置条件|依赖|否决|门槛未过)/g) ?? []).length >= 3,
};

/** 某个小节标题下是否有至少 n 条非空内容（压缩后模型常把编号换成小节 + 条目） */
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
function missingArtifacts(markdown: string, sections: readonly ReportSection[]): string[] {
  const tables = markdownTableCount(markdown);
  const out: string[] = [];
  for (const sec of sections) {
    for (const a of sec.artifacts ?? []) {
      if (!ARTIFACT_CHECKS[a](markdown, tables)) {
        out.push(`${ARTIFACT_LABEL[a]}（在「${sec.title}」里）`);
      }
    }
  }
  return out;
}

/**
 * 某一章压缩后还缺哪些方案构件
 *
 * 压缩是"只删不加"，但模型偶尔会把整节（如「### 设计原则」）压没——那就把构件压丢了。
 * 用它做守恒检查：压缩**不许让构件变少**（缺构件是硬伤，比篇幅偏长严重）。
 */
export function missingChapterArtifacts(
  kind: ReportKind,
  chapterKey: string,
  markdown: string,
): string[] {
  const chapter = reportChaptersOf(kind).find((c) => c.key === chapterKey);
  if (!chapter) return [];
  const sections = chapter.sections;
  return missingArtifacts(markdown, sections);
}

/** 切出某一章的正文（含标题行），用于按章做口吻检查 */
function chapterSlice(markdown: string, key: string): string {
  const parts = markdown.split(/\n(?=## )/);
  return (
    parts.find((p) => matchChapterKey((p.match(/^## [^\n]*/) ?? [""])[0]) === key) ?? ""
  );
}

/** 小节是否写了（认小节名，也认同义关键词） */
function sectionWritten(sec: ReportSection, subs: readonly string[]): boolean {
  const name = chapterName(sec.title);
  if (subs.some((h) => h.includes(name) || name.includes(h))) return true;
  return (sec.keywords ?? []).some((k) => subs.some((h) => h.includes(k)));
}

/** 哪些小节没单独成节（只提示：换个说法或并进本章导语都不算缺陷） */
function missingSections(sections: readonly ReportSection[], subs: readonly string[]): string[] {
  return sections.filter((sec) => !sectionWritten(sec, subs)).map((sec) => `「${sec.title}」`);
}

/** 一份报告的确定性校验 */
export function checkReport(kind: ReportKind, markdown: string): ReportGateReport {
  const text = markdown.replace(/\s/g, "");
  const chapters = reportChapterHeadings(markdown);
  const subs = subHeadings(markdown);
  const violations: ReportViolation[] = [];
  const defs = reportChaptersOf(kind);

  const written = new Set(chapters.map(matchChapterKey).filter((k) => k !== null));
  const missing = defs.filter((c) => !written.has(c.key)).map((c) => c.label);
  if (missing.length > 0) {
    violations.push({ kind: "缺章", hard: true, detail: `缺少章节：${missing.join("、")}` });
  } else {
    // 章节齐了才查小节与构件：缺章时先补章，别一次甩一堆问题给模型
    const sections = defs.flatMap((c) => c.sections);
    const miss = missingArtifacts(markdown, sections);
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

  if (kind === "external") {
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

  if (kind === "internal") {
    const hasRisk = /风险/.test(markdown);
    const hasBoundary = /边界|不做什么|不承接|不做/.test(markdown);
    if (!hasRisk || !hasBoundary) {
      violations.push({
        kind: "缺风险或边界",
        hard: false,
        detail: `内部版必须写清风险与边界（当前风险=${hasRisk ? "有" : "无"}、边界=${hasBoundary ? "有" : "无"}）`,
      });
    }
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

  // 价值章的口吻：用户实测反馈——六条价值每条都挂一句「本客户基线未提供 / 待补」，
  // 那不是价值，是缺口清单。逐条免责算硬伤（要重写），说明书句式只提示。
  const valueChapter = chapterSlice(markdown, "value");
  const gapHits = valueChapter.match(/(?:待补|未提供|待补充|无法核实|需客户提供|尚需)/g) ?? [];
  if (gapHits.length >= 3) {
    violations.push({
      kind: "价值写成缺口清单",
      hard: true,
      detail:
        `「核心价值」章里有 ${gapHits.length} 处「待补 / 未提供 / 无法核实」——价值要写成"采用之后变成什么样"，` +
        "缺口与核实状态最多在章末一句话交代，逐条缺口放「客观与风险」章",
    });
  }
  const manualHits = valueChapter.match(/(?:度量口径是|口径是|本条信息|数据来源[：:])/g) ?? [];
  if (manualHits.length >= 2) {
    violations.push({
      kind: "说明书腔",
      hard: false,
      detail: `「核心价值」章有 ${manualHits.length} 处说明书句式（如「度量口径是…」）——指标名放进「怎么核」括号里就够`,
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

  if (kind === "external" && !written.has("glossary")) {
    violations.push({
      kind: "缺术语表",
      hard: false,
      detail: "附录缺术语表：把报告里客户/新人可能不熟的术语逐个解释（只解释通行含义，不自己发明定义）",
    });
  }

  // 注意：`text` 去掉了所有空白（表格行首的 `|` 信息也没了），篇幅必须按**原始 markdown** 的正文算
  const prose = proseChars(markdown);
  if (prose > REPORT_MAX_CHARS[kind]) {
    violations.push({
      kind: "篇幅超标",
      hard: false,
      detail: `正文（表格不计）${prose} 字，超过 ${REPORT_MAX_CHARS[kind]} 字上限——把并列事实合并成结论，细节留给表格`,
    });
  }

  if (prose < REPORT_MIN_CHARS[kind]) {
    violations.push({
      kind: "篇幅不足",
      hard: false,
      detail: `正文（表格不计）${prose} 字，低于 ${REPORT_MIN_CHARS[kind]} 字下限（可能被截断或写得太简）`,
    });
  }

  return { kind, chars: text.length, chapters, violations, ok: violations.every((v) => !v.hard) };
}

/** 给重试用的违规清单（拼进提示词） */
export function reportViolationsBrief(report: ReportGateReport): string {
  return report.violations.map((v) => `- 【${v.kind}】${v.detail}`).join("\n");
}
