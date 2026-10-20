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

import { CURRENT_STATE_TABLES, TABLES_BY_CODE, middleColumns } from "@scene/contract";
import { judgeGate } from "./gate-check.js";
import { judgeConstraint } from "./constraint-check.js";
import { judgeRowValue } from "./value-check.js";
import { evaluateGates } from "./output-gates.js";
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
  | "客户侧口径混入场景分析"
  | "中栏太长"
  | "依据未落到事实"
  | "硬结论无依据"
  | "判定与能力底账矛盾"
  /**
   * 表1-3 的门槛没通过三问（变更表 #228）
   *
   * 用户定调：「所谓的门槛一定是要真实，而且重要的……只是普通的要求不能叫门槛」。
   * 判定由 `gate-check.ts` 出，这里只把它接进同一份问题清单，走同一套修复轮。
   */
  | "门槛不成立"
  /**
   * 表2-5 的行没通过「约束 vs 门槛」边界判定与「可执行判据」判定（变更表 #229）
   *
   * 用户定调：「不用合成一张表，要区分边界，同时要确认表格内容是否真有价值」。
   */
  | "约束不成立"
  /** 整行没有实质内容（全占位词/空话）——「有内容」不等于「有价值」 */
  | "行无价值"
  /**
   * 没通过该表的输出门限（`TABLE_GATES`，变更表 #231）
   *
   * 门槛三问、约束判定、行无价值这三类已有专门 kind，这里只承接其余门限
   * （数值、具名、条数、去重、覆盖、跨表、合计、空话、派生行），避免重复报。
   */
  | "不达门限"
  /**
   * 产出行校验（`validateIncomingRows`）的机械违规（变更表 #163）
   *
   * 与上面那些"语义"问题同列一个清单：判定仍出自确定性层，
   * 但修复轮与总结都按同一套口径处理。
   */
  | "未知表号"
  | "缺必填列"
  | "枚举非法"
  | "缺来源"
  | "自称用户确认"
  | "核实推诿";

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
  /**
   * 本批行所属阶段（用于**口径分档**，用户定调 2026-10-14）
   *
   * 阶段 1–2 只梳理**场景与行业本身**，客户现状表（表1-2、表2-7）已移到阶段 3；
   * 因此这两步的中栏不该出现「本客户／我方」这类客户侧口径。
   */
  stage?: number;
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

/**
 * "本客户基线拿不到"的补白写法：出现这些词就等于没有真基线
 *
 * 为什么不能只比 `EMPTY_BASELINE`：真机上还有「行业通例：目标达成率提升 20%，
 * 本客户实测值未提供」这种——耍个花招补一句"未提供"就让判据失效，等于形同虚设。
 * 括注先剥掉（`未提供（本客户材料未含）` → `未提供`），剩下的正文里出现这些词同样算没基线。
 */
const NO_BASELINE_PATTERNS: readonly RegExp[] = [/未提供/, /未给出/, /暂无/, /待补/];

/**
 * 这一行有没有**本客户基线**（G-R8「价值主张必须有指标 + 本客户基线」的唯一判据）
 *
 * 一处判据三处共用，避免口径漂移：① 自检「价值不可验证」；② 报告「价值」章导语的
 * 「其中 N 条有基线」（不许把"未提供"数成有基线）；③ 完整度「无基线行强制标 C 级假设」
 * 说明的是同一件事。**按列 key 取值，与列摆在中栏还是右栏无关**（变更表 #153）。
 */
export function hasCustomerBaseline(value: unknown): boolean {
  const text = String(value ?? "").trim();
  if (text === "") return false;
  const bare = text.replace(/[（(][^）)]*[）)]/g, "").trim();
  if (EMPTY_BASELINE.includes(bare)) return false;
  return !NO_BASELINE_PATTERNS.some((re) => re.test(bare));
}

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
 * 「中栏太长」的例外列（用户定调 v1.34，2026-10-09：「表1-1『内容』列不需要守 60 字」）
 *
 * 表1-1 是场景画像概览：项/内容 纵向呈现，`content` 就是**整段表述**
 * （契约里标了 `longText` + `truncate`）。它是给人一眼读懂"这个场景是什么"的，
 * 不是结论格——压到 60 字反而把范围、口径、条件这些必要信息切碎。
 *
 * **例外只给这一列**：其余 longText 中栏列（「怎么测」「打分依据」「要点」等 28 列）
 * 都是结论型格子，照旧受 60 字约束。
 * 曾经想按"凡 longText 一律豁免"来做，查证后发现那等于把这条检查废掉，
 * 已否掉（登记于变更表 #165）。
 */
