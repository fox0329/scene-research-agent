import { describe, it, expect } from "vitest";
import { parseSo360Html, looksBlockedBySo360 } from "./web-so360.js";

const FIXTURE = `
<li class="res-list" data-result-type="normal">
  <h3 class="res-title"><a href="https://www.so.com/link?m=abc" data-mdurl="https://www.zjtcn.com/zhishi/gdjmjgfyq">长输管道阀室设计规范</a></h3>
  <p class="res-desc">长输管道线路截断阀室、分输阀室的设计要求与安全规定。</p>
</li>
<li class="res-list" data-result-type="ad">
  <h3 class="res-title"><a href="https://www.so.com/link?m=ad" data-mdurl="https://example.com/ad">广告：阀门厂家</a></h3>
  <p class="res-desc">广告内容</p>
</li>
<li class="res-list" data-result-type="normal">
  <h3 class="res-title"><a href="https://ai.so.com/search?q=abc">AI 问答卡</a></h3>
  <p class="res-desc">不是原始来源</p>
</li>
`;

describe("parseSo360Html", () => {
  it("优先 data-mdurl 真实地址，跳过广告和 AI 问答卡", () => {
    const hits = parseSo360Html(FIXTURE);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.url).toBe("https://www.zjtcn.com/zhishi/gdjmjgfyq");
    expect(hits[0]?.title).toBe("长输管道阀室设计规范");
    expect(hits[0]?.snippet).toContain("分输阀室");
  });

  it("空页返回空数组", () => {
    expect(parseSo360Html("")).toEqual([]);
  });

  it("反爬页识别为被拦", () => {
    expect(looksBlockedBySo360("<html>访问异常，请输入验证码</html>")).toBe(true);
    expect(looksBlockedBySo360(FIXTURE)).toBe(false);
  });
});
