/**
 * 检查管线单测（MR2-T2）：三路一轮合并、唯一清单、必改计数、去重。
 * postcheck/completeness 输入造最小行；reflection 输入直接构造条目。
 */

import { describe, expect, it } from "vitest";
import type { InfoStageId, RequirementEntry } from "@scene/contract";
import type { InfoRow, PostcheckRow } from "@scene/domain";
import { runCheckPipeline, type PipelineInput } from "./reflection-pipeline.js";

function entry(partial: Partial<RequirementEntry> = {}): RequirementEntry {
  return {
    id: "e1",
    scenario_id: "s1",
    origin_scenario_id: null,
    scope: "scene",
    kind: "constraint",
    text: "不提国产替代",
    check_anchor: { type: "keyword", terms: ["国产", "替代"], mode: "命中即违反" },
    status: "active",
    confidence: "用户原话",
    sources: [],
    artifact_refs: [],
    created_at: "2026-11-04T00:00:00.000Z",
    updated_at: "2026-11-04T00:00:00.000Z",
    ...partial,
  };
}

/** 合规行：中栏有内容、右栏有可定位来源（不触发 postcheck 硬伤） */
function cleanRow(tableCode: string, rowId: string): PostcheckRow {
  return {
    tableCode,
    rowId,
    label: "潜污泵控制",
    row: { 关键要素: "潜污泵控制箱", 方案: " PLC 控制一用一备" } as Record<string, unknown>,
    source: "手册.pdf:1",
    sourceType: "用户确认",
  };
}

function input(partial: Partial<PipelineInput> = {}): PipelineInput {
  const rows: PostcheckRow[] = [cleanRow("表1-1", "r1")];
  const infoRows = rows.map((r) => ({
    tableCode: r.tableCode,
    id: r.rowId,
    row: r.row,
  }));
  return {
    stage: 3 as InfoStageId,
    postcheckRows: rows,
    rowsByTable: { "表1-1": infoRows },
    entries: [],
    target: { text: "重点讲排涝能力", metrics: {} },
    ...partial,
  };
}

describe("检查管线（MR2-T2）", () => {
  it("三路一轮同跑：reflection 命中进必改，completeness 缺口为 advisory", () => {
    const result = runCheckPipeline(
      input({ entries: [entry()], target: { text: "方案提及国产替代路径", metrics: {} } }),
    );
    const reflection = result.findings.filter((f) => f.source === "reflection");
    expect(reflection).toHaveLength(1);
    expect(reflection[0]!.level).toBe("mandatory");
    expect(reflection[0]!.entryId).toBe("e1");
    expect(reflection[0]!.detail).toContain("不提国产替代");
    // 表行已给 → completeness 应无缺口（缺口则必为 advisory）
    for (const f of result.findings.filter((x) => x.source === "completeness")) {
      expect(f.level).toBe("advisory");
    }
  });

  it("画像条目合规（锚点未命中）→ reflection 零发现", () => {
    const result = runCheckPipeline(input({ entries: [entry()] }));
    expect(result.findings.filter((f) => f.source === "reflection")).toHaveLength(0);
  });

  it(" dismissed 条目不参与管线比对", () => {
    const result = runCheckPipeline(input({ entries: [entry({ status: "dismissed" })] }));
    expect(result.findings.filter((f) => f.source === "reflection")).toHaveLength(0);
  });

  it("counts 如实反映三路原始发现数", () => {
    const result = runCheckPipeline(
      input({ entries: [entry()], target: { text: "方案提及国产替代路径", metrics: {} } }),
    );
    expect(result.counts.reflection).toBe(1);
    expect(result.mandatoryCount).toBeGreaterThanOrEqual(1);
  });

  it("空画像 + 无违规锚点 → reflection 路零必改（postcheck 对假行的发现另计）", () => {
    const result = runCheckPipeline(input());
    expect(result.findings.filter((f) => f.source === "reflection")).toHaveLength(0);
    expect(result.counts.reflection).toBe(0);
  });

  it("InfoRow 兼容：completeness 用 rowsByTable 不炸", () => {
    const rows: InfoRow[] = [
      { id: "r1", row: { 关键要素: "潜污泵" }, source: "手册.pdf:1", source_type: "用户确认", evidence_level: "A" } as unknown as InfoRow,
    ];
    const result = runCheckPipeline(
      input({ rowsByTable: { "表1-1": rows.map((r) => ({ id: String(r.id), row: r.row as Record<string, unknown> })) } }),
    );
    expect(result.findings.length).toBeGreaterThanOrEqual(0);
  });
});
