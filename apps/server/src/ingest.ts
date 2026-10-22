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
  PriceQuote,
  OptionalMaterial,
  EvidenceLevel,
} from "@scene/contract";
import { TABLES_BY_CODE, VERIFICATION_KEYS } from "@scene/contract";
import type { ParseResult } from "@scene/infra";
import { createSourceLookup, upsertSourcePages } from "@scene/infra";
import type { DbInstance } from "@scene/infra";
import { resolveProductForModel, upsertSpecParam } from "./library-service.js";
import { boundaryEvidenceError, isLocatableSource } from "./library-gate.js";
import { evaluateGates, isEmptyValue, normalizeModel, normalizeValue } from "@scene/domain";
import type {
  QualityAssessment,
  CompletenessReport,
} from "@scene/domain";
import {
  assessQuality,
  checkCompleteness,
  spotCheckSources,
  classifyLibrarySource,
  findAbsoluteTerms,
  gradeIncomingEvidence,
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

/** 证据等级分布（本次入库行的 B/C 等） */
export interface IngestEvidenceSummary {
  A: number;
  B: number;
  C: number;
  D: number;
}

/** 命中绝对化措辞的行（不删除，降为 C 并留痕） */
export interface IngestFlaggedRow {
  table_code: string;
  /** 行标识（型号/参数/能力名等，便于人工回查） */
  key: string;
  /** 命中字段（英文字段名） */
  field: string;
  /** 命中词 */
  term: string;
  /** 固定原因文案 */
  reason: string;
}

/** 同键不同值的冲突（保留原值，不覆盖、不新增） */
export interface IngestConflict {
  table_code: string;
  /** 行标识 */
  key: string;
  /** 库里已有值 */
  existing: string;
  /** 新材料给的值 */
  incoming: string;
  /** 新材料来源 */
  source: string;
}

/** ingest 返回结果 */
export interface IngestResult {
  rowsInserted: number;
  /** 每张表插入行数（M1–M6 / O1–O6），入库反馈用 */
  tableCounts: Record<string, number>;
  /** 并入已有型号的 M1 行数（没新建产品行——旧实现每批材料都会造重复行） */
  mergedProducts: number;
  qualityAssessment: QualityAssessment;
  completenessReport: CompletenessReport;
  /**
   * M1–M6 / 可选材料 的输出门限体检结果。
   * 这几张表走入库路径，阶段推进时才跑的门限管不到它们（专家审阅 2026-10-20 指出的通路缺口）。
   */
  gateFindings: { tableCode: string; label: string; gate: string; detail: string }[];
  /**
   * 被门禁挡下的行（未入库，逐条给出原因）
   *
   * M4「不做」缺可定位出处或缺「依据」、来源不可定位、缺必填列都走这里。
   * 宁可少一行，也不让没有材料出处/缺必填的行混进资料库；原因随结果返回，
   * 上传回执/日志能说清"少了什么"。
   */
  skippedRows: { table_code: string; source: string; reason: string }[];
  /** 本次成功入库行的证据等级分布（A/B/C/D） */
  evidenceSummary: IngestEvidenceSummary;
  /** 命中绝对化措辞的行（已降为 C，未删除） */
  flaggedRows: IngestFlaggedRow[];
  /** 同键不同值的冲突（未覆盖、未新增，保留原值） */
  conflicts: IngestConflict[];
  /**
   * 模型没有返回可解析结果时的一句话原因（可重试）
   *
   * 与「材料里确实没有可归入表格的信息」分开：后者是正常 0 行，前者是模型调用/格式
   * 临时失败。上传回执必须让用户知道是哪一种，不能让两种都显示成「没有可归入的信息」。
   */
  modelIssue?: string;
}

// ─── DSH 产出 JSON 结构 ────────────────────────────────────

/** DSH 返回的单条归类记录 */
interface ClassifiedRow {
  /** 目标表编号：M1-M6 / O1-O6 */
  table_code: string;
  /** 该行字段值 */
  fields: Record<string, unknown>;
  /** 来源标注（文件名:页码） */
  source: string;
}

/** DSH 返回的完整 JSON */
interface DshOutput {
  rows: ClassifiedRow[];
  /** 模型没有产出可解析结果时的原因（不是「材料无信息」） */
  issue?: string;
}

/** 单行的确定性质量判定结果 */
interface RowQuality {
  level: EvidenceLevel;
  /** 行标识（冲突/留痕共用） */
  key: string;
  flags: IngestFlaggedRow[];
}

/** 可选材料表号 → payload 类目（与 contract 的 payloads 键一致） */
const OPTIONAL_CATEGORY: Readonly<Record<string, string>> = {
  O1: "O1认证",
  O2: "O2案例",
  O4: "O4开发资料",
  O5: "O5路线图",
  O6: "O6交付与生态",
};

/** 来源不可定位的固定原因（被拒行必须说清缺什么） */
function sourceRejectedReason(source: unknown): string {
  const text = String(source ?? "").trim();
  return `来源不可定位（缺少页码/章节）：${text || "空"}`;
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
            enum: ["M1", "M2", "M3", "M4", "M5", "M6", "O1", "O2", "O4", "O5", "O6"],
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

const SYSTEM_PROMPT = `你是产品资料解析专家。你的任务是将输入的产品文档内容按表格分类归入以下 11 张表：

## 产品清单（table_code=M1）
字段：model(型号), name(产品名称), status(在售/停售/在研/规划/待确认)
必填：model, name, status
注意：材料只写规格、没写产品状态时，status 填「待确认」，不要因此丢弃 M1 行，也不要因此漏掉 M2 规格行。

## 规格书（table_code=M2）
字段：param_class(参数类别), param_name(参数名称), value(参数值), measured(实测/宣称/未提及)
必填：param_class, param_name, value, measured
注意：每条规格参数需关联到产品清单中的某个产品，用 fields.product_model 指定关联的 model 字段值

## 能力清单（table_code=M3）
字段：domain(领域), name(能力名称), description(描述，依赖条件也写在这里), maturity(已交付/组件具备/在研/规划)
必填：domain, name, description, maturity

## 边界与限制·不做的事（table_code=M4）
字段：description(不做的事), reason(依据：凭什么判"不做"，要能对上材料里的原话/限制条件), has_plan(有/无/未定), response(客户要求时怎么办), owner(负责人)
必填：description, reason, has_plan, response, owner, source
注意：「不做」是硬结论，必须同时给**可定位出处**（source 形如 文件名:页码）与**依据**（reason）；缺任一条就不要输出这一行，不许用"行业通例/通常"编理由。

## 已知限制（table_code=M5）
字段：product_name(产品名称), description(限制描述), impact(高/中/低), fix_status(已修复/修复中/无计划/硬件限制), external_visible(可提/内部可提/不可提), owner(负责人)
必填：product_name, description, impact, fix_status, external_visible, owner

## 报价（table_code=M6）
字段：model(型号，必须能在产品清单找到), config(配置构成), unit_price(含税单价，元，可写区间如 12000–15000 或「面议」)
必填：model, config, unit_price
注意：**任何价格/报价信息一律写这里**（单价、区间、含税参考价、年费都算）；一行只写一个报价口径；禁止编价格。

## 可选材料（table_code=O1/O2/O4/O5/O6；fields 的键名必须逐字用下面这些，否则入不了表）
- O1认证：model(型号), cert_type(证书类型), cert_no(证书号), valid_until(有效期至), issuer(发证机构), covered_models(覆盖型号)
- O2案例：name(案例名), scene(场景), delivered_at(交付时间), acceptance(验收指标与结果)
- O4SDK：product(产品), doc_name(资料名称) 及其余开发资料字段（见表格定义）
- O5路线图：feature(功能), expected_release(预计时间), priority(优先级)
- O6生态：partner_name(伙伴名称), integration_type(集成方式), maturity(成熟度)
注意：证书号、有效期、发证机构、交付时间、验收指标都是必填，材料里没有就写「未提及」，不要换键名。价格与报价一律写报价表，可选材料不再有价格类别。

## 来源标注规则
每条记录的 source 字段必须包含"文件名:定位符"。定位符只接受两类：
- 具体页码：12、12-14（页码范围）
- 章节号：8.2、A.1（标准/文档章节）
禁止写「未知」「?」「-」或只写文件名——来源不可定位的记录不会入库。
如果材料确实没有页码，用能定位到原文的章节号；连章节号都没有就不要输出该行。
Word（.docx）没有稳定页码：没有章节号时，定位符统一写 1（整篇按第 1 页存储，如 产品说明书.docx:1），不要用「文档信息」「核心单元」这类标题代替定位符。

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

  // 4. 验证产出（来源校验 + 必填列 + M4 门禁 + 丢弃无效行）
  const { valid: validRows, skipped: skippedRows } = validateRows(dshOutput, fileName);

  // 4.5 证据等级与夸大措辞（确定性判定，零 LLM）
  const qualities = assessRowQualities(validRows, fileName);

  // 5. 写入数据库
  const { inserted, tableCounts, mergedProducts, evidenceSummary, conflicts, acceptedRows } =
    writeRows(db, validRows, productLineId, fileName, qualities);

  // 5.5 只报真正入库的行：被冲突/关联失败挡下的行不冒充"已入库但降级"
  const flaggedRows = [...qualities.entries()]
    .filter(([row]) => acceptedRows.has(row))
    .flatMap(([, quality]) => quality.flags);

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
    skippedRows,
    evidenceSummary,
    flaggedRows,
    conflicts,
    ...(dshOutput.issue ? { modelIssue: dshOutput.issue } : {}),
  };
}

/**
 * 入库后跑 M1–M6 / 可选材料的输出门限。
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
  /* M3 表定义已删「不适用场景」：入库体检只看现存列，存量 DB 列不参与门禁 */
  for (const r of q<{ id: string; domain: string; name: string; maturity: string }>(
    "SELECT id, domain, name, maturity FROM capability WHERE product_line_id = ?",
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
  for (const r of q<{
    id: string;
    model: string;
    config: string;
    unit_price: string;
  }>(
    `SELECT q.id, q.model, q.config, q.unit_price
       FROM price_quote q JOIN product p ON p.id = q.product_id WHERE p.product_line_id = ?`,
  )) {
    rows.push({ id: r.id, tableCode: "M6", row: r });
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
  parts.push(
    "请将上述内容按给定表格分类，输出 JSON。每条记录的 source 字段必须是「文件名:具体页码/章节号」" +
      "（如 白皮书.pdf:12、白皮书.pdf:12-14、标准.pdf:8.2、标准.pdf:A.1）；" +
      "写「未知」「?」「-」的行不会入库；.docx 没有章节号时定位符写 1（整篇按第 1 页），不要用标题代替页码；" +
      "边界与限制里的「不做」必须同时给可定位出处与依据（reason），缺一条就不要输出；" +
      "价格一律写报价表（可选材料没有价格类别）。",
  );

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
  /**
   * 模型偶尔会返回空内容或截断的 JSON（实测同一份 Word 第一次 0 行、重传即成功）。
   * 这种失败还**没写任何行**，重试一次是安全的；只重试一次，避免模型持续异常时
   * 把一次上传拖成多次长调用。
   */
  for (let attempt = 0; attempt < 2; attempt++) {
    let fullText = "";
    let streamError = "";
    for await (const event of dshClient.prompt(session, {
      system: SYSTEM_PROMPT,
      user: userPrompt,
      outputContract: OUTPUT_CONTRACT,
    })) {
      if (event.type === "text") {
        fullText += (event as { type: "text"; text: string }).text;
      }
      if (event.type === "error") {
        // 模型/网络错误也要重试一次：供应商 504/网关超时是偶发的，
        // 但第二次仍失败要如实上报，不能伪装成「材料没有可入库信息」。
        streamError = String(
          (event as { message?: unknown }).message ?? "未知错误",
        );
        break;
      }
    }

    if (streamError !== "") {
      if (attempt === 0) {
        console.warn(`[ingest] 模型调用失败（${streamError}），重试一次`);
        continue;
      }
      return {
        rows: [],
        issue: `模型调用失败：${streamError}（已自动重试一次，可直接再试）`,
      };
    }

    if (fullText.trim() !== "") {
      const parsed = parseDshOutput(fullText);
      if (parsed !== null) return parsed;
    }

    if (attempt === 0) {
      console.warn(
        `[ingest] 模型未返回可解析结果（收到 ${fullText.length} 字，开头 ${JSON.stringify(fullText.slice(0, 120))}），重试一次`,
      );
      continue;
    }
    return {
      rows: [],
      issue: fullText.trim() === ""
        ? "模型没有返回内容（可能临时不可用，请重试）"
        : "模型返回的内容不是可解析的 JSON（可能被截断，请重试）",
    };
  }
  // 循环最多两轮，这里只是类型收口
  return { rows: [], issue: "模型没有返回可解析结果（请重试）" };
}

/**
 * 从 DSH 输出文本中提取 JSON。
 * 优先找 Function Calling 参数（JSON 对象），其次找 ```json 代码块，最后尝试整体 parse。
 */
function parseDshOutput(text: string): DshOutput | null {
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

  /**
   * 4. 模型输出被截断：尽量保住**最后一个完整行之前**的行。
   *    实测 3 MB 的安装指导一次输出 1.1 万字后被供应商截断；重试仍可能截断。
   *    完整行本身已过 JSON 结构，丢整批太浪费；丢掉残缺的尾行、补上数组/对象闭合即可。
   *    必须把截断原因带出去，不能让用户以为材料只导出了一部分。
   */
  const candidates = [
    trimmed.slice(jsonStart >= 0 ? jsonStart : 0),
    codeBlockMatch?.[1]?.trim() ?? "",
  ].filter((v) => v !== "");
  for (const candidate of candidates) {
    const repaired = repairTruncatedRows(candidate);
    if (repaired !== null) return repaired;
  }

  // 解析失败 → null，由调用方决定「重试」还是如实报错；不要伪装成合法的空结果
  return null;
}

/**
 * 从被截断的 `{"rows":[{...},{...}` 里收集完整的行对象，补成合法 JSON。
 *
 * 只在最后一个完整行处截断：最后一个 `}` 之后即使还有半行也丢掉。
 * 最多保留数组里的顶层对象；字段里的嵌套对象/数组由 depth 处理。
 */
function repairTruncatedRows(text: string): DshOutput | null {
  const rowsKey = text.indexOf('"rows"');
  if (rowsKey < 0) return null;
  const arrayStart = text.indexOf("[", rowsKey);
  if (arrayStart < 0) return null;

  const rowTexts: string[] = [];
  let depth = 1; // 从 rows 数组的 [ 之后开始算
  let rowStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = arrayStart + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 1) rowStart = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 1 && rowStart >= 0) {
        rowTexts.push(text.slice(rowStart, i + 1));
        rowStart = -1;
      }
      continue;
    }
    if (ch === "]" && depth === 1) break;
  }

  if (rowTexts.length === 0) return null;
  try {
    const parsed = JSON.parse(`{"rows":[${rowTexts.join(",")}]}`) as unknown;
    if (!isDshOutput(parsed)) return null;
    return {
      ...parsed,
      issue: `模型输出被截断，已保留前 ${parsed.rows.length} 行；建议拆分材料后重新上传以补齐`,
    };
  } catch {
    return null;
  }
}

