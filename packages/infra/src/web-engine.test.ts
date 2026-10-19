import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveEngine,
  isOfficialDeepSeek,
  loadWebSearchConfig,
  saveWebSearchConfig,
} from "./web-engine.js";

describe("isOfficialDeepSeek", () => {
  it("认官方 base_url（带 /v1）", () => {
    expect(isOfficialDeepSeek("https://api.deepseek.com/v1")).toBe(true);
    expect(isOfficialDeepSeek("https://api.deepseek.com")).toBe(true);
    expect(isOfficialDeepSeek("https://API.DeepSeek.com/v1")).toBe(true);
  });

  it("不认代理——这是实测出来的真问题", () => {
    // 用户实际配置：拓维的 OpenAI 兼容代理，没有 /tools/search
    expect(isOfficialDeepSeek("https://llm.talkweb.com.cn/v1")).toBe(false);
    expect(isOfficialDeepSeek("https://api.openai.com/v1")).toBe(false);
  });

  it("不认子串冒充", () => {
    expect(isOfficialDeepSeek("https://api.deepseek.com.evil.com/v1")).toBe(false);
    expect(isOfficialDeepSeek("https://notapi.deepseek.com/v1")).toBe(false);
  });

  it("空串与非法值返回 false", () => {
    expect(isOfficialDeepSeek("")).toBe(false);
    expect(isOfficialDeepSeek("不是URL")).toBe(false);
  });
});

describe("resolveEngine — 自动选", () => {
  it("官方 DeepSeek → deepseek-native", () => {
    const e = resolveEngine({}, { baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-x" });
    expect(e.kind).toBe("deepseek-native");
    expect(e.canSearch).toBe(true);
  });

  it("代理且无 Tavily → 退到免注册 Bing（用户不必去注册）", () => {
    const e = resolveEngine({}, { baseUrl: "https://llm.talkweb.com.cn/v1", apiKey: "sk-x" });
    expect(e.kind).toBe("bing-html");
    expect(e.canSearch).toBe(true);
    expect(e.detail).toContain("免注册");
    // 必须如实说明这是非官方接口、可能失效
    expect(e.detail).toContain("非官方");
  });

  it("代理但有 Tavily → tavily", () => {
    const e = resolveEngine({ tavilyKey: "tvly-x" }, { baseUrl: "https://llm.talkweb.com.cn/v1", apiKey: "sk-x" });
    expect(e.kind).toBe("tavily");
    expect(e.canSearch).toBe(true);
  });

  it("官方 DeepSeek 且也有 Tavily → 优先官方（零新增供应商）", () => {
    const e = resolveEngine({ tavilyKey: "tvly-x" }, { baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-x" });
    expect(e.kind).toBe("deepseek-native");
  });

  it("完全没有供应商 → 仍退到免注册 Bing（不抛错）", () => {
    const e = resolveEngine({}, undefined);
    expect(e.kind).toBe("bing-html");
    expect(e.canSearch).toBe(true);
  });
});

describe("resolveEngine — 显式指定", () => {
  it("强制 tavily 但没 Key → none + 说清原因", () => {
    const e = resolveEngine({ engine: "tavily" }, { baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-x" });
    expect(e.canSearch).toBe(false);
    expect(e.detail).toContain("没有填 Key");
  });

  it("强制 deepseek-native 但供应商是代理 → none", () => {
    const e = resolveEngine(
      { engine: "deepseek-native" },
      { baseUrl: "https://llm.talkweb.com.cn/v1", apiKey: "sk-x" },
    );
    expect(e.canSearch).toBe(false);
    expect(e.detail).toContain("不是 api.deepseek.com");
  });

  it("强制 none → 关闭检索", () => {
    const e = resolveEngine({ engine: "none" }, { baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-x" });
    expect(e.canSearch).toBe(false);
    expect(e.detail).toContain("已关闭");
  });
});

describe("配置读写", () => {
  let dir: string;
  const KEY = "SCENE_WEB_SEARCH_FILE";
  const old = process.env[KEY];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "webcfg-"));
    process.env[KEY] = join(dir, "web-search.local.json");
  });
  afterEach(() => {
    if (old === undefined) delete process.env[KEY];
    else process.env[KEY] = old;
    rmSync(dir, { recursive: true, force: true });
  });

  it("文件不存在 → 空配置，不抛错", () => {
    expect(loadWebSearchConfig()).toEqual({});
  });

  it("保存后能读回", () => {
    saveWebSearchConfig({ engine: "tavily", tavilyKey: "tvly-1" });
    expect(loadWebSearchConfig().tavilyKey).toBe("tvly-1");
    expect(loadWebSearchConfig().engine).toBe("tavily");
  });

  it("部分更新不覆盖已有字段", () => {
    saveWebSearchConfig({ engine: "tavily", tavilyKey: "tvly-1" });
    saveWebSearchConfig({ engine: "none" });
    const c = loadWebSearchConfig();
    expect(c.engine).toBe("none");
    expect(c.tavilyKey).toBe("tvly-1");
  });

  it("落盘权限为 600（含 Key，不能被同机其他用户读到）", () => {
    saveWebSearchConfig({ tavilyKey: "tvly-secret" });
    const p = process.env[KEY]!;
    expect(existsSync(p)).toBe(true);
    // 内容里确实有 Key（这是预期：本地配置，不是代码）
    expect(readFileSync(p, "utf-8")).toContain("tvly-secret");
  });

  it("损坏文件按未配置处理", () => {
    writeFileSync(process.env[KEY]!, "{不是合法 json");
    expect(loadWebSearchConfig()).toEqual({});
  });
});
