import { describe, it, expect } from "vitest";
import {
  parseCitations,
  keyPhrases,
  runDeterministicPostcheck,
  enforceTruthfulDowngrade,
  enforceMidCleanliness,
  splitMidCitations,
  hasCustomerFacts,
  hasMidCitation,
  MID_CELL_MAX_CHARS,
  summarizePostcheck,
  hasCustomerBaseline,
  type PostcheckRow,
  type SourceLookup,
} from "./postcheck.js";
import { TABLES_BY_CODE, middleColumns } from "@scene/contract";

/** 假材料库：只有这两页，且只含给定文字 */
const fakeLookup = (pages: Record<string, string[]>): SourceLookup => ({
  hasSource: (ref) => Object.keys(pages).includes(ref),
  hasContent: (ref, snippet) => (pages[ref] ?? []).some((line) => line.includes(snippet)),
});

const row = (p: Partial<PostcheckRow> = {}): PostcheckRow => ({
  tableCode: "表4-1",
  rowId: "r1",
  label: "能力A",
  row: { capability: "AI 推理加速，算力 6 TOPS", verification_verdict: "已核实" },
  source: "ingest-1.pdf:10",
  sourceType: "AI提取",
  ...p,
});

describe("postcheck — 出处解析", () => {
  it("只认「文件名:页码」，行情描述不算材料出处", () => {
    expect(parseCitations("ingest-1790179276611-30.pdf:10")).toEqual(["ingest-1790179276611-30.pdf:10"]);
    expect(parseCitations("a.pdf:1；b.pptx:2")).toEqual(["a.pdf:1", "b.pptx:2"]);
    // 行情/模型知识不是材料依据——这正是要区分的东西
    expect(parseCitations("行业通例（模型知识）")).toEqual([]);
    expect(parseCitations("a.pdf")).toEqual([]);
    expect(parseCitations(null)).toEqual([]);
  });
});

describe("postcheck — 关键片段抽取", () => {
  it("抽带量纲的数、引号里的词、长专名；不抽核实列", () => {
    const p = keyPhrases({
      a: "算力 6 TOPS，支持「霉变检测」",
      b: "基于 OpenHarmony 的行业终端",
      verification: "已核实：这一页写了算力 6 TOPS",
    });
    expect(p).toContain("6 TOPS");
    expect(p).toContain("霉变检测");
    expect(p.some((x) => x.includes("OpenHarmony"))).toBe(true);
    expect(p.some((x) => x.includes("已核实"))).toBe(false);
  });
});

describe("postcheck — 来源真实性", () => {
  it("出处查不到 → 硬伤", () => {
    const f = runDeterministicPostcheck({
      rows: [row({ source: "不存在的材料.pdf:99" })],
      lookup: fakeLookup({ "ingest-1.pdf:10": ["算力 6 TOPS"] }),
    });
    expect(f.map((x) => x.kind)).toContain("出处查不到");
    expect(f.find((x) => x.kind === "出处查不到")?.severity).toBe("硬伤");
  });

  it("出处存在但该页没有这句话 → 存疑（指出查了什么）", () => {
    const f = runDeterministicPostcheck({
      rows: [row()],
      lookup: fakeLookup({ "ingest-1.pdf:10": ["完全无关的一页内容"] }),
    });
    const hit = f.find((x) => x.kind === "出处无此内容");
    expect(hit?.severity).toBe("存疑");
    expect(hit?.detail).toContain("6 TOPS");
  });

  it("出处与内容都对得上 → 不报来源问题", () => {
    const f = runDeterministicPostcheck({
      rows: [row()],
      lookup: fakeLookup({ "ingest-1.pdf:10": ["AI 算力 内置 NPU，算力 6 TOPS"] }),
    });
    expect(f.filter((x) => x.kind.includes("出处") || x.kind.includes("无出处"))).toEqual([]);
  });

  it("声称 AI提取 却没有出处 → 硬伤", () => {
    const f = runDeterministicPostcheck({
      rows: [row({ source: "行业通例（模型知识）" })],
      lookup: fakeLookup({}),
    });
    expect(f.map((x) => x.kind)).toEqual(
      expect.arrayContaining(["声称有据但无出处", "结论与证据矛盾"]),
    );
  });

  it("挂「已核实」但出处查不到 → 结论与证据矛盾（硬伤）", () => {
    const f = runDeterministicPostcheck({
      rows: [row({ source: "幽灵材料.pdf:1", row: { capability: "x", verification_verdict: "已核实" } })],
      lookup: fakeLookup({}),
    });
    expect(f.find((x) => x.kind === "结论与证据矛盾")?.severity).toBe("硬伤");
  });

  it("行情行（行业通例 + 模型知识出处）不报来源硬伤", () => {
    const f = runDeterministicPostcheck({
      rows: [
        row({
          source: "行业通例（模型知识）",
          sourceType: "AI推断",
          row: { capability: "会议室预订的通行做法", verification_verdict: "行业通例" },
        }),
      ],
      lookup: fakeLookup({}),
    });
    expect(f.filter((x) => x.severity === "硬伤")).toEqual([]);
  });
});

