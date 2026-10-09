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

// ─── 公共接口 ─────────────────────────────────────────────────

/**
 * 来源权威性判定（G-R1：T1 权威 / T2 较权威 / T3 参考 / T4 待验证）
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
