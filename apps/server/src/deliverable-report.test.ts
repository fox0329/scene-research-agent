/**
 * @scene/server — 交付物报告生成测试（变更表 #112 / #136）
 *
 * 真 SQLite（:memory:）+ mock dshClient：覆盖「模型撰写 → 确定性校验 → 逐章兜底 → 落盘」
 * 全链路，以及三条铁律（五章齐全 / 不给决策建议 / 不带内部信息痕迹）在模型不听话时的行为。
 *
 * 变更表 #136 起交付物只有一份《<场景>解决方案》（落盘 `<场景 id>.solution.md`），
 * 不再有「内部调研报告 / 对外汇报材料」两份口径，也没有「主要风险点」章与附录/术语表。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportChapterHeading, reportChapters } from "@scene/contract";
import type { DshClient, FollowEvent } from "@scene/contract";
import { createDb } from "@scene/infra";
import type { DbInstance } from "@scene/infra";
import { createDeliverableReportCommand, splitReportChapters } from "./deliverable-report.js";
import { getReport } from "./report-service.js";

/** 章节 + 方案构件都齐的"好"报告（模拟模型照要求作答） */
function goodReport(): string {
  return reportChapters()
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
      return `## ${reportChapterHeading(c.key)}\n\n${body}`;
    })
    .join("\n\n");
}

/** 让 mock 逐次返回不同文本（用于验证"重写一次"） */
function dshOf(responses: string[]): { client: DshClient; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const client = {
    createSession: async ({ title }: { title: string }) => ({ sessionId: `s-${title}` }),
    prompt: (_h: unknown, input: { user: string }) => {
      calls.push(input.user);
      const text = responses[Math.min(i++, responses.length - 1)] ?? "";
      return (async function* (): AsyncGenerator<FollowEvent> {
        yield { type: "text", text };
        yield { type: "done" };
      })();
    },
    cancel: async () => {},
  } as unknown as DshClient;
  return { client, calls };
}

