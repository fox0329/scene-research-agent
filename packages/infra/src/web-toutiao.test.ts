import { describe, it, expect } from "vitest";
import { parseToutiaoHtml, looksBlockedByToutiao, unwrapToutiaoUrl } from "./web-toutiao.js";

const FIXTURE = `
<div class="result-content" cr-params="{&quot;gid&quot;:&quot;1&quot;,&quot;title&quot;:&quot;截断阀室安全专业管理标准&quot;,&quot;url&quot;:null}">
  <div class="l-card-title"><a href="/search/jump?aid=1455&amp;url=https%3A%2F%2Farticle.zlink.toutiao.com%2Fx%3Falert%3D0%26h5_url%3Dhttps%253A%252F%252Fwww.gov.cn%252Fzhengce%252Fvalve.html">截断阀室安全专业管理标准</a></div>
  <p>长输管道线路截断阀室的安全管理要求。</p>
</div>
<div class="result-content" cr-params="{&quot;title&quot;:&quot;广告：阀门厂家&quot;,&quot;url&quot;:&quot;https://example.com/ad&quot;}">
  <a href="https://example.com/ad">广告</a>
</div>
<div class="result-content" cr-params="{&quot;title&quot;:&quot;没有链接的卡片&quot;}">
  <span>忽略</span>
</div>
`;

describe("parseToutiaoHtml", () => {
  it("解析 SSR 卡片，展开多层跳转拿到真实地址", () => {
    const hits = parseToutiaoHtml(FIXTURE);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.url).toBe("https://www.gov.cn/zhengce/valve.html");
    expect(hits[0]?.title).toContain("截断阀室");
    expect(hits[0]?.snippet).toContain("安全管理");
  });

  it("空页返回空数组", () => {
    expect(parseToutiaoHtml("")).toEqual([]);
  });

  it("反爬页识别为被拦", () => {
    expect(looksBlockedByToutiao("<html>请输入验证码</html>")).toBe(true);
    expect(looksBlockedByToutiao(FIXTURE)).toBe(false);
  });

  it("展开 toutiao 的 url/h5_url 参数", () => {
    expect(
      unwrapToutiaoUrl(
        "https://article.zlink.toutiao.com/x?h5_url=https%3A%2F%2Fwww.gov.cn%2Fa.html",
      ),
    ).toBe("https://www.gov.cn/a.html");
  });
});
