import { describe, it, expect } from "vitest";
import { judgeBarrier, planStrategy } from "./barrier-scan.js";
import type { BarrierType } from "./barrier-scan.js";

// ─── judgeBarrier ────────────────────────────────────────────

describe("judgeBarrier", () => {
  it("现状满足判据 → 过得了", () => {
    expect(judgeBarrier("技术", "IP65 防护等级", "已具备 IP66，过得了")).toBe("过得了");
    expect(judgeBarrier("行业准入", "等保三级", "已认证")).toBe("过得了");
  });

  it("现状不满足判据 → 过不了", () => {
    expect(judgeBarrier("技术", "支持 Modbus 协议", "不具备该协议，过不了")).toBe("过不了");
    expect(judgeBarrier("行业准入", "国家强制 CCC 认证", "未认证")).toBe("过不了");
  });

  it("未调研类现状 → 不知道（优先暴露，标注调研重点）", () => {
    expect(judgeBarrier("经济", "单点价值密度≥10万", "不知道")).toBe("不知道");
    expect(judgeBarrier("技术", "工作温度 -40℃", "待确认")).toBe("不知道");
    expect(judgeBarrier("经济", "预算科目", "未调研")).toBe("不知道");
  });

  it("政策窗口类现状 → 等窗口", () => {
    expect(judgeBarrier("行业准入", "数据出境许可", "等政策放开")).toBe("等窗口");
    expect(judgeBarrier("行业准入", "行业标准立项", "窗口期未开")).toBe("等窗口");
  });

  it("生态锁定走合作方 → 借道", () => {
    expect(judgeBarrier("生态锁定", "私有协议授权分成", "借道：经总代授权进入")).toBe("借道");
    expect(judgeBarrier("生态锁定", "认证生态", "与生态主合作")).toBe("借道");
  });

  it("生态锁定走替代路径 → 绕道", () => {
    expect(judgeBarrier("生态锁定", "接口不开放", "绕道：自建网关转换")).toBe("绕道");
    expect(judgeBarrier("生态锁定", "存量绑定", "替代接口可用")).toBe("绕道");
  });

  it("一票否决者行使否决 → 过不了", () => {
    expect(judgeBarrier("一票否决者", "安全条线：数据不出域", "安全条线否决云方案")).toBe("过不了");
    expect(judgeBarrier("一票否决者", "法务：隐私合规", "明文禁止二次采集")).toBe("过不了");
  });

  it("五类门槛类型均可判定（全类型覆盖）", () => {
    const types: BarrierType[] = ["技术", "行业准入", "经济", "生态锁定", "一票否决者"];
    for (const t of types) {
      expect(judgeBarrier(t, "判据", "过得了")).toBe("过得了");
    }
  });

  it("现状无法归类 → 兜底不知道（宁可标调研重点）", () => {
    expect(judgeBarrier("经济", "毛利率≥30%", "利润池位置不明")).toBe("不知道");
  });

  it("不知道优先于其他关键词（未调研不被后续规则淹没）", () => {
    expect(judgeBarrier("技术", "标准号 GB/T 28181", "满足与否不知道")).toBe("不知道");
  });

  it("门槛类型非法抛错", () => {
    expect(() => judgeBarrier("资质" as BarrierType, "判据", "过得了")).toThrow("门槛类型非法");
  });

  it("判据为空抛错（判定必须落在确定性层）", () => {
    expect(() => judgeBarrier("技术", "", "过得了")).toThrow("判据不能为空");
    expect(() => judgeBarrier("技术", "  ", "过得了")).toThrow("判据不能为空");
  });

  it("现状为空抛错", () => {
    expect(() => judgeBarrier("经济", "预算科目", "")).toThrow("现状不能为空");
    expect(() => judgeBarrier("经济", "预算科目", " \t ")).toThrow("现状不能为空");
  });
});

// ─── planStrategy ────────────────────────────────────────────

describe("planStrategy", () => {
  it("过得了 → 直接进入", () => {
    expect(planStrategy("过得了")).toBe("直接进入");
  });

  it("绕道 → 找替代路径", () => {
    expect(planStrategy("绕道")).toBe("找替代路径");
  });

  it("借道 → 找合作伙伴", () => {
    expect(planStrategy("借道")).toBe("找合作伙伴");
  });

  it("过不了 → 不进入", () => {
    expect(planStrategy("过不了")).toBe("不进入");
  });

  it("等窗口 → 等政策变化", () => {
    expect(planStrategy("等窗口")).toBe("等政策变化");
  });

  it("不知道 → 列为调研重点", () => {
    expect(planStrategy("不知道")).toBe("列为调研重点");
  });

  it("六态判定全覆盖（表 1-4 策略口径完整）", () => {
    const mapping = {
      过得了: "直接进入",
      绕道: "找替代路径",
      借道: "找合作伙伴",
      过不了: "不进入",
      等窗口: "等政策变化",
      不知道: "列为调研重点",
    } as const;
    for (const [judgment, strategy] of Object.entries(mapping)) {
      expect(planStrategy(judgment as keyof typeof mapping)).toBe(strategy);
    }
  });
});

// ─── judgeBarrier + planStrategy 组合（表 1-3 → 表 1-4） ────

describe("judgeBarrier 与 planStrategy 组合", () => {
  it("门槛扫描 → 处置策略全链路（00b 表 1-3/1-4）", () => {
    expect(planStrategy(judgeBarrier("行业准入", "CCC 强制认证", "已认证"))).toBe("直接进入");
    expect(planStrategy(judgeBarrier("生态锁定", "接口不开放", "绕道"))).toBe("找替代路径");
    expect(planStrategy(judgeBarrier("生态锁定", "授权分成", "借道"))).toBe("找合作伙伴");
    expect(planStrategy(judgeBarrier("技术", "-40℃ 低温", "不满足"))).toBe("不进入");
    expect(planStrategy(judgeBarrier("行业准入", "数据出境", "等政策"))).toBe("等政策变化");
    expect(planStrategy(judgeBarrier("经济", "预算科目", "不清楚"))).toBe("列为调研重点");
  });
});
