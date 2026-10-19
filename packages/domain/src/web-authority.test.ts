import { describe, it, expect } from "vitest";
import { gradeWebSource, extractDocNo, extractReprintSource, authorityOfCategory } from "./web-authority.js";

/** 长到不会被判"正文过短"的正文（且含标题关键词，避免误触"内容与标题不符"） */
function bodyWith(keyword: string, times = 30): string {
  return `${keyword}。${"这是一段正常长度的正文内容，用于判定权威性。".repeat(times)}`;
}

describe("gradeWebSource — P 阶梯（先命中者胜）", () => {
  it("P1 法规标准原文站点 → T1", () => {
    const v = gradeWebSource({
      url: "https://openstd.samr.gov.cn/bzgk/gb/newGbInfo?hcno=1",
      title: "GB/T 22239-2019 信息安全技术 网络安全等级保护基本要求",
      text: bodyWith("GB/T 22239-2019 信息安全技术 网络安全等级保护基本要求"),
      publishedAt: "2019-05-10",
    });
    expect(v.rule).toBe("P1");
    expect(v.category).toBe("法规标准");
    expect(v.authority).toBe("T1");
  });

  it("P2 政府域名 → T1（含裸域 gov.cn）", () => {
    const v = gradeWebSource({
      url: "https://www.gov.cn/zhengce/content/2024/a.htm",
      title: "国务院关于印发十四五数字经济发展规划的通知",
      text: bodyWith("国务院关于印发十四五数字经济发展规划的通知"),
      publishedAt: "2022-01-12",
    });
    expect(v.rule).toBe("P2");
    expect(v.category).toBe("政府文件");
    expect(v.authority).toBe("T1");
  });

  it("P2 政府站上的评论/问答页 → 降为媒体（不是官方文件）", () => {
    const v = gradeWebSource({
      url: "https://www.gov.cn/comment/2024/a.htm",
      title: "网友评论",
      text: bodyWith("网友评论"),
      publishedAt: "2024-01-01",
    });
    expect(v.rule).toBe("P7");
    expect(v.category).toBe("媒体");
  });

  it("P3 交易所 → T2 年报公告", () => {
    const v = gradeWebSource({
      url: "https://www.cninfo.com.cn/new/disclosure/detail?stockCode=1",
      title: "云枢智控2024年年度报告",
      text: bodyWith("云枢智控2024年年度报告"),
      publishedAt: "2025-04-01",
    });
    expect(v.rule).toBe("P3");
    expect(v.category).toBe("年报公告");
    expect(v.authority).toBe("T2");
  });

  it("P4 厂商官方文档（三级子域也能认）→ T2", () => {
    const v = gradeWebSource({
      url: "https://docs.aws.amazon.com/lambda/latest/dg/welcome.html",
      title: "AWS Lambda 开发者指南",
      text: bodyWith("AWS Lambda 开发者指南"),
      publishedAt: "2025-01-01",
    });
    expect(v.rule).toBe("P4");
    expect(v.category).toBe("厂商官方");
    expect(v.authority).toBe("T2");
  });

  it("P5 学术站点 → T2 行业报告", () => {
    const v = gradeWebSource({
      url: "https://arxiv.org/abs/2403.14403",
      title: "Adaptive-RAG Learning to Adapt Retrieval-Augmented Large Language Models",
      text: bodyWith("Adaptive-RAG Learning to Adapt Retrieval-Augmented Large Language Models"),
      publishedAt: "2024-03-21",
    });
    expect(v.rule).toBe("P5");
    expect(v.category).toBe("行业报告");
    expect(v.authority).toBe("T2");
  });

  it("P8 自媒体 → T4（www 前缀不影响）", () => {
    for (const url of [
      "https://www.zhihu.com/question/1",
      "https://mp.weixin.qq.com/s/abc",
      "https://blog.csdn.net/x/article/details/1",
      "https://www.weibo.com/u/1",
    ]) {
      const v = gradeWebSource({ url, title: "文章", text: bodyWith("文章"), publishedAt: "2024-01-01" });
      expect(v.category).toBe("自媒体");
      expect(v.authority).toBe("T4");
      expect(v.rule).toBe("P8");
    }
  });

  it("自媒体必须排在厂商官方之前（www.zhihu.com 不被文档子域规则吃掉）", () => {
    const v = gradeWebSource({
      url: "https://www.zhihu.com/question/1",
      title: "如何评价边缘计算",
      text: bodyWith("如何评价边缘计算"),
      publishedAt: "2024-01-01",
    });
    expect(v.category).not.toBe("厂商官方");
  });

  it("P7 一般站点 → T3 媒体", () => {
    const v = gradeWebSource({
      url: "https://example.com/some/page",
      title: "随便一个页面",
      text: bodyWith("随便一个页面"),
      publishedAt: "2024-01-01",
    });
    expect(v.rule).toBe("P7");
    expect(v.authority).toBe("T3");
  });

  it("URL 解析不了 → 禁止引用（P9 语义）", () => {
    const v = gradeWebSource({ url: "不是URL", title: "x", text: "正文" });
    expect(v.blocked).toBe(true);
    expect(v.authority).toBe("T4");
  });
});

