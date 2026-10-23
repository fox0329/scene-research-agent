/**
 * @scene/infra — SQLite 仓储层测试
 *
 * 内存数据库测试，不写文件。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createDb, mapO3PricePayload, sourceSearch, type DbInstance } from "./sqlite-repo.js";
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

  it("存量库补 conversation.kind，并把历史「阶段 N · 分析」标成阶段分析（变更表 #174）", () => {
    const root = mkdtempSync(join(tmpdir(), "scene-conv-kind-"));
    const target = join(root, "scene.db");
    try {
      // 造一份"旧库"：没有 kind 列 + 两条历史阶段会话
      const old = new Database(target);
      old.exec("CREATE TABLE conversation (id TEXT PRIMARY KEY, scenario_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, dsh_session_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      old.exec("INSERT INTO conversation VALUES ('c1','s1','阶段 1 · 分析','活跃','x','2026-01-01','2026-01-01'), ('c2','s1','场景定义','活跃','y','2026-01-01','2026-01-01')");
      old.close();

      // 再启动一次 = 走增量升级
      const up = createDb(target);
      try {
        const rows = up.db
          .prepare("SELECT title, kind FROM conversation ORDER BY id")
          .all() as { title: string; kind: string }[];
        expect(rows[0]).toEqual({ title: "阶段 1 · 分析", kind: "阶段分析" });
        expect(rows[1]).toEqual({ title: "场景定义", kind: "用户" });

        // v2 产物会话：旧库缺列时逐列补齐，唯一索引只能在补列之后建（变更表 #295）
        const cols = (up.db.pragma("table_info(conversation)") as { name: string }[]).map(
          (c) => c.name,
        );
        expect(cols).toEqual(
          expect.arrayContaining([
            "kind",
            "scope_type",
            "scope_id",
            "step",
            "block",
            "purpose",
            "summary",
            "context_hash",
            "last_activity_at",
          ]),
        );
        const indexes = up.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'conversation'")
          .all() as { name: string }[];
        expect(indexes.map((i) => i.name)).toContain("ux_conversation_artifact_active");
      } finally {
        up.db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe("历史模型知识来源回填（#260）", () => {
  it("打开老库时把「行业通例/模型知识」来源改成「未知（未检索到公开来源）」，且幂等", () => {
    const dir = mkdtempSync(join(tmpdir(), "scene-mig-"));
    const file = join(dir, "scene.db");
    try {
      const first = createDb(file);
      const scenario = first.scenarioRepo.insert({ name: "回填测试", status: "进行中", current_stage: 1 });
      first.db
        .prepare(
          "INSERT INTO stage_data (id, scenario_id, stage, table_code, row, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          "sd_mig_1",
          scenario.id,
          1,
          "表1-2",
          JSON.stringify({ name: "旧行", source: "行业通例（模型知识）" }),
          new Date().toISOString(),
          new Date().toISOString(),
        );
      first.db.close();

      const second = createDb(file);
      const raw = second.db.prepare("SELECT row FROM stage_data WHERE id = ?").get("sd_mig_1") as { row: string };
      expect(JSON.parse(raw.row).source).toBe("未知（未检索到公开来源）");
      second.db.close();

      const third = createDb(file);
      const again = third.db.prepare("SELECT row FROM stage_data WHERE id = ?").get("sd_mig_1") as { row: string };
      expect(JSON.parse(again.row).source).toBe("未知（未检索到公开来源）");
      third.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
    instance.productLineRepo.insert({ name: "产品线" } as never);
    scenarioA = instance.scenarioRepo.insert({
      name: "场景A",
      status: "进行中",
      current_stage: 3,
    } as never).id;
    scenarioB = instance.scenarioRepo.insert({
      name: "场景B",
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

describe("存量库升级：scenario 去掉 product_line_id（v3.0，变更表 #160）", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scene-mig-"));
    dbPath = join(dir, "old.db");
    /* 造一个"老库"：带 product_line_id 非空外键的 scenario（就是升级前的真实结构），
       外加一张指向它的子表，用来证明重建后子表的外键仍然指着 scenario。 */
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE product_line (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, scenario_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE scenario (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        product_line_id TEXT NOT NULL REFERENCES product_line(id),
        status TEXT NOT NULL CHECK (status IN ('进行中','已完成','已归档')),
        current_stage INTEGER NOT NULL CHECK (current_stage BETWEEN 0 AND 8),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE scenario_step (
        scenario_id TEXT NOT NULL REFERENCES scenario(id), step INTEGER NOT NULL,
        completed_at TEXT NOT NULL, PRIMARY KEY (scenario_id, step)
      );
      INSERT INTO product_line VALUES ('pl-private','老场景·专属资料','sc-1','2026-01-01','2026-01-01');
      INSERT INTO product_line VALUES ('pl-common','拓维产品',NULL,'2026-01-01','2026-01-01');
      INSERT INTO scenario VALUES ('sc-1','老场景',NULL,'pl-private','进行中',1,'2026-01-01','2026-01-01');
      INSERT INTO scenario_step VALUES ('sc-1',1,'2026-01-01');
    `);
    old.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("迁移后：列没了、数据在、子表外键还指着 scenario、库归属关系不丢", () => {
    const instance = createDb(dbPath);
    const cols = (instance.db.pragma("table_info(scenario)") as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("product_line_id");
    expect(cols).toContain("description");
    expect(cols).toContain("current_stage");

    // 场景数据一字未丢
    const sc = instance.scenarioRepo.getById("sc-1");
    expect(sc).toBeDefined();
    expect(sc!.name).toBe("老场景");
    expect((sc as unknown as Record<string, unknown>)["description"]).toBeNull();

    // 子表照样能读写、外键仍然指向 scenario（没被 RENAME 带歪）
    expect(instance.scenarioStepRepo.completedSteps("sc-1")).toEqual([1]);
    instance.scenarioStepRepo.complete("sc-1", 2);
    expect(instance.scenarioStepRepo.completedSteps("sc-1")).toEqual([1, 2]);

    // 私有库关系存在 product_line.scenario_id 上，重建 scenario 不影响它
    expect(
      instance.productLineRepo.list({ where: "scenario_id = ?", params: ["sc-1"] }).map((l) => l.id),
    ).toEqual(["pl-private"]);

    // 全库外键干净
    expect(instance.db.pragma("foreign_key_check")).toHaveLength(0);
    instance.db.close();
  });

  it("已经是新结构的库再跑一次迁移：幂等，不重建也不报错", () => {
    const first = createDb(dbPath);
    first.db.close();
    const again = createDb(dbPath);
    expect(again.scenarioRepo.getById("sc-1")!.name).toBe("老场景");
    expect(again.db.pragma("foreign_key_check")).toHaveLength(0);
    again.db.close();
  });
});

// ─── O3 价格 → M6 报价（一次性迁移，用户定调 2026-10-21） ───
//
// 一个价格事实只能有一个家：存量 O3 价格明细迁进 price_quote 后删掉 O3 行；
// 型号在 M1 里找不到就不迁（不编产品），O3 行保留等用户补 M1。

describe("O3 价格 → M6 报价迁移", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scene-o3-migrate-"));
    dbPath = join(dir, "scene.db");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("迁成功：映射字段、删 O3 行、第二次打开不重复", () => {
    const first = createDb(dbPath);
    const line = first.productLineRepo.insert({ name: "产品线" });
    const product = first.productRepo.insert({
      product_line_id: line.id,
      model: "YS-EC3200",
      name: "边缘控制器",
      status: "在售",
      launch_date: "",
      position_desc: "",
    });
    first.optionalMaterialRepo.insert({
      product_line_id: line.id,
      // 历史库里的 O3 行（类别已下线）：仅用于验证一次性迁移，不再从类型层暴露
      category: "O3价格" as never,
      payload: {
        model: "YS-EC3200",
        price: "约 3800 元/台",
        currency: "CNY",
        channel: "含税参考价",
        date: "2025-11",
      },
      source: "云枢智控-产品与能力白皮书.docx:A.3",
      source_type: "AI提取",
    });
    // 非 O3 的可选材料不参与迁移，必须原样留下
    first.optionalMaterialRepo.insert({
      product_line_id: line.id,
      category: "O1认证",
      payload: { model: "YS-EC3200", cert_no: "C-1" },
      source: "认证证书.pdf:1",
    });
    first.db.close();

    const second = createDb(dbPath);
    expect(second.o3PriceMigration).toEqual({ migrated: 1, skipped: 0 });
    const quotes = second.quoteRepo.list();
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({
      product_id: product.id,
      model: "YS-EC3200",
      // 渠道「含税参考价」映射不到四个口径 → 按纯设备，原文留在 config
      config: "未注明；渠道原文：含税参考价",
      unit_price: "约 3800 元/台",
      price_scope: "纯设备",
      valid_until: "2025-11",
      source: "云枢智控-产品与能力白皮书.docx:A.3",
    });
    expect(
      second.optionalMaterialRepo.list({ where: "category = ?", params: ["O3价格"] }),
    ).toHaveLength(0);
    expect(
      second.optionalMaterialRepo.list({ where: "category = ?", params: ["O1认证"] }),
    ).toHaveLength(1);
    second.db.close();

    // 再打开：没有 O3 行可迁，不重复插报价
    const third = createDb(dbPath);
    expect(third.quoteRepo.list()).toHaveLength(1);
    expect(third.o3PriceMigration).toBeUndefined();
    third.db.close();
  });

  it("型号不在 M1：跳过不迁，O3 行保留", () => {
    const first = createDb(dbPath);
    const line = first.productLineRepo.insert({ name: "产品线" });
    first.productRepo.insert({
      product_line_id: line.id,
      model: "YS-EC3200",
      name: "边缘控制器",
      status: "在售",
      launch_date: "",
      position_desc: "",
    });
    first.optionalMaterialRepo.insert({
      product_line_id: line.id,
      category: "O3价格" as never,
      payload: { model: "NOT-IN-M1", price: "100", date: "2025-11" },
      source: "报价单.pdf:1",
    });
    first.db.close();

    const second = createDb(dbPath);
    expect(second.o3PriceMigration).toEqual({ migrated: 0, skipped: 1 });
    expect(second.quoteRepo.list()).toHaveLength(0);
    expect(
      second.optionalMaterialRepo.list({ where: "category = ?", params: ["O3价格"] }),
    ).toHaveLength(1);
    second.db.close();
  });

  it("渠道关键词映射口径；映射不上按纯设备并保留原文", () => {
    expect(mapO3PricePayload({ model: "A", price: "1", channel: "含三年维保" }, "s.pdf:1")!.price_scope).toBe("含三年维保");
    expect(mapO3PricePayload({ model: "A", price: "1", channel: "含安装调试" }, "s.pdf:1")!.price_scope).toBe("含安装");
    expect(mapO3PricePayload({ model: "A", price: "1", channel: "年费" }, "s.pdf:1")!.price_scope).toBe("年费");
    expect(mapO3PricePayload({ model: "A", price: "1", channel: "纯设备" }, "s.pdf:1")!.price_scope).toBe("纯设备");
    const fallback = mapO3PricePayload({ model: "A", price: "1", channel: "含税参考价" }, "s.pdf:1")!;
    expect(fallback.price_scope).toBe("纯设备");
    expect(fallback.config).toContain("含税参考价");
    // 缺型号/单价：不是可迁移的价格事实
    expect(mapO3PricePayload({ model: "", price: "1" }, "s.pdf:1")).toBeNull();
    expect(mapO3PricePayload({ model: "A", price: "" }, "s.pdf:1")).toBeNull();
  });
});
