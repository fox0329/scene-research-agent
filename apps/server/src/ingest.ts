/**
 * @scene/server — ingest command（上传材料→解析→归类入库）
 *
 * 应用层编排：infra(docParser / dshClient / db) + domain(assessQuality / checkCompleteness)
 * 流程：解析文件 → 组 prompt → DSH 分类 → 来源校验 → 写库 → 质量评估
 *
 * M2 优化：大文件分块（R2）暂不处理
 */

import { basename } from "node:path";
import type {
  DshClient,
  SessionHandle,
  Product,
  SpecParam,
  Capability,
  Boundary,
  Limitation,
  OptionalMaterial,
} from "@scene/contract";
import type { ParseResult } from "@scene/infra";
import { createSourceLookup, upsertSourcePages } from "@scene/infra";
import type { DbInstance } from "@scene/infra";
import { resolveProductForModel, upsertSpecParam } from "./library-service.js";
import { evaluateGates, normalizeModel } from "@scene/domain";
import type {
  QualityAssessment,
  CompletenessReport,
} from "@scene/domain";
import {
  assessQuality,
  checkCompleteness,
  spotCheckSources,
  gradeSourceByCategory,
} from "@scene/domain";
import type { SourceSpotCheckReport } from "@scene/domain";
import type { Authority } from "@scene/contract";

// ─── 依赖注入接口 ──────────────────────────────────────────

/** 文档解析器签名（与 infra/src/doc-parser.ts 对齐） */
export interface DocParser {
  (filePath: string): Promise<ParseResult>;
}

/** ingest command 依赖 */
export interface IngestDeps {
  db: DbInstance;
  dshClient: DshClient;
  docParser: DocParser;
}

/** ingest 执行参数 */
export interface IngestOpts {
  filePath: string;
  productLineId: string;
  /**
   * 材料的**真实文件名**（G-R0 溯源与"按文件删"都靠它，变更表 #156）
   *
   * 为什么必须显式传：上传路由落盘用的是临时名（`ingest-<ts>-<n>.pptx`），而
   * `basename(filePath)` 拿到的是这个临时名——模型照着 prompt 抄，于是行上的 source 变成
   * `ingest-1790179606669-44.docx:10`，谁都认不出这是哪份材料（实测库里 474 条全这样）。
   * 缺省仍取 filePath 的 basename（对话导入等场景本来就是真实路径）。
   */
  fileName?: string;
}

/** ingest 返回结果 */
export interface IngestResult {
  rowsInserted: number;
  /** 每张表插入行数（M1-M5 / O1-O6），入库反馈用 */
  tableCounts: Record<string, number>;
  /** 并入已有型号的 M1 行数（没新建产品行——旧实现每批材料都会造重复行） */
  mergedProducts: number;
  qualityAssessment: QualityAssessment;
  completenessReport: CompletenessReport;
  /**
   * M1–M5 / 可选材料 的输出门限体检结果。
   * 这几张表走入库路径，阶段推进时才跑的门限管不到它们（专家审阅 2026-10-20 指出的通路缺口）。
   */
  gateFindings: { tableCode: string; label: string; gate: string; detail: string }[];
}

// ─── DSH 产出 JSON 结构 ────────────────────────────────────

/** DSH 返回的单条归类记录 */
interface ClassifiedRow {
  /** 目标表编号：M1-M5 / O1-O6 */
  table_code: string;
  /** 该行字段值 */
  fields: Record<string, unknown>;
  /** 来源标注（文件名:页码） */
  source: string;
}

/** DSH 返回的完整 JSON */
interface DshOutput {
  rows: ClassifiedRow[];
}

// ─── 输出 JSON Schema（Function Calling 注入） ─────────────

