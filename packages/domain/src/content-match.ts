/**
 * content-match — 判断「材料原文是否支持这句话」（G-R0/G-R8 的判定核心）
 *
 * 为什么不能简单 `pageText.includes(snippet)`：
 * 业务行不是原文拷贝，是**归纳改写**。实测 203 条真实记录里，
 * 纯字符串比对会把 **107 条（53%）判成"原文没有"**——全是误杀：
 *   原文 `数据上云（MQTT / HTTPS）` → 业务行 `支持 MQTT / HTTPS 数据上云`
 *   原文 `压铸车间承担铝合金压铸件的成型…工序` → 业务行 `压铸车间主力成型设备…`
 * 这类改写是正常的，判成造假等于让自检天天误报，最后没人看。
 *
 * 但也不能放宽到"差不多就算"——否则编造的话也能混过去。
 *
 * 做法：两条独立的线，都过才算支持
 *   ① **关键要素必须逐一在原文出现**（数字、单位数值、型号编码、英文技术词）
 *      —— 专治"改数字"：`NPU 6 TOPS` → `NPU 60 TOPS` 措辞覆盖率仍很高，但 60 不在原文
 *   ② **双字组覆盖率 ≥ 阈值**（中文改写的容忍度）
 *      —— 实测真实记录最低 68%、编造样本最高 29%，取 50% 留足两侧余量
 *
 * 都是确定性规则：无 IO、无模型、可单测。
 */

/** 双字组覆盖率阈值：实测真实记录 ≥0.68、编造 ≤0.29，取中间偏保守的 0.5 */
export const COVERAGE_MIN = 0.5;

/** 逐条核对的结论 */
export type ContentVerdict = "supported" | "rewritten" | "unsupported";

/** 核对明细（写给用户看，也便于排查误判） */
export interface ContentMatchResult {
  /** supported=原文支持 / rewritten=措辞差异大但要素齐 / unsupported=原文不支持 */
  verdict: ContentVerdict;
  /** 双字组覆盖率（0–1） */
  coverage: number;
  /** 原文里找不到的关键要素（数字/型号/英文词） */
  missingTokens: string[];
  /** 说明 */
  detail: string;
}

/** 归一化：去掉空白与常见中英文标点，只留可比较的字符 */
function normalize(s: string): string {
  return String(s ?? "")
    .replace(/\s+/g, "")
    .replace(/[，。、；：（）()「」《》【】,.;:'"“”‘’\-—–~～]/g, "");
}

/**
 * 抽取"关键要素"——改了就一定是错的那部分
 *
 * 三类：
 *   - 带单位的数值：`6 TOPS` `24V` `-25~60℃` `2000 点/秒` `128GB`
 *   - 型号/编号：`YS-EC3200` `IP20` `GB/T 22239` `IEC 60870-5-104`
 *   - 英文技术词：`Modbus` `OPC UA` `MQTT` `NPU` `DDR4`
 */
export function extractHardTokens(snippet: string): string[] {
  const text = String(snippet ?? "");
  /** 归一化形式去重，保留可读原样给用户看（`YS-EC5200` 比 `YSEC5200` 好看） */
  const out = new Map<string, string>();
  const add = (raw: string) => {
    const display = raw.trim().replace(/\s+/g, " ").toUpperCase();
    const key = normalize(display);
    if (key.length === 0) return;
    if (!out.has(key)) out.set(key, display);
  };

  // 带单位的数值（含负号、区间、小数）
  //
  // 量词必须收全：漏了「个」就抓不到「4 个千兆网口」这种改数字
  // （原文是 2×千兆网口）。实测这条是唯一漏网的真错。
  for (const m of text.matchAll(
    /-?\d+(?:\.\d+)?(?:\s*[~～-]\s*-?\d+(?:\.\d+)?)?\s*(?:TOPS|GB|MB|KB|TB|GHz|MHz|kW|W|V|mA|A|℃|°C|%|ms|个|路|核|点|次|倍|层|项|类|组|条|台|套|页|人|年|个月|月|天|小时|分钟|秒|米|毫米)/gi,
  )) {
    add(m[0]);
  }
  // 型号 / 编号（含连字符与斜杠的标准号）
  for (const m of text.matchAll(/\b(?:[A-Z]{2,}\/[A-Z]?\s?\d[\d.\-]*|\b[A-Z]{1,}[- ]?[A-Z]{0,}\d{2,}[\w\-]*|\bIP\d{2}\b|\b[A-Z]{2,}\d{2,}[\w\-]*)/g)) {
    if (normalize(m[0]).length >= 4) add(m[0]);
  }
  // 英文技术词（长度 ≥3，排除纯停用词）
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9]{2,}\b/g)) {
    const t = m[0].toUpperCase();
    if (!["THE", "AND", "FOR", "NOT"].includes(t)) add(t);
  }
  return [...out.values()];
}

/** 双字组覆盖率：把片段切成 2 字窗口，算多少能在原文里找到 */
export function bigramCoverage(snippet: string, source: string): number {
  const t = normalize(snippet);
  const s = normalize(source);
  if (t.length < 2) return 1;
  if (s.length === 0) return 0;
  let hit = 0;
  let total = 0;
  for (let i = 0; i + 2 <= t.length; i++) {
    total += 1;
    if (s.includes(t.slice(i, i + 2))) hit += 1;
  }
  return total === 0 ? 1 : hit / total;
}

/**
 * 判断原文是否支持这句话
 *
 * @param snippet - 业务行里的说法（可能被归纳改写）
 * @param source - 材料原文（页级或整份材料）
 * @param opts.minCoverage - 覆盖率阈值，默认 `COVERAGE_MIN`
 * @returns 结论 + 覆盖率 + 缺失的关键要素，便于如实说明"哪里对不上"
 */
export function matchContent(
  snippet: string,
  source: string,
  opts: { minCoverage?: number } = {},
): ContentMatchResult {
  const minCoverage = opts.minCoverage ?? COVERAGE_MIN;
  const text = String(snippet ?? "").trim();
  const src = String(source ?? "");
  if (text === "") return { verdict: "supported", coverage: 1, missingTokens: [], detail: "无内容可核" };
  if (normalize(src) === "") {
    return { verdict: "unsupported", coverage: 0, missingTokens: [], detail: "该页无原文可核" };
  }

  const coverage = bigramCoverage(text, src);
  const srcNorm = normalize(src).toUpperCase();
  // 关键要素逐个核：原文里必须出现（归一化后比，避免空格/标点差异）
  const missingTokens = extractHardTokens(text).filter((t) => !srcNorm.includes(normalize(t).toUpperCase()));

  if (missingTokens.length > 0) {
    return {
      verdict: "unsupported",
      coverage,
      missingTokens,
      detail: `原文里找不到这些关键要素：${missingTokens.slice(0, 5).join("、")}`,
    };
  }
  if (coverage >= minCoverage) {
    return {
      verdict: "supported",
      coverage,
      missingTokens: [],
      detail: coverage >= 0.95 ? "原文一致" : "原文支持（措辞有归纳）",
    };
  }
  return {
    verdict: "unsupported",
    coverage,
    missingTokens: [],
    detail: `与原文重合度仅 ${Math.round(coverage * 100)}%（低于 ${Math.round(minCoverage * 100)}%），可能改写过度或引错出处`,
  };
}
