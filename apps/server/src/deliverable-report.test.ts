/**
 * @scene/server — 交付物报告生成测试（变更表 #112 / #137 / #139）
 *
 * 真 SQLite（:memory:）+ mock dshClient：覆盖「模型撰写 → 确定性校验 → 逐章兜底 → 落盘」
 * 全链路，以及三条铁律（章节齐全 / 不给决策建议 / 不带内部信息痕迹）在模型不听话时的行为。
 *
 * 变更表 #137 起交付物**两份**：《<场景>解决方案》（落盘 `<场景 id>.solution.md`）与
 * 《<场景>建设工作方案》（`<场景 id>.construction.md`）——一趟生成各跑一遍，章节骨架不同，
 * 两份互不串；也不再有「内部调研报告 / 对外汇报材料」两份口径与「主要风险点」章、附录、术语表。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REPORT_KINDS,
  reportChapterHeading,
  reportChapters,
  type ReportKind,
} from "@scene/contract";
import type { DshClient, FollowEvent } from "@scene/contract";
import { createDb } from "@scene/infra";
import type { DbInstance } from "@scene/infra";
import { reportMinChars } from "@scene/domain";
import {
  chapterRewriteRejection,
  createDeliverableReportCommand,
  splitReportChapters,
} from "./deliverable-report.js";
import {
  FIX_PROMPT_MARKER,
  REVIEW_PROMPT_MARKER,
  VERIFY_PROMPT_MARKER,
} from "./report-review.js";
import { getReport, getReports } from "./report-service.js";

/** 章节 + 方案构件都齐的"好"报告（模拟模型照要求作答）；两个口径各生成一份 */
function goodReport(kind: ReportKind): string {
  return reportChapters(kind)
    .map((c) => {
      const body = c.sections
        .map((sec) => {
          const arts = sec.artifacts ?? [];
          const lines = [`### ${sec.title}`, "", `${sec.title}的归纳正文。`];
          if (arts.includes("table")) {
            lines.push("", "| 层次 | 组成 | 作用 |", "|---|---|---|", "| 主链 | PLC | 控制闭环 |");
          }
          if (arts.includes("numbered-connections")) lines.push("", "① 仪表 → 网关；② 网关 → 平台。");
          if (arts.includes("principles")) lines.push("", "原则一 不替代原系统；原则二 不参与联锁。");
          if (arts.includes("value-table"))
            lines.push(
              "",
              "| 价值 | 现在 | 采用后 | 怎么核 |",
              "|---|---|---|---|",
              "| 价值一：会前不再逐台开机 | 提前 5–10 分钟接线（行业 3~10 分钟） | 碰一碰拉起，秒级就绪 | 预约开始时间与设备就绪时间戳差 |",
              "| 价值二：离场自动释放 | 占而不用与找不到房并存 | 自动释放、超时回收 | 按月比对预约与实际通电时段 |",
              "| 价值三：故障改远程 | 靠报修与到场 | 远程监控与 OTA | 工单上门次数与修复时长同期对比 |",
            );
          return lines.join("\n");
        })
        .join("\n\n");
      // 有些章「章下直接写、不套小节」（sections 为空，如建设工作方案的「监管协同展望」）：
      // 也要有正文，否则这一章等于没写、会被判缺章
      const text = body.trim() === "" ? `${c.label}的归纳正文。` : body;
      return `## ${reportChapterHeading(kind, c.key)}\n\n${text}`;
    })
    .join("\n\n");
}

/**
 * 提示词里出现的是哪一份的章节，就说明这一趟在写哪个口径
 *
 * 补写调用只列缺的那几章，所以按"只在建设工作方案里出现的章名"判口径。
 */
const CONSTRUCTION_ONLY_MARKERS = [
  "建设背景与必要性",
  "建设目标与思路",
  "建设内容",
  "建设路径",
  "工作安排",
  "保障措施",
  "监管协同展望",
];

function kindOfPrompt(input: { system: string; user: string }): ReportKind {
  const text = `${input.system}\n${input.user}`;
  return CONSTRUCTION_ONLY_MARKERS.some((m) => text.includes(m)) ? "construction" : "solution";
}

/** 按提示词内容决定返回什么（两份一起跑时靠它分辨口径） */
/** 终检通读一律回"没问题"：这些用例只关心撰写链路，别让终检重试多打一次调用 */
const REVIEW_CLEAN = '{"issues":[]}';

