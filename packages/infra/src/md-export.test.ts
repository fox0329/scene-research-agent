/**
 * @scene/infra — 交付物导出测试（v1.4 装配式）
 *
 * 覆盖：
 * - 内部报告 = 阶段总结装配 + 附录（来源与覆盖一张表）
 * - 对外材料 = 章节 ← 表映射，**只渲染中栏列**
 * - **两份文档都不含建议与判断**（这是本次重写的核心约束）
 * - 对外材料不含内部信息（竞品身份表、证据级标签、利润池）
 * - 空数据降级、文件命名规则
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";
import {
  backupBeforeOverwrite,
  exportDeliverables,
  exportFileName,
  safeWriteFile,
} from "./md-export.js";
import type { DeliverableInput, StageData } from "@scene/contract";

// ─── 测试数据构造 ────────────────────────────────────────────

function row(
  table_code: string,
  fields: Record<string, unknown>,
  extra: Partial<StageData> = {},
): StageData {
  return {
    id: `sd-${table_code}-${Math.random().toString(36).slice(2, 8)}`,
    scenario_id: "s1",
    stage: 1 as StageData["stage"],
    table_code: table_code as StageData["table_code"],
    row: fields,
    is_stale: false,
    source: "《白皮书》p.3",
    source_type: "AI提取",
    created_at: "2026-09-01",
    updated_at: "2026-09-01",
    ...extra,
  };
}

function makeInput(): DeliverableInput {
  return {
    scenario: {
      id: "s1",
      name: "智慧水务",
      product_line_id: "pl-iot",
      status: "进行中",
      current_stage: 6 as never,
      created_at: "2026-09-01",
      updated_at: "2026-09-15",
    },
    stageSummaries: [
      {
        stage: 0,
        title: "材料解析与入库",
        markdown: "# 阶段 0 · 材料解析与入库 — 总结\n\n## 一、信息摘要\n\n共获得 7 张表 / 12 行信息。",
      },
      {
        stage: 1,
        title: "认识场景（含门槛与合规）",
        markdown: "# 阶段 1 · 认识场景（含门槛与合规） — 总结\n\n## 五、待补齐信息\n\n- 表1-2 尚无数据",
      },
    ],
    stageData: [
      row("表1-1", { item: "场景名称", content: "智慧水务" }),
      row("表1-1", { item: "场景边界", content: "制水到输配" }),
      row("表1-1", { item: "买方类型", content: "市政水务集团" }),
      row("表1-2", {
        link: "制水",
        can_touch: "可以碰",
        our_role: "辅助",
        description: "加药与过滤",
      }),
      row("表1-3", {
        barrier_type: "技术",
        barrier_name: "等保三级",
        veto_holder: "",
        criteria: "GB/T 22239",
        judgment: "过得了",
      }),
      // 对外材料必须排除的表
      row("表3-1", { link: "视频监控", gross_margin: "35%", representative: "海康/大华" }),
      row("表3-4", {
        dimension: "算法准确率",
        our: "95%",
        competitor_a: "海康",
        competitor_b: "大华",
        competitor_c: "",
      }),
      row("表5-1", {
        layer: "边缘层",
        components: "边缘网关",
        interface: "Modbus",
        integration: "协议转换",
        boundary: "不承担安全责任",
        interface_name: "",
        type: "",
        protocol: "",
      }),
      row("表6-1", {
        benefit: "降低漏损",
        metric: "漏损率",
        baseline: "18%",
        expected: "12%",
        how_to_measure: "分区计量",
        user_feeling: "水费下降",
        evidence_level: "C",
      }),
    ],
    generatedAt: "2026-09-25",
  };
}

describe("exportFileName", () => {
  it("文件名 = 场景名称 + 解决方案（不带日期，变更表 #136）", () => {
    expect(exportFileName("智慧会议室")).toBe("智慧会议室解决方案.md");
  });

  it("场景名里的路径字符替换成下划线", () => {
    expect(exportFileName("A/B:C")).toBe("A_B_C解决方案.md");
  });
});

describe("exportDeliverables — <场景>解决方案（变更表 #136）", () => {
  it("封面只有一行报告名（不带日期，变更表 #134/#136），澄清/免责文字一律不出现", async () => {
    const report = await exportDeliverables(makeInput());
    expect(report).toMatch(/^# 智慧水务解决方案$/m);
    // 封面除了报告名什么都不留：场景行、日期行、场景锚副标题都不许再出现
    expect(report).not.toContain("> **场景**");
    expect(report).not.toContain("**生成日期**");
    expect(report).not.toContain("制水到输配 ｜ 市政水务集团");
    expect(report).not.toContain("怎么读");
    expect(report).not.toContain("不给决策建议");
    expect(report).not.toContain("内部版侧重");
    // 每章导语（口径说明）也不再有
    expect(report).not.toContain("先讲清场景在业务链条里的位置");
    // 报告名里不再有日期（变更表 #136），文件名也不带日期
  });

  it("正文按新骨架成章（不再是「阶段 N 总结」的拼接）", async () => {
    const report = await exportDeliverables(makeInput());
    for (const title of [
      "## 现状",
      "## 场景与问题",
      "## 方案",
      "## 价值",
      "## 下一步",
    ]) {
      expect(report, title).toContain(title);
    }
    // 用户定调 v1.32：「首先应该是报告，不是记录」——阶段总结标题不该再出现
    expect(report).not.toContain("第 0 部分");
    expect(report).not.toContain("信息摘要");
    expect(report).not.toContain("上下游衔接");
  });

  it("模型写了正文就用模型的（逐章替换）", async () => {
    const input = makeInput();
    const report = await exportDeliverables({
      ...input,
      chapters: [
        { key: "problems", markdown: "模型归纳：问题集中在三处。" },
        { key: "value", markdown: "模型归纳：价值集中在两处。" },
      ],
    });
    expect(report).toContain("模型归纳：问题集中在三处。");
    expect(report).toContain("模型归纳：价值集中在两处。");
    // 没给模型的章仍用要点版兜底（章节齐全）
    expect(report).toContain("## 现状");
    expect(report).not.toContain("附录");
  });

  it("正文恰好五章（不再有内部版的「主要风险点」章）", async () => {
    const report = await exportDeliverables(makeInput());
    const h2 = report.match(/^## .*$/gm) ?? [];
    expect(h2.map((h) => h.replace(/^## /, ""))).toEqual([
      "现状",
      "场景与问题",
      "方案",
      "价值",
      "下一步",
    ]);
    expect(report).not.toContain("附录");
    expect(report).not.toContain("来源索引");
  });

  it("只写结论：不列数据统计、不出「客观与风险」", async () => {
    const report = await exportDeliverables(makeInput());
    expect(report).toContain("## 下一步");
    expect(report).not.toContain("条：有来源");
    expect(report).not.toContain("数据状态");
    expect(report).not.toContain("客观与风险");
  });

  it("无阶段总结也照样出报告（正文不再依赖阶段总结）", async () => {
    const report = await exportDeliverables({ ...makeInput(), stageSummaries: [] });
    expect(report).toContain("## 下一步");
    expect(report).not.toContain("附录");
  });
});

describe("exportDeliverables — 只渲染中栏（对外口径）", () => {
  it("含客户视角章节且不含结论性建议", async () => {
    const report = await exportDeliverables(makeInput());
    // 变更表 #132：一级标题与文件名统一
    expect(report).toMatch(/^# 智慧水务解决方案$/m);
    // 只有这一份骨架：现状 / 场景与问题 / 方案 / 价值 / 下一步（变更表 #136）
    for (const t of ["## 现状", "## 场景与问题", "## 方案", "## 价值", "## 下一步"]) {
      expect(report, t).toContain(t);
    }
    expect(report).not.toContain("主要风险点");
    expect(report).not.toContain("不含结论性建议");
    expect(report).not.toContain("以试点实测为准");
  });

  it("只渲染中栏列：不出现来源、证据级、权威性", async () => {
    const report = await exportDeliverables(makeInput());
    expect(report).not.toContain("《白皮书》p.3");
    expect(report).not.toContain("证据等级");
    expect(report).not.toContain("来源权威性");
    // 表6-1 的 evidence_level 是中栏列已改为右栏，故导出里不应出现其取值
    expect(report).not.toContain("| 证据级 |");
  });

  it("不渲染竞品身份表与利润池表", async () => {
    const report = await exportDeliverables(makeInput());
    expect(report).not.toContain("海康");
    expect(report).not.toContain("大华");
    expect(report).not.toContain("表3-1");
    expect(report).not.toContain("表3-4");
    expect(report).not.toContain("利润池");
  });

  it("对外版正文里不写内部表号（只写结论）", async () => {
    const report = await exportDeliverables(makeInput());
    expect(report).toMatch(/现状/);
    expect(report).not.toMatch(/表\d+-\d+ （|表\d+-\d+$/m);
  });

  it("本节无数据时给出待补充提示", async () => {
    const input = makeInput();
    const report = await exportDeliverables({
      ...input,
      stageData: input.stageData.filter((r) => r.table_code !== "表6-1"),
    });
    // 缺表的章给出「本节信息待补充：表号」，而不是静默留空
    expect(report).toContain("本节信息待补充");
  });
});

describe("exportDeliverables — 不给决策建议（核心约束）", () => {
  it("报告不含建议档位与结论性措辞", async () => {
    const report = await exportDeliverables(makeInput());
    const forbidden = [
      "建议通过",
      "建议有条件通过",
      "建议不通过",
      "建议进",
      "不建议进",
      "结论：",
      "具备落地条件",
      "经评估",
      "红线",
    ];
    for (const bad of forbidden) {
      expect(report, `报告含「${bad}」`).not.toContain(bad);
    }
  });
});

describe("exportDeliverables — 空数据", () => {
  it("无任何阶段数据也能生成报告骨架", async () => {
    const report = await exportDeliverables({
      scenario: {
        id: "s2",
        name: "空场景",
        product_line_id: "pl",
        status: "进行中",
        current_stage: 0 as never,
        created_at: "2026-09-01",
        updated_at: "2026-09-01",
      },
      stageSummaries: [],
      stageData: [],
      generatedAt: "2026-09-25",
    });
    expect(report).toContain("# 空场景解决方案");
    expect(report).toContain("## 下一步");
    expect(report).toMatch(/^# 空场景解决方案$/m);
    expect(report).toContain("本节信息待补充");
  });

  it("模型这一章给了空串 → 回落该章要点版，而不是「（本节内容待补）」", async () => {
    const input = makeInput();
    const report = await exportDeliverables({
      ...input,
      chapters: [{ key: "problems", markdown: "   " }],
    });
    expect(report).not.toContain("（本节内容待补）");
    // 要点版里问题章的兜底正文来自表1-2（这一章不再是空的）
    const seg = report.split("## 场景与问题")[1] ?? "";
    expect(seg.trim().split("---")[0]!.trim().length).toBeGreaterThan(0);
  });

  it("模型把章名当正文抄了一遍 → 装配时去掉重复那一行，正文不动", async () => {
    const input = makeInput();
    input.chapters = [{ key: "status", markdown: "现状\n\n本场景处在办公空间与协同软件的交叉点。" }];
    const report = await exportDeliverables(input);
    expect(report).toContain("## 现状");
    expect(report).not.toMatch(/## 现状\n\n> [^\n]+\n\n现状/);
    expect(report.match(/^## 现状$/gm)?.length).toBe(1);
    expect(report).not.toMatch(/^现状$/m); // 抄来的那一行被装配时去掉
    expect(report).toContain("本场景处在办公空间与协同软件的交叉点。");
  });

});

describe("backupBeforeOverwrite", () => {
  it("覆盖前把旧内容留进 .history/，手改不会被静默吃掉", () => {
    const dir = mkdtempSync(join(tmpdir(), "scene-bak-"));
    try {
      const file = join(dir, "智慧会议室 内部调研报告 2026-10-07.md");
      writeFileSync(file, "第一版（用户手改）", "utf8");
      const saved = backupBeforeOverwrite(file);
      expect(saved).toBeTruthy();
      expect(readFileSync(saved!, "utf8")).toBe("第一版（用户手改）");
      writeFileSync(file, "第二版（重新生成）", "utf8");
      expect(readFileSync(file, "utf8")).toBe("第二版（重新生成）");
      // 文件不存在时不留档、不报错
      expect(backupBeforeOverwrite(join(dir, "没有这个文件.md"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("先读后写：交付物写入保护（变更表 #131）", () => {
  it("文件不存在时正常写出", () => {
    const dir = mkdtempSync(join(tmpdir(), "safewrite-"));
    const path = join(dir, "报告.md");
    const r = safeWriteFile(path, "第一版");
    expect(r.written).toBe(true);
    expect(r.overwritten).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("第一版");
  });

  it("内容与上次写出的一模一样时，不写盘、不动文件", () => {
    const dir = mkdtempSync(join(tmpdir(), "safewrite-"));
    const path = join(dir, "报告.md");
    safeWriteFile(path, "同一份内容");
    const before = statSync(path).mtimeMs;
    const r = safeWriteFile(path, "同一份内容");
    expect(r.written).toBe(false);
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it("应用自己写过、这次内容变了：留档后覆盖", () => {
    const dir = mkdtempSync(join(tmpdir(), "safewrite-"));
    const path = join(dir, "报告.md");
    safeWriteFile(path, "第一版");
    const r = safeWriteFile(path, "第二版");
    expect(r.overwritten).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("第二版");
    expect(readdirSync(join(dir, ".history")).length).toBe(1);
  });

  it("文件被手改过：不覆盖用户的文件，新版本另存", () => {
    const dir = mkdtempSync(join(tmpdir(), "safewrite-"));
    const path = join(dir, "报告.md");
    safeWriteFile(path, "应用写的");
    writeFileSync(path, "用户手改的", "utf8"); // 模拟用户手工编辑
    const r = safeWriteFile(path, "应用新生成的");
    expect(r.overwritten).toBe(false);
    expect(r.path).not.toBe(path);
    expect(readFileSync(path, "utf8")).toBe("用户手改的"); // 用户版本原样保留
    expect(readFileSync(r.path, "utf8")).toBe("应用新生成的");
    expect(r.notice).toContain("被手改过");
  });
});
