/**
 * constraint-check / value-check 测试 ——「约束的边界」与「内容的价值」
 *
 * 用例取自用户真实库（表2-5 共 21 行），用户定调：「不用合成一张表，要区分边界，
 * 同时要确认表格内容是否真有价值，进入表格的内容要确认价值」。
 */

import { describe, expect, it } from "vitest";
import { judgeConstraint } from "./constraint-check.js";
import { judgeRowValue } from "./value-check.js";

describe("judgeConstraint — 可执行的约束应当成立", () => {
  it("给了数值与周期（采集周期 1–10 s）算约束", () => {
    expect(
      judgeConstraint({
        constraint_item: "压铸机数据采集频率与实时性",
        required_value: "设备状态与节拍类数据采集周期 1–10 s；OEE 统计按班次/日汇总，实时看板刷新 ≤5 s",
        period: "连续运行（三班制）",
      }).isConstraint,
    ).toBe(true);
  });

  it("给了等级（一级A）算约束", () => {
    expect(
      judgeConstraint({
        constraint_item: "出水水质排放限值（COD、氨氮、总磷等）",
        required_value: "按《城镇污水处理厂污染物排放标准》一级A标准执行",
        standard_no: "GB 18918-2002",
      }).isConstraint,
    ).toBe(true);
  });

  it("给了具名清单（协议 / 指标）算约束", () => {
    expect(
      judgeConstraint({
        constraint_item: "自动化控制系统通信协议与互操作",
        required_value: "现场仪表与 PLC 通信采用 Modbus RTU/TCP、Profibus、OPC UA 等标准协议",
        standard_no: "IEC 62541（OPC UA）",
      }).isConstraint,
    ).toBe(true);
  });

  it("没有标准号但有明确数量（≥3 年留存）仍算约束", () => {
    expect(
      judgeConstraint({
        constraint_item: "数据留存",
        required_value: "在线监测原始数据与运行台账留存不少于 3 年",
      }).isConstraint,
    ).toBe(true);
  });
});

describe("judgeConstraint — 门槛复述与空约束不成立", () => {
  it("「排污许可与自行监测」是门槛复述 → 指向表1-3（真实库）", () => {
    const v = judgeConstraint({
      constraint_item: "排污许可与自行监测",
      required_value: "持证排污，按许可证载明的排放口、因子、频次开展自行监测并留存原始记录",
      standard_no: "HJ 819-2017",
    });
    expect(v.isConstraint).toBe(false);
    expect(v.failures.join()).toContain("准入门槛的复述");
    expect(v.suggestTable).toContain("表1-3");
  });

  it("「量级待确认」的施工窗口不成立（真实库）", () => {
    const v = judgeConstraint({
      constraint_item: "设备联网改造的施工与停机窗口约束",
      required_value: "改造须在计划停机或换模窗口内完成，单台设备停机时长量级为数小时（行业口径，量级待确认）",
    });
    expect(v.isConstraint).toBe(false);
    expect(v.failures.join()).toContain("落不了地");
  });

  it("只引标准不给数值（能耗限额）不成立（真实库）", () => {
    expect(
      judgeConstraint({
        constraint_item: "能耗限额与能效对标",
        required_value: "单位污水处理电耗按地方能耗限额标准或行业对标值考核，一般要求吨水电耗不高于地方限定值",
        standard_no: "GB/T 51161-2016",
      }).isConstraint,
    ).toBe(false);
  });

  it("一行塞多个约束项 → 不成立（真实库最后一行）", () => {
    const v = judgeConstraint({
      constraint_item: "本场景具体约束（本厂排放限值、能耗限额、系统定级、协议清单、计量台账）",
      required_value: "行业口径：排放限值按 GB 18918-2002 及排污许可证确定",
    });
    expect(v.isConstraint).toBe(false);
    expect(v.failures.join()).toContain("一行塞了多个约束项");
  });

  it("缺要求值 → 直接不成立", () => {
    expect(judgeConstraint({ constraint_item: "x", required_value: "" }).isConstraint).toBe(false);
  });
});

describe("judgeRowValue — 有内容不等于有价值", () => {
  it("整行全是占位词 → 无价值", () => {
    const v = judgeRowValue(["未提供", "", "待补"]);
    expect(v.hasValue).toBe(false);
    expect(v.reason).toContain("占位词");
  });

  it("整行只有空话 → 无价值", () => {
    const v = judgeRowValue(["待确认", "需进一步调研"]);
    expect(v.hasValue).toBe(false);
    expect(v.reason).toContain("空话");
  });

  it("信息量太短 → 无价值", () => {
    expect(judgeRowValue(["无"]).hasValue).toBe(false);
    expect(judgeRowValue(["看"]).hasValue).toBe(false);
  });

  it("有实质内容 → 有价值（含一格为空也算）", () => {
    expect(judgeRowValue(["压铸机", "", "OPC UA/Modbus TCP 协议"]).hasValue).toBe(true);
  });

  it("占位词与真内容混排 → 有价值（不能因为一格未提供就删整行）", () => {
    expect(judgeRowValue(["未提供", "IATF 16949 追溯要求"]).hasValue).toBe(true);
  });
});
