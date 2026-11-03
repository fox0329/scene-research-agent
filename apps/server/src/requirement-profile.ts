/**
 * @scene/server — 需求画像 repo + 交互事件唯一写入口（contract v1.5，变更表 #351–#353）
 *
 * 职责边界（评审修订 #353）：
 * - recordInteractionEvent 是 interaction_event 的**唯一写入口**，五处埋点 command
 *   只调它，禁止各 command 直写表（防跨模块直写，规则 3）。
 * - 本文件只做数据访问与行映射；条目合并/冲突/置信/升级判定等纯规则
 *   属 MR1-T3 领域层（packages/domain），这里不实现判定。
 * - 用户手编永远赢：updateRequirement 直接覆盖，抽取管道写入前须重读。
 */

import { randomUUID } from "node:crypto";
import type { DbInstance } from "@scene/infra";
import type {
  CheckAnchor,
  InteractionEventRecord,
  InteractionAction,
  InteractionSurface,
  RequirementEntry,
  RequirementPatchRequest,
  RequirementSource,
} from "@scene/contract";

// ─── 裸 SQL 薄包装（DbInstance 无快捷方法，同 operation-log 的 db.db.prepare 风格） ──

function run(db: DbInstance, sql: string, params: unknown[]): void {
  db.db.prepare(sql).run(...params);
}
function all(db: DbInstance, sql: string, params: unknown[]): Record<string, unknown>[] {
  return db.db.prepare(sql).all(...params) as Record<string, unknown>[];
}
function getOne(db: DbInstance, sql: string, params: unknown[]): Record<string, unknown> | undefined {
  return db.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
}

// ─── 行映射 ──────────────────────────────────────────────────