/** 类型守卫：是否为合法的 DshOutput（只检查顶层结构，行级校验在 validateRows） */
function isDshOutput(val: unknown): val is DshOutput {
  if (typeof val !== "object" || val === null) return false;
  const obj = val as Record<string, unknown>;
  return Array.isArray(obj["rows"]);
}

// ─── 子函数：来源 + 必填列 + 门禁校验 ──────────────────────

/** 材料没写状态时补一个合法且诚实的默认值，不让整行（及依赖它的规格）被丢掉。 */
function fillIngestDefaults(row: ClassifiedRow): ClassifiedRow {
  if (row.table_code !== "M1") return row;
  const fields = (row.fields ?? {}) as Record<string, unknown>;
  if (!isEmptyValue(fields["status"])) return row;
  return { ...row, fields: { ...fields, status: "待确认" } };
}

/**
 * 校验规则（顺序有意义，先报最根本的缺失）：
 *  ① table_code 必须合法；
 *  ② 来源必须可定位（具体页码/章节号，拒绝「未知」「?」「-」）；
 *  ③ M4「不做」还要有依据（reason）；
 *  ④ 契约里的 required 列必须非空（只校验 required，条件必填不管）。
 *
 * 被拒行全部进 skippedRows 并给出具体原因：门禁不能静默——用户要知道
 * "材料里明明写了，为什么没进来"。
 */