const OUTPUT_CONTRACT: Record<string, unknown> = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        required: ["table_code", "fields", "source"],
        properties: {
          table_code: {
            type: "string",
            enum: ["M1", "M2", "M3", "M4", "M5", "O1", "O2", "O3", "O4", "O5", "O6"],
            description: "目标表编号",
          },
          fields: {
            type: "object",
            description: "该行的字段键值对，字段名必须与表 schema 一致",
          },
          source: {
            type: "string",
            description: "来源标注，格式：文件名:页码，如 白皮书.pdf:12",
          },
        },
      },
    },
  },
  required: ["rows"],
};

// ─── System Prompt 构建 ────────────────────────────────────

const SYSTEM_PROMPT = `你是产品资料解析专家。你的任务是将输入的产品文档内容按表格分类归入以下 12 张表：

## M1 产品型号
字段：model(型号), name(产品名称), status(在售/停售/在研/规划/待确认), launch_date(发布日期), former_name(曾用名), position_desc(定位描述)
必填：model, name, status, launch_date, position_desc

## M2 规格参数
字段：param_class(参数类别), param_name(参数名称), value(参数值), measured(实测/宣称/未提及)
必填：param_class, param_name, value, measured
注意：每条 spec_param 需关联到 M1 中的某个产品，用 fields.product_model 指定关联的 model 字段值

## M3 能力清单
字段：domain(领域), name(能力名称), description(描述), maturity(已交付/组件具备/在研/规划), dependency(依赖项), inapplicable_scene(不适用场景)
必填：domain, name, description, maturity, dependency

## M4 边界声明（不做什么）
字段：description(不做的事), reason(原因), has_plan(有/无/未定), response(客户要求时怎么办), owner(负责人)
必填：description, reason, has_plan, response, owner

## M5 已知限制
字段：product_name(产品名称), description(限制描述), impact(高/中/低), fix_status(已修复/修复中/无计划/硬件限制), external_visible(可提/内部可提/不可提), owner(负责人)
必填：product_name, description, impact, fix_status, external_visible, owner

## O1-O6 可选材料（fields 的键名必须逐字用下面这些，否则入不了表）
- O1认证：model(型号), cert_type(证书类型), cert_no(证书号), valid_until(有效期至), issuer(发证机构), covered_models(覆盖型号)
- O2案例：name(案例名), scene(场景), delivered_at(交付时间), acceptance(验收指标与结果)
- O3价格：item(产品/服务), pricing_model(计价方式), price(价格或区间)
- O4SDK：product(产品), doc_name(资料名称) 及其余开发资料字段（见表格定义）
- O5路线图：feature(功能), expected_release(预计时间), priority(优先级)
- O6生态：partner_name(伙伴名称), integration_type(集成方式), maturity(成熟度)
注意：证书号、有效期、发证机构、交付时间、验收指标都是必填，材料里没有就写「未提及」，不要换键名。

## 来源标注规则
每条记录的 source 字段必须包含"文件名:页码"（如 whitepaper.pdf:12）。
如果你无法确定页码，用文件名加推测的位置（如 whitepaper.pdf:未知）。
如果文档内容完全无法确定来源，用文件名作为最低来源。

## 输出格式
输出 JSON 对象，包含 rows 数组。每条记录包含 table_code、fields、source 三个字段。
只输出文档中确实存在的数据，不要编造或推测不存在的信息。`;

// ─── 工厂函数 ──────────────────────────────────────────────

/**
 * 创建 ingest command。
 *
 * @param deps - 注入的依赖（db / dshClient / docParser）
 * @returns 包含 execute 方法的 command 对象
 */
export function createIngestCommand(deps: IngestDeps) {
  return {
    execute: (opts: IngestOpts) => executeIngest(deps, opts),
  };
}

// ─── 主流程 ────────────────────────────────────────────────

