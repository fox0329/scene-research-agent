/**
 * @scene/server — PPT 提示词测试（变更表 #142 收尾、#144 升）
 *
 * 真跑暴露的问题：模型声明了版式却不给对应字段（`layout: "表格"` 没有 `table`），
 * 确定性层降级后就是一页只有两三条的空页。所以提示词里**必须**有这三条硬约束：
 * ① 版式与字段成套；② 每页写到 12 条以上；③ 给不出字段就用网格要点写满四块。
 * #144 再加一条：**图标清单原样给模型**（每页一个、每块一个、表头列一一对应），
 * 且写死"清单外一律兜底 `presentation`"——名字写错那处图标就没了。
 * 再加上重试提示要**点名到页**。这里锁住这些文案，免得以后改提示词又改丢。
 */

import { describe, it, expect } from "vitest";
import { PPT_DEFAULT_ICON, PPT_ICONS, PPT_LIMITS, type PptPage } from "@scene/contract";
import {
  PPT_ICON_RULES,
  PPT_JSON_SPEC,
  PPT_LAYOUT_FIELD_RULES,
  buildPptOutlinePrompt,
  buildPptRetryPrompt,
} from "./ppt-prompt.js";

/** 首次提示的系统文案（模型真正读到的口径） */
const firstSystem = buildPptOutlinePrompt("solution", "智慧会议室", "# 正文").system;

/** 提示词里那段示例 JSON */
function examplePages(): PptPage[] {
  const slice = PPT_JSON_SPEC.join("\n").split("```")[1] ?? "";
  return (JSON.parse(slice) as { pages: PptPage[] }).pages;
}

describe("首次提示 —— 硬约束在文案里", () => {
  it("版式与字段成套：表格→table、流程阶段→stages、分层架构→layers 都点名", () => {
    expect(PPT_LAYOUT_FIELD_RULES.join("\n")).toContain("版式与字段必须成套");
    expect(firstSystem).toContain("写 `表格` ⇒ **必须**同时给合规 `table`");
    expect(firstSystem).toContain(`写 \`流程阶段\` ⇒ **必须**给 ${PPT_LIMITS.stages.min}–${PPT_LIMITS.stages.max} 个 \`stages\``);
    expect(firstSystem).toContain("每个都要有 `head` 与 `note`");
    expect(firstSystem).toContain("`分层架构` ⇒ **必须**给");
  });

  it("拿不准就用网格要点写满，别交空页（反例逐字在文案里）", () => {
    expect(firstSystem).toContain(`拿不准就一律用 \`网格要点\` 写满 ${PPT_LIMITS.blocks.count} 块`);
    expect(firstSystem).toContain("不要交一页只有两三条的空页");
  });

  it("每页 ≥12 条短句、不许编造数字、不写内部痕迹", () => {
    expect(firstSystem).toContain(`一页至少 ${PPT_LIMITS.minSentencesPerPage} 条有效短句`);
    expect(firstSystem).toContain("空页、只有两三条的大页一律不合格");
    expect(firstSystem).toContain("不许编造");
    expect(firstSystem).toContain("不许出现「待客户提供」");
  });

  it("示例 JSON 里给了填满的「流程阶段」页与「表格」页（字段与限额对齐契约）", () => {
    const pages = examplePages();
    const flow = pages.find((p) => p.layout === "流程阶段")!;
    expect(flow.stages.length).toBeGreaterThanOrEqual(PPT_LIMITS.stages.min);
    for (const s of flow.stages) {
      expect(s.head).not.toBe("");
      expect(s.note).not.toBe(""); // 每个阶段都要有说明
      expect(Array.from(s.head).length).toBeLessThanOrEqual(PPT_LIMITS.stages.headChars);
      expect(Array.from(s.note).length).toBeLessThanOrEqual(PPT_LIMITS.stages.noteChars);
    }
    const table = pages.find((p) => p.layout === "表格")!;
    expect(table.table).not.toBeNull(); // 声明了表格就必须带 table
    expect(table.table!.rows.length).toBeGreaterThanOrEqual(4); // 示例是填满的，不许一行两列
    expect(table.table!.head.length).toBeLessThanOrEqual(PPT_LIMITS.table.maxCols);
    for (const row of table.table!.rows) expect(row).toHaveLength(table.table!.head.length);
  });

  it("示例里的每一页都过得了字段限额（模型照着抄不会超限）", () => {
    for (const p of examplePages()) {
      expect(Array.from(p.kicker).length).toBeLessThanOrEqual(PPT_LIMITS.kickerChars);
      expect(Array.from(p.title).length).toBeLessThanOrEqual(PPT_LIMITS.titleChars);
      expect(Array.from(p.highlight).length).toBeLessThanOrEqual(PPT_LIMITS.highlightChars);
      expect((p.chips ?? []).length).toBeLessThanOrEqual(PPT_LIMITS.chips.max);
    }
  });
});

