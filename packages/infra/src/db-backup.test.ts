/**
 * @scene/infra — 数据备份 / 待恢复单测
 *
 * 覆盖：启动备份创建、保留 3 份、失败不抛、restore-on-boot 替换 +
 * pre-restore 备份、非法文件名拒绝、测试临时库默认不备份。
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "./sqlite-repo.js";
import {
  PENDING_RESTORE_NAME,
  PRE_RESTORE_PREFIX,
  STARTUP_BACKUP_PREFIX,
  BackupError,
  applyPendingRestore,
  createStartupBackup,
  prepareRestore,
  pruneBackups,
  validateBackupName,
} from "./db-backup.js";

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "scene-backup-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 建一个有数据的真实库（WAL 模式，和线上一致） */
function seedDb(path: string, rows: string[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE t (name TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO t (name) VALUES (?)");
    for (const name of rows) insert.run(name);
  } finally {
    db.close();
  }
}

function namesOf(path: string): string[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare("SELECT name FROM t ORDER BY name").all() as { name: string }[]).map(
      (r) => r.name,
    );
  } finally {
    db.close();
  }
}

describe("createStartupBackup", () => {
  it("在打开前复制一份 scene-YYYYMMDD-HHMMSS.db，内容可读", () => {
    const root = tempDir();
    const dbPath = join(root, "data", "scene.db");
    const backupDir = join(root, "data", "backups");
    seedDb(dbPath, ["甲", "乙"]);

    const now = new Date(2026, 0, 2, 3, 4, 5);
    const out = createStartupBackup(dbPath, { backupDir, now });

    expect(out.ok).toBe(true);
    expect(out.backup?.name).toBe("scene-20260102-030405.db");
    expect(existsSync(join(backupDir, out.backup!.name))).toBe(true);
    expect(namesOf(join(backupDir, out.backup!.name))).toEqual(["乙", "甲"]);
  });

  it("只保留最新 3 份，旧的自删", () => {
    const root = tempDir();
    const dir = join(root, "backups");
    mkdirSync(dir, { recursive: true });
    for (const day of ["01", "02", "03", "04", "05"]) {
      const file = join(dir, `scene-202601${day}-000000.db`);
      writeFileSync(file, "x");
      // 显式拉开 mtime：同一毫秒内排序不稳定
      utimesSync(file, new Date(2026, 0, Number(day)), new Date(2026, 0, Number(day)));
    }

    const deleted = pruneBackups(dir, 3, STARTUP_BACKUP_PREFIX);

    expect(deleted.sort()).toEqual(["scene-20260101-000000.db", "scene-20260102-000000.db"]);
    expect(readdirSync(dir).sort()).toEqual([
      "scene-20260103-000000.db",
      "scene-20260104-000000.db",
      "scene-20260105-000000.db",
    ]);
  });

  it("不误删历史手准备份（scene-master-before-* 不匹配自动备份命名）", () => {
    const root = tempDir();
    const dir = join(root, "backups");
    mkdirSync(dir, { recursive: true });
    const historical = join(dir, "scene-master-before-105-20261006-161503.db");
    writeFileSync(historical, "old");
    for (let day = 1; day <= 4; day += 1) {
      const file = join(dir, `scene-2026010${day}-000000.db`);
      writeFileSync(file, "x");
      utimesSync(file, new Date(2026, 0, day), new Date(2026, 0, day));
    }

    pruneBackups(dir, 3, STARTUP_BACKUP_PREFIX);

    expect(existsSync(historical)).toBe(true);
    expect(readdirSync(dir).filter((n) => n.startsWith("scene-master")).length).toBe(1);
  });

  it("备份目录不可写时只告警，不抛错", () => {
    const root = tempDir();
    const dbPath = join(root, "scene.db");
    seedDb(dbPath, ["甲"]);
    // 用一个普通文件当"目录"的父级：mkdir 必然失败
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a dir");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = createStartupBackup(dbPath, { backupDir: join(blocker, "backups") });

    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
    expect(warn).toHaveBeenCalled();
  });

  it("数据库尚不存在（首次启动）时跳过，不报错", () => {
    const root = tempDir();
    const out = createStartupBackup(join(root, "new.db"), { backupDir: join(root, "backups") });
    expect(out.ok).toBe(true);
    expect(out.skipped).toBeTruthy();
    expect(out.backup).toBeUndefined();
  });
});

describe("测试库默认不备份", () => {
  it("createDb(临时文件) 不创建 backups/，除非显式传目录", () => {
    const root = tempDir();
    const dbPath = join(root, "data", "scene.db");
    const first = createDb(dbPath);
    try {
      expect(first.dbBackup.dir).not.toBeNull();
      expect(first.dbBackup.startupBackup).toBeUndefined();
      expect(existsSync(join(root, "data", "backups"))).toBe(false);
    } finally {
      first.db.close();
    }

    const explicit = createDb(dbPath, { backupDir: join(root, "explicit-backups") });
    try {
      expect(explicit.dbBackup.startupBackup).toMatch(/^scene-\d{8}-\d{6}\.db$/u);
      expect(existsSync(join(root, "explicit-backups", explicit.dbBackup.startupBackup!))).toBe(
        true,
      );
    } finally {
      explicit.db.close();
    }
  });

  it(":memory: 不备份", () => {
    const db = createDb(":memory:");
    try {
      expect(db.dbBackup.dir).toBeNull();
      expect(db.dbBackup.startupBackup).toBeUndefined();
    } finally {
      db.db.close();
    }
  });
});

