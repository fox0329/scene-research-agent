/**
 * @scene/infra — 文档解析器（doc-parser）
 *
 * 根据文件扩展名自动选择解析库：
 * - .pdf  → unpdf（纯文本，表格由 LLM 后处理）；图片型（扫描）PDF
 *           无文本层时自动走 macOS Vision 识别（scripts/setup-ocr.sh 安装）
 * - .docx → mammoth（HTML output → 正则提取 table）
 * - .xlsx → exceljs（直接映射行列）
 * - .pptx → jszip + XML（提取 slide 文本，表格 TODO）
 *
 * @module doc-parser
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

/** 解析后的表格结构 */
export interface ParsedTable {
  headers: string[];
  rows: string[][];
}

/** 文档解析结果 */
export interface ParseResult {
  text: string;
  tables: ParsedTable[];
  metadata: {
    pageCount?: number;
    sheetCount?: number;
  };
}

/** 支持的文件扩展名 */
const SUPPORTED_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".pptx"]);

/**
 * 解析文档，自动根据扩展名选择解析器。
 *
 * @param filePath - 文件绝对路径
 * @returns 解析结果（纯文本 + 表格 + 元数据）
 * @throws 文件不存在、格式不支持、或解析失败时抛出明确错误
 */
export async function parseDocument(filePath: string): Promise<ParseResult> {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("parseDocument: filePath 必须是非空字符串");
  }

  const ext = extname(filePath).toLowerCase();

  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(
      `不支持的文件格式 "${ext}"。支持的格式：${[...SUPPORTED_EXTENSIONS].join(", ")}`,
    );
  }

  const buffer = await readFile(filePath);

  if (buffer.byteLength === 0) {
    throw new Error(`文件为空：${filePath}`);
  }

  switch (ext) {
    case ".pdf":
      return parsePdf(buffer, filePath);
    case ".docx":
      return parseDocx(buffer);
    case ".xlsx":
      return parseXlsx(buffer);
    case ".pptx":
      return parsePptx(buffer);
    default:
      // 类型守卫：TypeScript 应已经覆盖所有分支
      throw new Error(`未处理的扩展名：${ext}`);
  }
}

// ── PDF：unpdf + 扫描件 macOS Vision 识别回退 ──────────────

/** 扫描件判定阈值：去空白后文本不足此数视为无文本层（图片型 PDF） */
const SCANNED_TEXT_THRESHOLD = 10;
/** 单文件识别超时（ms）：40 页上限下足够，防卡死 */
const OCR_TIMEOUT_MS = 180_000;

async function parsePdf(buffer: Buffer, filePath: string): Promise<ParseResult> {
  const { extractText } = await import("unpdf");
  // unpdf 要求 Uint8Array，不接受 Buffer
  const uint8 = new Uint8Array(buffer);
  const result = await extractText(uint8, { mergePages: true });

  // mergePages: true 时 text 为 string，但 overload 有时解析不完整，兜底处理
  const text = Array.isArray(result.text)
    ? result.text.join("\n")
    : String(result.text);
  const pageCount = result.totalPages;

  // 图片型（扫描）PDF 无文本层：走 macOS Vision 识别（用户拍板路线）
  if (text.replace(/\s/g, "").length < SCANNED_TEXT_THRESHOLD && (pageCount ?? 0) > 0) {
    return { text: ocrScannedPdf(filePath), tables: [], metadata: { pageCount } };
  }

  return {
    text,
    tables: [], // PDF 无原生表格结构，由 LLM 后处理
    metadata: {
      pageCount,
    },
  };
}

/**
 * 调用 macOS Vision 识别助手（scripts/ocr_pdf.py，系统「实况文本」引擎）。
 *
 * @param filePath - 扫描件 PDF 绝对路径
 * @returns 逐页识别文本
 * @throws 组件未安装或识别失败时抛出可执行的中文错误
 */