describe("postcheck — 表述客观性", () => {
  it("绝对化/营销化措辞 → 存疑并点名原词", () => {
    const f = runDeterministicPostcheck({
      rows: [
        row({
          source: "行业通例（模型知识）",
          sourceType: "AI推断",
          row: { capability: "本方案是行业最优解，必然彻底解决漏损", verification_verdict: "行业通例" },
        }),
      ],
      lookup: fakeLookup({}),
    });
    const hit = f.find((x) => x.kind === "绝对化措辞");
    expect(hit?.severity).toBe("存疑");
    expect(hit?.detail).toContain("最优");
    expect(hit?.detail).toContain("彻底解决");
  });

  it("行情行写成本客户事实 → 存疑", () => {
    const f = runDeterministicPostcheck({
      rows: [
        row({
          source: "行业通例（模型知识）",
          sourceType: "AI推断",
          row: { capability: "本客户已部署中控系统", verification_verdict: "行业通例" },
        }),
      ],
      lookup: fakeLookup({}),
    });
    expect(f.find((x) => x.kind === "把推断写成客户事实")?.detail).toContain("本客户已");
  });
});

describe("postcheck — 有价值（价值类表要可验证）", () => {
  it("收益行缺本客户基线 → 价值不可验证", () => {
    const f = runDeterministicPostcheck({
      rows: [
        {
          tableCode: "表6-1",
          rowId: "v1",
          label: "省电",
          row: {
            benefit: "省电",
            metric: "kWh/月",
            baseline: "未提供",
            verification_verdict: "行业通例",
          },
          source: "行业通例（模型知识）",
          sourceType: "AI推断",
        },
      ],
      lookup: fakeLookup({}),
    });
    expect(f.find((x) => x.kind === "价值不可验证")?.detail).toContain("基线");
  });

  it("没有「指标/基线」列的表不算价值表（表6-4 试点与验收曾被手写进价值表 → 20 条假问题让模型白改）", () => {
    const f = runDeterministicPostcheck({
      rows: [
        {
          tableCode: "表6-4",
          rowId: "p1",
          label: "试点范围",
          row: { kind: "试点范围", content: "以单个典型作业面为试点单元", verification_verdict: "行业通例" },
          source: "行业通例（模型知识）",
          sourceType: "AI推断",
        },
      ],
      lookup: fakeLookup({}),
    });
    expect(f.find((x) => x.kind === "价值不可验证")).toBeUndefined();
  });

  it("基线写成「未提供（本客户材料未含）」也要报——补一句说明不算有基线", () => {
    const f = runDeterministicPostcheck({
      rows: [
        {
          tableCode: "表6-1",
          rowId: "v3",
          label: "省电",
          row: {
            metric: "kWh/月",
            baseline: "未提供（本客户材料未含）",
            verification_verdict: "行业通例",
          },
          source: "行业通例（模型知识）",
          sourceType: "AI推断",
        },
      ],
      lookup: fakeLookup({}),
    });
    expect(f.find((x) => x.kind === "价值不可验证")).toBeTruthy();
  });

  it("有指标 + 有基线 → 不报价值问题", () => {
    const f = runDeterministicPostcheck({
      rows: [
        {
          tableCode: "表6-1",
          rowId: "v2",
          label: "省电",
          row: { metric: "kWh/月", baseline: "12000", verification_verdict: "已核实" },
          source: "ingest-1.pdf:10",
          sourceType: "AI提取",
        },
      ],
      lookup: fakeLookup({ "ingest-1.pdf:10": ["12000"] }),
    });
    expect(f.find((x) => x.kind === "价值不可验证")).toBeUndefined();
  });

  it("「行业通例：…本客户实测值未提供」也算没有本客户基线（补白不许糊过去）", () => {
    const f = runDeterministicPostcheck({
      rows: [
        {
          tableCode: "表6-1",
          rowId: "v4",
          label: "效率提升",
          row: {
            metric: "会议时长",
            baseline: "行业通例：平均缩短 20%，本客户实测值未提供",
            verification_verdict: "行业通例",
          },
          source: "行业通例（模型知识）",
          sourceType: "AI推断",
        },
      ],
      lookup: fakeLookup({}),
    });
    expect(f.find((x) => x.kind === "价值不可验证")?.detail).toContain("基线");
  });

  it("判据按列 key 读、与栏位无关：基线挪到右栏补充说明后照样报（变更表 #153）", () => {
    /* 基线现在是右栏补充列（不占中栏列预算）。`isValueTable` 认的是表定义的
       metric/baseline 两个 key，`runDeterministicPostcheck` 从行数据取值——
       两者都不经过 `middleColumns`，所以挪栏位不改变这条判据。 */
    const t = TABLES_BY_CODE["表6-1"]!;
    expect(t.columns.map((c) => c.key)).toContain("baseline");
    expect(middleColumns(t).map((c) => c.key)).not.toContain("baseline");
    const f = runDeterministicPostcheck({
      rows: [
        {
          tableCode: "表6-1",
          rowId: "v5",
          label: "省电",
          row: { metric: "kWh/月", baseline: "未提供（本客户材料未含）", verification_verdict: "行业通例" },
          source: "行业通例（模型知识）",
          sourceType: "AI推断",
        },
      ],
      lookup: fakeLookup({}),
    });
    expect(f.find((x) => x.kind === "价值不可验证")).toBeTruthy();
  });
});

