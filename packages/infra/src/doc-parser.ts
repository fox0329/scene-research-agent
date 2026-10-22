/**
 * @scene/infra — 文档解析器（doc-parser）
 *
 * 根据文件扩展名自动选择解析库：
 * - .pdf  → unpdf（纯文本，表格由 LLM 后处理）；图片型（扫描）PDF
 *           无文本层时自动走 macOS Vision 识别（scripts/setup-ocr.sh 安装）
 * - .docx → mammoth（HTML output → 正则提取 table）
 * - .xlsx → exceljs（直接映射行列）
 * - .pptx → jszip + XML（提取 slide 文本 + `<a:tbl>` 原生表格；按幻灯片序号数值排序）
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

/** 一页（或一个可定位单元）的原文 */
export interface ParsedPage {
  /** 页码（PDF 为页号从 1 起；docx/xlsx/pptx 无稳定分页，用 1） */
  page: number;
  /** 该页原文（**材料原文**，不是业务字段拼接） */
  text: string;
}

/** 文档解析结果 */
export interface ParseResult {
  text: string;
  tables: ParsedTable[];
  metadata: {
    pageCount?: number;
    sheetCount?: number;
  };
  /**
   * 逐页原文（变更表 #212）
   *
   * 为什么必须有：`source_fts.content` 现在存的是**业务字段拼接**
   * （`NEW.name || ' ' || NEW.position_desc`），于是 `hasContent(ref, snippet)`
   * 等于拿业务行跟自己比——**自证**，永远为真。
   * G-R8「该页确有这句话」要成立，必须先把原文按页存下来。
   *
   * 拿不到分页的格式（docx/xlsx/pptx）整篇作为第 1 页，语义退化为
   * 「这篇材料里有没有这句话」，仍强于自证。
   */
  pages?: ParsedPage[];
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

  if (ext === ".doc") {
    // 旧版 Word（OLE 二进制）mammoth 读不了；提示可执行的动作，别让用户以为是文件坏了
    throw new Error("不支持旧版 Word .doc：请在 Word 中另存为 .docx 后重新上传");
  }

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
  // mergePages: false 才拿得到**逐页**文本（变更表 #212）
  const result = await extractText(uint8, { mergePages: false });

  // mergePages: false 时 text 为 string[]（每页一段）；overload 有时给 string，兜底
  const pageTexts = Array.isArray(result.text)
    ? result.text.map((t) => String(t ?? ""))
    : [String(result.text ?? "")];
  const text = pageTexts.join("\n");
  const pageCount = result.totalPages;

  // 图片型（扫描）PDF 无文本层：走 macOS Vision 识别（用户拍板路线）
  if (text.replace(/\s/g, "").length < SCANNED_TEXT_THRESHOLD && (pageCount ?? 0) > 0) {
    const ocrText = ocrScannedPdf(filePath);
    return {
      text: ocrText,
      tables: [],
      metadata: { pageCount },
      pages: [{ page: 1, text: ocrText }],
    };
  }

  return {
    text,
    tables: [], // PDF 无原生表格结构，由 LLM 后处理
    metadata: {
      pageCount,
    },
    // 逐页原文：页码与引用里的 `文件名:页码` 对齐（从 1 起）
    pages: pageTexts.map((t, i) => ({ page: i + 1, text: t })),
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

  try {
    // 提取纯文本
    const textResult = await mammoth.extractRawText({ buffer });

    // 提取 HTML（保留表格结构）
    const htmlResult = await mammoth.convertToHtml({ buffer });

    const tables = extractTablesFromHtml(htmlResult.value);
    const hasText = textResult.value.trim() !== "";
    const hasTableText = tables.some(
      (t) => t.headers.some((h) => h.trim() !== "") || t.rows.some((r) => r.some((c) => c.trim() !== "")),
    );

    // 图片型/纯文本框 Word 常被误当成"上传失败"：这里直接说清是文件里没有可读文字
    if (!hasText && !hasTableText) {
      throw new Error(
        "Word 文档没有可读取的文字：可能是扫描图片、纯截图或文字放在文本框中。请提供可选文本的 .docx/.pdf",
      );
    }

    return {
      text: textResult.value,
      tables,
      metadata: {},
      // docx 无稳定分页：整篇作第 1 页（引用 `文件.docx:1` 与现状一致）
      pages: [{ page: 1, text: textResult.value }],
    };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Word 文档没有可读取的文字")) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Word 文档解析失败（可能已加密、文件损坏，或只是把 .doc 改了扩展名）：${detail.slice(0, 200)}`,
    );
  }
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
  /** 每个 sheet 的文本（变更表 #212：作为可定位的"页"） */
  const sheetTexts: string[] = [];

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
      const sheetLines = [`[Sheet: ${ws.name}]`, ...allRows.map((row) => row.join("\t"))];
      textParts.push(...sheetLines);
      sheetTexts.push(sheetLines.join("\n"));
    }
  }

  return {
    text: textParts.join("\n"),
    tables,
    metadata: {
      sheetCount: wb.worksheets.length,
    },
    // xlsx 的可定位单元是 sheet：按 sheet 切"页"，引用 `文件.xlsx:1` 指第一个 sheet
    pages: sheetTexts.map((t, i) => ({ page: i + 1, text: t })),
  };
}

// ── PPT：jszip + XML ──────────────────────────────────────