function ocrScannedPdf(filePath: string): string {
  const root = process.cwd();
  const python =
    process.env["SCENE_OCR_PYTHON"] ?? join(root, "scripts", ".venv-ocr", "bin", "python");
  const helper = join(root, "scripts", "ocr_pdf.py");
  if (!existsSync(python) || !existsSync(helper)) {
    throw new Error(
      "图片型（扫描）PDF 需要文字识别组件（macOS Vision）：请先运行 scripts/setup-ocr.sh 后重试",
    );
  }
  const r = spawnSync(python, [helper, filePath], {
    encoding: "utf-8",
    timeout: OCR_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(
      `图片型 PDF 识别失败：${(r.stderr || r.stdout || "未知原因").trim().slice(0, 200)}`,
    );
  }
  try {
    const out = JSON.parse(r.stdout) as Record<string, { text?: string; error?: string }>;
    const entry = out[filePath];
    if (entry?.error) throw new Error(entry.error);
    const text = entry?.text ?? "";
    if (!text.trim()) {
      throw new Error("图片型 PDF 识别结果为空：可能为纯图形页或分辨率过低");
    }
    return text;
  } catch (e) {
    if (e instanceof Error && (e.message.startsWith("图片型") || e.message.includes("识别结果"))) {
      throw e;
    }
    throw new Error(`图片型 PDF 识别输出无法解析：${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Word：mammoth ──────────────────────────────────────────

async function parseDocx(buffer: Buffer): Promise<ParseResult> {
  const mammoth = await import("mammoth");

  // 提取纯文本
  const textResult = await mammoth.extractRawText({ buffer });

  // 提取 HTML（保留表格结构）
  const htmlResult = await mammoth.convertToHtml({ buffer });

  const tables = extractTablesFromHtml(htmlResult.value);

  return {
    text: textResult.value,
    tables,
    metadata: {},
  };
}

/**
 * 从 mammoth 输出的 HTML 中提取 <table> 结构。
 * 每个 <table> 取第一行为 headers，其余为 rows。
 */
function extractTablesFromHtml(html: string): ParsedTable[] {
  const tables: ParsedTable[] = [];
  // 匹配每个 <table>...</table> 块
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch: RegExpExecArray | null;

  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const tableHtml = tableMatch[1] ?? "";

    // 匹配所有 <tr>...</tr>
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const rows: string[][] = [];
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[1] ?? "";

      // 匹配 <td>/<th> 中的文本
      const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      const cells: string[] = [];
      let cellMatch: RegExpExecArray | null;

      while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
        // 去除内部 HTML 标签，只留纯文本
        const cellText = (cellMatch[1] ?? "").replace(/<[^>]+>/g, "").trim();
        cells.push(cellText);
      }
      rows.push(cells);
    }

    if (rows.length > 0) {
      const [firstRow, ...restRows] = rows;
      tables.push({
        headers: firstRow ?? [],
        rows: restRows,
      });
    }
  }

  return tables;
}

// ── Excel：exceljs ─────────────────────────────────────────

async function parseXlsx(rawBuffer: Buffer): Promise<ParseResult> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  // Node 22 的 Buffer<ArrayBuffer> 与 exceljs 类型声明不兼容（泛型参数差异），
  // 运行时 Buffer 完全兼容，此处类型断言是安全的。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(rawBuffer as any);

  const tables: ParsedTable[] = [];
  const textParts: string[] = [];

  for (const ws of wb.worksheets) {
    const allRows: string[][] = [];

    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      // 遍历到最大列数，确保对齐
      const colCount = ws.columnCount;
      for (let col = 1; col <= colCount; col++) {
        const cell = row.getCell(col);
        const val = cell.value;
        cells.push(val != null ? String(val) : "");
      }
      allRows.push(cells);
    });

    if (allRows.length > 0) {
      const [firstRow, ...restRows] = allRows;
      tables.push({
        headers: firstRow ?? [],
        rows: restRows,
      });

      // 生成可读文本
      textParts.push(`[Sheet: ${ws.name}]`);
      for (const row of allRows) {
        textParts.push(row.join("\t"));
      }
    }
  }

  return {
    text: textParts.join("\n"),
    tables,
    metadata: {
      sheetCount: wb.worksheets.length,
    },
  };
}

// ── PPT：jszip + XML ──────────────────────────────────────

async function parsePptx(buffer: Buffer): Promise<ParseResult> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);

  const allFiles = Object.keys(zip.files);
  const slideFiles = allFiles
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort();

  const textParts: string[] = [];

  for (const slideFile of slideFiles) {
    const xml = await zip.file(slideFile)!.async("string");

    // 提取 <a:t>text</a:t> 文本节点
    const textMatches = xml.match(/<a:t>([^<]*)<\/a:t>/g) ?? [];
    const texts = textMatches.map((m) => m.replace(/<\/?a:t>/g, ""));

    if (texts.length > 0) {
      const slideIndex = slideFile.match(/slide(\d+)\.xml/)?.[1] ?? "?";
      textParts.push(`[Slide ${slideIndex}]`);
      textParts.push(...texts);
    }

    // TODO: M2+ 增强 — 从 XML 中解析 <a:tbl> 表格节点
  }

  return {
    text: textParts.join("\n"),
    tables: [], // PPT 表格需深层 XML 解析，标记为 TODO
    metadata: {
      pageCount: slideFiles.length,
    },
  };
}