/** 按提示词内容决定返回什么（整篇撰写与压缩回炉靠提示词区分） */
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
async function run(db: DbInstance, dsh: DshClient, scenarioId: string): Promise<FollowEvent[]> {
  const cmd = createDeliverableReportCommand({ db, dshClient: dsh, keepaliveMs: 10_000 });
  const events: FollowEvent[] = [];
  for await (const e of await cmd.execute({ scenarioId })) events.push(e);
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

describe("交付物报告生成（模型撰写 + 确定性校验）", () => {
  it("模型写好五章 → 落盘一份，全部来自模型，done 事件带字数", async () => {
    const { client } = dshOf([goodReport()]);
    const events = await run(h.db, client, h.scenarioId);

    const done = events.find((e) => e.type === "done")!;
    expect(done).toBeDefined();
    const sources = done["sources"] as { kind: string; from: string }[];
    expect(sources).toHaveLength(5);
    expect(sources.every((s) => s.kind === "solution" && s.from === "模型")).toBe(true);
    const report = done["report"] as { solution_chars: number };
    expect(report.solution_chars).toBeGreaterThan(0);
    // 变更表 #136：不再有 internal_chars / external_chars 两个字数
    expect(report).not.toHaveProperty("internal_chars");
    expect(report).not.toHaveProperty("external_chars");

    const path = join(h.dir, `${h.scenarioId}.solution.md`);
    expect(existsSync(path)).toBe(true);
    // 两份口径的旧文件不再落盘
    expect(existsSync(join(h.dir, `${h.scenarioId}.internal.md`))).toBe(false);
    expect(existsSync(join(h.dir, `${h.scenarioId}.external.md`))).toBe(false);

    const saved = readFileSync(path, "utf8");
    expect(saved).toContain("## 现状");
    expect(saved).toContain("## 方案");
    expect(saved).toContain("## 价值");
    expect(saved).toContain("## 下一步");
    // 章标题不带手写序号（编号交给 Word 自动编号）
    expect(saved).not.toContain("## 一、");
    // 内部口径的章与附录都已退场（变更表 #136）
    expect(saved).not.toContain("主要风险点");
    expect(saved).not.toContain("附录");
    expect(saved).not.toContain("术语表");
  });

  it("正文超预算的章回炉压短（模型只删不加），压短后的正文进交付物", async () => {
    // 现状章第一节的正文灌水到超预算（预算 1000 字）
    const filler = "现状特征与提升空间";
    const fat = goodReport().replace(
      `${filler}的归纳正文。`,
      `${filler}的归纳正文。`.repeat(80),
    );
    const squeezed = goodReport().replace(`${filler}的归纳正文。`, "压短后的现状结论。");
    const { client, calls } = dshOf([fat, squeezed]);
    await run(h.db, client, h.scenarioId);

    const saved = readFileSync(join(h.dir, `${h.scenarioId}.solution.md`), "utf8");
    expect(saved).toContain("压短后的现状结论。");
    expect(calls.some((p) => p.includes("压到"))).toBe(true);
  });

  it("压缩把方案构件压没 → 作废这次压缩，保留原正文（缺构件比偏长更糟）", async () => {
    const filler = "现状特征与提升空间";
    const fat = goodReport().replace(
      `${filler}的归纳正文。`,
      `${filler}的归纳正文。`.repeat(80),
    );
    // 压缩结果更短，但整章的小节结构被压平（原本 3 个小节，压完一个标题都没有）→ 不能采用
    const lost = "## 现状\n\n只留一句话，小节标题被压没了。";
    const { client } = dshByPrompt(({ user }) => (user.includes("压到") ? lost : fat));
    await run(h.db, client, h.scenarioId);
    const saved = readFileSync(join(h.dir, `${h.scenarioId}.solution.md`), "utf8");
    expect(saved).toContain(`${filler}的归纳正文。`.repeat(80));
    expect(saved).not.toContain("小节标题被压没了");
  });

  it("压缩只删叙述、结构与构件都在 → 采用压缩结果", async () => {
    const filler = "现状特征与提升空间";
    const fat = goodReport().replace(
      `${filler}的归纳正文。`,
      `${filler}的归纳正文。`.repeat(80),
    );
    // 同一章、小节标题与构件都保留，只是把灌水的叙述压成一句话
    const tight = fat.replace(`${filler}的归纳正文。`.repeat(80), "压短后的现状结论。");
    const { client } = dshByPrompt(({ user }) => (user.includes("压到") ? tight : fat));
    await run(h.db, client, h.scenarioId);
    const saved = readFileSync(join(h.dir, `${h.scenarioId}.solution.md`), "utf8");
    expect(saved).toContain("压短后的现状结论。");
  });

  it("交付物不装内部附录，也不出现内部表号与内部口径的章", async () => {
    const { client } = dshOf([goodReport()]);
    await run(h.db, client, h.scenarioId);
    const saved = readFileSync(join(h.dir, `${h.scenarioId}.solution.md`), "utf8");
    // 内部附录、术语表、主要风险点章都已不存在（变更表 #136）
    expect(saved).not.toContain("来源索引");
    expect(saved).not.toContain("信息覆盖概览");
    expect(saved).not.toContain("附录");
    expect(saved).not.toContain("术语表");
    expect(saved).not.toContain("主要风险点");
    expect(saved).not.toMatch(/表\d+-\d+/);
  });

  it("模型漏章 + 写决策建议 → 重写一次；仍不达标则该章用要点版兜底", async () => {
    const bad = "## 现状\n\n我方建议优先投入到试点。";
    const { client, calls } = dshOf([bad, bad]);
    const events = await run(h.db, client, h.scenarioId);

    // 单份报告：整篇写 2 次（重写）+ 缺章补写 1 次 = 3 次
    expect(calls.length).toBe(3);
    expect(calls.some((c) => c.includes("只写下面这几节"))).toBe(true);
    expect(calls[1]).toContain("上一次的问题");

    const done = events.find((e) => e.type === "done")!;
    expect((done["violations"] as { hard: boolean }[]).some((v) => v.hard)).toBe(true);
    const saved = readFileSync(join(h.dir, `${h.scenarioId}.solution.md`), "utf8");
    // 缺的章由确定性要点版补上：章节齐全
    for (const c of reportChapters()) {
      expect(saved).toContain(`## ${reportChapterHeading(c.key)}`);
    }
  });

  it("交付物泄漏内部信息 → 硬伤，触发重写；重写合格即通过", async () => {
    const leaking = goodReport().replace(
      "## 场景与问题",
      "## 场景与问题\n\n见 表3-8，来源：客户台账。",
    );
    const { client, calls } = dshOf([leaking, goodReport()]);
    const events = await run(h.db, client, h.scenarioId);
    // 泄漏被拦下重写一次，重写版是干净的五章
    expect(calls.length).toBe(2);
    const done = events.find((e) => e.type === "done")!;
    expect((done["violations"] as { hard: boolean }[]).filter((v) => v.hard)).toEqual([]);
    const saved = readFileSync(join(h.dir, `${h.scenarioId}.solution.md`), "utf8");
    expect(saved).not.toMatch(/表\d+-\d+/);
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
    const { client, calls } = dshOf([goodReport()]);
    const events = await run(empty, client, sc.id);
    expect(events[0]!.type).toBe("error");
    expect(calls.length).toBe(0);
  });
});

describe("报告服务：正式版优先，没有则要点版", () => {
  it("未生成时返回要点版（generated=false），生成后返回正式版", async () => {
    const db = h.db;
    const scenario = db.scenarioRepo.getById(h.scenarioId)!;
    const before = getReport(db, scenario);
    expect(before.kind).toBe("solution");
    expect(before.generated).toBe(false);
    expect(before.markdown).toContain("## 现状");
    // 要点版只有数据要点，没有模型写的价值表
    expect(before.markdown).not.toContain("价值一：会前不再逐台开机");

    const { client } = dshOf([goodReport()]);
    await run(db, client, h.scenarioId);
    const after = getReport(db, scenario);
    expect(after.generated).toBe(true);
    expect(after.generated_at).toBeTruthy();
    // 读到的是模型撰写的正式版（`<id>.solution.md`），不是即时推导的要点版
    expect(after.markdown).toContain("价值一：会前不再逐台开机");
  });
});

describe("splitReportChapters：模型输出的分章解析", () => {
  it("按 ## 章名切分并忽略序号差异", () => {
    const map = splitReportChapters("## 一、现状\n甲\n## 三、方案\n乙");
    expect(map.get("status")).toBe("甲");
    expect(map.get("solution")).toBe("乙");
  });

  it("章名前有杂音、章内出现 ### 小标题都不影响切分", () => {
    const map = splitReportChapters("## 二、场景与问题\n### 小节\n内容");
    expect(map.get("problems")).toContain("### 小节");
  });
});

describe("splitReportChapters：同义章名与补写兜底", () => {
  it("模型写「场景概述」「解决方案」这类同义标题也认得出是哪一章", () => {
    const map = splitReportChapters("## 一、场景概述\n内容甲\n## 三、解决方案\n内容乙");
    expect(map.get("status")).toBe("内容甲");
    expect(map.get("solution")).toBe("内容乙");
  });

  it("补写某一章时模型没写 `## 章名`：整段归给这一章（内容不丢）", () => {
    const map = splitReportChapters("现状正文，没有标题。", ["status"]);
    expect(map.get("status")).toBe("现状正文，没有标题。");
  });

  it("补写多章时不套用整段兜底（避免把两章内容混成一章）", () => {
    const map = splitReportChapters("没有标题的正文", ["status", "next"]);
    expect(map.size).toBe(0);
  });
});
