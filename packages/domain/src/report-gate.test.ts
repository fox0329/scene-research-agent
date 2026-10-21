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

describe("报告确定性校验（变更表 #246）：一份《<场景>解决方案》，七章", () => {
  it("章节齐 + 方案构件齐 → 通过", () => {
    const r = checkReport("solution", goodReport("solution"));
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("solution");
    expect(r.chapters.length).toBe(reportChapters("solution").length);
    expect(reportChapters("solution").map((c) => c.label)).toEqual([
      "现状与问题",
      "建设目标与思路",
      "方案总体与建设内容",
      "建设路径",
      "工作安排",
      "保障措施",
      "下一步",
    ]);
  });

  it("缺章是硬伤（模型漏写一章不能就这么交付）", () => {
    const r = checkReport("solution", withoutChapter("solution", "方案总体与建设内容"));
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

  it("篇幅超总上限只提示（#139 补丁：出稿前已定向回炉，这里再升硬伤会触发整篇重写）", () => {
    const long = goodReport("solution") + "\n\n" + "补充废话。".repeat(2000);
    const v = checkReport("solution", long).violations.find((x) => x.kind === "篇幅超标");
    expect(v?.hard).toBe(false);
    expect(v?.detail).toContain("超过 6000 字总上限");
    // 只提示 = 不影响整体结论
    expect(checkReport("solution", long).ok).toBe(true);
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

  it("篇幅不足只提示，不当硬伤", () => {
    const v = checkReport("solution", goodReport("solution")).violations.find(
      (x) => x.kind === "篇幅不足",
    );
    expect(v?.hard).toBe(false);
  });

  it("章名识别忽略序号与多余空格", () => {
    expect(reportChapterHeadings("## 一、现状与问题 \n### 小节\n## 建设路径")).toEqual([
      "现状与问题",
      "建设路径",
    ]);
    expect(matchChapterKey("solution", "一、方案总体与建设内容")).toBe("solution");
  });
});

describe("合并后的七章口径（变更表 #246）", () => {
  it("七章齐 + 构件齐 → 通过", () => {
    const r = checkReport("solution", goodReport("solution"));
    expect(r.ok).toBe(true);
    expect(r.chapters.length).toBe(7);
  });

  it("漏「方案总体与建设内容」→ 硬伤「缺章」，detail 点到那一章名", () => {
    const r = checkReport("solution", withoutChapter("solution", "方案总体与建设内容"));
    const v = r.violations.find((x) => x.kind === "缺章");
    expect(v?.hard).toBe(true);
    expect(v?.detail).toBe("缺少章节：方案总体与建设内容");
  });

  it("方案总体章缺自建表格（架构 / 核心功能 / 职责 / 选型）→ 硬伤「缺少方案构件」", () => {
    const v = checkReport("solution", bareReport("solution")).violations.find(
      (x) => x.kind === "缺少方案构件",
    );
    expect(v?.hard).toBe(true);
    expect(v?.detail).toContain("「总体架构」");
    expect(v?.detail).toContain("「核心功能」");
    expect(v?.detail).toContain("「主辅职责对照」");
  });

  it("建设路径章缺那张设备清单表 → 硬伤", () => {
    const v = checkReport("solution", bareReport("solution")).violations.find(
      (x) => x.kind === "缺少方案构件",
    );
    expect(v?.detail).toContain("「新增感知设备」");
    expect(
      reportChapters("solution").find((c) => c.key === "path")?.sections.map((s) => s.title),
    ).toEqual(["数据采集", "新增感知设备"]);
  });

  it("工作安排章缺计划表 → 硬伤", () => {
    const v = checkReport("solution", bareReport("solution")).violations.find(
      (x) => x.kind === "缺少方案构件",
    );
    expect(v?.detail).toContain("「阶段与时间安排」");
  });

  it("篇幅上下限只有一套（2500 / 6000），下限同样只提示", () => {
    expect([reportMinChars("solution"), reportMaxChars("solution")]).toEqual([2500, 6000]);
    const v = checkReport("solution", goodReport("solution")).violations.find(
      (x) => x.kind === "篇幅不足",
    );
    expect(v?.hard).toBe(false);
    expect(v?.detail).toContain("低于 2500 字");
  });

  it("章首段超过 120 字 / 以分号列举开头 → 硬伤（变更表 #247）", () => {
    const bad = goodReport("solution").replace(
      "这是场景在业务中的位置的归纳正文。",
      "多园区由 IT 与厂商支持；纪要手工或录音转写，无统一检索；预约分散在三个系统里；" +
        "设备维护靠电话报修，没有台账，也没有远程监控手段，问题长期无人闭环处理。",
    );
    const v = checkReport("solution", bad).violations.find((x) => x.kind === "章首段不合规");
    expect(v?.hard).toBe(true);
    expect(v?.detail).toContain("现状与问题");
    // 干净的那份不产生这条
    expect(kindsOf("solution", goodReport("solution"))).not.toContain("章首段不合规");
  });

  it("整篇出现断头段 → 硬伤（终检的最后一道断言）", () => {
    const broken = goodReport("solution").replace(
      "这是场景在业务中的位置的归纳正文。",
      "、Teams 等云平台；多园区由 IT 支持。",
    );
    const v = checkReport("solution", broken).violations.find((x) => x.kind === "悬空残句");
    expect(v?.hard).toBe(true);
  });

  it("小节占位 → 只提示；跨章重复句 → 只提示", () => {
    const dup =
      goodReport("solution") +
      "\n\n现场巡检仍靠人工记录，数据分散在三个系统里，统计口径对不上。";
    const kinds = kindsOf("solution", dup);
    expect(kinds).toContain("空节");
    expect(checkReport("solution", dup).violations.find((x) => x.kind === "空节")?.hard).toBe(false);
  });

  it("不再产生已退场的违规类型（缺风险或边界 / 缺术语表 / 价值写成缺口清单）", () => {
    const raw = JSON.stringify(checkReport("solution", goodReport("solution")).violations);
    expect(raw).not.toContain("缺风险或边界");
    expect(raw).not.toContain("缺术语表");
    expect(raw).not.toContain("价值写成缺口清单");
  });

  it("别名回归：七章的章名都能认，别名不会串到别的章", () => {
    expect(matchChapterKey("solution", "建设路径")).toBe("path");
    expect(matchChapterKey("solution", "方案总体与建设内容")).toBe("solution");
    expect(matchChapterKey("solution", "保障措施")).toBe("safeguards");
    expect(matchChapterKey("solution", "现状")).toBe("status");
    const r = checkReport("solution", withoutChapter("solution", "保障措施"));
    expect(r.violations.find((x) => x.kind === "缺章")?.detail).toBe("缺少章节：保障措施");
  });
});
