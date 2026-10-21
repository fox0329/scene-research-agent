import { describe, expect, it } from "vitest";
import {
  ABSOLUTE_TERMS,
  classifyLibrarySource,
  downgradeLibraryEvidence,
  findAbsoluteTerms,
  gradeIncomingEvidence,
} from "./library-standard.js";

describe("资料库入库标准（领域层共享口径）", () => {
  it("自媒体来源判 T4 且低权威；厂商文档判 T2", () => {
    const wechat = classifyLibrarySource("https://mp.weixin.qq.com/s/abc");
    expect(wechat.authority).toBe("T4");
    expect(wechat.lowAuthority).toBe(true);

    const vendor = classifyLibrarySource("在鸿工控机CT21B产品手册.docx:1", "在鸿工控机CT21B产品手册.docx");
    expect(vendor.authority).toBe("T2");
    expect(vendor.lowAuthority).toBe(false);
  });

  it("绝对化词表只此一份，命中按词表顺序去重", () => {
    expect(ABSOLUTE_TERMS).toContain("100%");
    expect(findAbsoluteTerms("100% 覆盖所有人脸识别场景")).toEqual(["100%"]);
    expect(findAbsoluteTerms("行业第一且彻底解决")).toEqual(["行业第一", "彻底解决"]);
    expect(findAbsoluteTerms(null)).toEqual([]);
    expect(findAbsoluteTerms({ a: "100%" })).toEqual([]);
  });

  it("新导入：低权威或绝对化 → C，普通厂商材料 → B", () => {
    expect(gradeIncomingEvidence("白皮书.pdf:12", "白皮书.pdf", [])).toBe("B");
    expect(gradeIncomingEvidence("白皮书.pdf:12", "白皮书.pdf", ["100%"])).toBe("C");
    expect(gradeIncomingEvidence("https://zhihu.com/p/1", "", [])).toBe("C");
  });

  it("存量降级：T4 的 A/B → C，D 保留；绝对化 C 不洗白 D；已是 C 不动", () => {
    expect(downgradeLibraryEvidence("B", { lowAuthority: true, absoluteHit: false })).toBe("C");
    expect(downgradeLibraryEvidence("A", { lowAuthority: true, absoluteHit: false })).toBe("C");
    expect(downgradeLibraryEvidence("C", { lowAuthority: true, absoluteHit: false })).toBe("C");
    expect(downgradeLibraryEvidence("D", { lowAuthority: true, absoluteHit: false })).toBe("D");
    expect(downgradeLibraryEvidence("B", { lowAuthority: false, absoluteHit: true })).toBe("C");
    expect(downgradeLibraryEvidence("D", { lowAuthority: false, absoluteHit: true })).toBe("D");
    expect(downgradeLibraryEvidence("B", { lowAuthority: false, absoluteHit: false })).toBe("B");
    expect(downgradeLibraryEvidence(null, { lowAuthority: true, absoluteHit: false })).toBeNull();
  });
});
