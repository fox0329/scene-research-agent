/**
 * @scene/web — 记住上次成功导出的目录（变更表 #151）
 *
 * 交付物步导出 Word / PPT 每次都先让用户选文件夹；系统对话框弹不出来时还要手敲一遍绝对路径。
 * 这里按**项目**记住"上一次成功写出的目录"，下次打开手填输入框时预填、也作为系统对话框的
 * 默认起点（`startIn`，见 `apps/server/src/folder-picker.ts`）。
 *
 * 三条纪律（都是用户定调的口径）：
 *  ① **只记成功**：导出报错、用户取消、路径非法一律不写——失败不许覆盖上一次的成功记录；
 *  ② **不绕过校验**：这里存的只是"预填值"，真正写盘前仍要过服务端既有的 `assertExportDir`
 *     （必须在主目录下、存在、是文件夹、可写、非敏感目录）——**记忆不是授权**；
 *  ③ **用户操作优先**：用户改过输入框就以用户的为准（导出成功即覆盖记忆），
 *     用户把输入框清空就忘掉记忆（下次不再拿旧值烦他）。
 *
 * 存储用 `localStorage`（键里带 projectId，按项目分开），不新增数据库表。
 */

/** localStorage 的键前缀（后接 projectId） */
export const EXPORT_DIR_KEY_PREFIX = "scene.export-dir.v1.";

/** 读写存储的最小接口（`localStorage` 的子集；单测注入假存储） */
export interface ExportDirStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 浏览器存储；取不到（隐私模式 / 非浏览器）就给 `null`，一律按"没记过"处理 */
function browserStorage(): ExportDirStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function keyOf(projectId: string): string {
  return `${EXPORT_DIR_KEY_PREFIX}${projectId}`;
}

/** 这个项目上次成功导出的目录；没记过 / 没项目 / 读不出来都给 `""` */
export function loadExportDir(
  projectId: string | null | undefined,
  storage: ExportDirStorage | null = browserStorage(),
): string {
  if (!projectId || storage === null) return "";
  try {
    return (storage.getItem(keyOf(projectId)) ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * 记下这一次**成功写出**的目录
 *
 * 空值不写（空串只当次生效，不覆盖记忆）；存储不可用（满了 / 被禁用）也只是记不住，
 * **绝不因此让导出失败**。
 */
export function saveExportDir(
  projectId: string | null | undefined,
  dir: string,
  storage: ExportDirStorage | null = browserStorage(),
): void {
  const value = dir.trim();
  if (!projectId || value === "" || storage === null) return;
  try {
    storage.setItem(keyOf(projectId), value);
  } catch {
    // 记不住就算了：导出本身已经成功，不该被存储异常拖垮
  }
}

/** 忘掉这个项目的记忆（用户在输入框里清空 = 不许再拿旧值兜他） */
export function forgetExportDir(
  projectId: string | null | undefined,
  storage: ExportDirStorage | null = browserStorage(),
): void {
  if (!projectId || storage === null) return;
  try {
    storage.removeItem(keyOf(projectId));
  } catch {
    // 同上：清不掉也不影响导出
  }
}