function validateRows(
  output: DshOutput,
  _fileName: string,
): {
  valid: ClassifiedRow[];
  skipped: { table_code: string; source: string; reason: string }[];
} {
  const validTables = new Set([
    "M1", "M2", "M3", "M4", "M5", "M6",
    "O1", "O2", "O4", "O5", "O6",
  ]);
  const valid: ClassifiedRow[] = [];
  const skipped: { table_code: string; source: string; reason: string }[] = [];

  for (const raw of output.rows) {
    // 规格书/技术参数表常常只写参数、不写状态。M1 状态缺失时按「待确认」入库，
    // 与手工新增的默认值一致（library-service）；整行丢掉会连 M2 的关联产品一起丢。
    const row = fillIngestDefaults(raw);
    // table_code 必须是合法的表编号。不能静默 continue：模型偶尔会把表号写成
    // 「M1产品清单」「表1」或干脆漏掉，旧实现直接丢行，前端只看到「0 行、没有信息」，
    // 排不出是模型结构错还是文件没内容。挡下也要留下原因。
    const tableCode = String(row.table_code ?? "").trim();
    if (!tableCode || !validTables.has(tableCode)) {
      skipped.push({
        table_code: tableCode || "?",
        source: String(row.source ?? ""),
        reason: `表编号无效（${tableCode || "空"}）：必须是 M1–M6 / O1–O6`,
      });
      continue;
    }
    // 来源必须可定位（2026-10-21 收紧：页码/章节号必须是具体值）
    if (!isValidSource(row.source)) {
      skipped.push({
        table_code: row.table_code,
        source: String(row.source ?? ""),
        reason: sourceRejectedReason(row.source),
      });
      continue;
    }
    /* M4 门禁：来源已过通用校验，这里只剩「依据」一项要查 */
    if (row.table_code === "M4") {
      const fields = (row.fields ?? {}) as Record<string, unknown>;
      const gate = boundaryEvidenceError(row.source, fields["reason"]);
      if (gate) {
        skipped.push({
          table_code: "M4",
          source: String(row.source ?? ""),
          reason: gate,
        });
        continue;
      }
    }
    // 必填列（契约 required；条件必填不做机器判定）
    const missing = missingRequiredLabels(row);
    if (missing.length > 0) {
      skipped.push({
        table_code: row.table_code,
        source: String(row.source ?? ""),
        reason: `缺必填列：${missing.join("、")}`,
      });
      continue;
    }
    valid.push(row);
  }

  return { valid, skipped };
}

