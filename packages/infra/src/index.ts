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
} from "./sqlite-repo.js";

export { parseDocument } from "./doc-parser.js";
export type { ParseResult, ParsedTable } from "./doc-parser.js";

/** DSH 客户端适配器 */
export { createDshClient } from "./dsh-client.js";
export type { DshClientOptions } from "./dsh-client.js";

/** DSH 配置读取 */
export {
  getProviderConfig,
  getDefaultModelConfig,
  getApiKey,
  getBaseURL,
  getDshPort,
  getDshToken,
  parseSettings,
  clearConfigCache,
} from "./dsh-config.js";
export type { ProviderConfig, ModelSpec, DefaultModelConfig } from "./dsh-config.js";

/** 交付物导出（Markdown） */
export { exportDeliverables, exportFileName } from "./md-export.js";

/** 文件存储适配器 — TODO M1 实现 */
export {};