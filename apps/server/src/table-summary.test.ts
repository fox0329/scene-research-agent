import { describe, expect, it, vi } from "vitest";
import type { DshClient } from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { SUMMARY_MAX_CHARS, cleanSummary, ensureTableSummary, summaryPromptOf } from "./table-summary.js";

function mockDb(rows: Array<Record<string, unknown>>, existing?: string): DbInstance & {
  saved: Map<string, string>;
} {
  const saved = new Map<string, string>();
  if (existing) saved.set(`sc-1:表2-4`, existing);
  const db = {
    tableSummaryRepo: {
      get: (sid: string, code: string) => {
        const s = saved.get(`${sid}:${code}`);
        return s ? { scenario_id: sid, table_code: code, summary: s, created_at: "", updated_at: "" } : undefined;
      },
      listByScenario: () => [],
      upsert: (sid: string, code: string, summary: string) => {
        saved.set(`${sid}:${code}`, summary);
        return { scenario_id: sid, table_code: code, summary, created_at: "", updated_at: "" };
      },
      removeScenario: () => 0,
    },
    stageDataRepo: {
      list: () => rows.map((row, i) => ({ id: `r${i}`, row })),
    },
  } as unknown as DbInstance;
  return Object.assign(db, { saved });
}

function mockClient(text: string): DshClient {
  return {
    createSession: vi.fn(async () => ({ sessionId: "s" })),
    prompt: vi.fn(async function* () {
      yield { type: "text", text };
      yield { type: "done" };
    }),
    cancel: vi.fn(async () => {}),
  } as unknown as DshClient;
}

describe("表级内容总结（用户定调 2026-11-03：总结的是已填内容）", () => {
  it("提示词只喂这张表的中栏内容，并要求总结内容而非表用途", () => {
    const prompt = summaryPromptOf("表2-4", [
      { interaction_type: "液位触发", from_to: "低浮球→1号泵", method: "浮球闭合启泵" },
    ] as never);
    expect(prompt).toContain("交互类型：液位触发");
    expect(prompt).toContain("共 1 行");
    expect(prompt).toContain(`不超过 ${SUMMARY_MAX_CHARS} 个汉字总结这些内容`);
    // 来源类列不进上下文
    expect(prompt).not.toContain("source");
  });

  it("清洗掉前缀、引号，超长截断", () => {
    expect(cleanSummary("总结：十类交互，七类有依据")).toBe("十类交互，七类有依据");
    expect(cleanSummary("“一句话”")).toBe("一句话");
    // 用户定调 2026-11-03：不要「表5-1共13行：」这种开头，直接写总结
    expect(cleanSummary("表5-1共13行：4个架构层加9条接口，核心是CT15控制器")).toBe(
      "4个架构层加9条接口，核心是CT15控制器",
    );
    expect(cleanSummary("表 5-1（共 13 行）：摘要正文")).toBe("表 5-1（共 13 行）：摘要正文");
    expect(cleanSummary("共13行：一句话内容")).toBe("一句话内容");
    expect(Array.from(cleanSummary("一".repeat(200)))).toHaveLength(SUMMARY_MAX_CHARS);
  });

  it("已缓存直接返回，不再调模型", async () => {
    const db = mockDb([{ interaction_type: "x" }], "旧摘要");
    const client = mockClient("新摘要");
    expect(await ensureTableSummary({ db, dshClient: client }, "sc-1", "表2-4")).toBe("旧摘要");
    expect(client.prompt).not.toHaveBeenCalled();
  });

  it("空表不生成（没内容可总结）", async () => {
    const db = mockDb([]);
    const client = mockClient("不该出现");
    expect(await ensureTableSummary({ db, dshClient: client }, "sc-1", "表2-4")).toBeNull();
    expect(client.prompt).not.toHaveBeenCalled();
  });

  it("有内容时生成并落库", async () => {
    const db = mockDb([{ interaction_type: "液位触发", method: "浮球启泵" }]);
    const client = mockClient("十类交互，均围绕浮球与平台联动");
    expect(await ensureTableSummary({ db, dshClient: client }, "sc-1", "表2-4")).toBe(
      "十类交互，均围绕浮球与平台联动",
    );
    expect(db.saved.get("sc-1:表2-4")).toBe("十类交互，均围绕浮球与平台联动");
  });

  it("模型把总结包在 JSON 里也能取出来", async () => {
    const db = mockDb([{ method: "x" }]);
    const client = mockClient('{"summary":"一句话说完的内容总结"}');
    expect(await ensureTableSummary({ db, dshClient: client }, "sc-1", "表2-4")).toBe(
      "一句话说完的内容总结",
    );
  });
});
