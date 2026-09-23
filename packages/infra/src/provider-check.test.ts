/**
 * @scene/infra — 链接质量检查测试（fetch 全 mock，不出网）
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { checkProviderConnection, normalizeBaseUrl } from "./provider-check.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeBaseUrl", () => {
  it("去尾斜杠；拒绝非 http(s) 与非法 URL", () => {
    expect(normalizeBaseUrl("https://a.com/v1//")).toBe("https://a.com/v1");
    expect(() => normalizeBaseUrl("ftp://a.com")).toThrow(/http/);
    expect(() => normalizeBaseUrl("")).toThrow(/合法 URL/);
  });
});

describe("checkProviderConnection", () => {
  it("未填 Key：直接失败并说明", async () => {
    const r = await checkProviderConnection({ base_url: "https://a.com/v1", api_key: "" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/API Key/);
  });

  it("仅探活（无模型）：/models 200 → ok + 延迟 + 模型清单", async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      jsonResponse({ data: [{ id: "m-a" }, { id: "m-b" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await checkProviderConnection({ base_url: "https://a.com/v1", api_key: "sk-x" });
    expect(r.ok).toBe(true);
    expect(r.stage).toBe("models");
    expect(r.models_seen).toEqual(["m-a", "m-b"]);
    expect(r.models_latency_ms).toBeGreaterThanOrEqual(0);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://a.com/v1/models");
  });

  it("401 → 鉴权失败文案", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "bad" }, 401)));
    const r = await checkProviderConnection({ base_url: "https://a.com/v1", api_key: "sk-x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/鉴权失败/);
  });

  it("两段式：探活过 + chat 200 → stage=chat 带生成延迟", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).endsWith("/models")
        ? jsonResponse({ data: [{ id: "m-a" }] })
        : jsonResponse({ choices: [{ message: { content: "p" } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await checkProviderConnection({
      base_url: "https://a.com/v1",
      api_key: "sk-x",
      model: "m-a",
    });
    expect(r.ok).toBe(true);
    expect(r.stage).toBe("chat");
    expect(r.chat_latency_ms).toBeGreaterThanOrEqual(0);
    const chatCall = fetchMock.mock.calls[1]!;
    expect(String(chatCall[0])).toBe("https://a.com/v1/chat/completions");
    const body = JSON.parse(String((chatCall[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.max_tokens).toBe(1);
    expect(body.stream).toBe(false);
  });

  it("chat 404 → 失败并带响应片段", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).endsWith("/models")
        ? jsonResponse({ data: [] })
        : jsonResponse({ error: { message: "model not found" } }, 404),
    ));
    const r = await checkProviderConnection({
      base_url: "https://a.com/v1",
      api_key: "sk-x",
      model: "ghost",
    });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("chat");
    expect(r.error).toMatch(/模型调用失败（HTTP 404）/);
  });

  it("网络不可达 → 中文排查文案", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const r = await checkProviderConnection({ base_url: "https://a.com/v1", api_key: "sk-x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/网络不可达|链接/);
  });
});
