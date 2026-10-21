/**
 * 联网核验与提级：命中判定、权威门槛、冲突、独立性、失败兜底
 *
 * 全部用注入的假检索/假页面（不联网）；落库走真实 `saveWebCapture`，
 * 因此权威级判定仍是领域层的确定性规则。
 */

import { describe, it, expect, vi } from "vitest";
import { createDb } from "@scene/infra";
import { verifyLibrary, listVerifications, type LibraryVerifyDeps } from "./library-verify.js";

const MODEL = "CT21B";
const PRODUCT_NAME = "在鸿工控机CT21B";

/** 超过 300 字、含型号与标题关键词的正文（saveWebCapture 的权威判定要过"正文过短"关） */
function bodyWith(...needles: string[]): string {
  const seed =
    "本页为产品规格说明，面向工业现场部署。设备支持多种工业协议接入、本地数据处理与远程运维，" +
    "并提供完整的接口定义、环境适应性说明与安装指引。";
  const head = `${needles.join(" ")} 产品规格说明`;
  return `# ${head}\n\n${head}\n\n${(seed + "\n\n").repeat(8)}${needles.join("\n")}`;
}

function setup() {
  const db = createDb(":memory:");
  const line = db.productLineRepo.insert({ name: "核验库" });
  const product = db.productRepo.insert({
    product_line_id: line.id,
    model: MODEL,
    name: PRODUCT_NAME,
    status: "在售",
    launch_date: "2025-01-01",
    position_desc: "主力型号",
    source_type: "AI提取",
    source: "产品彩页.docx",
    source_authority: "T3",
    evidence_level: "B",
  } as never);
  return { db, lineId: line.id, productId: product.id };
}

function io(opts: {
  url?: string;
  title?: string;
  body?: string;
  publishedAt?: string;
  failSearch?: boolean;
  failFetch?: boolean;
}): LibraryVerifyDeps {
  const url = opts.url ?? "https://docs.example.com/ct21b";
  return {
    search: async () => {
      if (opts.failSearch) return { ok: false, hits: [], error: "HTTP 503" };
      return {
        ok: true,
        hits: [{ url, title: opts.title ?? `${MODEL} 工业计算机`, snippet: opts.body ?? MODEL }],
      };
    },
    fetch: async (target: string) => {
      if (opts.failFetch) return { ok: false, url: target, markdown: "", error: "抓取失败" };
      return {
        ok: true,
        url: target,
        finalUrl: target,
        title: opts.title ?? `${MODEL} 工业计算机`,
        markdown: opts.body ?? bodyWith(MODEL, PRODUCT_NAME),
        publishedAt: opts.publishedAt ?? "2025-06-01",
        publisher: "示例科技",
        httpStatus: 200,
        contentType: "text/html",
      };
    },
  };
}

