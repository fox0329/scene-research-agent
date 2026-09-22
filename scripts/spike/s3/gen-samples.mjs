/**
 * 生成 S3 Spike 测试用的样本文件：
 * - sample.pdf   （简单文本 PDF）
 * - sample.docx  （Word，含表格）
 * - sample.xlsx  （Excel，含多 Sheet）
 * - sample.pptx  （PPT，含文本幻灯片）
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 1. 生成 PDF（用 pdfkit 简易生成，或用硬编码最小 PDF） ──
async function createPDF() {
  // 最小合法 PDF，包含可提取的文本
  const pdfContent = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]
   /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 178 >>
stream
BT
/F1 24 Tf
100 700 Td
(S3 Spike Test PDF) Tj
0 -40 Td
/F1 14 Tf
(This is a test document for unpdf / pdf-parse evaluation.) Tj
0 -25 Td
(The quick brown fox jumps over the lazy dog.) Tj
0 -25 Td
(Table data: A=1 B=2 C=3) Tj
ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000266 00000 n
0000000496 00000 n
trailer
<< /Size 6 /Root 1 0 R >>
startxref
573
%%EOF`;
  writeFileSync(join(__dirname, 'sample.pdf'), pdfContent, 'utf-8');
  console.log('[gen] sample.pdf created');
}

// ── 2. 生成 DOCX（用 JSZip 手工构建最小 docx） ──
async function createDOCX() {
  const zip = new JSZip();

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);

  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>S3 Spike Test Word Document</w:t></w:r></w:p>
    <w:p><w:r><w:t>This document tests mammoth.js for DOCX parsing.</w:t></w:r></w:p>
    <w:tbl>
      <w:tblPr/>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Header A</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Header B</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Header C</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Row1-A</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Row1-B</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Row1-C</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Row2-A</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Row2-B</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Row2-C</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`);

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  writeFileSync(join(__dirname, 'sample.docx'), buffer);
  console.log('[gen] sample.docx created');
}

// ── 3. 生成 XLSX ──
async function createXLSX() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'S3 Spike';

  const ws1 = wb.addWorksheet('产品矩阵');
  ws1.columns = [
    { header: '产品', key: 'name', width: 15 },
    { header: '单价(万)', key: 'price', width: 12 },
    { header: '适用场景', key: 'scenario', width: 20 },
  ];
  ws1.addRow({ name: '场景通', price: 15, scenario: '场景落地分析' });
  ws1.addRow({ name: '质序', price: 20, scenario: '质量追溯' });
  ws1.addRow({ name: '方案助手', price: 10, scenario: '方案生成' });

  const ws2 = wb.addWorksheet('Sheet2');
  ws2.addRow(['Key', 'Value', 'Note']);
  ws2.addRow(['version', '0.1', '初始版本']);
  ws2.addRow(['status', 'spike', '验证中']);

  const buffer = await wb.xlsx.writeBuffer();
  writeFileSync(join(__dirname, 'sample.xlsx'), Buffer.from(buffer));
  console.log('[gen] sample.xlsx created');
}

// ── 4. 生成 PPTX ──
async function createPPTX() {
  const zip = new JSZip();

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`);

  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);

  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldMasterIdLst/>
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId1"/>
    <p:sldId id="257" r:id="rId2"/>
  </p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>
</p:presentation>`);

  zip.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>`);

  zip.file('ppt/slides/slide1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:txBody>
          <a:p><a:r><a:t>S3 Spike Test PPT</a:t></a:r></a:p>
          <a:p><a:r><a:t>Slide 1: Testing jszip+xml for PPTX parsing</a:t></a:r></a:p>
          <a:p><a:r><a:t>This slide contains plain text paragraphs.</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`);

  zip.file('ppt/slides/slide2.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:txBody>
          <a:p><a:r><a:t>Conclusion slide</a:t></a:r></a:p>
          <a:p><a:r><a:t>Key metric: 55 tables need parsing.</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`);

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  writeFileSync(join(__dirname, 'sample.pptx'), buffer);
  console.log('[gen] sample.pptx created');
}

// ── 执行 ──
await createPDF();
await createDOCX();
await createXLSX();
await createPPTX();
console.log('\nAll sample files generated.');