describe("postcheck — hasCustomerBaseline（有/没有本客户基线的唯一判据）", () => {
  it("有真基线：数字、带口径的数值都算", () => {
    for (const v of ["12000", "18%", "18%（2024 年台账）", "日均 120 单"]) {
      expect(hasCustomerBaseline(v), v).toBe(true);
    }
  });

  it("没有基线：空值、纯补白、补白加括注、「行业通例 + 未提供」都算没有", () => {
    for (const v of [
      "",
      "   ",
      null,
      undefined,
      "未提供",
      "暂无",
      "未知",
      "—",
      "未提供（本客户材料未含）",
      "行业通例：平均缩短 20%，本客户实测值未提供",
      "待补",
    ]) {
      expect(hasCustomerBaseline(v), String(v)).toBe(false);
    }
  });
});

describe("postcheck — 三轮后确定性收口", () => {
  it("没改掉的「已核实但出处查不到」按实降级，并把原因写进核实说明", () => {
    const r = row({ source: "幽灵.pdf:1" });
    const findings = runDeterministicPostcheck({ rows: [r], lookup: fakeLookup({}) });
    const fixed = enforceTruthfulDowngrade([r], findings);
    expect(fixed).toHaveLength(1);
    expect(fixed[0]?.row["verification_verdict"]).toBe("无法核实");
    const note = String(fixed[0]?.row["verification"]);
    expect(note).toContain("生成后自检");
    expect(note).toContain("按实降为「无法核实」");
    expect(String(fixed[0]?.row["verification"])).toContain("不得当结论用");
  });

  it("声称「AI提取」却给不出出处 → 来源属性按实改为 AI推断，且不许再挂「已核实」", () => {
    const r = row({ source: "(空)", sourceType: "AI提取" });
    const findings = runDeterministicPostcheck({ rows: [r], lookup: fakeLookup({}) });
    const fixed = enforceTruthfulDowngrade([r], findings);
    expect(fixed).toHaveLength(1);
    expect(fixed[0]?.sourceType).toBe("AI推断");
    expect(fixed[0]?.row["verification_verdict"]).toBe("无法核实");
  });

  it("行情行（行业通例）只是声称有据却无出处 → 只改来源属性，不降级为「无法核实」", () => {
    const r: PostcheckRow = {
      tableCode: "表1-2",
      rowId: "r2",
      label: "环节A",
      row: { link: "作业申请", verification_verdict: "行业通例" },
      source: "",
      sourceType: "AI提取",
    };
    const findings = runDeterministicPostcheck({ rows: [r], lookup: fakeLookup({}) });
    const fixed = enforceTruthfulDowngrade([r], findings);
    expect(fixed).toHaveLength(1);
    expect(fixed[0]?.sourceType).toBe("AI推断");
    expect(fixed[0]?.row["verification_verdict"]).toBe("行业通例");
    const note = String(fixed[0]?.row["verification"]);
    expect(note).toContain("生成后自检");
    // 留痕必须与做法一致：这行降的是来源属性，不是结论（v1.29 实跑发现文案与行为不符）
    expect(note).toContain("AI 推断");
    expect(note).not.toContain("按实降为「无法核实」");
  });

  it("只有头号硬伤才降级；措辞类存疑不降级（那是模型该改的）", () => {
    const r = row({
      row: { capability: "行业最优解", verification_verdict: "行业通例" },
      source: "行业通例（模型知识）",
      sourceType: "AI推断",
    });
    const findings = runDeterministicPostcheck({ rows: [r], lookup: fakeLookup({}) });
    expect(enforceTruthfulDowngrade([r], findings)).toEqual([]);
  });
});

