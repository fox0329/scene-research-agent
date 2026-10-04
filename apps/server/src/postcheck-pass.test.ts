import { describe, it, expect } from "vitest";
import type { DshClient, FollowEvent } from "@scene/contract";
import type { InfoRow } from "@scene/domain";
import type { SourceLookup } from "@scene/domain";
import { runPostcheck, parseProblems, sanitizeFix, toPostcheckRows } from "./postcheck-pass.js";

const lookupWith = (pages: Record<string, string[]>): SourceLookup => ({
  hasSource: (ref) => Object.keys(pages).includes(ref),
  hasContent: (ref, snippet) => (pages[ref] ?? []).some((line) => line.includes(snippet)),
});

/** 假模型：按轮次返回预设的 problems；同时记录每轮 user 提示词，便于断言"增量" */
function fakeDsh(rounds: string[]): {
  client: DshClient;
  prompts: string[];
  contracts: Record<string, unknown>[];
} {
  const prompts: string[] = [];
  const contracts: Record<string, unknown>[] = [];
  let i = 0;
  const client: DshClient = {
    createSession: async () => ({ id: "s1", title: "t" }) as never,
    prompt: (_h, input) => {
      prompts.push(input.user);
      contracts.push(input.outputContract);
      const text = rounds[Math.min(i, rounds.length - 1)] ?? '{"problems":[]}';
      i++;
      return (async function* (): AsyncIterable<FollowEvent> {
        yield { type: "text", text } as FollowEvent;
        yield { type: "done" } as FollowEvent;
      })();
    },
    cancel: async () => undefined,
  };
  return { client, prompts, contracts };
}

/** 有硬伤的行：挂「已核实」但出处查不到（表1-1 的合法字段是 item/content） */
const badRow = (): InfoRow => ({
  item: "场景边界",
  content: "本方案是行业最优解",
  verification_verdict: "已核实",
  verification: "已核实：材料里有",
});

function deps(rows: { id: string; row: InfoRow; source?: string | null; sourceType?: string | null }[], extra: {
  dsh?: DshClient;
  lookup?: SourceLookup;
  fixes?: { rowId: string; row?: InfoRow; source?: string | null }[];
  progress?: string[];
}) {
  const fixes = extra.fixes ?? [];
  return {
    listRows: () => rows.map((r) => ({ id: r.id, tableCode: "表1-1", row: r.row, source: r.source, sourceType: r.sourceType })),
    lookup: extra.lookup ?? lookupWith({}),
    dshClient: extra.dsh,
    applyFix: (rowId: string, patch: { row?: InfoRow; source?: string | null }) => {
      fixes.push({ rowId, ...patch });
      const target = rows.find((r) => r.id === rowId);
      if (target && patch.row) target.row = patch.row;
    },
    onProgress: (m: string) => extra.progress?.push(m),
    scenarioName: "测试场景",
    stage: 2 as never,
    fixes,
  };
}

describe("postcheck-pass — 输出解析", () => {
  it("容忍 ```json 包裹与前后废话", () => {
    expect(parseProblems('{"problems":[{"row_id":"a"}]}')).toHaveLength(1);
    expect(parseProblems('好的，结果如下：\n```json\n{"problems":[{"row_id":"a"}]}\n```\n以上')).toHaveLength(1);
    expect(parseProblems('前言{"problems":[{"row_id":"a"}]}后记')).toHaveLength(1);
  });

  it("解析不了就返回空数组（自检不因模型胡说而崩）", () => {
    expect(parseProblems("模型今天不想输出 JSON")).toEqual([]);
    expect(parseProblems('{"problems":"不是数组"}')).toEqual([]);
  });
});

describe("postcheck-pass — 修正过滤（模型不许靠自检越权）", () => {
  const allowed = new Set(["capability", "verification", "verification_verdict"]);

  it("允许改内容字段与核实说明", () => {
    const fixed = sanitizeFix({ capability: "行业最优解" }, { capability: "当前主流做法之一" }, allowed);
    expect(fixed?.row["capability"]).toBe("当前主流做法之一");
  });

  it("不许把结论升级成「已核实」", () => {
    expect(sanitizeFix({ verification_verdict: "行业通例" }, { verification_verdict: "已核实" }, allowed)).toBeNull();
  });

  it("允许按实降级", () => {
    const fixed = sanitizeFix({ verification_verdict: "已核实" }, { verification_verdict: "无法核实" }, allowed);
    expect(fixed?.row["verification_verdict"]).toBe("无法核实");
  });

  it("丢弃未知字段、非字符串、超长值", () => {
    expect(sanitizeFix({}, { 乱造字段: "x" }, allowed)).toBeNull();
    expect(sanitizeFix({}, { capability: 123 as never }, allowed)).toBeNull();
    expect(sanitizeFix({}, { capability: "x".repeat(5000) }, allowed)).toBeNull();
  });

  it("值没变就不写库", () => {
    expect(sanitizeFix({ capability: "同" }, { capability: "同" }, allowed)).toBeNull();
  });
});

