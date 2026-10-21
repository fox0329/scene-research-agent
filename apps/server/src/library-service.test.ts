/**
 * @scene/server — 产品资料库整理（去重）
 *
 * 用户验收 2026-10-04：
 *   · 「表格能不能简化？」（本轮只动数据层与列级空值，见变更表 #97）
 *   · 「重复的内容能不能合并？」→ dedupeLibrary / resolveProductForModel / upsertSpecParam
 *
 * 注：原「M6 内部费率骨架」（seedRateSkeleton）随 M6 一起删除（变更表 #106）。
 */

import { describe, expect, it } from "vitest";
import { createDb } from "@scene/infra";
import { dedupeLibrary, resolveProductForModel, upsertSpecParam } from "./library-service.js";

function setup() {
  const db = createDb(":memory:");
  const line = db.productLineRepo.insert({ name: "拓维产品" });
  return { db, lineId: line.id };
}

const product = (lineId: string, model: string, status: string, created: string) =>
  db0.productRepo.insert({
    product_line_id: lineId,
    model,
    name: `${model} 产品`,
    status,
    launch_date: "2025-01-01",
    position_desc: "主力型号",
    created_at: created,
  } as never);

let db0: ReturnType<typeof createDb>;

describe("资料库去重：同型号产品行合并 + 同产品重复规格删除", () => {
  it("保留在售行、删待确认行，并把重复行的规格与缺位字段并过去", () => {
    const { db, lineId } = setup();
    db0 = db;
    const keep = product(lineId, "CT15", "在售", "2026-09-23T14:42");
    const dupe = product(lineId, "CT15", "待确认", "2026-09-24T00:44");
    db.productRepo.update(dupe.id, { former_name: "老款 CT15" } as never);
    db.quoteRepo.insert({
      product_id: dupe.id,
      model: "CT15",
      config: "标准配置",
      unit_price: "9800",
      price_scope: "纯设备",
      source: "报价单.pdf:1",
      source_type: "用户确认",
    } as never);
    db.specParamRepo.insert({
      product_id: dupe.id,
      param_class: "操作系统",
      param_name: "OS版本",
      value: "在鸿 OS L0",
      measured: "未提及",
    } as never);
    // 保留行里已有一条完全相同的规格 + 一条更短的
    db.specParamRepo.insert({
      product_id: keep.id,
      param_class: "操作系统",
      param_name: "OS版本",
      value: "在鸿 OS L0",
      measured: "未提及",
    } as never);
    db.specParamRepo.insert({
      product_id: keep.id,
      param_class: "功耗",
      param_name: "电源",
      value: "DC24V/1A",
      measured: "未提及",
    } as never);

    const report = dedupeLibrary(db, lineId);
    expect(report.productGroups).toBe(1);
    expect(report.productsRemoved).toBe(1);
    expect(db.productRepo.list({ where: "product_line_id = ?", params: [lineId] })).toHaveLength(1);
    const kept = db.productRepo.getById(keep.id)!;
    expect(kept.former_name).toBe("老款 CT15"); // 缺位字段补过来了
    const specs = db.specParamRepo.list({ where: "product_id = ?", params: [keep.id] });
    expect(specs).toHaveLength(2); // OS版本重复 1 条被删；功耗那条保留
    expect(report.specsRemoved).toBe(1);
    // M6 报价随同型号合并迁到保留行，不撞 product 外键
    const quotes = db.quoteRepo.list({ where: "product_id = ?", params: [keep.id] });
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.model).toBe("CT15");

    // 幂等：再跑一次什么都不动
    const again = dedupeLibrary(db, lineId);
    expect(again.productsRemoved).toBe(0);
    expect(again.specsRemoved).toBe(0);
  });

  it("型号写法只差空格也算同一型号（在鸿7885平板 / 在鸿 7885平板）", () => {
    const { db, lineId } = setup();
    db0 = db;
    product(lineId, "在鸿7885平板", "待确认", "2026-09-23T10:00");
    product(lineId, "在鸿 7885平板", "待确认", "2026-09-23T11:00");
    const report = dedupeLibrary(db, lineId);
    expect(report.productsRemoved).toBe(1);
    expect(db.productRepo.list({ where: "product_line_id = ?", params: [lineId] })).toHaveLength(1);
  });

  it("同键近重复：留更完整的那句值", () => {
    const { db, lineId } = setup();
    db0 = db;
    const p = product(lineId, "CT31", "在售", "2026-09-23T10:00");
    db.specParamRepo.insert({ product_id: p.id, param_class: "功耗", param_name: "电源", value: "DC24V/1A", measured: "未提及" } as never);
    db.specParamRepo.insert({
      product_id: p.id,
      param_class: "功耗",
      param_name: "电源",
      value: "DC24V/1A，支持9-36V宽电压输入",
      measured: "未提及",
    } as never);
    const report = dedupeLibrary(db, lineId);
    expect(report.specsRemoved).toBe(1);
    const specs = db.specParamRepo.list({ where: "product_id = ?", params: [p.id] });
    expect(specs).toHaveLength(1);
    expect(specs[0]!.value).toBe("DC24V/1A，支持9-36V宽电压输入");
  });

  it("值互相冲突不合并（工作温度两个值都留）", () => {
    const { db, lineId } = setup();
    db0 = db;
    const p = product(lineId, "CT31", "在售", "2026-09-23T10:00");
    db.specParamRepo.insert({ product_id: p.id, param_class: "环境参数", param_name: "工作温度", value: "-10~50℃", measured: "未提及" } as never);
    db.specParamRepo.insert({ product_id: p.id, param_class: "环境参数", param_name: "工作温度", value: "-20~60℃", measured: "未提及" } as never);
    const report = dedupeLibrary(db, lineId);
    expect(report.specsRemoved).toBe(0);
    expect(db.specParamRepo.list({ where: "product_id = ?", params: [p.id] })).toHaveLength(2);
  });
});

