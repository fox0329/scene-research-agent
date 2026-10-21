/**
 * library-maintenance — 资料库确定性整理（能力重复合并）
 *
 * 用户定调 2026-10-21：「重复的信息可以合并」——体检结果里同一份能力被两个来源文件
 * 各写了一遍，能力清单就出现两行同名同领域的能力，分析时会被当成两项能力重复计数。
 *
 * 判定放在本模块（AGENTS §三.5：高风险判定落确定性层，可单测、可审计），
 * 规则只有三条，不做"信息量更大就特殊照顾"的模糊判断：
 *   ① 同键 = `product_line_id + domain + name`（name 去全部空白、大小写不敏感）；
 *   ② 保留**描述更长**的一行（信息更全）；
 *   ③ 描述等长时保留 `created_at` 更早的一行；仍并列按 id 字典序（结果可复现）。
 *
 * 幂等：合并后再跑没有同键组，`merged` 为空。
 */

import type { Capability } from "@scene/contract";
import type { DbInstance } from "@scene/infra";

/** 一组重复能力（报告结构与 API 返回一致） */
export interface CapabilityMergeGroup {
  /** 归一键：`产品线id|归一领域|归一能力名`（产品线 id 在前，便于反查受影响库） */
  key: string;
  /** 保留行 id */
  keptId: string;
  /** 删除行 id（按稳定顺序） */
  removedIds: string[];
  /** 保留行的描述（原文） */
  keptDescription: string;
  /** 被删行的描述（原文，按删除顺序） */
  removedDescriptions: string[];
}

/** 合并报告 */
export interface CapabilityMergeReport {
  merged: CapabilityMergeGroup[];
}

/** 能力名归一键：去掉全部空白（含全角空格）后小写 */
export function normalizeCapabilityName(name: string | null | undefined): string {
  return String(name ?? "")
    .replace(/[\u3000\s]+/g, "")
    .toLowerCase();
}

/** 领域归一键：去首尾、折叠空白（领域名里的空格是排版噪声，不改变语义） */
export function normalizeCapabilityDomain(domain: string | null | undefined): string {
  return String(domain ?? "")
    .replace(/[\u3000\s]+/g, " ")
    .trim();
}

/** 一行的归一组键 */
export function capabilityGroupKey(row: {
  product_line_id: string;
  domain: string;
  name: string;
}): string {
  return `${row.product_line_id}|${normalizeCapabilityDomain(row.domain)}|${normalizeCapabilityName(row.name)}`;
}

/** 描述信息量：按去首尾空白后的字符数比长短 */
function descriptionLength(description: string | null | undefined): number {
  return String(description ?? "").trim().length;
}

/**
 * 计算合并计划（纯函数，不碰 IO）
 *
 * @param rows - 待判定的能力行（调用方已按产品线过滤）
 * @returns 只包含"有 2 行及以上"的组
 */
export function planCapabilityMerge(
  rows: readonly Capability[],
): CapabilityMergeGroup[] {
  const groups = new Map<string, Capability[]>();
  for (const row of rows) {
    const key = capabilityGroupKey(row);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const out: CapabilityMergeGroup[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => {
      // ① 描述更长者优先保留
      const byLength = descriptionLength(b.description) - descriptionLength(a.description);
      if (byLength !== 0) return byLength;
      // ② 等长取创建更早者
      const ca = String(a.created_at ?? "");
      const cb = String(b.created_at ?? "");
      if (ca !== cb) return ca < cb ? -1 : 1;
      // ③ 仍并列按 id，保证每次跑结果一致
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const kept = sorted[0]!;
    const removed = sorted.slice(1);
    out.push({
      key,
      keptId: kept.id,
      removedIds: removed.map((r) => r.id),
      keptDescription: kept.description,
      removedDescriptions: removed.map((r) => r.description),
    });
  }
  return out;
}

/** 取目标能力行（指定产品线 / 全库） */
function listCapabilities(db: DbInstance, productLineId?: string): Capability[] {
  const line = String(productLineId ?? "").trim();
  return db.capabilityRepo.list(
    line
      ? { where: "product_line_id = ?", params: [line], orderBy: "created_at ASC" }
      : { orderBy: "created_at ASC" },
  ) as Capability[];
}

/** 只读预览：列出将要合并的组，不删任何行 */
export function previewDuplicateCapabilities(
  db: DbInstance,
  productLineId?: string,
): CapabilityMergeReport {
  return { merged: planCapabilityMerge(listCapabilities(db, productLineId)) };
}

/**
 * 执行能力重复合并（幂等）
 *
 * 删除其余行；**不迁移来源信息**（用户定调：保持简单规则，不做"来源信息量更大"特殊处理）。
 * 调用方如需通知下游待重算，可按 `key` 前缀解析受影响产品线。
 */
export function mergeDuplicateCapabilities(
  db: DbInstance,
  productLineId?: string,
): CapabilityMergeReport {
  const plan = planCapabilityMerge(listCapabilities(db, productLineId));
  for (const group of plan) {
    for (const id of group.removedIds) {
      db.capabilityRepo.deleteById(id);
    }
  }
  return { merged: plan };
}
