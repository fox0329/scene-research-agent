import { describe, it, expect } from "vitest";
import {
  parseCitations,
  keyPhrases,
  runDeterministicPostcheck,
  enforceTruthfulDowngrade,
  enforceMidCleanliness,
  splitMidCitations,
  hasMidCitation,
  MID_CELL_MAX_CHARS,
  summarizePostcheck,
  type PostcheckRow,
  type SourceLookup,
} from "./postcheck.js";

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
        row({ tableCode: "表5-5", rowId: "r9", label: "CT15", row: { item: long, note: "见 ingest-1.pdf:3" } }),
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
