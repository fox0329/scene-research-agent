import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  createSourceLookup,
  deleteSourceIndex,
  ftsPhrase,
  splitPageRef,
  splitFileRef,
  upsertSourcePages,
} from "./source-index.js";
import { sourcePassages } from "./sqlite-repo.js";

/** 建一张和线上同构的 trigram FTS 表（schema 见 packages/infra/src/sql/001_init.sql） */
function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE VIRTUAL TABLE source_fts USING fts5(
      ref_id, source, content, table_code, tokenize='trigram'
    );
  `);
  const ins = db.prepare("INSERT INTO source_fts (ref_id, source, content, table_code) VALUES (?,?,?,?)");
  ins.run("m1", "ingest-1790179276611-30.pdf:10", "AI 算力 内置 NPU，算力 6 TOPS", "M2");
  ins.run("m2", "ingest-1790179850820-50.pptx:14", "CT15 支持 8 TOPS INT8 算力", "M1");
  ins.run("m3", "ingest-1790179276611-30.pdf:11", "存储 128GB，支持 MicroSD 扩展", "M2");
  return db;
}

describe("source-index — FTS 短语转义", () => {
  it("包成短语并对内部引号翻倍转义", () => {
    expect(ftsPhrase("6 TOPS")).toBe('"6 TOPS"');
    expect(ftsPhrase('带"引号"的片段')).toBe('"带""引号""的片段"');
  });

  it("少于 3 字符无法用 trigram 检索 → 返回 null（不据此指控）", () => {
    expect(ftsPhrase("ab")).toBeNull();
    expect(ftsPhrase("  ")).toBeNull();
  });
});

describe("source-index — 来源真实性反查", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("出处存在性：存在 true、不存在 false", () => {
    const l = createSourceLookup(db);
    expect(l.hasSource("ingest-1790179276611-30.pdf:10")).toBe(true);
    expect(l.hasSource("ingest-1790179276611-30.pdf:99")).toBe(false);
    expect(l.hasSource("幽灵材料.pdf:1")).toBe(false);
    expect(l.hasSource("")).toBe(false);
  });

  it("该页确实有这句话 → true", () => {
    const l = createSourceLookup(db);
    expect(l.hasContent("ingest-1790179276611-30.pdf:10", "6 TOPS")).toBe(true);
    expect(l.hasContent("ingest-1790179276611-30.pdf:10", "内置 NPU")).toBe(true);
  });

  it("这句话在别的页/别的材料里 → 仍判 false（不许张冠李戴）", () => {
    const l = createSourceLookup(db);
    // 8 TOPS 在 pptx:14，不在 pdf:10
    expect(l.hasContent("ingest-1790179276611-30.pdf:10", "8 TOPS")).toBe(false);
    expect(l.hasContent("ingest-1790179850820-50.pptx:14", "8 TOPS")).toBe(true);
  });

  it("片段过短或极端字符 → 保守返回 true，不让自检误伤", () => {
    const l = createSourceLookup(db);
    expect(l.hasContent("ingest-1790179276611-30.pdf:10", "6T")).toBe(true);
    expect(l.hasContent("ingest-1790179276611-30.pdf:10", '"""')).toBe(true);
  });
});

describe("source-index — 删行时清索引（变更表 #156）", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("删掉某行的索引后，它的来源不再被判「存在」（触发器只管插入/更新，没有 DELETE 触发器）", () => {
    const l = createSourceLookup(db);
    expect(l.hasSource("ingest-1790179276611-30.pdf:10")).toBe(true);
    deleteSourceIndex(db, "m1");
    expect(l.hasSource("ingest-1790179276611-30.pdf:10")).toBe(false);
    expect(l.hasContent("ingest-1790179276611-30.pdf:10", "6 TOPS")).toBe(false);
  });

  it("只删目标行：同文件别的行、别的材料都不受影响", () => {
    const l = createSourceLookup(db);
    deleteSourceIndex(db, "m1");
    expect(l.hasSource("ingest-1790179276611-30.pdf:11")).toBe(true);
    expect(l.hasSource("ingest-1790179850820-50.pptx:14")).toBe(true);
  });

  it("空 id 是空操作（不误删整表）", () => {
    const l = createSourceLookup(db);
    deleteSourceIndex(db, "");
    deleteSourceIndex(db, "   ");
    expect(l.hasSource("ingest-1790179276611-30.pdf:10")).toBe(true);
    expect(l.hasSource("ingest-1790179276611-30.pdf:11")).toBe(true);
  });
});

describe("source-index — 右栏「看原文」按来源取段落（变更表 #179）", () => {
  it("等值取用：只回这一条来源的原文，按内容去重", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE VIRTUAL TABLE source_fts USING fts5(
      ref_id, source, content, table_code, tokenize='trigram'
    );`);
    const ins = db.prepare(
      "INSERT INTO source_fts (ref_id, source, content, table_code) VALUES (?,?,?,?)",
    );
    ins.run("a", "在鸿工控机CT21B规格参数.docx:1", "支持宽温 -40~70℃ 工作", "M1");
    ins.run("b", "在鸿工控机CT21B规格参数.docx:1", "支持宽温 -40~70℃ 工作", "M2"); // 同一句被两张表引用
    ins.run("c", "在鸿工控机CT21B规格参数.docx:1", "八核处理器 RK3588J", "M1");
    ins.run("d", "别的材料.pdf:9", "这条不该被捞进来", "M1"); // 来源不同

    const got = sourcePassages(db, "在鸿工控机CT21B规格参数.docx:1");
    expect(got.map((p) => p.content)).toEqual(["支持宽温 -40~70℃ 工作", "八核处理器 RK3588J"]);
    expect(got.every((p) => p.source === "在鸿工控机CT21B规格参数.docx:1")).toBe(true);

    // 没有原文的出处（「用户输入」「模型知识」）返回空数组，不是报错
    expect(sourcePassages(db, "用户输入")).toEqual([]);
  });
});

