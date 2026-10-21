/**
 * @scene/domain — 领域层模块桩
 *
 * 12 个领域模块，每个对应一个可独立描述的业务能力。
 * 依赖单向：domain → contract；不依赖 infra / server / web。
 * 领域模块不依赖 IO（DB/网络/模型），依赖通过参数注入。
 */

// 阶段 0 — 证据采集与溯源
export {
  gradeSource,
  gradeByCategory,
  gradeSourceByCategory,
  classifySource,
  gradeEvidence,
  gradeAnalysisEvidence,
  verifyCitation,
} from "./evidence.js";
export type { SourceCategory } from "./evidence.js";

// 资料库入库标准（新导入与存量体检共用）
export {
  ABSOLUTE_TERMS,
  findAbsoluteTerms,
  isAuthority,
  isEvidenceLevel,
  classifyLibrarySource,
  gradeIncomingEvidence,
  downgradeLibraryEvidence,
} from "./library-standard.js";
export type { LibrarySourceClass } from "./library-standard.js";

// 阶段 0 — 材料解析与入表
export {
  assessQuality,
  checkCompleteness,
  spotCheckSources,
  SPOT_CHECK_MIN,
  upsertFromAnalysis,
} from "./material.js";
export type { SourceSpotCheck, SourceSpotCheckReport } from "./material.js";
export type {
  DimensionStatus,
  QualityDimension,
  QualityAssessment,
  CompletenessCheckItem,
  MaterialReminder,
  CompletenessReport,
  CapabilityMaturityChange,
  UpdateOperation,
  AnalysisWriteback,
  MaterialUpdate,
} from "./material.js";

// 阶段 1 — 解析计划
export { } from "./parse-plan.js";

// 阶段 2 — 门槛筛查
export {
  judgeBarrier,
  planStrategy,
} from "./barrier-scan.js";
export type {
  BarrierType,
  BarrierJudgment,
  StrategyRecommendation,
} from "./barrier-scan.js";

// 阶段 3 — 市场分析
export {
  crossCheckNeeds,
  compareAlternatives,
  analyzeProfitPool,
} from "./market.js";
export type {
  UnmetNeed,
  CrossCheckResult,
  Alternative,
  AlternativeAnalysis,
  ProfitPoolEntry,
  ProfitAnalysis,
  SegmentAnalysis,
} from "./market.js";

// 阶段 4 — 能力匹配
export {
  judgeMatch,
  scoreCompetitiveness,
  prioritizeSubScenes,
} from "./capability-match.js";
export type {
  MatchJudgment,
  CompetitivenessDimension,
  CompetitivenessResult,
  SubScene,
  SubScenePriority,
} from "./capability-match.js";

// 全局 — 工作流编排
export {
  advance,
  canAdvance,
  rollback,
  stagesToMarkAfterRollback,
  markStale,
  getRiskChain,
  STAGES,
  FIRST_STAGE,
  LAST_STAGE,
} from "./workflow.js";
export type { StaleMark } from "./workflow.js";
export {
  TABLE_DEPENDENCIES,
  getAffectedStages,
  createStaleMark,
  hasStaleMarks,
  getStaleBanners,
  clearStaleMarks,
} from "./workflow.js";

// 全局 — 断点续做
export {
  planResume,
  collectRecomputeStages,
  isStageCompleted,
  findDanglingConversations,
} from "./resume.js";
export type { ResumeAction, ResumeInput, ResumePlan } from "./resume.js";

// 全局 — 会话管理
export {
  SESSION_TITLE_MAX,
  SESSION_STATUS_ACTIVE,
  SESSION_STATUS_ARCHIVED,
  validateSessionTitle,
  canArchive,
  canDelete,
  normalizeConversationTitle,
  normalizeTitle,
} from "./session.js";

// 全局 — 产品资料库去重（同型号产品行 / 同产品重复规格）
export {
  normalizeModel,
  normalizeValue,
  planProductMerge,
  planSpecDedupe,
  matchExistingProduct,
} from "./library-dedupe.js";
export type {
  ProductLike,
  ProductMergeGroup,
  SpecLike,
  SpecDedupePlan,
} from "./library-dedupe.js";

// ─── 对话即导入：消息内文件路径提取 ─────────────────────────

export { extractImportablePaths, expandHomePath, IMPORTABLE_EXTS } from "./chat-import.js";

// ─── 信息完整度检查（替代旧「质量关」；见 04 §六） ─────────────
export {
  checkStageCompleteness,
  userGaps,
  agentGaps,
  gapsToSummaryLines,
  gapsBrief,
  isEmptyValue,
} from "./completeness.js";
export type {
  InfoRow,
  Gap,
  GapKind,
  GapOwner,
  StageCompleteness,
} from "./completeness.js";

// ─── 确认机制（见 04 §4.7） ────────────────────────────────
export {
  confirmStateOf,
  usableDownstream,
  applyConfirmation,
  anchorRows1_1,
  alignmentWithBrief,
  ALIGNMENT_CONFLICT_NOTE,
} from "./confirmation.js";
export type {
  ConfirmState,
  ConfirmAction,
  Alignment,
  AlignmentItem,
} from "./confirmation.js";

// ─── 场景锚（表1-1）纯逻辑（见 04 §3.0.4） ────────────────────
export {
  anchorFixedRows,
  anchorRequiredRows,
  anchorUserRows,
  anchorAgentRows,
  buildAnchorSkeleton,
  anchorFromBrief,
  briefDraftHints,
  descriptionFromAnchor,
  anchorCompletion,
  isPlaceholderAnchorContent,
  mergeAnchorRows,
} from "./anchor.js";
export type { AnchorCompletion } from "./anchor.js";