/**
 * 取该行缺失的必填列中文名。
 *
 * 用契约注册表（`TABLES_BY_CODE`）的 `required`，不另抄一份列清单：
 * 表定义改了，门禁自动跟着改。两处例外是数据形态差异，不是绕过：
 *  · M2 的「所属产品」在契约里叫 product_id，材料行给的是 product_model；
 *  · 可选材料的 category 不进 fields，而由 table_code 映射。
 * 核实两列（verification_*）是分析阶段的要求，材料入库不产出，跳过。
 */
function missingRequiredLabels(row: ClassifiedRow): string[] {
  const category = OPTIONAL_CATEGORY[row.table_code];
  const def = TABLES_BY_CODE[category ? "可选材料" : row.table_code];
  if (!def) return [];
  const payload = category ? (def.payloads?.[category] ?? []) : [];
  const verification = new Set<string>(VERIFICATION_KEYS);
  return [...def.columns, ...payload]
    .filter((c) => c.required === true && !verification.has(c.key))
    .filter((c) => !hasRequiredValue(row, c.key))
    .map((c) => c.label);
}

/**
 * 必填值是否存在：`待确认` 是 M1 的合法枚举值，但通用 `isEmptyValue` 把它当占位符
 * （用于完整度判定）。材料没写状态时我们补的正是这个值；这里按枚举放行，否则补了也会被拒。
 */
