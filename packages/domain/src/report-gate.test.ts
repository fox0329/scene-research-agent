import { describe, it, expect } from "vitest";
import { reportChapterHeading, reportChapters, type ReportSection } from "@scene/contract";
import { checkReport, reportChapterHeadings } from "./report-gate.js";

/** 一节的样板正文：带什么构件就写什么（模拟模型照要求作答） */
function sectionBody(sec: ReportSection): string {
  const arts = sec.artifacts ?? [];
  const parts = [`这是${sec.title}的归纳正文。`];
  if (arts.includes("table")) {
    parts.push("| 层次 | 组成 | 作用 |\n|---|---|---|\n| 主链 | PLC | 控制闭环 |");
  }
  if (arts.includes("numbered-connections")) parts.push("① 仪表 → 网关；② 网关 → 平台。");
  if (arts.includes("principles")) parts.push("原则一 不替代原系统；原则二 不参与安全联锁。");
  if (arts.includes("value-table"))
    parts.push(
      "| 价值 | 现在 | 采用后 | 怎么核 |\n|---|---|---|---|\n" +
        "| 价值一：会前就绪 | 提前 5–10 分钟接线 | 碰一碰秒级就绪 | 预约时间与就绪时间戳差 |\n" +
        "| 价值二：离场释放 | 占而不用 | 自动释放 | 按月比对预约与实际通电 |\n" +
        "| 价值三：故障改远程 | 靠报修到场 | 远程监控与 OTA | 工单上门次数对比 |",
    );
  return parts.join("\n\n");
}

/** 章节齐全、构件齐全的样板报告（只有一份「解决方案」，变更表 #136） */
function goodReport(extra = ""): string {
  const chapters = reportChapters().map((c) => {
    const body = c.sections.map((sec) => `### ${sec.title}\n\n${sectionBody(sec)}`).join("\n\n");
    return [`## ${reportChapterHeading(c.key)}`, "", body].join("\n");
  });
  return chapters.join("\n\n") + extra;
}