describe("postcheck — 报告", () => {
  it("按类型计数并留明细（最多 10 条）", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({ rowId: `r${i}`, source: "幽灵.pdf:1", row: { x: "1", verification_verdict: "已核实" } }),
    );
    const findings = runDeterministicPostcheck({ rows, lookup: fakeLookup({}) });
    const rep = summarizePostcheck({ checked: rows.length, fixed: 12, findings });
    expect(rep.checked).toBe(12);
    expect(rep.remaining).toBe(findings.length);
    expect(rep.openFindings).toHaveLength(10);
    // 三轮会反复判出同一处问题，统计必须按「行+类型」去重（否则 20 行会统计成 80）
    expect(rep.byKind["结论与证据矛盾"]).toBe(12);
  });
});

describe("postcheck — 中栏说结果、来源归右栏（v1.32）", () => {
  it("识别中栏里的引用痕迹：材料 id / 文件名页码 / （M5）/ 材料未提供", () => {
    expect(hasMidCitation("6TOPS NPU 可集成霉变检测（ingest-1790179276611-30.pdf:30）")).toBe(true);
    expect(hasMidCitation("CT15 无 NPU、不支持 AI 推理（M5）")).toBe(true);
    expect(hasMidCitation("来源：ingest-1.docx:7")).toBe(true);
    expect(hasMidCitation("依赖边缘本地运维平台，需局域网访问设备 IP")).toBe(false);
  });

  it("拆格：纯引用的句子整句搬走，正文里夹带的引用片段只摘引用、正文一字不删", () => {
    const r = splitMidCitations(
      "已有 42 个产品型号量产交付（M1_产品型号 ingest-1.pdf:2）。依赖 NPU 硬件，CT15 无 NPU。",
    );
    expect(r.cleaned).toBe("已有 42 个产品型号量产交付。 依赖 NPU 硬件，CT15 无 NPU。");
    expect(r.moved.join("")).toContain("ingest-1.pdf:2");
    // 正文里的关键结论必须还在
    expect(r.cleaned).toContain("42 个产品型号量产交付");
    expect(r.cleaned).toContain("依赖 NPU 硬件");
  });

  it("中栏夹带出处 / 中栏太长 → 点名（存疑，交给第 2 轮改写）", () => {
    const long = "按 10 间会议室各 1 套的参考规模，单价区间 1,500~4,000 元/套，取 2,500 元为量级参考，非厂商报价，另需考虑安装调试与三年维保";
    const findings = runDeterministicPostcheck({
      rows: [
        // 表5-5 已删（变更表 #105）→ 换一张仍在的中栏表：表5-3 的 content（长文本）带出处
        row({ tableCode: "表5-3", rowId: "r9", label: "CT15", row: { content: long, rollback: "见 ingest-1.pdf:3" } }),
      ],
      lookup: fakeLookup({ "ingest-1.pdf:3": ["x"] }),
    });
    expect(findings.some((f) => f.kind === "中栏夹带出处")).toBe(true);
    expect(findings.some((f) => f.kind === "中栏太长")).toBe(true);
    expect(long.length).toBeGreaterThan(MID_CELL_MAX_CHARS);
  });

  it("确定性收口：残留引用搬进右栏 source，正文保留；只剩引用的格子留空（交给完整度报缺）", () => {
    const sweptList = enforceMidCleanliness([
      row({
        tableCode: "表4-1",
        rowId: "r7",
        label: "AI 推理",
        row: { ability: "AI 推理加速（M5）", maturity: "来源：ingest-9.pdf:4" },
        source: "ingest-1.pdf:10",
      }),
    ]);
    const swept = sweptList[0]!;
    expect(swept.movedCount).toBeGreaterThan(0);
    expect(String(swept.row["ability"])).toBe("AI 推理加速");
    expect(String(swept.row["maturity"])).toBe("");
    expect(swept.emptied).toEqual(["maturity"]);
    // 引用不许丢：并进右栏来源
    expect(String(swept.row["source"])).toContain("ingest-1.pdf:10");
    expect(String(swept.row["source"])).toContain("ingest-9.pdf:4");
  });

  it("中栏本来干净的行走都不动（不做无谓改写）", () => {
    const rows = [row({ tableCode: "表4-1", rowId: "r8", row: { ability: "AI 推理加速", maturity: "已交付" } })];
    expect(enforceMidCleanliness(rows)).toEqual([]);
  });
});