function hasRequiredValue(row: ClassifiedRow, key: string): boolean {
  const value = requiredValue(row, key);
  if (!isEmptyValue(value)) return true;
  return row.table_code === "M1" && key === "status" && String(value ?? "").trim() === "待确认";
}

/** 必填列的取值：字段优先，其次行级（source 在行上）；处理两个数据形态别名 */
function requiredValue(row: ClassifiedRow, key: string): unknown {
  const fields = (row.fields ?? {}) as Record<string, unknown>;
  if (key === "product_id") return fields["product_id"] ?? fields["product_model"];
  if (key === "category") return fields["category"] ?? OPTIONAL_CATEGORY[row.table_code];
  return fields[key] ?? (row as unknown as Record<string, unknown>)[key];
}

/**
 * 来源校验（委托共享模块，server 的 ingest 与手工边界入口同一把尺子）：
 * `文件名:12`、`文件名:12-14`、`文件名:8.2`、`文件名:A.1` 放行；
 * `文件名:未知`、`文件名:?`、`文件名:-` 一律不可定位。
 */
function isValidSource(source: unknown, _fileName?: string): boolean {
  return isLocatableSource(source);
}

// ─── 子函数：证据等级与夸大措辞（确定性） ──────────────────

/** 本批次的证据等级与留痕（按行对象引用索引） */
function assessRowQualities(
  rows: readonly ClassifiedRow[],
  fileName: string,
): Map<ClassifiedRow, RowQuality> {
  const out = new Map<ClassifiedRow, RowQuality>();
  for (const row of rows) {
    const key = rowKey(row);
    const flags = absoluteFlags(row, key);
    // 口径在 domain（`library-standard`）：材料低权威或命中绝对化 → C
    const level = gradeIncomingEvidence(
      row.source,
      fileName,
      flags.map((f) => f.term),
    );
    out.set(row, { level, key, flags });
  }
  return out;
}