// ─── 页级原文核对（变更表 #212：修掉「自证」） ────────────────

describe("splitPageRef", () => {
  it("拆出文件名与页码", () => {
    expect(splitPageRef("规格书.pdf:12")).toEqual({ fileName: "规格书.pdf", page: 12 });
    expect(splitPageRef("白皮书.docx：3")).toEqual({ fileName: "白皮书.docx", page: 3 });
  });

  it("拆不出来的（URL / 无页码 / 非法页号）返回 null", () => {
    expect(splitPageRef("https://example.com/a")).toBeNull();
    expect(splitPageRef("白皮书#3")).toBeNull();
    expect(splitPageRef("文件.pdf:0")).toBeNull();
    expect(splitPageRef("")).toBeNull();
  });
});

describe("upsertSourcePages", () => {
  it("按页写入原文，重复写覆盖而不累积", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE source_page (
      id TEXT PRIMARY KEY, file_name TEXT NOT NULL, page INTEGER NOT NULL,
      content TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE(file_name, page)
    );`);
    expect(upsertSourcePages(db, "a.pdf", [
      { page: 1, text: "第一页原文" },
      { page: 2, text: "第二页原文" },
    ])).toBe(2);
    // 再写一次同页：覆盖
    upsertSourcePages(db, "a.pdf", [{ page: 1, text: "第一页改过" }]);
    const rows = db.prepare("SELECT page, content FROM source_page ORDER BY page").all();
    expect(rows).toEqual([
      { page: 1, content: "第一页改过" },
      { page: 2, content: "第二页原文" },
    ]);
    db.close();
  });

  it("空白页不占位（避免有页无内容的假象）", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE source_page (
      id TEXT PRIMARY KEY, file_name TEXT NOT NULL, page INTEGER NOT NULL,
      content TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE(file_name, page)
    );`);
    expect(upsertSourcePages(db, "a.pdf", [{ page: 1, text: "   " }])).toBe(0);
    db.close();
  });
});

