/**
 * @scene/server — 交付物报告生成测试（变更表 #112 / #137）
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
import { createDeliverableReportCommand, splitReportChapters } from "./deliverable-report.js";
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
  const line = db.productLineRepo.insert({ name: "测试产品线" });
  const scenario = db.scenarioRepo.insert({
    name: "智慧会议室",
    product_line_id: line.id,
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

/** 跑一遍命令，收集事件 */
async function run(
  db: DbInstance,
  dsh: DshClient,
  scenarioId: string,
  kinds?: readonly ReportKind[],
): Promise<FollowEvent[]> {
  const cmd = createDeliverableReportCommand({ db, dshClient: dsh, keepaliveMs: 10_000 });
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

  it("正文超预算的章回炉压短（模型只删不加），压短后的正文进交付物", async () => {
    // 现状章第一节的正文灌水到超预算（解决方案现状章预算 1000 字）
    const filler = "现状特征与提升空间";
    const fat = goodReport("solution").replace(
      `${filler}的归纳正文。`,
      `${filler}的归纳正文。`.repeat(80),
    );
    const squeezed = goodReport("solution").replace(`${filler}的归纳正文。`, "压短后的现状结论。");
    const { client, calls } = dshByPrompt((input) => {
      if (kindOfPrompt(input) !== "solution") return goodReport("construction");
      return input.user.includes("压到") ? squeezed : fat;
    });
    await run(h.db, client, h.scenarioId);

    const saved = readFileSync(join(h.dir, `${h.scenarioId}.solution.md`), "utf8");
    expect(saved).toContain("压短后的现状结论。");
    expect(calls.some((p) => p.includes("压到"))).toBe(true);
  });

  it("压缩把方案构件压没 → 作废这次压缩，保留原正文（缺构件比偏长更糟）", async () => {
    const filler = "现状特征与提升空间";
    const fat = goodReport("solution").replace(
      `${filler}的归纳正文。`,
      `${filler}的归纳正文。`.repeat(80),
    );
    // 压缩结果更短，但整章的小节结构被压平（原本 3 个小节，压完一个标题都没有）→ 不能采用
    const lost = "## 现状\n\n只留一句话，小节标题被压没了。";
    const { client } = dshByPrompt((input) => {
      if (kindOfPrompt(input) !== "solution") return goodReport("construction");
      return input.user.includes("压到") ? lost : fat;
    });
    await run(h.db, client, h.scenarioId);
    const saved = readFileSync(join(h.dir, `${h.scenarioId}.solution.md`), "utf8");
    expect(saved).toContain(`${filler}的归纳正文。`.repeat(80));
    expect(saved).not.toContain("小节标题被压没了");
  });

  it("压缩只删叙述、结构与构件都在 → 采用压缩结果", async () => {
    const filler = "现状特征与提升空间";
    const fat = goodReport("solution").replace(
      `${filler}的归纳正文。`,
      `${filler}的归纳正文。`.repeat(80),
    );
    // 同一章、小节标题与构件都保留，只是把灌水的叙述压成一句话
    const tight = fat.replace(`${filler}的归纳正文。`.repeat(80), "压短后的现状结论。");
    const { client } = dshByPrompt((input) => {
      if (kindOfPrompt(input) !== "solution") return goodReport("construction");
      return input.user.includes("压到") ? tight : fat;
    });
    await run(h.db, client, h.scenarioId);
    const saved = readFileSync(join(h.dir, `${h.scenarioId}.solution.md`), "utf8");
    expect(saved).toContain("压短后的现状结论。");
  });

  it("压缩稿带断头段 → 先修再采纳（不是整章退回），落盘正文既更短又没有半句话", async () => {
    const filler = "现状特征与提升空间";
    const fat = goodReport("solution").replace(
      `${filler}的归纳正文。`,
      `${filler}的归纳正文。`.repeat(80),
    );
    // 压缩稿：灌水删掉了（确实更短），但把一句话砍成了半句——段首留下「、」
    const broken = goodReport("solution").replace(
      `${filler}的归纳正文。`,
      "、Teams 等云平台；多园区由 IT 支持。",
    );
    const { client } = dshByPrompt((input) => {
      if (kindOfPrompt(input) !== "solution") return goodReport("construction");
      return input.user.includes("压到") ? broken : fat;
    });
    const events = await run(h.db, client, h.scenarioId);

    // 按章标题切（不能用 `split("## 现状")`：正文里的 `### 现状特征与提升空间` 也含这个子串）
    const chapterOf = (md: string): string =>
      md.split(/\n(?=## )/).find((p) => p.startsWith("## 现状")) ?? "";
    const saved = readFileSync(join(h.dir, `${h.scenarioId}.solution.md`), "utf8");
    const chapter = chapterOf(saved);
    // 断头段被修掉：段首残标点与残句头都不在了，剩下的是完整句
    expect(chapter).not.toContain("、Teams");
    expect(chapter).toContain("多园区由 IT 支持。");
    // 该章其它内容（小节与结论）仍在
    expect(chapter).toContain(`### ${filler}`);
    // 是"修完再采纳"，不是"整章退回原稿"：采纳后的这一章仍明显短于灌水版
    expect(chapter.length).toBeLessThan(chapterOf(fat).length);
    expect(chapter).not.toContain(`### ${filler}\n\n${`${filler}的归纳正文。`.repeat(80)}`);
    // 进度里明说修了几处断头句
    const progress = events
      .filter((e) => e.type === "progress")
      .map((e) => String(e["message"] ?? ""));
    expect(progress.some((m) => m.includes("修掉 1 处断头句"))).toBe(true);
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
    const { client, calls } = dshByPrompt(() => bad);
    const events = await run(h.db, client, h.scenarioId);

    // 每个口径：整篇写 2 次（重写）+ 缺章补写 1 次 = 3 次；两份共 6 次
    expect(calls.length).toBe(6);
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
      const kind = kindOfPrompt(input);
      const n = (seen.get(kind) ?? 0) + 1;
      seen.set(kind, n);
      const good = goodReport(kind);
      // 第一次带内部痕迹，第二次是干净版
      return n === 1 ? good.replace(/^(## .+)$/m, "$1\n\n见 表3-8，来源：客户台账。") : good;
    });
    const events = await run(h.db, client, h.scenarioId);
    // 泄漏被拦下重写一次，重写版是干净的两份
    expect(calls.length).toBe(4);
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
    const line = empty.productLineRepo.insert({ name: "空线" });
    const sc = empty.scenarioRepo.insert({
      name: "空场景",
      product_line_id: line.id,
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
