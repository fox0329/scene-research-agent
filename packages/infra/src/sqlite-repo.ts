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
  PriceQuote,
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
  LibraryVerification,
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

// ─── O3 价格 → M6 报价（一次性迁移） ────────────────────────

/** 迁移一条 O3 价格后要写进 price_quote 的字段（纯映射结果） */
export interface O3PriceQuoteMapping {
  model: string;
  config: string;
  unit_price: string;
  price_scope: PriceQuote["price_scope"];
  valid_until: string;
  source: string;
}

/**
 * 价格口径关键词 → 契约枚举
 *
 * 顺序有讲究：先长后短（「含三年维保」不能被「含安装」抢走）；「年费」放在「含安装」之后，
 * 因为「含安装，年费另计」这种写法主口径是含安装。一个都映射不上时按「纯设备」，
 * 并把渠道原文留在 config 里——宁可口径保守，也不能把原文丢掉。
 */
const O3_SCOPE_RULES: { keyword: string; scope: PriceQuote["price_scope"] }[] = [
  { keyword: "含三年维保", scope: "含三年维保" },
  { keyword: "含安装", scope: "含安装" },
  { keyword: "年费", scope: "年费" },
  { keyword: "纯设备", scope: "纯设备" },
];

/** 型号归一：只做大小写与首尾空白（迁移不猜同义词） */
function normalizeQuoteModel(model: string): string {
  return model.trim().toLowerCase();
}

/**
 * O3 价格 payload → M6 报价映射（纯函数，迁移与单测共用）
 *
 * 映射规则（用户定调 2026-10-21）：
 *   model → model；config 缺失填「未注明」；price → unit_price；
 *   channel → price_scope（关键词映射，映射不上按「纯设备」并保留渠道原文到 config）；
 *   date → valid_until（原文照抄，如 `2025-11`）；source 沿用 O3 行原文。
 *
 * 缺型号或单价的 payload 返回 null（没有型号挂不到 M1，没有金额就不是报价事实）。
 */
export function mapO3PricePayload(
  payload: Record<string, unknown>,
  source: unknown,
): O3PriceQuoteMapping | null {
  const model = String(payload["model"] ?? "").trim();
  const unitPrice = String(payload["price"] ?? "").trim();
  if (!model || !unitPrice) return null;

  const channel = String(payload["channel"] ?? "").trim();
  const matched = O3_SCOPE_RULES.find((rule) => channel.includes(rule.keyword));
  const baseConfig = String(payload["config"] ?? "").trim() || "未注明";
  const config =
    channel && !matched ? `${baseConfig}；渠道原文：${channel}` : baseConfig;
  const validUntil = String(payload["date"] ?? payload["valid_until"] ?? "").trim();
  const sourceText = String(source ?? payload["source"] ?? "").trim();

  return {
    model,
    config,
    unit_price: unitPrice,
    price_scope: matched?.scope ?? "纯设备",
    valid_until: validUntil,
    source: sourceText,
  };
}

/**
 * 把存量 `optional_material.category='O3价格'` 迁到 `price_quote`（M6）
 *
 * 幂等：迁成功的 O3 行**当场删除**，第二次打开库没有可迁行；迁不动的行（型号不在 M1、
 * 缺金额/坏 JSON）原样保留，不编产品、不编价格。
 *
 * 返回迁移/跳过条数，供调用方记日志或测试核对。
 */
