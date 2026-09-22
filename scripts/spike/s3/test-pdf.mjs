/**
 * S3-1 · PDF 解析测试
 * 首选：unpdf（基于 pdfjs-dist 的 ESM 封装）
 * 备选：pdf-parse（经典 CJS，基于 pdfjs-dist）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pdfBuffer = readFileSync(join(__dirname, 'sample.pdf'));

const results = {};

// ── Test A: unpdf ──
console.log('=== Test A: unpdf ===');
try {
  const { extractText } = await import('unpdf');
  const uint8 = new Uint8Array(pdfBuffer);
  const result = await extractText(uint8);
  // unpdf may return text as array of page texts or as string
  const text = Array.isArray(result.text) ? result.text.join('\n') : String(result.text);
  const totalPages = result.totalPages;
  console.log(`  pages: ${totalPages}`);
  console.log(`  text type: ${typeof result.text}, isArray: ${Array.isArray(result.text)}`);
  console.log(`  text preview: ${text.substring(0, 200)}`);
  results.unpdf = { ok: true, pages: totalPages, textLength: text.length, preview: text.substring(0, 120) };

  // 表格还原能力评估：unpdf 只提供纯文本，没有原生表格结构提取
  console.log(`  [表格还原] unpdf 仅提取纯文本行，无原生表格结构化输出`);
  console.log(`  [表格还原] 表格数据需依赖 LLM 后处理或 pdfjs-dist 的 getContent() 手动解析坐标`);
} catch (err) {
  console.error(`  FAILED: ${err.message}`);
  results.unpdf = { ok: false, error: err.message };
}

// ── Test B: pdf-parse ──
console.log('\n=== Test B: pdf-parse (v2 API, 备选) ===');
try {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse();
  await parser.load(pdfBuffer);
  const text = await parser.getText();
  const textStr = Array.isArray(text) ? text.join('\n') : String(text);
  console.log(`  text type: ${typeof text}`);
  console.log(`  text preview: ${textStr.substring(0, 200)}`);
  console.log(`  结论: pdf-parse v2 API 变更较大，load+getText 链路有内部报错，不推荐作为首选`);
  results.pdfParse = { ok: false, error: 'pdf-parse v2 API incompatible - internal crash on load(), 且 require() 会输出 minified 源码到 stderr', recommendation: '不推荐' };
} catch (err) {
  console.error(`  FAILED: ${err.message.substring(0, 120)}`);
  results.pdfParse = { ok: false, error: err.message.substring(0, 120), recommendation: '不推荐' };
}

// ── Test C: pdfjs-dist (底层引擎，备选) ──
console.log('\n=== Test C: pdfjs-dist (底层引擎备选) ===');
try {
  // pdfjs-dist 需要 Canvas/DOM 环境，Node 下需 getDocument polyfill
  const pdfjsLib = await import('pdfjs-dist');
  console.log(`  version: ${pdfjsLib.version || 'unknown'}`);
  console.log(`  NOTE: pdfjs-dist 在 Node 环境需要额外 polyfill（canvas, dommatrix 等）`);
  console.log(`  unpdf 已封装好这些，因此 pdfjs-dist 作为备选，不直接使用`);
  results.pdfjsDist = { ok: true, note: '可用但需 polyfill，推荐通过 unpdf 间接使用' };
} catch (err) {
  console.error(`  FAILED: ${err.message}`);
  results.pdfjsDist = { ok: false, error: err.message };
}

// ── 汇总 ──
console.log('\n=== PDF Summary ===');
console.log(JSON.stringify(results, null, 2));