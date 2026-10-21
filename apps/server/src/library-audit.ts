/**
 * 存量资料库体检（确定性，纯代码判定）
 *
 * 背景：0.6.9 的入库标准（`docs/资料入库标准.md`）只对**新导入**生效；
 * 存量行的 `evidence_level` 多为硬编码 "B"（自媒体来源也是 B），
 * `source` 里还有「未知」「边界:未知」这类不可定位串。
 *
 * 本模块只做三件事，且都只读或只改一个字段：
 *   ① 按同一套入库规则重新判权威级/证据级（规则来自 `@scene/domain/library-standard`，
 *      **不在这里复制词表或类目表**）；
 *   ② 列出不可定位来源、绝对化措辞、同键不同值冲突（只报告，不删行、不改冲突行）；
 *   ③ `apply: true` 时只把 `evidence_level` 降为 C，不动 source/内容/其余字段。
 *
 * 幂等：已是 C 的行不重复计数；第二次 POST 的 `downgraded` 应为 0。
 */

import type {
  Boundary,
  Capability,
  Limitation,
  OptionalMaterial,
  PriceQuote,
  Product,
  SpecParam,
} from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import {
  ABSOLUTE_TERMS,
  classifyLibrarySource,
  downgradeLibraryEvidence,
  findAbsoluteTerms,
  isAuthority,
  isEvidenceLevel,
  normalizeValue,
} from "@scene/domain";
import { isLocatableSource } from "./library-gate.js";

/** 体检覆盖的表（M1–M6 + O1/O2/O4/O5/O6） */
export const AUDIT_TABLES = [
  "M1",
  "M2",
  "M3",
  "M4",
  "M5",
  "M6",
  "O1",
  "O2",
  "O4",
  "O5",
  "O6",
] as const;

export type AuditTable = (typeof AUDIT_TABLES)[number];

/** 不可定位来源的行（只报告，不删除） */
export interface AuditUnlocatableRow {
  table: AuditTable | string;
  row_id: string;
  /** 来源原文（可能是空串） */
  source: string;
  /** 行摘要（≤20 字，便于人工回查） */
  summary: string;
}

/** 命中绝对化措辞的行（只报告；apply 时证据降 C） */
export interface AuditAbsoluteRow extends AuditUnlocatableRow {
  /** 命中词，顿号连接（界面直接展示） */
  term: string;
  terms: string[];
}

/** 冲突里的一个取值 */
export interface AuditConflictValue {
  value: string;
  source: string;
  row_id: string;
}

/** 同键不同值（只报告，由人裁决；不覆盖、不新增） */
export interface AuditConflict {
  table: AuditTable | string;
  /** 人可读的键（型号/参数类/参数名 等） */
  key: string;
  values: AuditConflictValue[];
}

/** 体检报告（GET 只读预览与 POST 应用返回同一结构） */
export interface LibraryAuditReport {
  /** 扫描行数（全库或指定产品线） */
  scanned: number;
  /** 每张表扫描行数（含 0，便于界面稳定展示） */
  byTable: Record<string, number>;
  /** 按体检规则换算后的证据级分布（预览也按将要落库的结果统计） */
  evidence: { A: number; B: number; C: number; D: number };
  /** 需要降级/已降级的行数（已是 C 的不计；幂等） */
  downgraded: number;
  unlocatable: AuditUnlocatableRow[];
  absolute: AuditAbsoluteRow[];
  conflicts: AuditConflict[];
  generatedAt: string;
  /** false=只读预览（GET），true=已把证据级写回库（POST） */
  applied: boolean;
}

export interface LibraryAuditOptions {
  /** 只体检某个产品线；缺省全库 */
  productLineId?: string;
  /** 是否把证据级降级写回库；缺省 false（只读） */
  apply?: boolean;
}

/** 可选材料类目 → 表号（与 contract 的 category 枚举一致） */
const OPTIONAL_CODE: Readonly<Record<string, AuditTable>> = {
  O1认证: "O1",
  O2案例: "O2",
  O4SDK: "O4",
  O5路线图: "O5",
  O6生态: "O6",
};

/** 扫描过程中统一的行形态 */
interface ScannedRow {
  table: AuditTable;
  id: string;
  source: string;
  /** 库里已有权威级（可能为空/脏值） */
  authorityRaw: unknown;
  evidenceRaw: unknown;
  /** 参与绝对化检查的文本字段（已转字符串） */
  fields: Record<string, string>;
  summary: string;
  /** 冲突分组键（M2/M3/M4 才有） */
  groupId?: string;
  /** 冲突分组的人可读键 */
  groupKey?: string;
  /** 该行在冲突比较里的取值 */
  conflictValue?: string;
}

