import { describe, it, expect } from "vitest";
import { matchContent, bigramCoverage, extractHardTokens, COVERAGE_MIN } from "./content-match.js";

// 真实原文片段（取自 推广/素材/demo资料 云枢智控-产品规格参数表.xlsx）
const XLSX = `
YS-EC3200	网络接口	2×千兆网口
YS-EC3200	软件能力	多协议设备接入；数据上云（MQTT / HTTPS）
YS-EC5200	AI 算力	NPU 6 TOPS
YS-EC5200	协议支持	Modbus RTU/TCP、OPC UA、IEC 60870-5-104、Profinet、EtherNet/IP
`;

describe("bigramCoverage", () => {
  it("几乎照抄 → 接近 1", () => {
    expect(bigramCoverage("NPU 6 TOPS", XLSX)).toBeGreaterThan(0.95);
  });

  it("完全编造 → 很低", () => {
    expect(bigramCoverage("本产品支持卫星直连并内置量子加密模块", XLSX)).toBeLessThan(0.35);
  });
});

describe("extractHardTokens", () => {
  it("抓带单位的数值", () => {
    expect(extractHardTokens("NPU 6 TOPS")).toContain("6 TOPS");
    expect(extractHardTokens("供电 24V")).toContain("24V");
  });

  it("抓量词（改数字要靠它）", () => {
    expect(extractHardTokens("4 个千兆网口")).toContain("4 个");
  });

  it("抓型号与英文技术词", () => {
    const t = extractHardTokens("YS-EC5200 支持 Modbus");
    expect(t).toContain("YS-EC5200");
    expect(t).toContain("MODBUS");
  });
});

describe("matchContent", () => {
  it("原文照抄 → supported 且接近一致", () => {
    const r = matchContent("YS-EC5200 NPU 6 TOPS", XLSX);
    expect(r.verdict).toBe("supported");
    expect(r.coverage).toBeGreaterThan(0.9);
  });

  it("归纳改写但要素齐 → 仍判 support（不能误杀）", () => {
    // 原文「数据上云（MQTT / HTTPS）」，业务行常写成这样
    const r = matchContent("支持 MQTT / HTTPS 数据上云", XLSX);
    expect(r.verdict).toBe("supported");
  });

  it("完全编造 → unsupported", () => {
    const r = matchContent("本产品支持卫星直连并内置量子加密模块", XLSX);
    expect(r.verdict).toBe("unsupported");
  });

  it("改数字 → unsupported，并点名缺哪个要素", () => {
    const r = matchContent("YS-EC5200 的 AI 算力为 NPU 60 TOPS", XLSX);
    expect(r.verdict).toBe("unsupported");
    expect(r.missingTokens.join()).toContain("60");
  });

  it("改数量（原文 2×千兆网口，写成 4 个）→ unsupported", () => {
    const r = matchContent("YS-EC3200 网络接口为 4 个千兆网口", XLSX);
    expect(r.verdict).toBe("unsupported");
    expect(r.missingTokens.join()).toContain("4");
  });

  it("空片段 → 视为可核（不指控）", () => {
    expect(matchContent("", XLSX).verdict).toBe("supported");
  });

  it("原文为空 → unsupported 且说明无原文", () => {
    const r = matchContent("任意说法", "");
    expect(r.verdict).toBe("unsupported");
    expect(r.detail).toContain("无原文");
  });

  it("阈值可调（调高更严）", () => {
    const loose = matchContent("支持 MQTT / HTTPS 数据上云", XLSX, { minCoverage: 0.99 });
    expect(loose.verdict).toBe("unsupported");
  });

  it("默认阈值 0.5（实测真实 ≥0.68、编造 ≤0.29 的中间）", () => {
    expect(COVERAGE_MIN).toBe(0.5);
  });
});
