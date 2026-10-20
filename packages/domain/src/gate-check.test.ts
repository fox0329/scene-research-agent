/**
 * gate-check 测试 —「什么才算门槛」
 *
 * 用例全部取自**用户真实库里的 19 行**（汽车零部件压铸车间 OEE / 城镇污水处理厂能耗），
 * 不是编的样例：这批数据里 10 行是难度/成本/风险被写成了门槛，正是用户定调的由来
 * （「所谓的门槛一定是要真实，而且重要的……只是普通的要求不能叫门槛」）。
 */

import { describe, expect, it } from "vitest";
import { findFakeGates, judgeGate } from "./gate-check.js";

/** 真门槛：防爆等级（用户原话里举的例子） */
const EXPLOSION_PROOF = {
  barrier_type: "行业准入",
  barrier_name: "粉尘环境电气设备防爆合格证",
  veto_holder: "应急管理部门与第三方防爆认证机构",
  criteria: "镁合金粉尘环境须选用带 Ex 标志的粉尘防爆设备（Ex tD），设备须取得防爆合格证后方可安装",
  verification: "《爆炸危险环境电力装置设计规范》GB 50058 对粉尘环境选型有强制要求",
};

/** 真门槛：装备承制资格（用户原话里举的例子） */
const WEAPON_QUALIFICATION = {
  barrier_type: "行业准入",
  barrier_name: "装备承制单位资格",
  veto_holder: "军方装备主管部门",
  criteria: "须列入《装备承制单位名录》并具备相应保密资格，未列入者不得参与投标",
};

describe("judgeGate — 真门槛应当成立", () => {
  it("防爆合格证（用户举的例子）算门槛", () => {
    const v = judgeGate(EXPLOSION_PROOF);
    expect(v.isGate, v.failures.join("；")).toBe(true);
    expect(v.suggestTable).toBeNull();
  });

  it("装备承制资格（用户举的例子）算门槛", () => {
    expect(judgeGate(WEAPON_QUALIFICATION).isGate).toBe(true);
  });

  it("IATF 16949 过程审核（真实库）算门槛", () => {
    expect(
      judgeGate({
        barrier_type: "行业准入",
        barrier_name: "汽车行业质量管理体系与过程审核要求（IATF 16949 / VDA 6.3）",
        veto_holder: "整车厂（OEM）客户与第三方认证机构",
        criteria: "汽车零部件供应商须通过 IATF 16949 并接受 VDA 6.3 过程审核，过程与质量数据须可追溯、可审计",
      }).isGate,
    ).toBe(true);
  });

  it("等保 2.0 工控安全（真实库）算门槛", () => {
    expect(
      judgeGate({
        barrier_type: "行业准入",
        barrier_name: "工业数据采集与联网的网络安全合规要求",
        veto_holder: "企业信息安全部门与监管/合规审查",
        criteria: "工业控制系统联网须满足《网络安全法》与等级保护 2.0（GB/T 22239）相关要求",
      }).isGate,
    ).toBe(true);
  });

  it("生态锁定写清不可替代性后算门槛（用户定调保留该类型）", () => {
    expect(
      judgeGate({
        barrier_type: "生态锁定",
        barrier_name: "MES 厂商独家接口",
        veto_holder: "既有 MES 供应商",
        criteria: "MES 采用私有协议且不开放接口，数据只能由原厂网关采集，否则无法与生产工单对齐",
      }).isGate,
    ).toBe(true);
  });

  it("经济类给出量化阈值与立项口径后算门槛（用户定调保留该类型）", () => {
    expect(
      judgeGate({
        barrier_type: "经济",
        barrier_name: "立项回收期上限",
        veto_holder: "企业投资决策层与财务部门",
        criteria: "立项要求投资回收期 ≤3 年，单厂改造预算上限 200 万元，超出不予立项",
      }).isGate,
    ).toBe(true);
  });
});