function rowToEntry(row: Record<string, unknown>): RequirementEntry {
  return {
    id: row.id as string,
    scenario_id: (row.scenario_id as string | null) ?? null,
    origin_scenario_id: (row.origin_scenario_id as string | null) ?? null,
    scope: row.scope as RequirementEntry["scope"],
    kind: row.kind as RequirementEntry["kind"],
    text: row.text as string,
    check_anchor: row.check_anchor ? (JSON.parse(row.check_anchor as string) as CheckAnchor) : null,
    status: row.status as RequirementEntry["status"],
    confidence: row.confidence as RequirementEntry["confidence"],
    sources: JSON.parse((row.source_json as string) || "[]") as RequirementSource[],
    artifact_refs: JSON.parse((row.artifact_refs as string) || "[]") as string[],
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

// ─── 交互事件（唯一写入口） ──────────────────────────────────

export interface RecordEventInput {
  scenario_id?: string | null;
  conversation_id?: string | null;
  surface: InteractionSurface;
  action: InteractionAction;
  target?: string;
  detail?: Record<string, unknown>;
}

export function recordInteractionEvent(db: DbInstance, input: RecordEventInput): InteractionEventRecord {
  const record: InteractionEventRecord = {
    id: randomUUID(),
    scenario_id: input.scenario_id ?? null,
    conversation_id: input.conversation_id ?? null,
    surface: input.surface,
    action: input.action,
    target: input.target ?? "",
    detail_json: JSON.stringify(input.detail ?? {}),
    created_at: new Date().toISOString(),
  };
  run(db, 
    `INSERT INTO interaction_event
       (id, scenario_id, conversation_id, surface, action, target, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.scenario_id,
      record.conversation_id,
      record.surface,
      record.action,
      record.target,
      record.detail_json,
      record.created_at,
    ],
  );
  return record;
}

export function listInteractionEvents(
  db: DbInstance,
  scenarioId: string,
  opts?: { limit?: number },
): InteractionEventRecord[] {
  const rows = all(db, 
    `SELECT * FROM interaction_event WHERE scenario_id = ?
     ORDER BY created_at DESC LIMIT ?`,
    [scenarioId, opts?.limit ?? 100],
  ) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as string,
    scenario_id: (row.scenario_id as string | null) ?? null,
    conversation_id: (row.conversation_id as string | null) ?? null,
    surface: row.surface as InteractionEventRecord["surface"],
    action: row.action as InteractionEventRecord["action"],
    target: row.target as string,
    detail_json: row.detail_json as string,
    created_at: row.created_at as string,
  }));
}

// ─── 需求画像条目 ────────────────────────────────────────────

export interface InsertRequirementInput {
  scenario_id: string | null;
  origin_scenario_id?: string | null;
  scope: RequirementEntry["scope"];
  kind: RequirementEntry["kind"];
  text: string;
  check_anchor?: CheckAnchor | null;
  confidence: RequirementEntry["confidence"];
  sources: RequirementSource[];
  artifact_refs?: string[];
}

export function insertRequirement(db: DbInstance, input: InsertRequirementInput): RequirementEntry {
  const now = new Date().toISOString();
  const entry: RequirementEntry = {
    id: randomUUID(),
    scenario_id: input.scenario_id,
    origin_scenario_id: input.origin_scenario_id ?? null,
    scope: input.scope,
    kind: input.kind,
    text: input.text,
    check_anchor: input.check_anchor ?? null,
    status: "active",
    confidence: input.confidence,
    sources: input.sources,
    artifact_refs: input.artifact_refs ?? [],
    created_at: now,
    updated_at: now,
  };
  run(db, 
    `INSERT INTO requirement_profile
       (id, scenario_id, origin_scenario_id, scope, kind, text, check_anchor,
        status, confidence, source_json, artifact_refs, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    [
      entry.id,
      entry.scenario_id,
      entry.origin_scenario_id,
      entry.scope,
      entry.kind,
      entry.text,
      entry.check_anchor ? JSON.stringify(entry.check_anchor) : null,
      entry.confidence,
      JSON.stringify(entry.sources),
      JSON.stringify(entry.artifact_refs),
      entry.created_at,
      entry.updated_at,
    ],
  );
  return entry;
}

/** 场景视图：本场景 scene 条目 + 全局 user 条目（冷启动注入的数据面） */
export function listRequirements(db: DbInstance, scenarioId: string): RequirementEntry[] {
  const rows = all(db, 
    `SELECT * FROM requirement_profile
     WHERE status != 'dismissed' AND (scenario_id = ? OR scope = 'user')
     ORDER BY updated_at DESC`,
    [scenarioId],
  ) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

/** 升级候选：同文本在 ≥2 个场景保持 active 的 scene 条目（判定在领域层，这里供数） */
export function listUpgradeCandidates(db: DbInstance): RequirementEntry[] {
  const rows = all(db,
    `SELECT * FROM requirement_profile
     WHERE scope = 'scene' AND status = 'active'
       AND scenario_id IS NOT NULL
       AND (SELECT COUNT(DISTINCT scenario_id) FROM requirement_profile p2
            WHERE p2.text = requirement_profile.text
              AND p2.scope = 'scene' AND p2.status = 'active') >= 2
     ORDER BY updated_at DESC`,
    [],
  ) as Record<string, unknown>[];
  // 同文本在 N 个场景会有 N 行，候选按「一类一张卡」去重（确认时整类升级，MR1-T5）
  const seen = new Set<string>();
  const unique: RequirementEntry[] = [];
  for (const row of rows) {
    const entry = rowToEntry(row);
    if (seen.has(entry.text)) continue;
    seen.add(entry.text);
    unique.push(entry);
  }
  return unique;
}

/** 用户手编（PATCH）：直接覆盖，用户编辑永远赢 */
export function updateRequirement(
  db: DbInstance,
  id: string,
  patch: RequirementPatchRequest,
): RequirementEntry | null {
  const row = getOne(db, "SELECT * FROM requirement_profile WHERE id = ?", [id]) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.text !== undefined) {
    sets.push("text = ?");
    vals.push(patch.text);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    vals.push(patch.status);
  }
  if (patch.scope !== undefined) {
    sets.push("scope = ?");
    vals.push(patch.scope);
    // 升级为用户级：scenario_id 置 NULL，origin 留当前场景溯源（评审修订 #353）
    if (patch.scope === "user") {
      sets.push("scenario_id = NULL");
      sets.push("origin_scenario_id = ?");
      vals.push(row.scenario_id as string | null);
    }
  }
  if (patch.check_anchor !== undefined) {
    sets.push("check_anchor = ?");
    vals.push(patch.check_anchor ? JSON.stringify(patch.check_anchor) : null);
  }
  if (patch.sources !== undefined) {
    // 相似合并：来源追加（内容去重），不是整组替换——旧来源一条不丢
    const currentSources = JSON.parse((row.source_json as string) || "[]") as RequirementSource[];
    for (const s of patch.sources) {
      const dup = currentSources.some((x) => JSON.stringify(x) === JSON.stringify(s));
      if (!dup) currentSources.push(s);
    }
    sets.push("source_json = ?");
    vals.push(JSON.stringify(currentSources));
  }
  sets.push("updated_at = ?");
  vals.push(new Date().toISOString());
  vals.push(id);
  run(db, `UPDATE requirement_profile SET ${sets.join(", ")} WHERE id = ?`, vals);
  const updated = getOne(db, "SELECT * FROM requirement_profile WHERE id = ?", [id]) as
    | Record<string, unknown>
    | undefined;
  return updated ? rowToEntry(updated) : null;
}

/** 降级：用户级退回场景级，挂到指定场景 */
export function demoteToScene(db: DbInstance, id: string, scenarioId: string): RequirementEntry | null {
  return updateRequirement(db, id, { scope: "scene" }) && reassignScenario(db, id, scenarioId);
}

function reassignScenario(db: DbInstance, id: string, scenarioId: string): RequirementEntry | null {
  run(db, "UPDATE requirement_profile SET scenario_id = ? WHERE id = ?", [scenarioId, id]);
  const row = getOne(db, "SELECT * FROM requirement_profile WHERE id = ?", [id]) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToEntry(row) : null;
}

/** dismissed 即黑名单：抽取管道取指纹时用（MR1-T3 领域层消费） */
export function listDismissedTexts(db: DbInstance): string[] {
  const rows = all(db,
    "SELECT text FROM requirement_profile WHERE status = 'dismissed'",
    [],
  ) as { text: string }[];
  return rows.map((r) => r.text);
}
