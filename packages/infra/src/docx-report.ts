/**
 * @scene/infra — 报告 Markdown → Word（.docx）
 *
 * 为什么手写 OOXML：交付格式来自用户的《Word 输出格式规范》v0.3（军标模板），页面、
 * 页边距、Heading 行距、正文首行缩进都要逐项对齐，第三方库的默认样式树反而要一层层改；
 * 且仓库已有 jszip 依赖（沿用 doc-parser 的动态 import 写法），不引入新依赖。
 *
 * 解析铁律：**任何解析不出来的行都不许丢**——最差当普通段落写进去。
 *
 * 约定：
 *  - 文件开头第一个 `#` = 封面（第一页顶部空 3 行后写报告名，标题后的 `>` 引用块不渲染）；
 *    封面后依次是目录页、正文；
 *  - `##`→Heading1、`###`→Heading2、`####`→Heading3、`#####`/`######`→Heading4，
 *    后续若再出现 `#` 也按 Heading1（报告里只应有一个 `#`）；
 *  - `---`（分隔线）忽略，不生成内容也不分页；
 *  - 连续的 `| … |` 行 = 表格，`| --- |` 分隔行丢弃，首行 = 表头；每个表格后紧跟一个空段落；
 *  - `- ` / `* ` 行 = 项目符号段落；其余非空行 = 正文段落；
 *  - 行内 `**x**` → 加粗 run。
 *
 * 标题挂 Word 多级列表编号（`word/numbering.xml`，numId=1，Heading1/2/3 → ilvl 0/1/2，
 * 阿拉伯数字 1 / 1.1 / 1.1.1，规范 §2.1）：章节增删由 Word 自动重排。
 * 因此 `##` 及更深的标题文字里**已有的章号要先剥掉**（「一、现状」→「现状」），
 * 否则会和自动编号叠成「1 一、现状」；封面 `#` 标题不剥——报告名里可能有别的数字。
 *
 * @module docx-report
 */

/** 生成参数 */
export interface DocxOptions {
  /** 页眉左侧文字（一般传报告名）；缺省不写页眉 */
  headerText?: string;
  /** 生成时间，写进 docProps/core.xml；缺省用当前时间 */
  createdAt?: Date;
}

// ─── 常量：命名空间与页面 ────────────────────────────────────

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const CP_NS = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
const DC_NS = "http://purl.org/dc/elements/1.1/";
const DCTERMS_NS = "http://purl.org/dc/terms/";
const DCMITYPE_NS = "http://purl.org/dc/dcmitype/";
const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";
const EP_NS = "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
const VT_NS = "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes";

const FONT_LATIN = "Times New Roman";
const FONT_CN_BODY = "宋体";
const FONT_CN_COVER = "黑体";

/** 封面上标题之前空几行（用户定稿：「在第一页往下空3行显示」） */
const COVER_BLANK_LINES = 3;

/** 空段落：封面留白、表格后留白共用 */
const EMPTY_PARAGRAPH_XML = "<w:p/>";

/**
 * 表标题样式名（规范 §1.5《正文表标题》：黑体 12pt、居中、无首行缩进、表格**上方**）
 *
 * 用**命名样式**而不是就地写格式：样式名会出现在 Word 的样式面板里，用户改一处就整篇生效，
 * 这也正是规范把「正文表标题」写成一个样式名的原因。
 */
const STYLE_TABLE_CAPTION = "正文表标题";

/**
 * 认得出「表标题」的写法：`表 4-1 YS-EC3200 关键规格` / `表3.1-1 编号说明` / `表A-2 认证清单`。
 *
 * 三条约束都是为了**不误伤正文**：
 *  - `表` 后面必须是编号（数字或大写字母），所以「表格11 的内容…」「表示……」都不会命中；
 *  - 编号与标题文字之间必须有空白，「表2是…」这种口语不会命中；
 *  - 整行不能以句末标点收尾——标题不会是完整句子。
 */
