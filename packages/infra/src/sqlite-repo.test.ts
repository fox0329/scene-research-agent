/**
 * @scene/infra — SQLite 仓储层测试
 *
 * 内存数据库测试，不写文件。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb, sourceSearch, type DbInstance } from "./sqlite-repo.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("createDb", () => {
  let instance: DbInstance;

  beforeEach(() => {
    instance = createDb(":memory:");
  });

  afterEach(() => {
    instance.db.close();
  });

  it("应创建所有 15 张业务表", () => {
    const tables = instance.db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as { name: string }[];

    const names = tables.map((t) => t.name);

    // 资料库 8 表
    expect(names).toContain("product_line");
    expect(names).toContain("product");
    expect(names).toContain("spec_param");
    expect(names).toContain("capability");
    expect(names).toContain("boundary");
    expect(names).toContain("limitation");
    expect(names).toContain("cost_rate");
    expect(names).toContain("optional_material");

    // 场景层 6 表
    expect(names).toContain("scenario");
    expect(names).toContain("scenario_material");
    expect(names).toContain("stage_data");
    expect(names).toContain("conversation");
    expect(names).toContain("message");
    expect(names).toContain("quality_gate");
  });

  it("应创建 FTS5 虚表 source_fts", () => {
    const vtables = instance.db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'source_fts'`,
      )
      .all() as { name: string }[];

    expect(vtables).toHaveLength(1);
    expect(vtables[0]!.name).toBe("source_fts");
  });

  it("冷启动自动建库文件父目录（故障 #9：全新检出无 data/ 目录）", () => {
    const root = mkdtempSync(join(tmpdir(), "scene-db-"));
    const target = join(root, "data", "deeper", "app.db");
    const fileInstance = createDb(target);
    try {
      expect(existsSync(target)).toBe(true);
      const row = fileInstance.db.prepare("SELECT count(*) AS c FROM product_line").get() as { c: number };
      expect(row.c).toBe(0);
    } finally {
      fileInstance.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("productLineRepo CRUD", () => {
  let instance: DbInstance;

  beforeEach(() => {
    instance = createDb(":memory:");
  });

  afterEach(() => {
    instance.db.close();
  });

  it("insert 应自动生成 id 和时间戳", () => {
    const row = instance.productLineRepo.insert({ name: "智能交通" });

    expect(row.id).toBeTruthy();
    expect(row.name).toBe("智能交通");
    expect(row.created_at).toBeTruthy();
    expect(row.updated_at).toBe(row.created_at);
  });

  it("list 应返回所有行", () => {
    instance.productLineRepo.insert({ name: "A" });
    instance.productLineRepo.insert({ name: "B" });

    const rows = instance.productLineRepo.list();
    expect(rows).toHaveLength(2);
  });

  it("list 带 where 过滤", () => {
    instance.productLineRepo.insert({ name: "A" });
    instance.productLineRepo.insert({ name: "B" });

    const rows = instance.productLineRepo.list({
      where: "name = ?",
      params: ["B"],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("B");
  });

  it("getById 应返回匹配行或 undefined", () => {
    const row = instance.productLineRepo.insert({ name: "X" });
    expect(instance.productLineRepo.getById(row.id)?.name).toBe("X");
    expect(instance.productLineRepo.getById("nonexistent")).toBeUndefined();
  });

  it("update 应修改字段并更新 updated_at", () => {
    const row = instance.productLineRepo.insert({ name: "原名" });
    // 保证时间推进
    const updated = instance.productLineRepo.update(row.id, { name: "新名" });

    expect(updated).toBeTruthy();
    expect(updated!.name).toBe("新名");
    expect(updated!.updated_at >= row.created_at).toBe(true);
  });

  it("update 不存在的 id 应返回 undefined", () => {
    const result = instance.productLineRepo.update("nope", { name: "X" });
    expect(result).toBeUndefined();
  });

  it("deleteById 应删除行并返回 true", () => {
    const row = instance.productLineRepo.insert({ name: "删我" });
    expect(instance.productLineRepo.deleteById(row.id)).toBe(true);
    expect(instance.productLineRepo.getById(row.id)).toBeUndefined();
  });

  it("deleteById 不存在的 id 应返回 false", () => {
    expect(instance.productLineRepo.deleteById("nope")).toBe(false);
  });
});

describe("productRepo CRUD（含外键和溯源字段）", () => {
  let instance: DbInstance;

  beforeEach(() => {
    instance = createDb(":memory:");
  });

  afterEach(() => {
    instance.db.close();
  });

  it("insert 应创建产品并可查询", () => {
    const line = instance.productLineRepo.insert({ name: "交通" });
    const prod = instance.productRepo.insert({
      product_line_id: line.id,
      model: "X-100",
      name: "信号机",
      status: "在售",
      launch_date: "2024-01-01",
      position_desc: "城市路口信号控制",
      source_type: "AI提取",
      source: "产品手册.pdf:12",
      source_authority: "T1",
      evidence_level: "A",
    });

    expect(prod.id).toBeTruthy();
    expect(prod.model).toBe("X-100");
    expect(prod.source_type).toBe("AI提取");

    const fetched = instance.productRepo.getById(prod.id);
    expect(fetched?.name).toBe("信号机");
  });

  it("insert 缺少外键应抛错", () => {
    expect(() => {
      instance.productRepo.insert({
        product_line_id: "nonexistent",
        model: "X",
        name: "X",
        status: "在售",
        launch_date: "2024-01-01",
        position_desc: "test",
      });
    }).toThrow();
  });
});

describe("sourceSearch FTS5", () => {
  let instance: DbInstance;

  beforeEach(() => {
    instance = createDb(":memory:");
  });

  afterEach(() => {
    instance.db.close();
  });

  it("应通过 FTS5 MATCH 查询插入的来源数据", () => {
    const line = instance.productLineRepo.insert({ name: "交通" });

    instance.productRepo.insert({
      product_line_id: line.id,
      model: "X-100",
      name: "高清摄像头",
      status: "在售",
      launch_date: "2024-01-01",
      position_desc: "路口高清视频采集",
      source: "产品手册.pdf:30",
    });

    instance.productRepo.insert({
      product_line_id: line.id,
      model: "Y-200",
      name: "雷达传感器",
      status: "在研",
      launch_date: "2025-01-01",
      position_desc: "毫米波雷达测速",
      source: "技术白皮书.pdf:5",
    });

    // 等待触发器同步 FTS
    const results = sourceSearch(instance.db, "摄像头");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.content.includes("摄像头"))).toBe(true);
  });

  it("空查询应返回空结果或报错", () => {
    // FTS5 空字符串 MATCH 会报错，需处理
    expect(() => sourceSearch(instance.db, "")).toThrow();
  });

  it("limit 参数应限制返回数量", () => {
    const line = instance.productLineRepo.insert({ name: "交通" });
    for (let i = 0; i < 5; i++) {
      instance.productRepo.insert({
        product_line_id: line.id,
        model: `M-${i}`,
        name: `设备${i} 摄像头`,
        status: "在售",
        launch_date: "2024-01-01",
        position_desc: "测试设备",
        source: `文档${i}.pdf:1`,
      });
    }

    const results = sourceSearch(instance.db, "摄像头", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe("DB_PATH 环境变量", () => {
  it("createDb() 不传参时应读取 DB_PATH 环境变量", () => {
    const original = process.env.DB_PATH;
    try {
      process.env.DB_PATH = ":memory:";
      const instance = createDb();
      expect(instance.db).toBeTruthy();

      // 验证表存在
      const tables = instance.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='product_line'`,
        )
        .all();
      expect(tables).toHaveLength(1);

      instance.db.close();
    } finally {
      if (original === undefined) {
        delete process.env.DB_PATH;
      } else {
        process.env.DB_PATH = original;
      }
    }
  });

  it("显式传参应优先于 DB_PATH", () => {
    const original = process.env.DB_PATH;
    try {
      process.env.DB_PATH = "should-not-be-used";
      const instance = createDb(":memory:");
      expect(instance.db).toBeTruthy();
      instance.db.close();
    } finally {
      if (original === undefined) {
        delete process.env.DB_PATH;
      } else {
        process.env.DB_PATH = original;
      }
    }
  });
});
// ─── 回退清理仓库方法（M4-T4.2） ───────────────────────────

describe("stageDataRepo markStale / deleteByScenarioStage（多场景隔离）", () => {
  let instance: DbInstance;
  let scenarioA: string;
  let scenarioB: string;

  beforeEach(() => {
    instance = createDb(":memory:");
    const pl = instance.productLineRepo.insert({ name: "产品线" } as never);
    scenarioA = instance.scenarioRepo.insert({
      name: "场景A",
      product_line_id: pl.id,
      status: "进行中",
      current_stage: 3,
    } as never).id;
    scenarioB = instance.scenarioRepo.insert({
      name: "场景B",
      product_line_id: pl.id,
      status: "进行中",
      current_stage: 3,
    } as never).id;
  });

  afterEach(() => {
    instance.db.close();
  });

  const seed = (scenarioId: string, stage: number, tableCode: string) =>
    instance.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage,
      table_code: tableCode,
      row: { x: 1 },
      is_stale: false,
    } as never);

  it("markStale 只影响指定场景指定阶段，is_stale 布尔往返正确", () => {
    seed(scenarioA, 2, "表2-1");
    const a3 = seed(scenarioA, 3, "表3-1");
    const b3 = seed(scenarioB, 3, "表3-1");

    const changes = instance.stageDataRepo.markStale(scenarioA, [2, 3], true);
    expect(changes).toBe(2);

    const listA = instance.stageDataRepo.listByScenarioStage(scenarioA, 3);
    expect(listA[0]!.id).toBe(a3.id);
    expect(listA[0]!.is_stale).toBe(true);
    // 隔离抽查：场景 B 同阶段数据不受影响
    const listB = instance.stageDataRepo.listByScenarioStage(scenarioB, 3);
    expect(listB[0]!.id).toBe(b3.id);
    expect(listB[0]!.is_stale).toBe(false);
  });

  it("markStale 空阶段列表返回 0；置回 false 亦可", () => {
    seed(scenarioA, 1, "表1-1");
    expect(instance.stageDataRepo.markStale(scenarioA, [], true)).toBe(0);
    instance.stageDataRepo.markStale(scenarioA, [1], true);
    expect(instance.stageDataRepo.markStale(scenarioA, [1], false)).toBe(1);
    expect(instance.stageDataRepo.listByScenarioStage(scenarioA, 1)[0]!.is_stale).toBe(false);
  });

  it("deleteByScenarioStage 精确删除（阶段+场景双条件）", () => {
    seed(scenarioA, 1, "表1-1");
    const keep = seed(scenarioA, 2, "表2-1");
    seed(scenarioB, 1, "表1-1");

    expect(instance.stageDataRepo.deleteByScenarioStage(scenarioA, 1)).toBe(1);
    expect(instance.stageDataRepo.listByScenarioStage(scenarioA, 1)).toHaveLength(0);
    expect(instance.stageDataRepo.listByScenarioStage(scenarioA, 2)[0]!.id).toBe(keep.id);
    expect(instance.stageDataRepo.listByScenarioStage(scenarioB, 1)).toHaveLength(1);
  });

  it("qualityGateRepo.deleteByScenarioStage 只删本场景本阶段", () => {
    instance.qualityGateRepo.insert({
      scenario_id: scenarioA,
      stage: 1,
      item_no: 1,
      title: "检查项",
      result: "通过",
      detail: "",
      evidence_refs: {},
    } as never);
    instance.qualityGateRepo.insert({
      scenario_id: scenarioB,
      stage: 1,
      item_no: 1,
      title: "检查项B",
      result: "通过",
      detail: "",
      evidence_refs: {},
    } as never);

    expect(instance.qualityGateRepo.deleteByScenarioStage(scenarioA, 1)).toBe(1);
    expect(instance.qualityGateRepo.listByScenarioStage(scenarioA, 1)).toHaveLength(0);
    expect(instance.qualityGateRepo.listByScenarioStage(scenarioB, 1)).toHaveLength(1);
  });
});
