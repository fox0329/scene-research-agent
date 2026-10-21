/**
 * 联网核验 / 能力重复预览的展示文案（纯函数单测）
 */

import { describe, it, expect } from "vitest";
import type { ApiLibraryVerificationSummary, ApiLibraryVerifyDetail } from "../api";
import {
  dedupePreviewText,
  sourceLabel,
  verificationRows,
  verificationSummaryText,
  verifyDoneText,
} from "./library-verify";

function detail(patch: Partial<ApiLibraryVerifyDetail> = {}): ApiLibraryVerifyDetail {
  return {
    table: "M1",
    row_id: "r1",
    summary: "CT21B 在鸿工控机CT21B",
    status: "已核实",
    authority: "T2",
    sources: [
      { title: "CT21B 产品规格", url: "https://docs.example.com/ct21b", publisher: "示例科技", published_at: "2025-06-01" },
    ],
    key_text: "CT21B",
    note: "命中 T2 独立来源",
    checked_at: "2026-10-21T00:00:00.000Z",
    upgraded: true,
    ...patch,
  };
}

function summary(over: Partial<ApiLibraryVerificationSummary> = {}): ApiLibraryVerificationSummary {
  return {
    generated_at: "2026-10-21T00:00:00.000Z",
    total: 3,
    by_status: { 已核实: 1, 未核实: 1, 有冲突: 1 },
    upgraded: 1,
    details: [],
    groups: { 已核实: [], 未核实: [], 有冲突: [] },
    ...over,
  };
}

describe("verificationSummaryText", () => {
  it("按「已核验 x（升 A y）/ 冲突 z / 未核实 w」输出", () => {
    expect(verificationSummaryText(summary())).toBe("已核验 3（升 A 1）/ 冲突 1 / 未核实 1");
  });

  it("没有核验记录时全为 0", () => {
    expect(
      verificationSummaryText(
        summary({ total: 0, by_status: { 已核实: 0, 未核实: 0, 有冲突: 0 }, upgraded: 0 }),
      ),
    ).toBe("已核验 0（升 A 0）/ 冲突 0 / 未核实 0");
  });
});

describe("verificationRows", () => {
  it("行摘要为空时依次退回关键标识、行 id", () => {
    const rows = verificationRows([
      detail({ summary: "", key_text: "CT21B" }),
      detail({ summary: "", key_text: "", row_id: "row-x" }),
    ]);
    expect(rows[0]!.summary).toBe("CT21B");
    expect(rows[1]!.summary).toBe("row-x");
  });

  it("没有权威级时显示占位符，不改写状态", () => {
    const rows = verificationRows([detail({ authority: "", status: "未核实" })]);
    expect(rows[0]!.authority).toBe("—");
    expect(rows[0]!.status).toBe("未核实");
    expect(rows[0]!.sources[0]!.url).toBe("https://docs.example.com/ct21b");
  });
});

describe("sourceLabel", () => {
  it("优先显示标题，没标题才显示 URL", () => {
    expect(sourceLabel({ title: "规格书", url: "https://x.test", publisher: "", published_at: "" })).toBe("规格书");
    expect(sourceLabel({ title: " ", url: "https://x.test", publisher: "", published_at: "" })).toBe("https://x.test");
  });
});

describe("dedupePreviewText", () => {
  it("有重复组时报组数并指到能力清单", () => {
    const text = dedupePreviewText({
      merged: [
        {
          key: "l1|工业|设备监测",
          keptId: "a",
          removedIds: ["b"],
          keptDescription: "长描述",
          removedDescriptions: ["短"],
        },
      ],
    });
    expect(text).toContain("1 组");
    expect(text).toContain("能力清单");
  });

  it("没有重复组时说明没有重复", () => {
    expect(dedupePreviewText({ merged: [] })).toContain("没有");
    expect(dedupePreviewText(undefined)).toContain("没有");
  });
});

describe("verifyDoneText", () => {
  it("汇总批次结果", () => {
    expect(verifyDoneText({ checked: 30, upgraded: 12, conflict: 1, unverified: 17 })).toBe(
      "联网核验完成：核验 30 行，升 A 12，冲突 1，未核实 17",
    );
  });
});