function dshByPrompt(
  pick: (input: { system: string; user: string }) => string,
): { client: DshClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    createSession: async ({ title }: { title: string }) => ({ sessionId: `s-${title}` }),
    prompt: (_h: unknown, input: { system: string; user: string }) => {
      calls.push(input.user);
      const text = pick(input);
      return (async function* (): AsyncGenerator<FollowEvent> {
        yield { type: "text", text };
        yield { type: "done" };
      })();
    },
    cancel: async () => {},
  } as unknown as DshClient;
  return { client, calls };
}

/** 让 mock 逐次返回不同文本（用于验证"重写一次"） */
function dshOf(responses: string[]): { client: DshClient; calls: string[] } {
  let i = 0;
  return dshByPrompt(() => responses[Math.min(i++, responses.length - 1)] ?? "");
}

interface Harness {
  db: DbInstance;
  scenarioId: string;
  dir: string;
}

function makeHarness(): Harness {
  const db = createDb(":memory:");
  db.productLineRepo.insert({ name: "测试产品线" });
  const scenario = db.scenarioRepo.insert({
    name: "智慧会议室",
    status: "进行中",
    current_stage: 6,
  });
  // 两条真实数据即可（报告装配需要 stageData 非空）
  db.stageDataRepo.insert({
    scenario_id: scenario.id,
    stage: 1,
    table_code: "表1-1",
    row: { item: "场景名称", content: "智慧会议室" },
    is_stale: false,
  });
  db.stageDataRepo.insert({
    scenario_id: scenario.id,
    stage: 3,
    table_code: "表1-2",
    row: { link: "会议室预约", pain: "订而不用" },
    is_stale: false,
  });
  const dir = mkdtempSync(join(tmpdir(), "scene-report-"));
  process.env.DELIVERABLE_DIR = dir;
  return { db, scenarioId: scenario.id, dir };
}

/** 跑一遍命令，收集事件（终检默认开；`off` 用于只关心撰写链路的用例） */
async function run(
  db: DbInstance,
  dsh: DshClient,
  scenarioId: string,
  kinds?: readonly ReportKind[],
  review: "on" | "off" = "on",
): Promise<FollowEvent[]> {
  const cmd = createDeliverableReportCommand({ db, dshClient: dsh, keepaliveMs: 10_000, review });
  const events: FollowEvent[] = [];
  for await (const e of await cmd.execute({ scenarioId, kinds })) events.push(e);
  return events;
}

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  rmSync(h.dir, { recursive: true, force: true });
  delete process.env.DELIVERABLE_DIR;
});

describe("chapterRewriteRejection — 回炉稿的采纳门槛（变更表 #139 补丁）", () => {
  // 建设内容章：总体架构（要表）+ 核心功能（要表）+ 状态研判与分级管控；3 张表才算构件齐
  const before = [
    "### 总体架构",
    "",
    "本方案采用四层架构，逐层说明组件与部署，这段话写得长一些，用来把篇幅撑起来。",
    "",
    "| 层次 | 我方组件与部署 | 承担什么 |",
    "|---|---|---|",
    "| 感知层 | 传感器 | 采集 |",
    "| 传输层 | 网关 | 回传 |",
    "| 平台层 | 平台 | 研判 |",
    "| 应用层 | 应用 | 展示 |",
    "",
    "### 核心功能",
    "",
    "以两条主线切入，按场景列项，这段话同样写得长一些，用来把篇幅撑起来。",
    "",
    "| 设备类别 | 感知设备 |",
    "|---|---|",
    "| 户内 | 传感器 |",
    "",
    "### 状态研判与分级管控",
    "",
    "一段说研判模型与结论口径，另一段说分级机制与管控频次的差异。",
    "",
    "| 风险等级 | 判定依据 |",
    "|---|---|",
    "| 高 | 状态差 |",
  ].join("\n");
  /** 只把三句话改短：小节、表格、段落结构都不动 */
  const shorter = (text: string): string =>
    text
      .replace(
        "本方案采用四层架构，逐层说明组件与部署，这段话写得长一些，用来把篇幅撑起来。",
        "本方案采用四层架构。",
      )
      .replace("以两条主线切入，按场景列项，这段话同样写得长一些，用来把篇幅撑起来。", "以两条主线切入。")
      .replace("一段说研判模型与结论口径，另一段说分级机制与管控频次的差异。", "说清研判与分级。");

  const check = (after: string): string | null =>
    chapterRewriteRejection({ kind: "construction", key: "content", before, after });

  it("更短、构件不少、小节不少、章首段合格 → 采纳（返回 null）", () => {
    expect(check(shorter(before))).toBeNull();
  });

  it("重写没变短（等长或更长）→ 不采纳", () => {
    expect(check(before)).toContain("没变短");
    expect(check(`${before}\n\n再补一句。`)).toContain("没变短");
  });

  it("方案构件变少（表格被吃掉）→ 不采纳", () => {
    const dropped = shorter(before).replace("\n\n| 设备类别 | 感知设备 |\n|---|---|\n| 户内 | 传感器 |", "");
    expect(dropped).not.toBe(shorter(before));
    expect(check(dropped)).toBe("方案构件变少");
  });

  it("`###` 小节变少（整节被吃掉）→ 不采纳", () => {
    const trimmed = shorter(before).replace("\n\n### 状态研判与分级管控\n\n说清研判与分级。", "");
    expect(trimmed).not.toBe(shorter(before));
    expect(check(trimmed)).toBe("小节变少（3 → 2 个）");
  });

  it("改后章首段不合格（半句/分号列举开头）→ 不采纳", () => {
    const badLead = shorter(before).replace("本方案采用四层架构。", "多园区由 IT 与厂商支持；现场靠人工预约。");
    expect(check(badLead)).toContain("章首段不合格");
  });
});