/** 命中绝对化措辞的字段（同一字段同一词只留一条） */
function absoluteFlags(row: ClassifiedRow, key: string): IngestFlaggedRow[] {
  const flags: IngestFlaggedRow[] = [];
  const fields = (row.fields ?? {}) as Record<string, unknown>;
  for (const [field, value] of Object.entries(fields)) {
    for (const term of findAbsoluteTerms(value)) {
      flags.push({
        table_code: row.table_code,
        key,
        field,
        term,
        reason: "绝对化措辞，需核实",
      });
    }
  }
  return flags;
}

/** 行标识：用于 flaggedRows / conflicts 的人工回查（不是数据库主键） */
function rowKey(row: ClassifiedRow): string {
  const f = (row.fields ?? {}) as Record<string, unknown>;
  const s = (key: string): string => String(f[key] ?? "").trim();
  switch (row.table_code) {
    case "M1":
      return s("model");
    case "M2":
      return [s("product_model"), s("param_class"), s("param_name")].filter(Boolean).join("/");
    case "M3":
      return [s("domain"), s("name")].filter(Boolean).join("/");
    case "M4":
      return s("description");
    case "M5":
      return [s("product_name"), s("description")].filter(Boolean).join("/");
    case "M6":
      return [s("model"), s("config")].filter(Boolean).join("/");
    case "O1":
      return s("cert_no") || [s("model"), s("cert_type")].filter(Boolean).join("/");
    case "O2":
      return s("name");
    case "O4":
      return [s("product"), s("doc_name")].filter(Boolean).join("/");
    case "O5":
      return s("item");
    case "O6":
      return [s("item"), s("coverage")].filter(Boolean).join("/");
    default:
      return row.table_code;
  }
}

// ─── 子函数：写入数据库 ────────────────────────────────────