describe("prepareRestore / applyPendingRestore", () => {
  it("恢复：替换为备份内容，并保留 pre-restore 备份", () => {
    const root = tempDir();
    const dbPath = join(root, "data", "scene.db");
    const backupDir = join(root, "data", "backups");
    seedDb(dbPath, ["原始"]);

    // 对"原始"库做一份可恢复的备份
    const backup = createStartupBackup(dbPath, {
      backupDir,
      now: new Date(2026, 0, 2, 3, 4, 5),
    }).backup!;

    // 之后再写一行，恢复后应消失
    const db = new Database(dbPath);
    db.prepare("INSERT INTO t (name) VALUES (?)").run("恢复后应消失");
    db.close();

    const prepared = prepareRestore(dbPath, backup.name, { backupDir });
    expect(prepared).toEqual({ pending: true, restartRequired: true, name: backup.name });
    expect(existsSync(join(root, "data", PENDING_RESTORE_NAME))).toBe(true);

    const applied = applyPendingRestore(dbPath, { backupDir });

    expect(applied.restoredFrom).toBe(PENDING_RESTORE_NAME);
    expect(applied.preRestoreBackup).toMatch(new RegExp(`^${PRE_RESTORE_PREFIX}-`, "u"));
    expect(existsSync(join(root, "data", PENDING_RESTORE_NAME))).toBe(false);
    expect(namesOf(dbPath)).toEqual(["原始"]);

    // 恢复前旧库必须还在：内容含恢复前写入的那一行
    const pre = join(backupDir, applied.preRestoreBackup!);
    expect(existsSync(pre)).toBe(true);
    expect(namesOf(pre)).toEqual(["原始", "恢复后应消失"]);
  });

  it("createDb 启动时自动执行待恢复（无需调用方介入）", () => {
    const root = tempDir();
    const dbPath = join(root, "data", "scene.db");
    const backupDir = join(root, "data", "backups");
    seedDb(dbPath, ["A"]);
    const backup = createStartupBackup(dbPath, { backupDir, now: new Date(2026, 0, 2, 3, 4, 5) })
      .backup!;
    const db = new Database(dbPath);
    db.prepare("INSERT INTO t (name) VALUES (?)").run("B");
    db.close();
    prepareRestore(dbPath, backup.name, { backupDir });

    const instance = createDb(dbPath, { backupDir });
    try {
      expect(instance.dbBackup.restoredFrom).toBe(PENDING_RESTORE_NAME);
      expect(instance.dbBackup.preRestoreBackup).toMatch(/^pre-restore-/u);
      const rows = instance.db.prepare("SELECT name FROM t").all() as { name: string }[];
      expect(rows.map((r) => r.name)).toEqual(["A"]);
    } finally {
      instance.db.close();
    }
  });

  it("恢复前备份失败时拒绝替换，并保留待恢复文件", () => {
    const root = tempDir();
    const dbPath = join(root, "data", "scene.db");
    const backupDir = join(root, "data", "backups");
    seedDb(dbPath, ["原始"]);
    const backup = createStartupBackup(dbPath, { backupDir, now: new Date() }).backup!;
    prepareRestore(dbPath, backup.name, { backupDir });

    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a dir");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const applied = applyPendingRestore(dbPath, { backupDir: join(blocker, "backups") });

    expect(applied.restoredFrom).toBeUndefined();
    expect(applied.warning).toMatch(/恢复前备份失败/u);
    expect(existsSync(join(root, "data", PENDING_RESTORE_NAME))).toBe(true);
    expect(namesOf(dbPath)).toEqual(["原始"]);
  });

  it("非法文件名一律拒绝（路径穿越/绝对路径/非 .db）", () => {
    const root = tempDir();
    const dbPath = join(root, "data", "scene.db");
    const backupDir = join(root, "data", "backups");
    seedDb(dbPath, ["原始"]);

    for (const bad of [
      "../evil.db",
      "../../etc/passwd.db",
      "..\\evil.db",
      join(root, "evil.db"),
      "/tmp/evil.db",
      "evil.txt",
      "sub/evil.db",
      "..",
      "",
      ".hidden.db",
    ]) {
      expect(() => validateBackupName(bad)).toThrow(BackupError);
      expect(() => prepareRestore(dbPath, bad, { backupDir })).toThrow(BackupError);
    }
  });

  it("合法但不存在 → not_found（不是路径穿越）", () => {
    const root = tempDir();
    const dbPath = join(root, "data", "scene.db");
    const backupDir = join(root, "data", "backups");
    seedDb(dbPath, ["原始"]);
    mkdirSync(backupDir, { recursive: true });
    try {
      prepareRestore(dbPath, "scene-20260102-030405.db", { backupDir });
      throw new Error("应当抛错");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(BackupError);
      expect((err as BackupError).kind).toBe("not_found");
    }
  });

  it("备份文件为空时删除 pending 并按原库启动", () => {
    const root = tempDir();
    const dbPath = join(root, "data", "scene.db");
    seedDb(dbPath, ["原始"]);
    const pending = join(root, "data", PENDING_RESTORE_NAME);
    writeFileSync(pending, "");
    const applied = applyPendingRestore(dbPath, { backupDir: join(root, "data", "backups") });
    expect(applied.restoredFrom).toBeUndefined();
    expect(applied.warning).toMatch(/为空/u);
    expect(existsSync(pending)).toBe(false);
    expect(statSync(dbPath).size).toBeGreaterThan(0);
  });
});
