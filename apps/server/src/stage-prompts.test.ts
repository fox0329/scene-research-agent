/**
 * @scene/server — 阶段提示词生成测试（注册表驱动版）
 *
 * 与旧版的区别：提示词内容**由表定义注册表派生**，因此断言的是"派生是否正确"
 * （表清单、字段名、枚举、必填标注、硬规则），而不是硬编码的文案片段。
 */

import { describe, it, expect } from "vitest";
import { STAGE_DEFS, middleColumns, tablesOfStage } from "@scene/contract";
import { buildStagePrompt, getStageOutputContract, renderTableSpec, stageMeta } from "./stage-prompts.js";

const scenario = { name: "智慧水务", description: "客户：市政水务集团", brief: "想搞清楚值不值得进" };
const anchor = [
  { item: "场景名称", content: "智慧水务" },
  { item: "场景边界", content: "制水厂到管网末端" },
];

describe("stage-prompts — 阶段覆盖（8 阶段口径）", () => {
  it("阶段 0-7 都能构建 prompt", () => {
    for (const s of STAGE_DEFS) {
      const p = buildStagePrompt(s.id, { "表1-1": anchor }, scenario);
      expect(p.system.length, `阶段 ${s.id}`).toBeGreaterThan(200);
      expect(p.user.length).toBeGreaterThan(100);
      expect(p.outputContract).toBeTruthy();
    }
  });

  it("老编号的阶段 7/8 明确报错（总结沉淀已删、交付物现为阶段 6）", () => {
    expect(() => buildStagePrompt(8 as never, {})).toThrow(/老编号/);
    expect(() => getStageOutputContract(8 as never)).toThrow(/老编号/);
    expect(() => buildStagePrompt(7 as never, {})).toThrow(/老编号/);
  });
});

describe("stage-prompts — 内容由注册表派生", () => {
  it("system 列出本阶段全部表（表号 + 名称 + 级别 + 行粒度）", () => {
    for (const s of STAGE_DEFS) {
      const p = buildStagePrompt(s.id, {}, scenario);
      for (const t of tablesOfStage(s.id)) {
        expect(p.system, `阶段 ${s.id} / ${t.code}`).toContain(`${t.code} ${t.name}`);
        expect(p.system).toContain(t.rowUnit);
        expect(p.system).toContain(`级别：${t.tier}`);
      }
    }
  });

  it("system 列出每张表的全部中栏列字段名", () => {
    const p = buildStagePrompt(1, {}, scenario);
    for (const t of tablesOfStage(1)) {
      for (const c of middleColumns(t)) {
        expect(p.system, `${t.code}.${c.key}`).toContain(`\`${c.key}\``);
      }
    }
  });

  it("必填与枚举在字段清单里标注", () => {
    const p = buildStagePrompt(1, {}, scenario);
    expect(p.system).toContain("必填");
    expect(p.system).toContain("枚举 barrier_type");
  });

  it("枚举必须带**合法取值**（只给枚举名时模型会自己编：实机 61 处非法值）", () => {
    const p = buildStagePrompt(1, {}, scenario);
    // 五个门槛类型逐个列出，不再只写「枚举 barrier_type」
    for (const v of ["技术", "行业准入", "经济", "生态锁定", "一票否决者"]) {
      expect(p.system).toContain(v);
    }
    expect(p.system).toMatch(/枚举 barrier_type，只能取：/);
    // 输出契约里同样带取值，模型两条通路都看得到
    const contract = JSON.stringify(p.outputContract);
    expect(contract).toContain("只能取：");
    expect(contract).toContain("高 / 中 / 低");
  });

  it("表1-1 的固定行逐个列出，且只给「场景名称」标「用户输入」", () => {
    const p = buildStagePrompt(1, {}, scenario);
    expect(p.system).toContain("固定行");
    expect(p.system).toContain("场景名称（必填）（用户输入）");
    // 其余 5 项是智能体该写的业务画像 —— 不能反过来标成"等用户确认"
    expect(p.system).toContain("场景边界（必填）");
    expect(p.system).toContain("采购特征");
    expect(p.system).not.toContain("需用户确认");
  });

  it("renderTableSpec 对可选材料列出 6 种 payload", () => {
    const t = tablesOfStage(0).find((x) => x.code === "可选材料")!;
    const spec = renderTableSpec(t);
    for (const cat of ["O1认证", "O2案例", "O3价格与授权", "O4开发资料", "O5路线图", "O6交付与生态"]) {
      expect(spec).toContain(cat);
    }
  });

  it("多子块表（方案架构 + 接口清单）按块渲染字段", () => {
    /* 表5-5 成本估算已删（变更表 #105）→ 阶段 4 的多子块表只剩 表5-1 */
    const p = buildStagePrompt(4, {}, scenario);
    expect(p.system).toContain("表5-1 架构与接口");
    expect(p.system).toContain("`layer`");
    expect(p.system).toContain("`interface_name`");
  });

  it("system 里不再有「跨阶段填写」标注（v1.25 删掉跨阶段补填）", () => {
    for (const stage of [1, 2, 3, 4] as const) {
      expect(buildStagePrompt(stage, {}, scenario).system).not.toContain("跨阶段填写");
    }
  });
});

