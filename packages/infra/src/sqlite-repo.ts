/**
 * @scene/infra — SQLite 仓储层
 *
 * 提供 better-sqlite3 封装：迁移、CRUD 仓库、FTS5 来源搜索。
 * 所有表 schema 由 001_init.sql 定义，类型由 @scene/contract 提供。
 */

import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
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
  ScenarioBrief,
  StageSummaryRow,
  ScenarioMaterial,
  ScenarioLinkedLine,
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
  // 存量库增量升级：001 的 CREATE IF NOT EXISTS 不会给已存在的表补列，幂等 ALTER 兜底
  const cols = db.pragma("table_info(product_line)") as { name: string }[];
  if (!cols.some((c) => c.name === "scenario_id")) {
    db.exec("ALTER TABLE product_line ADD COLUMN scenario_id TEXT");
  }
  const scCols = db.pragma("table_info(scenario)") as { name: string }[];
  if (!scCols.some((c) => c.name === "description")) {
    db.exec("ALTER TABLE scenario ADD COLUMN description TEXT");
  }
  // v2.9：通用库引用改为「默认引用 + 显式取消」，存量行默认 excluded = 0（= 引用）
  const linkCols = db.pragma("table_info(scenario_linked_line)") as { name: string }[];
  if (!linkCols.some((c) => c.name === "excluded")) {
    db.exec("ALTER TABLE scenario_linked_line ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0");
  }
}

// ─── 场景流程步仓库（v1.5 逐页推进） ────────────────────────

/** 场景流程步完成记录仓储 */
export interface ScenarioStepRepo {
  /** 已完成的步骤号（升序） */
  completedSteps(scenarioId: string): number[];
  /** 标记某步完成（重复标记幂等） */
  complete(scenarioId: string, step: number): void;
  /** 清除第 n 步及其之后的完成标记（回到某步重跑），返回清除条数 */
  clearFrom(scenarioId: string, step: number): number;
  /** 删除场景时清理 */
  deleteByScenario(scenarioId: string): number;
}