describe("报告确定性校验（变更表 #112 / #113）", () => {
  it("章节齐 + 方案构件齐 → 通过（五章：现状 / 场景与问题 / 方案 / 价值 / 下一步）", () => {
    const r = checkReport(goodReport());
    expect(r.ok).toBe(true);
    expect(r.chapters.length).toBe(reportChapters().length);
    expect(reportChapters().map((c) => c.label)).toEqual([
      "现状",
      "场景与问题",
      "方案",
      "价值",
      "下一步",
    ]);
  });

  it("缺章是硬伤（模型漏写一章不能就这么交付）", () => {
    const text = goodReport().replace("## 价值", "## 随便写点什么");
    const r = checkReport(text);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.kind === "缺章" && v.hard)).toBe(true);
  });

  it("章节齐但没长出方案构件（没有自建表 / 没设计原则 / 没边界）→ 硬伤", () => {
    // 只留章节标题与小节名，构件全无
    const text = reportChapters()
      .map((c) => {
        const body = c.sections.map((sec) => `### ${sec.title}\n\n正文。`).join("\n\n");
        return `## ${reportChapterHeading(c.key)}\n\n${body}`;
      })
      .join("\n\n");
    const r = checkReport(text);
    expect(r.ok).toBe(false);
    const v = r.violations.find((x) => x.kind === "缺少方案构件");
    expect(v?.hard).toBe(true);
    expect(v?.detail).toContain("自建表格");
    expect(v?.detail).toContain("设计原则");
  });

  it("出现决策建议是硬伤（产品只给事实，决定权在用户）", () => {
    const r = checkReport(goodReport("\n\n我方建议优先投入试点。"));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.kind === "出现决策建议")).toBe(true);
  });

  it("「下一步（步骤与交付物）」不算决策建议", () => {
    const r = checkReport(goodReport("\n\n下一步：现场勘察 → 单站试点 → 指标对标。"));
    expect(r.violations.some((v) => v.kind === "出现决策建议")).toBe(false);
  });

  it("对外材料出现内部表号 / 来源 / 证据级 → 硬伤", () => {
    for (const leak of ["见 表3-8", "来源：客户台账", "证据级 A", "信息缺口 3 条", "ingest-123-4.pdf"]) {
      const r = checkReport(goodReport(`\n\n参考资料 ${leak}`));
      expect(r.ok, leak).toBe(false);
      expect(r.violations.some((v) => v.kind === "对外泄漏内部信息"), leak).toBe(true);
    }
  });

  it("「能力缺口」是正当说法，不算对外泄漏（只有信息缺口这类内部口径才算）", () => {
    const r = checkReport(goodReport("\n\n主要缺口在算法与软件，需与伙伴配合。"));
    expect(r.violations.some((v) => v.kind === "对外泄漏内部信息")).toBe(false);
  });

  it("正文用「一、二、」当条目编号 → 只提示（会和章号混淆）", () => {
    const r = checkReport(goodReport("\n\n**二、按预约自动就绪、离场自动释放。** 减少占而不用。"));
    const v = r.violations.find((x) => x.kind === "正文用了章号式编号");
    expect(v?.hard).toBe(false);
    // 章标题本身是 `## 二、…`，不算正文编号
    expect(v?.detail).toContain("1 处");
  });

  it("篇幅超标只提示（要精要，不要流水账）", () => {
    const long = goodReport() + "\n\n" + "补充废话。".repeat(1000);
    const v = checkReport(long).violations.find((x) => x.kind === "篇幅超标");
    expect(v?.hard).toBe(false);
    expect(v?.detail).toContain("超过");
  });

  it("篇幅按正文字数算：表格再长也不算流水账", () => {
    const rows = Array.from({ length: 400 }, (_, i) => `| 行${i} | 说明${i} |`).join("\n");
    const md = `${goodReport()}\n\n| 序号 | 连接 |\n|---|---|\n${rows}\n`;
    expect(checkReport(md).violations.some((v) => v.kind === "篇幅超标")).toBe(false);
  });

  it("原则写成「### 设计原则 + 条目」（没有原则一/二编号）也算构件齐全", () => {
    const md = goodReport().replace("原则一 不替代原系统；原则二 不参与安全联锁。", "- 辅助不替代\n- 能接的接、不能接的明说");
    const v = checkReport(md).violations.find((x) => x.kind === "缺少方案构件");
    expect(v).toBeUndefined();
  });

  it("价值章逐条写「待补/未提供」→ 硬伤（那是缺口清单，不是价值）", () => {
    const bad = goodReport().replace("| 预约时间与就绪时间戳差 |", "| 本客户基线未提供 |")
      .replace("| 按月比对预约与实际通电 |", "| 本客户基线未提供 |")
      .replace("| 工单上门次数对比 |", "| 本客户基线未提供 |");
    const v = checkReport(bad).violations.find((x) => x.kind === "价值写成缺口清单");
    expect(v?.hard).toBe(true);
  });

  it("价值章只在章末交代一次基线 → 不算缺口清单", () => {
    const ok = goodReport().replace(
      "价值一 ……度量口径：单次巡检人天。",
      "价值一：采用后现场巡检减少。现在：靠人工巡检。（怎么核：巡检人天）\n" +
        "本客户基线未提供，以上为行业通例量级。",
    );
    const r = checkReport(ok);
    expect(r.violations.some((x) => x.kind === "价值写成缺口清单")).toBe(false);
  });

  it("篇幅不足只提示，不当硬伤", () => {
    const v = checkReport(goodReport()).violations.find(
      (x) => x.kind === "篇幅不足",
    );
    expect(v?.hard).toBe(false);
  });

  it("章名识别忽略序号与多余空格", () => {
    expect(reportChapterHeadings("## 一、现状 \n### 小节\n## 方案")).toEqual(["现状", "方案"]);
    expect(reportChapterHeadings("## 现状\n## 场景与问题")).toEqual(["现状", "场景与问题"]);
  });
});
