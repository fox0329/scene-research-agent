import { describe, it, expect, vi } from "vitest";
import type { DshClient, FollowEvent, ScenarioBrief } from "@scene/contract";
import { createDb } from "@scene/infra";
import { anchorConfirmRows } from "@scene/domain";
import {
  readAnchorRows,
  ensureAnchorRows,
  writeAnchorRows,
  syncDerivedDescription,
  readBrief,
  upsertBrief,
  draftAnchor,
  normalizeDraftItems,
} from "./scenario-anchor.js";

// ─── 测试脚手架 ────────────────────────────────────────────

function mockDsh(events: FollowEvent[]): DshClient {
  return {
    createSession: vi.fn(async () => ({ sessionId: "dsh-1" })),
    prompt: vi.fn(async function* (): AsyncGenerator<FollowEvent> {
      for (const e of events) yield e;
    }),
    cancel: vi.fn(async () => {}),
  };
}

function setup(): { db: ReturnType<typeof createDb>; scenarioId: string } {
  const db = createDb(":memory:");
  const line = db.productLineRepo.insert({ name: "感知与控制" });
  const scenario = db.scenarioRepo.insert({
    name: "智慧水务",
    description: null,
    product_line_id: line.id,
    status: "进行中",
    current_stage: 0,
  });
  return { db, scenarioId: scenario.id };
}

const brief = (scenarioId: string): ScenarioBrief => ({
  scenario_id: scenarioId,
  scene_name: "智慧水务",
  intent: "想搞清楚这个场景值不值得进",
  customer_hint: "市政水务集团",
  region_hint: "华东某市",
  scope_hint: "只看出厂到管网",
  audience: "给领导看",
  deadline: "两周",
  raw_text: "智慧水务 / 想搞清楚这个场景值不值得进",
  created_at: "2026-09-25T00:00:00.000Z",
  updated_at: "2026-09-25T00:00:00.000Z",
});

// ─── 锚行读写 ──────────────────────────────────────────────

describe("scenario-anchor — 锚骨架", () => {
  it("ensureAnchorRows 建 12 行骨架且幂等", () => {
    const { db, scenarioId } = setup();
    const rows = ensureAnchorRows(db, scenarioId, "智慧水务");
    expect(rows).toHaveLength(12);
    expect(rows[0]?.item).toBe("场景名称");
    expect(rows[0]?.content).toBe("智慧水务");
    // 幂等：再次调用不新增
    expect(ensureAnchorRows(db, scenarioId, "智慧水务")).toHaveLength(12);
    expect(readAnchorRows(db, scenarioId)).toHaveLength(12);
  });

  it("锚行落在 stage_data 的 stage=1 / table_code=表1-1", () => {
    const { db, scenarioId } = setup();
    ensureAnchorRows(db, scenarioId, "智慧水务");
    const stored = db.stageDataRepo.listByScenarioStage(scenarioId, 1);
    expect(stored).toHaveLength(12);
    expect(stored.every((r) => r.table_code === "表1-1")).toBe(true);
  });
});