/** M2 的 product_model 关联需先解析为 product_id */
function writeRows(
  db: DbInstance,
  rows: ClassifiedRow[],
  productLineId: string,
  fileName: string,
  qualities: Map<ClassifiedRow, RowQuality>,
): {
  inserted: number;
  tableCounts: Record<string, number>;
  mergedProducts: number;
  evidenceSummary: IngestEvidenceSummary;
  conflicts: IngestConflict[];
  acceptedRows: Set<ClassifiedRow>;
} {
  let inserted = 0;
  /** 并入已有型号的 M1 行数（没新建产品行，但材料内容已补进去） */
  let mergedProducts = 0;
  const tableCounts: Record<string, number> = {};
  const evidenceSummary: IngestEvidenceSummary = { A: 0, B: 0, C: 0, D: 0 };
  const conflicts: IngestConflict[] = [];
  /** 真正被资料库接受的行（含并入已有型号的 M1）：未入库的行不报夸大措辞 */
  const acceptedRows = new Set<ClassifiedRow>();
  const count = (table: string, level: EvidenceLevel, row: ClassifiedRow) => {
    tableCounts[table] = (tableCounts[table] ?? 0) + 1;
    evidenceSummary[level] += 1;
    acceptedRows.add(row);
    inserted++;
  };
  const qualityOf = (row: ClassifiedRow): RowQuality =>
    qualities.get(row) ?? { level: "B", key: rowKey(row), flags: [] };
  // model → product_id 缓存（同一次 ingest 内共享）
  const modelToProductId = new Map<string, string>();

  // 先遍历一次，把 M1 行落到产品（已有型号并入、没有才新建），收集 model → id 映射
  for (const row of rows) {
    if (row.table_code !== "M1") continue;
    const q = qualityOf(row);
    const { productId, created } = resolveProductForModel(
      db,
      productLineId,
      row.fields,
      row.source,
      fileName,
      q.level,
    );
    if (!productId) continue;
    // 用归一型号做 key：材料里写出「在鸿 7885平板」时也要能接到已有「在鸿7885平板」
    modelToProductId.set(normalizeModel(String(row.fields["model"] ?? "")), productId);
    acceptedRows.add(row);
    if (created) count("M1", q.level, row);
    else mergedProducts += 1;
  }

  // 再遍历，写入其余表
  for (const row of rows) {
    if (row.table_code === "M1") continue;
    const q = qualityOf(row);

    switch (row.table_code) {
      case "M2": {
        const ok = insertSpecParam(db, row, productLineId, modelToProductId, fileName, q, conflicts);
        if (ok) count("M2", q.level, row);
        break;
      }
      case "M3": {
        const ok = insertCapability(db, row, productLineId, fileName, q, conflicts);
        if (ok) count("M3", q.level, row);
        break;
      }
      case "M4": {
        const ok = insertBoundary(db, row, productLineId, fileName, q, conflicts);
        if (ok) count("M4", q.level, row);
        break;
      }
      case "M5": {
        const ok = insertLimitation(db, row, productLineId, fileName, q);
        if (ok) count("M5", q.level, row);
        break;
      }
      case "M6": {
        const ok = insertPriceQuote(db, row, productLineId, modelToProductId, fileName, q);
        if (ok) count("M6", q.level, row);
        break;
      }
      default: {
        // O1-O6
        if (row.table_code.startsWith("O")) {
          const ok = insertOptionalMaterial(db, row, productLineId, fileName, q);
          if (ok) count(row.table_code, q.level, row);
        }
        break;
      }
    }
  }

  return { inserted, tableCounts, mergedProducts, evidenceSummary, conflicts, acceptedRows };
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
  return classifyLibrarySource(source, fileName).authority;
}

function insertSpecParam(
  db: DbInstance,
  row: ClassifiedRow,
  _productLineId: string,
  modelToProductId: Map<string, string>,
  fileName: string,
  quality: RowQuality,
  conflicts: IngestConflict[],
): boolean {
  const f = row.fields;
  const productModel = String(f["product_model"] ?? "");
  const productId =
    modelToProductId.get(productModel) ?? modelToProductId.get(normalizeModel(productModel));
  if (!productId) return false;

  try {
    const paramClass = String(f["param_class"] ?? "");
    const paramName = String(f["param_name"] ?? "");
    const value = String(f["value"] ?? "");
    const existing = (db.specParamRepo.list({
      where: "product_id = ? AND param_class = ? AND param_name = ?",
      params: [productId, paramClass, paramName],
    }) as SpecParam[]).filter(
      (s) =>
        s.product_id === productId &&
        s.param_class === paramClass &&
        s.param_name === paramName,
    );
    if (existing.length > 0) {
      // 值相同 → 静默跳过（历史库里 53 行完全重复就是这么来的）
      if (existing.some((s) => normalizeValue(s.value) === normalizeValue(value))) return false;
      // 值不同 → 不覆盖、不新增，留下冲突证据；保留库里已有值
      conflicts.push({
        table_code: "M2",
        key: quality.key,
        existing: existing.map((s) => s.value).join(" / "),
        incoming: value,
        source: row.source,
      });
      return false;
    }
    return upsertSpecParam(db, productId, f as Record<string, unknown>, row.source, fileName, quality.level);
  } catch {
    return false;
  }
}

