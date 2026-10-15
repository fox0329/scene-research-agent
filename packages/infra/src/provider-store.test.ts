/**
 * @scene/infra — 供应商登记表测试（变更表 #16）
 *
 * SCENE_PROVIDERS_FILE 指到临时目录，不碰项目 data/。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRegistry,
  maskKey,
  registrySummary,
  removeProvider,
  resolveActiveModel,
  setDefaultModel,
  upsertProvider,
  NOT_CONFIGURED_MESSAGE,
} from "./provider-store.js";

let root: string;
const origFile = process.env.SCENE_PROVIDERS_FILE;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scene-pstore-"));
  process.env.SCENE_PROVIDERS_FILE = join(root, "providers.local.json");
});

afterEach(() => {
  if (origFile !== undefined) process.env.SCENE_PROVIDERS_FILE = origFile;
  else delete process.env.SCENE_PROVIDERS_FILE;
  rmSync(root, { recursive: true, force: true });
});

describe("默认未配置态", () => {
  it("文件缺失 → 空登记表、configured=false、解析抛「尚未配置」", () => {
    expect(loadRegistry()).toEqual({ providers: [], default_model: null });
    const s = registrySummary();
    expect(s.configured).toBe(false);
    expect(s.providers).toEqual([]);
    expect(() => resolveActiveModel()).toThrow(NOT_CONFIGURED_MESSAGE);
  });

  it("文件损坏 → 按未配置处理，不抛错", () => {
    writeFileSync(process.env.SCENE_PROVIDERS_FILE!, "{ broken");
    expect(loadRegistry().providers).toEqual([]);
  });
});

describe("供应商增删改", () => {
  it("upsert 新建 + 按 name 更新，密钥留空保留原值", () => {
    const created = upsertProvider({
      name: "talkweb",
      base_url: "https://llm.example.com/v1/",
      api_key: "sk-abcdef123456",
      models: [{ id: "deepseek-v4-pro" }, { id: "   ", name: "空行剔除" }],
    });
    expect(created.base_url).toBe("https://llm.example.com/v1"); // 去尾斜杠
    expect(created.models).toEqual([{ id: "deepseek-v4-pro" }]); // 空 ID 剔除
    expect(created.has_key).toBe(true);
    expect(created.key_masked).toBe("sk-••••3456"); // 不回显密钥本体

    const updated = upsertProvider({
      name: "talkweb",
      base_url: "https://new.example.com/v1",
      models: [{ id: "m2" }],
    });
    expect(updated.base_url).toBe("https://new.example.com/v1");
    const reg = loadRegistry();
    expect(reg.providers).toHaveLength(1);
    expect(reg.providers[0]!.api_key).toBe("sk-abcdef123456"); // 保留
  });

  it("非法输入：空名 / 非 http(s) 链接 / 无模型 都抛错", () => {
    expect(() =>
      upsertProvider({ name: " ", base_url: "https://a.com/v1", models: [{ id: "m" }] }),
    ).toThrow("名称");
    expect(() =>
      upsertProvider({ name: "p", base_url: "ftp://a.com", models: [{ id: "m" }] }),
    ).toThrow("http");
    expect(() =>
      upsertProvider({ name: "p", base_url: "https://a.com", models: [] }),
    ).toThrow("模型");
  });

  it.skipIf(process.platform === "win32")("登记表文件不给组/其他用户读权限（0600 口径）", () => {
    upsertProvider({ name: "p", base_url: "https://a.com/v1", api_key: "k", models: [{ id: "m" }] });
    const mode = statSync(process.env.SCENE_PROVIDERS_FILE!).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it("removeProvider：存在返回 true；删除默认模型所在供应商后默认清空", () => {
    upsertProvider({ name: "p1", base_url: "https://a.com/v1", api_key: "k1", models: [{ id: "m1" }] });
    setDefaultModel({ provider: "p1", model: "m1" });
    expect(removeProvider("p1")).toBe(true);
    expect(removeProvider("p1")).toBe(false);
    expect(registrySummary().default_model).toBeNull();
  });
});

describe("默认模型与解析", () => {
  beforeEach(() => {
    upsertProvider({ name: "p1", base_url: "https://a.com/v1", api_key: "k1", models: [{ id: "m1" }, { id: "m2" }] });
    upsertProvider({ name: "p2", base_url: "https://b.com/v1", models: [{ id: "m9" }] });
  });

  it("setDefaultModel：模型不属于该供应商抛错；省略 model 取第一个", () => {
    expect(() => setDefaultModel({ provider: "p1", model: "zzz" })).toThrow("不含模型");
    expect(() => setDefaultModel({ provider: "nope", model: "m1" })).toThrow("未找到供应商");
    expect(setDefaultModel({ provider: "p1", model: "" })).toEqual({ provider: "p1", model: "m1" });
  });

  it("configured 需默认供应商有 Key：p2 无 Key → false；p1 有 Key → true", () => {
    setDefaultModel({ provider: "p1", model: "m2" });
    expect(registrySummary().configured).toBe(true);
    setDefaultModel({ provider: "p2", model: "m9" });
    expect(registrySummary().configured).toBe(false);
    expect(() => resolveActiveModel()).toThrow(/未填 API Key/);
  });

  it("resolveActiveModel 命中默认；显式供应商名解析首个模型", () => {
    setDefaultModel({ provider: "p1", model: "m2" });
    const r = resolveActiveModel();
    expect(r.provider.name).toBe("p1");
    expect(r.modelId).toBe("m2");
    const r2 = resolveActiveModel("p1");
    expect(r2.modelId).toBe("m1");
  });

  it("maskKey：短密钥全打点，空为 null", () => {
    expect(maskKey("")).toBeNull();
    expect(maskKey("abc")).toBe("••••");
    expect(maskKey("sk-1234567890abc")).toBe("sk-••••0abc");
  });
});
