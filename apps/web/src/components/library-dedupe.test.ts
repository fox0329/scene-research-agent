import { describe, it, expect } from "vitest";
import { dedupePreviewText } from "./library-dedupe";

describe("dedupePreviewText", () => {
  it("有重复组时报组数并指到能力清单", () => {
    const text = dedupePreviewText({
      merged: [
        {
          key: "l1|工业|设备监测",
          keptId: "a",
          removedIds: ["b"],
          keptDescription: "长描述",
          removedDescriptions: ["短"],
        },
      ],
    });
    expect(text).toContain("1 组");
    expect(text).toContain("能力清单");
  });

  it("没有重复组时说明没有重复", () => {
    expect(dedupePreviewText({ merged: [] })).toContain("没有");
    expect(dedupePreviewText(undefined)).toContain("没有");
  });
});