describe("scenario-anchor — 锚行写入与派生缓存", () => {
  it("按 item upsert（不重复插入），并按固定行顺序返回", () => {
    const { db, scenarioId } = setup();
    ensureAnchorRows(db, scenarioId, "智慧水务");
    writeAnchorRows(db, scenarioId, [{ item: "覆盖什么", content: "制水到输配" }]);
    writeAnchorRows(db, scenarioId, [{ item: "覆盖什么", content: "制水到输配（含二次供水）" }]);
    const rows = readAnchorRows(db, scenarioId);
    expect(rows).toHaveLength(12);
    expect(rows.find((r) => r.item === "覆盖什么")?.content).toBe("制水到输配（含二次供水）");
  });

  it("内容被清空时，来源/确认态一并清掉（不留「空内容 + AI推断」的自相矛盾行）", () => {
    const { db, scenarioId } = setup();
    ensureAnchorRows(db, scenarioId, "智慧水务");
    writeAnchorRows(db, scenarioId, [
      { item: "买方类型", content: "园区开发主体", source_type: "AI推断", source: "系统推断", confirm_state: "系统推断" },
    ]);
    // 先确认它带着来源
    expect(readAnchorRows(db, scenarioId).find((r) => r.item === "买方类型")?.source_type).toBe("AI推断");

    // 「重新整理定义」清空该行 → 来源列也必须清（否则界面显示"空内容 + 系统推断"）
    writeAnchorRows(db, scenarioId, [{ item: "买方类型", content: "" }]);
    const col = db.stageDataRepo
      .list({ where: "scenario_id = ? AND table_code = ?", params: [scenarioId, "表1-1"] })
      .find((r) => r.row["item"] === "买方类型");
    expect(col?.source_type ?? null).toBeNull();
    expect(col?.source ?? null).toBeNull();
  });

  it("syncDerivedDescription 由锚行生成 description（派生缓存）", () => {
    const { db, scenarioId } = setup();
    ensureAnchorRows(db, scenarioId, "智慧水务");
    writeAnchorRows(db, scenarioId, [
      { item: "客户类型/行业", content: "市政水务集团" },
      { item: "核心用途", content: "漏损监测" },
    ]);
    const text = syncDerivedDescription(db, scenarioId);
    expect(text).toContain("客户类型/行业：市政水务集团");
    expect(text).toContain("核心用途：漏损监测");
    expect(db.scenarioRepo.getById(scenarioId)?.description).toBe(text);
  });

  it("锚行为空时派生缓变为 null（不留旧文本）", () => {
    const { db, scenarioId } = setup();
    ensureAnchorRows(db, scenarioId, "智慧水务");
    // 只留空内容
    writeAnchorRows(db, scenarioId, [{ item: "场景名称", content: "" }]);
    expect(syncDerivedDescription(db, scenarioId)).toBe("");
    expect(db.scenarioRepo.getById(scenarioId)?.description).toBeNull();
  });
});

// ─── 场景诉求 ──────────────────────────────────────────────

describe("scenario-anchor — 场景诉求", () => {
  it("upsert 写入并读回；场景名同步到 scenario.name", () => {
    const { db, scenarioId } = setup();
    const b = upsertBrief(db, scenarioId, {
      scene_name: "智慧水务（华东）",
      intent: "想搞清楚值不值得进",
      customer_hint: "市政水务集团",
    });
    expect(b.intent).toBe("想搞清楚值不值得进");
    expect(readBrief(db, scenarioId)?.customer_hint).toBe("市政水务集团");
    expect(db.scenarioRepo.getById(scenarioId)?.name).toBe("智慧水务（华东）");
  });

  it("raw_text 首次写入后不再被改写（它是确认基准）", () => {
    const { db, scenarioId } = setup();
    const first = upsertBrief(db, scenarioId, { scene_name: "智慧水务", intent: "看值不值得进" });
    expect(first.raw_text).toContain("想搞清楚什么：看值不值得进");
    const second = upsertBrief(db, scenarioId, { intent: "改成看怎么做方案" });
    expect(second.intent).toBe("改成看怎么做方案");
    expect(second.raw_text).toBe(first.raw_text); // 基准不动
  });

  it("空字符串线索规整为 null", () => {
    const { db, scenarioId } = setup();
    const b = upsertBrief(db, scenarioId, { scene_name: "x", intent: "y", customer_hint: "   " });
    expect(b.customer_hint).toBeNull();
  });
});

// ─── 起草 ──────────────────────────────────────────────────