/**
 * 存量资料库体检入口。
 *
 * @param db - 数据库实例
 * @param opts - 产品线过滤 / 是否写回；缺省全库只读
 */
export function auditLibrary(
  db: DbInstance,
  opts: LibraryAuditOptions = {},
): LibraryAuditReport {
  const apply = opts.apply === true;
  const productLineId = opts.productLineId?.trim() || undefined;
  const rows = scanLibrary(db, productLineId);

  const byTable: Record<string, number> = {};
  for (const table of AUDIT_TABLES) byTable[table] = 0;

  const evidence = { A: 0, B: 0, C: 0, D: 0 };
  const unlocatable: AuditUnlocatableRow[] = [];
  const absolute: AuditAbsoluteRow[] = [];
  let downgraded = 0;

  for (const row of rows) {
    byTable[row.table] = (byTable[row.table] ?? 0) + 1;

    const flat = {
      table: row.table,
      row_id: row.id,
      source: row.source,
      summary: row.summary,
    };
    if (!isLocatableSource(row.source)) unlocatable.push(flat);

    const terms = absoluteTermsOf(row.fields);
    if (terms.length > 0) {
      absolute.push({ ...flat, term: terms.join("、"), terms });
    }

    const current = isEvidenceLevel(row.evidenceRaw) ? row.evidenceRaw : null;
    const cls = classifyLibrarySource(
      row.source,
      fileNameOfSource(row.source),
    );
    /**
     * 权威级口径：库里已有有效值就沿用（人工改过的不被体检覆盖），
     * 但**低权威判定同时看规则重算结果**——存量 T3 大多是历史上的硬编码，
     * 若只信已有值，自媒体来源永远降不下来（用户问的正是这件事）。
     */
    const authority = isAuthority(row.authorityRaw) ? row.authorityRaw : cls.authority;
    const lowAuthority = cls.lowAuthority || authority === "T4";

    const next = downgradeLibraryEvidence(current, {
      lowAuthority,
      absoluteHit: terms.length > 0,
    });
    if (next) evidence[next] += 1;

    const changed = next !== current;
    if (changed && next) {
      if (!apply || writeEvidence(db, row.table, row.id, next)) downgraded += 1;
    }
  }

  return {
    scanned: rows.length,
    byTable,
    evidence,
    downgraded,
    unlocatable,
    absolute,
    conflicts: findConflicts(rows),
    generatedAt: new Date().toISOString(),
    applied: apply,
  };
}

// ─── 扫描 ──────────────────────────────────────────────────

function scanLibrary(db: DbInstance, productLineId?: string): ScannedRow[] {
  const products = db.productRepo.list(
    productLineId ? { where: "product_line_id = ?", params: [productLineId] } : {},
  );
  const productById = new Map(products.map((p) => [p.id, p]));

  const rows: ScannedRow[] = [];
  for (const product of products) rows.push(fromProduct(product));

  const specParams = db.specParamRepo.list() as SpecParam[];
  for (const spec of specParams) {
    const product = productById.get(spec.product_id);
    if (!product) continue;
    rows.push(fromSpecParam(spec, product));
  }

  const capabilities = db.capabilityRepo.list(
    productLineId ? { where: "product_line_id = ?", params: [productLineId] } : {},
  ) as Capability[];
  for (const cap of capabilities) rows.push(fromCapability(cap));

  const boundaries = db.boundaryRepo.list(
    productLineId ? { where: "product_line_id = ?", params: [productLineId] } : {},
  ) as Boundary[];
  for (const boundary of boundaries) rows.push(fromBoundary(boundary));

  const limitations = db.limitationRepo.list(
    productLineId ? { where: "product_line_id = ?", params: [productLineId] } : {},
  ) as Limitation[];
  for (const limitation of limitations) rows.push(fromLimitation(limitation));

  const quotes = db.quoteRepo.list() as PriceQuote[];
  for (const quote of quotes) {
    // 报价挂 product_id；不属本次范围的报价不扫（与 M2 同一归属口径）
    if (!productById.has(quote.product_id)) continue;
    rows.push(fromQuote(quote));
  }

  const optional = db.optionalMaterialRepo.list(
    productLineId ? { where: "product_line_id = ?", params: [productLineId] } : {},
  ) as OptionalMaterial[];
  for (const item of optional) {
    const table = OPTIONAL_CODE[item.category];
    if (!table) continue;
    rows.push(fromOptional(item, table));
  }

  return rows;
}

