import { describe, it, expect, vi } from "vitest";
import { searchWithFallback, type SearchEngineFn } from "./web-fallback.js";

const BUDGET = { pageTimeoutMs: 1000 } as never;
const hit = (title: string) => ({ url: `https://example.com/${encodeURIComponent(title)}`, title, snippet: title });
const fail = (error: string): SearchEngineFn => vi.fn(async () => ({ ok: false, hits: [], error }));

describe("searchWithFallback", () => {
  it("百度被拦时改走搜狗，再到 360，直到拿到命中", async () => {
    const so360: SearchEngineFn = vi.fn(async () => ({ ok: true, hits: [hit("长输管道阀室设计规范")] }));
    const r = await searchWithFallback("baidu", "管网阀室 标准", BUDGET, 5, {
      baidu: fail("安全验证页"),
      sogou: fail("反爬验证页"),
      so360,
    });
    expect(r.ok).toBe(true);
    expect(r.via).toBe("360");
    expect(r.hits).toHaveLength(1);
    expect(so360).toHaveBeenCalledTimes(1);
  });

  it("前一家有命中但全不相关时继续换引擎", async () => {
    const sogou: SearchEngineFn = vi.fn(async () => ({ ok: true, hits: [hit("供热管网设计标准")] }));
    const so360: SearchEngineFn = vi.fn(async () => ({ ok: true, hits: [hit("天然气管网阀室设计规定")] }));
    const r = await searchWithFallback(
      "baidu",
      "管网阀室 标准",
      BUDGET,
      5,
      {
        baidu: async () => ({ ok: true, hits: [hit("供热管网设计标准")] }),
        sogou,
        so360,
      },
      (h) => String(h.title).includes("阀室"),
    );
    expect(r.ok).toBe(true);
    expect(r.via).toBe("360");
    expect(sogou).toHaveBeenCalledTimes(1);
    expect(so360).toHaveBeenCalledTimes(1);
  });

  it("全部失败时把每一家的原因带回，不伪造命中", async () => {
    const r = await searchWithFallback("baidu", "管网阀室", BUDGET, 5, {
      baidu: fail("百度安全验证"),
      sogou: fail("搜狗反爬"),
      so360: fail("360 无结果"),
      toutiao: fail("头条无结果"),
    });
    expect(r.ok).toBe(false);
    expect(r.hits).toEqual([]);
    expect(r.error).toContain("百度");
    expect(r.error).toContain("搜狗");
    expect(r.error).toContain("360");
  });
});
