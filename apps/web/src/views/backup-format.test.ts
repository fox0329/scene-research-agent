/**
 * @scene/web — 备份展示格式化单测（纯逻辑，不渲染组件）
 */

import { describe, it, expect } from "vitest";
import { formatBackupSize, formatBackupTime } from "./backup-format.js";

describe("formatBackupSize", () => {
  it("小于 1 KB 显示字节", () => {
    expect(formatBackupSize(0)).toBe("0 B");
    expect(formatBackupSize(512)).toBe("512 B");
    expect(formatBackupSize(1023)).toBe("1023 B");
  });

  it("KB/MB 保留一位小数，10 以上取整", () => {
    expect(formatBackupSize(1024)).toBe("1.0 KB");
    expect(formatBackupSize(1536)).toBe("1.5 KB");
    expect(formatBackupSize(10 * 1024)).toBe("10 KB");
    expect(formatBackupSize(12.5 * 1024 * 1024)).toBe("13 MB");
  });

  it("非法值显示占位符，不抛错", () => {
    expect(formatBackupSize(-1)).toBe("—");
    expect(formatBackupSize(Number.NaN)).toBe("—");
    expect(formatBackupSize(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatBackupTime", () => {
  it("按本地时间输出 YYYY-MM-DD HH:mm", () => {
    // 用本地时间构造，避免测试机时区不同导致期望值漂移
    const iso = new Date(2026, 0, 2, 3, 4, 5).toISOString();
    expect(formatBackupTime(iso)).toBe("2026-01-02 03:04");
  });

  it("非法时间显示占位符", () => {
    expect(formatBackupTime("not-a-time")).toBe("—");
    expect(formatBackupTime("")).toBe("—");
  });
});
