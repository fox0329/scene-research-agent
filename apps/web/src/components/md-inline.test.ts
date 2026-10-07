import { describe, expect, it } from "vitest";
import { splitBold } from "./md-inline";

describe("报告正文行内粗体", () => {
  it("把 `**结论**` 起句切成「粗体 + 正文」两段", () => {
    expect(splitBold("**原则一：不替代原系统。** 终端形态维持客户既有选择。")).toEqual([
      { text: "原则一：不替代原系统。", bold: true },
      { text: " 终端形态维持客户既有选择。", bold: false },
    ]);
  });

  it("一行里多处粗体都切出来", () => {
    expect(splitBold("**二类是「看不见」**——设备状态不可见。**痛度高。**")).toEqual([
      { text: "二类是「看不见」", bold: true },
      { text: "——设备状态不可见。", bold: false },
      { text: "痛度高。", bold: true },
    ]);
  });

  it("落单的 ** 不吞正文，原样当普通文字", () => {
    expect(splitBold("表 5-1 见 ** 附录")).toEqual([{ text: "表 5-1 见 ** 附录", bold: false }]);
  });

  it("空粗体 `****` 不算粗体", () => {
    expect(splitBold("前****后")).toEqual([{ text: "前****后", bold: false }]);
  });

  it("没有星号时原样返回", () => {
    expect(splitBold("纯文字一行。")).toEqual([{ text: "纯文字一行。", bold: false }]);
  });
});
