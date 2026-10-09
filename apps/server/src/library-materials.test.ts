import { describe, expect, it } from "vitest";
import {
  NO_SOURCE_FILE_LABEL,
  aggregateMaterials,
  isLegacyTempSource,
  rowBelongsToFile,
  sourceFileName,
} from "./library-materials.js";

/**
 * 来源文件聚合与匹配（变更表 #156）
 *
 * 判定全在这个纯模块里，路由只负责取行/落删除——所以"删对了没有"可以在这一层穷举。
 */
describe("来源文件清单：文件名解析与全等匹配（变更表 #156）", () => {
  it("取最后一个冒号前的部分当文件名（页码部分不带冒号）", () => {
    expect(sourceFileName("副本狄耐克鸿蒙智慧医院建设方案.pptx:12")).toBe(
      "副本狄耐克鸿蒙智慧医院建设方案.pptx",
    );
    // 文件名里带冒号也照样取对：最后一个冒号才是分隔符
    expect(sourceFileName("2026:年度方案.pptx:3-5")).toBe("2026:年度方案.pptx");
    expect(sourceFileName("白皮书.pdf:未知")).toBe("白皮书.pdf");
  });

  it("取不到文件名的都算「无来源」（空值 / 没有冒号 / 冒号开头 / 只有页码）", () => {
    for (const bad of ["", "   ", "白皮书.pdf", ":12", null, undefined, 42]) {
      expect(sourceFileName(bad)).toBe("");
    }
  });

  it("按文件名全等匹配：a.pdf 不吃 a.pdf.bak（前缀匹配会误删）", () => {
    expect(rowBelongsToFile("a.pdf:1", "a.pdf")).toBe(true);
    expect(rowBelongsToFile("a.pdf.bak:1", "a.pdf")).toBe(false);
    expect(rowBelongsToFile("a.pdf.old:9", "a.pdf")).toBe(false);
    // 反向同理：删 a.pdf.bak 也不吃 a.pdf
    expect(rowBelongsToFile("a.pdf:1", "a.pdf.bak")).toBe(false);
    expect(rowBelongsToFile("a.pdf.bak:2", "a.pdf.bak")).toBe(true);
  });

  it("带空格的来源与查询参数都能对齐（trim 后比较）", () => {
    expect(rowBelongsToFile(" 方案.pptx :7", "方案.pptx")).toBe(true);
    expect(rowBelongsToFile("方案.pptx:7", "  方案.pptx  ")).toBe(true);
  });

  it("无来源的行不属于任何文件（只能逐行删）", () => {
    expect(rowBelongsToFile("", "a.pdf")).toBe(false);
    expect(rowBelongsToFile("a.pdf", "a.pdf")).toBe(false);
  });
});

describe("资料来源聚合（变更表 #156）", () => {
  it("同名来源不同页码合并计数，并按表号分开统计", () => {
    const groups = aggregateMaterials([
      { code: "M1", source: "方案.pptx:3" },
      { code: "M1", source: "方案.pptx:9" },
      { code: "M2", source: "方案.pptx:9" },
      { code: "O1", source: "认证.pdf:1" },
    ]);
    expect(groups).toHaveLength(2);
    // 行数降序：方案 3 行在前
    expect(groups[0]).toMatchObject({
      file: "方案.pptx",
      rows: 3,
      tables: { M1: 2, M2: 1 },
      deletable: true,
    });
    expect(groups[1]).toMatchObject({
      file: "认证.pdf",
      rows: 1,
      tables: { O1: 1 },
      deletable: true,
    });
  });

  it("行数相同时按文件名升序（顺序稳定，界面不会每次刷新都换位）", () => {
    const groups = aggregateMaterials([
      { code: "M1", source: "b.pdf:1" },
      { code: "M1", source: "a.pdf:1" },
      { code: "M1", source: "c.pdf:1" },
    ]);
    expect(groups.map((g) => g.file)).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
  });

  it("空线返回 []", () => {
    expect(aggregateMaterials([])).toEqual([]);
  });

  it("无来源标注的行单独一组、不可按文件删除（清单行数之和 = 本库总行数）", () => {
    const rows = [
      { code: "M1", source: "方案.pptx:1" },
      { code: "M3", source: "" },
      { code: "M3", source: undefined as unknown },
    ];
    const groups = aggregateMaterials(rows);
    const noSource = groups.find((g) => g.file === NO_SOURCE_FILE_LABEL);
    expect(noSource).toMatchObject({ rows: 2, tables: { M3: 2 }, deletable: false });
    expect(groups.reduce((sum, g) => sum + g.rows, 0)).toBe(rows.length);
  });

  it("同名文件不会因为页码写法不同被拆成两组", () => {
    const groups = aggregateMaterials([
      { code: "M1", source: "方案.pptx:12" },
      { code: "M2", source: "方案.pptx:12-14" },
      { code: "M5", source: "方案.pptx:未知" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows).toBe(3);
  });
});

describe("历史临时名识别（变更表 #156：老数据只能原样展示）", () => {
  it("认得上传落盘的临时名（ingest-时间戳-序号.扩展名）", () => {
    expect(isLegacyTempSource("ingest-1790179606669-44.docx")).toBe(true);
    expect(isLegacyTempSource("ingest-1791527249715-1.pptx")).toBe(true);
  });

  it("真实材料名不误判（哪怕带 ingest 字样）", () => {
    expect(isLegacyTempSource("副本狄耐克鸿蒙智慧医院建设方案.pptx")).toBe(false);
    expect(isLegacyTempSource("ingest-方案.pdf")).toBe(false);
    expect(isLegacyTempSource("ingest-x.pdf:10")).toBe(false);
    expect(isLegacyTempSource("")).toBe(false);
  });
});