describe("stage-prompts — 信息版口径（不给决策建议 + 每条信息必须自己核实）", () => {
  const forbidden = ["建议进", "建议有条件进", "建议不通过", "一票否决后不进"];

  it("任何阶段的 prompt 都不含建议档位措辞", () => {
    for (const s of STAGE_DEFS) {
      const p = buildStagePrompt(s.id, {}, scenario);
      for (const bad of forbidden) {
        expect(p.system, `阶段 ${s.id}`).not.toContain(bad);
        expect(p.user).not.toContain(bad);
      }
    }
  });

  it("system 明确声明「不给决策建议 / 每条信息必须自己核实」与「不得自称用户确认」", () => {
    const p = buildStagePrompt(3, {}, scenario);
    expect(p.system).toContain("不给决策建议");
    expect(p.system).toContain("每条信息必须由你核实");
    expect(p.system).toContain("verification_verdict");
    expect(p.system).toContain("禁止把核实推给读者");
    expect(p.system).toContain("不得自称「用户确认」");
    // 反编造与「行业行情要写满」是一对相反的要求，必须同时在场（见下方 market 用例）
    expect(p.system).toContain("没有材料依据就写「未提供」");
    expect(p.system).toContain("行业公共知识");
  });

  /**
   * 第 3 步（理解商业）的回归：这一阶段产出的是**行业行情**（毛利、玩家、采购机制、
   * 门槛、趋势），可旧口径「依据不足就填未提供」让它整列留白——用户原话「认识场景
   * 商业理解之后主要就是要了解市场信息，你全都不填，要用户自己填吗？」。
   * 这里把口径钉住：行情必须写满并标 C/T4（待验证由 authority 列表达），具体事实才可留「未提供」。
   */
  it("阶段 2 的市场行情口径：必须写满 + 行业通例 C/T4（不许退回给用户）", () => {
    const market = buildStagePrompt(2, {}, scenario);
    expect(market.system).toContain("市场行情必须由你写出来");
    expect(market.system).toContain("不许整列留「未提供」");
    expect(market.system).toContain("行业通例（模型知识）");
    expect(market.system).toContain("毛利率");
    expect(market.system).toContain("主导者");
    expect(market.system).toContain("时间窗口");

    // 别的阶段不该被塞进市场口径（能力匹配等阶段的事实仍以材料为准）
    for (const other of [1, 3, 4, 5] as const) {
      expect(buildStagePrompt(other, {}, scenario).system).not.toContain("市场行情必须由你写出来");
    }
  });

  it("user 注入场景诉求与场景锚", () => {
    const p = buildStagePrompt(2, { "表1-1": anchor }, scenario);
    expect(p.user).toContain("场景诉求（第一输入，唯一基准）");
    expect(p.user).toContain("想搞清楚值不值得进");
    expect(p.user).toContain("场景锚（表1-1");
    expect(p.user).toContain("场景边界：制水厂到管网末端");
  });

  it("场景锚为空时给出明确提示而非留白", () => {
    const p = buildStagePrompt(1, {}, scenario);
    expect(p.user).toContain("场景锚尚未填写");
  });

  it("上游数据带来源标注时，首列是「资料来源」（主库/本场景可区分）", () => {
    const p = buildStagePrompt(
      3,
      {
        M1_产品型号: [
          { model: "IPC-3000", name: "边缘控制器", data_scope: "本场景" },
          { model: "SEN-200", name: "压力变送器", data_scope: "主库：公司产品库" },
        ],
      },
      scenario,
    );
    expect(p.user).toContain("资料来源");
    expect(p.user).toContain("本场景");
    expect(p.user).toContain("主库：公司产品库");
  });

  it("上游数据按表渲染为表格，空表不出现", () => {
    const p = buildStagePrompt(1, { M1: [{ model: "IPC-3000", name: "IPC" }], M2: [] }, scenario);
    expect(p.user).toContain("M1 产品清单（1 行）");
    expect(p.user).not.toContain("M2 规格书（0 行）");
  });
});

