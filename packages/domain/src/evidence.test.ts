import { describe, it, expect } from "vitest";
import {
  gradeAnalysisEvidence,
  gradeSource,
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
