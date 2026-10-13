/**
 * @scene/infra — 密钥落盘保护测试（变更表 #183）
 *
 * 关注两件事：① 加解密本身对不对（含历史明文、错误密钥、被篡改的密文）；
 * ② 接进供应商登记表之后，**文件里不再出现明文密钥**、而应用读到的仍是明文密钥。
 * 全程在临时目录里跑，不碰项目 data/。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  SECRET_PREFIX,
  decryptSecret,
  encryptSecret,
  isEncrypted,
  isSecretBoxEnabled,
  masterKey,
} from "./secret-box.js";
import { loadRegistry, registrySummary, resolveActiveModel, upsertProvider } from "./provider-store.js";

const KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");
const PLAINTEXT_KEY = "sk-live-abcdef1234567890";

let root: string;
const origProvidersFile = process.env.SCENE_PROVIDERS_FILE;
const origSecretKey = process.env.SCENE_SECRET_KEY;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scene-secretbox-"));
  process.env.SCENE_PROVIDERS_FILE = join(root, "providers.local.json");
  delete process.env.SCENE_SECRET_KEY;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (origProvidersFile === undefined) delete process.env.SCENE_PROVIDERS_FILE;
  else process.env.SCENE_PROVIDERS_FILE = origProvidersFile;
  if (origSecretKey === undefined) delete process.env.SCENE_SECRET_KEY;
  else process.env.SCENE_SECRET_KEY = origSecretKey;
});

describe("主密钥读取", () => {
  it("没配主密钥时不启用加密", () => {
    expect(masterKey()).toBeNull();
    expect(isSecretBoxEnabled()).toBe(false);
  });

  it("长度不对的主密钥当没配（宁可不加密，也不能写出解不开的密文）", () => {
    process.env.SCENE_SECRET_KEY = Buffer.from("太短").toString("base64");
    expect(masterKey()).toBeNull();
    expect(encryptSecret(PLAINTEXT_KEY)).toBe(PLAINTEXT_KEY);
  });

  it("合法的 32 字节主密钥会启用加密", () => {
    process.env.SCENE_SECRET_KEY = KEY;
    expect(isSecretBoxEnabled()).toBe(true);
  });
});

describe("加解密", () => {
  beforeEach(() => {
    process.env.SCENE_SECRET_KEY = KEY;
  });

  it("加密后能解回原文，且密文不含明文", () => {
    const box = encryptSecret(PLAINTEXT_KEY);
    expect(isEncrypted(box)).toBe(true);
    expect(box.startsWith(SECRET_PREFIX)).toBe(true);
    expect(box).not.toContain(PLAINTEXT_KEY);
    expect(decryptSecret(box)).toBe(PLAINTEXT_KEY);
  });

  it("同一个明文两次加密结果不同（随机 IV）", () => {
    expect(encryptSecret(PLAINTEXT_KEY)).not.toBe(encryptSecret(PLAINTEXT_KEY));
  });

  it("已是密文时重复加密不再套一层（幂等）", () => {
    const once = encryptSecret(PLAINTEXT_KEY);
    expect(encryptSecret(once)).toBe(once);
  });

  it("历史明文原样通过，便于平滑迁移", () => {
    expect(decryptSecret(PLAINTEXT_KEY)).toBe(PLAINTEXT_KEY);
  });

  it("换了主密钥解不开，返回空串而不是垃圾", () => {
    const box = encryptSecret(PLAINTEXT_KEY);
    process.env.SCENE_SECRET_KEY = OTHER_KEY;
    expect(decryptSecret(box)).toBe("");
  });

  it("密文被改过（认证标签不匹配）返回空串", () => {
    const box = encryptSecret(PLAINTEXT_KEY);
    const tampered = box.slice(0, -4) + (box.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(decryptSecret(tampered)).toBe("");
  });

  it("密文格式不完整返回空串", () => {
    expect(decryptSecret(`${SECRET_PREFIX}只有一段`)).toBe("");
  });
});

describe("接进供应商登记表", () => {
  const upsert = () =>
    upsertProvider({
      name: "verify-gw",
      base_url: "https://api.deepseek.com/v1",
      api_key: PLAINTEXT_KEY,
      models: [{ id: "deepseek-chat" }],
    });

  it("未给主密钥：维持明文落盘（与从前行为一致）", () => {
    upsert();
    const raw = readFileSync(process.env.SCENE_PROVIDERS_FILE!, "utf-8");
    expect(raw).toContain(PLAINTEXT_KEY);
  });

  it("给了主密钥：文件里没有明文密钥，应用读到的仍是明文密钥", () => {
    process.env.SCENE_SECRET_KEY = KEY;
    upsert();
    const raw = readFileSync(process.env.SCENE_PROVIDERS_FILE!, "utf-8");
    expect(raw).not.toContain(PLAINTEXT_KEY);
    expect(raw).toContain(SECRET_PREFIX);

    expect(loadRegistry().providers[0]!.api_key).toBe(PLAINTEXT_KEY);
    expect(resolveActiveModel("verify-gw").provider.api_key).toBe(PLAINTEXT_KEY);
    // 公共面照旧只给掩码，且掩码取的是真实密钥（证明解密发生在脱敏之前）
    expect(registrySummary().providers[0]!.key_masked).toBe("sk-••••7890");
    expect(registrySummary().providers[0]!.has_key).toBe(true);
  });

  it("历史明文在下一次写入时自动转成密文", () => {
    const path = process.env.SCENE_PROVIDERS_FILE!;
    // 模拟旧版本留下的明文登记表
    writeFileSync(
      path,
      JSON.stringify(
        {
          providers: [
            {
              name: "legacy",
              base_url: "https://api.deepseek.com/v1",
              api_key: PLAINTEXT_KEY,
              models: [{ id: "deepseek-chat" }],
              updated_at: new Date().toISOString(),
            },
          ],
          default_model: { provider: "legacy", model: "deepseek-chat" },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    process.env.SCENE_SECRET_KEY = KEY;
    expect(resolveActiveModel().provider.api_key).toBe(PLAINTEXT_KEY); // 明文仍能读
    upsertProvider({
      name: "legacy",
      base_url: "https://api.deepseek.com/v1",
      api_key: "", // 编辑时留空 = 保留原密钥
      models: [{ id: "deepseek-chat" }],
    });
    const raw = readFileSync(path, "utf-8");
    expect(raw).not.toContain(PLAINTEXT_KEY); // 再写一次就变密文了
    expect(raw).toContain(SECRET_PREFIX);
    expect(resolveActiveModel().provider.api_key).toBe(PLAINTEXT_KEY);
  });
});
