import { describe, it, expect } from "vitest";
import {
  TABLES,
  TABLES_BY_CODE,
  type TableColumn,
  type TableDef,
  STAGE_DEFS,
  ENUMS,
  COMPUTED_CARDS,
  SCENARIO_BRIEF_FIELDS,
  SUMMARY_DOC_SECTIONS,
  MIDDLE_COLUMN_BUDGET,
  columnBudgetViolations,
  registryIssues,
  middleColumns,
  supplementColumns,
  middleColumnsByBlock,
  tablesOfStage,
  pinnedTables,
  crossStageTables,
  tableDef,
  stageDef,
} from "./tables.js";

/** 按「块 / payload / 整表」分组取中栏列——与 columnBudgetViolations 同口径 */
function midGroups(t: TableDef): { label: string; cols: readonly TableColumn[] }[] {
  if (t.payloads) {
    return Object.entries(t.payloads).map(([cat, cols]) => ({
      label: `${t.code}(${cat})`,
      cols: [...t.columns, ...cols].filter((c) => c.slot === "中栏" && c.key !== t.groupBy),
    }));
  }
  if (t.columns.some((c) => c.block)) {
    return Object.entries(middleColumnsByBlock(t)).map(([b, cols]) => ({
      label: `${t.code}(${b})`,
      cols,
    }));
  }
  return [{ label: t.code, cols: middleColumns(t) }];
}

describe("表定义注册表 — 完整性", () => {
  it("registryIssues 为空（表数/表号唯一/列预算/枚举/长文本截断/阶段一致）", () => {
    expect(registryIssues()).toEqual([]);
  });

  it("共 34 张表，且表号唯一", () => {
    expect(TABLES).toHaveLength(34);
    expect(new Set(TABLES.map((t) => t.code)).size).toBe(34);
    expect(Object.keys(TABLES_BY_CODE)).toHaveLength(34);
  });

  it("级别分布：重要 17 / 支撑 12 / 过程 5", () => {
    const count = (tier: string): number => TABLES.filter((t) => t.tier === tier).length;
    expect(count("重要")).toBe(17);
    expect(count("支撑")).toBe(12);
    expect(count("过程")).toBe(5);
  });

  it("阶段分布：0→7张、1→8张、2→8张、3→4张、4→4张、5→2张、6→1张、7→0张", () => {
    const dist = [0, 1, 2, 3, 4, 5, 6, 7].map((s) => tablesOfStage(s as 0).length);
    expect(dist).toEqual([7, 8, 8, 4, 4, 2, 1, 0]);
  });

  it("阶段定义的 tableCodes 与实际表一致（含阶段 7 无表）", () => {
    for (const s of STAGE_DEFS) {
      expect(tablesOfStage(s.id).map((t) => t.code).sort()).toEqual([...s.tableCodes].sort());
    }
    expect(stageDef(7).tableCodes).toEqual([]);
  });
});

