/**
 * @scene/infra — 基础设施层
 *
 * 提供 DB（better-sqlite3）、文件存储、DSH 客户端等基础设施实现。
 * 依赖 contract + domain；被 server 引用。
 */

export { createDb, sourcePassages, sourceSearch } from "./sqlite-repo.js";
export type {
  DbInstance,
  Repo,
  ListFilters,
  SourcePassage,
  SourceSearchResult,
  MessageRepo,
  CreateMessageInput,
  QualityGateRepo,
  CreateQualityGateInput,
  StageDataRepo,
  CreateStageDataInput,
  ScenarioBriefRepo,
  StageSummaryRepo,
  ScenarioStepRepo,
} from "./sqlite-repo.js";

export { parseDocument } from "./doc-parser.js";
export type { ParseResult, ParsedTable } from "./doc-parser.js";

/** LLM 客户端适配器 */
export { createDshClient } from "./dsh-client.js";
export type { DshClientOptions } from "./dsh-client.js";

/** 应用自持供应商登记表（变更表 #16：模型配置与 DSH settings.yaml 解耦） */
export {
  loadRegistry,
  upsertProvider,
  removeProvider,
  setDefaultModel,
  registrySummary,
  resolveActiveModel,
  maskKey,
  toPublic,
  NOT_CONFIGURED_MESSAGE,
} from "./provider-store.js";
export type {
  ProviderProfile,
  ProviderPublic,
  ProviderModelEntry,
  DefaultModelRef,
  ProviderRegistry,
  ResolvedModel,
  UpsertInput,
} from "./provider-store.js";

/** 供应商链接质量检查（探活+鉴权+延迟，可选模型最小生成） */
export {
  checkProviderConnection,
  checkSavedProvider,
  fetchProviderModels,
  modelsUrlCandidates,
  normalizeBaseUrl,
} from "./provider-check.js";
export type { ConnectionCheckResult, ModelsFetchResult } from "./provider-check.js";

/** 交付物导出（Markdown） */
export {
  backupBeforeOverwrite,
  safeWriteFile,
  safeWriteFileBytes,
  exportDeliverables,
  exportFileName,
  buildReportMarkdown,
  reportChapterDigest,
} from "./md-export.js";
export type { ChapterDigest, DigestOptions, SafeWriteResult } from "./md-export.js";

/** 文件存储适配器 — TODO M1 实现 */
export {};export * from "./source-index.js";
export { reportMarkdownToDocx, type DocxOptions } from "./docx-report.js";

/** PPT 页面渲染（#141 立、#142 升：白底 + 七种高密度布局；#144 升：图标 + 颜色层次 + 字内强调；#145 升：去装饰 + 最小字号 16 + 版面均衡） */
export {
  PPT_CANVAS,
  PPT_COLORS,
  PPT_BAR_COLORS,
  PPT_FONT,
  PPT_FONT_MONO,
  PPT_GRID,
  PPT_LEADING_PUNCT,
  PPT_MIN_ORPHAN_CHARS,
  PPT_TONE_PROBLEM,
  PPT_TONE_VALUE,
  PPT_LAYOUT_RENDERERS,
  escXml,
  estimateTextWidth,
  hasLeadingPunct,
  pptBarColor,
  pptEmphasisOf,
  pptToneOf,
  stripLeadingPunct,
  wrapText,
  renderPptPage,
  renderPptDeck,
  writePptSvgs,
} from "./ppt-svg.js";
export type { PptEmphasis, PptRenderContext, PptSvgPage } from "./ppt-svg.js";

/** PPT 质量门禁（#142 立、#144 升、#145 升：密度 / 骨架 / 出界 / 压字 / 信息量 / 图标 / 颜色 / 强调 / 字号 / 网格 / 留白 / 行首标点 / 孤字行） */
export {
  PPT_CONTENT_ISSUES,
  PPT_MIN_QUALITY,
  PPT_QUALITY,
  PPT_RENDER_ISSUES,
  PPT_SEMANTIC_COLORS,
  checkPptDeck,
  countSvgColors,
  countSvgEmphasis,
  countSvgIcons,
  countSvgShapes,
  countSvgTexts,
  findLeadingPunctLines,
  findOrphanLines,
  isPptContentIssue,
  isPptRenderIssue,
  svgShapeBoxes,
  svgTextRects,
} from "./ppt-quality.js";
export type { PptQualityCode, PptQualityIssue, PptShapeBox, PptTextRect } from "./ppt-quality.js";
export * from "./web-store.js";
export * from "./web-fetch-client.js";
export * from "./web-engine.js";
