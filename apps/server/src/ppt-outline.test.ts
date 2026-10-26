/**
 * @scene/server — PPT 大纲（变更表 #341）
 *
 * 大纲是用户可改的交付物：生成提示词必须写清 6–15 页与版式范围；落盘读写不能串场景。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Scenario } from "@scene/contract";

import {
  buildPptOutlineDocPrompt,
  countOutlinePages,
  getPptOutline,
  pptOutlinePath,
  savePptOutlineFile,
} from "./ppt-outline.js";

const made: string[] = [];
const oldDir = process.env.DELIVERABLE_DIR;

function useTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "scene-ppt-outline-"));
  made.push(dir);
  process.env.DELIVERABLE_DIR = dir;
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (oldDir === undefined) delete process.env.DELIVERABLE_DIR;
  else process.env.DELIVERABLE_DIR = oldDir;
});

function scenario(id = "s1"): Scenario {
  return { id, name: "某厂区", created_at: "", updated_at: "" } as Scenario;
}

const OUTLINE = `# 某厂区 PPT 大纲

## 第 1 页｜一套平台管住设备与能耗｜版式：封面
- 标题：一套平台管住设备与能耗
- 要点：
  - 设备台账逐台贴码
- 结论：先看清现场，再谈节能

## 第 2 页｜现场设备互不相通｜版式：网格要点
- 标题：现场设备互不相通
- 要点：
  - 三套系统各管一摊
- 结论：数据口径先统一
`;

describe("PPT 大纲（#341）", () => {
  it("生成提示词写清 6–15 页、八种版式、必须依据解决方案", () => {
    const p = buildPptOutlineDocPrompt("某厂区", "## 解决方案\n正文");
    expect(p.system).toContain("6–15 页");
    expect(p.system).toContain("封面");
    expect(p.system).toContain("网格要点");
    expect(p.system).toContain("只能使用解决方案正文里出现过的");
    expect(p.user).toContain("## 解决方案正文");
  });

  it("页数按 `## 第 N 页` 数，用户改格式数不准也不崩", () => {
    expect(countOutlinePages(OUTLINE)).toBe(2);
    expect(countOutlinePages("没有页标题")).toBe(0);
  });

  it("未生成返回空；保存后可读回，路径按场景 id 隔离", () => {
    useTempDir();
    expect(getPptOutline(scenario("a")).generated).toBe(false);
    savePptOutlineFile(scenario("a"), OUTLINE);
    const got = getPptOutline(scenario("a"));
    expect(got.generated).toBe(true);
    expect(got.markdown).toContain("第 1 页");
    expect(got.chars).toBeGreaterThan(0);
    expect(pptOutlinePath("a")).toContain("a.ppt-outline.md");
    expect(getPptOutline(scenario("b")).generated).toBe(false);
  });
});
