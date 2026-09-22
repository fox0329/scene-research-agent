/**
 * @scene/infra — SQLite 仓储层
 *
 * 提供 better-sqlite3 封装：迁移、CRUD 仓库、FTS5 来源搜索。
 * 所有表 schema 由 001_init.sql 定义，类型由 @scene/contract 提供。
 */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type {
  ProductLine,
  Product,
  SpecParam,
  Capability,
  Boundary,
  Limitation,
  CostRate,
  OptionalMaterial,
} from "@scene/contract";

// ─── 通用类型 ──────────────────────────────────────────────

/** 带时间戳的基础行 */
interface BaseRow {
  id: string;
  created_at: string;
  updated_at: string;
}

/** 创建行：省略 id/时间戳，由仓储自动生成 */
type CreateInput<T extends BaseRow> = Omit<T, "id" | "created_at" | "updated_at">;

/** 更新补丁：所有字段可选，排除 id */
type UpdatePatch<T extends BaseRow> = Partial<Omit<T, "id" | "created_at" | "updated_at">>;

/** 通用列表过滤器 */
export interface ListFilters {
  /** WHERE 子句（不含 WHERE），如 "product_line_id = ?" */
  where?: string;
  /** 绑定参数 */
  params?: unknown[];
  /** 排序（不含 ORDER BY），如 "created_at DESC" */
  orderBy?: string;
  /** 限制条数 */
  limit?: number;
  /** 偏移 */
  offset?: number;
}

/** 通用仓库接口 */
export interface Repo<T extends BaseRow> {
  list(filters?: ListFilters): T[];
  getById(id: string): T | undefined;
  insert(row: CreateInput<T>): T;
  update(id: string, patch: UpdatePatch<T>): T | undefined;
  deleteById(id: string): boolean;
}

/** FTS5 搜索结果行 */
export interface SourceSearchResult {
  source: string | null;
  content: string;
  table_code: string;
  rank: number;
}

// ─── 工具函数 ──────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function uuid(): string {
  return randomUUID();
}

/** 运行迁移 SQL（支持多语句） */
function runMigrations(db: Database.Database): void {
  // better-sqlite3 的 ESM 导入在 Node 中需要特殊处理 __dirname
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const sqlPath = resolve(__dirname, "sql", "001_init.sql");
  const sql = readFileSync(sqlPath, "utf-8");
  db.exec(sql);
}

// ─── 通用仓库工厂 ──────────────────────────────────────────

function createRepo<T extends BaseRow>(
  db: Database.Database,
  tableName: string,
): Repo<T> {
  const list = (filters?: ListFilters): T[] => {
    let sql = `SELECT * FROM ${tableName}`;
    const params: unknown[] = [];

    if (filters?.where) {
      sql += ` WHERE ${filters.where}`;
      params.push(...(filters.params ?? []));
    }
    if (filters?.orderBy) {
      sql += ` ORDER BY ${filters.orderBy}`;
    }
    if (filters?.limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(filters.limit);
    }
    if (filters?.offset !== undefined) {
      sql += ` OFFSET ?`;
      params.push(filters.offset);
    }

    return db.prepare(sql).all(...params) as T[];
  };

  const getById = (id: string): T | undefined => {
    return db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(id) as T | undefined;
  };

  const insert = (row: CreateInput<T>): T => {
    const id = uuid();
    const timestamp = now();
    const fullRow = { ...row, id, created_at: timestamp, updated_at: timestamp } as T;

    const columns = Object.keys(fullRow);
    const placeholders = columns.map(() => "?").join(", ");
    const values = Object.values(fullRow);

    db.prepare(
      `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders})`,
    ).run(...values);

    return fullRow;
  };

  const update = (id: string, patch: UpdatePatch<T>): T | undefined => {
    const existing = getById(id);
    if (!existing) return undefined;

    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return existing;

    const timestamp = now();
    const setClauses = entries.map(([k]) => `${k} = ?`).join(", ");
    const values = entries.map(([, v]) => v);
    values.push(timestamp, id);

    db.prepare(
      `UPDATE ${tableName} SET ${setClauses}, updated_at = ? WHERE id = ?`,
    ).run(...values);

    return getById(id);
  };

  const deleteById = (id: string): boolean => {
    const result = db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(id);
    return result.changes > 0;
  };

  return { list, getById, insert, update, deleteById };
}

// ─── createDb ──────────────────────────────────────────────

export interface DbInstance {
  db: Database.Database;
  productLineRepo: Repo<ProductLine>;
  productRepo: Repo<Product>;
  specParamRepo: Repo<SpecParam>;
  capabilityRepo: Repo<Capability>;
  boundaryRepo: Repo<Boundary>;
  limitationRepo: Repo<Limitation>;
  costRateRepo: Repo<CostRate>;
  optionalMaterialRepo: Repo<OptionalMaterial>;
}

/**
 * 创建或打开 SQLite 数据库，运行迁移，返回 db 实例和 8 个资料库 repo。
 *
 * @param dbPath 数据库文件路径，默认读 DB_PATH 环境变量或 `data/scene-master.db`
 */
export function createDb(dbPath?: string): DbInstance {
  const resolved = dbPath ?? process.env.DB_PATH ?? "data/scene-master.db";
  const db = new Database(resolved);

  // 外键约束
  db.pragma("foreign_keys = ON");

  // 运行迁移
  runMigrations(db);

  return {
    db,
    productLineRepo: createRepo<ProductLine>(db, "product_line"),
    productRepo: createRepo<Product>(db, "product"),
    specParamRepo: createRepo<SpecParam>(db, "spec_param"),
    capabilityRepo: createRepo<Capability>(db, "capability"),
    boundaryRepo: createRepo<Boundary>(db, "boundary"),
    limitationRepo: createRepo<Limitation>(db, "limitation"),
    costRateRepo: createRepo<CostRate>(db, "cost_rate"),
    optionalMaterialRepo: createRepo<OptionalMaterial>(db, "optional_material"),
  };
}

// ─── FTS5 来源搜索 ─────────────────────────────────────────

/**
 * 全文搜索 source_fts 虚表，用于来源抽查（G-R3）。
 *
 * @param query FTS5 查询字符串（支持 NEAR、AND、OR 等）
 * @param limit 最大返回条数，默认 20
 */
export function sourceSearch(
  db: Database.Database,
  query: string,
  limit = 20,
): SourceSearchResult[] {
  const rows = db
    .prepare(
      `SELECT source, content, table_code, rank
       FROM source_fts
       WHERE source_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(query, limit) as SourceSearchResult[];

  return rows;
}