/**
 * @scene/server — 选择导出文件夹（变更表 #133）
 *
 * 用户在界面上点「导出到文件」时，要在**自己的文件夹**里拿到 Word：
 * 浏览器给不了真实路径，所以由本地服务端弹系统对话框取路径（macOS `osascript`），
 * 其他平台或取消失败时，界面回退到「手填路径」。
 *
 * 安全边界：只允许用户主目录下的已存在目录，且拒绝几个敏感目录——
 * 这个接口只服务本机单人使用，但它终究是"按传入路径写盘"，必须收紧。
 */

import { execFile } from "node:child_process";
import { existsSync, statSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** 明确不接受的目录（配置与密钥） */
const DENY = [".ssh", ".dsh", ".gnupg", "Library/Keychains", "Library/Keychains", ".aws", ".config"];

export interface FolderPickResult {
  dir: string | null;
  /** 取消或平台不支持时给界面看的说明 */
  reason?: string;
}

/** AppleScript 字符串字面量里的转义（反斜杠与双引号）——路径或场景名里带上它们就不会把脚本写坏 */
function appleString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * 「选择文件夹」那一条 AppleScript（变更表 #151 抽成纯函数，便于单测转义）
 *
 * `startIn` 非空时写成 `default location POSIX file "…"`——对话框打开就停在上次导出的目录，
 * 用户不用每次从头点。**调用方必须先过 `assertExportDir`**：给一个不存在的路径，
 * osascript 会直接报错（对话框弹不出来，用户被逼去手填）。
 */
export function folderPickScript(prompt: string, startIn?: string | null): string {
  const head = `POSIX path of (choose folder with prompt "${appleString(prompt)}"`;
  if (startIn === undefined || startIn === null || startIn === "") return `${head})`;
  return `${head} default location POSIX file "${appleString(startIn)}")`;
}

/**
 * 弹系统「选择文件夹」对话框；取消返回 null，非 macOS 抛错由路由转成 501
 *
 * `startIn` 见 `folderPickScript`（默认起点；调用方负责先校验它是不是合法的导出目录）。
 */
export async function pickFolder(
  prompt = "选择导出报告的文件夹",
  startIn?: string | null,
): Promise<FolderPickResult> {
  if (process.platform !== "darwin") {
    return { dir: null, reason: "当前系统不支持弹出文件夹对话框，请直接填写路径" };
  }
  try {
    const { stdout } = await run("osascript", ["-e", folderPickScript(prompt, startIn)], {
      timeout: 120_000,
    });
    const dir = stdout.trim();
    return { dir: dir === "" ? null : dir };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // 用户点取消：osascript 退出码 1，报 "User canceled"
    if (/User canceled|-128/i.test(message)) return { dir: null, reason: "已取消选择" };
    return { dir: null, reason: `无法打开文件夹对话框：${message.slice(0, 120)}` };
  }
}

/** 校验目标目录：绝对路径、存在、是目录、可写、在主目录下且不在敏感目录里 */
export function assertExportDir(input: string): string {
  const dir = resolve(input.trim());
  if (!dir.startsWith(homedir() + sep)) {
    throw new Error(`只能导出到你的主目录下的文件夹（${homedir()}），收到：${dir}`);
  }
  const rel = dir.slice(homedir().length + 1);
  if (DENY.some((d) => rel === d || rel.startsWith(`${d}${sep}`) || rel.startsWith(`${d}/`))) {
    throw new Error(`这个目录受保护，不能作为导出目录：${dir}`);
  }
  if (!existsSync(dir)) throw new Error(`目录不存在：${dir}`);
  if (!statSync(dir).isDirectory()) throw new Error(`不是文件夹：${dir}`);
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    throw new Error(`目录不可写：${dir}`);
  }
  return dir;
}

/**
 * 记忆里的目录能不能当对话框的默认起点（变更表 #151）
 *
 * **记忆值也要过同一道校验**——导出的安全边界只此一处（`assertExportDir`），记忆不是授权：
 * 目录被删 / 被移走 / localStorage 被手改过，都当"没记过"（返回 null，对话框退回系统默认位置），
 * 绝不让一个坏路径把对话框弄成弹不出来。
 */
export function safeStartDir(input: unknown): string | null {
  if (typeof input !== "string" || input.trim() === "") return null;
  try {
    return assertExportDir(input);
  } catch {
    return null;
  }
}
