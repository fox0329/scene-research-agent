/**
 * 对比度回归（v0.7.2 UI 质量专项）
 *
 * 现状：弱化文字 `--ct3` 原为 #a1a1aa，在白底只有 2.56:1，侧栏分组标题、
 * 流程阶段说明、右栏空态、单元格提示全部不达标（WCAG AA 要求 4.5:1）。
 * 这类问题截图看不出来，必须用公式锁住。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const tokens = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");

function token(name: string): string {
  const m = tokens.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`, "u"));
  expect(m, `缺少颜色 token --${name}`).not.toBeNull();
  return m![1]!;
}

function luminance(hex: string): number {
  const v = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("文字对比度", () => {
  const surfaces = { white: "#ffffff", page: token("cpg"), muted: token("cm") };

  it("弱化文字在三种底色上都达到 4.5:1", () => {
    for (const [name, bg] of Object.entries(surfaces)) {
      expect(contrast(token("ct3"), bg), `--ct3 on ${name}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("正文/次级文字在页面与白底上达到 4.5:1", () => {
    for (const name of ["ct", "ct2"]) {
      expect(contrast(token(name), surfaces.page), `--${name}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("主色与四种语义色在浅色底上达到 4.5:1", () => {
    const pairs: Array<[string, string]> = [
      ["cp", token("cp-s")],
      ["cs-h", token("cs-s")],
      ["cw-h", token("cw-s")],
      ["ce-h", token("ce-s")],
    ];
    for (const [fg, bg] of pairs) {
      expect(contrast(token(fg), bg), fg).toBeGreaterThanOrEqual(4.5);
    }
  });
});
