import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { composeTableDoc, renderTables, renderSummary } from "./docgen.js";
import { TABLES, STAGE_DEFS, MIDDLE_COLUMN_BUDGET, effectiveMiddleMax } from "./tables.js";

const root = process.cwd();
const read = (p: string): string => readFileSync(resolve(root, p), "utf8");

const composed = (): string =>
  composeTableDoc({
    preamble: read("docs-src/05-a-preamble.md"),
    appendix: read("docs-src/05-b-appendix.md"),
    version: read("docs-src/05-c-version.md"),
  });

describe("文档生成 — 与注册表一致（漂移守卫）", () => {
  it("05-表格定义总表.md 与注册表生成结果一致（不一致请跑 pnpm gen:docs）", () => {
    expect(read("05-表格定义总表.md")).toBe(composed());
  });

  it("人工撰写的三部分存在且非空", () => {
    expect(read("docs-src/05-a-preamble.md").length).toBeGreaterThan(500);
    expect(read("docs-src/05-b-appendix.md").length).toBeGreaterThan(500);
    expect(read("docs-src/05-c-version.md").length).toBeGreaterThan(100);
  });
});

describe("文档生成 — 内容完整性", () => {
  const body = renderTables();

  it("35 张表全部渲染为三级标题", () => {
    for (const t of TABLES) {
      expect(body, t.code).toContain(`### ${t.code} ${t.name} `);
    }
    expect(body.match(/^### /gm)?.length).toBe(TABLES.length);
  });

  it("每张表都渲染了目的、行粒度、栏位分配、完整度规则", () => {
    for (const t of TABLES) {
      expect(body).toContain(t.purpose);
      expect(body).toContain(t.rowUnit);
      expect(body).toContain(t.completeness[0]);
    }
    expect(body.match(/- \*\*栏位分配\*\*/g)?.length).toBe(TABLES.length);
    expect(body.match(/- \*\*完整度规则\*\*/g)?.length).toBe(TABLES.length);
  });

  it("表1-1 渲染 6 行固定项，并标出唯一由用户输入的那一项", () => {
    const section = body.slice(body.indexOf("### 表1-1 "), body.indexOf("### 表1-2 "));
    expect(section).toContain("**= 场景锚**");
    expect(section).toContain("固定行");
    expect(section).toContain("| 项 | 必填 | 内容属主 | 说明 |");
    for (const label of [
      "场景名称",
      "场景边界",
      "生产对象",
      "核心生产系统",
      "买方类型",
      "采购特征",
    ]) {
      expect(section, label).toContain(`| ${label} |`);
    }
    // 只有「场景名称」的内容属主是用户——这是产品设计反转后的核心事实
    const mine = section.match(/\| 用户 \|/g) ?? [];
    expect(mine).toHaveLength(1);
  });

  it("不再标「跨阶段填写」（v1.25 删掉跨阶段补填）", () => {
    expect(body).not.toContain("跨阶段填写");
    for (const gone of ["compliance_path", "is_digital", "current_status"]) {
      expect(body, gone).not.toContain(`| \`${gone}\` |`);
    }
  });

  it("可选材料渲染 5 种 payload（价格类别已下线）", () => {
    const i = body.indexOf("### 可选材料 ");
    const section = body.slice(i, body.indexOf("\n## ", i + 1));
    for (const cat of ["O1认证", "O2案例", "O4开发资料", "O5路线图", "O6交付与生态"]) {
      expect(section, cat).toContain(`**${cat}**`);
    }
    expect(section).not.toContain("O3");
  });

  it("多子块表（方案架构）按块渲染，且用能独立看懂的显示名（v1.26）", () => {
    /* 表5-5 成本估算已删（变更表 #105）→ 多子块表只剩 表5-1，块名仍须能脱离表名独立看懂 */
    for (const label of ["方案架构", "接口清单"]) {
      expect(body, label).toContain(`**${label}**`);
    }
    for (const gone of ["**架构块**", "**接口块**", "**硬件块**", "**汇总块**", "**成本估算**"]) {
      expect(body, gone).not.toContain(gone);
    }
  });

  it("列说明（note）被渲染出来", () => {
    expect(body).toContain("须与表3-3 的 budget 科目同词表");
    /* 表6-1 已随价值验证阶段删除（变更表 #243），改断言仍存在的 note */
    expect(body).toContain("唯一键（去重依据）");
  });

  it("生成内容不含任何建议档位措辞（产品不产出判断）", () => {
    for (const bad of ["建议进", "建议通过", "建议不通过", "红线", "一票否决 →"]) {
      expect(body, bad).not.toContain(bad);
      expect(renderSummary(), bad).not.toContain(bad);
    }
  });
});

describe("文档生成 — 汇总校验自动计算", () => {
  const summary = renderSummary();

  it("计数来自注册表而非手写", () => {
    expect(summary).toContain(`| **保留** | **${TABLES.length}** |`);
    expect(summary).toContain(`| 其中 \`重要\`（中栏表格，逐格校对） | **${TABLES.filter((t) => t.tier === "重要").length}** |`);
    expect(summary).toContain(`中栏列数上限 **${MIDDLE_COLUMN_BUDGET} 列**`);
  });

  it("逐阶段分布覆盖全部有表的阶段", () => {
    for (const s of STAGE_DEFS) {
      const n = TABLES.filter((t) => t.stage === s.id).length;
      if (n === 0) continue;
      expect(summary, `阶段 ${s.id}`).toContain(`阶段 ${s.id} · ${s.name}`);
    }
  });

  it("每阶段「实际最大中栏列数」不超过预算", () => {
    for (const s of STAGE_DEFS) {
      const ts = TABLES.filter((t) => t.stage === s.id);
      if (ts.length === 0) continue;
      const max = Math.max(...ts.map((t) => effectiveMiddleMax(t)));
      expect(max, `阶段 ${s.id}`).toBeLessThanOrEqual(MIDDLE_COLUMN_BUDGET);
      expect(summary).toContain(`实际最大 ${max}`);
    }
  });
});
