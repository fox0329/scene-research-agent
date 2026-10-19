import { describe, it, expect } from "vitest";
import {
  gradeAnalysisEvidence,
  gradeSource,
  gradeByCategory,
  gradeSourceByCategory,
  classifySource,
  gradeEvidence,
  verifyCitation,
} from "./evidence.js";
import type { SourceType } from "@scene/contract";

// ─── gradeSource ─────────────────────────────────────────────

describe("gradeSource", () => {
  it("用户补充 → T1 权威（一手信息）", () => {
    expect(gradeSource("用户补充")).toBe("T1");
  });

  it("用户确认 → T2 较权威", () => {
    expect(gradeSource("用户确认")).toBe("T2");
  });

  it("AI提取 → T3 参考", () => {
    expect(gradeSource("AI提取")).toBe("T3");
  });

  it("AI推断 → T4 待验证", () => {
    expect(gradeSource("AI推断")).toBe("T4");
  });

  it("四种来源标记全覆盖（G-R1 四级全产出）", () => {
    const all: SourceType[] = ["用户补充", "用户确认", "AI提取", "AI推断"];
    const results = new Set(all.map(gradeSource));
    expect(results).toEqual(new Set(["T1", "T2", "T3", "T4"]));
  });
});

// ─── gradeEvidence ───────────────────────────────────────────

describe("gradeEvidence", () => {
  it("用户补充 → A（一手信息，直接可验证）", () => {
    expect(gradeEvidence("用户补充", false)).toBe("A");
    expect(gradeEvidence("用户补充", true)).toBe("A");
  });

  it("用户确认 → B", () => {
    expect(gradeEvidence("用户确认", true)).toBe("B");
    expect(gradeEvidence("用户确认", false)).toBe("B");
  });

  it("AI提取 + 已确认 → B（用户确认 + AI 提取）", () => {
    expect(gradeEvidence("AI提取", true)).toBe("B");
  });

  it("AI提取 + 未确认 → C（未经确认按推断对待，不写结论）", () => {
    expect(gradeEvidence("AI提取", false)).toBe("C");
  });

  it("AI推断 + 已确认 → C（仍属架构推断）", () => {
    expect(gradeEvidence("AI推断", true)).toBe("C");
  });

  it("AI推断 + 未确认 → D（无来源佐证，必须删除）", () => {
    expect(gradeEvidence("AI推断", false)).toBe("D");
  });

  it("映射与 G-R2 口径一致（A>B>C>D 可达全覆盖）", () => {
    const combos: Array<[SourceType, boolean]> = [
      ["用户补充", true],
      ["用户确认", true],
      ["AI提取", true],
      ["AI提取", false],
      ["AI推断", true],
      ["AI推断", false],
    ];
    const levels = new Set(combos.map(([t, v]) => gradeEvidence(t, v)));
    expect(levels).toEqual(new Set(["A", "B", "C", "D"]));
  });
});

// ─── verifyCitation ──────────────────────────────────────────