describe("scenario-anchor — 起草", () => {
  const draftJson = JSON.stringify({
    items: [
      { item: "客户类型/行业", content: "市政水务集团", source_type: "AI提取", source: "《招标》p.2" },
      { item: "覆盖什么", content: "制水到输配", source_type: "AI提取" },
      { item: "核心用途", content: "漏损监测", source_type: "AI推断" },
      { item: "不存在的项", content: "应被丢弃", source_type: "AI提取" },
    ],
    open_questions: ["你说的智慧水务是供水还是排水？", "客户是集团还是市政部门？", "第三问", "第四问应被截断"],
  });

  it("normalizeDraftItems 丢弃非固定项，且 source_type 只接受 AI提取/AI推断", () => {
    const rows = normalizeDraftItems({
      items: [
        { item: "客户类型/行业", content: "x", source_type: "用户确认" },
        { item: "乱写的项", content: "y", source_type: "AI提取" },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source_type).toBe("AI推断"); // 不接受模型自称用户确认
  });

  it("起草成功：写锚行 + 重算缓存 + 发进场景梳理对话；待确认点最多 3 个", async () => {
    const { db, scenarioId } = setup();
    const scenario = db.scenarioRepo.getById(scenarioId)!;
    const dsh = mockDsh([
      { type: "text", text: draftJson },
      { type: "done" },
    ]);
    const out = await draftAnchor(db, dsh, scenario, brief(scenarioId));

    expect(out.usedLlm).toBe(true);
    expect(out.openQuestions).toHaveLength(3);
    const rows = readAnchorRows(db, scenarioId);
    expect(rows).toHaveLength(12);
    expect(rows.find((r) => r.item === "客户类型/行业")?.content).toBe("市政水务集团");
    expect(rows.find((r) => r.item === "客户类型/行业")?.source_type).toBe("AI提取");
    expect(rows.find((r) => r.item === "核心用途")?.source_type).toBe("AI推断");
    expect(rows.some((r) => r.item === "不存在的项")).toBe(false);
    // 派生缓存已写入
    expect(db.scenarioRepo.getById(scenarioId)?.description).toContain("市政水务集团");
    // 对话与消息落库
    const conv = db.conversationRepo.getById(out.conversationId);
    expect(conv?.title).toBe("场景梳理");
    const msgs = db.messageRepo.list({ where: "conversation_id = ?", params: [out.conversationId] });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.content).toContain("场景认识草稿");
  });

  it("起草不覆盖用户已确认的行（用户的决定优先）", async () => {
    const { db, scenarioId } = setup();
    ensureAnchorRows(db, scenarioId, "智慧水务");
    writeAnchorRows(db, scenarioId, [
      { item: "客户类型/行业", content: "市政水务集团（含排水）", source_type: "用户确认" },
    ]);
    const scenario = db.scenarioRepo.getById(scenarioId)!;
    const dsh = mockDsh([{ type: "text", text: draftJson }, { type: "done" }]);
    await draftAnchor(db, dsh, scenario, brief(scenarioId));
    const rows = readAnchorRows(db, scenarioId);
    expect(rows.find((r) => r.item === "客户类型/行业")?.content).toBe("市政水务集团（含排水）");
    expect(rows.find((r) => r.item === "客户类型/行业")?.source_type).toBe("用户确认");
  });

  it("LLM 失败时降级为按用户线索预填，不阻断", async () => {
    const { db, scenarioId } = setup();
    const scenario = db.scenarioRepo.getById(scenarioId)!;
    const dsh: DshClient = {
      createSession: vi.fn(async () => ({ sessionId: "s" })),
      prompt: vi.fn(() => {
        throw new Error("no key");
      }),
      cancel: vi.fn(async () => {}),
    };
    const out = await draftAnchor(db, dsh, scenario, brief(scenarioId));
    expect(out.usedLlm).toBe(false);
    const rows = readAnchorRows(db, scenarioId);
    expect(rows).toHaveLength(12);
    expect(rows.find((r) => r.item === "场景名称")?.content).toBe("智慧水务");
    expect(rows.find((r) => r.item === "客户类型/行业")?.content).toBe("市政水务集团");
    expect(rows.find((r) => r.item === "覆盖什么")?.source_type).toBe("用户补充");
    // 对话消息提示是降级态
    const msgs = db.messageRepo.list({ where: "conversation_id = ?", params: [out.conversationId] });
    expect(msgs[0]?.content).toContain("起草暂时不可用");
  });

  it("重复起草复用同一个「场景梳理」对话", async () => {
    const { db, scenarioId } = setup();
    const scenario = db.scenarioRepo.getById(scenarioId)!;
    const dsh = mockDsh([{ type: "text", text: draftJson }, { type: "done" }]);
    const a = await draftAnchor(db, dsh, scenario, brief(scenarioId));
    const b = await draftAnchor(db, dsh, scenario, brief(scenarioId));
    expect(b.conversationId).toBe(a.conversationId);
  });

  it("起草后 L1 六项仍未被确认（起草不等于确认）", async () => {
    const { db, scenarioId } = setup();
    const scenario = db.scenarioRepo.getById(scenarioId)!;
    const dsh = mockDsh([{ type: "text", text: draftJson }, { type: "done" }]);
    await draftAnchor(db, dsh, scenario, brief(scenarioId));
    const rows = readAnchorRows(db, scenarioId);
    const l1 = anchorConfirmRows().map((r) => r.label);
    const l1Rows = rows.filter((r) => l1.includes(r.item));
    expect(l1Rows.length).toBeGreaterThan(0);
    expect(l1Rows.every((r) => r.source_type !== "用户确认")).toBe(true);
  });
});
