/**
 * @scene/server — 对话联网检索工具测试（变更表 #344）
 *
 * 确定性层单测：引擎 mock 掉，验证参数校验、结果格式化、失败话术与分发。
 * 真实联网行为由起服务实测覆盖（见变更表 #344 验证记录）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./step-research.js", () => ({
  currentModelProvider: vi.fn(() => undefined),
}));

vi.mock("@scene/infra", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadWebSearchConfig: vi.fn(() => ({})),
    resolveEngine: vi.fn(),
    searchByEngine: vi.fn(),
  };
});

import { resolveEngine, searchByEngine } from "@scene/infra";
import {
  WEB_SEARCH_TOOL,
  chatWebSearchTools,
  extractChatSearchQuery,
  formatChatSearchHits,
  runChatWebSearch,
} from "./chat-web-search.js";

beforeEach(() => {
  vi.mocked(resolveEngine).mockReset();
  vi.mocked(searchByEngine).mockReset();
});

describe("extractChatSearchQuery", () => {
  it("提取并截断到 80 字", () => {
    expect(extractChatSearchQuery({ query: "  高德地图 服务区 采集 " })).toBe("高德地图 服务区 采集");
    expect(extractChatSearchQuery({ query: "长".repeat(90) })).toHaveLength(80);
  });

  it("空白查询返回 null", () => {
    expect(extractChatSearchQuery({})).toBeNull();
    expect(extractChatSearchQuery({ query: "   " })).toBeNull();
  });
});

describe("formatChatSearchHits", () => {
  it("标题、URL、发布时间、摘要齐全，带使用要求", () => {
    const text = formatChatSearchHits(
      "充电桩 数量",
      [
        {
          title: "全国充电基础设施 2025 年运行情况",
          url: "https://example.com/a",
          snippet: "截至 2025 年底全国充电桩约 1281.8 万台。".repeat(6),
          publishedAt: "2026-01",
        },
      ],
      "必应",
    );
    expect(text).toContain("查询「充电桩 数量」");
    expect(text).toContain("共 1 条");
    expect(text).toContain("来源通道：必应");
    expect(text).toContain("全国充电基础设施 2025 年运行情况");
    expect(text).toContain("https://example.com/a");
    expect(text).toContain("2026-01");
    expect(text.endsWith("…")).toBe(false); // 尾部是使用要求，不是摘要
    expect(text).toContain("…"); // 摘要被截断
    expect(text).not.toContain("万台。".repeat(6)); // 完整原文不出现
    expect(text).toContain("标题｜URL");
    expect(text).toContain("不要写进表格");
  });

  it("缺标题兜底、缺发布时间省略", () => {
    const text = formatChatSearchHits("q", [{ url: "https://e.com/b", snippet: "内容" }]);
    expect(text).toContain("（无标题）");
    expect(text).not.toContain("undefined");
    expect(text).toContain("1. （无标题）｜https://e.com/b");
  });
});

describe("runChatWebSearch", () => {
  it("缺 query 时提示模型补参数", async () => {
    const text = await runChatWebSearch({});
    expect(text).toContain("缺少 query");
    expect(searchByEngine).not.toHaveBeenCalled();
  });

  it("引擎不可用时如实说明并引导按行业通识回答", async () => {
    vi.mocked(resolveEngine).mockReturnValue({
      kind: "none",
      canSearch: false,
      detail: "未配置任何检索引擎",
    });
    const text = await runChatWebSearch({ query: "测试" });
    expect(text).toContain("联网检索当前不可用");
    expect(text).toContain("未配置任何检索引擎");
    expect(text).toContain("行业通识");
    expect(searchByEngine).not.toHaveBeenCalled();
  });

  it("命中时返回格式化结果", async () => {
    vi.mocked(resolveEngine).mockReturnValue({
      kind: "bing-html",
      canSearch: true,
      detail: "",
    });
    vi.mocked(searchByEngine).mockResolvedValue({
      ok: true,
      hits: [{ title: "高德充电桩上图", url: "https://e.com/c", snippet: "3000 站" }],
      via: "必应",
    });
    const text = await runChatWebSearch({ query: "高德 充电桩" });
    expect(text).toContain("https://e.com/c");
    expect(text).toContain("高德充电桩上图");
    expect(searchByEngine).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "bing-html", canSearch: true }),
      expect.objectContaining({}),
      "高德 充电桩",
      expect.objectContaining({ searches: 0 }),
      expect.objectContaining({ maxFetches: 0 }),
      5,
    );
  });

  it("检索失败给失败话术，不假装有结果", async () => {
    vi.mocked(resolveEngine).mockReturnValue({ kind: "tavily", canSearch: true, detail: "" });
    vi.mocked(searchByEngine).mockResolvedValue({ ok: false, hits: [], error: "反爬拦截" });
    const text = await runChatWebSearch({ query: "测试" });
    expect(text).toContain("联网检索未取得结果");
    expect(text).toContain("反爬拦截");
    expect(text).toContain("行业通识");
  });

  it("检索超时给超时话术", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(resolveEngine).mockReturnValue({ kind: "bing-html", canSearch: true, detail: "" });
      vi.mocked(searchByEngine).mockReturnValue(new Promise(() => {}));
      const pending = runChatWebSearch({ query: "慢查询" });
      const assertion = expect(pending).resolves.toContain("超时");
      await vi.advanceTimersByTimeAsync(26_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("chatWebSearchTools 分发", () => {
  it("工具定义是 web_search 的 function calling 格式", () => {
    expect(WEB_SEARCH_TOOL.function.name).toBe("web_search");
    expect(WEB_SEARCH_TOOL.function.parameters.required).toEqual(["query"]);
  });

  it("web_search 走检索，未知名拒绝", async () => {
    vi.mocked(resolveEngine).mockReturnValue({ kind: "bing-html", canSearch: true, detail: "" });
    vi.mocked(searchByEngine).mockResolvedValue({
      ok: true,
      hits: [{ title: "t", url: "https://e.com/d", snippet: "s" }],
    });
    const tools = chatWebSearchTools();
    await expect(tools.onCall("web_search", { query: "q" })).resolves.toContain("https://e.com/d");
    await expect(tools.onCall("write_table", {})).resolves.toEqual({
      note: "未知工具：write_table",
    });
  });
});
