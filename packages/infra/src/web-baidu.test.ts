import { describe, it, expect, vi, afterEach } from "vitest";
import { parseBaiduHtml, parseBaiduMobileHtml, looksBlockedByBaidu, searchBaidu } from "./web-baidu.js";

const FIXTURE = `
<div class="result c-container xpath-log new-pmd" id="1">
  <h3 class="t"><a href="http://www.baidu.com/link?url=abc">仪器是否满足 <em>CCEP</em> 环保认证要求</a></h3>
  <div class="c-abstract">在线监测设备需取得中国环境监测总站适用性检测报告。</div>
</div>
<div class="result c-container new-pmd" id="2">
  <h3 class="t"><a href="http://www.baidu.com/link?url=def">烟气排放连续监测系统（CEMS）设备认证要求</a></h3>
  <div class="c-abstract">固定污染源烟气排放连续监测系统技术要求。</div>
</div>
<div class="result c-container new-pmd" id="3" data-tuiguang="1">
  <h3 class="t"><a href="http://www.baidu.com/link?url=ad">广告：某某认证咨询</a></h3>
</div>
`;

describe("parseBaiduHtml", () => {
  it("解析标题/链接/摘要，并去掉推广位", () => {
    const hits = parseBaiduHtml(FIXTURE);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.title).toBe("仪器是否满足 CCEP 环保认证要求");
    expect(hits[0]?.snippet).toContain("适用性检测");
    expect(hits.every((h) => h.url.includes("baidu.com/link"))).toBe(true);
  });

  it("空页返回空数组", () => {
    expect(parseBaiduHtml("")).toEqual([]);
  });

  it("安全验证页识别为被拦", () => {
    expect(looksBlockedByBaidu("<html>百度安全验证</html>")).toBe(true);
    expect(looksBlockedByBaidu(FIXTURE)).toBe(false);
  });
});


const MOBILE_FIXTURE = `
<div  class="c-result result" data-log='{"mu":"https://www.mot.gov.cn/a.html"}'>
  <div class="c-result-content"><h3 class="cosc-title"><span class="cosc-title-slot"><span><!--s-text-->官方《城市轨道交通供电系统运营技术规范》解读</span></span></h3>
  <span class="summary-text_15QGa">适用于新建地铁、轻轨的供电系统，包含能源管理系统要求。</span></div>
</div>
<div  class="c-result result" data-log='{"mu":""}'>
  <h3>无落地链接的图片卡片</h3>
</div>
<div  class="c-result result" data-log='{"mu":"https://example.com/ad"}'>
  <h3>广告：某认证咨询</h3>
</div>
`;

describe("parseBaiduMobileHtml", () => {
  it("解析移动版结果：data-log.mu 真实 URL、h3 标题、summary-text 摘要", () => {
    const hits = parseBaiduMobileHtml(MOBILE_FIXTURE);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      url: "https://www.mot.gov.cn/a.html",
      title: "官方《城市轨道交通供电系统运营技术规范》解读",
      snippet: "适用于新建地铁、轻轨的供电系统，包含能源管理系统要求。",
    });
  });

  it("空页返回空数组", () => {
    expect(parseBaiduMobileHtml("")).toEqual([]);
  });
});

describe("searchBaidu — 桌面版被安全验证拦住", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("自动改走移动版，并返回真实落地链接", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>百度安全验证</html>", { status: 200 }))
      .mockResolvedValueOnce(new Response(MOBILE_FIXTURE, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const r = await searchBaidu("地铁能源管控", { pageTimeoutMs: 1000 } as never, 5);
    expect(r.ok).toBe(true);
    expect(r.hits[0]?.url).toBe("https://www.mot.gov.cn/a.html");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("m.baidu.com");
  });
});