describe("hasContent 查的是原文，不是业务行自己（#212 核心修复）", () => {
  function makeDbWithPages(): Database.Database {
    const db = new Database(":memory:");
    db.exec(`
      CREATE VIRTUAL TABLE source_fts USING fts5(
        ref_id, source, content, table_code, tokenize='trigram'
      );
      CREATE TABLE source_page (
        id TEXT PRIMARY KEY, file_name TEXT NOT NULL, page INTEGER NOT NULL,
        content TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE(file_name, page)
      );
    `);
    // 业务行自己（触发器写进 FTS 的那种拼接内容）
    db.prepare("INSERT INTO source_fts (ref_id, source, content, table_code) VALUES (?,?,?,?)")
      .run("m1", "白皮书.pdf:1", "智能摄像头 高端定位", "M1");
    // 真实原文：第 1 页只有别的内容
    db.prepare("INSERT INTO source_page (id, file_name, page, content, created_at) VALUES (?,?,?,?,?)")
      .run("p1", "白皮书.pdf", 1, "本章介绍公司概况与组织架构", new Date().toISOString());
    return db;
  }

  it("原文里没有这句话 → false（旧实现因为查业务行自己，永远 true）", () => {
    const db = makeDbWithPages();
    const lookup = createSourceLookup(db);
    // 这句只存在于业务行拼接里，原文里没有
    expect(lookup.hasContent("白皮书.pdf:1", "智能摄像头 高端定位")).toBe(false);
    db.close();
  });

  it("原文里确有这句话 → true", () => {
    const db = makeDbWithPages();
    const lookup = createSourceLookup(db);
    expect(lookup.hasContent("白皮书.pdf:1", "公司概况与组织架构")).toBe(true);
    db.close();
  });

  it("老数据没有页级原文 → 退回 FTS（兼容，不误判为失败）", () => {
    const db = makeDbWithPages();
    const lookup = createSourceLookup(db);
    // 第 2 页没有原文记录，退回 FTS 等值检索
    expect(lookup.hasContent("白皮书.pdf:1", "不存在的句子")).toBe(false);
    db.close();
  });

  it("hasSource 认得页级原文（新入库材料）", () => {
    const db = makeDbWithPages();
    const lookup = createSourceLookup(db);
    expect(lookup.hasSource("白皮书.pdf:1")).toBe(true);
    expect(lookup.hasSource("白皮书.pdf:99")).toBe(false);
    db.close();
  });
});

// ─── 真实出处形态：锚点不是页码（变更表 #212 补强） ─────────

describe("splitFileRef", () => {
  it("认得出真实库里那些非页码锚点", () => {
    expect(splitFileRef("白皮书.docx:表格2")).toEqual({ fileName: "白皮书.docx", anchor: "表格2" });
    expect(splitFileRef("白皮书.docx:8.1")).toEqual({ fileName: "白皮书.docx", anchor: "8.1" });
    expect(splitFileRef("客户资料.docx:三、车间设备与自动化现状")).toEqual({
      fileName: "客户资料.docx",
      anchor: "三、车间设备与自动化现状",
    });
  });

  it("从最后一个冒号切（文件名可能含冒号）", () => {
    expect(splitFileRef("C:\\资料\\白皮书.pdf:12")).toEqual({
      fileName: "C:\\资料\\白皮书.pdf",
      anchor: "12",
    });
  });
});

describe("非页码锚点退到整份材料核对", () => {
  function makeDb(): Database.Database {
    const db = new Database(":memory:");
    db.exec(`
      CREATE VIRTUAL TABLE source_fts USING fts5(
        ref_id, source, content, table_code, tokenize='trigram'
      );
      CREATE TABLE source_page (
        id TEXT PRIMARY KEY, file_name TEXT NOT NULL, page INTEGER NOT NULL,
        content TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE(file_name, page)
      );
    `);
    const ins = db.prepare(
      "INSERT INTO source_page (id, file_name, page, content, created_at) VALUES (?,?,?,?,?)",
    );
    ins.run("a", "白皮书.docx", 1, "第八章 产品能力\n智能摄像头支持边缘推理", new Date().toISOString());
    ins.run("b", "白皮书.docx", 2, "附录A 参数表\n功耗 12W", new Date().toISOString());
    return db;
  }

  it("`:表格2` 这类锚点在整份材料里找 → 找到为真", () => {
    const db = makeDb();
    const lookup = createSourceLookup(db);
    expect(lookup.hasContent("白皮书.docx:表格2", "边缘推理")).toBe(true);
    db.close();
  });

  it("`:8.1` 这类章节号锚点也核得到", () => {
    const db = makeDb();
    const lookup = createSourceLookup(db);
    expect(lookup.hasContent("白皮书.docx:8.1", "功耗 12W")).toBe(true);
    db.close();
  });

  it("材料里没有这句话 → false（不再自证）", () => {
    const db = makeDb();
    const lookup = createSourceLookup(db);
    expect(lookup.hasContent("白皮书.docx:表格2", "支持 5G 双上行")).toBe(false);
    db.close();
  });

  it("非页码锚点只要材料有原文，出处就算成立", () => {
    const db = makeDb();
    const lookup = createSourceLookup(db);
    expect(lookup.hasSource("白皮书.docx:表格99")).toBe(true);
    db.close();
  });
});

// ─── 分页语义按格式区分（变更表 #212 补强） ──────────────────

