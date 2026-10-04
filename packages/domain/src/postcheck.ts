/**
 * postcheck — 生成后三问自检（规则 G-R8，v1.28）
 *
 * 用户定调（原话）：「每个阶段生成后有没有 1、确认来源的真实性 2、确认表述的准确、
 * 客观性 3、问三次这真实吗？客观吗？有价值吗？**把这个要作为规则在每次生成后检查**」
 * 并明确：「这是生成过程的一个步骤，**为什么要用户判断**」——所以自检是生成的内部环节：
 * 自动查、自动改、改不掉的按实降级，不把决定推给用户。
 *
 * 本文件只做**确定性**部分（可单测、可审计）：
 *  - 来源真实性：引用的出处必须能在材料库里查到，且该页确实有这句话（`SourceLookup` 注入，
 *    实现见 `@scene/infra` 的 source-index —— 用 trigram 全文索引真查，不是让模型自述）
 *  - 表述准确/客观：绝对化措辞、把行业推断写成本客户事实
 *  - 有价值：价值类表必须有可测指标 + 本客户基线，否则"价值不可验证"
 *  - 兜底：三轮自检后模型仍没改掉的硬伤，按实降级（不许继续挂「已核实」）
 *
 * 模型侧的"三问×3 轮"在应用层（`apps/server/src/postcheck-pass.ts`）跑，本文件给它提供
 * 必须回答的问题清单，并负责最后一轮的确定性收口。
 */

import { TABLES_BY_CODE, middleColumns } from "@scene/contract";
import type { InfoRow } from "./completeness.js";

// ─── 类型 ────────────────────────────────────────────────

export type PostcheckKind =
  | "出处查不到"
  | "出处无此内容"
  | "声称有据但无出处"
  | "结论与证据矛盾"
  | "绝对化措辞"
  | "把推断写成客户事实"
  | "价值不可验证"
  | "中栏夹带出处"
  | "中栏太长";

export type PostcheckSeverity = "硬伤" | "存疑";

/** 降级标记：与 stage-summary 的 SELF_CHECK_MARK 同一串，总结据此留痕 */
export const SELF_CHECK_MARK = "【生成后自检】";

export interface PostcheckFinding {
  tableCode: string;
  rowId: string;
  /** 行标识（中栏首列），便于人一眼定位 */
  label: string;
  kind: PostcheckKind;
  /** 具体到"哪句话/哪个出处/哪个数"，不含糊 */
  detail: string;
  severity: PostcheckSeverity;
}

/** 待检的行（服务端从库里取出来喂进来） */
export interface PostcheckRow {
  tableCode: string;
  rowId: string;
  label: string;
  row: InfoRow;
  source?: string | null;
  sourceType?: string | null;
}

/**
 * 材料库反查端口
 *
 * 领域层不碰数据库/网络，由基础设施实现后注入（见 `packages/infra/src/source-index.ts`）。
 */
export interface SourceLookup {
  /** 这个出处（`文件名:页码`）在材料库里存在吗 */
  hasSource(ref: string): boolean;
  /** 这个出处所在的那一页，真的出现了这句话吗（子串匹配） */
  hasContent(ref: string, snippet: string): boolean;
}

export interface PostcheckInput {
  rows: readonly PostcheckRow[];
  lookup: SourceLookup;
}

// ─── 常量 ────────────────────────────────────────────────

/** 绝对化 / 营销化措辞：这类词让"表述客观性"失守，模板里一律不许出现 */
const ABSOLUTE_WORDS: readonly string[] = [
  "最好",
  "最强",
  "最优",
  "唯一",
  "第一",
  "必然",
  "一定会",
  "绝对不会",
  "百分百",
  "100%",
  "零风险",
  "彻底解决",
  "完全满足",
  "遥遥领先",
  "无与伦比",
  "行业首创",
];

