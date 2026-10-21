import { describe, expect, it } from "vitest";
import type { ApiLibraryAuditReport } from "../api";
import {
  auditAbsoluteRows,
  auditConflictRows,
  auditSummaryText,
  auditUnlocatableRows,
} from "./library-audit.js";

const report: ApiLibraryAuditReport = {
  scanned: 200,
  byTable: { M1: 10, M2: 190 },
  evidence: { A: 0, B: 180, C: 20, D: 0 },
  downgraded: 20,
  unlocatable: [
    { table: "M2", row_id: "s1", source: "CT15.docx:未知", summary: "处理器 RK3588J" },
  ],
  absolute: [
    {
      table: "M3",
      row_id: "c1",
      source: "白皮书.pdf:12",
      summary: "人脸识别",
      term: "100%、唯一",
      terms: ["100%", "唯一"],
    },
  ],
  conflicts: [
    {
      table: "M2",
      key: "CT21B/处理器/CPU",
      values: [
        { value: "RK3588J", source: "规格书.pdf:12", row_id: "s2" },
        { value: "RK3588", source: "规格书-v2.pdf:13", row_id: "s3" },
      ],
    },
  ],
  generatedAt: "2026-10-21T00:00:00.000Z",
  applied: false,
};

describe("已导入资料页：体检摘要与清单", () => {
  it("摘要含扫描行数、证据分布、缺页码、冲突", () => {
    const text = auditSummaryText(report);
    expect(text).toContain("扫描 200 行");
    expect(text).toContain("B 180");
    expect(text).toContain("C 20");
    expect(text).toContain("缺页码 1 行");
    expect(text).toContain("冲突 1 组");
  });

  it("缺页码 / 绝对化 / 冲突都渲染成「表 / 行摘要 / 来源 / 问题」四列", () => {
    expect(auditUnlocatableRows(report)).toEqual([
      {
        table: "M2",
        summary: "处理器 RK3588J",
        source: "CT15.docx:未知",
        issue: "来源缺页码/章节号，需补成「文件名:页码」",
      },
    ]);
    expect(auditAbsoluteRows(report)[0]).toMatchObject({
      table: "M3",
      summary: "人脸识别",
      source: "白皮书.pdf:12",
      issue: "绝对化措辞：100%、唯一",
    });
    expect(auditConflictRows(report)[0]).toMatchObject({
      table: "M2",
      summary: "CT21B/处理器/CPU",
      source: "规格书.pdf:12；规格书-v2.pdf:13",
      issue: "RK3588J ／ RK3588",
    });
  });

  it("空来源显示为（空），清单为空时不炸", () => {
    const empty: ApiLibraryAuditReport = {
      ...report,
      unlocatable: [{ table: "M1", row_id: "p1", source: "", summary: "X" }],
      absolute: [],
      conflicts: [],
    };
    expect(auditUnlocatableRows(empty)[0]!.source).toBe("（空）");
    expect(auditAbsoluteRows(empty)).toEqual([]);
    expect(auditConflictRows(empty)).toEqual([]);
  });
});
