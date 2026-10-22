/**
 * 资料库入库标准（确定性口径，纯函数）
 *
 * 为什么单独一层：`apps/server/src/ingest.ts`（新导入）与
 * 新导入的判定必须用**同一把尺子**——
 * 否则同一份自媒体材料在不同批次里会出现 B/C 两套标准。
 *
 * 本模块只做三件事：
 *   ① 权威级：来源串 + 文件名 → 类目 → T1–T4（委托 evidence.ts 的既有规则）；
 *   ② 绝对化措辞：命中清单（词表只此一份）；
 *   ③ 证据级：低权威 / 命中绝对化 → C（D 保留，不把「过度宣称」洗成「推断」）。
 *
 * 不碰数据库、不碰模型（AGENTS.md 规则 5：判定落确定性层）。
 */

import type { Authority, EvidenceLevel } from "@scene/contract";
import { gradeSourceByCategory, type SourceCategory } from "./evidence.js";

/**
 * 绝对化/夸大措辞（命中任一即降 C 并留痕，不删行）
 *
 * 与 `docs/资料入库标准.md` §二 的词表逐字一致。列表顺序固定：
 * 同一段文字命中多个词时，清单顺序稳定，单测与界面不抖。
 */
/**
 * 绝对化措辞（只收「结论性夸大」，不收正常技术词）
 *
 * 2026-10-21 实测误伤：`保证`（保证可用性）、`完全`（完全兼容）、`唯一`（唯一标识）、
 * `绝对`（绝对值）在技术文档里是正常表述，命中后把整行降 C，反而让体检结果不可信。
 * 保留真正表示「无保留承诺/排他第一」的说法。
 */
export const ABSOLUTE_TERMS: readonly string[] = [
  "100%",
  "百分之百",
  "零风险",
  "绝对领先",
  "绝对优势",
  "行业第一",
  "国内首家",
  "最强",
  "最佳",
  "最优",
  "必然",
  "彻底解决",
];

/** 命中绝对化措辞的词（去重、保持词表顺序）；非文本返回空数组 */
export function findAbsoluteTerms(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "object") return [];
  const text = String(value);
  if (!text) return [];
  return ABSOLUTE_TERMS.filter((term) => text.includes(term));
}

/** 权威级判定结果（入库共用） */
export interface LibrarySourceClass {
  /** 权威级 T1–T4 */
  authority: Authority;
  /** 来源类目（法规标准/政府文件/厂商官方/…） */
  category: SourceCategory;
  /**
   * 材料本身不能当硬证据
   *
   * 与入库时的口径一致：T4，或类目落在自媒体/用户自述/未知。
   * 为什么类目也要看：`classifySource` 对「有冒号但无线索」的来源兜底成「媒体 T3」，
   * 只看 T4 会漏掉「未知页」这类不可定位来源的原始缺陷。
   */
  lowAuthority: boolean;
}

/** 权威级是否有效（存量库里的值可能是 null / 空串 / 脏值） */
export function isAuthority(value: unknown): value is Authority {
  return value === "T1" || value === "T2" || value === "T3" || value === "T4";
}

/** 证据级是否有效 */
export function isEvidenceLevel(value: unknown): value is EvidenceLevel {
  return value === "A" || value === "B" || value === "C" || value === "D";
}

/** 低权威判定（入库与体检同一口径） */
export function isLowAuthority(authority: Authority, category: SourceCategory): boolean {
  return (
    authority === "T4" ||
    category === "自媒体" ||
    category === "用户自述" ||
    category === "未知"
  );
}

/**
 * 按来源串 + 文件名判权威级（入库口径）
 *
 * 固定按「AI 提取」传 source_type：权威级只看材料类目，不看谁录进来的
 * （`gradeSourceByCategory` 的设计口径）。`AI推断` 例外没有材料依据，
 * 但资料库行都有 source，所以这里不需要那个分支。
 */
export function classifyLibrarySource(
  source: unknown,
  fileName?: string,
): LibrarySourceClass {
  const text = String(source ?? "").trim();
  const { authority, category } = gradeSourceByCategory("AI提取", text, fileName ?? "");
  return { authority, category, lowAuthority: isLowAuthority(authority, category) };
}

/**
 * 新导入行的证据级（入库口径）
 *
 * 材料低权威或命中绝对化 → C；否则 B。新导入没有 A：材料提取出来的东西
 * 至多是「间接有据」，A 留给用户亲手补充/确认的条目。
 */
export function gradeIncomingEvidence(
  source: unknown,
  fileName: string,
  absoluteTerms: readonly string[],
): EvidenceLevel {
  const { lowAuthority } = classifyLibrarySource(source, fileName);
  return lowAuthority || absoluteTerms.length > 0 ? "C" : "B";
}

/**
 * 存量行的证据级降级规则（体检口径）
 *
 * - 命中绝对化 → C；原本已是 D 的**保留 D**（D 是「过度宣称」，不能降成 C 洗白）；
 * - 材料低权威 → 原为 A/B 的降 C，已是 C/D 的不动；
 * - 其余保持原值（包括空值：没有证据级不是「降级」能修的，留给人工补）。
 *
 * 幂等：已是 C 的行再次体检返回 C，调用方按「值是否变化」计数，不会重复。
 */
export function downgradeLibraryEvidence(
  level: EvidenceLevel | null | undefined,
  options: { lowAuthority: boolean; absoluteHit: boolean },
): EvidenceLevel | null | undefined {
  if (options.absoluteHit) return level === "D" ? "D" : "C";
  if (options.lowAuthority && (level === "A" || level === "B")) return "C";
  return level;
}
