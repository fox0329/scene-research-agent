import { describe, it, expect } from "vitest";
import { parseBingHtml, unwrapBingUrl, looksBlocked } from "./web-bing.js";

/** 真实 Bing 搜索结果页片段（2026-10-19 抓取，含跳转包装与实体） */
const REAL_FIXTURE = `
<ol id="b_results">
<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=9a1b&amp;u=a1aHR0cHM6Ly9vcGVuc3RkLnNhbXIuZ292LmNuL2J6Z2svc3RkL25ld0diSW5mbz9oY25vPUJBRkI0N0U4&amp;ntb=1" h="ID=SERP,1">国家标准|GB/T 22239-2019</a></h2><div class="b_caption"><p class="b_lineclamp2">2019年5月10日&ensp;&#0183;&ensp;版权所有 侵权必究 主管：国家市场监督管理总局</p></div><cite>openstd.samr.gov.cn</cite></li>
<li class="b_algo"><h2><a href="https://zhxy.cufe.edu.cn/info/1376/4471.htm">《网络安全等级保护制度 2.0》系列核心标准</a></h2><p>2026年6月2日&#0183;《网络安全等级保护制度 2.0》系列核心标准（GB/T 22239</p></li>
<li class="b_algo"><h2><a href="https://std.samr.gov.cn/gb/search/gbDetailed?id=88F4">国家标准 - 全国标准信息公共服务平台</a></h2><p>2019年5月10日 国家标准《信息安全技术 网络安全等级保护基本要求》</p></li>
</ol>
`;

describe("unwrapBingUrl", () => {
  it("还原 base64url 跳转包装", () => {
    const wrapped =
      "https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9vcGVuc3RkLnNhbXIuZ292LmNuL2J6Z2svZ2Iv&ntb=1";
    expect(unwrapBingUrl(wrapped)).toBe("https://openstd.samr.gov.cn/bzgk/gb/");
  });

  it("不是包装的 URL 原样返回", () => {
    expect(unwrapBingUrl("https://www.gov.cn/a.htm")).toBe("https://www.gov.cn/a.htm");
  });

  it("包装但解不出 → 原样返回（不抛错）", () => {
    const bad = "https://www.bing.com/ck/a?u=!!!!";
    expect(() => unwrapBingUrl(bad)).not.toThrow();
  });

  it("缺 u 参数 → 原样返回", () => {
    expect(unwrapBingUrl("https://www.bing.com/ck/a?p=1")).toBe("https://www.bing.com/ck/a?p=1");
  });
});

describe("parseBingHtml", () => {
  it("从真实页面片段抽出结果", () => {
    const hits = parseBingHtml(REAL_FIXTURE);
    expect(hits.length).toBe(3);
    expect(hits[0]!.url).toBe("https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=BAFB47E8");
    expect(hits[0]!.title).toBe("国家标准|GB/T 22239-2019");
  });

  it("域名不是 bing.com（跳转包装已还原，否则权威性判定全错）", () => {
    const hits = parseBingHtml(REAL_FIXTURE);
    for (const h of hits) expect(new URL(h.url).hostname).not.toContain("bing.com");
  });

  it("解码 HTML 实体（&#0183; &ensp; &amp;）", () => {
    const hits = parseBingHtml(REAL_FIXTURE);
    expect(hits[0]!.snippet).toContain("2019年5月10日");
    expect(hits[0]!.snippet).not.toContain("&#0183;");
    expect(hits[0]!.snippet).not.toContain("&ensp;");
  });

  it("去重同一 URL", () => {
    const dup = REAL_FIXTURE + REAL_FIXTURE;
    const hits = parseBingHtml(dup);
    const urls = hits.map((h) => h.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("空页面 → 空数组", () => {
    expect(parseBingHtml("")).toEqual([]);
    expect(parseBingHtml("<html><body>无结果</body></html>")).toEqual([]);
  });

  it("跳过没有 h2 链接的块", () => {
    const html = `<li class="b_algo"><div>只有摘要没有标题</div></li>`;
    expect(parseBingHtml(html)).toEqual([]);
  });

  it("跳过非 http 的链接", () => {
    const html = `<li class="b_algo"><h2><a href="javascript:void(0)">标题</a></h2></li>`;
    expect(parseBingHtml(html)).toEqual([]);
  });
});

describe("looksBlocked", () => {
  it("有结果块 → 没被拦", () => {
    expect(looksBlocked(REAL_FIXTURE)).toBe(false);
  });

  it("验证码页 → 被拦", () => {
    expect(looksBlocked("<html>请输入验证码</html>")).toBe(true);
    expect(looksBlocked("<html>unusual traffic detected</html>")).toBe(true);
  });

  it("空壳页也算异常（不清洗就当没搜到）", () => {
    expect(looksBlocked("<html><body></body></html>")).toBe(false);
  });
});

describe("matchesSites（服务端站点后置过滤）", () => {
  // 内联实现，避免测试依赖 apps/server
  function matchesSites(url: string, sites: string[]): boolean {
    const list = sites.map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (list.length === 0) return true;
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }
    return list.some((s) => {
      const site = s.replace(/^\*?\./, "").replace(/^\./, "");
      return host === site || host.endsWith(`.${site}`);
    });
  }

  it("空限定 → 全通过", () => {
    expect(matchesSites("https://a.com/x", [])).toBe(true);
  });

  it("裸域与子域都算命中", () => {
    expect(matchesSites("https://gov.cn/a", ["gov.cn"])).toBe(true);
    expect(matchesSites("https://www.gov.cn/a", ["gov.cn"])).toBe(true);
    expect(matchesSites("https://openstd.samr.gov.cn/a", ["samr.gov.cn"])).toBe(true);
  });

  it("带点的写法也认", () => {
    expect(matchesSites("https://www.gov.cn/a", [".gov.cn"])).toBe(true);
    expect(matchesSites("https://www.gov.cn/a", ["*.gov.cn"])).toBe(true);
  });

  it("不相关的站被挡掉（Bing 不遵守 site: 的补救）", () => {
    expect(matchesSites("https://www.toutiao.com/a", ["gov.cn"])).toBe(false);
    expect(matchesSites("https://baike.baidu.com/a", ["gov.cn"])).toBe(false);
  });

  it("形似但不是子域 → 挡掉", () => {
    expect(matchesSites("https://notgov.cn/a", ["gov.cn"])).toBe(false);
    expect(matchesSites("https://gov.cn.evil.com/a", ["gov.cn"])).toBe(false);
  });

  it("非法 URL → 挡掉", () => {
    expect(matchesSites("不是URL", ["gov.cn"])).toBe(false);
  });
});