/**
 * `<a:t>` 文本节点。
 *
 * 必须容忍属性：PowerPoint 会写出 `<a:t xml:space="preserve">`，
 * 旧写法只认无属性的 `<a:t>`，遇到带属性的节点会**静默丢字**（不报错、不计数）。
 */
const PPT_TEXT_RE = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;

/**
 * DrawingML 表格块 `<a:tbl>…</a:tbl>`。
 *
 * 按标签整体切而不是上 XML 解析器：DrawingML 的表格**不能嵌套**，
 * 而单元格里的 `<a:tcPr>` 等子元素不会产生第二个 `<a:tbl>`。
 */
const PPT_TABLE_RE = /<a:tbl(?:\s[^>]*)?>([\s\S]*?)<\/a:tbl>/g;

/**
 * 表行 `<a:tr>`、单元格 `<a:tc>`。
 *
 * 收尾都要求 `[ >]`，为的是避开同前缀的子元素：`<a:tcPr>` 长在 `<a:tc>` 里面
 * （`<a:tc` 后面跟的是 `P`，不匹配），`<a:tblGrid>` / `<a:txBody>` 同理不会误切。
 */
const PPT_ROW_SPLIT = /<a:tr[ >]/;
const PPT_CELL_SPLIT = /<a:tc[ >]/;

/** XML 实体反转义（`&amp;` 必须最后做，否则 `&amp;lt;` 会被二次解码成 `<`） */
function unescapeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

/**
 * 一个单元格的文本。
 *
 * 单元格里可以有多个 `<a:p>`（多段落），这里用空格并起来而不是换行：
 * 换行在下游会被当成行分隔，把一行记录拆成两条。
 * 合并单元格的「续格」（`hMerge` / `vMerge`）本身没有文字，解析出空串，列数保持一致。
 */
function pptCellText(cellXml: string): string {
  return [...cellXml.matchAll(PPT_TEXT_RE)]
    .map((m) => unescapeXmlEntities(m[1] ?? "").trim())
    .filter((s) => s !== "")
    .join(" ");
}

/**
 * 从一张幻灯片的 XML 里抽出所有 DrawingML 表格（`<a:tbl>`）。
 *
 * 首行作表头、其余作数据行，与 docx / xlsx 两条解析路径同一口径
 * （`ParsedTable` 的约定就是 headers + rows）。
 */
function extractTablesFromSlide(slideXml: string): ParsedTable[] {
  const tables: ParsedTable[] = [];

  for (const tableMatch of slideXml.matchAll(PPT_TABLE_RE)) {
    const tableXml = tableMatch[1] ?? "";
    const rowChunks = tableXml.split(PPT_ROW_SPLIT).slice(1);
    if (rowChunks.length === 0) continue;

    // 逐行切单元格；同一张表内按最宽行补空串，保证矩形（下游按列取值）
    const grid = rowChunks.map((rowXml) => {
      const cells = rowXml.split(PPT_CELL_SPLIT).slice(1).map(pptCellText);
      return cells;
    });
    const width = Math.max(...grid.map((cells) => cells.length));
    const rect = grid.map((cells) => [...cells, ...Array<string>(width - cells.length).fill("")]);

    // 整张表一个字都没有（空的占位 graphicFrame）就不算表，免得下游多出一张空表
    const blank = rect.every((cells) => cells.every((cell) => cell === ""));
    if (blank) continue;

    const [headers, ...rows] = rect;
    tables.push({ headers: headers ?? [], rows });
  }

  return tables;
}

async function parsePptx(buffer: Buffer): Promise<ParseResult> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);

  const allFiles = Object.keys(zip.files);
  const numberOf = (file: string) => Number(/slide(\d+)\.xml$/.exec(file)?.[1] ?? 0);
  // 按**数字**排，不能按字典序：字典序会把 slide10 排到 slide2 前面，
  // 十页以上的 PPT 文本顺序会乱（`[Slide 10]` 出现在 `[Slide 2]` 之前）。
  const slideFiles = allFiles
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => numberOf(a) - numberOf(b));

  const textParts: string[] = [];
  const tables: ParsedTable[] = [];
  /** 每页幻灯片的文本（变更表 #212） */
  const slideTexts: string[] = [];

  for (const slideFile of slideFiles) {
    const xml = await zip.file(slideFile)!.async("string");
    const slideIndex = numberOf(slideFile) || "?";

    // 文本：包含表格单元格里的 `<a:t>`，所以表格内容本来就在纯文本里
    const texts = [...xml.matchAll(PPT_TEXT_RE)]
      .map((m) => unescapeXmlEntities(m[1] ?? "").trim())
      .filter((s) => s !== "");

    const slideLines: string[] = [];
    if (texts.length > 0) {
      slideLines.push(`[Slide ${slideIndex}]`, ...texts);
    }

    for (const table of extractTablesFromSlide(xml)) {
      tables.push(table);
      // 表格也补一份带结构的纯文本，与 xlsx 路径同一做法（模型两条路都能看到）
      slideLines.push(`[Slide ${slideIndex} 表格]`, table.headers.join("\t"));
      for (const row of table.rows) slideLines.push(row.join("\t"));
    }

    if (slideLines.length > 0) {
      textParts.push(...slideLines);
      slideTexts.push(slideLines.join("\n"));
    }
  }

  return {
    text: textParts.join("\n"),
    tables,
    metadata: {
      pageCount: slideFiles.length,
    },
    // pptx 的可定位单元是 slide：引用 `文件.pptx:3` 指第 3 页幻灯片
    pages: slideTexts.map((t, i) => ({ page: i + 1, text: t })),
  };
}