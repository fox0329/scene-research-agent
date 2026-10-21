/**
 * 存量资料库体检（apps/server/src/library-audit.ts）
 *
 * 真实内存 SQLite：验证「只读预览不改数据 / POST 才降级、幂等、不删行」，
 * 以及不可定位、绝对化、同键冲突三类清单。
 */

import { describe, expect, it } from "vitest";
import { createDb } from "@scene/infra";
import type { DbInstance } from "@scene/infra";
import { auditLibrary } from "./library-audit.js";

interface Setup {
  db: DbInstance;
  lineId: string;
  productId: string;
}

function setup(source = "https://mp.weixin.qq.com/s/abc", extra: Record<string, unknown> = {}): Setup {
  const db = createDb(":memory:");
  const line = db.productLineRepo.insert({ name: "测试库" });
  const product = db.productRepo.insert({
    product_line_id: line.id,
    model: "CT21B",
    name: "在鸿工控机CT21B",
    status: "在售",
    launch_date: "2025-01-01",
    position_desc: "主力型号",
    source,
    source_type: "AI提取",
    source_authority: "T4",
    evidence_level: "B",
    ...extra,
  } as never);
  return { db, lineId: line.id, productId: product.id };
}

describe("存量资料体检：权威级 + 证据级", () => {
  it("T4 自媒体来源：预览不动库、POST 把 B 降为 C，再次 POST 不重复计数", () => {
    const { db, lineId, productId } = setup();
    const preview = auditLibrary(db, { productLineId: lineId });
    expect(preview.scanned).toBe(1);
    expect(preview.byTable.M1).toBe(1);
    expect(preview.downgraded).toBe(1);
    expect(preview.evidence.B).toBe(0);
    expect(preview.evidence.C).toBe(1);
    expect(preview.applied).toBe(false);
    // 只读：库里仍是 B
    expect(db.productRepo.getById(productId)!.evidence_level).toBe("B");

    const applied = auditLibrary(db, { productLineId: lineId, apply: true });
    expect(applied.applied).toBe(true);
    expect(applied.downgraded).toBe(1);
    expect(db.productRepo.getById(productId)!.evidence_level).toBe("C");

    const again = auditLibrary(db, { productLineId: lineId, apply: true });
    expect(again.downgraded).toBe(0);
    expect(again.evidence.C).toBe(1);
  });

  it("命中「100%」→ C（行保留），并进绝对化清单", () => {
    const { db, lineId, productId } = setup("行业白皮书.pdf:12", {
      position_desc: "100% 覆盖所有人脸识别场景",
      source_authority: "T2",
    });
    const report = auditLibrary(db, { productLineId: lineId });
    expect(report.downgraded).toBe(1);
    expect(report.evidence.C).toBe(1);
    expect(report.absolute).toHaveLength(1);
    expect(report.absolute[0]!.term).toBe("100%");
    expect(report.absolute[0]!.summary.length).toBeLessThanOrEqual(21);

    // 预览不删行、不改证据
    expect(db.productRepo.list({ where: "product_line_id = ?", params: [lineId] })).toHaveLength(1);
    expect(db.productRepo.getById(productId)!.evidence_level).toBe("B");

    auditLibrary(db, { productLineId: lineId, apply: true });
    expect(db.productRepo.getById(productId)!.evidence_level).toBe("C");
    // 内容一个字节没动
    expect(db.productRepo.getById(productId)!.position_desc).toBe("100% 覆盖所有人脸识别场景");
  });

  it("已是 C 的行不重复计数；原 D 保留 D", () => {
    const { db, lineId, productId } = setup("https://zhihu.com/p/1", {
      evidence_level: "C",
    });
    const report = auditLibrary(db, { productLineId: lineId, apply: true });
    expect(report.downgraded).toBe(0);
    expect(db.productRepo.getById(productId)!.evidence_level).toBe("C");

    const d = setup("https://zhihu.com/p/1", { evidence_level: "D" });
    const reportD = auditLibrary(d.db, { productLineId: d.lineId, apply: true });
    expect(reportD.downgraded).toBe(0);
    expect(d.db.productRepo.getById(d.productId)!.evidence_level).toBe("D");
  });
});

