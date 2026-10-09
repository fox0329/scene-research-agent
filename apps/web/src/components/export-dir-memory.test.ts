/**
 * @scene/web — 导出目录记忆单测（变更表 #151）
 *
 * 判据：按项目分开、只记成功（空值不覆盖）、读不出来当没记过、存储不可用不炸
 * （测试跑在 node 环境，没有 `window`，所以一律注入假存储）。
 */

import { describe, expect, it } from "vitest";

import {
  EXPORT_DIR_KEY_PREFIX,
  forgetExportDir,
  loadExportDir,
  saveExportDir,
  type ExportDirStorage,
} from "./export-dir-memory";

/** 假 localStorage（只实现用到的那三个方法） */
function fakeStorage(seed: Record<string, string> = {}): ExportDirStorage & { readonly map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

/** 会抛异常的存储（隐私模式 / 配额满） */
const brokenStorage: ExportDirStorage = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("quota");
  },
  removeItem: () => {
    throw new Error("denied");
  },
};

const KEY = `${EXPORT_DIR_KEY_PREFIX}proj-1`;

describe("导出目录记忆（变更表 #151）", () => {
  it("导出成功后记住目录，下次读回来（键名带 projectId）", () => {
    const storage = fakeStorage();
    saveExportDir("proj-1", "/Users/me/Documents/报告", storage);
    expect(loadExportDir("proj-1", storage)).toBe("/Users/me/Documents/报告");
    expect(storage.map.get(KEY)).toBe("/Users/me/Documents/报告");
  });

  it("按项目分开记：A 项目的记忆不会漏给 B 项目", () => {
    const storage = fakeStorage();
    saveExportDir("proj-1", "/Users/me/A", storage);
    saveExportDir("proj-2", "/Users/me/B", storage);
    expect(loadExportDir("proj-1", storage)).toBe("/Users/me/A");
    expect(loadExportDir("proj-2", storage)).toBe("/Users/me/B");
    expect(loadExportDir("proj-3", storage)).toBe("");
  });

  it("前后空格归一后再存（系统对话框给的路径可能带空格）", () => {
    const storage = fakeStorage();
    saveExportDir("proj-1", "  /Users/me/Documents/报告  ", storage);
    expect(loadExportDir("proj-1", storage)).toBe("/Users/me/Documents/报告");
  });

  it("空值 / 没项目 / 非字符串项目一律不写（失败与取消不许覆盖上次的成功记录）", () => {
    const storage = fakeStorage({ [KEY]: "/Users/me/上次" });
    saveExportDir("proj-1", "", storage);
    saveExportDir("proj-1", "   ", storage);
    saveExportDir(undefined, "/Users/me/别的", storage);
    saveExportDir(null, "/Users/me/别的", storage);
    expect(loadExportDir("proj-1", storage)).toBe("/Users/me/上次");
    expect(loadExportDir(undefined, storage)).toBe("");
    expect(loadExportDir(null, storage)).toBe("");
  });

  it("换了别处导出 → 记忆跟着换成新的（以用户操作为准）", () => {
    const storage = fakeStorage();
    saveExportDir("proj-1", "/Users/me/旧目录", storage);
    saveExportDir("proj-1", "/Users/me/新目录", storage);
    expect(loadExportDir("proj-1", storage)).toBe("/Users/me/新目录");
  });

  it("用户清空输入框 → 忘掉这个项目的记忆（别的项目不受影响）", () => {
    const storage = fakeStorage();
    saveExportDir("proj-1", "/Users/me/A", storage);
    saveExportDir("proj-2", "/Users/me/B", storage);
    forgetExportDir("proj-1", storage);
    expect(loadExportDir("proj-1", storage)).toBe("");
    expect(loadExportDir("proj-2", storage)).toBe("/Users/me/B");
  });

  it("垃圾值（只有空格）读出来当没记过", () => {
    expect(loadExportDir("proj-1", fakeStorage({ [KEY]: "   " }))).toBe("");
  });

  it("存储不可用（隐私模式 / 配额满）不炸：读给空、写与清静默跳过", () => {
    expect(loadExportDir("proj-1", brokenStorage)).toBe("");
    expect(() => saveExportDir("proj-1", "/Users/me/报告", brokenStorage)).not.toThrow();
    expect(() => forgetExportDir("proj-1", brokenStorage)).not.toThrow();
  });

  it("没有注入存储且非浏览器环境（node / SSR）→ 读空、写不炸", () => {
    expect(loadExportDir("proj-1", null)).toBe("");
    expect(() => saveExportDir("proj-1", "/Users/me/报告", null)).not.toThrow();
    expect(() => forgetExportDir("proj-1", null)).not.toThrow();
  });
});