const MID_LENGTH_EXEMPT: Readonly<Record<string, readonly string[]>> = {
  "表1-1": ["content"],
};

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
  /* 这三条曾经"按词啃"：把「未提供（本客户材料未含）」里的「材料未」当引用痕迹删掉，
     正文变成病句「未提供（本客户 含）」（用户报「交付与运维现状 表格为什么没填」时抓到）。
     「本客户材料未含」是 **缺材料的说明**（G-R5 要求必须写），不是引用痕迹。
     真正的纯引用句子由 isCitationOnly 整句搬右栏，不靠这里按词删。 */
  /按\s*(?:XX|某)?(?:白皮书|报告|标准|材料)/g,
];

/**
 * 「这一行到底有没有**客户事实**」（现状类表专用，确定性判据）
 *
 * 现状类表（`CURRENT_STATE_TABLES`：表1-2、表2-7）问的是"该客户现在怎么做"。
 * 没有客户材料时，模型只能写行业通例 + 把答案标成「未提供（本客户材料未含）」，
 * 整表读起来就像没填（用户实测："交付与运维现状 表格为什么没填？"）。
 * 用户定调：这种行不该入库，直接提示"需要先补材料"。
 *
 * 判据只看**值列**（首列是"项/环节"，是问题本身，不算事实）：值列整格只是在说
 * "材料里没有"（未提供／无材料／材料未含／暂无…）时，这一行就没有客户事实。
 */
const NO_FACT_VALUE =
  /^(?:未提供|未给出|未说明|未获取|未查到|未见|无材料|材料未含|暂无|待补|不详|未知|无)$/;

/** 去掉括注、空白与标点后的"可见正文"（用于判断这格有没有实质内容） */
function visibleText(value: unknown): string {
  return String(value ?? "")
    .replace(/[（(][^）)]*[)）]/g, "")
    .replace(/[\s，,。.、；;：:!？?—\-"'「」【】]/g, "");
}

/** 这一行有没有客户事实（非现状类表一律视为有，不参与此判据） */
export function hasCustomerFacts(tableCode: string, row: InfoRow): boolean {
  if (!isCurrentStateTable(tableCode)) return true;
  const def = TABLES_BY_CODE[tableCode];
  if (!def) return true;
  const mids = middleColumns(def);
  /* 首列是"项/环节"（问题本身），后面的才是答案；只有一列时退化为看它自己 */
  const valueCols = mids.length > 1 ? mids.slice(1) : mids;
  if (valueCols.length === 0) return true;
  const filled = valueCols.map((c) => visibleText(row[c.key])).filter((x) => x !== "");
  /* **字段空着 ≠ 材料里没有**：空值属于"没写全"，归完整性检查管；
     只有模型明确声明了"材料里没有"（未提供／材料未含…）才判定缺客户事实。 */
  if (filled.length === 0) return true;
  return filled.some((text) => !NO_FACT_VALUE.test(text));
}

function isCurrentStateTable(code: string): boolean {
  return (CURRENT_STATE_TABLES as readonly string[]).includes(code);
}

/** 一句话说明这张表缺什么材料（给界面提示用） */
export function missingMaterialHint(tableCode: string): string {
  const def = TABLES_BY_CODE[tableCode];
  const name = def ? `${tableCode} ${def.name}` : tableCode;
  return `${name}：需要先补客户材料（这张表问的是"该客户现在怎么做"，材料里没有就只能拿行业通例占位，所以本次没有生成）`;
}

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
  /* 保险：括号里带「本客户／客户」的限定语整块保护起来——它是**缺材料的说明**，
     属于正文（G-R5 要求写），任何引用模式都不许啃（啃过就是「本客户 含」这种病句） */
  const protectedSpans: string[] = [];
  let out = sentence.replace(/[（(][^）)]*(?:本客户|客户)[^）)]*[)）]/g, (m) => {
    protectedSpans.push(m);
    return `\u0000${protectedSpans.length - 1}\u0000`;
  });
  for (const re of MID_CITATION_PATTERNS) out = out.replace(re, " ");
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => protectedSpans[Number(i)] ?? "");
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

/** 「判定依据 / 打分依据」类列：写"凭什么"，不写结论复述与行业套话 */
const BASIS_LABEL_RE = /依据|理由/;