function fromProduct(product: Product): ScannedRow {
  const fields = pick(product as unknown as Record<string, unknown>, [
    "model",
    "name",
    "status",
    "launch_date",
    "former_name",
    "position_desc",
  ]);
  return {
    table: "M1",
    id: product.id,
    source: text(product.source),
    authorityRaw: product.source_authority,
    evidenceRaw: product.evidence_level,
    fields,
    summary: brief([product.model, product.name].filter(Boolean).join(" ")),
  };
}

function fromSpecParam(spec: SpecParam, product: Product): ScannedRow {
  const fields = pick(spec as unknown as Record<string, unknown>, [
    "param_class",
    "param_name",
    "value",
    "measured",
  ]);
  return {
    table: "M2",
    id: spec.id,
    source: text(spec.source),
    authorityRaw: spec.source_authority,
    evidenceRaw: spec.evidence_level,
    fields,
    summary: brief([spec.param_class, spec.param_name, spec.value].filter(Boolean).join(" ")),
    groupId: `M2:${spec.product_id}\u0000${spec.param_class}\u0000${spec.param_name}`,
    groupKey: [product.model, spec.param_class, spec.param_name].filter(Boolean).join("/"),
    conflictValue: spec.value,
  };
}

function fromCapability(cap: Capability): ScannedRow {
  return {
    table: "M3",
    id: cap.id,
    source: text(cap.source),
    authorityRaw: cap.source_authority,
    evidenceRaw: cap.evidence_level,
    fields: pick(cap as unknown as Record<string, unknown>, [
      "domain",
      "name",
      "description",
      "maturity",
      "dependency",
    ]),
    summary: brief([cap.domain, cap.name].filter(Boolean).join(" ")),
    groupId: `M3:${cap.product_line_id}\u0000${cap.domain}\u0000${cap.name}`,
    groupKey: [cap.domain, cap.name].filter(Boolean).join("/"),
    // 与入库冲突口径一致：描述 + 成熟度都算「值」
    conflictValue: `${cap.description}｜${cap.maturity}`,
  };
}

function fromBoundary(boundary: Boundary): ScannedRow {
  return {
    table: "M4",
    id: boundary.id,
    source: text(boundary.source),
    authorityRaw: boundary.source_authority,
    evidenceRaw: boundary.evidence_level,
    fields: pick(boundary as unknown as Record<string, unknown>, [
      "description",
      "reason",
      "has_plan",
      "response",
      "owner",
    ]),
    summary: brief(boundary.description),
    groupId: `M4:${boundary.product_line_id}\u0000${normalizeValue(boundary.description)}`,
    groupKey: boundary.description,
    // M4 的「值」是依据：同一条「不做」依据不同，才是需要人裁决的冲突
    conflictValue: boundary.reason,
  };
}

function fromLimitation(limitation: Limitation): ScannedRow {
  return {
    table: "M5",
    id: limitation.id,
    source: text(limitation.source),
    authorityRaw: limitation.source_authority,
    evidenceRaw: limitation.evidence_level,
    fields: pick(limitation as unknown as Record<string, unknown>, [
      "product_name",
      "description",
      "impact",
      "fix_status",
      "external_visible",
      "owner",
    ]),
    summary: brief(
      [limitation.product_name, limitation.description].filter(Boolean).join(" "),
    ),
  };
}

function fromQuote(quote: PriceQuote): ScannedRow {
  return {
    table: "M6",
    id: quote.id,
    source: text(quote.source),
    authorityRaw: quote.source_authority,
    evidenceRaw: quote.evidence_level,
    fields: pick(quote as unknown as Record<string, unknown>, [
      "model",
      "config",
      "unit_price",
      "price_scope",
      "valid_until",
    ]),
    summary: brief([quote.model, quote.config].filter(Boolean).join(" ")),
  };
}

function fromOptional(item: OptionalMaterial, table: AuditTable): ScannedRow {
  const payload = (item.payload ?? {}) as Record<string, unknown>;
  const fields = { ...scalarFields(payload), category: item.category };
  return {
    table,
    id: item.id,
    source: text(item.source),
    authorityRaw: item.source_authority,
    evidenceRaw: item.evidence_level,
    fields,
    summary: brief(optionalSummary(payload)),
  };
}