async function executeIngest(
  deps: IngestDeps,
  opts: IngestOpts,
): Promise<IngestResult> {
  const { db, dshClient, docParser } = deps;
  const { filePath, productLineId } = opts;

  // 1. 解析文件
  const parseResult = await docParser(filePath);
  // 真实文件名优先（上传路由传进来）；没有才退回路径的文件名
  const fileName = opts.fileName?.trim() || basename(filePath);

  // 1.5 原文按页落库（变更表 #212）
  //
  // 为什么必须在入库时做：`source_fts.content` 是业务字段拼接，拿它核「该页确有
  // 这句话」等于自证。原文只在这一刻还在手上（解析结果），落下来之后
  // G-R8 与来源抽查才有真依据。失败不阻断入库——原文存储是溯源增强。
  if (parseResult.pages?.length) {
    try {
      upsertSourcePages(db.db, fileName, parseResult.pages);
    } catch {
      // 老库没有 source_page 表 / 磁盘只读等情况：不影响本次入库
    }
  }

  // 2. 组 user prompt
  const userPrompt = buildUserPrompt(fileName, parseResult);

  // 3. 调用 DSH 流式获取结构化产出
  const session = await dshClient.createSession({ title: `ingest:${fileName}` });
  const dshOutput = await consumeDshPrompt(dshClient, session, userPrompt);

  // 4. 验证产出（来源校验 + 丢弃无效行）
  const validRows = validateRows(dshOutput, fileName);

  // 5. 写入数据库
  const { inserted, tableCounts, mergedProducts } = writeRows(db, validRows, productLineId, fileName);

  // 6. 质量评估 + 完成度检查
  const gateFindings = runIngestGates(db, productLineId);
  const qualityAssessment = buildQualityAssessment(db, productLineId);
  const completenessReport = buildCompletenessReport(db, productLineId);

  return {
    rowsInserted: inserted,
    tableCounts,
    mergedProducts,
    qualityAssessment,
    completenessReport,
    gateFindings,
  };
}

/**
 * 入库后跑 M1–M5 / 可选材料的输出门限。
 *
 * 为什么不复用 stage_data：产品侧数据在 product / spec_param 等表，不是场景表；
 * 门限要的是「同一口径的行集合」，这里按表适配成 GateRow。
 */
function runIngestGates(
  db: DbInstance,
  productLineId: string,
): { tableCode: string; label: string; gate: string; detail: string }[] {
  /* 单测里的 DbInstance 是 mock（无原生连接），此时跳过体检而不是让入库失败 */
  if (typeof db.db?.prepare !== "function") return [];
  const rows: { id: string; tableCode: string; row: Record<string, unknown> }[] = [];
  const q = <T>(sql: string): T[] => db.db.prepare(sql).all(productLineId) as T[];

  for (const r of q<{ id: string; model: string; name: string; status: string }>(
    "SELECT id, model, name, status FROM product WHERE product_line_id = ?",
  )) {
    rows.push({ id: r.id, tableCode: "M1", row: { model: r.model, name: r.name, status: r.status } });
  }
  for (const r of q<{ id: string; model: string; param_class: string; param_name: string; value: string }>(
    `SELECT s.id, p.model, s.param_class, s.param_name, s.value
       FROM spec_param s JOIN product p ON p.id = s.product_id WHERE p.product_line_id = ?`,
  )) {
    rows.push({ id: r.id, tableCode: "M2", row: { ...r, product_id: r.model } });
  }
  for (const r of q<{ id: string; domain: string; name: string; maturity: string; inapplicable_scene: string }>(
    "SELECT id, domain, name, maturity, inapplicable_scene FROM capability WHERE product_line_id = ?",
  )) {
    rows.push({ id: r.id, tableCode: "M3", row: r });
  }
  for (const r of q<{ id: string; description: string; response: string }>(
    "SELECT id, description, response FROM boundary WHERE product_line_id = ?",
  )) {
    rows.push({ id: r.id, tableCode: "M4", row: r });
  }
  for (const r of q<{ id: string; product_name: string; description: string }>(
    "SELECT id, product_name, description FROM limitation WHERE product_line_id = ?",
  )) {
    rows.push({ id: r.id, tableCode: "M5", row: r });
  }
  for (const r of q<{ id: string; category: string; payload: string }>(
    "SELECT id, category, payload FROM optional_material WHERE product_line_id = ?",
  )) {
    /* payload 是 JSON，必须摊平：证书号/有效期/发证机构都在里面，不摊平永远判不到 */
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
    } catch {
      body = {};
    }
    rows.push({ id: r.id, tableCode: "可选材料", row: { ...body, category: r.category } });
  }

  return evaluateGates(rows).map((f) => ({
    tableCode: f.tableCode,
    label: f.label,
    gate: f.gate,
    detail: f.detail,
  }));
}