describe("交付物报告生成（两份：模型撰写 + 确定性校验）", () => {
  it("模型写好两份 → 各落盘一份，全部来自模型，done 事件带两个字数", async () => {
    const { client } = dshByPrompt((input) => goodReport(kindOfPrompt(input)));
    const events = await run(h.db, client, h.scenarioId);

    const done = events.find((e) => e.type === "done")!;
    expect(done).toBeDefined();
    const sources = done["sources"] as { kind: string; key: string; from: string }[];
    // 解决方案 5 章 + 建设工作方案 7 章，两份都来自模型
    expect(sources).toHaveLength(12);
    expect(sources.filter((s) => s.kind === "solution")).toHaveLength(5);
    expect(sources.filter((s) => s.kind === "construction")).toHaveLength(7);
    expect(sources.every((s) => s.from === "模型")).toBe(true);

    const report = done["report"] as { solution_chars: number; construction_chars: number };
    expect(report.solution_chars).toBeGreaterThan(0);
    expect(report.construction_chars).toBeGreaterThan(0);
    // 变更表 #136 的旧字段与更早的双口径字段都退场
    expect(report).not.toHaveProperty("internal_chars");
    expect(report).not.toHaveProperty("external_chars");

    // 进度文案带口径名与各自的下限
    const progress = events
      .filter((e) => e.type === "progress")
      .map((e) => String(e["message"] ?? ""));
    expect(progress.some((m) => m.includes("正在撰写「智慧会议室解决方案」"))).toBe(true);
    expect(progress.some((m) => m.includes("正在撰写「智慧会议室建设工作方案」"))).toBe(true);
    expect(progress.some((m) => m.includes(`下限 ${reportMinChars("construction")} 字`))).toBe(true);

    const solutionPath = join(h.dir, `${h.scenarioId}.solution.md`);
    const constructionPath = join(h.dir, `${h.scenarioId}.construction.md`);
    expect(existsSync(solutionPath)).toBe(true);
    expect(existsSync(constructionPath)).toBe(true);
    // 变更表 #136 之前的两份口径文件不再落盘
    expect(existsSync(join(h.dir, `${h.scenarioId}.internal.md`))).toBe(false);
    expect(existsSync(join(h.dir, `${h.scenarioId}.external.md`))).toBe(false);

    const solution = readFileSync(solutionPath, "utf8");
    expect(solution).toContain("## 现状");
    expect(solution).toContain("## 方案");
    expect(solution).toContain("## 价值");
    expect(solution).toContain("## 下一步");
    // 章标题不带手写序号（编号交给 Word 自动编号）
    expect(solution).not.toContain("## 一、");
    // 内部口径的章与附录都已退场（变更表 #136）
    expect(solution).not.toContain("主要风险点");
    expect(solution).not.toContain("附录");
    expect(solution).not.toContain("术语表");
    // 两份互不串：建设工作方案的章不许跑进解决方案
    expect(solution).not.toContain("## 建设路径");
    expect(solution).not.toContain("## 保障措施");

    const construction = readFileSync(constructionPath, "utf8");
    for (const c of reportChapters("construction")) {
      expect(construction).toContain(`## ${reportChapterHeading("construction", c.key)}`);
    }
    // 解决方案的章也不许跑进建设工作方案
    expect(construction).not.toContain("## 现状");
    expect(construction).not.toContain("## 下一步");
    expect(construction).not.toContain("## 价值");
    expect(construction).not.toContain("主要风险点");
  });

  /** 往某章末尾追加 n 段正文（不改首段，所以"章首段是总纲"这条不会被自己踩到） */
  const pad = (md: string, anchor: string, n: number): string =>
    md.replace(anchor, `${anchor}\n\n${"补充说明现场情况与处置口径。\n\n".repeat(n).trimEnd()}`);

  it("全篇总量在上限内 → 一章都不回炉（逐章预算只是写作指引）", async () => {
    const { client, calls } = dshByPrompt((input) =>
      input.user.includes(REVIEW_PROMPT_MARKER) ? REVIEW_CLEAN : goodReport(kindOfPrompt(input)),
    );
    const events = await run(h.db, client, h.scenarioId, ["solution"]);

    // 一次整篇撰写 + 一次终检通读，没有任何回炉调用
    expect(calls.filter((c) => c.includes("本章正文预算"))).toEqual([]);
    expect(calls).toHaveLength(2);
    const progress = events.filter((e) => e.type === "progress").map((e) => String(e["message"] ?? ""));
    expect(progress.some((m) => m.includes("在总上限 4500 字内，不回炉"))).toBe(true);
    expect(progress.some((m) => /回炉最长的|回炉后|已回炉|回炉重写/.test(m))).toBe(false);
  });

  it("全篇超总量 → 只回炉最长的那一章（提示词带该章名与预算），改回上限内就收手", async () => {
    // 现状章灌到 5,200+ 字 → 全篇 5,500 字 > 4,500；它也是最长的章
    const fat = pad(goodReport("solution"), "现状特征与提升空间的归纳正文。", 400);
    const { client, calls } = dshByPrompt((input) => {
      if (input.user.includes(REVIEW_PROMPT_MARKER)) return REVIEW_CLEAN;
      if (kindOfPrompt(input) !== "solution") return goodReport("construction");
      if (input.user.includes("本章正文预算")) return goodReport("solution"); // 回炉：达标稿
      return fat;
    });
    const events = await run(h.db, client, h.scenarioId, ["solution"]);

    const rewrites = calls.filter((c) => c.includes("本章正文预算"));
    expect(rewrites).toHaveLength(1); // 够用就停手：不为了"凑满两章"多跑一次
    expect(rewrites[0]).toContain("现状"); // 挑的是最长的章
    expect(rewrites[0]).toContain("本章正文预算不超过 1000 字");
    expect(rewrites[0]).toContain("第一段是本章总纲");

    const progress = events.filter((e) => e.type === "progress").map((e) => String(e["message"] ?? ""));
    expect(progress.some((m) => m.includes("超总上限 4500 字，回炉最长的 2 章"))).toBe(true);
    expect(progress.some((m) => m.includes("回炉后正文") && m.includes("已在总上限 4500 字内"))).toBe(true);

    const saved = readFileSync(join(h.dir, `${h.scenarioId}.solution.md`), "utf8");
    expect(saved).not.toContain("补充说明现场情况与处置口径。");
    expect(saved).toContain("现状特征与提升空间的归纳正文。");
  });

  it("回炉两章后仍超总量 → 保留正文不截断，进度报「超总上限 M（已回炉 K 章）」", async () => {
    const fat = pad(
      pad(goodReport("solution"), "现状特征与提升空间的归纳正文。", 400),
      "实施要点的归纳正文。",
      250,
    );
    // 两章各回炉一次，都只是变短、仍然超标
    const leaner = pad(
      pad(goodReport("solution"), "现状特征与提升空间的归纳正文。", 300),
      "实施要点的归纳正文。",
      150,
    );
    let rewriteNo = 0;
    const { client, calls } = dshByPrompt((input) => {
      if (input.user.includes(REVIEW_PROMPT_MARKER)) return REVIEW_CLEAN;
      if (kindOfPrompt(input) !== "solution") return goodReport("construction");
      if (input.user.includes("本章正文预算")) {
        rewriteNo += 1;
        if (rewriteNo === 1) expect(input.user).toContain("现状"); // 降序：先最长的
        return leaner;
      }
      return fat;
    });
    const events = await run(h.db, client, h.scenarioId, ["solution"]);

    expect(calls.filter((c) => c.includes("本章正文预算"))).toHaveLength(2); // 上限内就不再动第二章
    const progress = events.filter((e) => e.type === "progress").map((e) => String(e["message"] ?? ""));
    expect(progress.some((m) => /超总上限 4500（已回炉 2 章），保留正文不截断/.test(m))).toBe(true);

    // 采纳的是更短的那版，但一个字都没再删
    const saved = readFileSync(join(h.dir, `${h.scenarioId}.solution.md`), "utf8");
    expect(saved).toContain("补充说明现场情况与处置口径。");
    expect(saved.match(/补充说明现场情况与处置口径。/g) ?? []).toHaveLength(450); // 300 + 150
  });

  it("回炉稿更长 / 吃掉 `###` 小节 → 不采纳，保留原稿（超总量的前提下触发）", async () => {
    const fat = pad(
      pad(goodReport("solution"), "现状特征与提升空间的归纳正文。", 400),
      "实施要点的归纳正文。",
      250,
    );
    // 现状章回炉稿更长；方案章回炉稿把「### 实施要点」（不背构件）整节吃掉
    const longer = pad(goodReport("solution"), "现状特征与提升空间的归纳正文。", 450);
    const dropped = pad(
      goodReport("solution").replace("\n\n### 实施要点\n\n实施要点的归纳正文。", ""),
      "实施要点的归纳正文。",
      100,
    );
    let rewriteNo = 0;
    const { client } = dshByPrompt((input) => {
      if (input.user.includes(REVIEW_PROMPT_MARKER)) return REVIEW_CLEAN;
      if (kindOfPrompt(input) !== "solution") return goodReport("construction");
      if (input.user.includes("本章正文预算")) {
        rewriteNo += 1;
        return rewriteNo === 1 ? longer : dropped;
      }
      return fat;
    });
    const events = await run(h.db, client, h.scenarioId, ["solution"]);

    const progress = events.filter((e) => e.type === "progress").map((e) => String(e["message"] ?? ""));
    expect(progress.some((m) => m.includes("没达标，保留原稿") && m.includes("没变短"))).toBe(true);
    expect(progress.some((m) => m.includes("没达标，保留原稿") && m.includes("小节变少"))).toBe(true);
    // 两份回炉稿都没采纳：原稿一字未动，也没截断
    const saved = readFileSync(join(h.dir, `${h.scenarioId}.solution.md`), "utf8");
    expect(saved.match(/补充说明现场情况与处置口径。/g) ?? []).toHaveLength(650); // 400 + 250
    expect(saved).toContain("### 实施要点");
  });

  it("回炉重写失败（模型报错）→ 保留原正文，不中断整篇生成", async () => {
    const fat = pad(goodReport("solution"), "现状特征与提升空间的归纳正文。", 400);
    const { client } = dshByPrompt((input) => {
      if (input.user.includes(REVIEW_PROMPT_MARKER)) return REVIEW_CLEAN;
      if (kindOfPrompt(input) !== "solution") return goodReport("construction");
      if (input.user.includes("本章正文预算")) throw new Error("回炉这一次断连了");
      return fat;
    });
    const events = await run(h.db, client, h.scenarioId, ["solution"]);

    expect(events.some((e) => e.type === "error")).toBe(false);
    const saved = readFileSync(join(h.dir, `${h.scenarioId}.solution.md`), "utf8");
    expect(saved.match(/补充说明现场情况与处置口径。/g) ?? []).toHaveLength(400);
    const progress = events.filter((e) => e.type === "progress").map((e) => String(e["message"] ?? ""));
    expect(progress.some((m) => m.includes("回炉重写失败") && m.includes("保留原正文"))).toBe(true);
  });

  it("终检：通读发现 1 处并改掉 → 落盘里那处已改、其它章逐字不变、done 带终检提示数", async () => {
    const kind: ReportKind = "construction";
    const before = goodReport(kind);
    // 在「建设内容」章开头插一句读不通的话（它成为该章首段，正好是终检要改的段落）
    const withProblem = before.replace(
      "## 建设内容\n\n",
      "## 建设内容\n\n这句前后矛盾的话要改掉，它和上一段说的是两回事。\n\n",
    );
    // 章与章之间装配层会插 `---` 分隔线；比对章正文时把它剥掉
    const chapterOf = (md: string, title: string): string =>
      (md.split(/\n(?=## )/).find((p) => p.startsWith(`## ${title}`)) ?? "")
        .replace(/\n+---\s*$/, "")
        .trim();
    const fixedChapter = chapterOf(withProblem, "建设内容").replace(
      "这句前后矛盾的话要改掉，它和上一段说的是两回事。",
      "建设内容按感知、平台、应用三层展开，逐层说明组件与职责。",
    );

    const { client, calls } = dshByPrompt((input) => {
      if (input.user.includes(REVIEW_PROMPT_MARKER)) {
        return JSON.stringify({
          issues: [
            {
              chapter: "建设内容",
              anchor: "这句前后矛盾的话要改掉",
              type: "前后矛盾",
              note: "与上一段冲突",
            },
          ],
        });
      }
      if (input.user.includes(FIX_PROMPT_MARKER)) return fixedChapter;
      if (input.user.includes(VERIFY_PROMPT_MARKER)) return '{"unresolved":[]}';
      return withProblem;
    });
    const events = await run(h.db, client, h.scenarioId, ["construction"]);

    // 三次终检调用：通读 / 改章 / 复查
    expect(calls.filter((p) => p.includes(REVIEW_PROMPT_MARKER))).toHaveLength(1);
    expect(calls.filter((p) => p.includes(FIX_PROMPT_MARKER))).toHaveLength(1);

    const saved = readFileSync(join(h.dir, `${h.scenarioId}.construction.md`), "utf8");
    expect(saved).toContain("建设内容按感知、平台、应用三层展开，逐层说明组件与职责。");
    expect(saved).not.toContain("这句前后矛盾的话要改掉");
    // 没被点名的段落与章节逐字不变
    for (const title of ["建设背景与必要性", "建设路径", "保障措施"]) {
      expect(chapterOf(saved, title), title).toBe(chapterOf(before, title));
    }

    const progress = events.filter((e) => e.type === "progress").map((e) => String(e["message"] ?? ""));
    expect(progress.some((m) => m.includes("终检：发现 1 处，改了 1 处，留 0 处提示"))).toBe(true);

    const done = events.find((e) => e.type === "done")!;
    expect(done["review"]).toEqual([
      { kind: "construction", issues: 1, fixed: 1, remaining: 0 },
    ]);
  });

  it("同一条校验提示只报一次：初稿校验与终检后校验的确定性判据不重复计数", async () => {
    const kind: ReportKind = "construction";
    // 把「建设内容」章首段灌成 >120 字的长段：checkReport 的确定性判据（章首段不合规）
    // 初稿与终检后各会命中一次，去重后只该剩一条
    const longLead = "本段刻意写得很长，用来触发章首段不合规的确定性判据。" + "内容".repeat(70) + "。";
    const withProblem = goodReport(kind).replace("## 建设内容\n\n", `## 建设内容\n\n${longLead}\n\n`);

    const { client } = dshByPrompt((input) => (input.user.includes("## 建设内容") ? withProblem : goodReport(kind)));
    // 只跑建设方案这一份：两份各有一条同名提示是正常的，这里查的是"同一份里不许重复"
    const events = await run(h.db, client, h.scenarioId, [kind]);
    const done = events.find((e) => e.type === "done")!;
    const violations = done["violations"] as { kind: string; detail: string }[];
    const lead = violations.filter((v) => v.kind === "章首段不合规");
    expect(lead).toHaveLength(1);
    expect(new Set(violations.map((v) => `${v.kind}|${v.detail}`)).size).toBe(violations.length);
  });

  it("两份交付物都不装内部附录，也不出现内部表号与内部口径的章", async () => {
    const { client } = dshByPrompt((input) => goodReport(kindOfPrompt(input)));
    await run(h.db, client, h.scenarioId);
    for (const kind of REPORT_KINDS) {
      const saved = readFileSync(join(h.dir, `${h.scenarioId}.${kind}.md`), "utf8");
      expect(saved, kind).not.toContain("来源索引");
      expect(saved, kind).not.toContain("信息覆盖概览");
      expect(saved, kind).not.toContain("附录");
      expect(saved, kind).not.toContain("术语表");
      expect(saved, kind).not.toContain("主要风险点");
      expect(saved, kind).not.toMatch(/表\d+-\d+/);
    }
  });

  it("模型漏章 + 写决策建议 → 重写一次；仍不达标则该章用要点版兜底", async () => {
    const bad = "## 现状\n\n我方建议优先投入到试点。";
    const { client, calls } = dshByPrompt((input) =>
      input.user.includes(REVIEW_PROMPT_MARKER) ? REVIEW_CLEAN : bad,
    );
    const events = await run(h.db, client, h.scenarioId);

    // 每个口径：整篇写 2 次（重写）+ 缺章补写 1 次 + 终检通读 1 次 = 4 次；两份共 8 次
    expect(calls.length).toBe(8);
    expect(calls.some((c) => c.includes("只写下面这几节"))).toBe(true);
    // 第二次整篇调用带上一版的问题清单
    expect(calls[1]).toContain("上一次的问题");

    const done = events.find((e) => e.type === "done")!;
    expect((done["violations"] as { hard: boolean }[]).some((v) => v.hard)).toBe(true);
    for (const kind of REPORT_KINDS) {
      const saved = readFileSync(join(h.dir, `${h.scenarioId}.${kind}.md`), "utf8");
      // 缺的章由确定性要点版补上：章节齐全
      for (const c of reportChapters(kind)) {
        expect(saved, `${kind}.${c.key}`).toContain(`## ${reportChapterHeading(kind, c.key)}`);
      }
    }
  });

  it("交付物泄漏内部信息 → 硬伤，触发重写；重写合格即通过（两份各自重写一次）", async () => {
    const seen = new Map<ReportKind, number>();
    const { client, calls } = dshByPrompt((input) => {
      if (input.user.includes(REVIEW_PROMPT_MARKER)) return REVIEW_CLEAN;
      const kind = kindOfPrompt(input);
      const n = (seen.get(kind) ?? 0) + 1;
      seen.set(kind, n);
      const good = goodReport(kind);
      // 第一次带内部痕迹，第二次是干净版
      return n === 1 ? good.replace(/^(## .+)$/m, "$1\n\n见 表3-8，来源：客户台账。") : good;
    });
    const events = await run(h.db, client, h.scenarioId);
    // 泄漏被拦下重写一次（每口径 2 次调用），干净版再走 1 次终检：两份共 6 次
    expect(calls.length).toBe(6);
    const done = events.find((e) => e.type === "done")!;
    expect((done["violations"] as { hard: boolean }[]).filter((v) => v.hard)).toEqual([]);
    for (const kind of REPORT_KINDS) {
      expect(readFileSync(join(h.dir, `${h.scenarioId}.${kind}.md`), "utf8"), kind).not.toMatch(
        /表\d+-\d+/,
      );
    }
  });

  it("只跑其中一份（kinds）：重跑建设工作方案不动用户手改过的解决方案", async () => {
    const sample = "# 用户自己改过的解决方案\n\n## 现状\n\n这段是用户手写的，不许被覆盖。";
    writeFileSync(join(h.dir, `${h.scenarioId}.solution.md`), sample, "utf8");

    const { client, calls } = dshOf([goodReport("construction")]);
    const events = await run(h.db, client, h.scenarioId, ["construction"]);

    // 只跑了建设方案这一份：模型只被叫了建设方案该有的次数，解决方案一个字节没动
    expect(calls.length).toBeGreaterThan(0);
    expect(readFileSync(join(h.dir, `${h.scenarioId}.solution.md`), "utf8")).toBe(sample);
    const construction = readFileSync(join(h.dir, `${h.scenarioId}.construction.md`), "utf8");
    expect(construction).toContain("## 建设内容");

    const done = events.find((e) => e.type === "done")!;
    const report = done["report"] as Record<string, number>;
    expect(report["construction_chars"]).toBeGreaterThan(0);
    expect(report["solution_chars"]).toBe(0);
  });

  it("还没有任何表格数据 → 直接报错，不去调用模型", async () => {
    const empty = createDb(":memory:");
    empty.productLineRepo.insert({ name: "空线" });
    const sc = empty.scenarioRepo.insert({
      name: "空场景",
      status: "进行中",
      current_stage: 6,
    });
    const { client, calls } = dshOf([goodReport("solution")]);
    const events = await run(empty, client, sc.id);
    expect(events[0]!.type).toBe("error");
    expect(calls.length).toBe(0);
  });
});

describe("报告服务：两份各自的正式版优先，没有则要点版", () => {
  it("未生成时两份都是要点版（generated=false），生成后各自读自己的正式版", async () => {
    const db = h.db;
    const scenario = db.scenarioRepo.getById(h.scenarioId)!;
    const before = getReports(db, scenario);
    expect(Object.keys(before).sort()).toEqual(["construction", "solution"]);
    expect(before.solution.generated).toBe(false);
    expect(before.construction.generated).toBe(false);
    expect(before.solution.generated_at).toBeNull();
    expect(before.construction.generated_at).toBeNull();
    expect(before.solution.chars).toBeGreaterThan(0);
    expect(before.construction.chars).toBeGreaterThan(0);
    // 两份的要点版各按自己的章节骨架装配
    expect(before.solution.markdown).toContain("## 现状");
    expect(before.construction.markdown).toContain("## 建设背景与必要性");
    // 要点版只有数据要点，没有模型写的价值表
    expect(before.solution.markdown).not.toContain("价值一：会前不再逐台开机");

    const { client } = dshByPrompt((input) => goodReport(kindOfPrompt(input)));
    await run(db, client, h.scenarioId);
    const after = getReports(db, scenario);
    expect(after.solution.generated).toBe(true);
    expect(after.construction.generated).toBe(true);
    expect(after.solution.generated_at).toBeTruthy();
    expect(after.construction.generated_at).toBeTruthy();
    // 读到的是模型撰写的正式版（各自的 `<id>.<kind>.md`），不是即时推导的要点版
    expect(after.solution.markdown).toContain("价值一：会前不再逐台开机");
    expect(getReport(db, scenario, "construction").markdown).toContain("## 建设路径");
    expect(getReport(db, scenario, "construction").kind).toBe("construction");
  });
});

describe("splitReportChapters：模型输出的分章解析", () => {
  it("按 ## 章名切分并忽略序号差异", () => {
    const map = splitReportChapters("## 一、现状\n甲\n## 三、方案\n乙", "solution");
    expect(map.get("status")).toBe("甲");
    expect(map.get("solution")).toBe("乙");
  });

  it("章名前有杂音、章内出现 ### 小标题都不影响切分", () => {
    const map = splitReportChapters("## 二、场景与问题\n### 小节\n内容", "solution");
    expect(map.get("problems")).toContain("### 小节");
  });

  it("章名匹配只在本口径自己的章里找（两份不互相误判）", () => {
    // 建设工作方案的章名，在解决方案口径里认不出来
    expect(splitReportChapters("## 建设路径\n甲", "construction").get("path")).toBe("甲");
    expect(splitReportChapters("## 建设路径\n甲", "solution").size).toBe(0);
    // 反之亦然
    expect(splitReportChapters("## 场景与问题\n乙", "solution").get("problems")).toBe("乙");
    expect(splitReportChapters("## 场景与问题\n乙", "construction").size).toBe(0);
  });
});

describe("splitReportChapters：同义章名与补写兜底", () => {
  it("模型写「场景概述」「解决方案」这类同义标题也认得出是哪一章", () => {
    const map = splitReportChapters("## 一、场景概述\n内容甲\n## 三、解决方案\n内容乙", "solution");
    expect(map.get("status")).toBe("内容甲");
    expect(map.get("solution")).toBe("内容乙");
  });

  it("补写某一章时模型没写 `## 章名`：整段归给这一章（内容不丢）", () => {
    const map = splitReportChapters("现状正文，没有标题。", "solution", ["status"]);
    expect(map.get("status")).toBe("现状正文，没有标题。");
  });

  it("补写多章时不套用整段兜底（避免把两章内容混成一章）", () => {
    const map = splitReportChapters("没有标题的正文", "solution", ["status", "next"]);
    expect(map.size).toBe(0);
  });
});
