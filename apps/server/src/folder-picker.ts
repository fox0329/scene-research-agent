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

/** 弹系统「选择文件夹」对话框；取消返回 null，非 macOS 抛错由路由转成 501 */
export async function pickFolder(prompt = "选择导出报告的文件夹"): Promise<FolderPickResult> {
  if (process.platform !== "darwin") {
    return { dir: null, reason: "当前系统不支持弹出文件夹对话框，请直接填写路径" };
  }
  try {
    const { stdout } = await run(
      "osascript",
      ["-e", `POSIX path of (choose folder with prompt "${prompt}")`],
      { timeout: 120_000 },
    );
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
