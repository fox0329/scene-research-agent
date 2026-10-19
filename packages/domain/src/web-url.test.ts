import { describe, it, expect } from "vitest";
import {
  normalizeUrl,
  urlKey,
  registeredDomain,
  slugify,
  snapshotFileName,
  isBareUrlCitation,
  isHttpUrl,
} from "./web-url.js";

describe("isHttpUrl", () => {
  it("认 http/https", () => {
    expect(isHttpUrl("https://a.com/x")).toBe(true);
    expect(isHttpUrl("http://a.com")).toBe(true);
  });

  it("不认其他协议与空串", () => {
    expect(isHttpUrl("ftp://a.com")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
    expect(isHttpUrl("a.com/x")).toBe(false);
  });
});

describe("normalizeUrl", () => {
  it("去 fragment、去追踪参数、参数排序、去尾斜杠", () => {
    const u = "https://WWW.Example.com:443/A/b/?utm_source=x&b=2&a=1&gclid=y#frag";
    expect(normalizeUrl(u)).toBe("https://www.example.com/A/b?a=1&b=2");
  });

  it("同一页面的不同追踪参数 → 同一结果（去重的基础）", () => {
    const a = normalizeUrl("https://a.com/p?utm_source=wx&id=1");
    const b = normalizeUrl("https://a.com/p?id=1&utm_medium=email&spm=abc");
    expect(a).toBe(b);
  });

  it("根路径保留斜杠", () => {
    expect(normalizeUrl("https://a.com/")).toBe("https://a.com/");
    expect(normalizeUrl("https://a.com")).toBe("https://a.com/");
  });

  it("非 http(s) 原样返回（不抛错）", () => {
    expect(normalizeUrl("随便一个字符串")).toBe("随便一个字符串");
  });

  it("非法 URL 原样返回（不抛错）", () => {
    expect(normalizeUrl("https://")).toBe("https://");
  });
});

describe("urlKey", () => {
  it("稳定：同 URL 多次同 key", () => {
    expect(urlKey("https://a.com/p?id=1")).toBe(urlKey("https://a.com/p?id=1"));
  });

  it("规范化后相同的 URL 同 key", () => {
    expect(urlKey("https://a.com/p?id=1&utm_source=x")).toBe(urlKey("https://a.com/p?id=1"));
  });

  it("不同页面不同 key", () => {
    expect(urlKey("https://a.com/p?id=1")).not.toBe(urlKey("https://a.com/p?id=2"));
  });

  it("是 16 位十六进制（可用作短键）", () => {
    expect(urlKey("https://a.com")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("registeredDomain", () => {
  it("取 eTLD+1", () => {
    expect(registeredDomain("https://docs.aws.amazon.com/x")).toBe("amazon.com");
    expect(registeredDomain("https://www.example.com/x")).toBe("example.com");
  });

  it("处理 .gov.cn 这类双段后缀", () => {
    expect(registeredDomain("https://www.miit.gov.cn/x")).toBe("miit.gov.cn");
    expect(registeredDomain("https://www.gov.cn/x")).toBe("gov.cn");
  });

  it("两段域名原样返回", () => {
    expect(registeredDomain("https://a.cn/x")).toBe("a.cn");
  });
});

describe("slugify", () => {
  it("保留中日韩文字、字母、数字，其余变连字符", () => {
    expect(slugify("国务院关于印发“十四五”规划的通知")).toBe("国务院关于印发-十四五-规划的通知");
  });

  it("去掉首尾与重复连字符", () => {
    expect(slugify("--a  b--")).toBe("a-b");
  });

  it("空结果兜底 untitled", () => {
    expect(slugify("///")).toBe("untitled");
  });

  it("按上限截断且不以连字符结尾", () => {
    const s = slugify("一".repeat(100), 10);
    expect(s.length).toBeLessThanOrEqual(10);
    expect(s.endsWith("-")).toBe(false);
  });
});

describe("snapshotFileName", () => {
  /** 现有引用正则：文件名不含 / : # 与空白 */
  const FILE_CITATION_RE = /^[^\s/:#]+[:#][^/\s]+$/;

  it("生成的引用串满足现有 FILE_CITATION_RE", () => {
    const f = snapshotFileName("www.gov.cn", "国务院关于印发十四五数字经济发展规划的通知");
    expect(FILE_CITATION_RE.test(`${f}:12`)).toBe(true);
  });

  it("域名里的点与标题里的斜杠冒号都被处理掉", () => {
    const f = snapshotFileName("docs.aws.amazon.com", "AWS Lambda: 文档/入门");
    expect(f).not.toContain("/");
    expect(f).not.toContain(":");
    expect(FILE_CITATION_RE.test(`${f}:1`)).toBe(true);
  });

  it("同名冲突时追加序号", () => {
    const taken = new Set<string>();
    const a = snapshotFileName("a.com", "标题", taken);
    taken.add(a);
    const b = snapshotFileName("a.com", "标题", taken);
    expect(b).not.toBe(a);
    expect(b).toMatch(/-2\.md$/);
  });

  it("以 .md 结尾", () => {
    expect(snapshotFileName("a.com", "t")).toMatch(/\.md$/);
  });
});

describe("isBareUrlCitation", () => {
  it("裸 URL → true（不可复核，必须降级）", () => {
    expect(isBareUrlCitation("https://www.gov.cn/a.htm")).toBe(true);
  });

  it("快照引用 → false", () => {
    expect(isBareUrlCitation("gov-cn-通知.md:12")).toBe(false);
  });

  it("非 URL → false", () => {
    expect(isBareUrlCitation("白皮书.pdf:3")).toBe(false);
  });

  it("URL 带块号 → false（被规范成快照引用的形态）", () => {
    expect(isBareUrlCitation("https://a.com/x:3")).toBe(false);
  });
});
