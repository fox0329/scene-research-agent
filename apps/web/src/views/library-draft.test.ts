import { describe, expect, it } from "vitest";
import {
  draftPayload,
  draftReady,
  isDraftRow,
  makeDraftRow,
} from "./library-draft.js";

describe("资料库新增行草稿", () => {
  it("新建草稿带合法缺省值，但不替用户猜产品名/能力描述", () => {
    const m1 = makeDraftRow("M1");
    expect(m1.status).toBe("待确认");
    expect(m1.name).toBeUndefined();
    expect(m1.model).toBeUndefined();

    const m3 = makeDraftRow("M3");
    expect(m3.name).toBeUndefined();
    expect(m3.description).toBeUndefined();
    expect(m3.domain).toBeUndefined();

    expect(makeDraftRow("M6").price_scope).toBe("纯设备");
  });

  it("M1 填型号和名称才算可保存", () => {
    const row = makeDraftRow("M1");
    row.model = "CT21B";
    expect(draftReady("M1", row)).toBe(false);
    row.name = "在鸿工控机";
    expect(draftReady("M1", row)).toBe(true);
  });

  it("M3 空表：名称 + 描述填完才保存", () => {
    const row = makeDraftRow("M3");
    row.name = "边缘推理";
    expect(draftReady("M3", row)).toBe(false);
    row.description = "支持 6TOPS NPU 推理";
    expect(draftReady("M3", row)).toBe(true);
  });

  it("M4 不做必须有来源和依据；限制不要求依据", () => {
    const row = makeDraftRow("M4");
    row.description = "不做平台二次开发";
    expect(draftReady("M4", row)).toBe(false);
    row.reason = "安全功能由独立 PLC 承载";
    expect(draftReady("M4", row)).toBe(false);
    row.source = "产品说明.pdf:12";
    expect(draftReady("M4", row)).toBe(true);

    const limitation = makeDraftRow("M4");
    limitation.type = "限制";
    limitation.description = "无 5G";
    expect(draftReady("M4", limitation)).toBe(true);
  });

  it("M2 必须绑定产品；O 表至少填一个业务字段", () => {
    const spec = makeDraftRow("M2");
    spec.param_name = "网口";
    spec.value = "2 路";
    expect(draftReady("M2", spec)).toBe(false);
    spec.product_id = "p-1";
    expect(draftReady("M2", spec)).toBe(true);

    const cert = makeDraftRow("O1");
    const o1Required = ["model", "cert_type", "cert_no", "valid_until", "issuer"];
    expect(draftReady("O1", cert, o1Required)).toBe(false);
    cert.model = "CT21B";
    cert.cert_type = "CE";
    cert.cert_no = "CE-001";
    cert.valid_until = "2027-01-01";
    expect(draftReady("O1", cert, o1Required)).toBe(false);
    cert.issuer = "TÜV";
    expect(draftReady("O1", cert, o1Required)).toBe(true);
  });

  it("提交时去掉本地标记、类别与空值", () => {
    const row = makeDraftRow("M1");
    row.model = "CT21B";
    row.name = "  ";
    row.source = "手册.pdf:1";
    expect(draftPayload(row)).toEqual({ status: "待确认", model: "CT21B", source: "手册.pdf:1" });
  });

  it("草稿能认出来，普通行不会被误判", () => {
    expect(isDraftRow(makeDraftRow("M1"))).toBe(true);
    expect(isDraftRow({ id: "real-1", name: "x" })).toBe(false);
  });
});
