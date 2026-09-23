/**
 * @scene/server — 阶段 prompt 模板单测（阶段 0-8）
 *
 * 覆盖：每个阶段 system/user/contract 三件套齐全、表号枚举与契约一致、
 * 上游数据注入格式。
 */

import { describe, it, expect } from "vitest";
import type { StageId } from "@scene/contract";
import {
  STAGE3_TABLES,
  STAGE4_TABLES,
  STAGE5_TABLES,
  STAGE6_TABLES,
  STAGE7_TABLES,
  STAGE8_TABLES,
} from "@scene/contract";
import { buildStagePrompt, getStageOutputContract } from "./stage-prompts.js";

const ALL_STAGES: StageId[] = [0, 1, 2, 3, 4, 5, 6, 7, 8];

describe("buildStagePrompt 阶段 0-8", () => {
  for (const stage of ALL_STAGES) {
    it(`阶段 ${stage} 返回完整 StagePrompt`, () => {
      const prompt = buildStagePrompt(stage, {
        "表1-1": [{ scene_name: "测试场景" }],
      });
      expect(prompt.system.length).toBeGreaterThan(50);
      expect(prompt.user).toContain("表1-1");
      expect(prompt.user).toContain("测试场景");
      expect(prompt.outputContract).toBeTruthy();
    });
  }

  it("阶段 3 system 含利润池/替代方案/未被满足的需求表结构", () => {
    const { system } = buildStage3();
    expect(system).toContain("表3-1 利润池");
    expect(system).toContain("表3-6 替代方案");
    expect(system).toContain("表3-8 未被满足的需求");
  });

  it("阶段 4 system 含匹配矩阵三档判定与买方语言规则", () => {
    const { system } = buildStage4();
    expect(system).toContain("真能解/条件能解/不能承诺");
    expect(system).toContain("买方语言");
  });

  it("阶段 5 system 含成本单价来源硬规则", () => {
    const { system } = buildStage5();
    expect(system).toContain("M6 内部费率基准");
    expect(system).toContain("禁止编造");
  });

  it("阶段 6 system 含 ROI C 级假设与双口径分离", () => {
    const { system } = buildStage6();
    expect(system).toContain("C 级假设");
    expect(system).toContain("表6-6 价值呈现双口径");
  });

  it("阶段 7 system 声明不负责的数据库回写", () => {
    const { system } = buildStage7();
    expect(system).toContain("本阶段不负责回写");
  });

  it("阶段 8 system 含对外材料硬性禁令", () => {
    const { system } = buildStage8();
    expect(system).toContain("不含竞品名字");
    expect(system).toContain("表8-内部");
    expect(system).toContain("表8-对外");
  });

  it("上游空数组不注入 user prompt", () => {
    const { user } = buildStagePrompt(3, { "表3-1": [], "表3-2": undefined });
    expect(user).not.toContain("### 表3-1");
    expect(user).not.toContain("### 表3-2");
  });
});

describe("getStageOutputContract 阶段 0-8", () => {
  const expectedEnums: Array<[StageId, readonly string[]]> = [
    [3, STAGE3_TABLES],
    [4, STAGE4_TABLES],
    [5, STAGE5_TABLES],
    [6, STAGE6_TABLES],
    [7, STAGE7_TABLES],
    [8, STAGE8_TABLES],
  ];

  for (const [stage, tables] of expectedEnums) {
    it(`阶段 ${stage} 契约 table_code 枚举与契约表号一致`, () => {
      const contract = getStageOutputContract(stage);
      const rows = contract.properties as Record<string, unknown>;
      const items = (rows.rows as Record<string, unknown>).items as Record<string, unknown>;
      const props = items.properties as Record<string, unknown>;
      const tc = props.table_code as Record<string, unknown>;
      expect(tc.enum).toEqual([...tables]);
    });
  }

  it("阶段 0-2 契约可获取", () => {
    for (const stage of [0, 1, 2] as StageId[]) {
      expect(getStageOutputContract(stage)).toBeTruthy();
    }
  });
});

// ─── 便捷封装（避免重复传参） ──────────────────────────────

function buildStage3() {
  return buildStagePrompt(3, {});
}
function buildStage4() {
  return buildStagePrompt(4, {});
}
function buildStage5() {
  return buildStagePrompt(5, {});
}
function buildStage6() {
  return buildStagePrompt(6, {});
}
function buildStage7() {
  return buildStagePrompt(7, {});
}
function buildStage8() {
  return buildStagePrompt(8, {});
}
