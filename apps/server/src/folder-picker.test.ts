/**
 * @scene/server — 导出文件夹校验（变更表 #133）+ 对话框脚本（变更表 #151）
 *
 * 这个接口会按传入路径写盘，所以边界必须收紧：只允许主目录下的已存在目录，
 * 且拒绝配置与密钥目录。弹对话框那部分依赖 macOS，不做单测（失败即回退手填）——
 * 但**拼出来的那条 AppleScript 是纯函数**，转义与默认起点在这里锁住。
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertExportDir, folderPickScript, safeStartDir } from "./folder-picker.js";

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function mkUnderHome(prefix: string): string {
  const dir = mkdtempSync(join(homedir(), `${prefix}-`));
  made.push(dir);
  return dir;
}

describe("导出目录校验（变更表 #133）", () => {
  it("接受主目录下存在的文件夹，返回绝对路径", () => {
    const dir = mkUnderHome(".scene-test-export");
    expect(assertExportDir(dir)).toBe(dir);
    expect(assertExportDir(`  ${dir}  `)).toBe(dir); // 前后空格自动去掉
  });

  it("拒绝主目录之外的路径", () => {
    expect(() => assertExportDir(tmpdir())).toThrow(/主目录/);
    // Windows 没有 /etc；用家目录的上一级（C:\Users）表达"家目录之外"
    const outsideHome = process.platform === "win32" ? join(homedir(), "..") : "/etc";
    expect(() => assertExportDir(outsideHome)).toThrow(/主目录/);
  });

  it("拒绝配置与密钥目录", () => {
    for (const rel of [".ssh", ".dsh", ".aws", "Library/Keychains"]) {
      const dir = join(homedir(), rel);
      // Windows 上这些目录通常不存在——产品会先按"不存在"拒绝，只要拒绝即可；
      // 存在时（macOS/Linux）必须给出"受保护"这个更准确的原因
      if (existsSync(dir)) {
        expect(() => assertExportDir(dir), rel).toThrow(/受保护/);
      } else {
        expect(() => assertExportDir(dir), rel).toThrow();
      }
    }
  });

  it("拒绝不存在的路径与不是文件夹的路径", () => {
    expect(() => assertExportDir(join(homedir(), "不存在的目录-abc-xyz"))).toThrow(/不存在/);
    const dir = mkUnderHome(".scene-test-export");
    const file = join(dir, "报告.md");
    writeFileSync(file, "x", "utf8");
    expect(() => assertExportDir(file)).toThrow(/不是文件夹/);
  });
});

describe("对话框 AppleScript（变更表 #151）", () => {
  it("没给默认起点 → 只有 prompt（与 #133 的老脚本等价）", () => {
    expect(folderPickScript("选个文件夹")).toBe(
      'POSIX path of (choose folder with prompt "选个文件夹")',
    );
  });

  it("给了默认起点 → 带上 default location POSIX file（上次导出的目录）", () => {
    expect(folderPickScript("选个文件夹", "/Users/me/Documents/报告")).toBe(
      'POSIX path of (choose folder with prompt "选个文件夹" default location POSIX file "/Users/me/Documents/报告")',
    );
  });

  it("空串 / null / undefined 都当没给（不写 default location）", () => {
    for (const value of ["", null, undefined]) {
      expect(folderPickScript("p", value)).toBe('POSIX path of (choose folder with prompt "p")');
    }
  });

  it("prompt 与路径里的双引号、反斜杠都转义（场景名带引号也不会把脚本写坏）", () => {
    const script = folderPickScript('把「A"B」导出到', '/Users/me/报"告\\目录');
    expect(script).toBe(
      'POSIX path of (choose folder with prompt "把「A\\"B」导出到" default location POSIX file "/Users/me/报\\"告\\\\目录")',
    );
  });
});

describe("记忆值当对话框起点（变更表 #151）", () => {
  it("合法目录（主目录下、存在）→ 归一后的绝对路径", () => {
    const dir = mkUnderHome(".scene-test-export");
    expect(safeStartDir(dir)).toBe(dir);
    expect(safeStartDir(`  ${dir}  `)).toBe(dir);
  });

  it("非法记忆值一律当没记过（主目录外 / 不存在 / 受保护 / 非字符串 / 空）", () => {
    for (const value of [
      tmpdir(),
      "/etc",
      join(homedir(), "不存在的目录-abc-xyz"),
      join(homedir(), ".ssh"),
      "",
      "   ",
      null,
      undefined,
      42,
      { dir: "/Users/me" },
    ]) {
      expect(safeStartDir(value), String(value)).toBeNull();
    }
  });
});