/** 行业套话：换任何一家公司都成立的句子，等于没给依据 */
const INDUSTRY_FILLER_RE = /(?:通常|一般|大多|普遍|往往)(?:都)?由[^，。；]{0,14}(?:承载|提供|负责|厂商|供应商)/;

/**
 * 这一行的「依据列」写废话了吗（用户定调 2026-10-04：「角色判定依据 里面有不少的废话」）
 *
 * 两种废话都能确定性认出来：
 *  ① **复述结论**——依据里又写一遍「属外围配合」，而「程度/角色」两列已经说过了；
 *  ② **行业套话**——「通常由第三方软件承载」这种换谁都成立的句子，不是我方凭什么。
 * 判据用的是**同一行里枚举列的取值**（复述 = 依据文本里又出现该取值），不需要语义模型。
 */
function basisFluff(r: PostcheckRow): string[] {
  const def = TABLES_BY_CODE[r.tableCode];
  if (!def) return [];
  // 只认**中栏**枚举列（程度／角色／判定那几列）——右栏枚举值（`authority=T3`、`evidence_level=B`）
  // 拿来比会误伤：型号串「CT31/CT32/CT33」里就含 "T3"（2026-10-04 实测误报，已加回归测试）
  const verdicts: string[] = [];
  for (const c of def.columns) {
    if (!c.enum || c.slot !== "中栏") continue;
    const v = String(r.row[c.key] ?? "").trim();
    if (v.length >= 2) verdicts.push(v);
  }
  const out: string[] = [];
  for (const c of def.columns) {
    if (c.slot !== "中栏" || !BASIS_LABEL_RE.test(c.label)) continue;
    const text = String(r.row[c.key] ?? "");
    if (text.trim() === "") continue;
    for (const v of verdicts) {
      if (text.includes(v)) {
        out.push(`${c.label} 复述了「${v}」（那一列已经说了）`);
        break;
      }
    }
    const filler = text.match(INDUSTRY_FILLER_RE);
    if (filler) out.push(`${c.label} 写的是行业套话「${filler[0]}」，不是我方凭什么`);
  }
  return out;
}

/** 能力底账（阶段 3 的权威表）：判"能不能碰"要看它，不是看某一个型号的规格页 */
const LEDGER_TABLE = "表4-1";

/** 否定断言里的能力词：「无 X 能力」「不支持 AI 推理」「无 NPU」 */
const NEGATION_ABILITY_RE =
  /(?:无|没有|不支持|不具备|缺乏)\s*([\u4e00-\u9fa5]{2,10}(?:能力|产品|功能|算法|硬件|模块|引擎|平台|方案))/g;
const NEGATION_TECH_RE =
  /(?:无|没有|不支持|不具备|缺乏)\s*([A-Za-z][A-Za-z0-9 ]{0,10}(?:推理|模型|算力)?)/g;

/**
 * 跨表确定性校验①：**硬结论缺依据**（用户质问「每一个表格的结论没有核实吗？」）
 *
 * 「不能碰／不参与」是最重的判定，等于告诉客户"这块别找我们"。可这一行自己的
 * 核实结论若是「无法核实／有反证」，就是**自认没有依据还下了硬结论**——按 G-R2
 * （C 级不写结论）只能降级为「只能配合／辅助」，或补足依据再说。
 * 实跑实例：有限空间安全作业 表4-2「危害辨识与风险评估」判"不能碰"，
 * 而该行核实结论正是「无法核实」（依据为 CT15 单品限制）。
 */
function hardVerdictWithoutBasis(r: PostcheckRow): PostcheckFinding | null {
  const def = TABLES_BY_CODE[r.tableCode];
  if (!def) return null;
  const verdictCol = def.columns.find((c) => c.key === "verification_verdict");
  if (!verdictCol) return null;
  const canTouch = String(r.row["can_touch"] ?? "").trim();
  const verdict = String(r.row["verification_verdict"] ?? "").trim();
  if (canTouch !== "不能碰") return null;
  if (verdict !== "无法核实" && verdict !== "有反证") return null;
  return {
    tableCode: r.tableCode,
    rowId: r.rowId,
    label: r.label,
    kind: "硬结论无依据",
    detail: `判「不能碰」，可这一行自己的核实结论是「${verdict}」——自认没依据的判定不能当结论用，只能写「只能配合／辅助」或不下判定（G-R2：C 级不写结论）`,
    severity: "硬伤",
  };
}

