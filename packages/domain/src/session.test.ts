/**
 * @scene/domain — session 纯函数测试
 *
 * 覆盖 validateSessionTitle / canArchive / canDelete / normalizeTitle 四个纯函数。
 * 零 IO，可独立运行。
 */

import { describe, it, expect } from "vitest";
import {
  validateSessionTitle,
  canArchive,
  canDelete,
  normalizeTitle,
  normalizeConversationTitle,
  SESSION_TITLE_MAX,
  SESSION_STATUS_ACTIVE,
  SESSION_STATUS_ARCHIVED,
} from "./session.js";

// ─── validateSessionTitle ──────────────────────────────────

describe("validateSessionTitle", () => {
  it("合法标题应返回 true", () => {
    expect(validateSessionTitle("产品调研")).toBe(true);
    expect(validateSessionTitle("短标题")).toBe(true);
  });

  it("恰好 50 字符的标题应返回 true", () => {
    const title = "a".repeat(SESSION_TITLE_MAX);
    expect(validateSessionTitle(title)).toBe(true);
  });

  it("超过 50 字符的标题应返回 false", () => {
    const title = "a".repeat(SESSION_TITLE_MAX + 1);
    expect(validateSessionTitle(title)).toBe(false);
  });

  it("空字符串应返回 false", () => {
    expect(validateSessionTitle("")).toBe(false);
  });

  it("纯空白字符串应返回 false", () => {
    expect(validateSessionTitle("   ")).toBe(false);
    expect(validateSessionTitle("\t\n")).toBe(false);
  });

  it("首尾有空白但 trim 后合法的标题应返回 true", () => {
    expect(validateSessionTitle("  有效标题  ")).toBe(true);
  });

  it("首尾有空白但 trim 后超长的标题应返回 false", () => {
    const padded = "  " + "a".repeat(SESSION_TITLE_MAX + 1) + "  ";
    expect(validateSessionTitle(padded)).toBe(false);
  });
});

// ─── canArchive ────────────────────────────────────────────

describe("canArchive", () => {
  it("活跃状态可归档", () => {
    expect(canArchive(SESSION_STATUS_ACTIVE)).toBe(true);
  });

  it("已归档状态不可重复归档", () => {
    expect(canArchive(SESSION_STATUS_ARCHIVED)).toBe(false);
  });

  it("未知状态不可归档", () => {
    expect(canArchive("已删除")).toBe(false);
    expect(canArchive("")).toBe(false);
  });
});

// ─── canDelete ─────────────────────────────────────────────

describe("canDelete", () => {
  it("无消息可直接删除", () => {
    expect(canDelete(false)).toBe(true);
  });

  it("有消息不可直接删除", () => {
    expect(canDelete(true)).toBe(false);
  });
});

// ─── normalizeTitle ────────────────────────────────────────

describe("normalizeTitle", () => {
  it("去除首尾空白", () => {
    expect(normalizeTitle("  hello  ")).toBe("hello");
  });

  it("截断到 50 字符", () => {
    const raw = "a".repeat(100);
    expect(normalizeTitle(raw)).toHaveLength(SESSION_TITLE_MAX);
  });

  it("纯空白输入返回空串", () => {
    expect(normalizeTitle("   ")).toBe("");
  });

  it("正常标题不变", () => {
    expect(normalizeTitle("产品调研")).toBe("产品调研");
  });

  it("恰好 50 字符不截断", () => {
    const title = "b".repeat(SESSION_TITLE_MAX);
    expect(normalizeTitle(title)).toBe(title);
  });

  it("是 normalizeConversationTitle 的别名", () => {
    expect(normalizeTitle).toBe(normalizeConversationTitle);
  });
});