describe("postcheck — 依据列不许写废话（v1.32 追加）", () => {
  const t42 = (roleReason: string, extra: Record<string, unknown> = {}): PostcheckRow => ({
    tableCode: "表4-2",
    rowId: "r42",
    label: "会议预约与空间管理",
    row: { link: "会议预约与空间管理", can_touch: "只能配合", our_role: "外围", role_reason: roleReason, ...extra },
    source: "行业通例（模型知识）",
    sourceType: "AI推断",
  });

  it("依据里复述结论（「属外围配合」）→ 点名", () => {
    const f = runDeterministicPostcheck({
      rows: [t42("预约与日历通常由第三方软件承载，我方仅提供门牌状态显示与近场拉起入口，属外围配合。")],
      lookup: fakeLookup({}),
    });
    const hit = f.find((x) => x.kind === "依据未落到事实");
    expect(hit).toBeTruthy();
    expect(hit?.detail).toContain("复述");
  });

  it("依据写行业套话（「通常由专业厂商承载」）→ 点名", () => {
    const f = runDeterministicPostcheck({
      rows: [t42("会议 MCU、音视频编解码通常由专业厂商承载，我方仅提供平板显示入口。")],
      lookup: fakeLookup({}),
    });
    const hit = f.find((x) => x.kind === "依据未落到事实");
    expect(hit).toBeTruthy();
    expect(hit?.detail).toContain("行业套话");
  });

  it("右栏枚举值不得参与判据：型号串含「CT31/CT32/CT33」不该被误判成复述「T3」", () => {
    const f = runDeterministicPostcheck({
      rows: [
        {
          ...t42("CT31/CT32/CT33 在售，支持 200+ 工业协议接入与 MQTT 上云。"),
          row: {
            link: "网络与设备接入",
            can_touch: "可以碰",
            our_role: "替代",
            role_reason: "CT31/CT32/CT33 在售，支持 200+ 工业协议接入与 MQTT 上云。",
            authority: "T3",
            evidence_level: "B",
          },
        },
      ],
      lookup: fakeLookup({}),
    });
    expect(f.some((x) => x.kind === "依据未落到事实")).toBe(false);
  });

  it("依据落到我方事实（型号 + 边界）→ 不点名（不误伤）", () => {
    const f = runDeterministicPostcheck({
      rows: [t42("CT15/CT16 IO 模块覆盖 DI/DO/AI/AO，可替代传统 PLC 做灯光空调联动。")],
      lookup: fakeLookup({}),
    });
    expect(f.some((x) => x.kind === "依据未落到事实")).toBe(false);
  });
});

describe("postcheck — 表4-4 对手必须有出处（2026-10-20 用户定调「没调研到写未知可以」）", () => {
  const pick = (opponent: string, winLoss = "强"): PostcheckRow => ({
    tableCode: "表4-4",
    rowId: "r44",
    label: "曝气优化",
    row: { sub_scene: "曝气优化", value_density: "高", opponent, win_loss: winLoss, entry_action: "1 座 5 万吨级厂试点 3 个月", rank: 1 },
    source: "表3-2",
    sourceType: "AI提取",
  });
  const KNOWN = ["中控技术、和利时、施耐德电气", "威派格、新奥数能"];

  it("对手写在表3-2 名单里 → 不点名", () => {
    const f = runDeterministicPostcheck({ rows: [pick("中控技术、和利时")], lookup: fakeLookup({}), knownOpponents: KNOWN });
    expect(f.some((x) => x.kind === "对手无出处")).toBe(false);
  });

  it("对手是行业常识补的厂商（名单里查不到）→ 点名，要求改未知", () => {
    const f = runDeterministicPostcheck({ rows: [pick("聚光科技、力合科技")], lookup: fakeLookup({}), knownOpponents: KNOWN });
    const hit = f.find((x) => x.kind === "对手无出处");
    expect(hit).toBeTruthy();
    expect(hit?.detail).toContain("未知");
  });

  it("对手写「未知」或「客户现状」→ 是诚实写法，不点名", () => {
    const f = runDeterministicPostcheck({
      rows: [pick("未知（无竞品情报）", "未知"), pick("客户现状（自建/手工）")],
      lookup: fakeLookup({}),
      knownOpponents: KNOWN,
    });
    expect(f.some((x) => x.kind === "对手无出处")).toBe(false);
  });

  it("对手写在竞品情报页里（本行 source 引用该页）→ 不点名", () => {
    const row = pick("数益工联、鼎捷数智");
    const f = runDeterministicPostcheck({
      rows: [{ ...row, source: "竞品情报-压铸OEE.md:3" }],
      lookup: {
        hasSource: () => true,
        hasContent: (ref, phrase) => ref === "竞品情报-压铸OEE.md:3" && "数益工联 鼎捷数智 布勒".includes(phrase),
      },
      knownOpponents: KNOWN,
    });
    expect(f.some((x) => x.kind === "对手无出处")).toBe(false);
  });

  it("对手既不在表3-2 名单、引用页里也没有 → 点名", () => {
    const row = pick("聚光科技");
    const f = runDeterministicPostcheck({
      rows: [{ ...row, source: "竞品情报-压铸OEE.md:3" }],
      lookup: { hasSource: () => true, hasContent: () => false },
      knownOpponents: KNOWN,
    });
    expect(f.some((x) => x.kind === "对手无出处")).toBe(true);
  });

  it("没传表3-2 名单时不做该判定（表3-2 未生成不误伤）", () => {
    const f = runDeterministicPostcheck({ rows: [pick("聚光科技、力合科技")], lookup: fakeLookup({}) });
    expect(f.some((x) => x.kind === "对手无出处")).toBe(false);
  });
});