describe("ingest 写入前匹配：从源头不再造重复产品行（根因修复）", () => {
  it("材料里的型号已存在 → 并入该行，不新建；新口径不再写曾用名", () => {
    const { db, lineId } = setup();
    db0 = db;
    const existing = product(lineId, "CT15", "在售", "2026-09-23T14:42");
    const res = resolveProductForModel(
      db,
      lineId,
      { model: "ct15", name: "边缘控制器", former_name: "老款" },
      "ingest-x.pptx:9",
    );
    expect(res.created).toBe(false);
    expect(res.productId).toBe(existing.id);
    expect(db.productRepo.list({ where: "product_line_id = ?", params: [lineId] })).toHaveLength(1);
    // 已有 name 不覆盖（用户确认过的内容优先）
    expect(db.productRepo.getById(existing.id)!.name).toBe("CT15 产品");
    // v2.11：曾用名不再从材料解析入库，DB 列保留但不写
    expect(db.productRepo.getById(existing.id)!.former_name).toBeNull();
  });

  it("型号写法有空格差异也能匹配（不新建重复行）", () => {
    const { db, lineId } = setup();
    db0 = db;
    const existing = product(lineId, "在鸿7885平板", "待确认", "2026-09-23T10:00");
    const res = resolveProductForModel(db, lineId, { model: "在鸿 7885平板" }, "ingest-x.pptx:2");
    expect(res.created).toBe(false);
    expect(res.productId).toBe(existing.id);
  });

  it("资料库里没有的型号 → 新建一行", () => {
    const { db, lineId } = setup();
    db0 = db;
    const res = resolveProductForModel(db, lineId, { model: "CT99", name: "新型号" }, "ingest-x.pptx:1");
    expect(res.created).toBe(true);
    expect(db.productRepo.list({ where: "product_line_id = ?", params: [lineId] })).toHaveLength(1);
  });
});

describe("规格写入：完全相同不重写、更完整则覆盖、冲突则并存", () => {
  const fields = (value: string) => ({ param_class: "功耗", param_name: "电源", value });

  it("库里已有完全相同 → 不写第二遍", () => {
    const { db, lineId } = setup();
    db0 = db;
    const p = product(lineId, "CT15", "在售", "2026-09-23T14:42");
    expect(upsertSpecParam(db, p.id, fields("DC24V/1A"), "a.pptx:1")).toBe(true);
    expect(upsertSpecParam(db, p.id, fields(" DC24V/1A "), "b.pptx:2")).toBe(false);
    expect(db.specParamRepo.list({ where: "product_id = ?", params: [p.id] })).toHaveLength(1);
  });

  it("新材料更完整 → 用完整那句覆盖", () => {
    const { db, lineId } = setup();
    db0 = db;
    const p = product(lineId, "CT15", "在售", "2026-09-23T14:42");
    upsertSpecParam(db, p.id, fields("DC24V/1A"), "a.pptx:1");
    expect(upsertSpecParam(db, p.id, fields("DC24V/1A，支持9-36V宽电压输入"), "b.pptx:2")).toBe(true);
    const specs = db.specParamRepo.list({ where: "product_id = ?", params: [p.id] });
    expect(specs).toHaveLength(1);
    expect(specs[0]!.value).toBe("DC24V/1A，支持9-36V宽电压输入");
  });

  it("值冲突（互不包含）→ 两条并存，不擅自覆盖", () => {
    const { db, lineId } = setup();
    db0 = db;
    const p = product(lineId, "CT15", "在售", "2026-09-23T14:42");
    upsertSpecParam(db, p.id, fields("-10~50℃"), "a.pptx:1");
    expect(upsertSpecParam(db, p.id, fields("-20~60℃"), "b.pptx:2")).toBe(true);
    expect(db.specParamRepo.list({ where: "product_id = ?", params: [p.id] })).toHaveLength(2);
  });
});
