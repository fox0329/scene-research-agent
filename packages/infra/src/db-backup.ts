/**
 * @scene/infra — SQLite 数据备份与待恢复文件
 *
 * 发布前的数据安全闭环（P0）：
 * - 启动备份：**打开/迁移之前**把已有库快照到同目录 `backups/`，保留最新 3 份；
 * - 在线备份：`VACUUM INTO` 生成一致性快照（运行中的库也能备）；
 * - 待恢复：只写同目录 `restore-on-boot.db`，真正的替换发生在下一次启动、
 *   `new Database()` 之前（运行中绝不替换正在使用的库）。
 *
 * 为什么快照优先走 `VACUUM INTO` 而不是 `copyFileSync`：库是 WAL 模式，崩溃后
 * 已提交数据可能还在 `-wal` 里，只复制主文件会静默丢数据。`VACUUM INTO` 会连带
 * WAL 里的内容写进一份独立快照；只有它打不开时才退回文件复制（备份失败不阻断启动）。
 */

import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// ─── 常量 ──────────────────────────────────────────────────

/** 备份目录名（与数据库同目录） */
export const BACKUP_DIR_NAME = "backups";
/** 本地保留份数：自动/手动备份各保留最新 3 份 */
export const BACKUP_KEEP = 3;
/** 列表接口最多返回条数（UI 只展示最近 3 份） */
export const BACKUP_LIST_LIMIT = 10;
/** 待恢复标记文件：下一次启动时替换数据库 */
export const PENDING_RESTORE_NAME = "restore-on-boot.db";
/** 自动备份文件名前缀：`scene-YYYYMMDD-HHMMSS.db` */
export const STARTUP_BACKUP_PREFIX = "scene";
/** 恢复前对当前库的备份前缀：`pre-restore-YYYYMMDD-HHMMSS.db` */
export const PRE_RESTORE_PREFIX = "pre-restore";

const DB_EXT = ".db";
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.db$/u;
const MAX_NAME_LENGTH = 128;

// ─── 类型 ──────────────────────────────────────────────────

/** 一份备份文件的对外信息（size=字节，created_at=文件 mtime ISO） */
export interface BackupInfo {
  name: string;
  size: number;
  created_at: string;
}

/** 启动备份结果：失败只返回 error，不抛（备份绝不能阻断启动） */
export interface BackupOutcome {
  ok: boolean;
  backup?: BackupInfo;
  /** 无需备份时说明原因（首次启动 / 空库） */
  skipped?: string;
  /** 失败原因（同时已 console.warn） */
  error?: string;
}

/** 已写入 `restore-on-boot.db` 的待恢复结果 */
export interface RestorePreparation {
  pending: true;
  restartRequired: true;
  name: string;
}

/** 启动时执行待恢复的结果 */
export interface RestoreApplyResult {
  /** 本次启用的待恢复文件名（固定为 restore-on-boot.db） */
  restoredFrom?: string;
  /** 替换前对旧库做的备份文件名 */
  preRestoreBackup?: string;
  /** 未能恢复/仅部分完成时的告警（不阻断启动） */
  warning?: string;
}

/** 启动备份/恢复的实况，挂在 DbInstance 上供日志与排障读取 */
export interface DbBackupStatus {
  /** 备份目录；内存库为 null */
  dir: string | null;
  /** 本次启动自动备份文件名 */
  startupBackup?: string;
  /** 本次启动应用的待恢复文件 */
  restoredFrom?: string;
  /** 恢复前对旧库的备份文件名 */
  preRestoreBackup?: string;
  /** 不阻断启动的告警 */
  warnings: string[];
}

/** 备份/恢复业务错误：路由据此映射 400 / 404 / 500 */
export class BackupError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid" | "not_found" | "io",
  ) {
    super(message);
    this.name = "BackupError";
  }
}

export interface BackupOptions {
  /** 备份目录；缺省同目录 `backups/` */
  backupDir?: string;
  /** 保留份数，默认 3 */
  keep?: number;
  /** 注入时钟（测试用，保证文件名可预期） */
  now?: Date;
}

// ─── 路径与命名 ────────────────────────────────────────────

/** 数据库文件默认备份目录：与 db 同目录的 `backups/` */
export function backupDirOf(dbPath: string): string {
  return join(dirname(resolve(dbPath)), BACKUP_DIR_NAME);
}

