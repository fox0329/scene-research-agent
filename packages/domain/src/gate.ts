/**
 * gate — 质量关检查
 *
 * 职责：每个阶段完成后的质量关逐项检查（来源抽查、完整性、一致性），
 * 以及建议三档计算。
 * 规则：G-R3 每个质量关至少抽查 3 条来源；检查结果只是建议，
 * 决定权在用户（核心原则）。
 *
 * 检查项数与 00b §3.3/§4.3/§5.3/§6.3/§7.3/§8.3 一一对应：
 * 阶段 0/7/8 无质量关；阶段 1=10、2=9、3=8、4=7、5=6、6=7 项。
 */

import type { AdviceLevel, GateResult, StageId } from "@scene/contract";

// ─── 质量关检查输入/结果类型 ─────────────────────────────────

/** 单项质量关检查输入（检查事实由确定性规则产出，本模块只做规范化） */
export interface GateCheckInput {
  /** 检查项标题；留空时取该阶段标准检查项清单中的对应标题 */
  title?: string;
  /** 检查结果 */
  result: GateResult;
  /** 是否关键项（不通过即构成阻止性风险，建议档降为"建议不通过"） */
  isCritical?: boolean;
  /** 不通过时是否存在替代路径（补齐前提后可继续） */
  hasAlternativePath?: boolean;
  /** 检查说明（如"抽查 3/3 条来源一致"） */
  detail?: string;
}

/** 单项质量关检查结果 */
export interface GateCheckResult {
  /** 检查项编号（从 1 起，与 00b 检查清单行号对应） */
  itemNo: string;
  /** 检查项标题 */
  title: string;
  /** 检查结果 */
  result: GateResult;
  /** 是否通过（"通过"为 true） */
  isPassed: boolean;
  /** 是否关键项 */
  isCritical: boolean;
  /** 不通过时是否存在替代路径 */
  hasAlternativePath: boolean;
  /** 检查说明 */
  detail: string;
}

// ─── 标准检查项清单（00b §3.3-§8.3） ─────────────────────────

/** 各阶段质量关标准检查项（无质量关的阶段为空数组） */
export const GATE_CHECK_TITLES: Readonly<Record<StageId, readonly string[]>> = {
  // 阶段 0 · 材料解析：无质量关（仅完成度评估，不阻断）
  0: [],
  // 质量关 0（00b §3.3，10 项）
  1: [
    "阶段 0 材料已完成度评估，缺失项已标注风险",
    "能明确写出我方角色，且不需要我方不持有的认证",
    "存在至少一个切入点，不触碰安全责任核心",
    "没有法规/强制规范明文禁止进入",
    "有可触达的信息来源",
    "买方有预算科目可挂",
    "已识别全部一票否决者",
    "门槛扫描表无\u201c不知道\u201d状态（或已标注为调研重点）",
    "生态锁定已选定借道/绕道策略",
    "来源抽查至少 3 条通过",
  ],
  // 质量关 1（00b §4.3，9 项）
  2: [
    "能画出完整的架构图+要素间关系（含接口方式）",
    "能说出用户得到什么服务（分角色），且映射到实现载体",
    "重要结论来源权威性达标（协议/接口有 T1/T2，约束有 T1）",
    "关键设备有价格量级与竞争强度",
    "物理/合规约束有具体要求值",
    "能估算数据规模（量级、增长、存储）",
    "能列出适用标准号与合规路径",
    "能说清\u201c哪个环节不能碰\u201d",
    "来源抽查至少 3 条通过",
  ],
  // 质量关 2（00b §5.3，8 项）
  3: [
    "能说清默认购买路径",
    "能列出 3 个以上竞品并完成功能对照表",
    "能说出替代方案及其弱点",
    "能列出至少 2 个失败常见原因",
    "能列出至少 3 条未被满足的需求",
    "能说出 2-3 条趋势及对我方含义",
    "能定位预算科目",
    "来源抽查至少 3 条通过",
  ],
  // 质量关 3（00b §6.3，7 项）
  4: [
    "能力底账已按成熟度分级，\u201c已交付\u201d项有验收数据",
    "痛点排序有多源交叉验证",
    "匹配矩阵中至少有一条\u201c真能解\u201d，且不与安全责任冲突",
    "有明确的否决理由清单",
    "场景优先级矩阵已出，明确\u201c先打哪个\u201d",
    "是否已记录结论与前提条件",
    "来源抽查至少 3 条通过",
  ],
  // 质量关 4（00b §7.3，6 项）
  5: [
    "方案架构含边界声明，接口清单已定",
    "约束与合规有明确路径、责任人与周期",
    "实施计划可行，不依赖不可控条件（或已论证可行）",
    "交付与运维模式已定，含 SLA",
    "成本已估算（含实施+运营），且与竞品做了价格对照",
    "来源抽查至少 3 条通过",
  ],
  // 质量关 5（00b §8.3，7 项）
  6: [
    "每条价值对应可测指标+基线",
    "用户价值指标已定义（怎么测/基线/改善/感受）",
    "投资回报已估算，标注为 C 级假设",
    "试点成功判据已被买方确认",
    "内部稿与对客稿分离",
    "有价值呈现物",
    "来源抽查至少 3 条通过",
  ],
  // 阶段 7 · 总结沉淀 / 阶段 8 · 最终交付物：无质量关
  7: [],
  8: [],
};

