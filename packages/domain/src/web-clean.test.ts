import { describe, it, expect } from "vitest";
import { stripBoilerplate, extractPublishedAt } from "./web-clean.js";

/** 真实政府页面的开头（实测抓回来的形态，导航与元数据混在一起） */
const GOV_HEAD = [
  "国务院关于印发“十四五”数字经济发展规划的通知_国务院文件_中国政府网",
  "首页",
  "- |",
  "- 简",
  "- 繁",
  "- EN",
  "- 登录",
  "- 个人中心",
  "- 退出",
  "- |",
  "- 邮箱",
  "- |",
  "- 无障碍",
  "javascript:;",
  "https://www.gov.cn/",
  "首页（https://www.gov.cn/） > 政策（https://www.gov.cn/zhengce/） > 国务院政策文件库（https://www.gov.cn/zhengce/zhengcewenjianku/） > 国务院文件",
  "字号：默认",
  "打印",
  "收藏",
  "|",
  "2022-01-12 16:55:00",
  "# 索  引  号：",
  "000014349/2021-00139",
  "# 发文机关：",
  "国务院",
  "# 发文字号：",
  "国发〔2021〕29号",
  "# 发布日期：",
  "2022年01月12日",
  "",
  "各省、自治区、直辖市人民政府：",
  "",
  "现将《“十四五”数字经济发展规划》印发给你们，请认真贯彻执行。",
].join("\n");

describe("stripBoilerplate — 去框架", () => {
  it("去掉导航菜单（实测块1就是这些）", () => {
    const out = stripBoilerplate(GOV_HEAD);
    expect(out).not.toContain("- 登录");
    expect(out).not.toContain("- 个人中心");
    expect(out).not.toContain("首页");
  });

  it("去掉面包屑", () => {
    const out = stripBoilerplate(GOV_HEAD);
    expect(out).not.toContain("国务院政策文件库（https://");
  });

  it("去掉工具栏与空链接占位", () => {
    const out = stripBoilerplate(GOV_HEAD);
    expect(out).not.toContain("字号：默认");
    expect(out).not.toContain("javascript:;");
    expect(out).not.toContain("收藏");
  });

  it("去掉孤立 URL 与纯时间戳", () => {
    const out = stripBoilerplate(GOV_HEAD);
    expect(out).not.toMatch(/^https:\/\/www\.gov\.cn\/$/m);
    expect(out).not.toContain("16:55:00");
  });

  it("去掉纯符号行", () => {
    const out = stripBoilerplate("正文\n\n- |\n\n---\n\n·\n\n结尾");
    expect(out).toBe("正文\n\n结尾");
  });
});

describe("stripBoilerplate — 留内容", () => {
  it("元数据值被留下且与标签合成一行（否则发文字号会丢）", () => {
    const out = stripBoilerplate(GOV_HEAD);
    expect(out).toContain("发文字号：国发〔2021〕29号");
    expect(out).toContain("发布日期：2022年01月12日");
    expect(out).toContain("索引号：000014349/2021-00139".replace("索引号", "索  引  号"));
  });

  it("元数据行不再带 # 标题标记（否则会被切成空节而丢块）", () => {
    const out = stripBoilerplate(GOV_HEAD);
    expect(out).not.toMatch(/^#{1,4}\s+索/u);
  });

  it("正文段落原样保留", () => {
    const out = stripBoilerplate(GOV_HEAD);
    expect(out).toContain("现将《“十四五”数字经济发展规划》印发给你们，请认真贯彻执行。");
  });

  it("真正的标题保留", () => {
    const out = stripBoilerplate("# 第一章 总则\n\n正文内容");
    expect(out).toBe("# 第一章 总则\n\n正文内容");
  });

  it("空正文 → 空串", () => {
    expect(stripBoilerplate("")).toBe("");
    expect(stripBoilerplate("   \n\n  ")).toBe("");
  });

  it("连续空行压成一个", () => {
    expect(stripBoilerplate("A\n\n\n\n\nB")).toBe("A\n\nB");
  });

  it("只有框架没有内容 → 空串（入库层据此拒收）", () => {
    expect(stripBoilerplate("首页\n- 登录\n打印\njavascript:;")).toBe("");
  });
});

describe("extractPublishedAt", () => {
  it("发布日期优先于成文日期（政府页两个都有，且成文日期在前）", () => {
    const text = ["成文日期：2021年12月12日", "发文字号：国发〔2021〕29号", "发布日期：2022年01月12日"].join("\n");
    expect(extractPublishedAt(text)).toBe("2022-01-12");
  });

  it("只有成文日期时用成文日期", () => {
    expect(extractPublishedAt("成文日期：2021年12月12日")).toBe("2021-12-12");
  });

  it("认多分隔符格式", () => {
    expect(extractPublishedAt("发布时间: 2024/3/7")).toBe("2024-03-07");
    expect(extractPublishedAt("发布日期：2024.03.07")).toBe("2024-03-07");
    expect(extractPublishedAt("published 2024-03-07")).toBe("2024-03-07");
  });

  it("无关键词时在正文前部找裸日期", () => {
    expect(extractPublishedAt("2024年3月7日，我司发布新品。")).toBe("2024-03-07");
  });

  it("裸日期只在正文前 3000 字里找（避免抓到正文中的历史日期）", () => {
    const text = "无关内容".repeat(1000) + " 2019年5月1日 ";
    expect(extractPublishedAt(text)).toBe("");
  });

  it("拒掉不存在的日期（2月30日）", () => {
    expect(extractPublishedAt("发布日期：2024年2月30日")).toBe("");
  });

  it("抽不到返回空串", () => {
    expect(extractPublishedAt("没有日期的正文")).toBe("");
    expect(extractPublishedAt("")).toBe("");
  });
});