/** 「把推断写成本客户事实」的措辞特征 */
const CUSTOMER_FACT_PATTERNS: readonly RegExp[] = [
  /本客户(已|已经|均|都|全部)/,
  /贵司(已|已经|均|都)/,
  /该客户(已|已经|均|都)/,
  /本项目(已|已经)(部署|上线|采用|具备|完成)/,
];

/**
 * 价值类表：**从列结构推导**，不手写表号
 *
 * 教训（v1.28 实跑）：第一版把手写的 `["表6-1","表6-4"]` 当价值表，而表6-4（试点与验收）
 * 根本没有「指标/基线」列——于是 20 行全部被扣上"价值不可验证"，模型照着假问题白改了一批内容。
 * 判据必须是"这张表**有没有**这两列"，而不是"我记不记得它是价值表"。
 */
function isValueTable(code: string): boolean {
  const t = TABLES_BY_CODE[code];
  if (!t) return false;
  const keys = new Set(t.columns.map((c) => c.key));
  return keys.has("metric") && keys.has("baseline");
}

/** 基线列的"空"值：这些等于没有基线 */
const EMPTY_BASELINE: readonly string[] = ["", "未提供", "暂无", "无", "未给出", "未知", "行业通例", "-", "—"];

/** 判为"行情类"的核实结论：这些结论下行文不能写成本客户事实 */
const GENERAL_VERDICTS: readonly string[] = ["行业通例", "无法核实", "未核", ""];

/** 硬伤类结论：模型没改掉就必须降级，不许继续挂"已核实" */
const CLAIMED_VERIFIED = "已核实";

/**
 * 中栏内容格的位置上限（用户定调 v1.32：「要简要说价值，说结果」）
 *
 * 数字是拍的，但拍得有依据：实测智慧会议室阶段 3-4 有 28% 的格子在 60–296 字之间，
 * 一格里塞了三件事 + 引用，读的人根本抓不到结论。
 */
export const MID_CELL_MAX_CHARS = 60;

/**
 * 中栏内容格里**不该出现**的引用痕迹（确定性判据，不靠模型自觉）
 *
 * 用户原话：「大量的文字在说明来源，我认为中栏的表格，要说价值，说结果，
 * 来源、引用什么的可以放到右栏」。这些痕迹一律搬到右栏 `source`。
 */
const MID_CITATION_PATTERNS: readonly RegExp[] = [
  // 文件名:页码 —— **必须第一个匹配**，整块吃掉（含 ingest- 前缀），
  // 否则先把 `ingest-1` 摘掉会剩一个光秃秃的 `.pdf:2`（实跑踩过）
  /[^\s，,；;、：:（）()「」【】]*\.(?:pdf|pptx|docx|xlsx|txt|md|csv|png|jpe?g)(?::\d+(?:[,\-–]\d+)*)?/gi,
  /ingest-[0-9A-Za-z_-]+/g, // 没带扩展名的材料 id
  /(?:来源|出处|摘自|参见|见附件|依据材料)\s*[：:]/g, // 「来源：…」
  /[（(]\s*[MO]\s*[1-6]\s*[)）]/g, // （M5）（O2）
  /\b[MO][1-6]_[\u4e00-\u9fa5A-Za-z]+/g, // M1_产品型号
  /第\s*\d+\s*页/g,
  /(?:材料|文档|资料)(?:中|里)?(?:未|没有|未见|未含)/g, // 材料未提供 / 文档里没有
  /(?:文档|材料)未(?:说明|提及|提供|给出)/g,
  /未见材料|材料未含|未查到材料/g,
  /按\s*(?:XX|某)?(?:白皮书|报告|标准|材料)/g,
];

/** 句子切分：按中文句读切开，逐句判断是"纯引用"还是"正文夹带引用" */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。；;!?！？\n])/)
    .map((x) => x.trim())
    .filter((x) => x !== "");
}

