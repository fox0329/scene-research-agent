import { describe, it, expect } from "vitest";
import { parseSogouHtml, looksBlockedBySogou } from "./web-sogou.js";

const FIXTURE = `
<div class="vrwrap" id="sogou_vr_1">
  <h3 class="vr-title"><a href="/link?url=abc">天然气管网管线进入场站<em>阀室</em>安全管理规定_百度文库</a></h3>
  <p class="star-wiki">第二条 进入站场、阀室内工作，必须正确穿着防静电工作服；阀室管理人员负责日动态管理。</p>
  <div data-url="https://wenku.baidu.com/view/abc.html"></div>
</div>
<div class="vrwrap" id="sogou_vr_2" data-ad="1">
  <h3 class="vr-title"><a href="/link?url=ad">广告：某某阀门厂家</a></h3>
  <p class="star-wiki">广告内容</p>
</div>
<div class="vrwrap" id="sogou_vr_3">
  <div>没有标题的推荐卡</div>
</div>
`;

describe("parseSogouHtml", () => {
  it("解析标题、真实 data-url、最长摘要，并去掉广告位", () => {
    const hits = parseSogouHtml(FIXTURE);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.url).toBe("https://wenku.baidu.com/view/abc.html");
    expect(hits[0]?.title).toContain("天然气管网");
    expect(hits[0]?.snippet).toContain("防静电");
  });

  it("空页返回空数组", () => {
    expect(parseSogouHtml("")).toEqual([]);
  });

  it("反爬页识别为被拦", () => {
    expect(looksBlockedBySogou("<html>请输入验证码</html>")).toBe(true);
    expect(looksBlockedBySogou(FIXTURE)).toBe(false);
  });
});