/** 本地时间戳：`YYYYMMDD-HHMMSS`（文件名用，不含时区标记） */
export function backupStamp(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** SQL 字符串字面量：单引号翻倍（VACUUM INTO 的路径转义） */
function sqlLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

function infoOf(file: string): BackupInfo {
  const st = statSync(file);
  return { name: basename(file), size: st.size, created_at: st.mtime.toISOString() };
}

/** 生成不冲突的备份名：同秒重复时追加 -2、-3… */
function uniqueBackupName(dir: string, prefix: string, now: Date): string {
  const base = `${prefix}-${backupStamp(now)}`;
  let name = `${base}${DB_EXT}`;
  for (let i = 2; existsSync(join(dir, name)); i += 1) {
    name = `${base}-${i}${DB_EXT}`;
  }
  return name;
}

// ─── 文件名校验（防路径穿越） ──────────────────────────────

/**
 * 校验备份文件名：只允许 `backups/` 下的 `.db` 文件名。
 *
 * 拒绝绝对路径、`../`、子目录、非 .db、隐藏文件；生成器产出的字符集
 * （字母数字与 `._-`）之外一律不接受，避免用奇怪名字绕过路径判断。
 */
export function validateBackupName(name: string): string {
  if (typeof name !== "string") throw new BackupError("需要备份文件名", "invalid");
  const trimmed = name.trim();
  if (!trimmed || trimmed !== name) throw new BackupError("备份文件名不能为空或含首尾空白", "invalid");
  if (trimmed.length > MAX_NAME_LENGTH) throw new BackupError("备份文件名过长", "invalid");
  if (trimmed.includes("\0")) throw new BackupError("备份文件名含非法字符", "invalid");
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new BackupError("备份文件名不能包含路径分隔符", "invalid");
  }
  if (basename(trimmed) !== trimmed) throw new BackupError("备份文件名不能包含目录", "invalid");
  if (!NAME_RE.test(trimmed)) {
    throw new BackupError("备份文件名非法（只接受 backups/ 下的 .db 文件名）", "invalid");
  }
  return trimmed;
}

/**
 * 把用户给的文件名解析为 `backupDir` 下的真实文件（存在、是普通文件、未越界）。
 *
 * 符号链接必须仍落在备份目录内：否则在 backups/ 里放一个指向 /etc 的链接
 * 就能把任意文件复制成待恢复库。
 */
export function resolveBackupFile(backupDir: string, name: string): string {
  const safe = validateBackupName(name);
  const absDir = resolve(backupDir);
  const target = resolve(absDir, safe);
  if (dirname(target) !== absDir) {
    throw new BackupError("备份文件必须位于备份目录内", "invalid");
  }
  if (!existsSync(target)) throw new BackupError(`备份文件不存在：${safe}`, "not_found");
  let real: string;
  let realDir: string;
  try {
    real = realpathSync(target);
    realDir = realpathSync(absDir);
  } catch {
    throw new BackupError(`备份文件不存在：${safe}`, "not_found");
  }
  if (dirname(real) !== realDir) {
    throw new BackupError("备份文件必须位于备份目录内", "invalid");
  }
  if (!statSync(real).isFile()) throw new BackupError("备份文件不是普通文件", "invalid");
  return target;
}

// ─── 列表与裁剪 ────────────────────────────────────────────

/** 列出备份（最新在前，最多 limit 条；不创建目录、无副作用） */
export function listBackups(dir: string, limit = BACKUP_LIST_LIMIT): BackupInfo[] {
  if (!existsSync(dir)) return [];
  const rows: { info: BackupInfo; mtime: number }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".") || !entry.name.endsWith(DB_EXT)) continue;
    try {
      const file = join(dir, entry.name);
      const st = statSync(file);
      rows.push({
        info: { name: entry.name, size: st.size, created_at: st.mtime.toISOString() },
        mtime: st.mtimeMs,
      });
    } catch {
      // 统计瞬间被删/被占用：跳过这一份，不让列表接口整体失败
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime || b.info.name.localeCompare(a.info.name));
  return rows.slice(0, Math.max(0, limit)).map((r) => r.info);
}

/**
 * 裁剪备份：只处理**本模块生成**的备份名，保留最新 keep 份。
 *
 * 前缀必须按完整命名模式匹配，不能用 `startsWith("scene-")`：
 * `backups/` 目录可能同时存着用户/脚本留下的历史备份（如
 * `scene-master-before-105-20261006-161503.db`），宽前缀会把它们当自动备份删掉。
 *
 * 自动/手动备份（scene-）与恢复前备份（pre-restore-）各自保留 3 份，
 * 恢复动作不会把用户手动创建的备份挤掉。
 */