/** 这句是不是**只在说出处**（去掉引用痕迹后剩不下几个字） */
function isCitationOnly(sentence: string): boolean {
  const stripped = stripCitationMarks(sentence).replace(/[\s，,。.、；;：:（）()·—\-「」【】]/g, "");
  return stripped.length <= 2;
}

/** 摘掉句子里夹带的引用痕迹（保留正文） */
function stripCitationMarks(sentence: string): string {
  let out = sentence;
  for (const re of MID_CITATION_PATTERNS) out = out.replace(re, " ");
  return out
    .replace(/[（(]\s*[)）]/g, " ")
    .replace(/\s*[，,；;]\s*(?=[，,；;。])/g, "")
    .replace(/\s{2,}/g, " ")
    // 摘掉引用后常留下「空格 + 中文标点」的疤（实跑：`量产交付 。`），一并收掉
    .replace(/\s+([，,。；;：:、）)】」》])/g, "$1")
    .replace(/([（(【「《])\s+/g, "$1")
    .replace(/^[，,、；;：:\s]+|[，,、；;：:\s]+$/g, "")
    .trim();
}

/**
 * 把一个中栏内容格拆成「正文」+「被搬走的引用」
 *
 * 规则：纯引用的句子整句搬走；正文里夹带的引用片段摘掉、正文留下
 * （**只摘引用痕迹，不删正文**——正文是用户的资产，宁可不动）。
 */
export function splitMidCitations(text: string): { cleaned: string; moved: string[] } {
  const moved: string[] = [];
  const kept: string[] = [];
  for (const sentence of splitSentences(text)) {
    if (isCitationOnly(sentence)) {
      moved.push(sentence);
      continue;
    }
    const cleaned = stripCitationMarks(sentence);
    if (cleaned !== sentence.replace(/[\s]+$/, "")) moved.push(sentence);
    if (cleaned !== "") kept.push(cleaned);
  }
  return { cleaned: kept.join(" ").trim(), moved };
}

/** 这一格夹带了出处吗 */
export function hasMidCitation(text: string): boolean {
  for (const re of MID_CITATION_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) return true;
  }
  return false;
}

/** 表的中栏列 key（含类别子表的列） */
function midKeysOf(code: string): string[] {
  const t = TABLES_BY_CODE[code];
  if (!t) return [];
  return middleColumns(t).map((c) => c.key);
}

// ─── 出处解析 ────────────────────────────────────────────

/**
 * 解析出处串成 `文件名:页码` 列表
 *
 * 出处是多来源时模型写「a.pdf:1；b.pdf:2」；只有文件名没有页码的（如"行业通例（模型知识）"）
 * 不是材料出处，返回空数组——**这正是要区分的东西**：行情不该被当成材料依据。
 */
export function parseCitations(source: string | null | undefined): string[] {
  const text = String(source ?? "").trim();
  if (text === "") return [];
  return text
    .split(/[；;、,，]/)
    .map((s) => s.trim())
    .filter((s) => /\.(pdf|pptx|docx|xlsx|txt|md|csv|png|jpg|jpeg):\d+$/i.test(s));
}

// ─── 关键片段抽取（用于反查"这一页到底有没有这句话"） ──────

/**
 * 从一行里抽出"值得反查"的片段
 *
 * 只挑**带单位/量纲的数**、**引号里的词**、**长专名**：这类东西如果材料里没有，
 * 基本就是模型编的或张冠李戴；普通描述性文字允许改写，不能要求逐字命中
 * （否则每行都会被误判成"出处无此内容"）。
 */
