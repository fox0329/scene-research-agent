/**
 * @scene/server — 导出文件夹校验（变更表 #133）
 *
 * 这个接口会按传入路径写盘，所以边界必须收紧：只允许主目录下的已存在目录，
 * 且拒绝配置与密钥目录。弹对话框那部分依赖 macOS，不做单测（失败即回退手填）。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertExportDir } from "./folder-picker.js";

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
    expect(() => assertExportDir("/etc")).toThrow(/主目录/);
  });

  it("拒绝配置与密钥目录", () => {
    for (const rel of [".ssh", ".dsh", ".aws", "Library/Keychains"]) {
      expect(() => assertExportDir(join(homedir(), rel)), rel).toThrow(/受保护/);
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
