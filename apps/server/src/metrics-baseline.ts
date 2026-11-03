/**
 * @scene/server — 三个归一化指标基线（MR2-T6，方案 §10）
 *
 * 全部按产物数归一化（评审修订口径：用量涨频次自然涨，不归一化趋势不可判）。
 * 基线上线记录进 docs/指标基线.md，上线 2 周后才有对比意义（红线 ③）。
 */

import type { DbInstance } from "@scene/infra";

export interface ReflectionMetrics {
  /** 产物数（归一化分母：stage_data 行数） */
  products: number;
  /** 反思必改项检出率（次/产物）：edit_cell 带 refine: 前缀的确认应用数 */
  refineApplyRate: number;
  /** undo/rewrite 频次（次/产物） */
  undoRewriteRate: number;
  /** 澄清问题重复率（同题重复次数；MR3 澄清上线前恒 0） */
  clarifyRepeatCount: number;
}

export function computeReflectionMetrics(db: DbInstance): ReflectionMetrics {
  const products = (db.db.prepare("SELECT COUNT(*) AS n FROM stage_data").get() as { n: number }).n;
  const refineApplies = (
    db.db
      .prepare("SELECT COUNT(*) AS n FROM interaction_event WHERE action = 'edit_cell' AND target LIKE 'refine:%'")
      .get() as { n: number }
  ).n;
  const undoRewrites = (
    db.db.prepare("SELECT COUNT(*) AS n FROM interaction_event WHERE action IN ('undo', 'rewrite')").get() as { n: number }
  ).n;

  return {
    products,
    refineApplyRate: products > 0 ? round2(refineApplies / products) : 0,
    undoRewriteRate: products > 0 ? round2(undoRewrites / products) : 0,
    clarifyRepeatCount: 0, // MR3 澄清上线后按同题去重计数
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