export function pruneBackups(dir: string, keep = BACKUP_KEEP, prefix?: string): string[] {
  const family = prefix ? new RegExp(`^${escapeRegExp(prefix)}-\\d{8}-\\d{6}(?:-\\d+)?\\.db$`, "u") : null;
  const rows = listBackups(dir, Number.MAX_SAFE_INTEGER).filter((b) =>
    family ? family.test(b.name) : true,
  );
  const deleted: string[] = [];
  for (const row of rows.slice(Math.max(0, keep))) {
    try {
      rmSync(join(dir, row.name), { force: true });
      deleted.push(row.name);
    } catch {
      // 删旧备份失败不影响新备份可用，也不该阻断启动
    }
  }
  return deleted;
}

/** 正则转义（前缀只来自内部常量，这里仍防御一下） */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── 快照 ──────────────────────────────────────────────────

/**
 * 把 src 快照到 dest（dest 必须不存在）。
 *
 * 优先 SQLite 在线备份（readonly 连接 + VACUUM INTO），能带上 WAL 中已提交的数据；
 * 打不开时退回文件复制。调用方保证此刻主库尚未以读写方式打开。
 */
function snapshotToFile(src: string, dest: string): void {
  try {
    const ro = new Database(src, { readonly: true, fileMustExist: true });
    try {
      ro.exec(`VACUUM INTO ${sqlLiteral(dest)}`);
    } finally {
      ro.close();
    }
    if (!existsSync(dest)) throw new Error("SQLite 未生成备份文件");
  } catch {
    // 在线备份不可用（坏库/锁/旧格式）→ 文件复制兜底；失败则交给调用方
    rmSync(dest, { force: true });
    copyFileSync(src, dest);
  }
}

/** 立即对文件做一份指定前缀的快照（调用方保证库未以读写方式打开） */
function createFileBackup(dbPath: string, opts: BackupOptions, prefix: string): BackupInfo {
  const src = resolve(dbPath);
  const dir = resolve(opts.backupDir ?? backupDirOf(src));
  mkdirSync(dir, { recursive: true });
  const name = uniqueBackupName(dir, prefix, opts.now ?? new Date());
  const dest = join(dir, name);
  snapshotToFile(src, dest);
  pruneBackups(dir, opts.keep ?? BACKUP_KEEP, prefix);
  return infoOf(dest);
}

// ─── 启动备份 ──────────────────────────────────────────────

/**
 * 打开数据库**之前**自动备份一份（失败只告警，绝不阻断启动）。
 *
 * @param dbPath 数据库文件路径
 * @param opts.backupDir 备份目录；缺省同目录 backups/
 */
export function createStartupBackup(dbPath: string, opts: BackupOptions = {}): BackupOutcome {
  try {
    const src = resolve(dbPath);
    if (!existsSync(src)) return { ok: true, skipped: "数据库文件尚不存在（首次启动）" };
    if (statSync(src).size === 0) return { ok: true, skipped: "数据库文件为空" };
    return { ok: true, backup: createFileBackup(src, opts, STARTUP_BACKUP_PREFIX) };
  } catch (err: unknown) {
    const message = errText(err);
    // 备份是增强能力，不是启动前置条件：坏目录/坏盘只能告警
    console.warn(`[db-backup] 启动自动备份失败（不阻断启动）：${message}`);
    return { ok: false, error: message };
  }
}

// ─── 在线备份（API「立即备份」） ───────────────────────────

/**
 * 用 SQLite `VACUUM INTO` 对正在使用的库做一致性备份。
 *
 * 先写同目录临时文件再 rename：中途失败不会留下半截 `.db` 被当成可用备份；
 * 目标名同秒冲突时追加 -2。完成后把 scene- 家族裁剪到 3 份。
 *
 * @throws BackupError 备份失败（路由映射为 500）
 */