// ─── 子函数：组 user prompt ────────────────────────────────

function buildUserPrompt(fileName: string, parseResult: ParseResult): string {
  const parts: string[] = [];

  parts.push(`以下是文件「${fileName}」的解析内容，请按表格分类归入。`);
  parts.push("");

  if (parseResult.text) {
    parts.push("## 纯文本内容");
    parts.push(parseResult.text);
    parts.push("");
  }

  if (parseResult.tables.length > 0) {
    parts.push("## 表格内容");
    for (let i = 0; i < parseResult.tables.length; i++) {
      const table = parseResult.tables[i]!;
      parts.push(`### 表格 ${i + 1}`);
      parts.push(table.headers.join(" | "));
      parts.push(table.headers.map(() => "---").join(" | "));
      for (const row of table.rows) {
        parts.push(row.join(" | "));
      }
      parts.push("");
    }
  }

  if (parseResult.metadata.pageCount) {
    parts.push(`（文档共 ${parseResult.metadata.pageCount} 页）`);
  }
  if (parseResult.metadata.sheetCount) {
    parts.push(`（文档共 ${parseResult.metadata.sheetCount} 个 sheet）`);
  }

  parts.push("");
  parts.push("请将上述内容按 M1-M5、O1-O6 表格分类，输出 JSON。每条记录的 source 字段必须包含「文件名:页码」。");

  return parts.join("\n");
}

// ─── 子函数：消费 DSH 流 ──────────────────────────────────

/**
 * 消费 dshClient.prompt() 的 AsyncIterable，拼接所有文本，
 * 尝试解析为 DshOutput JSON。
 *
 * 失败时返回 { rows: [] }（降级：标记为待人工）。
 */
export async function consumeDshPrompt(
  dshClient: DshClient,
  session: SessionHandle,
  userPrompt: string,
): Promise<DshOutput> {
  const stream = dshClient.prompt(session, {
    system: SYSTEM_PROMPT,
    user: userPrompt,
    outputContract: OUTPUT_CONTRACT,
  });

  let fullText = "";

  for await (const event of stream) {
    if (event.type === "text") {
      fullText += (event as { type: "text"; text: string }).text;
    }
    if (event.type === "error") {
      // DSH 错误 → 返回空结果（降级）
      return { rows: [] };
    }
  }

  return parseDshOutput(fullText);
}

/**
 * 从 DSH 输出文本中提取 JSON。
 * 优先找 Function Calling 参数（JSON 对象），其次找 ```json 代码块，最后尝试整体 parse。
 */
function parseDshOutput(text: string): DshOutput {
  const trimmed = text.trim();

  // 1. 尝试直接 parse 整体
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isDshOutput(parsed)) return parsed;
  } catch {
    // 继续
  }

  // 2. 尝试从 ```json ... ``` 代码块提取
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch?.[1]) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim()) as unknown;
      if (isDshOutput(parsed)) return parsed;
    } catch {
      // 继续
    }
  }

  // 3. 尝试找第一个 { 开始的 JSON 对象
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart)) as unknown;
      if (isDshOutput(parsed)) return parsed;
    } catch {
      // 继续
    }
  }

  // 解析失败 → 返回空（标记为待人工）
  return { rows: [] };
}

/** 类型守卫：是否为合法的 DshOutput（只检查顶层结构，行级校验在 validateRows） */
function isDshOutput(val: unknown): val is DshOutput {
  if (typeof val !== "object" || val === null) return false;
  const obj = val as Record<string, unknown>;
  return Array.isArray(obj["rows"]);
}

