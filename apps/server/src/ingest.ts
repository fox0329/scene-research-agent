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
import type { DbInstance } from "@scene/infra";
import { resolveProductForModel, upsertSpecParam } from "./library-service.js";
import { normalizeModel } from "@scene/domain";
import type {
  QualityAssessment,
  CompletenessReport,
} from "@scene/domain";
import { assessQuality, checkCompleteness } from "@scene/domain";

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

## O1-O6 可选材料
- O1认证：fields 含 cert_name, cert_body, cert_date, scope
- O2案例：fields 含 project_name, client, year, scale, summary
- O3价格：fields 含 model, price, currency, channel, date
- O4SDK：fields 含 name, version, language, url, maturity
- O5路线图：fields 含 feature, expected_release, priority
- O6生态：fields 含 partner_name, integration_type, maturity

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
  const fileName = basename(filePath);

  // 2. 组 user prompt
  const userPrompt = buildUserPrompt(fileName, parseResult);

  // 3. 调用 DSH 流式获取结构化产出
  const session = await dshClient.createSession({ title: `ingest:${fileName}` });
  const dshOutput = await consumeDshPrompt(dshClient, session, userPrompt);

  // 4. 验证产出（来源校验 + 丢弃无效行）
  const validRows = validateRows(dshOutput, fileName);

  // 5. 写入数据库
  const { inserted, tableCounts, mergedProducts } = writeRows(db, validRows, productLineId);

  // 6. 质量评估 + 完成度检查
  const qualityAssessment = buildQualityAssessment(db, productLineId);
  const completenessReport = buildCompletenessReport(db, productLineId);

  return { rowsInserted: inserted, tableCounts, mergedProducts, qualityAssessment, completenessReport };
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
    const { productId, created } = resolveProductForModel(db, productLineId, row.fields, row.source);
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
        const ok = insertSpecParam(db, row, productLineId, modelToProductId);
        if (ok) count("M2");
        break;
      }
      case "M3": {
        const ok = insertCapability(db, row, productLineId);
        if (ok) count("M3");
        break;
      }
      case "M4": {
        const ok = insertBoundary(db, row, productLineId);
        if (ok) count("M4");
        break;
      }
      case "M5": {
        const ok = insertLimitation(db, row, productLineId);
        if (ok) count("M5");
        break;
      }
      default: {
        // O1-O6
        if (row.table_code.startsWith("O")) {
          const ok = insertOptionalMaterial(db, row, productLineId);
          if (ok) count(row.table_code);
        }
        break;
      }
    }
  }

  return { inserted, tableCounts, mergedProducts };
}

function insertSpecParam(
  db: DbInstance,
  row: ClassifiedRow,
  _productLineId: string,
  modelToProductId: Map<string, string>,
): boolean {
  const f = row.fields;
  const productModel = String(f["product_model"] ?? "");
  const productId =
    modelToProductId.get(productModel) ?? modelToProductId.get(normalizeModel(productModel));
  if (!productId) return false;

  try {
    // upsert：同产品 + 同类别 + 同名称下，完全相同的不再写第二遍，
    // 新材料更完整时用完整那句覆盖（历史库里 843 行有 53 行完全重复就是这么来的）
    return upsertSpecParam(db, productId, f as Record<string, unknown>, row.source);
  } catch {
    return false;
  }
}

function insertCapability(
  db: DbInstance,
  row: ClassifiedRow,
  productLineId: string,
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
      source_authority: "T3",
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
      source_authority: "T3",
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
      source_authority: "T3",
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
      source_authority: "T3",
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

  return checkCompleteness(
    products,
    filteredSpecParams,
    capabilities,
    boundaries,
    limitations,
  );
}