describe("postcheck-pass — 三轮自检", () => {
  it("第 1 轮全量只报告（不给修法）、第 2 轮只改被点名的、第 3 轮复查", async () => {
    const rows = [
      { id: "good", row: { item: "x", content: "正常表述" }, source: "ingest-1.pdf:1", sourceType: "AI提取" },
      { id: "bad", row: badRow(), source: "幽灵.pdf:9", sourceType: "AI提取" },
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `filler${i}`,
        row: { item: `正常${i}`, content: `常规做法${i}` },
        source: "行业通例（模型知识）",
        sourceType: "AI推断",
      })),
    ];
    const { client, prompts, contracts } = fakeDsh(['{"problems":[]}']);
    const progress: string[] = [];
    const d = deps(rows, { dsh: client, lookup: lookupWith({ "ingest-1.pdf:1": ["正常表述"] }), progress });
    await runPostcheck(d);
    // 三轮：全量报告 → 只改被点名的 → 复查（第一遍说没问题也要走完三轮）
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("共 7 行"); // 第 1 轮全量
    expect(prompts[1]).toContain("共 1 行"); // 第 2 轮只剩被点名的那行
    // 第 1 轮不允许给修法（这是成本控制：全量轮输出越小越好）
    const triageItems = (contracts[0]?.["properties"] as Record<string, unknown>)["problems"] as {
      items: { required: string[] };
    };
    expect(triageItems.items.required).not.toContain("fix");
    expect(progress.some((m) => m.includes("只改被点名的 1 行"))).toBe(true);
  });

  it("模型给出修正 → 落库、计数、复查后问题消失", async () => {
    const rows = [
      {
        id: "r1",
        row: { item: "x", content: "本方案是行业最优解", verification_verdict: "行业通例", verification: "行业通例" },
        source: "行业通例（模型知识）",
        sourceType: "AI推断",
      },
    ];
    const { client } = fakeDsh([
      // 第 1 轮：只报告
      JSON.stringify({ problems: [{ row_id: "r1", question: "客观", detail: "「行业最优解」是绝对化措辞" }] }),
      // 第 2 轮：给修法
      JSON.stringify({
        problems: [
          { row_id: "r1", question: "客观", detail: "绝对化措辞", fix: { content: "当前主流做法之一" } },
        ],
      }),
      '{"problems":[]}',
    ]);
    const d = deps(rows, { dsh: client, lookup: lookupWith({}) });
    const out = await runPostcheck(d);
    expect(out.fixedRows).toBe(1);
    expect(out.report.remaining).toBe(0);
    expect(d.fixes[0]?.row?.["content"]).toBe("当前主流做法之一");
    expect(rows[0]?.row["content"]).toBe("当前主流做法之一");
  });

  it("三轮都不改 → 硬伤按实降级为「无法核实」，原因写进核实说明", async () => {
    const rows = [{ id: "r1", row: badRow(), source: "幽灵.pdf:9", sourceType: "AI提取" }];
    const { client } = fakeDsh(['{"problems":[]}']);
    const d = deps(rows, { dsh: client, lookup: lookupWith({}) });
    const out = await runPostcheck(d);
    expect(out.downgraded).toBe(1);
    expect(rows[0]?.row["verification_verdict"]).toBe("无法核实");
    expect(String(rows[0]?.row["verification"])).toContain("生成后自检");
    // 降级行的矛盾已消解（不再是待办），但 byKind 留痕：抓到了"结论与证据矛盾"
    expect(out.report.remaining).toBe(0);
    expect(out.report.downgraded).toBe(1);
    expect(out.report.byKind["结论与证据矛盾"]).toBeGreaterThan(0);
  });

  it("模型调用失败不阻断：按确定性结果收口", async () => {
    const rows = [{ id: "r1", row: badRow(), source: "幽灵.pdf:9", sourceType: "AI提取" }];
    const failing: DshClient = {
      createSession: async () => ({ id: "s" }) as never,
      prompt: () => {
        throw new Error("模型超时");
      },
      cancel: async () => undefined,
    };
    const progress: string[] = [];
    const out = await runPostcheck(deps(rows, { dsh: failing, lookup: lookupWith({}), progress }));
    expect(out.downgraded).toBe(1);
    expect(progress.some((p) => p.includes("调用失败"))).toBe(true);
  });

  it("没有模型可用时也把确定性硬伤降级（自检不是可选项）", async () => {
    const rows = [{ id: "r1", row: badRow(), source: "幽灵.pdf:9", sourceType: "AI提取" }];
    const out = await runPostcheck(deps(rows, { lookup: lookupWith({}) }));
    expect(out.downgraded).toBe(1);
    expect(out.report.checked).toBe(1);
  });

  it("行数为 0 时直接返回空报告，不建会话", async () => {
    const { client, prompts } = fakeDsh(['{"problems":[]}']);
    const out = await runPostcheck(deps([], { dsh: client, lookup: lookupWith({}) }));
    expect(out.report.checked).toBe(0);
    expect(prompts).toEqual([]);
  });
});

describe("postcheck-pass — 行标签", () => {
  it("取中栏首列作标签（便于人定位）", () => {
    const rows = toPostcheckRows([
      { id: "x", tableCode: "表1-1", row: { item: "场景边界", content: "…" }, source: null, sourceType: null },
    ]);
    expect(rows[0]?.label).toBe("场景边界");
  });

  it("历史数据里的未知表号不炸，标签退化为占位", () => {
    const rows = toPostcheckRows([
      { id: "x", tableCode: "表9-9", row: { a: "1" }, source: null, sourceType: null },
    ]);
    expect(rows[0]?.label).toBe("(未命名条目)");
  });
});
