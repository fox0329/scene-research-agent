import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InlineText } from "./InlineText";

describe("InlineText — 对话/对照表粗体", () => {
  it("把 **商用后厨** 渲染成 strong，而不是原样星号", () => {
    const html = renderToStaticMarkup(React.createElement(InlineText, { text: "重点在**商用后厨**，前厅次之。" }));
    expect(html).toBe("重点在<strong>商用后厨</strong>，前厅次之。");
  });

  it("落单的 ** 原样保留", () => {
    expect(renderToStaticMarkup(React.createElement(InlineText, { text: "见 ** 附录" }))).toBe(
      "见 ** 附录",
    );
  });
});