// ─── 子函数：来源校验 ──────────────────────────────────────

/** 校验规则：table_code 和 source 必须合法，缺则丢弃 */
function validateRows(output: DshOutput, fileName: string): ClassifiedRow[] {
  const validTables = new Set([
    "M1", "M2", "M3", "M4", "M5",
    "O1", "O2", "O3", "O4", "O5", "O6",
  ]);
  const valid: ClassifiedRow[] = [];

  for (const row of output.rows) {
    // table_code 必须是合法的表编号
    if (!row.table_code || !validTables.has(row.table_code)) continue;
    // source 必须含文件名 + 页码
    if (!isValidSource(row.source, fileName)) continue;
    valid.push(row);
  }

  return valid;
}

/**
 * 来源校验：
 * 1. source 非空
 * 2. 文件名部分非空（不强制等于上传文件名——AI 可能引用补充资料）
 * 3. 包含页码或"未知"标记
 */
function isValidSource(source: string, _fileName: string): boolean {
  if (!source || source.trim().length === 0) return false;

  // 必须有文件名部分（: 分隔）
  const colonIndex = source.lastIndexOf(":");
  if (colonIndex <= 0) return false;

  const filePart = source.slice(0, colonIndex);
  const pagePart = source.slice(colonIndex + 1);

  // 文件名部分必须非空（与上传文件名匹配优先，但也接受其他文件名模式）
  if (filePart.trim().length === 0) return false;

  // 页码部分必须存在（数字、"未知"、或范围如 12-14）
  if (pagePart.trim().length === 0) return false;

  return true;
}

// ─── 子函数：写入数据库 ────────────────────────────────────

/** M2 的 product_model 关联需先解析为 product_id */
function writeRows(
  db: DbInstance,
  rows: ClassifiedRow[],
  productLineId: string,
  fileName: string,
): { inserted: number; tableCounts: Record<string, number>; mergedProducts: number } {
  let inserted = 0;
  /** 并入已有型号的 M1 行数（没新建产品行，但材料内容已补进去） */
  let mergedProducts = 0;
  const tableCounts: Record<string, number> = {};
  const count = (table: string) => {
    tableCounts[table] = (tableCounts[table] ?? 0) + 1;
    inserted++;
  };
  // model → product_id 缓存（同一次 ingest 内共享）
  const modelToProductId = new Map<string, string>();

  // 先遍历一次，把 M1 行落到产品（已有型号并入、没有才新建），收集 model → id 映射
  for (const row of rows) {
    if (row.table_code !== "M1") continue;
    const { productId, created } = resolveProductForModel(db, productLineId, row.fields, row.source, fileName);
    if (!productId) continue;
    // 用归一型号做 key：材料里写出「在鸿 7885平板」时也要能接到已有「在鸿7885平板」
    modelToProductId.set(normalizeModel(String(row.fields["model"] ?? "")), productId);
    if (created) count("M1");
    else mergedProducts += 1;
  }

  // 再遍历，写入其余表
  for (const row of rows) {
    if (row.table_code === "M1") continue;

    switch (row.table_code) {
      case "M2": {
        const ok = insertSpecParam(db, row, productLineId, modelToProductId, fileName);
        if (ok) count("M2");
        break;
      }
      case "M3": {
        const ok = insertCapability(db, row, productLineId, fileName);
        if (ok) count("M3");
        break;
      }
      case "M4": {
        const ok = insertBoundary(db, row, productLineId, fileName);
        if (ok) count("M4");
        break;
      }
      case "M5": {
        const ok = insertLimitation(db, row, productLineId, fileName);
        if (ok) count("M5");
        break;
      }
      default: {
        // O1-O6
        if (row.table_code.startsWith("O")) {
          const ok = insertOptionalMaterial(db, row, productLineId, fileName);
          if (ok) count(row.table_code);
        }
        break;
      }
    }
  }

  return { inserted, tableCounts, mergedProducts };
}

