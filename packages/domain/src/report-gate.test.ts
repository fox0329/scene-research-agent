import { describe, it, expect } from "vitest";
import {
  reportChapterHeading,
  reportChapters,
  type ReportKind,
  type ReportSection,
} from "@scene/contract";
import {
  checkReport,
  matchChapterKey,
  reportChapterHeadings,
  reportMaxChars,
  reportMinChars,
} from "./report-gate.js";

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

/** 章节齐全、构件齐全的样板报告（按交付物口径生成，变更表 #136 / #137） */
function goodReport(kind: ReportKind, extra = ""): string {
  const chapters = reportChapters(kind).map((c) => {
    const body = c.sections.map((sec) => `### ${sec.title}\n\n${sectionBody(sec)}`).join("\n\n");
    return [`## ${reportChapterHeading(kind, c.key)}`, "", body].join("\n");
  });
  return chapters.join("\n\n") + extra;
}

/** 章节齐但构件全无（只留标题与小节名） */
function bareReport(kind: ReportKind): string {
  return reportChapters(kind)
    .map((c) => {
      const body = c.sections.map((sec) => `### ${sec.title}\n\n正文。`).join("\n\n");
      return `## ${reportChapterHeading(kind, c.key)}\n\n${body}`;
    })
    .join("\n\n");
}

/** 章节齐但漏写某一章（把该章标题换成认不出的写法） */
function withoutChapter(kind: ReportKind, label: string): string {
  return goodReport(kind).replace(`## ${label}`, "## 随便写点什么");
}

/** 违规类型清单（字符串化，便于断言"某类违规不再产生"） */
function kindsOf(kind: ReportKind, markdown: string): string[] {
  return checkReport(kind, markdown).violations.map((v) => v.kind as string);
}