describe("gradeWebSource — 降级因子", () => {
  it("无发布日期 → 降一级", () => {
    const withDate = gradeWebSource({
      url: "https://www.miit.gov.cn/a.htm",
      title: "工业和信息化部通知",
      text: bodyWith("工业和信息化部通知"),
      publishedAt: "2024-01-01",
    });
    const noDate = gradeWebSource({
      url: "https://www.miit.gov.cn/a.htm",
      title: "工业和信息化部通知",
      text: bodyWith("工业和信息化部通知"),
    });
    expect(withDate.downgrades).not.toContain("无发布日期");
    expect(noDate.downgrades).toContain("无发布日期");
    expect(noDate.authority).not.toBe("T1");
  });

  it("正文过短 → 降级并提示可能是摘要页", () => {
    const v = gradeWebSource({
      url: "https://example.com/a",
      title: "短页面",
      text: "太短了",
      publishedAt: "2024-01-01",
    });
    expect(v.downgrades).toContain("正文过短");
  });

  it("转载声明 → 降级（权威性属于原发机构）", () => {
    const v = gradeWebSource({
      url: "https://www.miit.gov.cn/a.htm",
      title: "工业和信息化部通知",
      text: `来源：新华社\n${bodyWith("工业和信息化部通知")}`,
      publishedAt: "2024-01-01",
    });
    expect(v.downgrades).toContain("转载");
    expect(v.authority).not.toBe("T1");
  });

  it("T1 最低降到 T3，不直接降到 T4（政府站转载仍是可查的公开信息）", () => {
    const v = gradeWebSource({
      url: "https://www.gov.cn/a.htm",
      title: "国务院通知",
      text: `来源：某自媒体\n国务院通知\n短正文`,
    });
    expect(v.authority).toBe("T3");
  });

  it("命中注入特征 → 降级", () => {
    const v = gradeWebSource({
      url: "https://example.com/a",
      title: "文章",
      text: bodyWith("文章"),
      publishedAt: "2024-01-01",
      injectionHit: true,
    });
    expect(v.downgrades).toContain("命中注入特征");
  });

  it("降级过多 → 禁止引用", () => {
    const v = gradeWebSource({
      url: "https://example.com/a",
      title: "搜索结果",
      text: "短",
      injectionHit: true,
    });
    expect(v.blocked).toBe(true);
  });
});

describe("gradeWebSource — 升级因子", () => {
  it("含文号 → 升一级（但从 T1 不再上浮）", () => {
    const v = gradeWebSource({
      url: "https://www.miit.gov.cn/a.htm",
      title: "工业和信息化部关于印发工业互联网行动计划的通知",
      text: `工业和信息化部关于印发工业互联网行动计划的通知\n工信部信发〔2024〕1号\n${bodyWith("工业和信息化部")}`,
      publishedAt: "2024-01-01",
    });
    expect(v.upgrades).toContain("含文号");
    expect(v.authority).toBe("T1");
  });

  it("PDF 原件 → 记升级因子", () => {
    const v = gradeWebSource({
      url: "https://example.com/a.pdf",
      title: "报告",
      text: bodyWith("报告"),
      publishedAt: "2024-01-01",
      contentType: "application/pdf",
    });
    expect(v.upgrades).toContain("PDF原文");
  });
});

describe("extractDocNo", () => {
  it("抽国办发文号", () => {
    expect(extractDocNo("国办发〔2017〕47号 政府网站发展指引")).toBe("国办发〔2017〕47号");
  });

  it("抽国家标准号", () => {
    expect(extractDocNo("GB/T 22239-2019 信息安全技术")).toBe("GB/T 22239-2019");
  });

  it("抽不带 T 的 GB 号", () => {
    expect(extractDocNo("GB 50311-2016 综合布线")).toBe("GB 50311-2016");
  });

  it("抽 SEC Accession Number", () => {
    expect(extractDocNo("Accession Number 0001234567-24-000001")).toBe("Accession Number 0001234567-24-000001");
  });

  it("没有文号返回 null", () => {
    expect(extractDocNo("一段普通正文")).toBeNull();
  });
});

describe("extractReprintSource", () => {
  it("抽「来源：X」", () => {
    expect(extractReprintSource("来源：新华社\n正文")).toBe("新华社");
  });

  it("抽「本文转自 X」", () => {
    expect(extractReprintSource("本文转自 人民日报")).toBe("人民日报");
  });

  it("没有返回 null", () => {
    expect(extractReprintSource("普通正文")).toBeNull();
  });
});

describe("authorityOfCategory", () => {
  it("与现有映射一致", () => {
    expect(authorityOfCategory("法规标准")).toBe("T1");
    expect(authorityOfCategory("政府文件")).toBe("T1");
    expect(authorityOfCategory("厂商官方")).toBe("T2");
    expect(authorityOfCategory("年报公告")).toBe("T2");
    expect(authorityOfCategory("行业报告")).toBe("T2");
    expect(authorityOfCategory("媒体")).toBe("T3");
    expect(authorityOfCategory("自媒体")).toBe("T4");
    expect(authorityOfCategory("未知")).toBe("T4");
  });
});