// ─── 模型产出行校验（补「输出契约空壳」，见 04 §一） ────────────
export { validateIncomingRows, violationsBrief, mustDowngrade } from "./row-validation.js";
export type { IncomingRow, RowViolation, ViolationKind } from "./row-validation.js";

// ─── 阶段总结文档（见 04 §五；确定性生成，不需要 LLM） ──────────
export { buildStageSummary, buildStageBrief } from "./stage-summary.js";
export type { StageSummaryInput, StageBrief, StageBriefSource } from "./stage-summary.js";

// ─── 业务流程推进状态机（v1.5 逐页推进） ──────────────────────
export {
  buildFlowStatus,
  nextStep,
  prevStep,
  completionToClearFrom,
  flowBrief,
} from "./flow.js";
export type {
  FlowStepState,
  FlowStepProgress,
  FlowReadiness,
  FlowStepStatus,
  FlowStatus,
} from "./flow.js";

// ─── 生成后三问自检（规则 G-R8，v1.28） ──────────────────────
// 用户定调：「这是生成过程的一个步骤，为什么要用户判断」→ 自动查、自动改、改不掉按实降级。
export {
  runDeterministicPostcheck,
  enforceTruthfulDowngrade,
  enforceMidCleanliness,
  enforceSourceDiscipline,
  summarizePostcheck,
  MODEL_KNOWLEDGE_SOURCE_RE,
  UNKNOWN_SOURCE_MATERIAL,
  UNKNOWN_SOURCE_UNVERIFIED,
  parseCitations,
  keyPhrases,
  splitMidCitations,
  hasMidCitation,
  hasCustomerFacts,
  missingMaterialHint,
  MID_CELL_MAX_CHARS,
} from "./postcheck.js";
export { judgeGate, findFakeGates, type GateVerdict } from "./gate-check.js";
export { judgeConstraint, findWeakConstraints, type ConstraintVerdict } from "./constraint-check.js";
export { judgeRowValue, type ValueVerdict } from "./value-check.js";
export type {
  MidSweepResult,
  SourceDisciplineResult,
  PostcheckFinding,
  PostcheckInput,
  PostcheckKind,
  PostcheckReport,
  PostcheckRow,
  PostcheckSeverity,
  SourceLookup,
} from "./postcheck.js";
export {
  checkReport,
  matchChapterKey,
  missingChapterArtifacts,
  reportChapterHeadings,
  reportViolationsBrief,
  reportMinChars,
  reportMaxChars,
} from "./report-gate.js";
export { proseChars } from "./md-metrics.js";

// ─── 报告正文形态（断头段 + 章首段：变更表 #138 / #139） ──────
export {
  brokenProseHeads,
  repairProseHeads,
  firstProseParagraph,
  leadParagraphIssue,
  splitOverlongLead,
  replaceFirstProseParagraph,
  LEAD_PARAGRAPH_MAX_CHARS,
  LEAD_PARAGRAPH_SOFT_MAX_CHARS,
} from "./prose-shape.js";

// ─── 交付物终检（通读找问题 → 只改被点名的段落；变更表 #139） ──────
export {
  MAX_REVIEW_ISSUES,
  REVIEW_ISSUE_TYPES,
  DUPLICATE_SENTENCE_MIN_CHARS,
  STUB_SECTION_CHARS,
  parseReviewIssues,
  parseUnresolved,
  chapterBlocks,
  duplicateSentences,
  stubSections,
  leadParagraphProblems,
  deterministicReviewFindings,
  fixAccepted,
  contradictionCheck,
} from "./report-review.js";
export type {
  ReviewIssue,
  ReviewIssueType,
  ParsedReviewIssues,
  ReviewFinding,
} from "./report-review.js";
export type { ReportGateReport, ReportKind, ReportViolation } from "./report-gate.js";

// ─── PPT 大纲校验与兜底（变更表 #141 立、#142 升、#146 升：大纲质量判据） ──
export {
  PPT_BANNED_PATTERNS,
  PPT_OUTLINE_ISSUE_CODES,
  checkPptOutlineQuality,
  hasPptBanned,
  pptBannedHit,
  pptLayoutSentenceMax,
  pptPageSentenceBar,
  pptPageSentences,
  parsePptOutline,
} from "./ppt-outline.js";
export type { PptOutlineParse, PptOutlineQualityCode, PptOutlineQualityIssue } from "./ppt-outline.js";

export { matchContent, bigramCoverage, extractHardTokens, COVERAGE_MIN } from "./content-match.js";
export type { ContentVerdict, ContentMatchResult } from "./content-match.js";

// ─── 联网检索：URL / 权威性 / 切块 / 注入检测（变更表 #216） ────
export {
  isHttpUrl,
  normalizeUrl,
  urlKey,
  registeredDomain,
  slugify,
  cleanTitle,
  snapshotFileName,
  isBareUrlCitation,
} from "./web-url.js";
export {
  gradeWebSource,
  gradeWebSourceAuthority,
  authorityOfCategory,
  extractDocNo,
  extractReprintSource,
} from "./web-authority.js";
export type { WebAuthorityVerdict, WebPageMeta, WebRuleId, DowngradeFactor, UpgradeFactor } from "./web-authority.js";
export { chunkMarkdown, blocksToText, BLOCK_MAX, BLOCK_MIN } from "./web-chunk.js";
export type { WebBlock } from "./web-chunk.js";
export { scanInjection, shouldBlockInjection, BLOCK_AT_KINDS } from "./web-injection.js";
export type { InjectionKind, InjectionScan } from "./web-injection.js";export { stripBoilerplate, extractPublishedAt } from "./web-clean.js";
export { evaluateGates, type GateFinding, type GateRow } from "./output-gates.js";