/** G-R3：每个质量关至少抽查的来源条数 */
export const MIN_SAMPLE_SIZE = 3;

// ─── 公共接口 ─────────────────────────────────────────────────

/**
 * 执行质量关检查（00b §3.3-§8.3 检查清单的规范化）
 *
 * 校验检查项数与该阶段标准一致（00b 硬性口径），按输入顺序编号 1..N；
 * 标题留空时回填标准清单标题。判定事实由调用方按确定性规则产出，
 * 本函数不重新计算单项结果。
 *
 * @param stage - 阶段编号
 * @param checks - 检查输入列表
 * @returns 规范化检查结果列表
 * @throws 检查项数与该阶段标准不符时抛错
 */
export function runGate(
  stage: StageId,
  checks: GateCheckInput[],
): GateCheckResult[] {
  const titles = GATE_CHECK_TITLES[stage];
  if (checks.length !== titles.length) {
    throw new Error(
      `阶段 ${stage} 质量关需要 ${titles.length} 项检查，实际 ${checks.length} 项`,
    );
  }
  return checks.map((check, i) => ({
    itemNo: String(i + 1),
    title: check.title?.trim() || titles[i]!,
    result: check.result,
    isPassed: check.result === "通过",
    isCritical: check.isCritical ?? false,
    hasAlternativePath: check.hasAlternativePath ?? false,
    detail: check.detail ?? "",
  }));
}

/**
 * 随机采样抽查来源（G-R3：至少 3 条）
 *
 * 采样量小于 3 时按 3 取（G-R3 下限）；来源不足时全量返回。
 * 相同引用去重后再采样，避免同一来源占多个抽查名额。
 * 随机源通过参数注入（默认 Math.random），保证领域函数可测。
 *
 * @param sources - 来源引用列表（文件名:页码 / #章节 / URL）
 * @param sampleSize - 期望采样量
 * @param rng - 随机数生成器（返回 [0,1)），测试可注入确定性实现
 * @returns 抽中的来源引用（顺序经随机打乱）
 */
export function sampleSources(
  sources: string[],
  sampleSize: number,
  rng: () => number = Math.random,
): string[] {
  // 去重：同一引用只占一个抽查名额
  const unique = [...new Set(sources.filter((s) => s && s.trim()))];
  if (unique.length === 0) {
    return [];
  }

  const size = Math.max(sampleSize, MIN_SAMPLE_SIZE);
  if (size >= unique.length) {
    return shuffleCopy(unique, rng);
  }
  return shuffleCopy(unique, rng).slice(0, size);
}

/** Fisher-Yates 洗牌（不修改入参） */
function shuffleCopy(items: string[], rng: () => number): string[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

/**
 * 建议三档计算（00b §3.3/§4.3/§5.3 统一口径）
 *
 * 规则（确定性，非 LLM 语气判断）：
 *   1. 任一关键项不通过 → 建议不通过（存在阻止性风险）
 *   2. 其余任一项不通过或未检 → 建议有条件通过（存在需补齐的前提）
 *   3. 全部通过 → 建议通过
 * 建议只是建议：用户可覆盖（核心原则）。
 *
 * @param results - 质量关检查结果列表
 * @returns 建议三档之一
 */
export function decideAdvice(results: GateCheckResult[]): AdviceLevel {
  const hasCriticalFail = results.some(
    (r) => r.result === "不通过" && r.isCritical,
  );
  if (hasCriticalFail) {
    return "建议不通过";
  }

  const hasUnmet = results.some((r) => r.result !== "通过");
  if (hasUnmet) {
    return "建议有条件通过";
  }
  return "建议通过";
}

/**
 * 由已落库的质量关结果集直接三档判定（M5 阶段面板读取路径）。
 * 落库的 QualityGate 不带 is_critical 位，按保守口径：任一「不通过」即建议不通过。
 */
export function adviceFromGateRecords(results: GateResult[]): AdviceLevel {
  if (results.some((r) => r === "不通过")) return "建议不通过";
  if (results.some((r) => r !== "通过")) return "建议有条件通过";
  return "建议通过";
}
