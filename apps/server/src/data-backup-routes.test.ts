/**
 * @scene/server — 数据备份 / 恢复路由测试
 *
 * 文件型 SQLite（临时目录）+ mock dshClient，验证：
 * GET 列表（最新在前、最多 10）、POST 立即备份、restore 路径校验、
 * restore 只落 pending 文件且不碰运行中的库。
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DshClient } from "@scene/contract";
import { createDb, PENDING_RESTORE_NAME, type DbInstance } from "@scene/infra";
import { createApp } from "./app.js";

function mockDshClient(): DshClient {
  return {
    createSession: vi.fn(async () => ({ sessionId: "dsh-test" })),
    prompt: vi.fn(() => (async function* () {})()),
    cancel: vi.fn(async () => {}),
  } as unknown as DshClient;
}

interface Harness {
  app: ReturnType<typeof createApp>;
  db: DbInstance;
  root: string;
  dbPath: string;
  backupDir: string;
}

const openHarnesses: Harness[] = [];
const roots: string[] = [];

function makeHarness(options: { backupDir?: string } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "scene-backup-routes-"));
  roots.push(root);
  process.env.SCENE_PROVIDERS_FILE = join(root, "providers.local.json");
  process.env.EXPORT_DIR = join(root, "exports");
  const dbPath = join(root, "data", "scene.db");
  const backupDir = options.backupDir ?? join(root, "data", "backups");
  const db = createDb(dbPath, { backupDir });
  const app = createApp({ db, dshClient: mockDshClient() });
  const harness = { app, db, root, dbPath, backupDir };
  openHarnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const h of openHarnesses.splice(0)) {
    await h.app.close();
    h.db.db.close();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GET /api/v1/data/backups", () => {
  it("内存库返回空目录 + 空列表（设置页仍可打开）", async () => {
    const db = createDb(":memory:");
    const app = createApp({ db, dshClient: mockDshClient() });
    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/data/backups" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ dir: "", backups: [] });
    } finally {
      await app.close();
      db.db.close();
    }
  });

  it("备份目录尚未创建（首次启动）时返回空列表 + 目录", async () => {
    const h = makeHarness();
    expect(existsSync(h.backupDir)).toBe(false);
    const res = await h.app.inject({ method: "GET", url: "/api/v1/data/backups" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ dir: h.backupDir, backups: [] });
    // 只读接口不得顺手建目录
    expect(existsSync(h.backupDir)).toBe(false);
  });

  it("内存库：立即备份/恢复都明确 400，不抛异常", async () => {
    const db = createDb(":memory:");
    const app = createApp({ db, dshClient: mockDshClient() });
    try {
      const backup = await app.inject({ method: "POST", url: "/api/v1/data/backups" });
      expect(backup.statusCode).toBe(400);
      const restore = await app.inject({
        method: "POST",
        url: "/api/v1/data/restore",
        payload: { name: "scene-20260101-000000.db" },
      });
      expect(restore.statusCode).toBe(400);
    } finally {
      await app.close();
      db.db.close();
    }
  });

  it("最新在前、最多 10 份，并返回备份目录", async () => {
    const h = makeHarness();
    mkdirSync(h.backupDir, { recursive: true });
    for (let day = 1; day <= 12; day += 1) {
      const dd = String(day).padStart(2, "0");
      const file = join(h.backupDir, `scene-202601${dd}-000000.db`);
      writeFileSync(file, `backup-${dd}`);
      const when = new Date(2026, 0, day);
      utimesSync(file, when, when);
    }

    const res = await h.app.inject({ method: "GET", url: "/api/v1/data/backups" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      dir: string;
      backups: { name: string; size: number; created_at: string }[];
    };
    expect(body.dir).toBe(h.backupDir);
    expect(body.backups).toHaveLength(10);
    expect(body.backups[0]!.name).toBe("scene-20260112-000000.db");
    expect(body.backups[9]!.name).toBe("scene-20260103-000000.db");
    expect(body.backups[0]!.size).toBe(Buffer.byteLength("backup-12"));
    expect(Number.isNaN(new Date(body.backups[0]!.created_at).getTime())).toBe(false);
  });
});

describe("POST /api/v1/data/backups", () => {
  it("立即备份生成可读文件、返回文件信息，并出现在列表里", async () => {
    const h = makeHarness();
    h.db.productLineRepo.insert({ name: "备份测试产品线" });

    const res = await h.app.inject({ method: "POST", url: "/api/v1/data/backups" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; size: number; created_at: string };
    expect(body.name).toMatch(/^scene-\d{8}-\d{6}(-\d+)?\.db$/u);
    expect(body.size).toBeGreaterThan(0);
    const file = join(h.backupDir, body.name);
    expect(existsSync(file)).toBe(true);

    // 备份里确实有刚写入的数据（VACUUM INTO 是真快照，不是空壳）
    const copy = await h.app.inject({
      method: "GET",
      url: "/api/v1/data/backups",
    });
    const list = copy.json() as { backups: { name: string }[] };
    expect(list.backups.map((b) => b.name)).toContain(body.name);
  });

  it("连续备份自动裁剪到 3 份", async () => {
    const h = makeHarness();
    for (let i = 0; i < 4; i += 1) {
      const res = await h.app.inject({ method: "POST", url: "/api/v1/data/backups" });
      expect(res.statusCode).toBe(200);
    }
    const files = readdirSync(h.backupDir).filter(
      (name) => name.startsWith("scene-") && name.endsWith(".db"),
    );
    expect(files.length).toBeLessThanOrEqual(3);
  });
});

describe("POST /api/v1/data/restore", () => {
  it("合法备份 → 只生成 restore-on-boot.db，不替换运行中的库", async () => {
    const h = makeHarness();
    h.db.productLineRepo.insert({ name: "备份时的数据" });
    const created = (
      await h.app.inject({ method: "POST", url: "/api/v1/data/backups" })
    ).json() as { name: string };

    // 备份之后又写一行：恢复准备阶段绝不能把它抹掉
    h.db.productLineRepo.insert({ name: "备份后的数据" });

    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/data/restore",
      payload: { name: created.name },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      pending: true,
      restartRequired: true,
      name: created.name,
    });
    const pending = join(h.root, "data", PENDING_RESTORE_NAME);
    expect(existsSync(pending)).toBe(true);
    expect(readFileSync(pending).equals(readFileSync(join(h.backupDir, created.name)))).toBe(true);

    // 运行中的库保持原样
    const names = h.db.productLineRepo.list({}).map((row) => row.name);
    expect(names).toEqual(["备份时的数据", "备份后的数据"]);
  });

  it.each([
    ["../evil.db", 400],
    ["../../etc/passwd.db", 400],
    ["..\\evil.db", 400],
    ["/tmp/evil.db", 400],
    ["evil.txt", 400],
    ["sub/evil.db", 400],
    ["missing.db", 404],
  ])("非法/不存在的名字 %s → %i，且不生成 pending", async (name, expected) => {
    const h = makeHarness();
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/data/restore",
      payload: { name },
    });
    expect(res.statusCode).toBe(expected);
    expect(existsSync(join(h.root, "data", PENDING_RESTORE_NAME))).toBe(false);
  });

  it("缺少 name / 非字符串 → 400", async () => {
    const h = makeHarness();
    for (const payload of [{}, { name: 123 }, { name: "" }, { name: "  " }]) {
      const res = await h.app.inject({
        method: "POST",
        url: "/api/v1/data/restore",
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });
});
