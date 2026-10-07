import { describe, it, expect } from "vitest";
import {
  reportChapterHeading,
  reportChaptersOf,
  type ReportKind,
  type ReportSection,
} from "@scene/contract";
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
  if (arts.includes("value-with-metric")) parts.push("价值一 ……度量口径：单次巡检人天。");
  if (arts.includes("boundary")) parts.push("边界：不做安全联锁，不承担 SIS 职责。");
  return parts.join("\n\n");
}

/** 章节齐全、构件齐全的样板报告 */
function goodReport(kind: ReportKind, extra = ""): string {
  const chapters = reportChaptersOf(kind).map((c) => {
    const body = c.sections.map((sec) => `### ${sec.title}\n\n${sectionBody(sec)}`).join("\n\n");
    return `## ${reportChapterHeading(kind, c.key)}\n\n${body}`;
  });
  const glossary =
    kind === "internal" ? "## 附录 B、术语表" : "## 附录、术语表";
  return [
    ...chapters,
    `${glossary}\n\n| 术语 | 说明 |\n|---|---|\n| 门槛 | 进场的前置条件 |`,
  ].join("\n\n") + extra;
}

describe("报告确定性校验（变更表 #112 / #113）", () => {
  it("章节齐 + 方案构件齐 → 通过（对外 5 章 / 内部 6 章）", () => {
    const ext = checkReport("external", goodReport("external"));
    expect(ext.ok).toBe(true);
    // 5 章 + 术语表（对外没有「客观与风险」）
    expect(ext.chapters.length).toBe(reportChaptersOf("external").length + 1);
    const int = checkReport("internal", goodReport("internal"));
    expect(int.ok).toBe(true);
    expect(int.chapters.length).toBe(reportChaptersOf("internal").length + 1);
  });

  it("缺章是硬伤（模型漏写一章不能就这么交付）", () => {
    const text = goodReport("internal").replace("## 四、价值", "## 四、随便写点什么");
    const r = checkReport("internal", text);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.kind === "缺章" && v.hard)).toBe(true);
  });

  it("章节齐但没长出方案构件（没有自建表 / 没设计原则 / 没边界）→ 硬伤", () => {
    // 只留章节标题与小节名，构件全无
    const text = reportChaptersOf("external")
      .map((c) => {
        const body = c.sections.map((sec) => `### ${sec.title}\n\n正文。`).join("\n\n");
        return `## ${reportChapterHeading("external", c.key)}\n\n${body}`;
      })
      .join("\n\n");
    const r = checkReport("external", text);
    expect(r.ok).toBe(false);
    const v = r.violations.find((x) => x.kind === "缺少方案构件");
    expect(v?.hard).toBe(true);
    expect(v?.detail).toContain("自建表格");
    expect(v?.detail).toContain("设计原则");
  });

  it("出现决策建议是硬伤（产品只给事实，决定权在用户）", () => {
    const r = checkReport("internal", goodReport("internal", "\n\n我方建议优先投入试点。"));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.kind === "出现决策建议")).toBe(true);
  });

  it("「下一步（步骤与交付物）」不算决策建议", () => {
    const r = checkReport("external", goodReport("external", "\n\n下一步：现场勘察 → 单站试点 → 指标对标。"));
    expect(r.violations.some((v) => v.kind === "出现决策建议")).toBe(false);
  });

  it("对外材料出现内部表号 / 来源 / 证据级 → 硬伤", () => {
    for (const leak of ["见 表3-8", "来源：客户台账", "证据级 A", "信息缺口 3 条", "ingest-123-4.pdf"]) {
      const r = checkReport("external", goodReport("external", `\n\n参考资料 ${leak}`));
      expect(r.ok, leak).toBe(false);
      expect(r.violations.some((v) => v.kind === "对外泄漏内部信息"), leak).toBe(true);
    }
  });

  it("「能力缺口」是正当说法，不算对外泄漏（只有信息缺口这类内部口径才算）", () => {
    const r = checkReport("external", goodReport("external", "\n\n主要缺口在算法与软件，需与伙伴配合。"));
    expect(r.violations.some((v) => v.kind === "对外泄漏内部信息")).toBe(false);
  });

  it("同样的内部痕迹放在内部版不算违规（内部版本来就带来源与核实）", () => {
    const r = checkReport("internal", goodReport("internal", "\n\n见表3-8，来源：客户台账；证据级 A。"));
    expect(r.violations.some((v) => v.kind === "对外泄漏内部信息")).toBe(false);
  });

  it("正文用「一、二、」当条目编号 → 只提示（会和章号混淆）", () => {
    const r = checkReport(
      "external",
      goodReport("external", "\n\n**二、按预约自动就绪、离场自动释放。** 减少占而不用。"),
    );
    const v = r.violations.find((x) => x.kind === "正文用了章号式编号");
    expect(v?.hard).toBe(false);
    // 章标题本身是 `## 二、…`，不算正文编号
    expect(v?.detail).toContain("1 处");
  });

  it("缺术语表只提示不拦（附录不该拖住整份报告）", () => {
    const text = goodReport("external").replace("## 附录、术语表", "## 附录、说明");
    const r = checkReport("external", text);
    expect(r.violations.find((v) => v.kind === "缺术语表")?.hard).toBe(false);
  });

  it("篇幅超标只提示（要精要，不要流水账）", () => {
    const long = goodReport("external") + "\n\n" + "补充废话。".repeat(1000);
    const v = checkReport("external", long).violations.find((x) => x.kind === "篇幅超标");
    expect(v?.hard).toBe(false);
    expect(v?.detail).toContain("超过");
  });

  it("篇幅按正文字数算：表格再长也不算流水账", () => {
    const rows = Array.from({ length: 400 }, (_, i) => `| 行${i} | 说明${i} |`).join("\n");
    const md = `${goodReport("external")}\n\n| 序号 | 连接 |\n|---|---|\n${rows}\n`;
    expect(checkReport("external", md).violations.some((v) => v.kind === "篇幅超标")).toBe(false);
  });

  it("原则写成「### 设计原则 + 条目」（没有原则一/二编号）也算构件齐全", () => {
    const md = goodReport("external").replace(
      "原则一：只做会场设备侧。",
      "### 设计原则\n\n- 辅助不替代\n- 能接的接、不能接的明说\n",
    );
    const v = checkReport("external", md).violations.find((x) => x.kind === "缺少方案构件");
    expect(v).toBeUndefined();
  });

  it("价值章逐条写「待补/未提供」→ 硬伤（那是缺口清单，不是价值）", () => {
    const bad = goodReport("external").replace(
      "价值一 ……度量口径：单次巡检人天。",
      "价值一：省人。度量口径是巡检人天。本客户基线未提供。\n" +
        "价值二：省电。本客户分项计量未提供。\n价值三：少上门。本客户工单未提供。",
    );
    const v = checkReport("external", bad).violations.find((x) => x.kind === "价值写成缺口清单");
    expect(v?.hard).toBe(true);
  });

  it("价值章只在章末交代一次基线 → 不算缺口清单", () => {
    const ok = goodReport("external").replace(
      "价值一 ……度量口径：单次巡检人天。",
      "价值一：采用后现场巡检减少。现在：靠人工巡检。（怎么核：巡检人天）\n" +
        "本客户基线未提供，以上为行业通例量级。",
    );
    const r = checkReport("external", ok);
    expect(r.violations.some((x) => x.kind === "价值写成缺口清单")).toBe(false);
  });

  it("篇幅不足只提示，不当硬伤", () => {
    const v = checkReport("external", goodReport("external")).violations.find(
      (x) => x.kind === "篇幅不足",
    );
    expect(v?.hard).toBe(false);
  });

  it("章名识别忽略序号与多余空格", () => {
    expect(reportChapterHeadings("## 一、现状 \n### 小节\n## 方案")).toEqual(["现状", "方案"]);
  });
});