export function keyPhrases(row: InfoRow, limit = 6): string[] {
  const out: string[] = [];
  const push = (s: string): void => {
    const v = s.trim();
    if (v.length >= 2 && !out.includes(v)) out.push(v);
  };
  for (const [key, raw] of Object.entries(row)) {
    // 核实列本身不是事实内容，不参与反查
    if (key === "verification" || key === "verification_verdict") continue;
    const value = Array.isArray(raw) ? raw.join("；") : String(raw ?? "");
    if (value.trim() === "") continue;
    // ① 带量纲的数
    for (const m of value.matchAll(
      /\d+(?:\.\d+)?\s*(?:TOPS|GB|TB|MB|GHz|MHz|ms|km|kg|kW|kWh|万元|亿元|元|%|台|个|路|人|天|小时|分钟|年|次|步|米|m²|㎡)/gi,
    )) {
      push(m[0]);
    }
    // ② 引号里的词（模型引号引用时通常是原文）
    for (const m of value.matchAll(/[「『"“]([^」』"”]{2,24})[」』"”]/g)) {
      if (m[1]) push(m[1]);
    }
    // ③ 长专名：连续中文/字母数字 5–14 字，且不像普通句子
    for (const m of value.matchAll(/[A-Za-z][A-Za-z0-9./-]{4,20}|[\u4e00-\u9fa5]{5,14}/g)) {
      push(m[0]);
    }
    if (out.length >= limit * 3) break;
  }
  return out.slice(0, limit * 3);
}

// ─── 确定性自检 ──────────────────────────────────────────

function isMaterialClaim(r: PostcheckRow): boolean {
  return String(r.sourceType ?? "") === "AI提取";
}

function verdictOf(r: PostcheckRow): string {
  return String(r.row["verification_verdict"] ?? "").trim();
}

/** 一行正文（不含核实列）拼接，用于措辞检查 */
function proseOf(r: PostcheckRow): string {
  return Object.entries(r.row)
    .filter(([k]) => k !== "verification" && k !== "verification_verdict")
    .map(([, v]) => (Array.isArray(v) ? v.join("；") : String(v ?? "")))
    .join("｜");
}

/**
 * 确定性自检：返回必须被处理的问题清单
 *
 * 判据都写在这里，**不写提示词**（AGENTS §三.5：高风险判定必须落在确定性层）。
 */
export function runDeterministicPostcheck(input: PostcheckInput): PostcheckFinding[] {
  const findings: PostcheckFinding[] = [];
  for (const r of input.rows) {
    const citations = parseCitations(r.source);
    const verdict = verdictOf(r);
    const prose = proseOf(r);

    // ① 来源真实性：声称有据，却给不出出处
    if (isMaterialClaim(r) && citations.length === 0) {
      findings.push({
        tableCode: r.tableCode,
        rowId: r.rowId,
        label: r.label,
        kind: "声称有据但无出处",
        detail: `行上标了「AI提取」（声称来自材料），但出处是「${String(r.source ?? "(空)")}」，给不出文件名+页码`,
        severity: "硬伤",
      });
    }

    // ② 出处存在性 + 该页是否真有这句话
    const missingRefs: string[] = [];
    const noContentRefs: string[] = [];
    const phrases = keyPhrases(r.row);
    for (const ref of citations) {
      if (!input.lookup.hasSource(ref)) {
        missingRefs.push(ref);
        continue;
      }
      if (phrases.length > 0 && !phrases.some((p) => input.lookup.hasContent(ref, p))) {
        noContentRefs.push(ref);
      }
    }
    if (missingRefs.length > 0) {
      findings.push({
        tableCode: r.tableCode,
        rowId: r.rowId,
        label: r.label,
        kind: "出处查不到",
        detail: `材料库里没有这些出处：${missingRefs.join("、")}`,
        severity: "硬伤",
      });
    }
    if (noContentRefs.length > 0) {
      findings.push({
        tableCode: r.tableCode,
        rowId: r.rowId,
        label: r.label,
        kind: "出处无此内容",
        detail: `出处 ${noContentRefs.join("、")} 存在，但抽出的关键内容（${phrases
          .slice(0, 3)
          .join("、")}）在该页查不到——要么改写自材料、要么引错了页`,
        severity: "存疑",
      });
    }

    // ③ 结论与证据矛盾：挂着「已核实」却没有可定位的出处
    if (verdict === CLAIMED_VERIFIED && (citations.length === 0 || missingRefs.length === citations.length)) {
      findings.push({
        tableCode: r.tableCode,
        rowId: r.rowId,
        label: r.label,
        kind: "结论与证据矛盾",
        detail:
          citations.length === 0
            ? "核实结论写「已核实」，但出处栏没有可定位的材料（文件名+页码）"
            : `核实结论写「已核实」，但引用的出处（${missingRefs.join("、")}）在材料库里都查不到`,
        severity: "硬伤",
      });
    }

    // ④ 表述客观性：绝对化 / 营销化措辞
    const hits = ABSOLUTE_WORDS.filter((w) => prose.includes(w));
    if (hits.length > 0) {
      findings.push({
        tableCode: r.tableCode,
        rowId: r.rowId,
        label: r.label,
        kind: "绝对化措辞",
        detail: `正文出现绝对化/营销化措辞：${hits.join("、")}——客观表述要能复算、能被反驳`,
        severity: "存疑",
      });
    }

    // ⑤ 把行业推断写成本客户事实
    if (GENERAL_VERDICTS.includes(verdict)) {
      const pattern = CUSTOMER_FACT_PATTERNS.find((p) => p.test(prose));
      if (pattern) {
        findings.push({
          tableCode: r.tableCode,
          rowId: r.rowId,
          label: r.label,
          kind: "把推断写成客户事实",
          detail: `核实结论是「${verdict || "未核"}」（行情/未核），正文却用了「${String(
            prose.match(pattern)?.[0] ?? "",
          )}」这种本客户事实口径`,
          severity: "存疑",
        });
      }
    }

    // ⑦ 中栏说结果：内容格里不许夹带出处/引用（用户定调 v1.32「来源、引用什么的可以放到右栏」）
    const midKeys = midKeysOf(r.tableCode);
    const citedCells: string[] = [];
    const longCells: string[] = [];
    for (const key of midKeys) {
      const v = r.row[key];
      if (typeof v !== "string" || v.trim() === "") continue;
      if (hasMidCitation(v)) citedCells.push(key);
      if (v.trim().length > MID_CELL_MAX_CHARS) longCells.push(`${key}（${v.trim().length} 字）`);
    }
    if (citedCells.length > 0) {
      findings.push({
        tableCode: r.tableCode,
        rowId: r.rowId,
        label: r.label,
        kind: "中栏夹带出处",
        detail: `中栏这些格子里在讲来源/引用：${citedCells.join("、")}——出处搬右栏，格子只留结论与结果`,
        severity: "存疑",
      });
    }
    if (longCells.length > 0) {
      findings.push({
        tableCode: r.tableCode,
        rowId: r.rowId,
        label: r.label,
        kind: "中栏太长",
        detail: `中栏超过 ${MID_CELL_MAX_CHARS} 字：${longCells.join("、")}——一格只说一件事，压到一句话`,
        severity: "存疑",
      });
    }

    // ⑥ 有价值：价值类表的收益必须"可验证"（有指标、有本客户基线）
    if (isValueTable(r.tableCode)) {
      const metric = String(r.row["metric"] ?? "").trim();
      const baseline = String(r.row["baseline"] ?? "").trim();
      const missing: string[] = [];
      if (metric === "") missing.push("指标");
      // 「未提供（本客户材料未含）」这类**说明性写法**同样是"没有本客户基线"：
      // 模型只要在基线上补一句"未提供"就能让检查通过的话，这条判据就形同虚设——
      // 用户要看到的恰恰是"这条收益没有本客户基线，所以不可验证"。
      if (EMPTY_BASELINE.includes(baseline.replace(/[（(][^）)]*[）)]/g, "").trim())) {
        missing.push(`基线（现为「${baseline || "空"}」）`);
      }
      if (missing.length > 0) {
        findings.push({
          tableCode: r.tableCode,
          rowId: r.rowId,
          label: r.label,
          kind: "价值不可验证",
          detail: `价值主张缺 ${missing.join("、")}——没有本客户基线的收益无法验证有没有价值`,
          severity: "存疑",
        });
      }
    }
  }
  return findings;
}

