/**
 * S3-3 · Excel (XLSX) 解析测试
 * 首选：exceljs — 读取单元格数据、Sheet 列表、表格结构
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const xlsxBuffer = readFileSync(join(__dirname, 'sample.xlsx'));

const results = {};

console.log('=== Test: exceljs ===');
try {
  const exceljs = await import('exceljs');
  const ExcelJS = exceljs.default || exceljs;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsxBuffer);

  const sheetNames = wb.worksheets.map(ws => ws.name);
  console.log(`  sheets: [${sheetNames.join(', ')}]`);

  const sheetData = {};
  for (const ws of wb.worksheets) {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells = [];
      row.eachCell({ includeEmpty: false }, (col, colNumber) => {
        cells.push({ col: colNumber, value: col.value });
      });
      rows.push({ row: rowNumber, cells });
    });
    sheetData[ws.name] = rows;
    console.log(`\n  [${ws.name}] ${rows.length} rows:`);
    for (const r of rows) {
      const vals = r.cells.map(c => `${c.value}`).join(' | ');
      console.log(`    row ${r.row}: ${vals}`);
    }
  }

  results.exceljs = {
    ok: true,
    sheetCount: wb.worksheets.length,
    sheetNames,
    sheetData,
  };
} catch (err) {
  console.error(`  FAILED: ${err.message}`);
  results.exceljs = { ok: false, error: err.message };
}

console.log('\n=== Excel Summary ===');
console.log(JSON.stringify(results, null, 2));