const TABLE_CAPTION_PATTERN = /^表\s*[0-9A-Z]+(?:[-.][0-9]+)*\s+\S/;
const TABLE_CAPTION_TAIL = /[。；;]$/;

/** 多级列表 numId（规范 §2.1：章节编号走 numId=1） */
const NUMBERING_NUM_ID = "1";
/** 三级章节编号格式：Heading1 → %1、Heading2 → %1.%2、Heading3 → %1.%2.%3 */
const NUMBERING_LEVEL_TEXTS: ReadonlyArray<string> = ["%1", "%1.%2", "%1.%2.%3"];

/** A4 = 210×297mm，1cm = 567 twip */
const PAGE_WIDTH = 11906;
const PAGE_HEIGHT = 16838;
const PAGE_MARGIN = { top: 1418, right: 1418, bottom: 1418, left: 1814, header: 851, footer: 794 };
/** 正文可用宽度 = 页宽 − 左右页边距（表格均分列宽用） */
const TABLE_WIDTH = PAGE_WIDTH - PAGE_MARGIN.left - PAGE_MARGIN.right;

const LINE_ONE_HALF = '<w:spacing w:before="0" w:after="0" w:line="360" w:lineRule="auto"/>';
const NO_INDENT = '<w:ind w:firstLine="0"/>';

/** 目录域：三部分（begin / instrText / separate / 占位 / end）在 buildTocParagraph 里拼 */
const TOC_FIELD_CODE = 'TOC \\o "1-3" \\h \\z \\u';
const TOC_PLACEHOLDER = "右键更新域以生成目录";

const CONTENT_TYPE_OVERRIDES: ReadonlyArray<[string, string]> = [
  ["/word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"],
  ["/word/styles.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"],
  ["/word/numbering.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"],
  ["/word/settings.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"],
  ["/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"],
  ["/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"],
];

// ─── 行内与段落 ──────────────────────────────────────────────

interface InlineRun {
  text: string;
  bold: boolean;
}

interface RunFormat {
  /** 强制加粗整段（标题、表头） */
  bold?: boolean;
  /** 半磅字号；缺省由样式给 */
  half?: number;
  /** 中文字体；缺省用正文宋体（由样式给） */
  eastAsia?: string;
}

interface HeadingMatch {
  level: number;
  text: string;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 只认 `**加粗**`，未闭合的 `**` 当普通文字保留（不丢内容） */
function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const pattern = /\*\*(.+?)\*\*/g;
  let cursor = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match.index > cursor) runs.push({ text: text.slice(cursor, match.index), bold: false });
    const boldText = match[1] ?? "";
    if (boldText !== "") runs.push({ text: boldText, bold: true });
    cursor = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (cursor < text.length) runs.push({ text: text.slice(cursor), bold: false });
  if (runs.length === 0) runs.push({ text: "", bold: false });
  return runs;
}

/** w:rPr 子元素顺序是 schema 固定的：rFonts → b → sz → szCs */
function runPropsXml(format: RunFormat | undefined, bold: boolean): string {
  const bits: string[] = [];
  if (format?.eastAsia !== undefined) {
    bits.push(
      `<w:rFonts w:ascii="${FONT_LATIN}" w:hAnsi="${FONT_LATIN}" w:eastAsia="${format.eastAsia}" w:cs="${FONT_LATIN}"/>`,
    );
  }
  if (bold) bits.push("<w:b/>");
  if (format?.half !== undefined) bits.push(`<w:sz w:val="${format.half}"/><w:szCs w:val="${format.half}"/>`);
  return bits.length > 0 ? `<w:rPr>${bits.join("")}</w:rPr>` : "";
}

function runsXml(text: string, format?: RunFormat): string {
  return parseInline(text)
    .map((run) => {
      const bold = run.bold || format?.bold === true;
      return `<w:r>${runPropsXml(format, bold)}<w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`;
    })
    .join("");
}

function paragraphXml(text: string, pPr: string, format?: RunFormat): string {
  return `<w:p><w:pPr>${pPr}</w:pPr>${runsXml(text, format)}</w:p>`;
}

