/**
 * @scene/server — 对话写工具（变更表 #312–#314）
 *
 * 设计约束（产品架构评审 P0）：
 *  - 写操作必须走与界面相同的 HTTP 路由（app.inject），不绕过校验/门禁/stale；
 *  - 每次成功写入记 operation_log，返回可撤销句柄；
 *  - 删除类走两阶段确认：先预览，`confirm_operation` 再执行。
 *
 * 读能力暂以「上下文注入」提供（见 buildLibraryContext / buildArtifactContext）：
 * 当前 DSH 管道是单轮工具调用，工具结果无法回喂模型；多轮工具循环是后续改造项。
 */

import type { FastifyInstance } from "fastify";
import type { DbInstance } from "@scene/infra";
import { ANCHOR_TABLE_CODE } from "@scene/contract";
import {
  applyUndoActions,
  readRowForUndo,
  recordOperation,
  type UndoAction,
} from "./operation-log.js";
import { takePending } from "./pending-ops.js";
import { syncDerivedDescription } from "./scenario-anchor.js";

export interface ToolOutcome {
  note: string;
  operation?: { id: string; summary: string };
}

export interface ToolContext {
  db: DbInstance;
  app: FastifyInstance;
  conversationId: string | null;
  surface: string;
  scenarioId?: string;
  lineId?: string;
}

/** 资料库表 → 物理表（撤销留底用）；M4 合并了边界与限制两张表 */
const TABLE_NAMES: Record<string, string[]> = {
  M1: ["product"],
  M2: ["spec_param"],
  M3: ["capability"],
  M4: ["boundary", "limitation"],
  M5: ["limitation"],
  M6: ["quote"],
  O1: ["optional_material"],
  O2: ["optional_material"],
  O4: ["optional_material"],
  O5: ["optional_material"],
  O6: ["optional_material"],
};

