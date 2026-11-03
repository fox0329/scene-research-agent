/**
 * source-quality — 来源质量门（确定性层）
 *
 * 用户定调（2026-11-03）：表格里不许用「未知」「不适用」这类无价值占位——没有可信来源就
 * 给判断并标 T4/C，界面标蓝。但实测发现两类漏网（照明场景 11 张表）：
 *
 * 1. **禁止措辞漏网**：模型仍然会写 `source = 未知（未检索到公开来源）`，8 行；
 * 2. **内容农场当依据**：`baijiahao.baidu.com`（百家号，6 行）、`zhidao.baidu.com`（2 行）、
 *    `blog.csdn.net`（1 行）被当作 source 落库，而 AGENTS G-R0 明确「公众号、博客、
 *    内容农场只能当线索，不能当依据」。
 *
 * 这两类必须在入库前确定性拦下：改写成「推断：…」、强制 T4/C、并把该行中栏**全部**格子标蓝
 * （整行都没有可定位来源，只标部分格子会让人以为剩下的有依据）。
 */

/** 内容农场 / UGC 站点：只能当线索，不能当依据 */
const UGC_DOMAINS: readonly string[] = [
  "baijiahao.baidu.com",
  "zhidao.baidu.com",
  "baike.baidu.com",
  "wenku.baidu.com",
  "zhihu.com",
  "zhuanlan.zhihu.com",
  "csdn.net",
  "blog.csdn.net",
  "jianshu.com",
  "sohu.com",
  "163.com",
  "toutiao.com",
  "weibo.com",
  "xiaohongshu.com",
  "douban.com",
  "360doc.com",
  "docin.com",
  "bilibili.com",
];

/**
 * 禁止措辞：要么给可定位来源，要么写明推断依据（用户定调 2026-11-03）
 *
 * 注意不能用 `\b` 收尾：中文字符不属于 JS 的词字符，「未知」后面既没有边界，
 * `^未知\b` 会整个失效（实测漏判）。改成"单独出现，或以标点接一句说明"。
 */
const FORBIDDEN_WORDING =
  /^(未知|无|暂无|不详|待补|待补充)([（(：:，,。\s].*)?$|未检索到|检索不到|未找到来源|无公开来源|没有找到来源|找不到来源|未见公开|未提供|不适用/u;

export type SourceQuality = "ok" | "no-source" | "ugc";

export interface SourceJudgement {
  quality: SourceQuality;
  /** 命中的 UGC 域名（仅 quality="ugc"） */
  domain?: string;
}

/**
 * 判一条来源能不能当依据
 *
 * - `no-source`：空值或写了禁止措辞（没给出来源）
 * - `ugc`：指向内容农场/UGC 站点（给了链接但撑不住）
 * - `ok`：材料页码、官方/媒体 URL 等，交给既有权威性分级继续判
 */
/**
 * 把 source 里的 URL 与粘连的正文切开
 *
 * 实测（地铁能源管控表3-1）：模型会写成
 * `https://max.book118.com/html/...shtm；能耗统计须按标准分项计量`——
 * URL 后面黏了一句正文。URL 只到第一个非 URL 字符为止，后面的说明属于右栏核实说明，不进来源列。
 */
export function cleanSourceText(source: unknown): string {
  const text = typeof source === "string" ? source.trim() : "";
  const matched = text.match(/https?:\/\/[^\s，。；、）)】\]"'<>]+/u);
  if (!matched) return text;
  return matched[0];
}

export function judgeSourceQuality(source: unknown): SourceJudgement {
  const text = typeof source === "string" ? source.trim() : "";
  if (text === "") return { quality: "no-source" };
  if (FORBIDDEN_WORDING.test(text)) return { quality: "no-source" };
  const matched = text.match(/https?:\/\/([^/\s]+)/u);
  if (matched?.[1]) {
    const host = matched[1].toLowerCase().replace(/^www\./u, "");
    const hit = UGC_DOMAINS.find((d) => host === d || host.endsWith(`.${d}`));
    if (hit) return { quality: "ugc", domain: host };
  }
  return { quality: "ok" };
}

/**
 * 命中质量门后的规范化来源文本
 *
 * 只陈述"依据是什么"（没来源 / 只有低质资讯），**不编造推论链条**——链条得是模型自己给的。
 */
export function normalizeSourceText(judgement: SourceJudgement): string {
  if (judgement.quality === "ugc") {
    return `推断：仅有 ${judgement.domain ?? "公开资讯"} 等非权威公开资讯可参考，未见权威来源`;
  }
  if (judgement.quality === "no-source") {
    return "推断：本步未见可定位来源，按场景逻辑与行业通识判断";
  }
  return "";
}
