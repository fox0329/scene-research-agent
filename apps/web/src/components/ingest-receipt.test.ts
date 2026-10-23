/**
 * @scene/web — 入库回执测试（变更表 #210）
 *
 * 重点不是文案好不好看，而是**0 行的文件必须被点名、且不被重复计算**：
 * 这是「上传 3 个文件、列表只有 2 个」这种对不上账的情况唯一的出口。
 */

import { describeUploadOutcome } from "./ingest-receipt";
import { describe, expect, it } from "vitest";
import { buildIngestReceipt, fileResultLine, type FileIngestResult } from "./ingest-receipt.js";

const ok = (name: string, rows: number): FileIngestResult => ({ name, rows, failed: false });

describe("buildIngestReceipt — 0 行文件要点名", () => {
  it("三个文件里有一个 0 行：点它的名，且只点它", () => {
    const receipt = buildIngestReceipt(
      [ok("白皮书.docx", 145), ok("产品介绍.pptx", 0), ok("规格参数表.xlsx", 77)],
      { M1: 8, M2: 111 },
    );

    expect(receipt.emptyFiles).toEqual(["产品介绍.pptx"]);
    expect(receipt.emptyLine).toContain("1 个文件未产出可校验记录");
    expect(receipt.emptyLine).toContain("产品介绍.pptx");
    expect(receipt.emptyLine).not.toContain("白皮书.docx");
    expect(receipt.totalRows).toBe(222);
  });

  it("没有 0 行文件时不占一行（emptyLine 为 null）", () => {
    const receipt = buildIngestReceipt([ok("a.docx", 3), ok("b.xlsx", 4)], {});
    expect(receipt.emptyFiles).toEqual([]);
    expect(receipt.emptyLine).toBeNull();
  });

  it("已报错的文件不进 0 行名单（同一件事只说一遍）", () => {
    const receipt = buildIngestReceipt(
      [ok("好文件.docx", 10), { name: "坏文件.pptx", rows: 0, failed: true }],
      {},
    );

    expect(receipt.emptyFiles).toEqual([]);
    expect(receipt.emptyLine).toBeNull();
    expect(receipt.failedCount).toBe(1);
    expect(receipt.doneLine).toContain("失败 1 个");
  });

  it("全部文件都是 0 行：照样点名两个（最坏情况也不能沉默）", () => {
    const receipt = buildIngestReceipt([ok("x.pptx", 0), ok("y.pptx", 0)], {});
    expect(receipt.emptyFiles).toEqual(["x.pptx", "y.pptx"]);
    expect(receipt.emptyLine).toContain("2 个文件未产出可校验记录");
    expect(receipt.totalRows).toBe(0);
  });
});

describe("buildIngestReceipt — 文案口径", () => {
  it("完成行按文件数报，并带上每表行数与失败数", () => {
    const receipt = buildIngestReceipt(
      [ok("白皮书.docx", 145), ok("规格参数表.xlsx", 77)],
      { M2: 81, M1: 8 },
    );
    expect(receipt.doneLine).toBe("【完成】2 个文件 · 共入库 222 行（规格书×81、产品清单×8）");
  });

  it("表号显示为中文名，O3 价格类别不再出现在回执里", () => {
    const receipt = buildIngestReceipt([ok("报价单.pdf", 2)], { M6: 1, O3: 1 });
    expect(receipt.doneLine).toContain("报价×1");
    expect(receipt.doneLine).not.toContain("O3");
  });

  it("没有每表计数时不出现空括号", () => {
    const receipt = buildIngestReceipt([ok("a.docx", 5)], {});
    expect(receipt.doneLine).toBe("【完成】1 个文件 · 共入库 5 行");
    expect(receipt.toast).toBe("解析完成：入库 5 行");
  });

  it("toast 同时提 0 行数与失败数", () => {
    const receipt = buildIngestReceipt(
      [ok("a.docx", 7), ok("b.pptx", 0), { name: "c.pdf", rows: 0, failed: true }],
      { M1: 7 },
    );
    expect(receipt.toast).toBe("解析完成：入库 7 行（产品清单×7），1 个文件 0 行 · 失败 1 个");
  });
});