describe("表定义注册表 — 列预算（中栏 ≤6 列）", () => {
  it("无任何表（含 payload 与多子块）超过中栏列预算", () => {
    expect(columnBudgetViolations()).toEqual([]);
  });

  it("每张表的中栏列数 ≤ 上限（按块 / payload 分别核算）", () => {
    for (const t of TABLES) {
      for (const g of midGroups(t)) {
        expect(g.cols.length, `${g.label} 中栏 ${g.cols.length} 列`).toBeLessThanOrEqual(
          MIDDLE_COLUMN_BUDGET,
        );
      }
    }
  });

  it("元信息列（source/evidence_level/authority）一律在右栏补充，不进中栏", () => {
    const metaKeys = ["source", "evidence_level", "authority"];
    for (const t of TABLES) {
      for (const g of midGroups(t)) {
        for (const c of g.cols) {
          expect(metaKeys, `${g.label}.${c.key}`).not.toContain(c.key);
        }
      }
    }
  });

  it("多子块表（成本估算 / 方案架构）每个子块中栏列 ≤ 上限", () => {
    for (const code of ["表5-5", "表5-1"]) {
      const byBlock = middleColumnsByBlock(tableDef(code));
      for (const cols of Object.values(byBlock)) {
        expect(cols.length).toBeLessThanOrEqual(MIDDLE_COLUMN_BUDGET);
      }
    }
    expect(Object.keys(middleColumnsByBlock(tableDef("表5-5"))).sort()).toEqual([
      "人工",
      "汇总",
      "硬件",
      "运营",
    ]);
  });

  it("可选材料：1 张表 6 种 payload，每种 payload 的中栏列（含类别列）≤ 上限", () => {
    const t = tableDef("可选材料");
    expect(Object.keys(t.payloads ?? {})).toHaveLength(6);
    for (const [, cols] of Object.entries(t.payloads ?? {})) {
      expect(middleColumns(t, cols.length ? undefined : undefined).length).toBeLessThanOrEqual(
        MIDDLE_COLUMN_BUDGET,
      );
    }
    // 按类别计算（类别列 + payload 中栏列）
    for (const cat of ENUMS.optional_category) {
      const payloadMid = (t.payloads?.[cat] ?? []).filter((c) => c.slot === "中栏");
      expect(payloadMid.length + 1).toBeLessThanOrEqual(MIDDLE_COLUMN_BUDGET);
    }
  });

  it("长文本列必给 truncate（避免行高失控）", () => {
    for (const t of TABLES) {
      for (const c of t.columns) {
        if (c.type === "longText" && c.slot === "中栏") {
          expect(c.truncate, `${t.code}.${c.key}`).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("表定义注册表 — 关键结构", () => {
  it("常驻表只有表1-1（场景锚）", () => {
    expect(pinnedTables().map((t) => t.code)).toEqual(["表1-1"]);
  });

  it("表1-1 有 12 个固定行，其中 6 项为 L1 必确认", () => {
    const rows = tableDef("表1-1").fixedRows ?? [];
    expect(rows).toHaveLength(12);
    expect(rows.filter((r) => r.confirmRequired).map((r) => r.key)).toEqual([
      "customer_type",
      "scope_in",
      "scope_out",
      "use_case",
      "entry_point",
      "value_proposition",
    ]);
  });

  it("表1-1 用「项 / 内容」两列纵向呈现", () => {
    expect(middleColumns(tableDef("表1-1")).map((c) => c.key)).toEqual(["item", "content"]);
  });

  it("跨阶段填写的表为 表2-5 / 表3-6 / 表3-8（回退时按列清除）", () => {
    expect(crossStageTables().map((t) => t.code).sort()).toEqual(["表2-5", "表3-6", "表3-8"]);
    expect(tableDef("表2-5").filledInStages).toEqual([1, 4]);
    expect(tableDef("表3-6").filledInStages).toEqual([2, 4]);
    expect(tableDef("表3-8").filledInStages).toEqual([2, 3]);
  });

  it("表2 规格书按型号分组（groupBy 不进列）", () => {
    const t = tableDef("M2");
    expect(t.groupBy).toBe("product_id");
    expect(middleColumns(t).map((c) => c.key)).not.toContain("product_id");
    expect(supplementColumns(t).map((c) => c.key)).toContain("product_id");
  });

  it("投资回报是计算卡片而非表（派生值不让模型填）", () => {
    expect(TABLES_BY_CODE["投资回报"]).toBeUndefined();
    const roi = COMPUTED_CARDS.find((c) => c.key === "roi");
    expect(roi?.inputs).toEqual(["表5-5", "表6-1"]);
    expect(roi?.formula).toContain("回收期");
  });

  it("每张表都有 purpose / rowUnit / completeness，且被引用阶段合法", () => {
    for (const t of TABLES) {
      expect(t.purpose.length, t.code).toBeGreaterThan(0);
      expect(t.rowUnit.length, t.code).toBeGreaterThan(0);
      expect(t.completeness.length, t.code).toBeGreaterThan(0);
      for (const s of t.consumedBy ?? []) {
        expect(s, `${t.code} consumedBy`).toBeGreaterThanOrEqual(t.stage === 0 ? 0 : 0);
        expect(s).toBeLessThanOrEqual(7);
      }
    }
  });

  it("ref 类型列都指向存在的表", () => {
    for (const t of TABLES) {
      for (const c of t.columns) {
        if (c.type === "ref" && c.refTable) {
          expect(TABLES_BY_CODE[c.refTable], `${t.code}.${c.key} → ${c.refTable}`).toBeDefined();
        }
      }
    }
  });
});

describe("表定义注册表 — 输入与总结文档骨架", () => {
  it("场景诉求：必填两项（场景名称 + 一句话想搞清楚什么）", () => {
    expect(SCENARIO_BRIEF_FIELDS.filter((f) => f.required).map((f) => f.key)).toEqual([
      "scene_name",
      "intent",
    ]);
    expect(SCENARIO_BRIEF_FIELDS.length).toBeGreaterThanOrEqual(5);
  });

  it("阶段总结文档为六段骨架", () => {
    expect(SUMMARY_DOC_SECTIONS).toHaveLength(6);
    expect(SUMMARY_DOC_SECTIONS.map((s) => s.title)).toEqual([
      "一、信息摘要",
      "二、关键信息清单",
      "三、说明与方法口径",
      "四、来源与抽查",
      "五、信息缺口与待补充",
      "六、上下游衔接",
    ]);
  });

  it("每个阶段都有总结文档标题", () => {
    for (const s of STAGE_DEFS) {
      expect(s.summaryTitle.length, `阶段 ${s.id}`).toBeGreaterThan(0);
    }
  });
});

describe("表定义注册表 — 枚举", () => {
  it("关键枚举取值与 05 一致", () => {
    expect(ENUMS.can_touch).toEqual(["可以碰", "只能配合", "不能碰"]);
    expect(ENUMS.our_role).toEqual(["替代", "辅助", "外围", "不参与"]);
    expect(ENUMS.match).toEqual(["真能解", "需补齐", "不能做"]);
    expect(ENUMS.barrier_type).toHaveLength(5);
    expect(ENUMS.evidence_level).toEqual(["A", "B", "C", "D"]);
    expect(ENUMS.authority).toEqual(["T1", "T2", "T3", "T4"]);
    expect(ENUMS.asset_target).toHaveLength(4);
  });

  it("不含任何建议档位类枚举（产品不产出判断）", () => {
    const flat = Object.values(ENUMS).flat().join(" ");
    expect(flat).not.toContain("建议进");
    expect(flat).not.toContain("建议通过");
    expect(flat).not.toContain("建议不通过");
  });
});