describe("报告确定性校验（变更表 #112 / #113）：solution 口径", () => {
  it("章节齐 + 方案构件齐 → 通过（五章：现状 / 场景与问题 / 方案 / 价值 / 下一步）", () => {
    const r = checkReport("solution", goodReport("solution"));
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("solution");
    expect(r.chapters.length).toBe(reportChapters("solution").length);
    expect(reportChapters("solution").map((c) => c.label)).toEqual([
      "现状",
      "场景与问题",
      "方案",
      "价值",
      "下一步",
    ]);
  });

  it("缺章是硬伤（模型漏写一章不能就这么交付）", () => {
    const r = checkReport("solution", withoutChapter("solution", "价值"));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.kind === "缺章" && v.hard)).toBe(true);
  });

  it("章节齐但没长出方案构件（没有自建表 / 没设计原则）→ 硬伤", () => {
    // 只留章节标题与小节名，构件全无
    const r = checkReport("solution", bareReport("solution"));
    expect(r.ok).toBe(false);
    const v = r.violations.find((x) => x.kind === "缺少方案构件");
    expect(v?.hard).toBe(true);
    expect(v?.detail).toContain("自建表格");
    expect(v?.detail).toContain("设计原则");
  });

  it("出现决策建议是硬伤（产品只给事实，决定权在用户）", () => {
    const r = checkReport("solution", goodReport("solution", "\n\n我方建议优先投入试点。"));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.kind === "出现决策建议")).toBe(true);
  });

  it("「下一步（步骤与交付物）」不算决策建议", () => {
    const r = checkReport(
      "solution",
      goodReport("solution", "\n\n下一步：现场勘察 → 单站试点 → 指标对标。"),
    );
    expect(r.violations.some((v) => v.kind === "出现决策建议")).toBe(false);
  });

  it("对外材料出现内部表号 / 来源 / 证据级 → 硬伤", () => {
    for (const leak of ["见 表3-8", "来源：客户台账", "证据级 A", "信息缺口 3 条", "ingest-123-4.pdf"]) {
      const r = checkReport("solution", goodReport("solution", `\n\n参考资料 ${leak}`));
      expect(r.ok, leak).toBe(false);
      expect(r.violations.some((v) => v.kind === "对外泄漏内部信息"), leak).toBe(true);
    }
  });

  it("「能力缺口」是正当说法，不算对外泄漏（只有信息缺口这类内部口径才算）", () => {
    const r = checkReport(
      "solution",
      goodReport("solution", "\n\n主要缺口在算法与软件，需与伙伴配合。"),
    );
    expect(r.violations.some((v) => v.kind === "对外泄漏内部信息")).toBe(false);
  });

  it("正文用「一、二、」当条目编号 → 只提示（会和章号混淆）", () => {
    const r = checkReport(
      "solution",
      goodReport("solution", "\n\n**二、按预约自动就绪、离场自动释放。** 减少占而不用。"),
    );
    const v = r.violations.find((x) => x.kind === "正文用了章号式编号");
    expect(v?.hard).toBe(false);
    // 章标题本身是 `## 二、…`，不算正文编号
    expect(v?.detail).toContain("1 处");
  });

  it("篇幅超标只提示（要精要，不要流水账）", () => {
    const long = goodReport("solution") + "\n\n" + "补充废话。".repeat(1000);
    const v = checkReport("solution", long).violations.find((x) => x.kind === "篇幅超标");
    expect(v?.hard).toBe(false);
    expect(v?.detail).toContain("超过");
  });

  it("篇幅按正文字数算：表格再长也不算流水账", () => {
    const rows = Array.from({ length: 400 }, (_, i) => `| 行${i} | 说明${i} |`).join("\n");
    const md = `${goodReport("solution")}\n\n| 序号 | 连接 |\n|---|---|\n${rows}\n`;
    expect(kindsOf("solution", md)).not.toContain("篇幅超标");
  });

  it("原则写成「### 设计原则 + 条目」（没有原则一/二编号）也算构件齐全", () => {
    const md = goodReport("solution").replace(
      "原则一 不替代原系统；原则二 不参与安全联锁。",
      "- 辅助不替代\n- 能接的接、不能接的明说",
    );
    const v = checkReport("solution", md).violations.find((x) => x.kind === "缺少方案构件");
    expect(v).toBeUndefined();
  });

  it("价值章逐条写「待补/未提供」→ 硬伤（那是缺口清单，不是价值）", () => {
    const bad = goodReport("solution")
      .replace("| 预约时间与就绪时间戳差 |", "| 本客户基线未提供 |")
      .replace("| 按月比对预约与实际通电 |", "| 本客户基线未提供 |")
      .replace("| 工单上门次数对比 |", "| 本客户基线未提供 |");
    const v = checkReport("solution", bad).violations.find((x) => x.kind === "价值写成缺口清单");
    expect(v?.hard).toBe(true);
  });

  it("价值章只在章末交代一次基线 → 不算缺口清单", () => {
    const ok = goodReport("solution").replace(
      "价值一 ……度量口径：单次巡检人天。",
      "价值一：采用后现场巡检减少。现在：靠人工巡检。（怎么核：巡检人天）\n" +
        "本客户基线未提供，以上为行业通例量级。",
    );
    expect(kindsOf("solution", ok)).not.toContain("价值写成缺口清单");
  });

  it("篇幅不足只提示，不当硬伤", () => {
    const v = checkReport("solution", goodReport("solution")).violations.find(
      (x) => x.kind === "篇幅不足",
    );
    expect(v?.hard).toBe(false);
  });

  it("章名识别忽略序号与多余空格", () => {
    expect(reportChapterHeadings("## 一、现状 \n### 小节\n## 方案")).toEqual(["现状", "方案"]);
    expect(reportChapterHeadings("## 现状\n## 场景与问题")).toEqual(["现状", "场景与问题"]);
  });
});