/**
 * 一条入库记录的来源权威性（变更表 #210）
 *
 * 原来四处硬编码 "T3"：材料是国标还是自媒体，入库时全按「参考」算，
 * 权威性分级形同虚设。现在按**材料类目**判（法规标准/政府文件→T1，
 * 厂商官方/年报/行业报告→T2，媒体→T3，自媒体/口述→T4），
 * 与"谁录进来的"（source_type）解耦。
 */
/**
 * 抽查的容错包装：材料库反查不可用时返回 undefined（退化成旧口径），不抛错
 *
 * 为什么必须容错：入库是主流程，抽查只是质量增强。索引表缺失、假库、
 * 老库未建 FTS 都可能让反查失败——为此把整次入库打挂是本末倒置。
 */
function safeSpotCheck(
  db: DbInstance,
  records: {
    products: Product[];
    specParams: SpecParam[];
    capabilities: Capability[];
    boundaries: Boundary[];
    limitations: Limitation[];
  },
): SourceSpotCheckReport | undefined {
  try {
    return spotCheckSources(createSourceLookup(db.db), records);
  } catch {
    return undefined;
  }
}

function authorityOf(source: string, fileName: string): Authority {
  return gradeSourceByCategory("AI提取", source, fileName).authority;
}

function insertSpecParam(
  db: DbInstance,
  row: ClassifiedRow,
  _productLineId: string,
  modelToProductId: Map<string, string>,
  fileName: string,
): boolean {
  const f = row.fields;
  const productModel = String(f["product_model"] ?? "");
  const productId =
    modelToProductId.get(productModel) ?? modelToProductId.get(normalizeModel(productModel));
  if (!productId) return false;

  try {
    // upsert：同产品 + 同类别 + 同名称下，完全相同的不再写第二遍，
    // 新材料更完整时用完整那句覆盖（历史库里 843 行有 53 行完全重复就是这么来的）
    return upsertSpecParam(db, productId, f as Record<string, unknown>, row.source, fileName);
  } catch {
    return false;
  }
}

function insertCapability(
  db: DbInstance,
  row: ClassifiedRow,
  productLineId: string,
  fileName: string,
): boolean {
  const f = row.fields;
  try {
    db.capabilityRepo.insert({
      product_line_id: productLineId,
      domain: String(f["domain"] ?? ""),
      name: String(f["name"] ?? ""),
      description: String(f["description"] ?? ""),
      maturity: (f["maturity"] as Capability["maturity"]) ?? "规划",
      dependency: String(f["dependency"] ?? ""),
      inapplicable_scene: f["inapplicable_scene"]
        ? String(f["inapplicable_scene"])
        : undefined,
      source_type: "AI提取",
      source: row.source,
      source_authority: authorityOf(row.source, fileName),
      evidence_level: "B",
    });
    return true;
  } catch {
    return false;
  }
}

function insertBoundary(
  db: DbInstance,
  row: ClassifiedRow,
  productLineId: string,
  fileName: string,
): boolean {
  const f = row.fields;
  try {
    db.boundaryRepo.insert({
      product_line_id: productLineId,
      description: String(f["description"] ?? ""),
      reason: String(f["reason"] ?? ""),
      has_plan: (f["has_plan"] as Boundary["has_plan"]) ?? "未定",
      response: String(f["response"] ?? ""),
      owner: String(f["owner"] ?? ""),
      plan_date: f["plan_date"] ? String(f["plan_date"]) : undefined,
      source_type: "AI提取",
      source: row.source,
      source_authority: authorityOf(row.source, fileName),
      evidence_level: "B",
    });
    return true;
  } catch {
    return false;
  }
}