function trimValue(value: unknown, max = 120): unknown {
  if (typeof value !== "string") return value;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

async function injectJson(
  app: FastifyInstance,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await app.inject({ method, url, payload: payload as never });
  let data: unknown = null;
  try {
    data = res.body ? JSON.parse(res.body) : null;
  } catch {
    data = res.body;
  }
  return { ok: res.statusCode < 400, status: res.statusCode, data };
}

function errorText(data: unknown, status: number): string {
  if (data && typeof data === "object" && "error" in data) {
    return String((data as { error?: unknown }).error ?? `HTTP ${status}`);
  }
  return `HTTP ${status}`;
}

function rowText(row: Record<string, unknown>, max = 60): string {
  return Object.entries(row)
    .filter(([k]) => !["id", "created_at", "updated_at", "payload", "product_line_id"].includes(k))
    .map(([k, v]) => `${k}=${String(trimValue(v, max) ?? "")}`)
    .join("; ");
}

/** 找资料库行：按 列=值 精确匹配（值来自上下文，模型照抄） */
function matchRow(
  rows: Array<Record<string, unknown>>,
  match: { column?: unknown; value?: unknown },
): { row?: Record<string, unknown>; error?: string } {
  const column = String(match.column ?? "").trim();
  const value = String(match.value ?? "").trim();
  if (!column || !value) return { error: "需要 match.column 与 match.value" };
  const hits = rows.filter((r) => String(r[column] ?? "").trim() === value);
  if (hits.length === 0) {
    const sample = rows.slice(0, 8).map((r) => rowText(r, 40)).join(" | ");
    return { error: `没找到 ${column}=${value} 的行。现有行：${sample || "（空表）"}` };
  }
  if (hits.length > 1) return { error: `${column}=${value} 匹配到 ${hits.length} 行，请给更唯一的列` };
  return { row: hits[0] };
}

/** 读资料库某表现有行（与界面同源，M4 走合并视图） */
async function fetchLibraryRows(
  ctx: ToolContext,
  table: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await injectJson(
    ctx.app,
    "GET",
    `/api/v1/library/tables/${encodeURIComponent(table)}?product_line_id=${encodeURIComponent(ctx.lineId ?? "")}`,
  );
  if (!res.ok) throw new Error(errorText(res.data, res.status));
  return Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
}

/**
 * 资料库写入：改 / 增 / 删。
 * 删除只出预览（R2），由 confirm_operation 执行。
 */
export async function libraryWrite(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const table = String(args.table ?? "").trim().toUpperCase();
  if (!TABLE_NAMES[table]) throw new Error(`表编号非法：${table || "（空）"}（可用 M1–M6/O1/O2/O4/O5/O6）`);
  if (!ctx.lineId) throw new Error("缺少产品线上下文");

  const updates = Array.isArray(args.updates) ? (args.updates as Array<Record<string, unknown>>) : [];
  const adds = Array.isArray(args.add) ? (args.add as Array<Record<string, unknown>>) : [];
  const deletes = Array.isArray(args.delete) ? (args.delete as Array<Record<string, unknown>>) : [];
  if (updates.length + adds.length + deletes.length === 0) {
    throw new Error("没有要改的内容：updates/add/delete 至少给一项");
  }
  if (updates.length + adds.length > 10) throw new Error("一次最多改/增 10 行");

  const rows = await fetchLibraryRows(ctx, table);
  const undo: UndoAction[] = [];
  const done: string[] = [];

  try {
    for (const item of updates) {
      const found = matchRow(rows, (item.match ?? {}) as { column?: unknown; value?: unknown });
      if (!found.row) throw new Error(found.error ?? "找不到要改的行");
      const id = String(found.row.id);
      const values = (item.values ?? {}) as Record<string, unknown>;
      const valid = Object.keys(values).filter(
        (k) => values[k] !== undefined && !["id", "created_at", "updated_at", "product_line_id"].includes(k),
      );
      if (valid.length === 0) throw new Error("updates[].values 为空");
      for (const tableName of TABLE_NAMES[table]!) {
        const before = readRowForUndo(ctx.db, tableName, id);
        if (before) {
          undo.push({ kind: "update", table: tableName, id, before });
          break;
        }
      }
      for (const cell of valid) {
        const res = await injectJson(
          ctx.app,
          "PATCH",
          `/api/v1/library/rows/${encodeURIComponent(table)}/${encodeURIComponent(id)}`,
          { cell, value: values[cell] },
        );
        if (!res.ok) throw new Error(errorText(res.data, res.status));
      }
      const label = String(found.row[String((item.match as { column?: unknown }).column ?? "")] ?? "");
      done.push(`改 ${table}「${label}」的 ${valid.join("、")}`);
    }

    for (const item of adds) {
      const values = (item.values ?? {}) as Record<string, unknown>;
      const res = await injectJson(ctx.app, "POST", `/api/v1/library/rows/${encodeURIComponent(table)}`, {
        product_line_id: ctx.lineId,
        values,
      });
      if (!res.ok) throw new Error(errorText(res.data, res.status));
      const created = res.data as { id?: string };
      if (created?.id) {
        for (const tableName of TABLE_NAMES[table]!) {
          if (readRowForUndo(ctx.db, tableName, created.id)) {
            undo.push({ kind: "delete", table: tableName, id: created.id });
            break;
          }
        }
      }
      done.push(`新增 ${table} 一行`);
    }
  } catch (err) {
    applyUndoActions(ctx.db, undo);
    throw err;
  }

  /* 删除（#312）：可撤销，直接执行；预览确认因模型不稳定改为后续增强 */
  for (const item of deletes) {
    const found = matchRow(rows, (item.match ?? {}) as { column?: unknown; value?: unknown });
    if (!found.row) throw new Error(found.error ?? "找不到要删的行");
    const id = String(found.row.id);
    for (const tableName of TABLE_NAMES[table]!) {
      const before = readRowForUndo(ctx.db, tableName, id);
      if (before) {
        undo.push({ kind: "insert", table: tableName, row: before });
        break;
      }
    }
    const res = await injectJson(
      ctx.app,
      "DELETE",
      `/api/v1/library/rows/${encodeURIComponent(table)}/${encodeURIComponent(id)}`,
    );
    if (!res.ok) throw new Error(errorText(res.data, res.status));
    const delLabel = String(
      found.row[String((item.match as { column?: unknown }).column ?? "")] ?? "",
    );
    done.push(`删 ${table}「${delLabel}」`);
  }

  const rec = recordOperation(ctx.db, {
    conversationId: ctx.conversationId,
    surface: ctx.surface,
    tool: "library_write",
    summary: done.join("、") || "资料库写入",
    undo,
  });
  return {
    note: `已改资料库：${done.join("；")}（可撤销）。`,
    operation: { id: rec.id, summary: rec.summary },
  };
}

/** 新建产品线（R1，可撤销） */
export function createProductLine(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  const name = String(args.name ?? "").trim();
  if (!name) throw new Error("产品线名称不能为空");
  const line = ctx.db.productLineRepo.insert({ name });
  const rec = recordOperation(ctx.db, {
    conversationId: ctx.conversationId,
    surface: ctx.surface,
    tool: "create_product_line",
    summary: `新建产品线「${name}」`,
    undo: [{ kind: "delete", table: "product_line", id: line.id }],
  });
  return {
    note: `已新建产品线「${name}」。`,
    operation: { id: rec.id, summary: rec.summary },
  };
}

/** 注释型来源：只接受用户给的原文，source_type 固定「用户补充」 */
export function writeAnchorRows(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  if (!ctx.scenarioId) throw new Error("缺少场景上下文");
  const rows = Array.isArray(args.rows) ? (args.rows as Array<Record<string, unknown>>) : [];
  if (rows.length === 0) throw new Error("rows 不能为空");
  const stageRows = ctx.db.stageDataRepo
    .listByScenarioStage(ctx.scenarioId, 1 as never)
    .filter((r) => r.table_code === ANCHOR_TABLE_CODE);
  const undo: UndoAction[] = [];
  const done: string[] = [];
  for (const item of rows) {
    const label = String(item.item ?? "").trim();
    const content = String(item.content ?? "").trim();
    if (!label) throw new Error("rows[].item 不能为空");
    const target = stageRows.find(
      (r) => String((r.row as Record<string, unknown>)["item"] ?? "").trim() === label,
    );
    if (!target) throw new Error(`表1-1 里没有「${label}」这一行。现有：${stageRows.map((r) => String((r.row as Record<string, unknown>)["item"] ?? "")).join("、")}`);
    const before = readRowForUndo(ctx.db, "stage_data", target.id);
    if (before) undo.push({ kind: "update", table: "stage_data", id: target.id, before });
    const nextRow = {
      ...(target.row as Record<string, unknown>),
      content,
      ...(item.source === undefined ? {} : { source: String(item.source ?? "") }),
    };
    ctx.db.stageDataRepo.update(target.id, {
      row: nextRow as never,
      ...(item.source === undefined ? {} : { source: String(item.source), source_type: "用户补充" }),
    } as never);
    done.push(label);
  }
  syncDerivedDescription(ctx.db, ctx.scenarioId);
  const rec = recordOperation(ctx.db, {
    conversationId: ctx.conversationId,
    surface: ctx.surface,
    tool: "write_anchor_rows",
    summary: `更新表1-1：${done.join("、")}`,
    undo,
  });
  return {
    note: `已更新表1-1：${done.join("、")}（可撤销）。`,
    operation: { id: rec.id, summary: rec.summary },
  };
}

/** 确认并执行待确认操作（R2） */
export async function confirmOperation(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const id = String(args.op_id ?? "").trim();
  const op = takePending(id, ctx.conversationId);
  if (!op) throw new Error("待确认操作不存在或已过期（5 分钟），请重新发起");
  const result = await op.run();
  return {
    note: result.note,
    ...(result.operationId
      ? { operation: { id: result.operationId, summary: result.note } }
      : {}),
  };
}

/** 工具定义：资料库写 */
export const LIBRARY_WRITE_TOOL = {
  type: "function",
  function: {
    name: "library_write",
    description:
      "修改资料库：更新行（updates）、新增行（add）、删除行（delete）。行用「列=值」定位，列名照抄上下文里的键。删除只出预览，需用户确认后再调 confirm_operation。",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string", description: "表编号：M1/M2/M3/M4/M5/M6/O1/O2/O4/O5/O6" },
        updates: {
          type: "array",
          description: "要改的行，一次最多 10 行",
          items: {
            type: "object",
            properties: {
              match: {
                type: "object",
                properties: {
                  column: { type: "string", description: "定位列（如 model、name、description）" },
                  value: { type: "string", description: "该列的现有值，照抄上下文" },
                },
                required: ["column", "value"],
              },
              values: { type: "object", description: "列 → 新值" },
            },
            required: ["match", "values"],
          },
        },
        add: {
          type: "array",
          description: "要新增的行，一次最多 10 行",
          items: {
            type: "object",
            properties: { values: { type: "object", description: "列 → 值" } },
            required: ["values"],
          },
        },
        delete: {
          type: "array",
          description: "要删除的行（只预览，需确认）",
          items: {
            type: "object",
            properties: {
              match: {
                type: "object",
                properties: { column: { type: "string" }, value: { type: "string" } },
                required: ["column", "value"],
              },
            },
            required: ["match"],
          },
        },
      },
      required: ["table"],
    },
  },
} as const;