describe("建设工作方案口径（变更表 #137）", () => {
  /** 七章：建设背景与必要性 / 建设目标与思路 / 建设内容 / 建设路径 / 工作安排 / 保障措施 / 监管协同展望 */
  it("七章齐 + 构件齐 → 通过", () => {
    const r = checkReport("construction", goodReport("construction"));
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("construction");
    expect(r.chapters.length).toBe(7);
    expect(reportChapters("construction").map((c) => c.label)).toEqual([
      "建设背景与必要性",
      "建设目标与思路",
      "建设内容",
      "建设路径",
      "工作安排",
      "保障措施",
      "监管协同展望",
    ]);
  });

  it("只写六章（漏「建设内容」）→ 硬伤「缺章」，detail 点到那一章名", () => {
    const r = checkReport("construction", withoutChapter("construction", "建设内容"));
    expect(r.ok).toBe(false);
    const v = r.violations.find((x) => x.kind === "缺章");
    expect(v?.hard).toBe(true);
    expect(v?.detail).toBe("缺少章节：建设内容");
  });

  it("「总体架构 / 核心功能」章缺自建表格 → 硬伤「缺少方案构件」", () => {
    const r = checkReport("construction", bareReport("construction"));
    expect(r.ok).toBe(false);
    const v = r.violations.find((x) => x.kind === "缺少方案构件");
    expect(v?.hard).toBe(true);
    expect(v?.detail).toContain("「总体架构」");
    expect(v?.detail).toContain("「核心功能」");
  });

  it("建设路径章缺那一张表（新增感知设备）→ 硬伤；成本评估小节已按用户要求删除", () => {
    const v = checkReport("construction", bareReport("construction")).violations.find(
      (x) => x.kind === "缺少方案构件",
    );
    expect(v?.hard).toBe(true);
    expect(v?.detail).toContain("「新增感知设备」");
    // 成本评估退场：建设路径只剩数据采集 + 新增感知设备，也不该再被当成缺构件
    expect(v?.detail).not.toContain("成本评估");
    expect(
      reportChapters("construction").find((c) => c.key === "path")?.sections.map((s) => s.title),
    ).toEqual(["数据采集", "新增感知设备"]);
  });

  it("工作安排章缺计划表 → 硬伤", () => {
    const v = checkReport("construction", bareReport("construction")).violations.find(
      (x) => x.kind === "缺少方案构件",
    );
    expect(v?.hard).toBe(true);
    expect(v?.detail).toContain("「阶段与时间安排」");
  });

  it("篇幅按 construction 口径：不足 2000 只提示", () => {
    const v = checkReport("construction", goodReport("construction")).violations.find(
      (x) => x.kind === "篇幅不足",
    );
    expect(v?.hard).toBe(false);
    expect(v?.detail).toContain("低于 2000 字");
  });

  it("篇幅按 construction 口径：超过 6000 只提示", () => {
    const long = goodReport("construction") + "\n\n" + "补充废话。".repeat(1500);
    const v = checkReport("construction", long).violations.find((x) => x.kind === "篇幅超标");
    expect(v?.hard).toBe(false);
    expect(v?.detail).toContain("超过 6000 字");
  });

  it("篇幅上下限按口径给（solution 1200/4500，construction 2000/6000）", () => {
    expect([reportMinChars("solution"), reportMaxChars("solution")]).toEqual([1200, 4500]);
    expect([reportMinChars("construction"), reportMaxChars("construction")]).toEqual([2000, 6000]);
  });

  it("不再产生已退场的违规类型（缺风险或边界 / 缺术语表）", () => {
    const raw = JSON.stringify(checkReport("construction", goodReport("construction")).violations);
    expect(raw).not.toContain("缺风险或边界");
    expect(raw).not.toContain("缺术语表");
  });

  it("价值章口吻检查对 construction 自然空转（它没有 value 章）", () => {
    const md = goodReport("construction") + "\n\n待补待补待补充，基线未提供，无法核实。";
    const kinds = kindsOf("construction", md);
    expect(kinds).not.toContain("价值写成缺口清单");
    expect(kinds).not.toContain("说明书腔");
  });

  it("别名回归：construction 的「建设路径」不会被认成 solution 的「下一步」", () => {
    // 少一章时只报那一章；建设路径 / 建设内容 已被认出来，不算缺章
    const r = checkReport("construction", withoutChapter("construction", "保障措施"));
    expect(r.violations.find((x) => x.kind === "缺章")?.detail).toBe("缺少章节：保障措施");
    expect(matchChapterKey("construction", "建设路径")).toBe("path");
    expect(matchChapterKey("solution", "建设路径")).toBeNull();
  });

  it("别名回归：construction 的「建设内容」不会被认成 solution 的「方案」", () => {
    const r = checkReport("construction", withoutChapter("construction", "保障措施"));
    expect(r.violations.find((x) => x.kind === "缺章")?.detail).toBe("缺少章节：保障措施");
    expect(matchChapterKey("construction", "建设内容")).toBe("content");
    expect(matchChapterKey("solution", "建设内容")).toBeNull();
  });
});