describe("首次提示 —— 图标（#144）", () => {
  it("白名单**原样**贴在提示词里（模型只能从这 47 个里挑）", () => {
    for (const name of PPT_ICONS) expect(firstSystem, `清单里少了 ${name}`).toContain(name);
    expect(PPT_ICON_RULES.join("\n")).toContain(PPT_ICONS.join("、"));
    // 一个字母都不许改：整份清单是连续的一串
    expect(firstSystem).toContain(PPT_ICONS.join("、"));
  });

  it("写死兜底与「不许自创名字」，并说清每处该给几个图标", () => {
    expect(firstSystem).toContain(`选不出就用 \`${PPT_DEFAULT_ICON}\``);
    expect(firstSystem).toContain("不许自创名字");
    expect(firstSystem).toContain("每一页给一个 `icon`");
    expect(firstSystem).toContain("`table.icons` 与表头列一一对应");
    expect(firstSystem).toContain("一个字母都不要改");
  });

  it("按意思挑的对义提示在文案里（台账→file-text、网络→network、风险→alert-triangle）", () => {
    expect(firstSystem).toContain("台账/清单→file-text");
    expect(firstSystem).toContain("网络→network");
    expect(firstSystem).toContain("风险→alert-triangle");
  });

  it("示例 JSON 里每页 / 每块 / 每阶段都带图标，且名字都在白名单内", () => {
    const pages = examplePages();
    for (const p of pages) {
      expect(PPT_ICONS as readonly string[], `${p.layout} 页缺 icon`).toContain(p.icon);
      // 示例里每页只写自己用到的字段，缺的那些按空数组过（真实返回也一样）
      for (const b of p.blocks ?? []) expect(PPT_ICONS as readonly string[]).toContain(b.icon);
      for (const c of p.columns ?? []) expect(PPT_ICONS as readonly string[]).toContain(c.icon);
      for (const s of p.stages ?? []) expect(PPT_ICONS as readonly string[]).toContain(s.icon);
      for (const l of p.layers ?? []) expect(PPT_ICONS as readonly string[]).toContain(l.icon);
      for (const c of p.cards ?? []) expect(PPT_ICONS as readonly string[]).toContain(c.icon);
      if (p.table) {
        expect(p.table.icons).toHaveLength(p.table.head.length); // 与表头列一一对应
        for (const name of p.table.icons) expect(PPT_ICONS as readonly string[]).toContain(name);
      }
    }
  });
});

describe("重试提示 —— 点名到页", () => {
  const reason = "第 5 页只有 2 条（每页请写到 12 条以上）";
  const retry = buildPptRetryPrompt("construction", "智慧会议室", reason);

  it("把上一次卡在哪、要改什么逐字写进 system 与 user", () => {
    expect(retry.system).toContain(reason);
    expect(retry.user).toContain(reason);
    expect(retry.system).toContain("这次必须改掉的两件事");
    expect(retry.system).toContain(`每一页都写到 ${PPT_LIMITS.minSentencesPerPage} 条以上有效短句`);
    expect(retry.system).toContain("不要再交一页只有两三条的空页");
    expect(retry.system).toContain("版式与字段必须成套"); // 重试也带上成套规则
    // 重试是整页重发，图标清单必须一起带上（否则新写的块只能回落兜底图标）
    expect(retry.system).toContain(PPT_ICONS.join("、"));
    expect(retry.system).toContain("不许自创名字");
  });

  it("没给原因时退回「解析不出来」的口径（旧路径不变）", () => {
    const plain = buildPptRetryPrompt("solution", "智慧会议室");
    expect(plain.system).toContain("上一次的输出无法解析为 JSON");
    expect(plain.user).toContain("## PPT：上一次的大纲不合要求，只按格式重发一次");
    expect(plain.user).toContain("只输出 JSON。");
  });
});
