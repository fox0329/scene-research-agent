import { describe, it, expect } from "vitest";
import {
  TABLES,
  TABLES_BY_CODE,
  STAGE_DEFS,
  ENUMS,
  SCENARIO_BRIEF_FIELDS,
  SUMMARY_DOC_SECTIONS,
  tableDisplayName,
  MIDDLE_COLUMN_BUDGET,
  columnBudgetViolations,
  registryIssues,
  middleColumns,
  supplementColumns,
  blockLabel,
  enumValues,
  rowBelongsToBlock,
  middleColumnsByBlock,
  middleColumnGroups,
  tablesOfStage,
  pinnedTables,
  tableDef,
  stageDef,
  reportChapters,
  REPORT_KINDS,
} from "./tables.js";

describe("表定义注册表 — 完整性", () => {
  it("registryIssues 为空（表数/表号唯一/列预算/枚举/长文本截断/阶段一致）", () => {
    expect(registryIssues()).toEqual([]);
  });

  it("共 26 张表，且表号唯一", () => {
    /* 35 → 34（删 表5-5）→ 33（删 M6 内部费率）→ 28（阶段 2 收成 5 张）
     * → 27（阶段 3 精简）→ 25（删除价值验证阶段：表6-1/表6-4，变更表 #243）
     * → 26（v2.11 新增 M6 硬件报价） */
    expect(TABLES).toHaveLength(26);
    expect(new Set(TABLES.map((t) => t.code)).size).toBe(26);
    expect(Object.keys(TABLES_BY_CODE)).toHaveLength(26);
  });

  it("级别分布：重要 15 / 支撑 10 / 过程 1", () => {
    const count = (tier: string): number => TABLES.filter((t) => t.tier === tier).length;
    expect(count("重要")).toBe(15);
    expect(count("支撑")).toBe(10);
    expect(count("过程")).toBe(1);
  });

  it("阶段分布：0→7张、1→6张、2→5张、3→5张、4→3张、5→0张", () => {
    /* 表1-2 属"客户现状"，已从阶段 1 移到阶段 3（用户定调 2026-10-14）
     * 表2-7 交付与运维现状已删除（变更表 #226，用户定调「没价值的直接删」）
     * 阶段 0 新增 M6 硬件报价（v2.11） */
    const dist = [0, 1, 2, 3, 4, 5].map((s) => tablesOfStage(s as 0).length);
    expect(dist).toEqual([7, 6, 5, 5, 3, 0]);
  });

  it("阶段定义的 tableCodes 与实际表一致（含交付物阶段无表）", () => {
    for (const s of STAGE_DEFS) {
      expect(tablesOfStage(s.id).map((t) => t.code).sort()).toEqual([...s.tableCodes].sort());
    }
    expect(stageDef(5).tableCodes).toEqual([]);
  });
});