describe("verifyCitation", () => {
  it("文件名:页码 格式合法", () => {
    expect(verifyCitation("规格书.pdf:12")).toBe(true);
    expect(verifyCitation("白皮书:3")).toBe(true);
    expect(verifyCitation("M2规格书.docx:p5")).toBe(true);
  });

  it("文件名#章节 格式合法", () => {
    expect(verifyCitation("白皮书.pdf#3")).toBe(true);
    expect(verifyCitation("年报#第二章")).toBe(true);
  });

  it("URL 格式合法（http/https）", () => {
    expect(verifyCitation("https://example.com/standard/gb4943")).toBe(true);
    expect(verifyCitation("http://www.gb688.cn/bzgkgl/new/stdInfo?no=4258")).toBe(true);
  });

  it("空来源与空白来源作废（G-R0：来源不存在则作废）", () => {
    expect(verifyCitation("")).toBe(false);
    expect(verifyCitation("   ")).toBe(false);
  });

  it("只有文件名没有定位符作废", () => {
    expect(verifyCitation("白皮书.pdf")).toBe(false);
    expect(verifyCitation("规格书")).toBe(false);
  });

  it("定位符为空作废", () => {
    expect(verifyCitation("白皮书.pdf:")).toBe(false);
    expect(verifyCitation("白皮书.pdf#")).toBe(false);
  });

  it("文件名为空作废", () => {
    expect(verifyCitation(":12")).toBe(false);
    expect(verifyCitation("#3")).toBe(false);
  });

  it("非 http(s) 协议前缀作废", () => {
    expect(verifyCitation("ftp://files/doc.pdf")).toBe(false);
    expect(verifyCitation("file:///Users/x/规格书.pdf:1")).toBe(false);
  });

  it("含路径分隔符的文件引用作废（应走 URL 形式）", () => {
    expect(verifyCitation("/abs/path/白皮书.pdf:1")).toBe(false);
    expect(verifyCitation("docs/白皮书.pdf:1")).toBe(false);
  });

  it("含空白的引用作废", () => {
    expect(verifyCitation("白皮书.pdf:1 页")).toBe(false);
    expect(verifyCitation("白皮 书.pdf:1")).toBe(false);
  });

  it("首尾空白被容忍（trim 后校验）", () => {
    expect(verifyCitation("  规格书.pdf:12 ")).toBe(true);
  });

  it("协议残缺作废", () => {
    expect(verifyCitation("https://")).toBe(false);
    expect(verifyCitation("http:/example.com")).toBe(false);
  });
});

describe("gradeAnalysisEvidence — 分析行的证据分级（变更表 #167，用户定调 v1.35）", () => {
  it("用户说的：用户补充 A、用户确认 B", () => {
    expect(gradeAnalysisEvidence("用户补充")).toBe("A");
    expect(gradeAnalysisEvidence("用户确认")).toBe("B");
  });

  it("材料提取：有可定位出处 B（间接有据，与材料入库行同口径）；出处给不出来 C", () => {
    expect(gradeAnalysisEvidence("AI提取", true)).toBe("B");
    expect(gradeAnalysisEvidence("AI提取", false)).toBe("C");
  });

  it("AI 推断一律 C，且任何来源类型都产不出 D（「D 不得入库」只管材料入库）", () => {
    expect(gradeAnalysisEvidence("AI推断")).toBe("C");
    expect(gradeAnalysisEvidence("AI推断", true)).toBe("C");
    const all = (["用户补充", "用户确认", "AI提取", "AI推断"] as const).flatMap((t) => [
      gradeAnalysisEvidence(t),
      gradeAnalysisEvidence(t, true),
    ]);
    expect(all).not.toContain("D");
    expect(new Set(all)).toEqual(new Set(["A", "B", "C"]));
  });
});

// ─── 来源类目分级（G-R1 类目级，变更表 #210） ────────────────