describe("postcheck — 硬结论必须有依据（v1.33，用户质问「结论没有核实吗」）", () => {
  const ledgerRow = (ability: string, limitation = ""): PostcheckRow => ({
    tableCode: "表4-1",
    rowId: "led-1",
    label: ability,
    row: { no: "4-1-01", ability, maturity: "已交付", limitation },
    source: "ingest-1.pdf:2",
    sourceType: "AI提取",
  });
  const mapRow = (link: string, canTouch: string, role: string, reason: string, verdict: string): PostcheckRow => ({
    tableCode: "表4-2",
    rowId: "map-1",
    label: link,
    row: {
      link,
      can_touch: canTouch,
      our_role: role,
      role_reason: reason,
      verification_verdict: verdict,
    },
    source: "ingest-1.pdf:2",
    sourceType: "AI提取",
  });

  it("判「不能碰」但依据里是单品限制、底账里有该能力 → 跨表矛盾点名", () => {
    const f = runDeterministicPostcheck({
      rows: [
        ledgerRow("边缘 AI 推理算力（AI Box 边缘算力，6TOPS NPU）", "算力就绪但场景算法需另配"),
        mapRow("危害辨识与风险评估", "不能碰", "不参与", "无风险辨识与评估类能力；CT15 无 NPU、不支持 AI 推理，研判靠人工。", "无法核实"),
      ],
      lookup: fakeLookup({}),
    });
    expect(f.some((x) => x.kind === "判定与能力底账矛盾")).toBe(true);
    expect(f.some((x) => x.kind === "硬结论无依据")).toBe(true);
  });

  it("底账里的「限制条件」不能反过来当能力（曾误报 6 处）", () => {
    const f = runDeterministicPostcheck({
      rows: [
        ledgerRow("CT 系列在鸿控制器近场/远程设备控制（灯光、窗帘、空调等点位）", "CT15 无 NPU，不支持 AI 推理"),
        mapRow("语音转写与会议纪要", "不能碰", "不参与", "无 NPU 硬件，转写靠第三方。", "无法核实"),
      ],
      lookup: fakeLookup({}),
    });
    expect(f.some((x) => x.kind === "判定与能力底账矛盾")).toBe(false);
  });

  it("没下硬否定结论的行不查底账（「CT15 无 NPU」只是补充说明）→ 不点名", () => {
    const f = runDeterministicPostcheck({
      rows: [
        ledgerRow("边缘 AI 推理算力（AI Box 边缘算力，6TOPS NPU）"),
        mapRow("语音转写与会议纪要", "只能配合", "辅助", "AI Box 有 6TOPS NPU 可跑轻量模型；CT15 无 NPU。", "已核实"),
      ],
      lookup: fakeLookup({}),
    });
    expect(f.some((x) => x.kind === "判定与能力底账矛盾")).toBe(false);
    expect(f.some((x) => x.kind === "硬结论无依据")).toBe(false);
  });

  it("判「不能碰」但依据确凿（核实结论已核实）→ 不点名（不误伤正常边界）", () => {
    const f = runDeterministicPostcheck({
      rows: [
        ledgerRow("边缘 AI 推理算力（AI Box 边缘算力，6TOPS NPU）"),
        mapRow("个体防护装备配备", "不能碰", "不参与", "无防护装备产品线，能力集中在控制器、网关与终端侧。", "已核实"),
      ],
      lookup: fakeLookup({}),
    });
    expect(f.some((x) => x.kind === "硬结论无依据")).toBe(false);
    expect(f.some((x) => x.kind === "判定与能力底账矛盾")).toBe(false);
  });
});