describe("judgeGate — 普通要求不算门槛（真实库里的误判）", () => {
  it("技术难度：接口封闭、协议不开放 → 不是门槛", () => {
    const v = judgeGate({
      barrier_type: "技术",
      barrier_name: "压铸机（压铸单元）数据接口封闭、协议不开放",
      veto_holder: "压铸机与自动化设备供应商",
      criteria: "主流压铸机控制器数据接口开放程度不一，取数多需经 OPC UA/Modbus TCP 或厂商网关",
    });
    expect(v.isGate).toBe(false);
    expect(v.failures.join()).toContain("技术难度");
    expect(v.suggestTable).toContain("表1-2");
  });

  it("多源异构协议接入 → 不是门槛（是工作量）", () => {
    const v = judgeGate({
      barrier_type: "技术",
      barrier_name: "多源异构设备与协议并存，需统一数据采集与语义层",
      veto_holder: "车间既有设备品牌与协议碎片化",
      criteria: "车间内压铸机、机器人、模温机等设备协议与状态定义不统一，需建统一采集与语义层",
    });
    expect(v.isGate).toBe(false);
  });

  it("车间环境约束（高温油污）→ 不是门槛，归表2-5", () => {
    const v = judgeGate({
      barrier_type: "技术",
      barrier_name: "车间网络与边缘侧环境约束",
      veto_holder: "车间现场环境与既有网络条件",
      criteria: "车间高温、油雾与电磁干扰对采集设备与布线构成环境约束",
    });
    expect(v.isGate).toBe(false);
    expect(v.suggestTable).toContain("表2-5");
  });

  it("一次性投入几十万 → 不是门槛（没给立项口径）", () => {
    const v = judgeGate({
      barrier_type: "经济",
      barrier_name: "单车间设备联网与 OEE 系统的一次性投入门槛",
      veto_holder: "企业投资决策层（设备/信息化预算审批）",
      criteria: "数十台规模车间的设备联网与 OEE 系统一次性投入为数十万元至百万元级",
    });
    expect(v.isGate).toBe(false);
    expect(v.suggestTable).toContain("表6-1");
  });

  it("生态绑定只说风险、没说不替代 → 不是门槛，归表3-5", () => {
    const v = judgeGate({
      barrier_type: "生态锁定",
      barrier_name: "压铸机厂商自带数据平台与专用网关的生态绑定",
      veto_holder: "压铸机与自动化设备供应商",
      criteria: "部分压铸机厂商提供自带数据模块或云平台，采用私有协议，可能影响跨品牌统一采集",
    });
    expect(v.isGate).toBe(false);
    expect(v.suggestTable).toContain("表3-5");
  });

  it("车间内部角色的接受度 → 不是准入门槛，归表4-2", () => {
    const v = judgeGate({
      barrier_type: "一票否决者",
      barrier_name: "车间生产与设备管理部门对停机采集与数据真实性的接受度",
      veto_holder: "车间主任/生产经理与设备主管",
      criteria: "OEE 数据涉及班组考核与责任归属，采集口径与停机分类需与车间达成一致",
    });
    expect(v.isGate).toBe(false);
    expect(v.failures.join()).toContain("内部角色");
    expect(v.suggestTable).toContain("表4-2");
  });

  it("没写否决者 → 不成立（说不清谁在卡）", () => {
    const v = judgeGate({
      barrier_type: "生态锁定",
      barrier_name: "既有 SCADA/PLC 品牌与上位系统生态锁定",
      veto_holder: "",
      criteria: "既有 PLC/SCADA 以上位组态为主，接口开放程度不明",
    });
    expect(v.isGate).toBe(false);
    expect(v.failures.join()).toContain("没写否决者");
  });

  it("类型非法 → 直接不成立", () => {
    const v = judgeGate({ barrier_type: "资质门槛", barrier_name: "x", criteria: "y" });
    expect(v.isGate).toBe(false);
    expect(v.failures.join()).toContain("类型非法");
  });
});

describe("judgeGate — 外部硬性要求不以写出「否则」为前提", () => {
  it("OEM 追溯要求（真实库，原文没写后果）仍算门槛", () => {
    expect(
      judgeGate({
        barrier_type: "一票否决者",
        barrier_name: "整车厂（OEM）客户对供应商生产数据与追溯的要求",
        veto_holder: "整车厂客户（OEM）及其供应商质量管理部",
        criteria: "汽车零部件供应商须满足 OEM 对关键件生产过程可追溯、批次与质量数据可提供的要求",
      }).isGate,
    ).toBe(true);
  });
});

describe("findFakeGates — 批量只回不成立的行", () => {
  it("混合样本里只挑出假门槛，并带上定位与建议表", () => {
    const out = findFakeGates([
      { id: "r1", fields: EXPLOSION_PROOF },
      { id: "r2", fields: { ...EXPLOSION_PROOF, barrier_type: "技术", criteria: "接口封闭，协议不开放" } },
      { id: "r3", fields: WEAPON_QUALIFICATION },
    ]);
    expect(out).toHaveLength(1);
    const [first] = out;
    expect(first?.id).toBe("r2");
    expect(first?.verdict.suggestTable).toBeTruthy();
  });
});