/** 可选材料的一行摘要：优先取该类别最有辨识度的字段 */
function optionalSummary(payload: Record<string, unknown>): string {
  const candidates = [
    "cert_name",
    "cert_no",
    "project_name",
    "name",
    "feature",
    "item",
    "partner_name",
    "doc_name",
    "model",
  ];
  for (const key of candidates) {
    const value = text(payload[key]);
    if (value) return value;
  }
  return Object.values(payload)
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .join(" ");
}

// ─── 冲突 ──────────────────────────────────────────────────

/**
 * 同键不同值分组。
 *
 * 只报告、不写库：哪一份材料可信由人裁决（标准 §二）。值按归一化去重，
 * 同一取值来自两份材料不算冲突（那只是重复）。
 */
function findConflicts(rows: readonly ScannedRow[]): AuditConflict[] {
  const groups = new Map<
    string,
    { table: string; key: string; values: Map<string, AuditConflictValue> }
  >();

  for (const row of rows) {
    if (!row.groupId || row.conflictValue === undefined) continue;
    const group = groups.get(row.groupId) ?? {
      table: row.table,
      key: row.groupKey ?? row.groupId,
      values: new Map<string, AuditConflictValue>(),
    };
    const normalized = normalizeValue(row.conflictValue);
    if (!group.values.has(normalized)) {
      group.values.set(normalized, {
        value: row.conflictValue,
        source: row.source,
        row_id: row.id,
      });
    }
    groups.set(row.groupId, group);
  }

  const order = new Map(AUDIT_TABLES.map((table, i) => [table, i]));
  return [...groups.values()]
    .filter((group) => group.values.size > 1)
    .map((group) => ({
      table: group.table,
      key: group.key,
      values: [...group.values.values()],
    }))
    .sort(
      (a, b) =>
        (order.get(a.table as AuditTable) ?? 99) - (order.get(b.table as AuditTable) ?? 99) ||
        a.key.localeCompare(b.key, "zh"),
    );
}

// ─── 写回 ──────────────────────────────────────────────────

/** 只更新 evidence_level；返回是否真的落库（行已被删时 false） */
function writeEvidence(
  db: DbInstance,
  table: AuditTable,
  id: string,
  level: "A" | "B" | "C" | "D",
): boolean {
  const patch = { evidence_level: level } as never;
  try {
    switch (table) {
      case "M1":
        return Boolean(db.productRepo.update(id, patch));
      case "M2":
        return Boolean(db.specParamRepo.update(id, patch));
      case "M3":
        return Boolean(db.capabilityRepo.update(id, patch));
      case "M4":
        return Boolean(db.boundaryRepo.update(id, patch));
      case "M5":
        return Boolean(db.limitationRepo.update(id, patch));
      case "M6":
        return Boolean(db.quoteRepo.update(id, patch));
      default:
        return Boolean(db.optionalMaterialRepo.update(id, patch));
    }
  } catch {
    // 单行写入失败不该让整次体检中断；调用方按未降级处理（下次体检会再尝试）
    return false;
  }
}

// ─── 小工具 ────────────────────────────────────────────────

function text(value: unknown): string {
  return String(value ?? "").trim();
}

/** 行摘要：压缩空白后最多 20 字（超出加省略号） */
export function brief(value: string, max = 20): string {
  const clean = String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  const chars = [...clean];
  // 截断时把省略号也算进上限，保证「行摘要 20 字」是硬上限
  return chars.length <= max ? clean : `${chars.slice(0, max - 1).join("")}…`;
}

/** 取指定列里的标量字段（对象/数组不参与绝对化检查，与入库一致） */
function pick(row: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
  }
  return out;
}

/** 行内标量字段（对象/数组不参与绝对化检查，与入库一致） */
function scalarFields(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
  }
  return out;
}

/** 命中词（去重，按词表顺序，避免字段遍历顺序影响展示） */
function absoluteTermsOf(fields: Record<string, string>): string[] {
  const hits = new Set<string>();
  for (const value of Object.values(fields)) {
    for (const term of findAbsoluteTerms(value)) hits.add(term);
  }
  return ABSOLUTE_TERMS.filter((term) => hits.has(term));
}

/**
 * 来源串 → 文件名（只用于给类目判定补线索）
 *
 * URL 没有「文件名:页码」结构，直接返回空；文件来源取最后一个冒号前的内容
 * （与 `library-gate` / `library-materials` 同口径）。
 */
function fileNameOfSource(source: string): string {
  if (/^https?:\/\//iu.test(source)) return "";
  const colon = Math.max(source.lastIndexOf(":"), source.lastIndexOf("："));
  return colon > 0 ? source.slice(0, colon).trim() : "";
}
