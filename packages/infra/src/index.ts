/**
 * @scene/infra — 基础设施层
 *
 * 提供 DB（better-sqlite3）、文件存储、DSH 客户端等基础设施实现。
 * 依赖 contract + domain；被 server 引用。
 */

export { createDb, sourceSearch } from "./sqlite-repo.js";
export type {
  DbInstance,
  Repo,
  ListFilters,
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

/** PPT 页面渲染（变更表 #141：确定性 SVG，五种布局） */
export {
  PPT_CANVAS,
  PPT_COLORS,
  PPT_FONT,
  PPT_LAYOUT_RENDERERS,
  escXml,
  estimateTextWidth,
  wrapText,
  renderPptPage,
  renderPptDeck,
  writePptSvgs,
} from "./ppt-svg.js";
export type { PptRenderContext, PptSvgPage } from "./ppt-svg.js";