function insertCapability(
  db: DbInstance,
  row: ClassifiedRow,
  productLineId: string,
  fileName: string,
  quality: RowQuality,
  conflicts: IngestConflict[],
): boolean {
  const f = row.fields;
  const domain = String(f["domain"] ?? "");
  const name = String(f["name"] ?? "");
  const description = String(f["description"] ?? "");
  const maturity = (f["maturity"] as Capability["maturity"]) ?? "规划";
  try {
    const existing = (db.capabilityRepo.list({
      where: "product_line_id = ?",
      params: [productLineId],
    }) as Capability[]).filter(
      (c) =>
        c.product_line_id === productLineId && c.domain === domain && c.name === name,
    );
    if (existing.length > 0) {
      const same = existing.some(
        (c) =>
          normalizeValue(c.description) === normalizeValue(description) &&
          c.maturity === maturity,
      );
      if (same) return false;
      conflicts.push({
        table_code: "M3",
        key: quality.key,
        existing: `${existing[0]!.description}｜${existing[0]!.maturity}`,
        incoming: `${description}｜${maturity}`,
        source: row.source,
      });
      return false;
    }
    db.capabilityRepo.insert({
      product_line_id: productLineId,
      domain,
      name,
      description,
      maturity,
      // DB 列保留（不迁移）；依赖条件按新口径并入 description，不再单独读 dependency；
      // 「不适用场景」列已从表定义删除，新数据不再写入
      dependency: "",
      source_type: "AI提取",
      source: row.source,
      source_authority: authorityOf(row.source, fileName),
      evidence_level: quality.level,
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
  quality: RowQuality,
  conflicts: IngestConflict[],
): boolean {
  const f = row.fields;
  const description = String(f["description"] ?? "");
  const reason = String(f["reason"] ?? "");
  try {
    const existing = (db.boundaryRepo.list({
      where: "product_line_id = ?",
      params: [productLineId],
    }) as Boundary[]).filter(
      (b) =>
        b.product_line_id === productLineId &&
        normalizeValue(b.description) === normalizeValue(description),
    );
    if (existing.length > 0) {
      // 同 description、reason 相同 → 静默跳过；reason 不同 → 冲突，保留原值
      if (existing.some((b) => normalizeValue(b.reason) === normalizeValue(reason))) return false;
      conflicts.push({
        table_code: "M4",
        key: quality.key,
        existing: existing[0]!.reason,
        incoming: reason,
        source: row.source,
      });
      return false;
    }
    db.boundaryRepo.insert({
      product_line_id: productLineId,
      description,
      reason,
      has_plan: (f["has_plan"] as Boundary["has_plan"]) ?? "未定",
      response: String(f["response"] ?? ""),
      owner: String(f["owner"] ?? ""),
      plan_date: f["plan_date"] ? String(f["plan_date"]) : undefined,
      source_type: "AI提取",
      source: row.source,
      source_authority: authorityOf(row.source, fileName),
      evidence_level: quality.level,
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
  quality: RowQuality,
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
      evidence_level: quality.level,
    });
    return true;
  } catch {
    return false;
  }
}


function insertPriceQuote(
  db: DbInstance,
  row: ClassifiedRow,
  productLineId: string,
  modelToProductId: Map<string, string>,
  fileName: string,
  quality: RowQuality,
): boolean {
  const f = row.fields;
  const model = String(f["model"] ?? "").trim();
  const key = normalizeModel(model);
  let productId = modelToProductId.get(model) ?? modelToProductId.get(key);
  if (!productId) {
    const hit = db.productRepo
      .list({ where: "product_line_id = ?", params: [productLineId] })
      .find((p) => normalizeModel(p.model) === key);
    productId = hit?.id;
  }
  if (!productId) return false;
  const scopes: PriceQuote["price_scope"][] = ["纯设备", "含安装", "含三年维保", "年费"];
  const config = String(f["config"] ?? "").trim();
  const unitPrice = String(f["unit_price"] ?? "").trim();
  // 价格口径已不进表：材料给了合法口径就沿用，缺省按「纯设备」落库（DB 列保留）
  const providedScope = String(f["price_scope"] ?? "") as PriceQuote["price_scope"];
  const scope = scopes.includes(providedScope) ? providedScope : "纯设备";
  // 契约必填：型号命中产品清单 + 配置/含税单价非空，否则不入库
  if (!config || !unitPrice) return false;
  try {
    db.quoteRepo.insert({
      product_id: productId,
      model,
      config,
      unit_price: unitPrice,
      price_scope: scope,
      valid_until: f["valid_until"] ? String(f["valid_until"]) : undefined,
      source: row.source,
      source_type: "AI提取",
      source_authority: authorityOf(row.source, fileName),
      evidence_level: quality.level,
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
  quality: RowQuality,
): boolean {
  // O1/O2/O4/O5/O6 → category 映射（价格类别已下线，报价只进 M6）
  const categoryMap: Record<string, OptionalMaterial["category"]> = {
    O1: "O1认证",
    O2: "O2案例",
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
      evidence_level: quality.level,
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