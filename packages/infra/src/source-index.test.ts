import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createSourceLookup, deleteSourceIndex, ftsPhrase } from "./source-index.js";

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