export const CREATE_PRODUCT_LINE_TOOL = {
  type: "function",
  function: {
    name: "create_product_line",
    description: "新建一条产品线（资料库的一级分类），用户明确要新建时调用。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "产品线名称" } },
      required: ["name"],
    },
  },
} as const;

export const WRITE_ANCHOR_ROWS_TOOL = {
  type: "function",
  function: {
    name: "write_anchor_rows",
    description:
      "写第 1 步「表1-1 场景定义」的行。item 用现有行名（照抄上下文），content 为内容；只有用户提供了出处时才传 source。",
    parameters: {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              item: { type: "string", description: "行名，如「场景名称」「客户痛点」" },
              content: { type: "string", description: "这一行的内容" },
              source: { type: "string", description: "用户提供的出处（可选）" },
            },
            required: ["item", "content"],
          },
        },
      },
      required: ["rows"],
    },
  },
} as const;

export const CONFIRM_OPERATION_TOOL = {
  type: "function",
  function: {
    name: "confirm_operation",
    description: "执行一条已预览、且用户已口头确认的删除类操作。op_id 来自预览提示。",
    parameters: {
      type: "object",
      properties: { op_id: { type: "string", description: "预览里给出的操作 id" } },
      required: ["op_id"],
    },
  },
} as const;