export function createOnlineBackup(
  db: Database.Database,
  dir: string,
  opts: Omit<BackupOptions, "backupDir"> = {},
): BackupInfo {
  const absDir = resolve(dir);
  try {
    mkdirSync(absDir, { recursive: true });
    const name = uniqueBackupName(absDir, STARTUP_BACKUP_PREFIX, opts.now ?? new Date());
    const dest = join(absDir, name);
    const tmp = join(
      absDir,
      `.${name}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
    );
    try {
      db.exec(`VACUUM INTO ${sqlLiteral(tmp)}`);
      renameSync(tmp, dest);
    } catch (err: unknown) {
      rmSync(tmp, { force: true });
      throw err;
    }
    pruneBackups(absDir, opts.keep ?? BACKUP_KEEP, STARTUP_BACKUP_PREFIX);
    return infoOf(dest);
  } catch (err: unknown) {
    throw new BackupError(`备份失败：${errText(err)}`, "io");
  }
}

// ─── 待恢复 ────────────────────────────────────────────────

/**
 * 准备恢复：把选定备份复制为数据库同目录的 `restore-on-boot.db`。
 *
 * **不碰正在使用的库**——运行中只落一个标记文件，真正的替换在下次启动时
 * 由 `applyPendingRestore` 完成。
 */
export function prepareRestore(
  dbPath: string,
  name: string,
  opts: { backupDir?: string } = {},
): RestorePreparation {
  if (dbPath === ":memory:") {
    throw new BackupError("内存数据库不支持恢复", "invalid");
  }
  const absDb = resolve(dbPath);
  const dir = resolve(opts.backupDir ?? backupDirOf(absDb));
  const safe = validateBackupName(name);
  const src = resolveBackupFile(dir, safe);
  const targetDir = dirname(absDb);
  mkdirSync(targetDir, { recursive: true });
  const pending = join(targetDir, PENDING_RESTORE_NAME);
  const tmp = join(
    targetDir,
    `.${PENDING_RESTORE_NAME}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    copyFileSync(src, tmp);
    renameSync(tmp, pending);
  } catch (err: unknown) {
    rmSync(tmp, { force: true });
    throw new BackupError(`准备恢复失败：${errText(err)}`, "io");
  }
  return { pending: true, restartRequired: true, name: safe };
}

/**
 * 启动时执行待恢复：先把当前库备份为 `pre-restore-*`，再原子替换。
 *
 * 必须在 `new Database(dbPath)` 之前调用。若恢复前备份失败则**不替换**
 * （宁可不恢复，也不能在没有退路时覆盖用户数据），待恢复文件保留到下次启动。
 */
export function applyPendingRestore(
  dbPath: string,
  opts: BackupOptions = {},
): RestoreApplyResult {
  if (dbPath === ":memory:") return {};
  const absDb = resolve(dbPath);
  const pending = join(dirname(absDb), PENDING_RESTORE_NAME);
  if (!existsSync(pending)) return {};

  try {
    if (statSync(pending).size === 0) {
      rmSync(pending, { force: true });
      return { warning: "待恢复文件为空，已删除；本次按原库启动" };
    }

    const hasCurrent = existsSync(absDb) && statSync(absDb).size > 0;
    let preRestoreBackup: string | undefined;
    if (hasCurrent) {
      try {
        preRestoreBackup = createFileBackup(absDb, opts, PRE_RESTORE_PREFIX).name;
      } catch (err: unknown) {
        return {
          warning: `恢复前备份失败，本次未恢复（待恢复文件保留）：${errText(err)}`,
        };
      }
    }

    /* WAL/SHM 属于旧主文件：替换主文件前先把它们挪走，失败再挪回，
       避免旧 WAL 被新库误当成自己的日志。 */
    const stashed: { from: string; to: string }[] = [];
    let sidecarError = "";
    for (const suffix of ["-wal", "-shm"] as const) {
      const side = `${absDb}${suffix}`;
      if (!existsSync(side)) continue;
      const to = `${side}.restore-old`;
      try {
        rmSync(to, { force: true });
        renameSync(side, to);
        stashed.push({ from: side, to });
      } catch (err: unknown) {
        sidecarError = `${suffix} 挪不动：${errText(err)}`;
        break;
      }
    }
    if (sidecarError) {
      for (const s of stashed) {
        try {
          renameSync(s.to, s.from);
        } catch {
          // 回滚侧车失败也只剩告警，不能把启动拖死
        }
      }
      const message = `旧库 WAL/SHM 无法安全移开，本次未恢复（待恢复文件保留）：${sidecarError}`;
      console.warn(`[db-backup] ${message}`);
      return { preRestoreBackup, warning: message };
    }

    try {
      renameSync(pending, absDb);
    } catch (err: unknown) {
      for (const s of stashed) {
        try {
          renameSync(s.to, s.from);
        } catch {
          // 回滚侧车失败也只剩告警，不能把启动拖死
        }
      }
      const message = `替换数据库失败（待恢复文件保留）：${errText(err)}`;
      console.warn(`[db-backup] ${message}`);
      return { preRestoreBackup, warning: message };
    }

    for (const s of stashed) {
      try {
        rmSync(s.to, { force: true });
      } catch {
        // 旧侧车清理失败不影响已完成的恢复
      }
    }
    return { restoredFrom: PENDING_RESTORE_NAME, preRestoreBackup };
  } catch (err: unknown) {
    const message = `执行待恢复失败，本次按原库启动：${errText(err)}`;
    console.warn(`[db-backup] ${message}`);
    return { warning: message };
  }
}
