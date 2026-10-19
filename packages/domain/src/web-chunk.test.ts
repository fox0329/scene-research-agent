import { describe, it, expect } from "vitest";
import { chunkMarkdown, blocksToText, BLOCK_MAX, BLOCK_MIN } from "./web-chunk.js";

/** 一段足够长的正文 */
function longText(n = 400): string {
  return "这是一段用于测试切块的正文内容。".repeat(Math.ceil(n / 16)).slice(0, n);
}

describe("chunkMarkdown", () => {
  it("空正文 → 无块", () => {
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("   \n\n  ")).toEqual([]);
  });

  it("按标题切节，标题进 heading、不进正文", () => {
    const md = ["# 第一章 总则", "", longText(200), "", "## 第二条", "", longText(200)].join("\n");
    const blocks = chunkMarkdown(md);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(blocks[0]!.heading).toBe("第一章 总则");
    expect(blocks[0]!.text).not.toContain("第一章");
    expect(blocks[1]!.heading).toBe("第二条");
  });

  it("块号从 1 连续递增", () => {
    const md = ["# A", longText(200), "# B", longText(200), "# C", longText(200)].join("\n\n");
    const blocks = chunkMarkdown(md);
    blocks.forEach((b, i) => expect(b.blockNo).toBe(i + 1));
  });

  it("超长段落被强制切，且每块不超上限", () => {
    const md = `# 长文\n\n${longText(3000)}`;
    const blocks = chunkMarkdown(md);
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) expect(b.text.length).toBeLessThanOrEqual(BLOCK_MAX);
  });

  it("强制切优先落在句末标点（不把句子劈开）", () => {
    // 构造 1300 字、句号在 1150 字处
    const sentence = "这是一句话。";
    let md = `# 长文\n\n`;
    md += "短句。".repeat(287); // 861 字
    md += sentence.repeat(40); // 240 字
    const blocks = chunkMarkdown(md);
    // 每个非末块应以句末标点结尾
    for (let i = 0; i < blocks.length - 1; i++) {
      expect(/[。！？；，.!?;]$/.test(blocks[i]!.text)).toBe(true);
    }
  });

  it("同标题下的过短块与相邻块合并", () => {
    const md = ["# 同一节", "", "短。", "", longText(200)].join("\n");
    const blocks = chunkMarkdown(md);
    // 短块被并入，不单独成块
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.text.length).toBeGreaterThan(BLOCK_MIN);
  });

  it("不同标题下的短块不合并（标题是定位信息，不能被吞）", () => {
    const md = ["# 第一节", "", "短。", "", "# 第二节", "", "也短。"].join("\n");
    const blocks = chunkMarkdown(md);
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.heading).toBe("第一节");
    expect(blocks[1]!.heading).toBe("第二节");
  });

  it("记录字符偏移（用于对齐 citations 语义）", () => {
    const md = ["# A", "", longText(200), "", "# B", "", longText(200)].join("\n");
    const blocks = chunkMarkdown(md);
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i]!.charStart).toBeGreaterThan(blocks[i - 1]!.charStart);
    }
    expect(blocks[0]!.charEnd).toBeGreaterThan(blocks[0]!.charStart);
  });

  it("没有标题的正文也能切（引言部分）", () => {
    const blocks = chunkMarkdown(longText(300));
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.heading).toBe("");
  });

  it("CRLF 被规范化（Windows 抓回来的正文）", () => {
    const md = "# A\r\n\r\n" + longText(200).replace(/。/g, "。\r\n");
    const blocks = chunkMarkdown(md);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) expect(b.text).not.toContain("\r");
  });

  it("真实政府文件形态切得合理", () => {
    const md = [
      "# 国务院关于印发十四五数字经济发展规划的通知",
      "",
      "国发〔2021〕29号",
      "",
      "各省、自治区、直辖市人民政府，国务院各部委、各直属机构：",
      "",
      "现将《十四五数字经济发展规划》印发给你们，请认真贯彻执行。",
      "",
      "## 一、发展形势",
      "",
      "数字经济是继农业经济、工业经济之后的主要经济形态，是以数据资源为关键要素，以现代信息网络为主要载体，以信息通信技术融合应用、全要素数字化转型为重要推动力，促进公平与效率更加统一的新经济形态。",
      "",
      "## 二、主要目标",
      "",
      "到2025年，数字经济迈向全面扩展期，数字经济核心产业增加值占GDP比重达到10%。",
    ].join("\n");
    const blocks = chunkMarkdown(md);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    // 文号那块要在，且能定位
    const docNoBlock = blocks.find((b) => b.text.includes("国发〔2021〕29号"));
    expect(docNoBlock).toBeDefined();
  });
});

describe("blocksToText", () => {
  it("能拼回带标题的正文", () => {
    const md = ["# A", "", longText(200), "", "# B", "", longText(200)].join("\n");
    const text = blocksToText(chunkMarkdown(md));
    expect(text).toContain("## A");
    expect(text).toContain("## B");
  });

  it("指定起始块号时只取后面的", () => {
    const md = ["# A", "", longText(200), "", "# B", "", longText(200)].join("\n");
    const blocks = chunkMarkdown(md);
    const from2 = blocksToText(blocks, 2);
    expect(from2).not.toContain("## A");
    expect(from2).toContain("## B");
  });
});