function migrateO3PricesToQuotes(db: Database.Database): {
  migrated: number;
  skipped: number;
} {
  let rows: {
    id: string;
    product_line_id: string;
    payload: string;
    source: string | null;
    source_type: string | null;
    source_authority: string | null;
    evidence_level: string | null;
  }[];
  try {
    rows = db
      .prepare(
        `SELECT id, product_line_id, payload, source, source_type, source_authority, evidence_level
           FROM optional_material WHERE category = 'O3价格'`,
      )
      .all() as typeof rows;
  } catch {
    // 极老库没有这张表：无需迁移，不阻断启动
    return { migrated: 0, skipped: 0 };
  }
  if (rows.length === 0) return { migrated: 0, skipped: 0 };

  const productsOfLine = db.prepare(
    "SELECT id, model FROM product WHERE product_line_id = ?",
  );
  const existingQuote = db.prepare(
    `SELECT id FROM price_quote
      WHERE product_id = ? AND model = ? AND unit_price = ? AND price_scope = ?
      LIMIT 1`,
  );
  const insertQuote = db.prepare(
    `INSERT INTO price_quote
       (id, product_id, model, config, unit_price, price_scope, valid_until, source,
        source_type, source_authority, evidence_level, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteO3 = db.prepare(
    "DELETE FROM optional_material WHERE id = ? AND category = 'O3价格'",
  );

  const run = db.transaction(() => {
    let migrated = 0;
    let skipped = 0;
    for (const row of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload ?? "{}");
      } catch {
        skipped += 1;
        continue;
      }
      if (typeof payload !== "object" || payload === null) {
        skipped += 1;
        continue;
      }
      const mapped = mapO3PricePayload(payload as Record<string, unknown>, row.source);
      if (!mapped) {
        skipped += 1;
        continue;
      }
      const product = (
        productsOfLine.all(row.product_line_id) as { id: string; model: string }[]
      ).find((p) => normalizeQuoteModel(p.model) === normalizeQuoteModel(mapped.model));
      // 型号不在 M1：跳过、不编产品，O3 行保留（等用户补 M1 后再迁）
      if (!product) {
        skipped += 1;
        continue;
      }
      const duplicate = existingQuote.get(
        product.id,
        mapped.model,
        mapped.unit_price,
        mapped.price_scope,
      );
      if (!duplicate) {
        const stamp = now();
        insertQuote.run(
          uuid(),
          product.id,
          mapped.model,
          mapped.config,
          mapped.unit_price,
          mapped.price_scope,
          mapped.valid_until,
          mapped.source,
          row.source_type,
          row.source_authority,
          row.evidence_level,
          stamp,
          stamp,
        );
      }
      // 已有等价报价也算"已归位"：O3 这份重复明细必须删掉，否则还是两个家
      deleteO3.run(row.id);
      migrated += 1;
    }
    return { migrated, skipped };
  });
  return run();
}

/** 运行迁移 SQL（支持多语句） */
function runMigrations(db: Database.Database): {
  /** O3→M6 价格迁移结果；没有 O3 行时缺省 */
  o3PriceMigration?: { migrated: number; skipped: number };
} {
  // better-sqlite3 的 ESM 导入在 Node 中需要特殊处理 __dirname
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const sqlPath = resolve(__dirname, "sql", "001_init.sql");
  const sql = readFileSync(sqlPath, "utf-8");
  db.exec(sql);
  // 存量库增量升级：001 的 CREATE IF NOT EXISTS 不会给已存在的表补列，幂等 ALTER 兜底
  /**
   * 历史「模型知识当来源」一次性回填（变更表 #260）
   *
   * 2026-10-21 用户定调：来源必须真实、客观、最新，模型知识不能算来源。
   * 新生成的行已由 postcheck 确定性改写；这里把**存量**行一并改成
   * 「未知（未检索到公开来源）」，避免老结论继续挂着"行业通例"冒充证据。
   * 幂等：改写后不再命中正则，重复打开不会二次改动。
   */
  try {
    const MODEL_SOURCE_RE = /行业通例|模型知识|常识|经验判断/u;
    const rows = db
      .prepare("SELECT id, row FROM stage_data")
      .all() as { id: string; row: string }[];
    const update = db.prepare("UPDATE stage_data SET row = ? WHERE id = ?");
    for (const r of rows) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(r.row) as Record<string, unknown>;
      } catch {
        continue;
      }
      const src = String(parsed["source"] ?? "");
      if (!MODEL_SOURCE_RE.test(src)) continue;
      parsed["source"] = "未知（未检索到公开来源）";
      update.run(JSON.stringify(parsed), r.id);
    }
  } catch {
    // 极老库没有 stage_data 或列结构不同：跳过，不影响启动
  }

  const cols = db.pragma("table_info(product_line)") as { name: string }[];
  if (!cols.some((c) => c.name === "scenario_id")) {
    db.exec("ALTER TABLE product_line ADD COLUMN scenario_id TEXT");
  }
  /**
   * 阶段分析不再逐阶段登记会话（变更表 #174）
   *
   * 只补一次列：补列的同时把历史"阶段 N · 分析"标成 `阶段分析`，左侧栏据此隐藏
   * （数据保留，不删）。放在 `if` 里是为了不覆盖用户后来自己改过的值。
   */
  const convCols = db.pragma("table_info(conversation)") as { name: string }[];
  if (!convCols.some((c) => c.name === "kind")) {
    db.exec("ALTER TABLE conversation ADD COLUMN kind TEXT NOT NULL DEFAULT '用户'");
    db.exec("UPDATE conversation SET kind = '阶段分析' WHERE title GLOB '阶段 * · 分析'");
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
  // v3.0（变更表 #160）：场景私有库改为「按需创建 + 可删」，关系只存在 product_line.scenario_id
  // 上，`scenario.product_line_id`（非空外键）退休。SQLite 改不掉 NOT NULL，只能整表重建。
  if (scCols.some((c) => c.name === "product_line_id")) {
    rebuildScenarioWithoutOwnLine(db);
  }
  /**
   * 删除已废弃表的数据（变更表 #226，用户定调「没价值的直接删」）
   *
   * 表2-7「交付与运维现状」与表5-4 是同一批项在「现状/交付」各写一遍，表3-6「替代方案」
   * 与表3-4「竞争对手对照」是同一判断的两面——两张表已从注册表移除，库里残留的行也一并清掉，
   * 否则界面上会出现「表定义里没有、数据里有」的幽灵表。
   *
   * 幂等：DELETE 到空为止，第二次启动是空操作。
   */
  db.exec("DELETE FROM stage_data WHERE table_code IN ('表2-7', '表3-6')");
  /* 表1-3 删除「行业通行处置」列（变更表 #228，用户定调「这列删掉」）：
     列没了还留着 JSON 键，导出与自检都会读到幽灵字段，所以连数据一起清。 */
  db.exec("UPDATE stage_data SET row = json_remove(row, '$.industry_practice') WHERE table_code = '表1-3'");

  /**
   * 每一步的联网调研来源（调研先于分析）
   *
   * 用户质问「调研信息来源为什么一个链接都没有」——根因是分析来源只写「行业通例（模型知识）」，
   * 产品从来没真正跑过一步联网调研。这张表让「每一步分析前先搜一次」有落点：
   * 一行 = 某一步的一条检索结果（或一条检索失败记录）。
   *
   * 放在迁移里而不是 001_init.sql：这是**只加不删**的增量表，
   * `CREATE TABLE IF NOT EXISTS` 对存量库与新库都幂等。`url_key` 用领域层
   * `urlKey()` 归一化（去追踪参数），同一 URL 在同一场景同一步不重复占位。
   */
  db.exec(`CREATE TABLE IF NOT EXISTS research_source (
  id               TEXT PRIMARY KEY,
  scenario_id      TEXT NOT NULL,
  step             INTEGER NOT NULL,
  query            TEXT NOT NULL,
  title            TEXT NOT NULL,
  url              TEXT NOT NULL,
  url_key          TEXT NOT NULL,
  snippet          TEXT NOT NULL DEFAULT '',
  engine           TEXT NOT NULL DEFAULT '',
  fetched_at       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT '有效',
  error            TEXT NOT NULL DEFAULT '',
  publisher        TEXT NOT NULL DEFAULT '',
  domain           TEXT NOT NULL DEFAULT '',
  published_at     TEXT NOT NULL DEFAULT '',
  authority        TEXT NOT NULL DEFAULT '',
  verified         INTEGER NOT NULL DEFAULT 0,
  stale            INTEGER NOT NULL DEFAULT 0,
  UNIQUE(scenario_id, step, url_key)
)`);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_research_source_step ON research_source(scenario_id, step)",
  );
  /**
   * 存量库（0.6.5 起已有该表）补列：先 pragma 判断再 ALTER，重复启动是空操作。
   *
   * 为什么要这些列：只存检索标题/URL 等于"搜了一下"，用户要的是**真来源**——
   * 发布方、发布时间、权威级、是否抓过正文验真、是否过期（>3 年），
   * 右栏与门禁都靠它们判"这条能不能当依据"。
   */
  const researchCols = db.pragma("table_info(research_source)") as { name: string }[];
  const addResearchCol = (name: string, ddl: string): void => {
    if (researchCols.some((c) => c.name === name)) return;
    db.exec(`ALTER TABLE research_source ADD COLUMN ${ddl}`);
  };
  addResearchCol("publisher", "publisher TEXT NOT NULL DEFAULT ''");
  // 域名单独留列：右栏标签与「来源 host 是否在本步调研里」都要用，且不要每次重新解析 URL
  addResearchCol("domain", "domain TEXT NOT NULL DEFAULT ''");
  addResearchCol("published_at", "published_at TEXT NOT NULL DEFAULT ''");
  addResearchCol("authority", "authority TEXT NOT NULL DEFAULT ''");
  addResearchCol("verified", "verified INTEGER NOT NULL DEFAULT 0");
  addResearchCol("stale", "stale INTEGER NOT NULL DEFAULT 0");

  /**
   * 联网核验记录（用户定调 2026-10-21「导入的资料可以通过检索的方式核实或提高等级」）
   *
   * 一行 = 某张表某一行资料的一次核验结论。与资料行**分表存放**：
   * 核验结论（未核实/有冲突）不许覆盖原始证据，只有 T1/T2 独立来源命中才会
   * 把资料行的 `evidence_level` 升为 A。
   *
   * `UNIQUE(table_code, row_id)` 让"重核"是覆盖而不是堆记录（upsert）；
   * `checked_at` 兼作 7 天时效判断依据。放在迁移里而不是 001_init.sql：
   * 增量表，`CREATE TABLE IF NOT EXISTS` 对存量库与新库都幂等。
   */
  db.exec(`CREATE TABLE IF NOT EXISTS library_verification (
  id           TEXT PRIMARY KEY,
  table_code   TEXT NOT NULL,
  row_id       TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('已核实','未核实','有冲突')),
  authority    TEXT NOT NULL DEFAULT '',
  sources_json TEXT NOT NULL DEFAULT '[]',
  key_text     TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  checked_at   TEXT NOT NULL,
  UNIQUE (table_code, row_id)
)`);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_library_verification_status ON library_verification(status, checked_at)",
  );

  /**
   * 价格去重（用户定调 2026-10-21「一个价格事实只能有一个家」）
   *
   * 放在最后：product / price_quote 表与全部补列都已就绪。存量 O3 价格明细一次性归位到
   * M6，迁成功的 O3 行删除；迁移条数经 `createDb` 的返回值带出，便于启动日志/测试核对。
   */
  const o3PriceMigration = migrateO3PricesToQuotes(db);
  return o3PriceMigration.migrated + o3PriceMigration.skipped > 0
    ? { o3PriceMigration }
    : {};
}

/**
 * 整表重建 `scenario`，去掉 `product_line_id` 列（SQLite 不支持 DROP NOT NULL）
 *
 * 按 SQLite 官方推荐的流程：**关外键 → 事务内重建 → 回来再开外键 → 校验**。
 * 为什么必须在这个顺序：外键开着时 DROP/RENAME 会被子表拦下；`PRAGMA foreign_keys`
 * 又不能改在事务里，所以开关必须在事务外。
 * 数据只搬 7 列（其余列与子表**一个字节都不动**）：`product_line.scenario_id` 上原有的
 * "私有库"关系因此天然保留——存量场景的私有库升级后照旧认得出来。
 */
function rebuildScenarioWithoutOwnLine(db: Database.Database): void {
  const fkWasOn = (db.pragma("foreign_keys", { simple: true }) as number) === 1;
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE scenario_rebuild (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL CHECK (status IN ('进行中','已完成','已归档')),
  current_stage    INTEGER NOT NULL CHECK (current_stage BETWEEN 0 AND 8),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
)`);
      db.exec(`INSERT INTO scenario_rebuild
  (id, name, description, status, current_stage, created_at, updated_at)
  SELECT id, name, description, status, current_stage, created_at, updated_at FROM scenario`);
      db.exec("DROP TABLE scenario");
      db.exec("ALTER TABLE scenario_rebuild RENAME TO scenario");
    })();
  } finally {
    if (fkWasOn) db.pragma("foreign_keys = ON");
  }
  // 重建后必须自证没留下悬空外键：有就当场炸，别带着坏库继续跑
  const broken = db.pragma("foreign_key_check") as unknown[];
  if (broken.length > 0) {
    throw new Error(`scenario 表重建后外键校验失败（${broken.length} 处），已停止启动`);
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

// ─── 步骤联网调研来源仓库（调研先于分析） ──────────────────

/** 一条步骤调研来源（一行 = 一条检索结果，或一条「检索失败」记录） */
export interface ResearchSource {
  /** `rs_<hash>`（由场景 + 步 + 归一化 URL 派生，同一条结果反复检索不换 id） */
  id: string;
  scenario_id: string;
  /** 流程步号（1 起） */
  step: number;
  /** 产出这条结果的检索 query；检索失败时写明原因 */
  query: string;
  title: string;
  url: string;
  /** 领域层 `urlKey()` 归一化后的散列（去追踪参数） */
  url_key: string;
  snippet: string;
  /** 引擎种类（deepseek-native / tavily / bing-html / none） */
  engine: string;
  fetched_at: string;
  /** 有效 / 检索失败 */
  status: string;
  /** 失败原因（成功时为空串） */
  error: string;
  /** 抓正文后回读的发布方（web_source.publisher；没抓成功时为空串） */
  publisher?: string;
  /** 注册域（web_source.domain；用于右栏标签与 host 级来源核对） */
  domain?: string;
  /** 页面声明的发布时间（ISO 或可解析串；没有则为空串） */
  published_at?: string;
  /** 权威性 T1–T4（抓正文入库后由领域层判定；未验真时为空串） */
  authority?: string;
  /** 正文抓取成功 = 1（失败仍保留检索命中，但不算"已验真来源"） */
  verified?: number;
  /** 发布时间早于「当前 − 3 年」= 1；没有日期不判过期 */
  stale?: number;
}

/**
 * 步骤调研来源仓储
 *
 * `upsert` 按 `(scenario_id, step, url_key)` 幂等：同一步重跑调研只更新快照，
 * 不累积重复链接。
 */
export interface ResearchRepo {
  /** 按场景 + 步列出（最近抓取的在前，失败的记录排在有效记录之后） */
  listByStep(scenarioId: string, step: number): ResearchSource[];
  upsert(row: ResearchSource): ResearchSource;
  /** 清空某步的调研来源（重跑前清旧结果），返回删除条数 */
  clearStep(scenarioId: string, step: number): number;
}

function createResearchRepo(db: Database.Database): ResearchRepo {
  const listByStep = (scenarioId: string, step: number): ResearchSource[] =>
    db
      .prepare(
        `SELECT * FROM research_source
         WHERE scenario_id = ? AND step = ?
         ORDER BY CASE status WHEN '有效' THEN 0 ELSE 1 END,
                  verified DESC,
                  CASE authority WHEN 'T1' THEN 1 WHEN 'T2' THEN 2 WHEN 'T3' THEN 3
                                 WHEN 'T4' THEN 4 ELSE 5 END,
                  published_at DESC, fetched_at DESC, id ASC`,
      )
      .all(scenarioId, step) as ResearchSource[];

  const upsert = (row: ResearchSource): ResearchSource => {
    db.prepare(
      `INSERT INTO research_source
         (id, scenario_id, step, query, title, url, url_key, snippet, engine, fetched_at, status, error,
          publisher, domain, published_at, authority, verified, stale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scenario_id, step, url_key) DO UPDATE SET
         id = excluded.id,
         query = excluded.query,
         title = excluded.title,
         url = excluded.url,
         snippet = excluded.snippet,
         engine = excluded.engine,
         fetched_at = excluded.fetched_at,
         status = excluded.status,
         error = excluded.error,
         publisher = excluded.publisher,
         domain = excluded.domain,
         published_at = excluded.published_at,
         authority = excluded.authority,
         verified = excluded.verified,
         stale = excluded.stale`,
    ).run(
      row.id,
      row.scenario_id,
      row.step,
      row.query,
      row.title,
      row.url,
      row.url_key,
      row.snippet,
      row.engine,
      row.fetched_at,
      row.status,
      row.error,
      row.publisher ?? "",
      row.domain ?? "",
      row.published_at ?? "",
      row.authority ?? "",
      row.verified ?? 0,
      row.stale ?? 0,
    );
    return db
      .prepare("SELECT * FROM research_source WHERE scenario_id = ? AND step = ? AND url_key = ?")
      .get(row.scenario_id, row.step, row.url_key) as ResearchSource;
  };

  const clearStep = (scenarioId: string, step: number): number =>
    db
      .prepare("DELETE FROM research_source WHERE scenario_id = ? AND step = ?")
      .run(scenarioId, step).changes;

  return { listByStep, upsert, clearStep };
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

// ─── 联网核验记录仓库 ──────────────────────────────────────

/** upsert 输入：id 由仓库生成（已有同键行时保留原 id） */
export type CreateVerificationInput = Omit<LibraryVerification, "id">;

/**
 * 核验记录仓库
 *
 * 与通用 `Repo` 的区别：主键口径是 `(table_code, row_id)` 而不是 `id`——
 * 同一行重核只更新一条记录（upsert），不堆历史，避免"7 天时效"判断被旧记录干扰。
 */
export interface VerificationRepo {
  listAll(): LibraryVerification[];
  getByRow(tableCode: string, rowId: string): LibraryVerification | undefined;
  upsert(row: CreateVerificationInput): LibraryVerification;
  deleteByRow(tableCode: string, rowId: string): boolean;
}

function createVerificationRepo(db: Database.Database): VerificationRepo {
  const getByRow = (tableCode: string, rowId: string): LibraryVerification | undefined =>
    db
      .prepare(
        `SELECT id, table_code, row_id, status, authority, sources_json, key_text, note, checked_at
         FROM library_verification WHERE table_code = ? AND row_id = ?`,
      )
      .get(tableCode, rowId) as LibraryVerification | undefined;

  return {
    listAll: () =>
      db
        .prepare(
          `SELECT id, table_code, row_id, status, authority, sources_json, key_text, note, checked_at
           FROM library_verification ORDER BY checked_at DESC`,
        )
        .all() as LibraryVerification[],
    getByRow,
    upsert: (row) => {
      db.prepare(
        `INSERT INTO library_verification
           (id, table_code, row_id, status, authority, sources_json, key_text, note, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(table_code, row_id) DO UPDATE SET
           status = excluded.status,
           authority = excluded.authority,
           sources_json = excluded.sources_json,
           key_text = excluded.key_text,
           note = excluded.note,
           checked_at = excluded.checked_at`,
      ).run(
        `lv_${randomUUID()}`,
        row.table_code,
        row.row_id,
        row.status,
        row.authority,
        row.sources_json,
        row.key_text,
        row.note,
        row.checked_at,
      );
      // 回读：同键已有行时 id 保留旧值，不能把生成的 id 直接返回
      return getByRow(row.table_code, row.row_id)!;
    },
    deleteByRow: (tableCode, rowId) =>
      db
        .prepare("DELETE FROM library_verification WHERE table_code = ? AND row_id = ?")
        .run(tableCode, rowId).changes > 0,
  };
}

// ─── createDb ──────────────────────────────────────────────

export interface DbInstance {
  db: Database.Database;
  /** 数据库实际文件路径（`:memory:` 原样保留） */
  dbPath: string;
  productLineRepo: Repo<ProductLine>;
  productRepo: Repo<Product>;
  specParamRepo: Repo<SpecParam>;
  capabilityRepo: Repo<Capability>;
  boundaryRepo: Repo<Boundary>;
  limitationRepo: Repo<Limitation>;
  /** 硬件报价（M6）：一行一个报价口径 */
  quoteRepo: Repo<PriceQuote>;
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
  /** 每一步的联网调研来源（调研先于分析） */
  researchRepo: ResearchRepo;
  /** 资料行联网核验记录（M1/M3/M6/O1） */
  verificationRepo: VerificationRepo;
  /**
   * 最近一次打开库时 O3→M6 价格迁移的结果
   *
   * 只在确有 O3 行时出现：`migrated` 已归位并删除的条数，`skipped` 因型号不在 M1 /
   * 缺金额 / 坏 payload 而原样保留的条数。启动日志据此报迁移条数。
   */
  o3PriceMigration?: { migrated: number; skipped: number };
}

/**
 * 创建或打开 SQLite 数据库，运行迁移，返回 db 实例和全部 repo。
 *
 * @param dbPath 数据库文件路径，默认读 DB_PATH 环境变量或 `data/scene-master.db`
 */
export function createDb(dbPath?: string): DbInstance {
  const resolved = dbPath ?? process.env.DB_PATH ?? "data/scene-master.db";
  const isMemory = resolved === ":memory:";
  const absPath = isMemory ? resolved : resolve(resolved);
  // 一条命令冷启动（npm start）时默认目录可能不存在：落库前自动建父目录；:memory: 跳过
  if (!isMemory) mkdirSync(dirname(absPath), { recursive: true });

  const db = new Database(resolved);

  // 外键约束
  db.pragma("foreign_keys = ON");

  // 运行迁移
  const migration = runMigrations(db);

  return {
    db,
    dbPath: absPath,
    productLineRepo: createRepo<ProductLine>(db, "product_line"),
    productRepo: createRepo<Product>(db, "product"),
    specParamRepo: createRepo<SpecParam>(db, "spec_param"),
    capabilityRepo: createRepo<Capability>(db, "capability"),
    boundaryRepo: createRepo<Boundary>(db, "boundary"),
    limitationRepo: createRepo<Limitation>(db, "limitation"),
    quoteRepo: createRepo<PriceQuote>(db, "price_quote"),
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
    researchRepo: createResearchRepo(db),
    verificationRepo: createVerificationRepo(db),
    ...(migration.o3PriceMigration
      ? { o3PriceMigration: migration.o3PriceMigration }
      : {}),
  };
}

// ─── FTS5 来源搜索 ─────────────────────────────────────────

/**
 * 全文搜索 source_fts 虚表，用于来源抽查（G-R3）。
 *
 * @param query FTS5 查询字符串（支持 NEAR、AND、OR 等）
 * @param limit 最大返回条数，默认 20
 */
/** FTS5 来源段落行：右栏「看原文」用（不带 rank——这里是精确取用，不是检索） */
export interface SourcePassage {
  source: string;
  content: string;
  table_code: string;
}

/**
 * 按来源串取出索引里的原文段落（变更表 #179）
 *
 * 右栏「来源」旁边点「看原文」时用：`source` 就是引用痕迹里的那个串
 * （形如 `在鸿工控机CT21B规格参数.docx:1` 或 URL），所以这里是**等值取用**而不是检索——
 * 用 `MATCH` 会被分词拆散、把别的来源也捞进来，反而证明不了"这句话确实在这一页"。
 * 同一来源在同一页可能被多张表引用，按内容去重后**长段优先**——
 * 索引里同一页既有"MCU -"这种表格碎片，也有整段描述；碎片证明不了什么，先给信息量大的。
 */
export function sourcePassages(
  db: Database.Database,
  source: string,
  limit = 3,
): SourcePassage[] {
  const rows = db
    .prepare(
      `SELECT source, content, table_code
       FROM source_fts
       WHERE source = ? AND content <> ''
       ORDER BY length(content) DESC`,
    )
    .all(source) as SourcePassage[];

  const seen = new Set<string>();
  const out: SourcePassage[] = [];
  for (const r of rows) {
    const key = r.content.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

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