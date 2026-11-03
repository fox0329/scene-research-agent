/**
 * @scene/server — 检查管线整合（MR2-T2，方案 6.5）
 *
 * 一轮内同跑三路检查（postcheck 确定性发现 ∥ reflection 锚点比对 ∥ completeness 缺口），
 * 合并成**唯一**偏差清单——修订合并单轮、一次差分，不再三轮自检各改各的。
 * postcheck 路只取确定性发现（模型修订合并进 T3 refine-output 的单次重写）。
 */

import type { InfoStageId, RequirementEntry } from "@scene/contract";
import {
  checkStageCompleteness,
  evaluateEntries,
  excludeDismissed,
  runDeterministicPostcheck,
  type AnchorTarget,
  type AnchorViolation,
  type PostcheckRow,
  type SourceLookup,
} from "@scene/domain";

export interface PipelineInput {
  stage: InfoStageId;
  /** postcheck 行（toPostcheckRows 转换后，调用方从库行转换） */
  postcheckRows: readonly PostcheckRow[];
  /** completeness 的表行（同库行，按表分组） */
  rowsByTable: Readonly<Record<string, readonly { id: string; row: Record<string, unknown> }[] | undefined>>;
  entries: readonly RequirementEntry[];
  target: AnchorTarget;
  /** postcheck 来源核查；缺省 = 不做来源核查（表未入库时） */
  lookup?: SourceLookup;
  tableCodes?: readonly string[];
  /** postcheck 的机械违规注入（变更表 #163 口径透传，PostcheckInput 无此字段则弃用） */
  violations?: readonly unknown[];
}

export type PipelineFindingSource = "postcheck" | "reflection" | "completeness";

export interface PipelineFinding {
  source: PipelineFindingSource;
  /** mandatory = 差分必改；review = 存疑；advisory = 缺数据等差分改不动的 */
  level: "mandatory" | "review" | "advisory";
  /** 定位：表号[:行id] 或条目 id */
  location: string;
  detail: string;
  /** reflection 路回链：差分应用时知道对应哪条画像条目 */
  entryId?: string;
  raw: AnchorViolation | { gapKind: string; owner: string } | Record<string, unknown>;
}

export interface PipelineResult {
  /** 合并去重后的唯一清单（顺序：postcheck → reflection → completeness，可复现） */
  findings: PipelineFinding[];
  mandatoryCount: number;
  counts: Record<PipelineFindingSource, number>;
}

export function runCheckPipeline(input: PipelineInput): PipelineResult {
  const postcheckFindings = runDeterministicPostcheck({
    rows: input.postcheckRows,
    lookup: input.lookup ?? emptyLookup(),
    stage: input.stage,
  });

  const reflectionViolations = evaluateEntries(
    excludeDismissed([...input.entries], new Set()),
    input.target,
  );

  const completeness = checkStageCompleteness({
    stage: input.stage,
    rowsByTable: input.rowsByTable,
    ...(input.tableCodes !== undefined ? { tableCodes: input.tableCodes } : {}),
  });

  const findings: PipelineFinding[] = [
    ...postcheckFindings.map((f) => ({
      source: "postcheck" as const,
      level: (f.severity === "硬伤" ? "mandatory" : "review") as PipelineFinding["level"],
      location: `${f.tableCode}:${f.rowId}`,
      detail: f.detail,
      raw: f as unknown as Record<string, unknown>,
    })),
    ...reflectionViolations.map((v) => ({
      source: "reflection" as const,
      level: "mandatory" as const,
      location: v.entryId,
      detail: `${v.entryText}——${v.detail}`,
      entryId: v.entryId,
      raw: v,
    })),
    ...completeness.gaps.map((g) => ({
      source: "completeness" as const,
      // 缺数据不是差分能改的：一律 advisory，但用户缺口要透出（T5 澄清流转消费）
      level: "advisory" as const,
      location: g.tableCode ? `${g.tableCode}${g.column ? `:${g.column}` : ""}` : "阶段级",
      detail: g.detail,
      raw: { gapKind: g.kind, owner: g.owner },
    })),
  ];

  const deduped = dedupeFindings(findings);
  return {
    findings: deduped,
    mandatoryCount: deduped.filter((f) => f.level === "mandatory").length,
    counts: {
      postcheck: postcheckFindings.length,
      reflection: reflectionViolations.length,
      completeness: completeness.gaps.length,
    },
  };
}

function emptyLookup(): SourceLookup {
  return { hasSource: () => false, hasContent: () => false };
}

/** 同 source 同 location 同 detail 的重复发现只留一条（三路交叉报告去重） */
function dedupeFindings(findings: PipelineFinding[]): PipelineFinding[] {
  const seen = new Set<string>();
  const out: PipelineFinding[] = [];
  for (const f of findings) {
    const key = `${f.source}::${f.location}::${f.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