describe("中栏太长 — 表1-1『内容』列例外（用户定调 v1.34，变更表 #165）", () => {
  const long = "空间与业务范围：华东地区某三甲医院集团下属院区内的一个住院病区，为试点范围；业务上覆盖病区内的护理呼叫、输液监护、病区环境监测与设备联动四类动作。";

  it("表1-1 内容列写整段也不判『中栏太长』", () => {
    const findings = runDeterministicPostcheck({
      rows: [row({ tableCode: "表1-1", rowId: "a1", label: "场景边界", row: { item: "场景边界", content: long } })],
      lookup: fakeLookup({}),
    });
    expect(long.length).toBeGreaterThan(MID_CELL_MAX_CHARS);
    expect(findings.some((f) => f.kind === "中栏太长")).toBe(false);
  });

  it("例外只免长度，不免『中栏夹带出处』：表1-1 内容列夹了引用照样点名", () => {
    const findings = runDeterministicPostcheck({
      rows: [
        row({
          tableCode: "表1-1",
          rowId: "a2",
          label: "场景边界",
          row: { item: "场景边界", content: `${long}（见 ingest-1.pdf:2）` },
        }),
      ],
      lookup: fakeLookup({ "ingest-1.pdf:2": ["x"] }),
    });
    expect(findings.some((f) => f.kind === "中栏夹带出处")).toBe(true);
  });

  it("例外不外溢：其它表的结论型长列（表6-1 怎么测）超 60 字仍点名", () => {
    const findings = runDeterministicPostcheck({
      rows: [
        row({
          tableCode: "表6-1",
          rowId: "a3",
          label: "响应时长",
          row: { how_to_measure: long },
        }),
      ],
      lookup: fakeLookup({}),
    });
    expect(findings.some((f) => f.kind === "中栏太长")).toBe(true);
  });
});

/**
 * 故障清单 #66：中栏"按词啃"引用痕迹，把缺材料的说明啃成病句
 *
 * 用户报「交付与运维现状 表格为什么没填？」→ 库里 7 行全写「未提供（本客户 含）」：
 * 模型原本写的是规范的「未提供（本客户材料未含）」，被 MID_CITATION_PATTERNS 里
 * `(?:材料|文档|资料)(?:中|里)?(?:未|没有|未见|未含)` 把「材料未」当引用删掉。
 * 它是**缺材料的说明**（G-R5 要求写），不是引用痕迹。
 */
describe("中栏引用清理 — 不许把缺材料的说明啃成病句（故障清单 #66）", () => {
  it("「未提供（本客户材料未含）」原样保留", () => {
    const out = splitMidCitations("未提供（本客户材料未含）");
    expect(out.cleaned).toBe("未提供（本客户材料未含）");
    expect(out.moved).toEqual([]);
  });

  it("夹在长句里的「（本客户材料未含）」整块保住", () => {
    const out = splitMidCitations("本客户现有报修渠道与响应时限均无材料（本客户材料未含），只能给行业通例");
    expect(out.cleaned).toContain("（本客户材料未含）");
    expect(out.cleaned).not.toContain("本客户 含");
  });

  it("真正的出处照旧搬右栏（文件名:页码）", () => {
    const out = splitMidCitations("会议平板故障率偏高。来源：ingest-3.pdf:12");
    expect(out.cleaned).not.toContain("ingest-3.pdf");
    expect(out.moved.join(" ")).toContain("ingest-3.pdf:12");
  });
});

/**
 * 现状类表（表1-2）缺客户材料时的判据
 *
 * 表2-7 交付与运维现状已删除（变更表 #226），原用例改用 表1-2 的真实列。
 *
 * 用户定调 2026-10-14：「干脆不生成，直接提示需要先补材料」——没有客户材料时，
 * 模型只能写行业通例 + 把答案标成「未提供（本客户材料未含）」，整表读起来像没填。
 */
