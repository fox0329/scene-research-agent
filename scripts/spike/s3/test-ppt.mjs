/**
 * S3-4 · PPT (PPTX) 解析测试
 * 方案：jszip 解压 + XML 文本节点提取
 * PPTX 本质是 ZIP，幻灯片在 ppt/slides/slide*.xml
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pptxBuffer = readFileSync(join(__dirname, 'sample.pptx'));

const results = {};

console.log('=== Test: jszip + XML text extraction ===');
try {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(pptxBuffer);

  // 列出所有文件
  const allFiles = Object.keys(zip.files);
  console.log(`  files in zip: ${allFiles.length}`);
  console.log(`  files: ${allFiles.join(', ')}`);

  // 找到所有 slide*.xml
  const slideFiles = allFiles.filter(f => f.match(/^ppt\/slides\/slide\d+\.xml$/));
  console.log(`\n  slides found: ${slideFiles.length}`);

  const slideTexts = [];
  for (const slideFile of slideFiles.sort()) {
    const xml = await zip.file(slideFile).async('string');

    // 简单 XML 文本节点提取：<a:t>text</a:t>
    const textMatches = xml.match(/<a:t>([^<]*)<\/a:t>/g) || [];
    const texts = textMatches.map(m => m.replace(/<\/?a:t>/g, ''));

    console.log(`\n  [${slideFile}] extracted ${texts.length} text nodes:`);
    for (const t of texts) {
      console.log(`    - ${t}`);
    }
    slideTexts.push({ file: slideFile, textCount: texts.length, texts });
  }

  results.jszip = {
    ok: true,
    fileCount: allFiles.length,
    slideCount: slideFiles.length,
    slideTexts,
  };
} catch (err) {
  console.error(`  FAILED: ${err.message}`);
  results.jszip = { ok: false, error: err.message };
}

console.log('\n=== PPT Summary ===');
console.log(JSON.stringify(results, null, 2));