describe("stage-prompts — 输出契约（补契约空壳）", () => {
  it("table_code 的 enum 等于本阶段表号（由注册表派生）", () => {
    for (const s of STAGE_DEFS) {
      if (tablesOfStage(s.id).length === 0) continue;
      const c = getStageOutputContract(s.id) as {
        properties: { rows: { items: { properties: { table_code: { enum: string[] } } } } };
      };
      expect(c.properties.rows.items.properties.table_code.enum).toEqual(
        tablesOfStage(s.id).map((t) => t.code),
      );
    }
  });

  it("fields.properties 列出本阶段全部合法字段名（模型不能自创键名）", () => {
    const c = getStageOutputContract(1) as {
      properties: { rows: { items: { properties: { fields: { properties: Record<string, unknown> } } } } };
    };
    const keys = Object.keys(c.properties.rows.items.properties.fields.properties);
    for (const t of tablesOfStage(1)) {
      for (const col of t.columns) {
        expect(keys, `${t.code}.${col.key}`).toContain(col.key);
      }
    }
    expect(keys).toContain("source");
  });

  it("source_type 只允许 AI提取 / AI推断", () => {
    const c = getStageOutputContract(2) as {
      properties: { rows: { items: { properties: { source_type: { enum: string[] } } } } };
    };
    expect(c.properties.rows.items.properties.source_type.enum).toEqual(["AI提取", "AI推断"]);
  });

  it("阶段 6（交付物）不要求 rows，而要两份文档", () => {
    const c = getStageOutputContract(6) as { required: string[]; properties: Record<string, unknown> };
    expect(c.required).toEqual(["internal_report", "external_report"]);
    expect(c.properties["rows"]).toBeUndefined();
  });
});

describe("stage-prompts — 流程步限定表集（v1.5）", () => {
  it("限定表集后：system 只渲染本步的表，契约 enum 也只含本步表号", () => {
    const step3 = ["表1-2", "表1-3", "表2-2", "表2-3", "表2-4", "表2-5", "表2-7"];
    const p = buildStagePrompt(1, {}, scenario, { tables: step3 });
    // 不再出现场景锚（它属第 2 步，由起草 + 用户确认产生）
    expect(p.system).not.toContain("### 表1-1");
    expect(p.system).toContain("### 表1-2");
    expect(p.system).toContain("### 表2-7");
    const c = p.outputContract as {
      properties: { rows: { items: { properties: { table_code: { enum: string[] } } } } };
    };
    expect(c.properties.rows.items.properties.table_code.enum).toEqual(step3);
  });

  it("不传限定表集时保持原行为（阶段全部表）", () => {
    const p = buildStagePrompt(1, {}, scenario);
    expect(p.system).toContain("### 表1-1");
    expect(p.system).toContain("### 表2-7");
  });
});

describe("stage-prompts — 阶段元信息", () => {
  it("stageMeta 覆盖 7 阶段（0-6）且表清单与注册表一致", () => {
    const meta = stageMeta();
    expect(meta).toHaveLength(7);
    for (const m of meta) {
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.tables).toEqual(tablesOfStage(m.id as 0).map((t) => t.code));
    }
    expect(meta[6]?.tables).toEqual([]); // 交付物阶段无表
  });
});