function insertLimitation(
  db: DbInstance,
  row: ClassifiedRow,
  productLineId: string,
  fileName: string,
): boolean {
  const f = row.fields;
  try {
    db.limitationRepo.insert({
      product_line_id: productLineId,
      product_name: String(f["product_name"] ?? ""),
      description: String(f["description"] ?? ""),
      impact: (f["impact"] as Limitation["impact"]) ?? "中",
      fix_status: (f["fix_status"] as Limitation["fix_status"]) ?? "无计划",
      external_visible:
        (f["external_visible"] as Limitation["external_visible"]) ?? "内部可提",
      owner: String(f["owner"] ?? ""),
      source_type: "AI提取",
      source: row.source,
      source_authority: authorityOf(row.source, fileName),
      evidence_level: "B",
    });
    return true;
  } catch {
    return false;
  }
}


function insertOptionalMaterial(
  db: DbInstance,
  row: ClassifiedRow,
  productLineId: string,
  fileName: string,
): boolean {
  // O1-O6 → category 映射
  const categoryMap: Record<string, OptionalMaterial["category"]> = {
    O1: "O1认证",
    O2: "O2案例",
    O3: "O3价格",
    O4: "O4SDK",
    O5: "O5路线图",
    O6: "O6生态",
  };

  const category = categoryMap[row.table_code];
  if (!category) return false;

  try {
    db.optionalMaterialRepo.insert({
      product_line_id: productLineId,
      category,
      payload: row.fields,
      source_type: "AI提取",
      source: row.source,
      source_authority: authorityOf(row.source, fileName),
      evidence_level: "B",
    });
    return true;
  } catch {
    return false;
  }
}

// ─── 子函数：质量评估 + 完成度检查 ────────────────────────

function buildQualityAssessment(
  db: DbInstance,
  productLineId: string,
): QualityAssessment {
  const products = db.productRepo.list({
    where: "product_line_id = ?",
    params: [productLineId],
  }) as Product[];
  const specParams = db.specParamRepo.list() as SpecParam[];
  const boundaries = db.boundaryRepo.list({
    where: "product_line_id = ?",
    params: [productLineId],
  }) as Boundary[];
  const limitations = db.limitationRepo.list({
    where: "product_line_id = ?",
    params: [productLineId],
  }) as Limitation[];

  // 过滤属于该产品线的 specParam（通过 product 关联）
  const productIds = new Set(products.map((p) => p.id));
  const filteredSpecParams = specParams.filter((sp) =>
    productIds.has(sp.product_id),
  );

  return assessQuality(products, filteredSpecParams, boundaries, limitations);
}

function buildCompletenessReport(
  db: DbInstance,
  productLineId: string,
): CompletenessReport {
  const products = db.productRepo.list({
    where: "product_line_id = ?",
    params: [productLineId],
  }) as Product[];
  const specParams = db.specParamRepo.list() as SpecParam[];
  const capabilities = db.capabilityRepo.list({
    where: "product_line_id = ?",
    params: [productLineId],
  }) as Capability[];
  const boundaries = db.boundaryRepo.list({
    where: "product_line_id = ?",
    params: [productLineId],
  }) as Boundary[];
  const limitations = db.limitationRepo.list({
    where: "product_line_id = ?",
    params: [productLineId],
  }) as Limitation[];

  const productIds = new Set(products.map((p) => p.id));
  const filteredSpecParams = specParams.filter((sp) =>
    productIds.has(sp.product_id),
  );

  // 来源抽查真核对（G-R3，变更表 #211）：逐条回原文验证出处与内容，
  // 不再只看"有没有标来源"——标了但查不到，等于没核。
  //
  // 检索不可用时（如测试里的假库、或索引表缺失）**不阻断入库**：
  // 抽查是质量增强，不是前置条件；拿不到结果就退化成旧口径。
  const spotCheck = safeSpotCheck(db, {
    products,
    specParams: filteredSpecParams,
    capabilities,
    boundaries,
    limitations,
  });

  return checkCompleteness(
    products,
    filteredSpecParams,
    capabilities,
    boundaries,
    limitations,
    spotCheck,
  );
}