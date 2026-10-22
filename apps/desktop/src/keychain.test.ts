import { describe, expect, it, vi } from "vitest";
import { keychainProtectionRequested, keychainStatus } from "./keychain";

describe("桌面壳钥匙串探测", () => {
  it("默认不探测：没设 SCENE_KEYCHAIN_PROTECTION 时绝不碰 Keychain", () => {
    const isEncryptionAvailable = vi.fn(() => true);
    expect(keychainStatus({ isEncryptionAvailable }, {})).toBe(false);
    expect(isEncryptionAvailable).not.toHaveBeenCalled();
  });

  it("显式开启后才探测，并如实返回可用性", () => {
    const isEncryptionAvailable = vi.fn(() => true);
    expect(keychainStatus({ isEncryptionAvailable }, { SCENE_KEYCHAIN_PROTECTION: "1" })).toBe(true);
    expect(isEncryptionAvailable).toHaveBeenCalledTimes(1);
  });

  it("显式开启但 Keychain 不可用 / 探测抛错：按不可用处理", () => {
    const env = { SCENE_KEYCHAIN_PROTECTION: "1" };
    expect(keychainStatus({ isEncryptionAvailable: () => false }, env)).toBe(false);
    expect(
      keychainStatus(
        {
          isEncryptionAvailable: () => {
            throw new Error("user denied");
          },
        },
        env,
      ),
    ).toBe(false);
  });

  it("只有值恰好为 1 才算开启（0/true/空都不算）", () => {
    expect(keychainProtectionRequested({ SCENE_KEYCHAIN_PROTECTION: "1" })).toBe(true);
    expect(keychainProtectionRequested({ SCENE_KEYCHAIN_PROTECTION: "0" })).toBe(false);
    expect(keychainProtectionRequested({ SCENE_KEYCHAIN_PROTECTION: "true" })).toBe(false);
  });
});
