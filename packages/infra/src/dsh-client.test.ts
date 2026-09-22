/**
 * @scene/infra — DSH 客户端测试
 *
 * 只测本地逻辑，不实际调用 LLM API（需要网络）。
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { DshClient, SessionHandle, FollowEvent } from "@scene/contract";
import {
  parseSettings,
  clearConfigCache,
  getProviderConfig,
  getDefaultModelConfig,
  getDshPort,
  getBaseURL,
} from "./dsh-config.js";
import { createDshClient } from "./dsh-client.js";

// ─── parseSettings 测试 ──────────────────────────────────

describe("parseSettings", () => {
  const sampleRaw: Record<string, unknown> = {
    "llm-pi-ai": {
      providers: {
        talkweb: {
          displayName: "talkweb",
          apiKeyEnv: "TALKWEB_API_KEY",
          api: "openai-completions",
          baseURL: "https://llm.talkweb.com.cn/v1",
          models: [
            { id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
            { id: "deepseek-v4-flash", name: "deepseek-v4-flash" },
          ],
        },
        "zai-coding-cn": {
          apiKeyEnv: "ZAI_CODING_CN_API_KEY",
          models: [
            { id: "glm-5.2", name: "GLM-5.2", contextWindow: 1000000, maxTokens: 131072 },
          ],
        },
      },
    },
    "agent-default-model": {
      provider: "zai-coding-cn",
      model: "glm-5.2",
    },
  };

  it("应正确解析 providers 配置", () => {
    const { providers } = parseSettings(sampleRaw);

    expect(Object.keys(providers)).toHaveLength(2);
    expect(providers["talkweb"]).toBeDefined();
    expect(providers["zai-coding-cn"]).toBeDefined();
  });

  it("talkweb 应含 displayName、baseURL 和两个模型", () => {
    const { providers } = parseSettings(sampleRaw);
    const tw = providers["talkweb"]!;

    expect(tw.displayName).toBe("talkweb");
    expect(tw.apiKeyEnv).toBe("TALKWEB_API_KEY");
    expect(tw.api).toBe("openai-completions");
    expect(tw.baseURL).toBe("https://llm.talkweb.com.cn/v1");
    expect(tw.models).toHaveLength(2);
    expect(tw.models[0]!.id).toBe("deepseek-v4-pro");
  });

  it("zai-coding-cn 无 displayName、无 baseURL", () => {
    const { providers } = parseSettings(sampleRaw);
    const zai = providers["zai-coding-cn"]!;

    expect(zai.displayName).toBeUndefined();
    expect(zai.baseURL).toBeUndefined();
    expect(zai.apiKeyEnv).toBe("ZAI_CODING_CN_API_KEY");
    expect(zai.models[0]!.contextWindow).toBe(1000000);
    expect(zai.models[0]!.maxTokens).toBe(131072);
  });

  it("应正确解析 agent-default-model", () => {
    const { defaultModel } = parseSettings(sampleRaw);

    expect(defaultModel.provider).toBe("zai-coding-cn");
    expect(defaultModel.model).toBe("glm-5.2");
  });

  it("缺少 agent-default-model 时应使用默认值", () => {
    const raw = { "llm-pi-ai": { providers: {} } };
    const { defaultModel } = parseSettings(raw);

    expect(defaultModel.provider).toBe("talkweb");
    expect(defaultModel.model).toBe("deepseek-v4-pro");
  });

  it("缺少 apiKeyEnv 时应抛出错误", () => {
    const raw = {
      "llm-pi-ai": {
        providers: {
          bad: { models: [] },
        },
      },
    };

    expect(() => parseSettings(raw)).toThrow('provider "bad" 缺少 apiKeyEnv');
  });

  it("models 为空数组时不应报错", () => {
    const raw = {
      "llm-pi-ai": {
        providers: {
          empty: { apiKeyEnv: "EMPTY_KEY", models: [] },
        },
      },
    };

    const { providers } = parseSettings(raw);
    expect(providers["empty"]!.models).toHaveLength(0);
  });

  it("api 字段缺省时应默认 openai-completions", () => {
    const raw = {
      "llm-pi-ai": {
        providers: {
          x: { apiKeyEnv: "X_KEY", models: [{ id: "m1", name: "M1" }] },
        },
      },
    };

    const { providers } = parseSettings(raw);
    expect(providers["x"]!.api).toBe("openai-completions");
  });
});

// ─── getProviderConfig 测试（需要读实际 settings.yaml） ──

describe("getProviderConfig", () => {
  beforeEach(() => {
    clearConfigCache();
  });

  it("应能读取 talkweb 供应商配置", () => {
    const cfg = getProviderConfig("talkweb");

    expect(cfg.apiKeyEnv).toBe("TALKWEB_API_KEY");
    expect(cfg.baseURL).toBe("https://llm.talkweb.com.cn/v1");
    expect(cfg.models.length).toBeGreaterThan(0);
  });

  it("应能读取 zai-coding-cn 供应商配置", () => {
    const cfg = getProviderConfig("zai-coding-cn");

    expect(cfg.apiKeyEnv).toBe("ZAI_CODING_CN_API_KEY");
    expect(cfg.models.length).toBeGreaterThan(0);
  });

  it("应能读取 xiaomi-token-plan-cn 供应商配置", () => {
    const cfg = getProviderConfig("xiaomi-token-plan-cn");

    expect(cfg.apiKeyEnv).toBe("XIAOMI_TOKEN_PLAN_CN_API_KEY");
  });

  it("不存在的供应商应抛出错误", () => {
    expect(() => getProviderConfig("nonexistent")).toThrow('未找到供应商 "nonexistent"');
  });
});

// ─── getDefaultModelConfig 测试 ──────────────────────────

describe("getDefaultModelConfig", () => {
  beforeEach(() => {
    clearConfigCache();
  });

  it("应返回 agent-default-model 配置", () => {
    const def = getDefaultModelConfig();

    expect(def.provider).toBeTruthy();
    expect(def.model).toBeTruthy();
  });
});

// ─── getDshPort 测试 ─────────────────────────────────────

describe("getDshPort", () => {
  it("默认端口应为 3081", () => {
    const original = process.env.DSH_PORT;
    try {
      delete process.env.DSH_PORT;
      expect(getDshPort()).toBe(3081);
    } finally {
      if (original !== undefined) process.env.DSH_PORT = original;
    }
  });

  it("DSH_PORT 环境变量应覆盖默认值", () => {
    const original = process.env.DSH_PORT;
    try {
      process.env.DSH_PORT = "3082";
      expect(getDshPort()).toBe(3082);
    } finally {
      if (original !== undefined) {
        process.env.DSH_PORT = original;
      } else {
        delete process.env.DSH_PORT;
      }
    }
  });

  it("无效端口值应抛出错误", () => {
    const original = process.env.DSH_PORT;
    try {
      process.env.DSH_PORT = "not-a-number";
      expect(() => getDshPort()).toThrow("DSH_PORT 环境变量值无效");
    } finally {
      if (original !== undefined) {
        process.env.DSH_PORT = original;
      } else {
        delete process.env.DSH_PORT;
      }
    }
  });
});

// ─── getBaseURL 测试 ─────────────────────────────────────

describe("getBaseURL", () => {
  beforeEach(() => {
    clearConfigCache();
  });

  it("有 baseURL 的供应商应直接返回", () => {
    const url = getBaseURL("talkweb", 3081);
    expect(url).toBe("https://llm.talkweb.com.cn/v1");
  });

  it("无 baseURL 的供应商应走 DSH 代理", () => {
    const url = getBaseURL("zai-coding-cn", 3082);
    expect(url).toBe("http://127.0.0.1:3082/v1");
  });
});

// ─── createDshClient 测试 ────────────────────────────────

describe("createDshClient", () => {
  it("应返回实现 DshClient 接口的对象", () => {
    const client = createDshClient({ provider: "talkweb" });

    expect(typeof client.createSession).toBe("function");
    expect(typeof client.prompt).toBe("function");
    expect(typeof client.cancel).toBe("function");
  });

  it("createSession 应生成唯一 sessionId", async () => {
    const client = createDshClient({ provider: "talkweb" });

    const h1 = await client.createSession({ title: "测试会话1" });
    const h2 = await client.createSession({ title: "测试会话2" });

    expect(h1.sessionId).toBeTruthy();
    expect(h2.sessionId).toBeTruthy();
    expect(h1.sessionId).not.toBe(h2.sessionId);
  });

  it("createSession 返回的 sessionId 应为 UUID 格式", async () => {
    const client = createDshClient({ provider: "talkweb" });
    const h = await client.createSession({ title: "UUID 测试" });

    // UUID v4 格式：xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(h.sessionId).toMatch(uuidRegex);
  });

  it("prompt 对不存在的会话应返回 error 事件", async () => {
    const client = createDshClient({ provider: "talkweb" });
    const fakeHandle: SessionHandle = { sessionId: "nonexistent-id" };

    const events: FollowEvent[] = [];
    for await (const event of client.prompt(fakeHandle, {
      system: "test",
      user: "test",
      outputContract: {},
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
    expect((events[0]! as Record<string, unknown>).message).toContain("nonexistent-id");
  });

  it("cancel 对不存在的会话不应抛错", async () => {
    const client = createDshClient({ provider: "talkweb" });

    // 不应抛出
    await client.cancel({ sessionId: "nonexistent-id" });
  });
});

// ─── DshClient 接口完整性验证 ────────────────────────────

describe("DshClient 接口实现完整性", () => {
  it("createDshClient 返回值应满足 DshClient 类型约束", () => {
    // 编译期类型检查 + 运行时方法存在性
    const client: DshClient = createDshClient({ provider: "talkweb" });

    expect(client.createSession).toBeInstanceOf(Function);
    expect(client.prompt).toBeInstanceOf(Function);
    expect(client.cancel).toBeInstanceOf(Function);

    // prompt 应返回 AsyncIterable
    const iter = client.prompt(
      { sessionId: "test" },
      { system: "s", user: "u", outputContract: {} },
    );
    expect(iter[Symbol.asyncIterator]).toBeInstanceOf(Function);
  });

  it("createSession 应接受 preset 可选参数", async () => {
    const client = createDshClient({ provider: "talkweb" });
    const h = await client.createSession({
      title: "带 preset",
      preset: "analysis",
    });

    expect(h.sessionId).toBeTruthy();
  });
});