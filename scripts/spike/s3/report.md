# Spike S3 · 文档解析实测

日期：2026-09-23

## 结论：✅ 全部通过

技术方案选型（unpdf / mammoth / exceljs / jszip+xml）全部验证通过，无需调整首选方案。

## 四种格式实测结果

| 格式 | 首选库 | 版本 | 状态 | 表格还原 |
|---|---|---|---|---|
| PDF | unpdf | 1.8.1 | 通过 | 纯文本行，无原生表格结构；需 LLM 后处理 |
| Word | mammoth | 1.12.3 | 通过 | HTML table 完整保留，可正则转 Markdown |
| Excel | exceljs | 4.4.0 | 通过 | 最强，原生行列结构，可直接映射 55 张标准表 |
| PPT | jszip + XML | 3.10.2 | 通过 | 文本节点完整；内嵌表格需深层 XML 解析（M2+增强） |

## 关键发现

1. pdf-parse 2.x 已不可用（API 完全重构且内部报错），从备选中移除
2. unpdf 需要 Uint8Array，不接受 Buffer，需 `new Uint8Array(buffer)` 转换
3. Word mammoth 输出 HTML table，可直接用正则转 Markdown 表格
4. Excel exceljs 原生行列结构最强，是映射 55 张标准表的首选

## 测试脚本

- scripts/spike/s3/gen-samples.mjs — 生成测试样本
- scripts/spike/s3/test-pdf.mjs — PDF 解析
- scripts/spike/s3/test-word.mjs — Word 解析
- scripts/spike/s3/test-excel.mjs — Excel 解析
- scripts/spike/s3/test-ppt.mjs — PPT 解析
