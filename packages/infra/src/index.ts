/**
 * @scene/infra — 基础设施层
 *
 * 提供 DB（better-sqlite3）、文件存储、DSH 客户端等基础设施实现。
 * 依赖 contract + domain；被 server 引用。
 */

export { createDb, sourceSearch } from "./sqlite-repo.js";
export type { DbInstance, Repo, ListFilters, SourceSearchResult } from "./sqlite-repo.js";

/** DSH 客户端适配器 — TODO M1 实现 */
export {};

/** 文件存储适配器 — TODO M1 实现 */
export {};