describe("存量资料体检：清单", () => {
  it("不可定位来源进清单，但行保留", () => {
    const { db, lineId, productId } = setup("在鸿CT15销售技术参数.docx:未知", {
      source_authority: "T3",
    });
    const report = auditLibrary(db, { productLineId: lineId, apply: true });
    expect(report.unlocatable).toHaveLength(1);
    expect(report.unlocatable[0]).toMatchObject({
      table: "M1",
      row_id: productId,
      source: "在鸿CT15销售技术参数.docx:未知",
    });
    expect(report.unlocatable[0]!.summary).toContain("CT21B");
    // 只报告，不删行
    expect(db.productRepo.getById(productId)).toBeTruthy();
  });

  it("M2 同 product+param_class+param_name 不同值 → 冲突分组（不改数据）", () => {
    const { db, lineId, productId } = setup("规格书.pdf:12", { source_authority: "T2" });
    const spec = (value: string, source: string) =>
      db.specParamRepo.insert({
        product_id: productId,
        param_class: "处理器",
        param_name: "CPU",
        value,
        measured: "宣称",
        source,
        source_type: "AI提取",
        source_authority: "T2",
        evidence_level: "B",
      } as never);
    spec("RK3588J", "规格书.pdf:12");
    spec("RK3588", "规格书-v2.pdf:13");

    const report = auditLibrary(db, { productLineId: lineId });
    expect(report.conflicts).toHaveLength(1);
    const conflict = report.conflicts[0]!;
    expect(conflict.table).toBe("M2");
    expect(conflict.key).toContain("CT21B");
    expect(conflict.key).toContain("处理器");
    expect(conflict.values.map((v) => v.value).sort()).toEqual(["RK3588", "RK3588J"]);
    expect(conflict.values.map((v) => v.source).sort()).toEqual([
      "规格书-v2.pdf:13",
      "规格书.pdf:12",
    ]);

    // 冲突只报告：apply 后两条规格的 value 原样保留
    auditLibrary(db, { productLineId: lineId, apply: true });
    const values = db.specParamRepo
      .list({ where: "product_id = ?", params: [productId] })
      .map((s) => s.value)
      .sort();
    expect(values).toEqual(["RK3588", "RK3588J"]);
  });

  it("M6 报价与 O1 可选材料也扫：低权威来源都能降级", () => {
    const { db, lineId, productId } = setup("白皮书.pdf:12", { source_authority: "T2" });
    const quote = db.quoteRepo.insert({
      product_id: productId,
      model: "CT21B",
      config: "标准配置",
      unit_price: "9800",
      price_scope: "纯设备",
      source: "https://mp.weixin.qq.com/s/price",
      source_type: "AI提取",
      source_authority: "T4",
      evidence_level: "B",
    } as never);
    const optional = db.optionalMaterialRepo.insert({
      product_line_id: lineId,
      category: "O1认证",
      payload: { cert_name: "CE Class B" },
      source: "https://zhihu.com/p/cert",
      source_type: "AI提取",
      source_authority: "T4",
      evidence_level: "B",
    } as never);

    const report = auditLibrary(db, { productLineId: lineId, apply: true });
    expect(report.scanned).toBe(3);
    expect(report.byTable.M6).toBe(1);
    expect(report.byTable.O1).toBe(1);
    expect(report.downgraded).toBe(2);
    expect(db.quoteRepo.getById(quote.id)!.evidence_level).toBe("C");
    expect(db.optionalMaterialRepo.getById(optional.id)!.evidence_level).toBe("C");
    // 内容字段一个没动
    expect(db.quoteRepo.getById(quote.id)!.unit_price).toBe("9800");
    expect(db.optionalMaterialRepo.getById(optional.id)!.payload).toEqual({ cert_name: "CE Class B" });
  });

  it("只扫指定产品线；空库返回全 0 且 byTable 键稳定", () => {
    const { db, lineId } = setup();
    const other = db.productLineRepo.insert({ name: "别的库" });
    db.productRepo.insert({
      product_line_id: other.id,
      model: "X1",
      name: "别的产品",
      status: "在售",
      launch_date: "2025-01-01",
      position_desc: "",
      source: "https://mp.weixin.qq.com/s/x",
      source_type: "AI提取",
      source_authority: "T4",
      evidence_level: "B",
    } as never);

    const scoped = auditLibrary(db, { productLineId: lineId });
    expect(scoped.scanned).toBe(1);
    expect(scoped.byTable.M1).toBe(1);
    expect(scoped.byTable.O1).toBe(0);

    const all = auditLibrary(db);
    expect(all.scanned).toBe(2);
  });
});