// ─── 确定性收口（三轮之后强制执行） ─────────────────────

/**
 * 三轮自检后仍没改掉的「硬伤」，按实降级
 *
 * 为什么不继续挂着：挂着「已核实」但出处查不到，等于把编造的来源当事实交付——
 * 比"标成无法核实"严重得多（G-R0 来源溯源铁律：来源不存在则作废）。
 */
/** 兜底动作里要改的行外字段（来源属性不在 row JSON 里，要单独回写） */
export interface PostcheckEnforcement {
  rowId: string;
  row: InfoRow;
  note: string;
  /** 声称有据却给不出出处 → 来源属性按实改为「AI推断」（没有可定位出处就不许声称来自材料） */
  sourceType?: "AI推断";
}

export function enforceTruthfulDowngrade(
  rows: readonly PostcheckRow[],
  findings: readonly PostcheckFinding[],
): PostcheckEnforcement[] {
  const badByRow = new Map<string, PostcheckFinding[]>();
  for (const f of findings) {
    if (f.severity !== "硬伤") continue;
    if (f.kind !== "结论与证据矛盾" && f.kind !== "出处查不到" && f.kind !== "声称有据但无出处")
      continue;
    const list = badByRow.get(f.rowId) ?? [];
    list.push(f);
    badByRow.set(f.rowId, list);
  }
  const out: PostcheckEnforcement[] = [];
  for (const r of rows) {
    const bad = badByRow.get(r.rowId);
    if (!bad || bad.length === 0) continue;
    const reason = `${SELF_CHECK_MARK}${bad.map((f) => `${f.kind}：${f.detail}`).join("；")}`;
    const old = String(r.row["verification"] ?? "").trim();
    const noProvenance = bad.some((f) => f.kind === "声称有据但无出处");
    /**
     * 只"声称有据却给不出出处"的行，还要看它的结论档位：
     *  - 结论是 已核实/交叉一致/单一来源（都在声称"有来源"）→ 必须一起降级；
     *  - 结论是 行业通例（行情本来就能自证）→ **只把来源属性按实改为 AI推断**，不降级，
     *    否则会把一句行情白白打成"无法核实"（实跑里 20 行里有一批是这种，属误伤）。
     */
    const claimsSource = ["已核实", "交叉一致", "单一来源"].includes(String(r.row["verification_verdict"] ?? "").trim());
    const onlyProvenance = bad.every((f) => f.kind === "声称有据但无出处");
    const keepVerdict = onlyProvenance && !claimsSource;
    /**
     * 留痕文字必须与**实际做法**一致（v1.29 实跑发现）：
     * 保留档位的那条原来也写"核实结论按实降为无法核实"，可实际降的是来源属性——
     * 说的和做的不一致，用户看到的是"被降级了"，库里却是"行业通例 + AI推断"。
     */
    const note = keepVerdict
      ? `${reason}；出处给不出来，来源属性按实标为「AI 推断」，核实结论保留「行业通例」——行情不因缺本客户材料就打成无法核实。`
      : `${reason}；出处无法定位，核实结论按实降为「无法核实」，不得当结论用。`;
    const next: InfoRow = {
      ...r.row,
      verification_verdict: "无法核实",
      verification: old === "" ? note : `${old}\n${note}`,
    };
    // 保留原档位时，核实说明仍要留下自检留痕（来源属性确实被改过）
    const keepRow: InfoRow = {
      ...r.row,
      verification: old === "" ? note : `${old}\n${note}`,
    };
    out.push({
      rowId: r.rowId,
      row: keepVerdict ? keepRow : next,
      note,
      ...(noProvenance ? { sourceType: "AI推断" as const } : {}),
    });
  }
  return out;
}

