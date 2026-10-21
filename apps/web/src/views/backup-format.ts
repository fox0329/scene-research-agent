/**
 * @scene/web — 设置页「数据备份」的纯展示格式化
 *
 * 单独抽出来是为了可单测：字节数、时间戳的显示口径不该埋在 JSX 里。
 */

const SIZE_UNITS = ["KB", "MB", "GB", "TB"] as const;

/**
 * 字节数 → 人类可读体积（1024 进制）
 *
 * 小于 1 KB 用 B；1–10 保留一位小数，10 以上取整——备份文件通常几 MB，
 * 界面上要的是"大概多大"，不是精确到字节。
 */
export function formatBackupSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${text} ${SIZE_UNITS[unit]}`;
}

/** 补零 */
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * ISO 时间 → 本地 `YYYY-MM-DD HH:mm`（备份列表用）
 *
 * 只到分钟：备份文件名里已有精确到秒的时间戳；列表再显示秒会增加噪音。
 * 非法时间返回「—」，不让一条坏数据把整行渲染打挂。
 */
export function formatBackupTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
