import { describe, it, expect } from "vitest";
import { parseBaiduHtml, looksBlockedByBaidu } from "./web-baidu.js";

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