describe("verifyLibrary — M1 产品", () => {
  it("T2 独立来源命中 → 已核实 + 证据升 A", async () => {
    const { db, productId } = setup();
    const report = await verifyLibrary(db, {}, io({}));

    expect(report.checked).toBe(1);
    expect(report.verified).toBe(1);
    expect(report.upgraded).toBe(1);
    expect(report.remaining).toBe(0);
    expect(report.details[0]!.status).toBe("已核实");
    expect(report.details[0]!.authority).toBe("T2");
    expect(report.details[0]!.sources[0]!.url).toBe("https://docs.example.com/ct21b");
    expect(db.productRepo.getById(productId)!.evidence_level).toBe("A");

    const saved = db.verificationRepo.getByRow("M1", productId)!;
    expect(saved.status).toBe("已核实");
    expect(saved.key_text).toContain(MODEL);
    expect(JSON.parse(saved.sources_json)).toHaveLength(1);
  });

  it("只有 T3 → 未核实，证据级保持 B", async () => {
    const { db, productId } = setup();
    const report = await verifyLibrary(
      db,
      {},
      io({ url: "https://www.example-news.com/articles/1", publishedAt: "2025-06-01" }),
    );

    expect(report.verified).toBe(0);
    expect(report.unverified).toBe(1);
    expect(report.details[0]!.authority).toBe("T3");
    expect(report.details[0]!.note).toContain("T3");
    expect(db.productRepo.getById(productId)!.evidence_level).toBe("B");
  });

  it("型号对不上 → 未核实（不升级）", async () => {
    const { db, productId } = setup();
    const report = await verifyLibrary(
      db,
      {},
      io({
        title: "CT99 工业计算机",
        body: bodyWith("CT99", "工业计算机"),
      }),
    );

    expect(report.unverified).toBe(1);
    expect(report.verified).toBe(0);
    expect(db.productRepo.getById(productId)!.evidence_level).toBe("B");
  });

  it("同 host 的自有材料不算独立来源", async () => {
    const { db, productId } = setup();
    db.productRepo.update(productId, { source: "https://docs.example.com/spec.pdf" } as never);
    const report = await verifyLibrary(db, {}, io({}));

    expect(report.unverified).toBe(1);
    expect(report.details[0]!.note).toContain("同 host");
    expect(db.productRepo.getById(productId)!.evidence_level).toBe("B");
  });

  it("检索失败不崩：写未核实 + 失败原因，不改证据", async () => {
    const { db, productId } = setup();
    const report = await verifyLibrary(db, {}, io({ failSearch: true }));

    expect(report.checked).toBe(1);
    expect(report.unverified).toBe(1);
    expect(report.details[0]!.note).toContain("HTTP 503");
    expect(db.productRepo.getById(productId)!.evidence_level).toBe("B");
    expect(db.verificationRepo.getByRow("M1", productId)!.status).toBe("未核实");
  });

  it("只核未核验或超过 7 天的行：7 天内重复调用 checked=0", async () => {
    const { db } = setup();
    const deps = io({});
    const first = await verifyLibrary(db, {}, deps);
    expect(first.checked).toBe(1);

    const again = await verifyLibrary(db, {}, deps);
    expect(again.checked).toBe(0);
    expect(again.remaining).toBe(0);

    const later = await verifyLibrary(db, {}, {
      ...deps,
      now: () => new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
    });
    expect(later.checked).toBe(1);
  });
});

