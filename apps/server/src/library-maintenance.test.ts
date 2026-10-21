/**
 * 能力重复合并：同键保留描述最长的一行；幂等；预览不改库
 */

import { describe, it, expect } from "vitest";
import { createDb } from "@scene/infra";
import {
  mergeDuplicateCapabilities,
  previewDuplicateCapabilities,
} from "./library-maintenance.js";

function capability(
  db: ReturnType<typeof createDb>,
  lineId: string,
  domain: string,
  name: string,
  description: string,
  source: string,
) {
  return db.capabilityRepo.insert({
    product_line_id: lineId,
    domain,
    name,
    description,
    maturity: "已交付",
    dependency: "",
    source_type: "AI提取",
    source,
    source_authority: "T3",
    evidence_level: "B",
  } as never);
}

function setup() {
  const db = createDb(":memory:");
  const line = db.productLineRepo.insert({ name: "能力合并库" });
  return { db, lineId: line.id };
}

describe("mergeDuplicateCapabilities", () => {
  it("同产品线+领域+能力名：保留描述更长的一行，删除短行", () => {
    const { db, lineId } = setup();
    const short = capability(db, lineId, "工业", "设备监测", "支持设备状态监测", "材料A.docx");
    const long = capability(
      db,
      lineId,
      "工业 ",
      "设备 监测",
      "支持设备状态实时监测，并可导出历史曲线与告警记录",
      "材料B.docx",
    );

    const report = mergeDuplicateCapabilities(db, lineId);
    expect(report.merged).toHaveLength(1);
    expect(report.merged[0]!.keptId).toBe(long.id);
    expect(report.merged[0]!.removedIds).toEqual([short.id]);
    expect(report.merged[0]!.keptDescription).toContain("历史曲线");
    expect(report.merged[0]!.removedDescriptions).toEqual(["支持设备状态监测"]);
    expect(db.capabilityRepo.getById(long.id)).toBeTruthy();
    expect(db.capabilityRepo.getById(short.id)).toBeUndefined();
  });

  it("幂等：合并后再跑 merged = 0", () => {
    const { db, lineId } = setup();
    capability(db, lineId, "工业", "设备监测", "短描述", "材料A.docx");
    capability(db, lineId, "工业", "设备监测", "更长一些的描述内容", "材料B.docx");

    expect(mergeDuplicateCapabilities(db, lineId).merged).toHaveLength(1);
    expect(mergeDuplicateCapabilities(db, lineId).merged).toHaveLength(0);
    expect(
      db.capabilityRepo.list({ where: "product_line_id = ?", params: [lineId] }),
    ).toHaveLength(1);
  });

  it("预览只读：列出将合并的组，不删任何行", () => {
    const { db, lineId } = setup();
    capability(db, lineId, "工业", "设备监测", "短描述", "材料A.docx");
    capability(db, lineId, "工业", "设备监测", "更长一些的描述内容", "材料B.docx");

    const preview = previewDuplicateCapabilities(db, lineId);
    expect(preview.merged).toHaveLength(1);
    expect(
      db.capabilityRepo.list({ where: "product_line_id = ?", params: [lineId] }),
    ).toHaveLength(2);
  });

  it("描述等长时保留创建更早的行", () => {
    const { db, lineId } = setup();
    const early = capability(db, lineId, "工业", "设备监测", "同样长的描述", "材料A.docx");
    const late = capability(db, lineId, "工业", "设备监测", "同样长的描述", "材料B.docx");
    db.db
      .prepare("UPDATE capability SET created_at = ? WHERE id = ?")
      .run("2025-01-01T00:00:00.000Z", early.id);
    db.db
      .prepare("UPDATE capability SET created_at = ? WHERE id = ?")
      .run("2025-06-01T00:00:00.000Z", late.id);

    const report = mergeDuplicateCapabilities(db, lineId);
    expect(report.merged[0]!.keptId).toBe(early.id);
    expect(report.merged[0]!.removedIds).toEqual([late.id]);
  });

  it("不同产品线的同名能力不合并；指定产品线只处理该库", () => {
    const { db, lineId } = setup();
    const other = db.productLineRepo.insert({ name: "另一个库" });
    const a = capability(db, lineId, "工业", "设备监测", "同一句描述", "材料A.docx");
    const b = capability(db, other.id, "工业", "设备监测", "同一句描述", "材料B.docx");

    expect(mergeDuplicateCapabilities(db, lineId).merged).toHaveLength(0);
    expect(db.capabilityRepo.getById(a.id)).toBeTruthy();
    expect(db.capabilityRepo.getById(b.id)).toBeTruthy();

    // 不传产品线 = 全库，但两条分属不同库，仍不是同键
    expect(mergeDuplicateCapabilities(db).merged).toHaveLength(0);
  });

  it("不传产品线时全库范围内同键仍会合并", () => {
    const { db, lineId } = setup();
    const short = capability(db, lineId, "工业", "设备监测", "短", "材料A.docx");
    const long = capability(db, lineId, "工业", "设备监测", "这是一段更长的描述", "材料B.docx");

    const report = mergeDuplicateCapabilities(db);
    expect(report.merged).toHaveLength(1);
    expect(report.merged[0]!.keptId).toBe(long.id);
    expect(db.capabilityRepo.getById(short.id)).toBeUndefined();
  });
});