function createScenarioStepRepo(db: Database.Database): ScenarioStepRepo {
  const completedSteps = (scenarioId: string): number[] =>
    (
      db
        .prepare("SELECT step FROM scenario_step WHERE scenario_id = ? ORDER BY step ASC")
        .all(scenarioId) as { step: number }[]
    ).map((r) => r.step);

  const complete = (scenarioId: string, step: number): void => {
    db.prepare(
      "INSERT OR REPLACE INTO scenario_step (scenario_id, step, completed_at) VALUES (?, ?, ?)",
    ).run(scenarioId, step, now());
  };

  const clearFrom = (scenarioId: string, step: number): number =>
    db
      .prepare("DELETE FROM scenario_step WHERE scenario_id = ? AND step >= ?")
      .run(scenarioId, step).changes;

  const deleteByScenario = (scenarioId: string): number =>
    db.prepare("DELETE FROM scenario_step WHERE scenario_id = ?").run(scenarioId).changes;

  return { completedSteps, complete, clearFrom, deleteByScenario };
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

// ─── 场景诉求仓库（主键为 scenario_id，故不用通用 createRepo） ──

/** 场景诉求仓储：一场景一行 */
export interface ScenarioBriefRepo {
  get(scenarioId: string): ScenarioBrief | undefined;
  /** 存在则更新、不存在则插入（返回最新行） */
  upsert(scenarioId: string, patch: Omit<ScenarioBrief, "scenario_id" | "created_at" | "updated_at">): ScenarioBrief;
  remove(scenarioId: string): boolean;
}

function createScenarioBriefRepo(db: Database.Database): ScenarioBriefRepo {
  const get = (scenarioId: string): ScenarioBrief | undefined =>
    db.prepare("SELECT * FROM scenario_brief WHERE scenario_id = ?").get(scenarioId) as
      | ScenarioBrief
      | undefined;

  const upsert = (
    scenarioId: string,
    patch: Omit<ScenarioBrief, "scenario_id" | "created_at" | "updated_at">,
  ): ScenarioBrief => {
    const existing = get(scenarioId);
    const timestamp = now();
    if (!existing) {
      const row: ScenarioBrief = {
        ...patch,
        scenario_id: scenarioId,
        created_at: timestamp,
        updated_at: timestamp,
      };
      const columns = Object.keys(row);
      db.prepare(
        `INSERT INTO scenario_brief (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      ).run(...Object.values(row));
      return row;
    }
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length > 0) {
      const sets = entries.map(([k]) => `${k} = ?`).join(", ");
      db.prepare(`UPDATE scenario_brief SET ${sets}, updated_at = ? WHERE scenario_id = ?`).run(
        ...entries.map(([, v]) => v),
        timestamp,
        scenarioId,
      );
    }
    return get(scenarioId)!;
  };

  const remove = (scenarioId: string): boolean =>
    db.prepare("DELETE FROM scenario_brief WHERE scenario_id = ?").run(scenarioId).changes > 0;

  return { get, upsert, remove };
}

// ─── 阶段总结文档仓库（复合主键 scenario_id + stage） ──────────

/** 阶段总结文档仓储 */
export interface StageSummaryRepo {
  get(scenarioId: string, stage: StageId): StageSummaryRow | undefined;
  upsert(scenarioId: string, stage: StageId, content: string): StageSummaryRow;
  listByScenario(scenarioId: string): StageSummaryRow[];
  remove(scenarioId: string, stage: StageId): boolean;
}

function createStageSummaryRepo(db: Database.Database): StageSummaryRepo {
  const get = (scenarioId: string, stage: StageId): StageSummaryRow | undefined =>
    db
      .prepare("SELECT * FROM stage_summary WHERE scenario_id = ? AND stage = ?")
      .get(scenarioId, stage) as StageSummaryRow | undefined;

  const upsert = (scenarioId: string, stage: StageId, content: string): StageSummaryRow => {
    const timestamp = now();
    const existing = get(scenarioId, stage);
    if (existing) {
      db.prepare("UPDATE stage_summary SET content = ?, updated_at = ? WHERE scenario_id = ? AND stage = ?").run(
        content,
        timestamp,
        scenarioId,
        stage,
      );
    } else {
      db.prepare(
        "INSERT INTO stage_summary (scenario_id, stage, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(scenarioId, stage, content, timestamp, timestamp);
    }
    return get(scenarioId, stage)!;
  };

  const listByScenario = (scenarioId: string): StageSummaryRow[] =>
    db
      .prepare("SELECT * FROM stage_summary WHERE scenario_id = ? ORDER BY stage ASC")
      .all(scenarioId) as StageSummaryRow[];

  const remove = (scenarioId: string, stage: StageId): boolean =>
    db
      .prepare("DELETE FROM stage_summary WHERE scenario_id = ? AND stage = ?")
      .run(scenarioId, stage).changes > 0;

  return { get, upsert, listByScenario, remove };
}

// ─── 消息仓库工厂 ──────────────────────────────────────────

function createMessageRepo(db: Database.Database): MessageRepo {
  const list = (filters?: ListFilters): Message[] => {
    const { sql, params } = buildListSql("message", filters);
    return db.prepare(sql).all(...params) as Message[];
  };

  const listByConversation = (conversationId: string): Message[] =>
    // rowid 随插入递增：同毫秒消息保持因果序（uuid id 无排序意义）
    list({
      where: "conversation_id = ?",
      params: [conversationId],
      orderBy: "created_at ASC, rowid ASC",
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
  /**
   * 删除某场景某阶段**某一张表**的数据行（按表并发生成的部分成功用）
   *
   * 为什么需要：按表并发后可能"这张表成了、那张表失败"。失败表必须保留原有内容
   * （老口径：模型没产出就不许清库），所以不能再整阶段删——只能逐表删成功的那些。
   */
  deleteByScenarioStageTable(scenarioId: string, stage: StageId, tableCode: string): number;
  getById(id: string): StageData | undefined;
  /** 单元格编辑落库（M5 联真）：row 整体覆盖写回 JSON，可同步 source_type；返回更新后的行 */
  /**
   * 局部更新；`source_type: null` = **显式清空**来源（传 undefined 表示"不改"）
   *
   * 为什么需要 null：行被清空内容后（如"重新整理定义"清掉旧推断），来源标记必须一起清，
   * 否则会留下"空内容 + AI推断"这种自相矛盾的行。
   */
  /**
   * v1.28 起支持改 `source`：生成后自检发现"出处查不到/该页没有这句话"时，
   * 必须能把站不住的出处改掉或清掉（`source: null` = 显式清空），否则自检只能报告不能修。
   */
  update(
    id: string,
    patch: { row?: Record<string, unknown>; source_type?: string | null; source?: string | null },
  ): StageData | undefined;
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
  const deleteByScenarioStageTable = (
    scenarioId: string,
    stage: StageId,
    tableCode: string,
  ): number => {
    const result = db
      .prepare(`DELETE FROM stage_data WHERE scenario_id = ? AND stage = ? AND table_code = ?`)
      .run(scenarioId, stage, tableCode);
    return result.changes;
  };

  const getById = (id: string): StageData | undefined => {
    const raw = db.prepare(`SELECT * FROM stage_data WHERE id = ?`).get(id);
    return raw ? deserializeStageData(raw as StageData) : undefined;
  };

  const update = (
    id: string,
    patch: { row?: Record<string, unknown>; source_type?: string | null; source?: string | null },
  ): StageData | undefined => {
    const existing = getById(id);
    if (!existing) return undefined;
    const entries: [string, unknown][] = [];
    if (patch.row !== undefined) entries.push(["row", JSON.stringify(patch.row)]);
    if (patch.source_type !== undefined) entries.push(["source_type", patch.source_type]);
    if (patch.source !== undefined) entries.push(["source", patch.source]);
    if (entries.length === 0) return existing;
    const setClauses = entries.map(([k]) => `${k} = ?`).join(", ");
    db.prepare(`UPDATE stage_data SET ${setClauses}, updated_at = ? WHERE id = ?`)
      .run(...entries.map(([, v]) => v), now(), id);
    return getById(id);
  };

  return {
    list,
    insert,
    listByScenarioStage,
    markStale,
    deleteByScenarioStage,
    deleteByScenarioStageTable,
    getById,
    update,
  };
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

// ─── 知识库只读仓库（M5 联真） ──────────────────────────────

// ─── 可选材料仓库（payload JSON 往返） ─────────────────────

/**
 * optional_material 专用：契约类型 payload 为对象，列为 JSON 文本。
 * 通用仓库直接绑定对象会让 better-sqlite3 抛绑定错误，这里统一序列化/反序列化。
 */
function createOptionalMaterialRepo(db: Database.Database): Repo<OptionalMaterial> {
  const base = createRepo<OptionalMaterial>(db, "optional_material");

  const parseRow = (row: OptionalMaterial): OptionalMaterial =>
    typeof row.payload === "string"
      ? { ...row, payload: JSON.parse(row.payload) as Record<string, unknown> }
      : row;

  const toJsonPayload = (row: CreateInput<OptionalMaterial>): CreateInput<OptionalMaterial> => ({
    ...row,
    // 列存 JSON 文本；绑定前序列化（类型上仍是契约的 Record）
    payload: (typeof row.payload === "string"
      ? row.payload
      : JSON.stringify(row.payload ?? {})) as unknown as Record<string, unknown>,
  });

  return {
    list: (filters) => base.list(filters).map(parseRow),
    getById: (id) => {
      const row = base.getById(id);
      return row ? parseRow(row) : undefined;
    },
    insert: (row) => {
      const created = base.insert(toJsonPayload(row));
      return parseRow(base.getById(created.id) ?? created);
    },
    update: (id, patch) => {
      const next = { ...patch } as Record<string, unknown>;
      if (next["payload"] !== undefined && typeof next["payload"] !== "string") {
        next["payload"] = JSON.stringify(next["payload"]);
      }
      const updated = base.update(id, next as never);
      return updated ? parseRow(updated) : undefined;
    },
    deleteById: (id) => base.deleteById(id),
  };
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
  scenarioBriefRepo: ScenarioBriefRepo;
  stageSummaryRepo: StageSummaryRepo;
  scenarioStepRepo: ScenarioStepRepo;
  stageDataRepo: StageDataRepo;
  qualityGateRepo: QualityGateRepo;
  scenarioMaterialRepo: Repo<ScenarioMaterial>;
  scenarioLinkedLineRepo: Repo<ScenarioLinkedLine>;
}

/**
 * 创建或打开 SQLite 数据库，运行迁移，返回 db 实例和 8 个资料库 repo。
 *
 * @param dbPath 数据库文件路径，默认读 DB_PATH 环境变量或 `data/scene-master.db`
 */
export function createDb(dbPath?: string): DbInstance {
  const resolved = dbPath ?? process.env.DB_PATH ?? "data/scene-master.db";
  // 一条命令冷启动（npm start）时默认目录可能不存在：落库前自动建父目录；:memory: 跳过
  if (resolved !== ":memory:") mkdirSync(dirname(resolve(resolved)), { recursive: true });
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
    optionalMaterialRepo: createOptionalMaterialRepo(db),
    conversationRepo: createRepo<Conversation>(db, "conversation"),
    messageRepo: createMessageRepo(db),
    scenarioRepo: createRepo<Scenario>(db, "scenario"),
    scenarioBriefRepo: createScenarioBriefRepo(db),
    stageSummaryRepo: createStageSummaryRepo(db),
    scenarioStepRepo: createScenarioStepRepo(db),
    stageDataRepo: createStageDataRepo(db),
    qualityGateRepo: createQualityGateRepo(db),
    scenarioMaterialRepo: createRepo<ScenarioMaterial>(db, "scenario_material"),
    scenarioLinkedLineRepo: createRepo<ScenarioLinkedLine>(db, "scenario_linked_line"),
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