/**
 * 跨表确定性校验②：**判定与能力底账矛盾**（用户质问「为什么是不能碰」）
 *
 * 拿**一个型号的短板**否定**公司级能力**是最容易犯的错——实跑实例：
 * 依据写「CT15 无 NPU、不支持 AI 推理」→ 判"不参与"，可同一场景的能力底账里明明有
 * 「边缘 AI 推理算力（AI Box 边缘算力，6TOPS NPU）」已交付；同一张表 4-2 的另一行
 * 还写着「边缘侧有 AI 推理能力」判"可以碰"。判据不看措辞、只看底账对不对得上。
 */
function ledgerContradictions(
  rows: readonly PostcheckRow[],
): PostcheckFinding[] {
  // 只比「能力名」，**不比限制条件**——限制条件正是"我方缺什么"的记录，
  // 拿它去证否"无 X"会得出"底账自己都说无 X"的鬼话（2026-10-04 实测 6 处全是误报）
  const ledger = rows
    .filter((r) => r.tableCode === LEDGER_TABLE)
    .map((r) => String(r.row["ability"] ?? "").trim())
    .filter((a) => a !== "");
  if (ledger.length === 0) return [];

  const out: PostcheckFinding[] = [];
  for (const r of rows) {
    if (r.tableCode === LEDGER_TABLE) continue;
    // 只在**这一行自己下了硬否定结论**时才对底账——"能不能碰"才是要负责的判定；
    // 其他行里的"CT15 无 NPU"是补充说明（同一行判的是"只能配合"），不该点名
    const hardNo =
      String(r.row["can_touch"] ?? "").trim() === "不能碰" ||
      String(r.row["our_role"] ?? "").trim() === "不参与";
    if (!hardNo) continue;
    const def = TABLES_BY_CODE[r.tableCode];
    if (!def) continue;
    for (const c of def.columns) {
      if (c.slot !== "中栏") continue;
      const text = String(r.row[c.key] ?? "");
      if (text === "") continue;
      const terms = [
        ...text.matchAll(NEGATION_ABILITY_RE),
        ...text.matchAll(NEGATION_TECH_RE),
      ].map((m) => (m[1] ?? "").trim());
      for (const term of terms) {
        if (term.length < 2) continue;
        const hit = ledger.find((a) => a.includes(term));
        if (hit === undefined) continue;
        out.push({
          tableCode: r.tableCode,
          rowId: r.rowId,
          label: r.label,
          kind: "判定与能力底账矛盾",
          detail: `${c.label} 写「无／不支持 ${term}」，但能力底账（${LEDGER_TABLE}）里有「${hit}」——一个型号的限制不能当公司级结论，请改判或补依据`,
          severity: "存疑",
        });
        break;
      }
    }
  }
  return out;
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
/**
 * 阶段 1–2 的客户侧口径措辞（用户定调 2026-10-14）
 *
 * 用户实测质问：「认识场景／场景理解／理解商业这三步梳理的应该是场景的状态，与用户本地的产品、
 * 用户的现状没有关系才对——为什么场景要素清单里提示『未提供（本客户未指定品牌）』『未提供（本客户
 * 未提供采购价）』？」根因是自检口径不分阶段：场景级字段（主要供应商、价格量级、竞争激烈度）被
 * 逼着按客户口径回答。判据落确定性层：阶段 ≤2 的中栏出现客户侧/我方措辞即报出。
 */
const CUSTOMER_SCOPE_WORDS = /本客户|该客户|本场景客户|客户方|我方|贵司|贵方/g;

function customerScopeLeak(r: PostcheckRow, stage?: number): PostcheckFinding | null {
  if (stage === undefined || stage > 2) return null;
  const hits: string[] = [];
  for (const key of midKeysOf(r.tableCode)) {
    const v = r.row[key];
    if (typeof v !== "string") continue;
    const m = v.match(CUSTOMER_SCOPE_WORDS);
    if (m !== null) hits.push(`${key}（${[...new Set(m)].join("、")}）`);
  }
  if (hits.length === 0) return null;
  return {
    tableCode: r.tableCode,
    rowId: r.rowId,
    label: r.label,
    kind: "客户侧口径混入场景分析",
    detail:
      `阶段 1–2 只梳理**场景与行业本身**，这些格子却用了客户侧口径：${hits.join("；")}——` +
      "场景级字段按**行业口径**给量级并标注口径；判断不了就写「量级待确认（行业口径）」，不许写「未提供（本客户…）」",
    severity: "存疑",
  };
}

export function runDeterministicPostcheck(input: PostcheckInput): PostcheckFinding[] {
  const findings: PostcheckFinding[] = [];
  // 跨表校验先跑（判据要对照整批行，不能只看当前行）
  findings.push(...ledgerContradictions(input.rows));
  for (const r of input.rows) {
    const hard = hardVerdictWithoutBasis(r);
    if (hard) findings.push(hard);
    const citations = parseCitations(r.source);
    const verdict = verdictOf(r);
    const prose = proseOf(r);

    /* ⓪ 门槛成立性：表1-3 的行必须过三问（外部主体/可核验凭据/出局后果） */
    if (r.tableCode === "表1-3") {
      const gate = judgeGate(r.row as Record<string, unknown>);
      if (!gate.isGate) {
        findings.push({
          tableCode: r.tableCode,
          rowId: r.rowId,
          label: r.label,
          kind: "门槛不成立",
          detail: `${gate.failures.join("；")}。按性质应归 ${gate.suggestTable ?? "其他表"}，不是门槛`,
          severity: "存疑",
        });
      }
    }

    /* ⓪-b 约束成立性：表2-5 的行必须是可执行约束，不是准入门槛的复述 */
    if (r.tableCode === "表2-5") {
      const c = judgeConstraint(r.row as Record<string, unknown>);
      if (!c.isConstraint) {
        findings.push({
          tableCode: r.tableCode,
          rowId: r.rowId,
          label: r.label,
          kind: "约束不成立",
          detail: `${c.failures.join("；")}${c.suggestTable ? `。去向：${c.suggestTable}` : ""}`,
          severity: "存疑",
        });
      }
    }

    /* ⓪-c 价值：整行没实质内容的，别占着一行让用户白读（判据只看中栏） */
    {
      const def = TABLES_BY_CODE[r.tableCode];
      if (def) {
        const v = judgeRowValue(middleColumns(def).map((c) => (r.row as Record<string, unknown>)[c.key]));
        if (!v.hasValue) {
          findings.push({
            tableCode: r.tableCode,
            rowId: r.rowId,
            label: r.label,
            kind: "行无价值",
            detail: v.reason ?? "整行没有实质内容",
            severity: "存疑",
          });
        }
      }
    }

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
    const lengthExempt = new Set(MID_LENGTH_EXEMPT[r.tableCode] ?? []);
    const citedCells: string[] = [];
    const longCells: string[] = [];
    for (const key of midKeys) {
      const v = r.row[key];
      if (typeof v !== "string" || v.trim() === "") continue;
      // 引用痕迹任何列都不许进中栏（例外只免长度，不免"夹带出处"）
      if (hasMidCitation(v)) citedCells.push(key);
      if (!lengthExempt.has(key) && v.trim().length > MID_CELL_MAX_CHARS) {
        longCells.push(`${key}（${v.trim().length} 字）`);
      }
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

    // ⑨ 口径分档：阶段 1–2 只谈场景与行业本身（用户定调 2026-10-14）
    const scopeLeak = customerScopeLeak(r, input.stage);
    if (scopeLeak) findings.push(scopeLeak);

    // ⑧ 依据列不许写废话：复述结论 / 行业套话（用户定调：「角色判定依据 里面有不少的废话」）
    const fluff = basisFluff(r);
    if (fluff.length > 0) {
      findings.push({
        tableCode: r.tableCode,
        rowId: r.rowId,
        label: r.label,
        kind: "依据未落到事实",
        detail: `${fluff.join("；")}——依据只写我方有什么/没有什么（型号、能力、边界），一句到底`,
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
      // 判据统一走 `hasCustomerBaseline`（与报告导语、完整度规则同源）。
      if (!hasCustomerBaseline(baseline)) {
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
  /* 输出门限：整表跑一遍（去重/覆盖/合计/跨表这类规则需要全表才判得准）。
     门槛三问、约束判定、行无价值已有专门 kind，这里跳过以免同一问题报两遍。 */
  const alreadyCovered = /门槛三问|可执行|行必须有实质内容/;
  for (const f of evaluateGates(
    input.rows.map((r) => ({ id: r.rowId, tableCode: r.tableCode, row: r.row as Record<string, unknown> })),
  )) {
    if (alreadyCovered.test(f.gate)) continue;
    findings.push({
      tableCode: f.tableCode,
      rowId: f.rowId,
      label: f.label,
      kind: "不达门限",
      detail: `${f.gate}——${f.detail}`,
      /* 必填缺失属「完整性」问题，完整度检查已经会报，这里不重复判硬伤 */
      severity: f.kind === "non-empty" ? "存疑" : f.severity,
    });
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
