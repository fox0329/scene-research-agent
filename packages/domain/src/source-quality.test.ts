import { describe, expect, it } from "vitest";
import { cleanSourceText, judgeSourceQuality, normalizeSourceText } from "./source-quality.js";

describe("来源质量门（用户定调 2026-11-03：内容农场只能当线索）", () => {
  it("禁止措辞一律判成没来源", () => {
    for (const text of [
      "未知（未检索到公开来源）",
      "未知",
      "未检索到公开来源",
      "无公开来源",
      "暂无",
      "",
    ]) {
      expect(judgeSourceQuality(text).quality).toBe("no-source");
    }
  });

  it("内容农场/UGC 站点不给当依据（实测混进来的百家号、百度知道、CSDN）", () => {
    const cases = [
      "https://baijiahao.baidu.com/s?id=1878170997463809610",
      "https://zhidao.baidu.com/question/439150233439895252.html",
      "https://blog.csdn.net/xxx/article/details/123",
      "https://zhuanlan.zhihu.com/p/123456",
    ];
    for (const url of cases) expect(judgeSourceQuality(url).quality).toBe("ugc");
    expect(judgeSourceQuality("https://baijiahao.baidu.com/s?id=1").domain).toBe(
      "baijiahao.baidu.com",
    );
  });

  it("官方与主流媒体来源放行，交给既有权威性分级", () => {
    for (const url of [
      "https://www.ccgp.gov.cn/cggg/zygg/2024.shtml",
      "https://cn.chinadaily.com.cn/a/202401/01/xxx.html",
      "照明招标文件.pdf:12",
      "用户输入（场景描述）",
    ]) {
      expect(judgeSourceQuality(url).quality).toBe("ok");
    }
  });

  it("命中后的来源文本要说明依据，且不编造链条", () => {
    expect(normalizeSourceText({ quality: "no-source" })).toContain("推断：");
    expect(normalizeSourceText({ quality: "no-source" })).toContain("本步未见可定位来源");
    const ugc = normalizeSourceText({ quality: "ugc", domain: "baijiahao.baidu.com" });
    expect(ugc).toContain("baijiahao.baidu.com");
    expect(ugc).toContain("未见权威来源");
  });
});

describe("来源列里 URL 与正文粘连要切开（地铁能源管控实测）", () => {
  it("URL 后面的中文说明不进来源列", () => {
    expect(
      cleanSourceText("https://max.book118.com/html/2025/1119/5124314330013014.shtm；能耗统计须按标准分项计量"),
    ).toBe("https://max.book118.com/html/2025/1119/5124314330013014.shtm");
  });

  it("正常来源原样返回", () => {
    expect(cleanSourceText("招标文件.pdf:12")).toBe("招标文件.pdf:12");
    expect(cleanSourceText("http://finance.sina.cn/2026-01-07/detail-inhfnqzp4657681.d.html")).toBe(
      "http://finance.sina.cn/2026-01-07/detail-inhfnqzp4657681.d.html",
    );
  });
});