describe("verifyLibrary — 可核验范围", () => {
  it("M2/M4/M5 不核（内部规格/边界/短板，公开引擎核不了）", async () => {
    const db = createDb(":memory:");
    const line = db.productLineRepo.insert({ name: "范围测试库" });
    const lineId = line.id;
    const productId = db.productRepo.insert({
      product_line_id: lineId,
      model: "",
      name: "",
      status: "待确认",
      launch_date: "",
      position_desc: "",
    } as never).id;
    db.specParamRepo.insert({
      product_id: productId,
      param_class: "通用",
      param_name: "防护等级",
      value: "IP65",
      measured: "宣称",
      source: "规格书.docx",
      evidence_level: "B",
    } as never);
    db.boundaryRepo.insert({
      product_line_id: lineId,
      description: "不做定制机箱",
      reason: "产线限制",
      has_plan: "无",
      response: "外协",
      owner: "产品部",
      source: "边界说明.docx",
      evidence_level: "B",
    } as never);
    db.limitationRepo.insert({
      product_line_id: lineId,
      product_name: MODEL,
      description: "无 5G 模块",
      impact: "中",
      fix_status: "无计划",
      external_visible: "内部可提",
      owner: "产品部",
      source: "短板清单.docx",
      evidence_level: "B",
    } as never);

    // M1 占位行先标为已核验（7 天内不再核），本用例只看 M2/M4/M5 是否被跳过
    db.verificationRepo.upsert({
      table_code: "M1",
      row_id: productId,
      status: "未核实",
      authority: "",
      sources_json: "[]",
      key_text: "",
      note: "",
      checked_at: new Date().toISOString(),
    });

    const search = vi.fn(async () => ({ ok: true, hits: [] }));
    const fetchFn = vi.fn(async (url: string) => ({ ok: false, url, markdown: "" }));
    const report = await verifyLibrary(db, {}, { search, fetch: fetchFn });

    expect(report.checked).toBe(0);
    expect(search).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("verifyLibrary — M3 能力 / M6 报价", () => {
  it("M3 能力名分词命中 T2 → 升 A", async () => {
    const db = createDb(":memory:");
    const line = db.productLineRepo.insert({ name: "能力核验库" });
    const cap = db.capabilityRepo.insert({
      product_line_id: line.id,
      domain: "工业",
      name: "设备状态实时监测",
      description: "支持设备状态实时监测与历史曲线导出",
      maturity: "已交付",
      dependency: "",
      source_type: "AI提取",
      source: "能力清单.docx",
      source_authority: "T3",
      evidence_level: "B",
    } as never);

    const report = await verifyLibrary(
      db,
      { productLineId: line.id },
      io({ title: "设备状态实时监测 工业", body: bodyWith("设备状态实时监测", "工业") }),
    );
    expect(report.verified).toBe(1);
    expect(report.upgraded).toBe(1);
    expect(db.capabilityRepo.getById(cap.id)!.evidence_level).toBe("A");
  });

  it("M6 命中但单价矛盾 → 有冲突，保持原级", async () => {
    const db = createDb(":memory:");
    const line = db.productLineRepo.insert({ name: "报价核验库" });
    const product = db.productRepo.insert({
      product_line_id: line.id,
      model: MODEL,
      name: PRODUCT_NAME,
      status: "在售",
      launch_date: "2025-01-01",
      position_desc: "",
    } as never);
    const quote = db.quoteRepo.insert({
      product_id: product.id,
      model: MODEL,
      config: "标准配置",
      unit_price: "9800",
      price_scope: "纯设备",
      source: "报价单.xlsx",
      source_type: "AI提取",
      source_authority: "T3",
      evidence_level: "B",
    } as never);

    const report = await verifyLibrary(
      db,
      {},
      io({ body: bodyWith(MODEL, "含税单价 12800 元", "标准配置") }),
    );

    const detail = report.details.find((d) => d.table === "M6")!;
    expect(report.conflict).toBe(1);
    expect(detail.status).toBe("有冲突");
    expect(detail.note).toContain("12800");
    expect(db.quoteRepo.getById(quote.id)!.evidence_level).toBe("B");
  });

  it("M6 命中且价格一致 → 已核实", async () => {
    const db = createDb(":memory:");
    const line = db.productLineRepo.insert({ name: "报价一致库" });
    const product = db.productRepo.insert({
      product_line_id: line.id,
      model: MODEL,
      name: PRODUCT_NAME,
      status: "在售",
      launch_date: "2025-01-01",
      position_desc: "",
    } as never);
    const quote = db.quoteRepo.insert({
      product_id: product.id,
      model: MODEL,
      config: "标准配置",
      unit_price: "9800",
      price_scope: "纯设备",
      source: "报价单.xlsx",
      source_type: "AI提取",
      source_authority: "T3",
      evidence_level: "B",
    } as never);

    const report = await verifyLibrary(
      db,
      {},
      io({ body: bodyWith(MODEL, "含税单价 9800 元", "标准配置") }),
    );
    expect(report.details.find((d) => d.table === "M6")!.status).toBe("已核实");
    expect(db.quoteRepo.getById(quote.id)!.evidence_level).toBe("A");
  });
});

describe("listVerifications", () => {
  it("按状态分组统计，只读不改库", async () => {
    const { db, productId } = setup();
    await verifyLibrary(db, {}, io({}));
    const summary = listVerifications(db);

    expect(summary.total).toBe(1);
    expect(summary.by_status.已核实).toBe(1);
    expect(summary.by_status.未核实).toBe(0);
    expect(summary.by_status.有冲突).toBe(0);
    expect(summary.upgraded).toBe(1);
    expect(summary.groups.已核实[0]!.row_id).toBe(productId);
    expect(summary.groups.已核实[0]!.sources[0]!.url).toBe("https://docs.example.com/ct21b");
    // GET 口径：读两次结果一致，证据级不因读取而变
    expect(listVerifications(db).total).toBe(1);
    expect(db.productRepo.getById(productId)!.evidence_level).toBe("A");
  });
});