describe("hasCustomerFacts — 现状类表有没有客户事实（确定性判据）", () => {
  it("表1-2 答案整格是「未提供（本客户材料未含）」→ 没有客户事实", () => {
    expect(
      hasCustomerFacts("表1-2", {
        link: "会议室设备与系统运维",
        owner_now: "未提供（本客户材料未含）",
        current_flow: "未提供（本客户材料未含）",
      }),
    ).toBe(false);
  });

  it("表1-2 写了真实现状 → 有客户事实", () => {
    expect(
      hasCustomerFacts("表1-2", {
        link: "会议室设备与系统运维",
        owner_now: "行政部兼管",
        current_flow: "音视频设备由集成商季度巡检",
      }),
    ).toBe(true);
  });

  it("表1-2 值列全是「材料里没有」→ 没有客户事实", () => {
    expect(
      hasCustomerFacts("表1-2", { link: "会议室预订", owner_now: "未提供", current_tool: "材料未含" }),
    ).toBe(false);
  });

  it("字段空着不算「缺客户事实」（空值归完整性检查管，不许误删）", () => {
    expect(hasCustomerFacts("表1-2", { link: "现状项" })).toBe(true);
    expect(hasCustomerFacts("表1-2", { link: "视频监控", owner_now: "可以碰" })).toBe(true);
  });

  it("非现状类表不参与此判据（一律视为有事实，避免误删）", () => {
    expect(hasCustomerFacts("表2-5", { constraint_item: "消防", required_value: "未提供" })).toBe(true);
    expect(hasCustomerFacts("表2-3", { layer: "感知层", components: "未提供" })).toBe(true);
  });
});

/**
 * 口径分档 — 用户质问 2026-10-14
 *
 * 「认识场景／场景理解／理解商业这三步梳理的应该是场景的状态，与用户本地的产品、用户的现状
 * 没有关系才对——为什么场景要素清单表格里提示『未提供（本客户未指定品牌）』
 * 『未提供（本客户未提供采购价）』？」
 *
 * 根因：自检口径不分阶段。场景级字段（主要供应商、价格量级、竞争激烈度）被逼着按客户口径回答，
 * 于是把"行业问题"答成了"客户问题"。判据落确定性层：阶段 ≤2 的中栏出现客户侧/我方措辞即报出。
 */
describe("口径分档 — 阶段 1–2 不许把行业问题答成客户问题（故障清单 #68）", () => {
  const elementRow = (p: Partial<PostcheckRow> = {}): PostcheckRow =>
    row({
      tableCode: "表2-2",
      label: "会议平板",
      row: {
        element_name: "会议平板",
        element_type: "设备",
        function: "会议室显示与白板书写",
        vendor: "未提供（本客户未指定品牌）",
        price_range: "未提供（本客户未提供采购价）",
      },
      ...p,
    });

  it("阶段 1 的「本客户未指定品牌」被报出", () => {
    const f = runDeterministicPostcheck({ rows: [elementRow()], lookup: fakeLookup({}), stage: 1 });
    const hit = f.find((x) => x.kind === "客户侧口径混入场景分析");
    expect(hit).toBeDefined();
    expect(hit?.detail).toContain("行业口径");
    expect(hit?.severity).toBe("存疑");
  });

  it("阶段 2 同样报出（理解商业也只看场景与行业本身）", () => {
    const f = runDeterministicPostcheck({ rows: [elementRow()], lookup: fakeLookup({}), stage: 2 });
    expect(f.map((x) => x.kind)).toContain("客户侧口径混入场景分析");
  });

  it("阶段 3 起不报（客户现状表已移到能力匹配，本客户口径是正当的）", () => {
    const f = runDeterministicPostcheck({
      rows: [
        row({
          tableCode: "表1-2",
          label: "会议室预订",
          row: { link: "会议室预订", owner_now: "本客户行政部兼管", current_tool: "OA 系统" },
        }),
      ],
      lookup: fakeLookup({}),
      stage: 3,
    });
    expect(f.map((x) => x.kind)).not.toContain("客户侧口径混入场景分析");
  });

  it("不传阶段时不报（向后兼容：老调用点不因新判据失败）", () => {
    const f = runDeterministicPostcheck({ rows: [elementRow()], lookup: fakeLookup({}) });
    expect(f.map((x) => x.kind)).not.toContain("客户侧口径混入场景分析");
  });

  it("按行业口径给的量级不报（正例：这是我们要的写法）", () => {
    const f = runDeterministicPostcheck({
      rows: [
        elementRow({
          row: {
            element_name: "会议平板",
            element_type: "设备",
            function: "会议室显示与白板书写",
            vendor: "MAXHUB、华为、海信等十多家主流厂商",
            price_range: "万元级（65–86 寸）",
          },
        }),
      ],
      lookup: fakeLookup({}),
      stage: 1,
    });
    expect(f.map((x) => x.kind)).not.toContain("客户侧口径混入场景分析");
  });
});