describe("classifySource", () => {
  it("标准号 → 法规标准（GB/ISO/IEC/RFC 等）", () => {
    expect(classifySource("GB/T 22239-2019.pdf:12")).toBe("法规标准");
    expect(classifySource("ISO 27001 认证要求.pdf:3")).toBe("法规标准");
    expect(classifySource("https://www.iso.org/standard/54534.html")).toBe("法规标准");
  });

  it("法规名称 → 法规标准", () => {
    expect(classifySource("数据安全管理办法.docx:5")).toBe("法规标准");
    expect(classifySource("网络安全条例.pdf:1")).toBe("法规标准");
  });

  it("政府域名与机构 → 政府文件", () => {
    expect(classifySource("https://www.miit.gov.cn/zwgk/art/2024.html")).toBe("政府文件");
    expect(classifySource("工业和信息化部 通知.pdf:2")).toBe("政府文件");
  });

  it("交易所与年报 → 年报公告", () => {
    expect(classifySource("https://www.cninfo.com.cn/new/disclosure/1")).toBe("年报公告");
    expect(classifySource("某公司2024年年度报告.pdf:88")).toBe("年报公告");
  });

  it("厂商官方文档 → 厂商官方", () => {
    expect(classifySource("产品规格书.pdf:7")).toBe("厂商官方");
    expect(classifySource("https://docs.example.com/api/v2")).toBe("厂商官方");
  });

  it("咨询机构与行业报告 → 行业报告", () => {
    expect(classifySource("IDC 中国物联网市场预测 2025.pdf:4")).toBe("行业报告");
    expect(classifySource("智慧消防行业报告.pdf:1")).toBe("行业报告");
  });

  it("自媒体平台 → 自媒体（最低权威）", () => {
    expect(classifySource("https://mp.weixin.qq.com/s/abc")).toBe("自媒体");
    expect(classifySource("https://zhuanlan.zhihu.com/p/123")).toBe("自媒体");
    expect(classifySource("https://blog.csdn.net/x/article/details/1")).toBe("自媒体");
  });

  it("用户口述 → 用户自述（没有材料可指）", () => {
    expect(classifySource("用户补充")).toBe("用户自述");
    expect(classifySource("手动录入")).toBe("用户自述");
  });

  it("空串 → 未知", () => {
    expect(classifySource("")).toBe("未知");
    expect(classifySource("   ")).toBe("未知");
  });

  it("文件名里的类目线索也算（source 只有页码时）", () => {
    expect(classifySource("ingest-123.pdf:5", "GB50311-2016 综合布线.pdf")).toBe("法规标准");
  });
});

describe("gradeByCategory", () => {
  it("法规标准/政府文件 → T1", () => {
    expect(gradeByCategory("法规标准")).toBe("T1");
    expect(gradeByCategory("政府文件")).toBe("T1");
  });

  it("厂商官方/年报公告/行业报告 → T2", () => {
    expect(gradeByCategory("厂商官方")).toBe("T2");
    expect(gradeByCategory("年报公告")).toBe("T2");
    expect(gradeByCategory("行业报告")).toBe("T2");
  });

  it("媒体 → T3，自媒体/口述/未知 → T4", () => {
    expect(gradeByCategory("媒体")).toBe("T3");
    expect(gradeByCategory("自媒体")).toBe("T4");
    expect(gradeByCategory("用户自述")).toBe("T4");
    expect(gradeByCategory("未知")).toBe("T4");
  });
});

describe("gradeSourceByCategory（权威性只看依据本身，核实程度归 evidence_level）", () => {
  it("国标材料即使是 AI 提取，也按类目给 T1（依据本身权威）", () => {
    expect(gradeSourceByCategory("AI提取", "GB/T 22239-2019.pdf:12").authority).toBe("T1");
  });

  it("自媒体材料即使是用户补充，也按类目给 T4（不因用户说了就升权威）", () => {
    const r = gradeSourceByCategory("用户补充", "https://mp.weixin.qq.com/s/abc");
    expect(r.authority).toBe("T4");
    expect(r.category).toBe("自媒体");
  });

  it("用户口述没有材料依据 → 退回来源标记（用户补充→T1）", () => {
    expect(gradeSourceByCategory("用户补充", "用户补充").authority).toBe("T1");
  });

  it("AI 推断 + 自媒体 → T4", () => {
    expect(gradeSourceByCategory("AI推断", "https://zhuanlan.zhihu.com/p/1").authority).toBe("T4");
  });

  it("AI 推断即使指向国标也是 T4（推断没有材料依据）", () => {
    expect(gradeSourceByCategory("AI推断", "GB/T 22239-2019.pdf:12").authority).toBe("T4");
  });

  it("未知来源 → 退回标记映射，不误升权威", () => {
    expect(gradeSourceByCategory("AI提取", "").authority).toBe("T3");
  });
});