describe("buildIngestReceipt — 质量行（证据分布与冲突）", () => {
  const quality = {
    evidenceSummary: { A: 0, B: 18, C: 3, D: 0 },
    flaggedRows: [
      { table_code: "M3", key: "视频监控/人脸识别", field: "description", term: "100%" },
      { table_code: "M2", key: "IPC-3000/计算/CPU", field: "value", term: "最强" },
    ],
    conflicts: [
      {
        table_code: "M2",
        key: "IPC-3000/计算/CPU",
        existing: "4核 ARM",
        incoming: "8核 ARM",
        source: "新规格书.pdf:7",
      },
      {
        table_code: "M4",
        key: "不承担第三方云平台对接",
        existing: "无 SDK 支持",
        incoming: "商务原因",
        source: "会议纪要.docx:3",
      },
    ],
    skippedRows: [
      { table_code: "M5", source: "材料.pdf:未知", reason: "来源不可定位（缺少页码/章节）：材料.pdf:未知" },
    ],
  };

  it("qualityLine 含证据分布、夸大措辞行数、冲突数与被挡行数", () => {
    const receipt = buildIngestReceipt([ok("a.docx", 21)], { M2: 18, M3: 3 }, quality);

    expect(receipt.qualityLine).toContain("B 18 行");
    expect(receipt.qualityLine).toContain("C 3 行");
    expect(receipt.qualityLine).toContain("夸大措辞 2 行");
    expect(receipt.qualityLine).toContain("低权威来源 1 行");
    expect(receipt.qualityLine).toContain("冲突 2 条未覆盖");
    expect(receipt.qualityLine).toContain("被挡 1 行");
  });

  it("qualityLine 声明系统保证边界：可溯源可分级冲突可见，但不保证内容真伪", () => {
    const receipt = buildIngestReceipt([ok("a.docx", 21)], {}, quality);
    expect(receipt.qualityLine).toContain("系统保证可溯源、可分级、冲突可见");
    expect(receipt.qualityLine).toContain("材料本身真伪仍需交叉核验");
  });

  it("没有质量数据时不编造数字：明说暂无入库行、冲突与被挡都是 0", () => {
    const receipt = buildIngestReceipt([ok("a.docx", 0)], {});
    expect(receipt.qualityLine).toContain("暂无入库行");
    expect(receipt.qualityLine).toContain("冲突 0 条未覆盖");
    expect(receipt.qualityLine).toContain("被挡 0 行");
  });
});

describe("buildIngestReceipt — 0 行的具体原因", () => {
  it("模型空返回/坏 JSON 要带原因，不能再写成「材料没有信息」", () => {
    const receipt = buildIngestReceipt(
      [
        {
          name: "CT34.docx",
          rows: 0,
          failed: false,
          note: "模型没有返回内容（可能临时不可用，请重试）",
        },
      ],
      {},
    );
    expect(receipt.emptyLine).toContain("CT34.docx");
    expect(receipt.emptyLine).toContain("模型没有返回内容");
    expect(receipt.emptyLine).toContain("可直接重新上传重试");
    expect(receipt.emptyLine).not.toContain("没有可归入资料库表格的信息");
  });
});

describe("fileResultLine — 单文件进度行", () => {
  it("有行数就报行数", () => {
    expect(fileResultLine(ok("a.docx", 145))).toBe("　→ 入库 145 行");
  });

  it("0 行明确写成「未产出可校验记录」，不是空白也不是 0", () => {
    expect(fileResultLine(ok("a.pptx", 0))).toBe("　→ 0 行（未产出可校验记录）");
  });

  it("失败的文件不再补一行（错误行已经说过了）", () => {
    expect(fileResultLine({ name: "a.pdf", rows: 0, failed: true })).toBeNull();
  });
});


describe("describeUploadOutcome — 对话内上传结果（#326）", () => {
  it("新增行数就报新增", () => {
    expect(describeUploadOutcome("CT31.docx", 31, 31)).toContain("新增 31 行");
  });

  it("有冲突时说明保留原值，不让用户以为被覆盖", () => {
    const text = describeUploadOutcome("CT31.docx", 3, 46, "", 14);
    expect(text).toContain("新增 3 行");
    expect(text).toContain("14 条");
    expect(text).toContain("保留原值");
  });

  it("0 行但识别到内容：说明是去重，不是空文件", () => {
    const text = describeUploadOutcome("CT31.docx", 0, 31);
    expect(text).toContain("识别 31 行");
    expect(text).toContain("已有这些内容");
    expect(text).toContain("去重");
    expect(text).not.toContain("没有识别到");
  });

  it("0 行且没识别到：说明可重试或补录，并带模型原因", () => {
    const text = describeUploadOutcome("CT31.docx", 0, 0, "模型没有返回内容");
    expect(text).toContain("没有识别到可入库");
    expect(text).toContain("模型没有返回内容");
    expect(text).toContain("重试");
  });
});
