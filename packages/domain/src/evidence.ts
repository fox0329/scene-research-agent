/**
 * evidence — 证据采集与溯源（阶段 0）
 *
 * 职责：来源标注、权威性分级、证据分级、溯源链维护。
 * 规则：G-R0 溯源铁律、G-R1 来源权威性分级、G-R2 证据分级。
 *
 * 分级是确定性映射（AGENTS.md 规则 5）：LLM 不进入判定路径，
 * 只负责内容生成；本模块按"数据来源标记 + 用户确认状态"判定等级。
 */

import type { Authority, EvidenceLevel, SourceType } from "@scene/contract";

// ─── 来源格式规则（G-R0：来源不存在则作废） ──────────────────

/** URL 引用：http/https 协议 + 非空主机部分 */
const URL_CITATION_RE = /^https?:\/\/\S+$/;

/** 文件引用：文件名 + 定位符（:页码 / #章节），定位符不含路径分隔符 */
const FILE_CITATION_RE = /^[^\s/:#]+[:#][^/\s]+$/;

// ─── 权威性映射（G-R1） ─────────────────────────────────────

/**
 * 来源权威性分级映射（按数据来源标记的确定性降级链）：
 *   用户补充 → T1 权威（一手信息）
 *   用户确认 → T2 较权威（用户确认过的事实）
 *   AI 提取 → T3 参考（自公开材料提取，未经确认）
 *   AI 推断 → T4 待验证（无来源佐证）
 *
 * 类目级细化（政府文件/标准/法规 → T1、官方文档/年报 → T2、
 * 行业报告/媒体分析 → T3）在资料入库时按来源类目另行标注
 * （TraceableFields.source_authority），本函数只兜底映射来源标记。
 */
const AUTHORITY_BY_SOURCE_TYPE: Record<SourceType, Authority> = {
  用户补充: "T1",
  用户确认: "T2",
  AI提取: "T3",
  AI推断: "T4",
};

// ─── 来源类目分级（G-R1 的类目级细化，变更表 #210） ─────────

/**
 * 来源类目（**材料本身是什么**，与"事实怎么来的"解耦）
 *
 * 为什么必须分两层：`source_type` 回答"这条事实是用户写的还是 AI 提的"，
 * `source_authority` 回答"依据的材料本身有多权威"。原来二者被绑死
 * （用户补充→T1、AI提取→T3），结果**用户随手写的一段话**和**国家标准**都是 T1，
 * 权威性分级形同虚设。现在类目先行：材料是标准/法规就是 T1，是自媒体就是 T3/T4，
 * 不管它是谁录进来的。
 */
export type SourceCategory =
  | "法规标准"
  | "政府文件"
  | "厂商官方"
  | "年报公告"
  | "行业报告"
  | "媒体"
  | "自媒体"
  | "用户自述"
  | "未知";

/**
 * 类目 → 权威性（G-R1 类目级映射）
 *
 * T1 权威：法律法规、国家标准、政府发布（有强制力或官方效力）
 * T2 较权威：厂商官方文档、上市公司年报与交易所公告、权威行业机构报告
 * T3 参考：行业媒体、一般分析文章
 * T4 待验证：自媒体、论坛、用户口述、来源不明
 */
const AUTHORITY_BY_CATEGORY: Record<SourceCategory, Authority> = {
  法规标准: "T1",
  政府文件: "T1",
  厂商官方: "T2",
  年报公告: "T2",
  行业报告: "T2",
  媒体: "T3",
  自媒体: "T4",
  用户自述: "T4",
  未知: "T4",
};

/**
 * 权威域名/机构规则表（按序匹配，先命中者胜）
 *
 * 顺序有意义：`.gov.cn` 既可能是政府文件也可能挂在媒体转载页，
 * 所以政府/标准规则必须排在媒体规则之前。
 */
const CATEGORY_RULES: ReadonlyArray<{ re: RegExp; category: SourceCategory }> = [
  // 标准与法规：标准号、法规名称、标准机构域名
  { re: /(GB\/T|GB|ISO|IEC|IEEE|ITU|ETSI|3GPP|RFC)\s*\d/i, category: "法规标准" },
  { re: /(国家标准|行业标准|团体标准|地方标准|强制性标准|法律法规|条例|管理办法|实施细则)/, category: "法规标准" },
  { re: /\b(iso\.org|iec\.ch|ieee\.org|itu\.int|3gpp\.org|ietf\.org|sac\.gov\.cn|std\.samr\.gov\.cn)\b/i, category: "法规标准" },
  // 政府：域名 .gov / .gov.cn / 政府机构名
  { re: /\.gov(\.cn)?(\/|$)/i, category: "政府文件" },
  { re: /(人民政府|发展和改革委员会|工业和信息化|国家能源局|市场监督管理|住房和城乡建设|应急管理部|生态环境部)/, category: "政府文件" },
  // 年报公告：交易所、巨潮资讯
  { re: /\b(cninfo\.com\.cn|sse\.com\.cn|szse\.cn|hkexnews\.hk|sec\.gov)\b/i, category: "年报公告" },
  { re: /(年度报告|年报|招股说明书|公告编号|临时公告)/, category: "年报公告" },
  // 自媒体**必须排在「厂商官方」之前**（2026-10-19 实测 bug）：
  // `https://www.zhihu.com/question/123` 会被 `www.` 前缀规则命中判成「厂商官方 T2」，
  // 于是知乎回答和厂商文档同档——权威性分级被一条通配规则击穿。
  { re: /\b(mp\.weixin\.qq\.com|zhihu\.com|csdn\.net|jianshu\.com|baijiahao\.baidu\.com|toutiao\.com|sohu\.com|163\.com\/dy|weibo\.com|douban\.com|bilibili\.com|xiaohongshu\.com)\b/i, category: "自媒体" },
  // 厂商官方：文档关键词优先，再按「文档类子域」判定
  { re: /(官方文档|产品手册|技术白皮书|datasheet|数据手册|规格书|用户手册|安装指南)/i, category: "厂商官方" },
  // 文档类子域判定改为**两段式**（2026-10-19 实测 bug）：
  // 原来只认 `docs.xxx.com` 这种二级结构，`docs.aws.amazon.com`（三级）匹配不到，
  // 落到兜底「媒体 T3」——厂商官方文档被当成一般媒体。
  // 现在只要求「域名里出现文档类标签」，不限制层级。
  { re: /(^|\/\/)(docs?|developer|developers|support|help|api|reference|wiki)\./i, category: "厂商官方" },
  // 行业报告：咨询机构
  { re: /\b(idc|gartner|forrester|mckinsey|bcg|deloitte|pwc|赛迪|艾瑞|易观|头豹|亿欧)\b/i, category: "行业报告" },
  { re: /(行业报告|市场研究|调研报告|白皮书)/, category: "行业报告" },
  // 媒体（权威媒体名单见调研文档 §五）
  { re: /\b(xinhuanet\.com|people\.com\.cn|36kr\.com|huxiu\.com|jiemian\.com|caixin\.com|yicai\.com|thepaper\.cn|stcn\.com)\b/i, category: "媒体" },
];

/** 用户直接口述/手写（没有材料文件可指）时的来源串特征 */
const USER_STATEMENT_RE = /^(用户补充|用户口述|用户输入|手动录入|人工填写)/;

/**
 * 判定来源类目（确定性，可单测）
 *
 * 输入是**来源串**：`文件名:页码` 或 `https://…`，或用户口述标记。
 * 只做模式匹配，不调模型——类目判定必须可审计、可复现（规则 5）。
 *
 * @param source - 来源引用串（`规格书.pdf:12` / `https://…` / `用户补充`）
 * @param fileName - 原始文件名（可选，文件名本身常带类目线索，如「GB50311-2016.pdf」）
 */
export function classifySource(source: string, fileName?: string): SourceCategory {
  const raw = String(source ?? "").trim();
  const s = `${raw} ${String(fileName ?? "")}`.trim();
  if (s === "") return "未知";
  if (USER_STATEMENT_RE.test(raw)) return "用户自述";
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(s)) return rule.category;
  }
  // 纯 URL 且无任何特征：按"一般网络来源"处理，不当权威
  if (URL_CITATION_RE.test(raw)) return "媒体";
  // 有文件名但无线索：可能是内部资料，按参考级
  if (/[:#]/.test(s)) return "媒体";
  return "未知";
}

/**
 * 按类目判权威性（G-R1 类目级）
 *
 * @param category - 来源类目
 * @returns T1-T4
 */
export function gradeByCategory(category: SourceCategory): Authority {
  return AUTHORITY_BY_CATEGORY[category];
}

/**
 * 综合判定一条来源的权威性（**新口径，优先于 `gradeSource`**）
 *
 * **权威性只看依据本身**（材料类目），**不看它是谁录进来的**：
 * 这两个是不同维度，混在一起会得出荒谬结论——
 * "AI 从国标里提的一条"如果因为"AI 提取"被降到 T3，
 * 就等于国标和白皮书同档，类目分级白做。
 *
 * 「这条提取准不准」由 `evidence_level` 表达（AI提取未确认 → C），
 * 与「依据本身多权威」正交：**国标里提错了仍然是国标依据不足，
 * 而不是依据变成参考级**。
 *
 * 唯一例外是 `AI推断`：推断没有材料依据，指向哪个域名都不能算权威（T4）。
 * 用户口述同理没有材料依据，退回标记映射（用户补充→T1 是"一手判断"的意思）。
 *
 * @param sourceType - 数据来源标记（事实怎么来的）
 * @param source - 来源引用串
 * @param fileName - 原始文件名
 * @returns { authority, category } 供落库与自检使用
 */
export function gradeSourceByCategory(
  sourceType: SourceType,
  source: string,
  fileName?: string,
): { authority: Authority; category: SourceCategory } {
  const category = classifySource(source, fileName);
  if (category === "用户自述" || category === "未知") {
    // 没有可判定的材料类目：退回原有标记映射（用户补充→T1 等）
    return { authority: gradeSource(sourceType), category };
  }
  // 推断没有材料依据：指向哪个域名都不能当权威
  if (sourceType === "AI推断") {
    return { authority: "T4", category };
  }
  return { authority: gradeByCategory(category), category };
}

// ─── 公共接口 ─────────────────────────────────────────────────

/**
 * 来源权威性判定（G-R1：T1 权威 / T2 较权威 / T3 参考 / T4 待验证）
 *
 * 注意：本函数只看"事实怎么来的"（来源标记），**不看材料本身权威不权威**。
 * 需要按材料类目判定时用 `gradeSourceByCategory`。
 *
 * @param sourceType - 数据来源标记
 * @returns 权威性分级 T1-T4
 */
export function gradeSource(sourceType: SourceType): Authority {
  return AUTHORITY_BY_SOURCE_TYPE[sourceType];
}

/**
 * 证据分级（G-R2：A 直接可验证 / B 间接有据 / C 架构推断 / D 过度宣称）
 *
 * 确定性映射：
 *   用户补充           → A（一手信息）
 *   用户确认           → B（用户确认过）
 *   AI 提取 + 已确认    → B（用户确认 + AI 提取）
 *   AI 提取 + 未确认    → C（未经确认，按推断对待，不写结论）
 *   AI 推断 + 已确认    → C（推断有据，仍属架构推断）
 *   AI 推断 + 未确认    → D（无来源佐证的宣称，必须删除）
 *
 * @param sourceType - 数据来源标记
 * @param isVerified - 用户是否已确认该条数据
 * @returns 证据分级 A-D
 */
export function gradeEvidence(
  sourceType: SourceType,
  isVerified: boolean,
): EvidenceLevel {
  if (sourceType === "用户补充") {
    return "A";
  }
  if (sourceType === "用户确认") {
    return "B";
  }
  if (sourceType === "AI提取") {
    return isVerified ? "B" : "C";
  }
  // AI推断：确认过仍按 C（架构推断，不写结论）；未确认为 D（必须删除）
  return isVerified ? "C" : "D";
}

/**
 * 分析行的证据分级（G-R2 的 A/B/C 三分；用户定调 v1.35，2026-10-09）
 *
 * 「D 级不得入库」是**材料入库**的规则：M1–M5 是从资料里提取出来的东西，
 * 无来源佐证的宣称必须删。**分析行不是**——G-R5 明确允许阶段 3 之后写推理，
 * 用同一把尺子量就会得出"AI 推断 + 未核实 = D = 不许入库"，与 G-R5 直接打架
 * （用户定调：「分析行是我们自己的推理产出，不该用同一把尺子量」，判断成立）。
 *
 * 所以分析行只用 A/B/C，**结构上产不出 D**：
 *   用户补充 → A（一手信息）
 *   用户确认 → B
 *   AI 提取 + 有可定位出处 → B（间接有据，与材料入库行同口径）
 *   AI 提取 + 出处给不出来 → C（按推断对待）
 *   AI 推断 → C（架构推断）
 * 「推断不许写成客户事实」不靠这一列，由确定性自检项「把推断写成客户事实」
 * 「硬结论无依据」另行把关。
 *
 * @param sourceType - 数据来源标记
 * @param hasLocatableSource - 出处是否可定位到 `文件名:页码`（由 `parseCitations` 判定）
 */
export function gradeAnalysisEvidence(
  sourceType: SourceType,
  hasLocatableSource = false,
): EvidenceLevel {
  if (sourceType === "用户补充") {
    return "A";
  }
  if (sourceType === "用户确认") {
    return "B";
  }
  if (sourceType === "AI提取") {
    return hasLocatableSource ? "B" : "C";
  }
  return "C";
}

/**
 * 校验来源引用格式（G-R0 溯源铁律：格式不合法即作废）
 *
 * 合法格式二选一：
 *   - URL：http(s)://… （G-R0 的 URL+日期形式，日期由来源清单另记）
 *   - 文件引用：文件名 + ":"页码 或 "#"章节，如 "规格书.pdf:12"、"白皮书#3"
 *
 * @param source - 来源引用字符串
 * @returns 格式合法返回 true
 */
export function verifyCitation(source: string): boolean {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return URL_CITATION_RE.test(trimmed) || FILE_CITATION_RE.test(trimmed);
}
