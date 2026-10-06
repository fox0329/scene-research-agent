/**
 * @scene/domain — 交付物报告的确定性校验（变更表 #112）
 *
 * 报告正文改由模型撰写后，「不给决策建议」「对外材料不含内部信息」「六章齐全」
 * 这三条**不能再靠提示词自觉**——它们是产品铁律，必须落确定性层（AGENTS.md §三.5）。
 *
 * 判定分两档：
 *  - **硬伤**（缺章 / 对外泄漏内部信息 / 出现决策建议）：必须重写，调用方会带着
 *    违规清单重试一次；仍不过就用确定性兜底版。
 *  - **存疑**（内部版缺风险与边界、篇幅明显不足）：只提示，不拦。
 */

import { REPORT_CHAPTERS } from "@scene/contract";

export type ReportKind = "internal" | "external";

export interface ReportViolation {
  kind: "缺章" | "对外泄漏内部信息" | "出现决策建议" | "缺风险或边界" | "篇幅不足";
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

/** 两份报告的最低字数（对应"内部 8–15 页 / 对外 5–8 页"的六成下限） */
export const REPORT_MIN_CHARS: Record<ReportKind, number> = { internal: 2500, external: 1500 };

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
  ["scene", ["场景定义", "场景概述", "场景与边界", "场景画像", "场景定位"]],
  ["understand", ["场景认识", "认识场景", "场景理解"]],
  ["problems", ["存在的问题", "问题", "痛点"]],
  ["solution", ["我们的方案", "方案"]],
  ["value", ["能够提供的价值", "价值", "收益"]],
  ["summary", ["总结", "结论"]],
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

/** 一份报告的确定性校验 */
export function checkReport(kind: ReportKind, markdown: string): ReportGateReport {
  const text = markdown.replace(/\s/g, "");
  const chapters = reportChapterHeadings(markdown);
  const violations: ReportViolation[] = [];

  const written = new Set(chapters.map(matchChapterKey).filter((k) => k !== null));
  const missing = REPORT_CHAPTERS.filter((c) => !written.has(c.key)).map((c) => chapterName(c.title));
  if (missing.length > 0) {
    violations.push({ kind: "缺章", hard: true, detail: `缺少章节：${missing.join("、")}` });
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

  if (text.length < REPORT_MIN_CHARS[kind]) {
    violations.push({
      kind: "篇幅不足",
      hard: false,
      detail: `正文 ${text.length} 字，低于 ${REPORT_MIN_CHARS[kind]} 字下限（可能被截断或写得太简）`,
    });
  }

  return {
    kind,
    chars: text.length,
    chapters,
    violations,
    ok: !violations.some((v) => v.hard),
  };
}

/** 给重试用的违规清单（拼进提示词） */
export function reportViolationsBrief(report: ReportGateReport): string {
  return report.violations.map((v) => `- 【${v.kind}】${v.detail}`).join("\n");
}
