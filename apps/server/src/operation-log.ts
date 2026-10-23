/**
 * @scene/server — 写操作审计与撤销（变更表 #312，P0）
 *
 * 为什么先有它再放开写：对话让模型改数据后，用户必须能一键撤回。
 * 审计与撤销是 R1/R2 工具上线的前置条件，不是锦上添花。
 *
 * 存储：operation_log 一行 = 一次工具调用；undo_json 是逆操作数组，
 * 行级粒度，按 table + id 还原/删除，不依赖具体仓储类型。
 */

import { randomUUID } from "node:crypto";
import type { DbInstance } from "@scene/infra";

export type UndoAction =
  | { kind: "update"; table: string; id: string; before: Record<string, unknown> }
  | { kind: "delete"; table: string; id: string }
  | { kind: "insert"; table: string; row: Record<string, unknown> };

export interface OperationRecord {
  id: string;
  conversation_id: string | null;
  surface: string;
  tool: string;
  summary: string;
  undo: UndoAction[];
  created_at: string;
  undone_at: string | null;
}

/** 只允许这些表被撤销：白名单防止拼出任意 SQL */
const UNDO_TABLES = new Set([
  "stage_data",
  "product",
  "spec_param",
  "capability",
  "boundary",
  "limitation",
  "quote",
  "optional_material",
  "product_line",
]);

export function recordOperation(
  db: DbInstance,
  input: {
    conversationId?: string | null;
    surface: string;
    tool: string;
    summary: string;
    undo: UndoAction[];
  },
): OperationRecord {
  const row: OperationRecord = {
    id: randomUUID(),
    conversation_id: input.conversationId ?? null,
    surface: input.surface,
    tool: input.tool,
    summary: input.summary,
    undo: input.undo,
    created_at: new Date().toISOString(),
    undone_at: null,
  };
  db.db
    .prepare(
      `INSERT INTO operation_log (id, conversation_id, surface, tool, summary, undo_json, created_at, undone_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      row.id,
      row.conversation_id,
      row.surface,
      row.tool,
      row.summary,
      JSON.stringify(row.undo),
      row.created_at,
    );
  return row;
}

export function getOperation(db: DbInstance, id: string): OperationRecord | null {
  const r = db.db
    .prepare("SELECT * FROM operation_log WHERE id = ?")
    .get(id) as
    | {
        id: string;
        conversation_id: string | null;
        surface: string;
        tool: string;
        summary: string;
        undo_json: string;
        created_at: string;
        undone_at: string | null;
      }
    | undefined;
  if (!r) return null;
  return {
    id: r.id,
    conversation_id: r.conversation_id,
    surface: r.surface,
    tool: r.tool,
    summary: r.summary,
    undo: JSON.parse(r.undo_json) as UndoAction[],
    created_at: r.created_at,
    undone_at: r.undone_at,
  };
}

/** 撤销一次操作：按逆操作顺序回放，整体事务，失败全部回滚 */
export function undoOperation(
  db: DbInstance,
  id: string,
): { ok: boolean; message: string } {
  const op = getOperation(db, id);
  if (!op) return { ok: false, message: "找不到这次操作" };
  if (op.undone_at) return { ok: false, message: "这次操作已经撤销过" };

  const apply = db.db.transaction(() => {
    applyUndoActions(db, op.undo);
    db.db
      .prepare("UPDATE operation_log SET undone_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  });

  try {
    apply();
    return { ok: true, message: `已撤销：${op.summary}` };
  } catch (err) {
    return {
      ok: false,
      message: `撤销失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** 回放逆操作（撤销与工具失败回滚共用），调用方负责事务 */
export function applyUndoActions(db: DbInstance, undo: UndoAction[]): void {
  for (const action of [...undo].reverse()) {
    if (!UNDO_TABLES.has(action.table)) {
      throw new Error(`不允许撤销表 ${action.table}`);
    }
    if (action.kind === "update") {
      const keys = Object.keys(action.before).filter(
        (k) => k !== "id" && k !== "created_at",
      );
      if (keys.length === 0) continue;
      const sets = keys.map((k) => `${k} = ?`).join(", ");
      db.db
        .prepare(`UPDATE ${action.table} SET ${sets} WHERE id = ?`)
        .run(...keys.map((k) => action.before[k] as never), action.id);
    } else if (action.kind === "delete") {
      db.db.prepare(`DELETE FROM ${action.table} WHERE id = ?`).run(action.id);
    } else {
      const keys = Object.keys(action.row);
      const marks = keys.map(() => "?").join(", ");
      db.db
        .prepare(`INSERT OR REPLACE INTO ${action.table} (${keys.join(", ")}) VALUES (${marks})`)
        .run(...keys.map((k) => action.row[k] as never));
    }
  }
}

/** 读整行（撤销前留底）；表名走白名单 */
export function readRowForUndo(
  db: DbInstance,
  table: string,
  id: string,
): Record<string, unknown> | undefined {
  if (!UNDO_TABLES.has(table)) return undefined;
  return db.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}
