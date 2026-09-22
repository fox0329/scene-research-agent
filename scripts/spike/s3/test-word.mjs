/**
 * S3-2 · Word (DOCX) 解析测试
 * 首选：mammoth — 提取纯文本和 HTML，含表格
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const docxBuffer = readFileSync(join(__dirname, 'sample.docx'));

const results = {};

console.log('=== Test: mammoth ===');
try {
  const mammoth = await import('mammoth');

  // 纯文本提取
  const textResult = await mammoth.extractRawText({ buffer: docxBuffer });
  console.log(`  [rawText] messages: ${textResult.messages.length}`);
  console.log(`  [rawText] preview:\n${textResult.value.substring(0, 300)}`);

  // HTML 提取（保留表格结构）
  const htmlResult = await mammoth.convertToHtml({ buffer: docxBuffer });
  console.log(`\n  [html] messages: ${htmlResult.messages.length}`);
  console.log(`  [html] preview:\n${htmlResult.value.substring(0, 500)}`);

  // 检查表格是否被提取
  const hasTable = htmlResult.value.includes('<table');
  const hasRows = (htmlResult.value.match(/<tr>/g) || []).length;
  console.log(`\n  [table] hasTable=${hasTable}, rows=${hasRows}`);

  results.mammoth = {
    ok: true,
    textLength: textResult.value.length,
    htmlLength: htmlResult.value.length,
    hasTable,
    rowCount: hasRows,
    messageCount: textResult.messages.length,
  };
} catch (err) {
  console.error(`  FAILED: ${err.message}`);
  results.mammoth = { ok: false, error: err.message };
}

console.log('\n=== Word Summary ===');
console.log(JSON.stringify(results, null, 2));