/** 正文段落：缩进/行距/两端对齐全部继承 Normal 样式，这里不重复声明 */
function bodyParagraphXml(text: string): string {
  return `<w:p>${runsXml(text)}</w:p>`;
}

/** 表标题：格式全在样式里（黑体 12pt 居中、不缩进、keepNext 跟住下表） */
function tableCaptionXml(text: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="${STYLE_TABLE_CAPTION}"/></w:pPr>${runsXml(text)}</w:p>`;
}

/** 这一行是不是表标题（规范 §1.5） */
function isTableCaption(line: string): boolean {
  const text = line.trim();
  return TABLE_CAPTION_PATTERN.test(text) && !TABLE_CAPTION_TAIL.test(text);
}

function pageBreakParagraphXml(): string {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

// ─── 封面 / 目录 ─────────────────────────────────────────────

function coverTitleXml(text: string): string {
  return paragraphXml(text, `<w:spacing w:before="0" w:after="0" w:line="600" w:lineRule="exact"/>${NO_INDENT}<w:jc w:val="center"/>`, {
    bold: true,
    half: 48,
    eastAsia: FONT_CN_COVER,
  });
}

function tocTitleXml(): string {
  return paragraphXml("目  录", `${LINE_ONE_HALF}${NO_INDENT}<w:jc w:val="center"/>`, {
    half: 32,
    eastAsia: FONT_CN_COVER,
  });
}

/**
 * TOC 域。instrText 里是域代码常量（含 `"`），XML 文本节点中引号无需转义，
 * 这里**不**走 escapeXml——否则域代码会被写成 &quot; 而打不开目录。
 */
function tocParagraphXml(): string {
  const field =
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve">${TOC_FIELD_CODE}</w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    `<w:r><w:t>${TOC_PLACEHOLDER}</w:t></w:r>` +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  return `<w:p><w:pPr>${LINE_ONE_HALF}${NO_INDENT}<w:jc w:val="left"/></w:pPr>${field}</w:p>`;
}

// ─── 页眉 / 页脚 ─────────────────────────────────────────────

function headerXml(text: string): string {
  const pPr =
    '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>' +
    `${LINE_ONE_HALF}${NO_INDENT}<w:jc w:val="center"/>`;
  return `${XML_DECL}
<w:hdr xmlns:w="${W_NS}" xmlns:r="${R_NS}">${paragraphXml(text, pPr, { half: 18 })}</w:hdr>`;
}

/** 页脚：第 {PAGE} 页 共 {NUMPAGES} 页 —— 用域代码，页码自动刷新 */
function footerXml(): string {
  const field = (code: string, placeholder: string): string =>
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve"> ${code} </w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    `<w:r><w:t>${placeholder}</w:t></w:r>` +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  const run = (text: string): string => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
  const body = run("第 ") + field("PAGE", "1") + run(" 页 共 ") + field("NUMPAGES", "1") + run(" 页");
  return `${XML_DECL}
<w:ftr xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:p><w:pPr>${LINE_ONE_HALF}${NO_INDENT}<w:jc w:val="center"/></w:pPr>${body}</w:p></w:ftr>`;
}

// ─── 样式表 ─────────────────────────────────────────────────

function rFontsXml(eastAsia: string): string {
  return `<w:rFonts w:ascii="${FONT_LATIN}" w:hAnsi="${FONT_LATIN}" w:eastAsia="${eastAsia}" w:cs="${FONT_LATIN}"/>`;
}

interface ParagraphStyleSpec {
  id: string;
  name: string;
  isDefault?: boolean;
  pPr: string;
  rPr: string;
}

function paragraphStyleXml(spec: ParagraphStyleSpec): string {
  const attrs = `w:type="paragraph" w:styleId="${spec.id}"${spec.isDefault === true ? ' w:default="1"' : ""}`;
  const children = [
    `<w:name w:val="${spec.name}"/>`,
    spec.isDefault === true ? "" : '<w:basedOn w:val="Normal"/>',
    spec.isDefault === true ? "" : '<w:next w:val="Normal"/>',
    "<w:qFormat/>",
    `<w:pPr>${spec.pPr}</w:pPr>`,
    `<w:rPr>${spec.rPr}</w:rPr>`,
  ];
  return `<w:style ${attrs}>${children.join("")}</w:style>`;
}

/**
 * 标题样式：字号/行距/大纲级别 + 章节自动编号（numLevel 给出 ilvl，Heading4 不挂）。
 * `w:pPr` 子元素顺序是 schema 固定的：numPr → spacing → ind → outlineLvl。
 */
function headingStyleXml(
  id: string,
  name: string,
  outlineLevel: number,
  half: number,
  spacing: string,
  numLevel?: number,
): string {
  const numPr =
    numLevel === undefined
      ? ""
      : `<w:numPr><w:ilvl w:val="${numLevel}"/><w:numId w:val="${NUMBERING_NUM_ID}"/></w:numPr>`;
  const pPr = numPr + spacing + NO_INDENT + `<w:outlineLvl w:val="${outlineLevel}"/>`;
  const rPr = `${rFontsXml(FONT_CN_BODY)}<w:b/><w:sz w:val="${half}"/><w:szCs w:val="${half}"/>`;
  return paragraphStyleXml({ id, name, pPr, rPr });
}

function tableStylesXml(): string {
  const cellMar =
    '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>' +
    '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar>';
  const border = (tag: string): string => `<w:${tag} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`;
  const borders = `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"]
    .map(border)
    .join("")}</w:tblBorders>`;
  const normal = `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/>${cellMar}</w:tblPr></w:style>`;
  const grid = `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:pPr><w:spacing w:before="20" w:after="20" w:line="240" w:lineRule="auto"/>${NO_INDENT}</w:pPr><w:tblPr>${borders}${cellMar}</w:tblPr></w:style>`;
  return normal + grid;
}

function stylesXml(): string {
  const normal = paragraphStyleXml({
    id: "Normal",
    name: "Normal",
    isDefault: true,
    pPr: `${LINE_ONE_HALF}<w:ind w:firstLine="420"/><w:jc w:val="both"/>`,
    rPr: `${rFontsXml(FONT_CN_BODY)}<w:sz w:val="24"/><w:szCs w:val="24"/>`,
  });
  const h1Spacing = '<w:spacing w:before="340" w:after="330" w:line="578" w:lineRule="exact"/>';
  // 表标题：`w:pPr` 顺序固定 keepNext → spacing → ind → jc；黑体 12pt（规范 §1.5）
  const tableCaption = paragraphStyleXml({
    id: STYLE_TABLE_CAPTION,
    name: STYLE_TABLE_CAPTION,
    pPr: `<w:keepNext/>${LINE_ONE_HALF}${NO_INDENT}<w:jc w:val="center"/>`,
    rPr: `${rFontsXml(FONT_CN_COVER)}<w:sz w:val="24"/><w:szCs w:val="24"/>`,
  });
  const headings = [
    headingStyleXml("Heading1", "heading 1", 0, 32, h1Spacing, 0),
    headingStyleXml("Heading2", "heading 2", 1, 30, LINE_ONE_HALF, 1),
    headingStyleXml("Heading3", "heading 3", 2, 30, LINE_ONE_HALF, 2),
    headingStyleXml("Heading4", "heading 4", 3, 28, LINE_ONE_HALF),
  ].join("");
  return `${XML_DECL}
<w:styles xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:docDefaults><w:rPrDefault><w:rPr>${rFontsXml(FONT_CN_BODY)}<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>${LINE_ONE_HALF}<w:ind w:firstLine="420"/><w:jc w:val="both"/></w:pPr></w:pPrDefault></w:docDefaults>${normal}${tableCaption}${headings}${tableStylesXml()}</w:styles>`;
}

function settingsXml(): string {
  return `${XML_DECL}
<w:settings xmlns:w="${W_NS}"><w:zoom w:percent="100"/><w:defaultTabStop w:val="420"/><w:updateFields w:val="true"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
}

// ─── 多级列表（章节自动编号）─────────────────────────────────

/** 一级 lvl；`w:lvl` 子元素顺序固定：start → numFmt → lvlText → lvlJc → pPr */
function numberingLevelXml(level: number, levelText: string): string {
  return (
    `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="decimal"/>` +
    `<w:lvlText w:val="${levelText}"/><w:lvlJc w:val="left"/>` +
    '<w:pPr><w:ind w:left="0" w:hanging="0"/></w:pPr></w:lvl>'
  );
}

/**
 * `word/numbering.xml`：一条三级多级列表（numId=1），格式 1 / 1.1 / 1.1.1（规范 §2.1）。
 * Heading1/2/3 的样式里挂 numPr 指到这条列表，增删章节时 Word 自动重排编号。
 */
function numberingXml(): string {
  const levels = NUMBERING_LEVEL_TEXTS.map((text, level) => numberingLevelXml(level, text)).join("");
  const abstractNum = `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/>${levels}</w:abstractNum>`;
  const num = `<w:num w:numId="${NUMBERING_NUM_ID}"><w:abstractNumId w:val="0"/></w:num>`;
  return `${XML_DECL}
<w:numbering xmlns:w="${W_NS}">${abstractNum}${num}</w:numbering>`;
}

// ─── Markdown → 块 ──────────────────────────────────────────

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function isHorizontalRule(line: string): boolean {
  return /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

function isQuote(line: string): boolean {
  return line.trim().startsWith(">");
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith("|");
}

function isTableSeparator(line: string): boolean {
  return /^\|[\s:|-]+\|$/.test(line.trim());
}

function isListItem(line: string): boolean {
  // `* ` 才算列表项；`**加粗**` 开头（第二个字符还是 *）不算
  return /^[-*]\s+/.test(line.trim());
}

function matchHeading(line: string): HeadingMatch | null {
  const match = /^(#{1,6})\s+(.*)$/.exec(line.trim());
  if (match === null) return null;
  return { level: (match[1] ?? "").length, text: (match[2] ?? "").trim() };
}

/** `##`→Heading1、`###`→Heading2、`####`→Heading3、`#####`/`######`→Heading4；`#` 夹到 Heading1 */
function headingStyleId(level: number): string {
  return `Heading${Math.min(Math.max(level - 1, 1), 4)}`;
}

/** 中文数字（含「十一」这类组合） */
const CN_NUMERAL = "一二三四五六七八九十百零〇";

/**
 * 标题行首的章号写法（报告里出现过的手写编号都要认出）：
 * `一、` `十一、` / `一.` `一．` / `1、` `1.1、` / `1.` `1.1` `1.1.1` / `（一）` `(1)`。
 *
 * 阿拉伯编号分两条：
 *  - 「数字 + 顿号」不强制跟空白——顿号在中文里只当编号分隔符（`1、现状` 也要剥）；
 *  - 「数字 + 点」必须跟空白（`1. 现状`），多级点分只认 `1.1` / `1.1.1` 这种「点后还有数字」的写法，
 *    这样「2026 年规划」「10 个要点」原样保留（`1.5 倍增长` 与小节号 `1.5` 无法区分，按规范一律剥）。
 */
const HEADING_NUMBER_PATTERNS: ReadonlyArray<RegExp> = [
  new RegExp(`^[${CN_NUMERAL}]{1,3}、\\s*`),
  new RegExp(`^[${CN_NUMERAL}]{1,3}[.．]\\s*`),
  /^\d+(?:\.\d+)*、\s*/,
  /^\d+(?:\.\d+)*\.\s+/,
  /^\d+(?:\.\d+)+\s+/,
  new RegExp(`^[（(][${CN_NUMERAL}0-9]{1,4}[）)]\\s*`),
];

/**
 * 剥掉标题文字里已有的章号（「一、现状」→「现状」）。
 * 编号已交给 Word 多级列表自动生成，不剥就会叠成「1 一、现状」。
 * 剥完为空说明整行只剩编号，保留原文——宁可编号重复也不要空标题。
 */
function stripHeadingNumber(text: string): string {
  const trimmed = text.trim();
  for (const pattern of HEADING_NUMBER_PATTERNS) {
    if (!pattern.test(trimmed)) continue;
    const stripped = trimmed.replace(pattern, "").trim();
    if (stripped !== "") return stripped;
  }
  return trimmed;
}

/** 标题：`#`（封面后的第一个）保持原文，`##` 及更深剥掉手写章号 */
function headingTextOf(heading: HeadingMatch): string {
  return heading.level === 1 ? heading.text : stripHeadingNumber(heading.text);
}

function headingParagraphXml(level: number, text: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="${headingStyleId(level)}"/></w:pPr>${runsXml(text)}</w:p>`;
}

function listParagraphXml(text: string): string {
  const pPr = `${LINE_ONE_HALF}<w:ind w:left="420" w:firstLine="0"/>`;
  return paragraphXml(`• ${text}`, pPr);
}

function splitTableRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => cell.trim());
}

/** 表头行 = 第一行；`| --- |` 分隔行丢弃 */
function collectTable(lines: string[], start: number): { rows: string[][]; next: number } {
  const rows: string[][] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!isTableRow(line)) break;
    if (!isTableSeparator(line)) rows.push(splitTableRow(line));
    index += 1;
  }
  return { rows, next: index };
}

function tableCellXml(text: string, isHeader: boolean): string {
  const align = isHeader ? '<w:jc w:val="center"/>' : "";
  const pPr = '<w:spacing w:before="20" w:after="20" w:line="240" w:lineRule="auto"/>' + NO_INDENT + align;
  const runs = runsXml(text, { bold: isHeader, half: 21 });
  return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p><w:pPr>${pPr}</w:pPr>${runs}</w:p></w:tc>`;
}

function tableRowXml(row: string[], isHeader: boolean, columnCount: number): string {
  const cells: string[] = [];
  for (let index = 0; index < columnCount; index += 1) {
    cells.push(tableCellXml(row[index] ?? "", isHeader));
  }
  // tblHeader 只标在首行：Word 跨页时重复表头
  const trPr = isHeader ? "<w:trPr><w:tblHeader/></w:trPr>" : "";
  return `<w:tr>${trPr}${cells.join("")}</w:tr>`;
}

function tableXml(rows: string[][]): string {
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (columnCount === 0) return "";
  const columnWidth = Math.floor(TABLE_WIDTH / columnCount);
  const grid = `<w:tblGrid>${`<w:gridCol w:w="${columnWidth}"/>`.repeat(columnCount)}</w:tblGrid>`;
  const trs = rows.map((row, index) => tableRowXml(row, index === 0, columnCount)).join("");
  const tblPr =
    '<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>' +
    '<w:jc w:val="center"/><w:tblLayout w:type="autofit"/></w:tblPr>';
  return `<w:tbl>${tblPr}${grid}${trs}</w:tbl>`;
}

/** 正文块：按行扫描，逐块成段，谁也不丢 */
function renderBlocks(lines: string[], start: number): string {
  const out: string[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (isBlank(line) || isHorizontalRule(line)) {
      index += 1;
      continue;
    }
    if (isTableRow(line)) {
      const { rows, next } = collectTable(lines, index);
      const table = tableXml(rows);
      // 表格后紧跟一个空段落：正文不会贴着表格（且 Word 要求表格不能是 body 的最后一个元素）。
      // Markdown 里表格后的空行本来就不产生段落，所以这里不会出现两个连续空段。
      if (table !== "") out.push(table + EMPTY_PARAGRAPH_XML);
      index = next;
      continue;
    }
    if (isListItem(line)) {
      out.push(listParagraphXml(line.trim().replace(/^[-*]\s+/, "")));
      index += 1;
      continue;
    }
    const heading = matchHeading(line);
    if (heading !== null) {
      out.push(headingParagraphXml(heading.level, headingTextOf(heading)));
      index += 1;
      continue;
    }
    if (isQuote(line)) {
      out.push(bodyParagraphXml(line.trim().replace(/^>\s?/, "")));
      index += 1;
      continue;
    }
    if (isTableCaption(line)) {
      out.push(tableCaptionXml(line.trim()));
      index += 1;
      continue;
    }
    out.push(bodyParagraphXml(line.trim()));
    index += 1;
  }
  return out.join("");
}

/**
 * 封面 = 第一页顶部**空 3 行**后写报告名（变更表 #134，用户定稿逐字要求：
 * 「标题 智慧会议室 内部调研报告 2026-10-07 在第一页往下空3行显示」）。
 * 标题后面如果有 `>` 引用块（#134 之前的老报告才有：场景行 + 日期行），
 * 这里只**消费掉**不渲染——封面上除了报告名不留别的内容。
 */
function takeCover(lines: string[]): { xml: string; title: string; start: number } {
  let index = 0;
  while (index < lines.length && isBlank(lines[index] ?? "")) index += 1;
  const heading = matchHeading(lines[index] ?? "");
  if (heading === null || heading.level !== 1) return { xml: "", title: "", start: 0 };
  index += 1;
  while (index < lines.length && isBlank(lines[index] ?? "")) index += 1;
  while (index < lines.length && isQuote(lines[index] ?? "")) index += 1;
  const blanks = EMPTY_PARAGRAPH_XML.repeat(COVER_BLANK_LINES);
  return { xml: blanks + coverTitleXml(heading.text), title: heading.text, start: index };
}

// ─── OOXML 部件 ─────────────────────────────────────────────

function documentXml(body: string, hasHeader: boolean): string {
  const refs =
    (hasHeader ? '<w:headerReference w:type="default" r:id="rIdHeader"/>' : "") +
    '<w:footerReference w:type="default" r:id="rIdFooter"/>';
  const pgMar = `<w:pgMar w:top="${PAGE_MARGIN.top}" w:right="${PAGE_MARGIN.right}" w:bottom="${PAGE_MARGIN.bottom}" w:left="${PAGE_MARGIN.left}" w:header="${PAGE_MARGIN.header}" w:footer="${PAGE_MARGIN.footer}" w:gutter="0"/>`;
  const sectPr = `<w:sectPr>${refs}<w:pgSz w:w="${PAGE_WIDTH}" w:h="${PAGE_HEIGHT}"/>${pgMar}<w:cols w:space="425"/></w:sectPr>`;
  return `${XML_DECL}
<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${body}${sectPr}</w:body></w:document>`;
}

function contentTypesXml(hasHeader: boolean): string {
  const extras: Array<[string, string]> = [];
  if (hasHeader) {
    extras.push(["/word/header1.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"]);
  }
  extras.push(["/word/footer1.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"]);
  const defaults =
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>';
  const overrides = [...CONTENT_TYPE_OVERRIDES, ...extras]
    .map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`)
    .join("");
  return `${XML_DECL}
<Types xmlns="${CT_NS}">${defaults}${overrides}</Types>`;
}

function rootRelsXml(): string {
  const docRels = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const pkgRels = "http://schemas.openxmlformats.org/package/2006/relationships";
  const items = [
    `<Relationship Id="rId1" Type="${docRels}/officeDocument" Target="word/document.xml"/>`,
    `<Relationship Id="rId2" Type="${pkgRels}/metadata/core-properties" Target="docProps/core.xml"/>`,
    `<Relationship Id="rId3" Type="${docRels}/extended-properties" Target="docProps/app.xml"/>`,
  ];
  return `${XML_DECL}
<Relationships xmlns="${PKG_REL_NS}">${items.join("")}</Relationships>`;
}

function documentRelsXml(hasHeader: boolean): string {
  const docRels = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const items = [
    `<Relationship Id="rIdStyles" Type="${docRels}/styles" Target="styles.xml"/>`,
    `<Relationship Id="rIdNumbering" Type="${docRels}/numbering" Target="numbering.xml"/>`,
    `<Relationship Id="rIdSettings" Type="${docRels}/settings" Target="settings.xml"/>`,
  ];
  if (hasHeader) items.push(`<Relationship Id="rIdHeader" Type="${docRels}/header" Target="header1.xml"/>`);
  items.push(`<Relationship Id="rIdFooter" Type="${docRels}/footer" Target="footer1.xml"/>`);
  return `${XML_DECL}
<Relationships xmlns="${PKG_REL_NS}">${items.join("")}</Relationships>`;
}

function emptyRelsXml(): string {
  return `${XML_DECL}\n<Relationships xmlns="${PKG_REL_NS}"></Relationships>`;
}

function coreXml(title: string, createdAt: Date): string {
  const stamp = createdAt.toISOString().replace(/\.\d{3}Z$/, "Z");
  return `${XML_DECL}
<cp:coreProperties xmlns:cp="${CP_NS}" xmlns:dc="${DC_NS}" xmlns:dcterms="${DCTERMS_NS}" xmlns:dcmitype="${DCMITYPE_NS}" xmlns:xsi="${XSI_NS}"><dc:title>${escapeXml(title)}</dc:title><dc:creator>场景通</dc:creator><cp:lastModifiedBy>场景通</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>`;
}

function appXml(): string {
  return `${XML_DECL}
<Properties xmlns="${EP_NS}" xmlns:vt="${VT_NS}"><Application>场景通</Application><AppVersion>16.0000</AppVersion></Properties>`;
}

// ─── 对外 API ───────────────────────────────────────────────

/**
 * 把一份报告 Markdown 转成 .docx（A4，军标模板格式）。
 * 解析规则见模块头注释。任何解析不出来的行都不许丢——最差也要当普通段落写进去。
 */
export async function reportMarkdownToDocx(markdown: string, opts: DocxOptions = {}): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const createdAt = opts.createdAt ?? new Date();
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const cover = takeCover(lines);
  const hasHeader = (opts.headerText ?? "") !== "";
  const front =
    (cover.xml !== "" ? cover.xml + pageBreakParagraphXml() : "") +
    tocTitleXml() +
    tocParagraphXml() +
    pageBreakParagraphXml();
  const body = front + renderBlocks(lines, cover.start);

  const zip = new JSZip();
  // zip 条目的时间戳必须固定成 createdAt：JSZip 缺省用「当前时间」，会让同一份输入
  // 每次生成出不同字节，调用方（safeWriteFileBytes 按 sha256 判断「内容没变就不碰文件」）
  // 就永远认为文件变了。ZIP 的 DOS 时间从 1980 年起算，早于它就压到 1980-01-01。
  // createFolders: false —— 自动创建的目录条目拿不到 date，会重新引入「当前时间」。
  const zipDate = createdAt.getFullYear() < 1980 ? new Date(1980, 0, 1) : createdAt;
  const add = (name: string, content: string): void => {
    zip.file(name, content, { date: zipDate, createFolders: false });
  };

  add("[Content_Types].xml", contentTypesXml(hasHeader));
  add("_rels/.rels", rootRelsXml());
  add("word/document.xml", documentXml(body, hasHeader));
  add("word/styles.xml", stylesXml());
  add("word/numbering.xml", numberingXml());
  add("word/settings.xml", settingsXml());
  add("word/_rels/document.xml.rels", documentRelsXml(hasHeader));
  add("word/_rels/footer1.xml.rels", emptyRelsXml());
  add("word/footer1.xml", footerXml());
  if (hasHeader) {
    add("word/_rels/header1.xml.rels", emptyRelsXml());
    add("word/header1.xml", headerXml(opts.headerText ?? ""));
  }
  add("docProps/core.xml", coreXml(cover.title, createdAt));
  add("docProps/app.xml", appXml());
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
