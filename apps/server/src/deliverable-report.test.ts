/**
 * @scene/server — 交付物报告生成测试（变更表 #112）
 *
 * 真 SQLite（:memory:）+ mock dshClient：覆盖「模型撰写 → 确定性校验 → 逐章兜底 → 落盘」
 * 全链路，以及三条铁律（六章齐全 / 不给决策建议 / 对外不带内部信息）在模型不听话时的行为。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPORT_CHAPTERS } from "@scene/contract";
import type { DshClient, FollowEvent } from "@scene/contract";
import { createDb } from "@scene/infra";
import type { DbInstance } from "@scene/infra";
import { createDeliverableReportCommand, splitReportChapters } from "./deliverable-report.js";
import { getReport, getReportPair } from "./report-service.js";

/** 六章齐全的"好"报告 */
function goodReport(kind: "internal" | "external"): string {
  return REPORT_CHAPTERS.map(
    (c) =>
      `## ${c.title}\n\n${c.title}的归纳正文。这里把同一类信息合并成结论，而不是逐行搬运表格。` +
      (kind === "internal" && c.key === "summary" ? "风险在于设备协议私有；边界写明不做什么。" : ""),
  ).join("\n\n");
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
  it("模型写好六章 → 落盘两份，全部来自模型，done 事件带字数", async () => {
    const { client } = dshOf([goodReport("internal"), goodReport("external")]);
    const events = await run(h.db, client, h.scenarioId);

    const done = events.find((e) => e.type === "done")!;
    expect(done).toBeDefined();
    const sources = done["sources"] as { kind: string; from: string }[];
    expect(sources.filter((s) => s.kind === "internal").every((s) => s.from === "模型")).toBe(true);

    expect(existsSync(join(h.dir, `${h.scenarioId}.internal.md`))).toBe(true);
    expect(existsSync(join(h.dir, `${h.scenarioId}.external.md`))).toBe(true);
    const internal = readFileSync(join(h.dir, `${h.scenarioId}.internal.md`), "utf8");
    expect(internal).toContain("## 一、场景定义");
    expect(internal).toContain("## 六、总结");
    // 内部版带附录（来源索引 / 覆盖概览）
    expect(internal).toContain("附录 A、来源索引");
    expect(internal).toContain("附录 B、信息覆盖概览");
  });

  it("对外版不装内部附录，也不出现内部表号", async () => {
    const { client } = dshOf([goodReport("internal"), goodReport("external")]);
    await run(h.db, client, h.scenarioId);
    const external = readFileSync(join(h.dir, `${h.scenarioId}.external.md`), "utf8");
    expect(external).not.toContain("附录");
    expect(external).not.toMatch(/表\d+-\d+/);
  });

  it("模型漏章 + 写决策建议 → 重写一次；仍不达标则该章用要点版兜底", async () => {
    const bad = "## 一、场景定义\n\n我方建议优先投入到试点。";
    const { client, calls } = dshOf([bad, bad]);
    const events = await run(h.db, client, h.scenarioId);

    // 每份报告：整篇写 2 次（重写）+ 缺章补写 1 次 = 3 次，两份共 6 次
    expect(calls.length).toBe(6);
    expect(calls.some((c) => c.includes("只写下面这几节"))).toBe(true);
    expect(calls[1]).toContain("上一次的问题");

    const done = events.find((e) => e.type === "done")!;
    expect((done["violations"] as { hard: boolean }[]).some((v) => v.hard)).toBe(true);
    const internal = readFileSync(join(h.dir, `${h.scenarioId}.internal.md`), "utf8");
    // 缺的章由确定性要点版补上：六章齐全
    for (const c of REPORT_CHAPTERS) expect(internal).toContain(c.title);
  });

  it("对外材料泄漏内部信息 → 硬伤，触发重写；重写合格即通过", async () => {
    const leaking = goodReport("external").replace("## 二、场景认识", "## 二、场景认识\n\n见 表3-8，来源：客户台账。");
    const { client, calls } = dshOf([goodReport("internal"), leaking, goodReport("external")]);
    const events = await run(h.db, client, h.scenarioId);
    // 内部 1 次；对外 2 次（泄漏被拦下重写一次，重写版是干净的六章）
    expect(calls.length).toBe(3);
    const done = events.find((e) => e.type === "done")!;
    expect((done["violations"] as { hard: boolean }[]).filter((v) => v.hard)).toEqual([]);
    const external = readFileSync(join(h.dir, `${h.scenarioId}.external.md`), "utf8");
    expect(external).not.toMatch(/表\d+-\d+/);
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
    const { client, calls } = dshOf([goodReport("internal")]);
    const events = await run(empty, client, sc.id);
    expect(events[0]!.type).toBe("error");
    expect(calls.length).toBe(0);
  });
});

describe("报告服务：正式版优先，没有则要点版", () => {
  it("未生成时返回要点版（generated=false），生成后返回正式版", async () => {
    const db = h.db;
    const scenario = db.scenarioRepo.getById(h.scenarioId)!;
    const before = getReport(db, scenario, "internal");
    expect(before.generated).toBe(false);
    expect(before.markdown).toContain("## 一、场景定义");

    const { client } = dshOf([goodReport("internal"), goodReport("external")]);
    await run(db, client, h.scenarioId);
    const after = getReportPair(db, scenario);
    expect(after.internal.generated).toBe(true);
    expect(after.external.generated).toBe(true);
    expect(after.internal.generated_at).toBeTruthy();
  });
});

describe("splitReportChapters：模型输出的分章解析", () => {
  it("按 ## 章名切分并忽略序号差异", () => {
    const map = splitReportChapters("## 一、场景定义\n甲\n## 三、存在的问题\n乙");
    expect(map.get("scene")).toBe("甲");
    expect(map.get("problems")).toBe("乙");
  });

  it("章名前有杂音、章内出现 ### 小标题都不影响切分", () => {
    const map = splitReportChapters("## 二、场景认识\n### 小节\n内容");
    expect(map.get("understand")).toContain("### 小节");
  });
});

describe("splitReportChapters：同义章名与补写兜底", () => {
  it("模型写「场景概述」也认得出是第一段场景定义", () => {
    const map = splitReportChapters("## 一、场景概述\n内容甲\n## 三、问题\n内容乙");
    expect(map.get("scene")).toBe("内容甲");
    expect(map.get("problems")).toBe("内容乙");
  });

  it("补写某一章时模型没写 `## 章名`：整段归给这一章（内容不丢）", () => {
    const map = splitReportChapters("场景定义正文，没有标题。", ["scene"]);
    expect(map.get("scene")).toBe("场景定义正文，没有标题。");
  });

  it("补写多章时不套用整段兜底（避免把两章内容混成一章）", () => {
    const map = splitReportChapters("没有标题的正文", ["scene", "summary"]);
    expect(map.size).toBe(0);
  });
});