describe("docx 的数字锚点是打印页码，不能当页码越界判错引", () => {
  function makeDb(): Database.Database {
    const db = new Database(":memory:");
    db.exec(`
      CREATE VIRTUAL TABLE source_fts USING fts5(
        ref_id, source, content, table_code, tokenize='trigram'
      );
      CREATE TABLE source_page (
        id TEXT PRIMARY KEY, file_name TEXT NOT NULL, page INTEGER NOT NULL,
        content TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE(file_name, page)
      );
    `);
    // docx 整篇作第 1 页
    db.prepare("INSERT INTO source_page (id, file_name, page, content, created_at) VALUES (?,?,?,?,?)")
      .run("a", "白皮书.docx", 1, "第八章 产品能力\n边缘推理 6 TOPS", new Date().toISOString());
    // pdf 真有 3 页
    for (const p of [1, 2, 3]) {
      db.prepare("INSERT INTO source_page (id, file_name, page, content, created_at) VALUES (?,?,?,?,?)")
        .run(`x${p}`, "规格书.pdf", p, `第${p}页内容`, new Date().toISOString());
    }
    return db;
  }

  it("docx:9 退回整份材料核对 → 出处成立（实测遇到的真情况）", () => {
    const db = makeDb();
    const lookup = createSourceLookup(db);
    expect(lookup.hasSource("白皮书.docx:9")).toBe(true);
    expect(lookup.hasContent("白皮书.docx:9", "边缘推理 6 TOPS")).toBe(true);
    db.close();
  });

  it("pdf:99 页码越界 → 出处不成立（有稳定分页就必须真有那页）", () => {
    const db = makeDb();
    const lookup = createSourceLookup(db);
    expect(lookup.hasSource("规格书.pdf:2")).toBe(true);
    expect(lookup.hasSource("规格书.pdf:99")).toBe(false);
    db.close();
  });

  it("pdf 页码锚点只核那一页，不核别的页", () => {
    const db = makeDb();
    const lookup = createSourceLookup(db);
    expect(lookup.hasContent("规格书.pdf:1", "第1页内容")).toBe(true);
    expect(lookup.hasContent("规格书.pdf:1", "第2页内容")).toBe(false);
    db.close();
  });
});

// ─── 严格模式：不许拿业务表派生的 FTS 自证（故障清单 #83） ────

describe("严格模式", () => {
  function makeDb(withPages: boolean): Database.Database {
    const db = new Database(":memory:");
    db.exec(`
      CREATE VIRTUAL TABLE source_fts USING fts5(
        ref_id, source, content, table_code, tokenize='trigram'
      );
      CREATE TABLE source_page (
        id TEXT PRIMARY KEY, file_name TEXT NOT NULL, page INTEGER NOT NULL,
        content TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE(file_name, page)
      );
    `);
    // 触发器会把业务行的 source 写进 FTS——这正是自证的来源
    db.prepare("INSERT INTO source_fts (ref_id, source, content, table_code) VALUES (?,?,?,?)")
      .run("m1", "根本不存在的材料.docx:5", "编造的记录 量子加密", "M1");
    if (withPages) {
      db.prepare("INSERT INTO source_page (id, file_name, page, content, created_at) VALUES (?,?,?,?,?)")
        .run("p1", "真材料.docx", 1, "真实原文内容", new Date().toISOString());
    }
    return db;
  }

  it("库里有原文时：出处只在业务行里出现过，不算存在", () => {
    const db = makeDb(true);
    const lookup = createSourceLookup(db);
    // FTS 里有这条，但 source_page 里没有这个文件 → 严格模式判不存在
    expect(lookup.hasSource("根本不存在的材料.docx:5")).toBe(false);
    db.close();
  });

  it("库里有原文时：编造内容不能靠 FTS 自证", () => {
    const db = makeDb(true);
    const lookup = createSourceLookup(db);
    expect(lookup.hasContent("根本不存在的材料.docx:5", "编造的记录 量子加密")).toBe(false);
    db.close();
  });

  it("库里有原文时：真材料照常通过", () => {
    const db = makeDb(true);
    const lookup = createSourceLookup(db);
    expect(lookup.hasSource("真材料.docx:1")).toBe(true);
    expect(lookup.hasContent("真材料.docx:1", "真实原文内容")).toBe(true);
    db.close();
  });

  it("老库还没回填（source_page 空）→ 兼容模式，退回 FTS 不误杀", () => {
    const db = makeDb(false);
    const lookup = createSourceLookup(db);
    expect(lookup.hasSource("根本不存在的材料.docx:5")).toBe(true);
    db.close();
  });
});