/**
 * 三轮之后仍未清掉的「中栏夹带出处」：确定性搬走（不靠模型自觉）
 *
 * 为什么必须兜底：模型改了四轮也可能照旧把「（M5）」「ingest-xxx.pdf:3」写进内容格，
 * 而用户要的是**中栏说结果、右栏说来源**——这是版面口径，不能靠模型发挥。
 * 只搬引用痕迹，**正文一个字不删**；搬空的格子留给完整度规则去报缺（不塞"待补"糊弄过去）。
 */
export interface MidSweepResult {
  rowId: string;
  row: InfoRow;
  /** 被搬进右栏的引用片段数 */
  movedCount: number;
  /** 内容被搬空的中栏列（这些列现在没结果，要靠重填） */
  emptied: string[];
}

export function enforceMidCleanliness(rows: readonly PostcheckRow[]): MidSweepResult[] {
  const out: MidSweepResult[] = [];
  for (const r of rows) {
    const midKeys = midKeysOf(r.tableCode);
    if (midKeys.length === 0) continue;
    // InfoRow 的索引签名是只读的（防止下游误改契约字段），这里在本地可变副本上做清洗
    const next: Record<string, unknown> = { ...r.row };
    const moved: string[] = [];
    const emptied: string[] = [];
    for (const key of midKeys) {
      const v = next[key];
      if (typeof v !== "string" || v.trim() === "" || !hasMidCitation(v)) continue;
      const { cleaned, moved: parts } = splitMidCitations(v);
      next[key] = cleaned;
      moved.push(...parts);
      if (cleaned === "") emptied.push(key);
    }
    if (moved.length === 0 && emptied.length === 0) continue;
    // 引用一条都不许丢：并进右栏「来源」（已存在就接在后面）
    const prevSource = String(r.source ?? "").trim();
    const addSource = moved.join("；");
    if (addSource !== "") next["source"] = prevSource === "" ? addSource : `${prevSource}；${addSource}`;
    out.push({ rowId: r.rowId, row: next as InfoRow, movedCount: moved.length, emptied });
  }
  return out;
}

