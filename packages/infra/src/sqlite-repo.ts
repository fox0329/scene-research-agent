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
  Conversation,
  Message,
  Scenario,
  StageData,
  QualityGate,
  StageId,
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

// ─── 消息仓库（append-only） ────────────────────────────────

/** 消息创建输入：id / created_at 由仓储生成 */
export type CreateMessageInput = Omit<Message, "id" | "created_at">;

/**
 * 消息仓库：消息只插入与删除，不提供 update（append-only 语义）。
 */
export interface MessageRepo {
  list(filters?: ListFilters): Message[];
  /** 按会话列出消息（created_at 升序，id 作并列兜底） */
  listByConversation(conversationId: string): Message[];
  insert(row: CreateMessageInput): Message;
  deleteById(id: string): boolean;
  /** 删除某会话全部消息，返回删除条数 */
  deleteByConversation(conversationId: string): number;
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

/** 组装 SELECT 语句与绑定参数（list 共用） */
function buildListSql(
  tableName: string,
  filters?: ListFilters,
): { sql: string; params: unknown[] } {
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

  return { sql, params };
}

function createRepo<T extends BaseRow>(
  db: Database.Database,
  tableName: string,
): Repo<T> {
  const list = (filters?: ListFilters): T[] => {
    const { sql, params } = buildListSql(tableName, filters);
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

// ─── 消息仓库工厂 ──────────────────────────────────────────

function createMessageRepo(db: Database.Database): MessageRepo {
  const list = (filters?: ListFilters): Message[] => {
    const { sql, params } = buildListSql("message", filters);
    return db.prepare(sql).all(...params) as Message[];
  };

  const listByConversation = (conversationId: string): Message[] =>
    list({
      where: "conversation_id = ?",
      params: [conversationId],
      orderBy: "created_at ASC, id ASC",
    });

  const insert = (row: CreateMessageInput): Message => {
    const fullRow = { ...row, id: uuid(), created_at: now() } as Message;
    // 可选字段（stage / table_ref）未传时不绑定，避免 undefined 绑定失败
    const entries = Object.entries(fullRow).filter(([, v]) => v !== undefined);
    const columns = entries.map(([k]) => k);
    const values = entries.map(([, v]) => v);

    db.prepare(
      `INSERT INTO message (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...values);

    return fullRow;
  };

  const deleteById = (id: string): boolean => {
    const result = db.prepare(`DELETE FROM message WHERE id = ?`).run(id);
    return result.changes > 0;
  };

  const deleteByConversation = (conversationId: string): number => {
    const result = db
      .prepare(`DELETE FROM message WHERE conversation_id = ?`)
      .run(conversationId);
    return result.changes;
  };

  return { list, listByConversation, insert, deleteById, deleteByConversation };
}

// ─── 质量关仓库 ────────────────────────────────────────────

/** 质量关创建输入（id + checked_at 由仓储生成） */
export type CreateQualityGateInput = Omit<QualityGate, "id" | "checked_at">;

/** 质量关仓库：JSON 序列化 evidence_refs，自动生成 id/checked_at */
export interface QualityGateRepo {
  list(filters?: ListFilters): QualityGate[];
  insert(row: CreateQualityGateInput): QualityGate;
  /** 按场景+阶段列出质量关记录 */
  listByScenarioStage(scenarioId: string, stage: StageId): QualityGate[];
  /** 删除某场景某阶段全部质量关记录（重算覆盖，T4.2），返回删除条数 */
  deleteByScenarioStage(scenarioId: string, stage: StageId): number;
}

function createQualityGateRepo(db: Database.Database): QualityGateRepo {
  const list = (filters?: ListFilters): QualityGate[] => {
    const { sql, params } = buildListSql("quality_gate", filters);
    return (db.prepare(sql).all(...params) as QualityGate[]).map(deserializeQualityGate);
  };

  const listByScenarioStage = (scenarioId: string, stage: StageId): QualityGate[] =>
    list({
      where: "scenario_id = ? AND stage = ?",
      params: [scenarioId, stage],
      orderBy: "item_no ASC",
    });

  const insert = (row: CreateQualityGateInput): QualityGate => {
    const fullRow: QualityGate = {
      ...row,
      id: uuid(),
      checked_at: now(),
    };
    db.prepare(
      `INSERT INTO quality_gate (id, scenario_id, stage, item_no, title, result, detail, evidence_refs, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      fullRow.id,
      fullRow.scenario_id,
      fullRow.stage,
      fullRow.item_no,
      fullRow.title,
      fullRow.result,
      fullRow.detail,
      JSON.stringify(fullRow.evidence_refs),
      fullRow.checked_at,
    );
    return fullRow;
  };

  const deleteByScenarioStage = (scenarioId: string, stage: StageId): number => {
    const result = db
      .prepare(`DELETE FROM quality_gate WHERE scenario_id = ? AND stage = ?`)
      .run(scenarioId, stage);
    return result.changes;
  };

  return { list, insert, listByScenarioStage, deleteByScenarioStage };
}

function deserializeQualityGate(row: QualityGate): QualityGate {
  const evidenceRefs = row.evidence_refs as unknown;
  if (typeof evidenceRefs === "string") {
    return { ...row, evidence_refs: JSON.parse(evidenceRefs) as Record<string, unknown> };
  }
  return row;
}

// ─── 阶段数据仓库 ──────────────────────────────────────────

/** 阶段数据创建输入（id/created_at/updated_at 由仓储生成） */
export type CreateStageDataInput = Omit<StageData, "id" | "created_at" | "updated_at">;

/** 阶段数据仓库：JSON 序列化 row，is_stale 布尔↔整数转换 */
export interface StageDataRepo {
  list(filters?: ListFilters): StageData[];
  insert(row: CreateStageDataInput): StageData;
  /** 按场景+阶段列出阶段数据 */
  listByScenarioStage(scenarioId: string, stage: StageId): StageData[];
  /** 批量设置某场景若干阶段的失效标记（回退清理 T4.2 / 资料失效 F3），返回更新条数 */
  markStale(scenarioId: string, stages: StageId[], isStale: boolean): number;
  /** 删除某场景某阶段全部数据行（重算覆盖，T4.2），返回删除条数 */
  deleteByScenarioStage(scenarioId: string, stage: StageId): number;
}

function createStageDataRepo(db: Database.Database): StageDataRepo {
  const list = (filters?: ListFilters): StageData[] => {
    const { sql, params } = buildListSql("stage_data", filters);
    return (db.prepare(sql).all(...params) as StageData[]).map(deserializeStageData);
  };

  const listByScenarioStage = (scenarioId: string, stage: StageId): StageData[] =>
    list({
      where: "scenario_id = ? AND stage = ?",
      params: [scenarioId, stage],
    });

  const insert = (row: CreateStageDataInput): StageData => {
    const timestamp = now();
    const fullRow: StageData = {
      ...row,
      id: uuid(),
      created_at: timestamp,
      updated_at: timestamp,
    };
    db.prepare(
      `INSERT INTO stage_data (id, scenario_id, stage, table_code, row, is_stale, source_type, source, source_authority, evidence_level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      fullRow.id,
      fullRow.scenario_id,
      fullRow.stage,
      fullRow.table_code,
      JSON.stringify(fullRow.row),
      fullRow.is_stale ? 1 : 0,
      fullRow.source_type ?? null,
      fullRow.source ?? null,
      fullRow.source_authority ?? null,
      fullRow.evidence_level ?? null,
      fullRow.created_at,
      fullRow.updated_at,
    );
    return fullRow;
  };

  const markStale = (scenarioId: string, stages: StageId[], isStale: boolean): number => {
    if (stages.length === 0) return 0;
    const placeholders = stages.map(() => "?").join(", ");
    const result = db
      .prepare(
        `UPDATE stage_data SET is_stale = ?, updated_at = ?
         WHERE scenario_id = ? AND stage IN (${placeholders})`,
      )
      .run(isStale ? 1 : 0, now(), scenarioId, ...stages);
    return result.changes;
  };

  const deleteByScenarioStage = (scenarioId: string, stage: StageId): number => {
    const result = db
      .prepare(`DELETE FROM stage_data WHERE scenario_id = ? AND stage = ?`)
      .run(scenarioId, stage);
    return result.changes;
  };

  return { list, insert, listByScenarioStage, markStale, deleteByScenarioStage };
}

function deserializeStageData(row: StageData): StageData {
  const raw = row as unknown as Record<string, unknown>;
  let out: StageData = row;
  const rowField = raw["row"];
  if (typeof rowField === "string") {
    out = { ...out, row: JSON.parse(rowField) as Record<string, unknown> };
  }
  const stale = raw["is_stale"];
  if (typeof stale === "number") {
    out = { ...out, is_stale: stale === 1 };
  }
  return out;
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
  conversationRepo: Repo<Conversation>;
  messageRepo: MessageRepo;
  scenarioRepo: Repo<Scenario>;
  stageDataRepo: StageDataRepo;
  qualityGateRepo: QualityGateRepo;
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
    conversationRepo: createRepo<Conversation>(db, "conversation"),
    messageRepo: createMessageRepo(db),
    scenarioRepo: createRepo<Scenario>(db, "scenario"),
    stageDataRepo: createStageDataRepo(db),
    qualityGateRepo: createQualityGateRepo(db),
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