describe("表定义注册表 — 列预算（中栏 ≤6 列）", () => {
  it("无任何表（含 payload 与多子块）超过中栏列预算", () => {
    expect(columnBudgetViolations()).toEqual([]);
  });

  it("每张表的中栏列数 ≤ 上限（按块 / payload 分别核算）", () => {
    for (const t of TABLES) {
      for (const g of middleColumnGroups(t)) {
        expect(g.cols.length, `${g.label} 中栏 ${g.cols.length} 列`).toBeLessThanOrEqual(
          MIDDLE_COLUMN_BUDGET,
        );
      }
    }
  });

  it("元信息列（source/evidence_level/authority）一律在右栏补充，不进中栏", () => {
    const metaKeys = ["source", "evidence_level", "authority"];
    for (const t of TABLES) {
      for (const g of middleColumnGroups(t)) {
        for (const c of g.cols) {
          expect(metaKeys, `${g.label}.${c.key}`).not.toContain(c.key);
        }
      }
    }
  });

  it("出处/引用类列一律右栏（中栏只说结果——用户定调 v1.32）", () => {
    // 来源、出处、证据等级、权威性、证明材料：都是「引用」，不能占中栏（中栏要说价值、说结果）
    const provenanceKeys = [
      "source",
      "evidence_level",
      "authority",
      "proof",
      "data_source",
      "gap_source",
      "source_authority",
    ];
    for (const t of TABLES) {
      for (const g of middleColumnGroups(t)) {
        for (const c of g.cols) {
          expect(provenanceKeys, `${t.code} ${g.label}.${c.key}`).not.toContain(c.key);
        }
      }
    }
  });

  it("表5-1 架构与接口不带工作量列（工作量口径只在表5-3「人天」）", () => {
    const t = tableDef("表5-1");
    expect(t.columns.map((c) => c.key)).not.toContain("effort");
    expect(t.completeness.join()).toContain("接口块三项非空");
  });

  it("多子块表（方案架构 / 接口清单）每个子块中栏列 ≤ 上限", () => {
    /* 表5-5 成本估算已按用户定调删除（变更表 #105），多子块表现在只剩 表5-1 */
    const byBlock = middleColumnsByBlock(tableDef("表5-1"));
    for (const cols of Object.values(byBlock)) {
      expect(cols.length).toBeLessThanOrEqual(MIDDLE_COLUMN_BUDGET);
    }
    expect(Object.keys(byBlock).sort()).toEqual(["接口", "架构"]);
  });

  it("多子块表的每个块都有能独立看懂的显示名（v1.26：块在界面上一行各占一个表）", () => {
    // 缺了显示名就会退回「架构块」——脱离表名看不懂，而界面上不再有表名那一行做上下文
    for (const code of ["表5-1"]) {
      const t = tableDef(code);
      for (const b of Object.keys(middleColumnsByBlock(t))) {
        const label = blockLabel(t, b);
        expect(label, `${code} 的块「${b}」`).not.toBe(`${b}块`);
        expect(label.length).toBeGreaterThan(1);
      }
    }
    expect(["架构", "接口"].map((b) => blockLabel(tableDef("表5-1"), b))).toEqual([
      "方案架构",
      "接口清单",
    ]);
    // 未标显示名的表退回 `${块}块`（不留空标签）
    const fake = { ...tableDef("表5-1"), blockLabels: undefined } as ReturnType<typeof tableDef>;
    expect(blockLabel(fake, "架构")).toBe("架构块");
  });

  it("按块拆表后，每张表只显示属于自己的行（块内任一列有值）", () => {
    const t = tableDef("表5-1");
    const arch = { layer: "边缘层", components: "边缘网关" };
    const iface = { interface_name: "会议室预定接口", type: "REST" };
    expect(rowBelongsToBlock(t, "架构", arch)).toBe(true);
    expect(rowBelongsToBlock(t, "架构", iface)).toBe(false);
    expect(rowBelongsToBlock(t, "接口", iface)).toBe(true);
    expect(rowBelongsToBlock(t, "接口", arch)).toBe(false);
    expect(rowBelongsToBlock(t, "接口", { interface_name: "  " })).toBe(false);
    expect(rowBelongsToBlock(t, "架构", { boundary: [] })).toBe(false);
    expect(rowBelongsToBlock(tableDef("表5-3"), "任意", {})).toBe(true); // 非块表不参与过滤
  });

  it("块过滤忽略未提供占位词，接口块不再收架构行", () => {
    const t = tableDef("表5-1");
    // 真实库里模型把架构行的接口列全填了「未提供」（智慧厨房）
    const archWithPlaceholders = {
      layer: "设备接入层（厨房设备与传感执行）",
      components: "CT32 网关 + CT15 IO 控制器",
      interface: "RS-485 / ZigBee",
      integration: "经网关协议转换后上行",
      boundary: "不做厨电整机本体",
      interface_name: "未提供",
      type: "未提供",
      protocol: "未提供",
    };
    expect(rowBelongsToBlock(t, "架构", archWithPlaceholders)).toBe(true);
    expect(rowBelongsToBlock(t, "接口", archWithPlaceholders)).toBe(false);

    // 接口行用 layer=接口块 作块标记，不应再被架构块收进去
    const iface = {
      layer: "接口块",
      interface_name: "设备南向接入接口",
      type: "新增",
      protocol: "RS-485 / CAN",
    };
    expect(rowBelongsToBlock(t, "接口", iface)).toBe(true);
    expect(rowBelongsToBlock(t, "架构", iface)).toBe(false);
  });

  it("可选材料：1 张表 5 种 payload，每种 payload 的中栏列（含类别列）≤ 上限", () => {
    const t = tableDef("可选材料");
    expect(Object.keys(t.payloads ?? {})).toHaveLength(5);
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

  it("表1-1 收敛到 6 项业务画像，只有「场景名称」的属主是用户", () => {
    const rows = tableDef("表1-1").fixedRows ?? [];
    expect(rows.map((r) => r.key)).toEqual([
      "scene_name",
      "scene_boundary",
      "production_object",
      "core_systems",
      "buyer_type",
      "procurement",
    ]);
    // 属主划分：用户只输入场景名称，其余由智能体从业务角度写
    expect(rows.filter((r) => r.owner === "用户").map((r) => r.key)).toEqual(["scene_name"]);
    expect(rows.filter((r) => (r.owner ?? "智能体") === "智能体")).toHaveLength(5);
  });

  it("表1-1 用「项 / 内容」两列纵向呈现", () => {
    expect(middleColumns(tableDef("表1-1")).map((c) => c.key)).toEqual(["item", "content"]);
  });

  it("不再有「跨阶段填写的表」：后面的步只跑自己的表，不会回头更新上游表（v1.25）", () => {
    for (const code of ["表2-5", "表3-8"]) {
      const cols = tableDef(code).columns.map((c) => c.key);
      expect(cols, code).not.toContain("compliance_path");
      expect(cols, code).not.toContain("owner");
      expect(cols, code).not.toContain("current_status");
      expect(cols, code).not.toContain("is_digital");
    }
    // 表3-8 的排序/多源验证/预算科目改为阶段 2 自己填
    expect(tableDef("表3-8").columns.find((c) => c.key === "rank")?.required).toBe(true);
    expect(tableDef("表2-5").columns.map((c) => c.key)).toEqual([
      "constraint_item",
      "required_value",
      "standard_no",
      "period",
      "source",
      "evidence_level",
      "authority",
      // v1.27：每张表末尾统一追加核实两列
      "verification_verdict",
      "verification",
    ]);
  });

  it("每张表都带核实两列（v1.27），但表1-1 例外（用户定调 v1.35：它只有项和内容两列，不需要核实）", () => {
    // 例外要有据可查：表1-1 是固定 6 行的画像概览，附加核实列只会产生
    // "必填列校验判它缺值、界面上根本没有这两列"的假问题
    const anchor = TABLES.find((t) => t.code === "表1-1");
    expect(anchor?.columns.some((c) => c.key === "verification_verdict")).toBe(false);
    expect(anchor?.columns.some((c) => c.key === "verification")).toBe(false);
    for (const t of TABLES.filter((x) => x.code !== "表1-1")) {
      const keys = t.columns.map((c) => c.key);
      const verdict = t.columns.find((c) => c.key === "verification_verdict");
      const explain = t.columns.find((c) => c.key === "verification");
      expect(keys.lastIndexOf("verification_verdict"), t.code).toBe(keys.length - 2);
      expect(verdict?.required, t.code).toBe(true);
      expect(verdict?.enum, t.code).toBe("verification_verdict");
      expect(explain?.required, t.code).toBe(true);
      // 核实列一律右栏补充，不占中栏列预算
      expect(verdict?.slot, t.code).toBe("右栏补充");
      expect(
        middleColumns(t).some((c) => c.key.startsWith("verification")),
        t.code,
      ).toBe(false);
    }
    expect(enumValues("verification_verdict")).toEqual([
      "已核实",
      "交叉一致",
      "行业通例",
      "单一来源",
      "无法核实",
      "有反证",
    ]);
  });

  it("表2 规格书按型号分组（groupBy 不进列）", () => {
    const t = tableDef("M2");
    expect(t.groupBy).toBe("product_id");
    expect(middleColumns(t).map((c) => c.key)).not.toContain("product_id");
    expect(supplementColumns(t).map((c) => c.key)).toContain("product_id");
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
      "五、待补齐信息",
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

describe("dependsOnTables — 本步内的真实依赖（按表并发的调度依据）", () => {  it("只对确有其事的表声明依赖（不为了稳而随手加，会把并发收益吃光）", () => {
    // 要素清单 → 分层架构/要素间关系（架构与关系都引用要素名）
    expect(tableDef("表2-3")?.dependsOnTables).toEqual(["表2-2"]);
    expect(tableDef("表2-4")?.dependsOnTables).toEqual(["表2-2"]);
    // 客户现状（表1-2 环节现状）现与能力匹配同在阶段 3（2026-10-14 搬迁）；表2-7 已删除（变更表 #226）：
    // 判断"我方能不能满足"必须站在客户现状上，所以阶段 3 的表都要等这两张先出
    expect(tableDef("表4-1")?.dependsOnTables).toEqual(["表1-2"]);
    // 能力清单 → 需求-能力对照（同样要站在客户现状上）
    expect(tableDef("表4-3")?.dependsOnTables).toEqual(["表4-1", "表1-2"]);
    // 架构 → 实施计划（实施项要落在架构的组件上）
    expect(tableDef("表5-3")?.dependsOnTables).toEqual(["表5-1"]);
  });

  it("依赖只在同阶段内声明（跨阶段靠上游上下文，不写在这里）", () => {
    for (const t of TABLES) {
      for (const dep of t.dependsOnTables ?? []) {
        expect(tableDef(dep), `${t.code} 依赖了不存在的 ${dep}`).toBeDefined();
        expect(
          tableDef(dep)!.stage,
          `${t.code} 跨阶段依赖 ${dep}：应改由上游上下文提供`,
        ).toBe(t.stage);
      }
    }
  });
});

describe("v2.11 资料库精简口径", () => {
  it("M1 只保留 model/name/status/source 四个业务列", () => {
    expect(
      tableDef("M1")!.columns
        .map((c) => c.key)
        .filter((k) => !k.startsWith("verification")),
    ).toEqual(["model", "name", "status", "source"]);
  });

  it("M3 去掉 dependency 与不适用场景，保留 5 个业务列", () => {
    const keys = tableDef("M3")!.columns
      .map((c) => c.key)
      .filter((k) => !k.startsWith("verification"));
    expect(keys).toEqual([
      "domain",
      "name",
      "maturity",
      "description",
      "source",
    ]);
    expect(keys).not.toContain("dependency");
    expect(keys).not.toContain("inapplicable_scene");
  });

  it("M6 报价：阶段 0 / 支撑 / 一个报价口径 / 只保留型号-配置-单价", () => {
    const def = tableDef("M6")!;
    expect(def.name).toBe("报价");
    expect(def.stage).toBe(0);
    expect(def.tier).toBe("支撑");
    expect(def.rowUnit).toBe("一个报价口径");
    expect(
      def.columns.map((c) => c.key).filter((k) => !k.startsWith("verification")),
    ).toEqual(["model", "config", "unit_price"]);
    expect(def.columns.find((c) => c.key === "model")?.refTable).toBe("M1");
    expect(def.columns.some((c) => c.key === "price_scope")).toBe(false);
    expect(def.columns.some((c) => c.key === "valid_until")).toBe(false);
    expect(def.columns.some((c) => c.key === "source")).toBe(false);
    expect(def.completeness?.join(" ")).toContain("产品清单");
    expect(def.consumedBy).toEqual([2, 3]);
  });
});

describe("章节映射与表定义一致", () => {
  it("所有章节映射声明的列都能在表里解到（含右栏补充列）——否则报告会静默丢列", () => {
    /* 防回归（变更表 #153）：装配层 `renderBlock` 按映射里显式写明的 key 取列（不按中栏/右栏过滤）。
       这条用例守住"映射里写的 key 一定存在于表定义"，任何一侧改坏都会在这里被点名。 */
    for (const kind of REPORT_KINDS) {
      for (const chapter of reportChapters(kind)) {
        for (const b of chapter.blocks) {
          // tableDef 对未知表号直接抛错——映射里写错表号这条用例立刻红
          const def = tableDef(b.code);
          for (const key of b.cols ?? []) {
            expect(
              def.columns.map((c) => c.key),
              `${kind}/${chapter.key} · ${b.code} 的列 ${key}`,
            ).toContain(key);
          }
        }
      }
    }
  });
});

describe("tableDisplayName（界面文案用表名）", () => {
  it("已知表号返回业务表名，不是内部表号", () => {
    expect(tableDisplayName("表4-1")).toBe("能力底账");
    expect(tableDisplayName("表2-2")).toBe("场景要素清单");
  });

  it("未知表号原样返回，绝不抛错（提示文案不能因此挂掉）", () => {
    expect(tableDisplayName("表9-9")).toBe("表9-9");
  });
});