// ─── 自检报告（给总结文档与界面看） ─────────────────────

export interface PostcheckReport {
  /** 检了多少行 */
  checked: number;
  /** 三轮里模型自动改了多少行 */
  fixed: number;
  /** 三轮后仍没改掉、由确定性层按实降级的行数（不再是"待办"） */
  downgraded: number;
  /** 仍需处理（既没改掉、也没法降级）的条数 */
  remaining: number;
  /** 按问题类型计数（含已修好、已降级的，用于看这一轮自检到底抓到什么） */
  byKind: Record<string, number>;
  /** 仍未解决的明细（最多留 10 条，其余只计数） */
  openFindings: PostcheckFinding[];
}

export function summarizePostcheck(input: {
  checked: number;
  fixed: number;
  downgraded?: number;
  findings: readonly PostcheckFinding[];
  /** 仍需处理的问题；不传＝全部未解决 */
  open?: readonly PostcheckFinding[];
}): PostcheckReport {
  // 按「行 + 类型」去重：自检要跑三轮，同一处问题会被反复判出来，
  // 直接累加会把"20 行各 2 类问题"统计成 80/32 这种离谱数字（v1.28 实跑踩过）
  const byKind: Record<string, number> = {};
  const seen = new Set<string>();
  for (const f of input.findings) {
    const key = `${f.rowId}|${f.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  }
  const open = input.open ?? input.findings;
  return {
    checked: input.checked,
    fixed: input.fixed,
    downgraded: input.downgraded ?? 0,
    remaining: open.length,
    byKind,
    openFindings: open.slice(0, 10),
  };
}
