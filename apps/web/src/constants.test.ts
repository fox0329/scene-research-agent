import { describe, expect, it } from "vitest";
import {
  LARGE_FILE_HINT_MB,
  describeLargeFiles,
  describeOversize,
  describeSkipped,
  pickSupportedFiles,
  splitOversizeFiles,
} from "./constants.js";

/** 造一个指定 MB 的假 File（不真分配内存，只给 size） */
function fakeFile(name: string, mb: number): File {
  return { name, size: Math.round(mb * 1024 * 1024) } as File;
}

describe("上传前体积预检（变更表 #155）", () => {
  it("超过上限的挑出来，其余照常上传", () => {
    const { ok, oversize } = splitOversizeFiles(
      [fakeFile("小.pptx", 1), fakeFile("副本狄耐克鸿蒙智慧医院建设方案.pptx", 165), fakeFile("中.pdf", 49)],
      50,
    );
    expect(ok.map((f) => f.name)).toEqual(["小.pptx", "中.pdf"]);
    expect(oversize).toHaveLength(1);
    expect(oversize[0]!.name).toBe("副本狄耐克鸿蒙智慧医院建设方案.pptx");
    expect(oversize[0]!.mb).toBeCloseTo(165, 0);
  });

  it("正好等于上限不算超（边界与 multipart 一致：超过才拦）", () => {
    const { ok, oversize } = splitOversizeFiles([fakeFile("刚好.pptx", 50)], 50);
    expect(ok).toHaveLength(1);
    expect(oversize).toHaveLength(0);
  });

  it("文案要说清：几个、各自多大、上限多少、怎么办", () => {
    const msg = describeOversize([{ name: "副本狄耐克鸿蒙智慧医院建设方案.pptx", mb: 165.3 }], 50);
    expect(msg).toContain("1 个");
    expect(msg).toContain("165.3 MB");
    expect(msg).toContain("超过 50 MB 上限");
    expect(msg).toContain("压缩");
    expect(msg).toContain("拆分");
  });

  it("超过 3 个只列前 3 个并给总数", () => {
    const msg = describeOversize(
      [1, 2, 3, 4, 5].map((i) => ({ name: `大${i}.pptx`, mb: 100 + i })),
      50,
    );
    expect(msg).toContain("已跳过 5 个");
    expect(msg).toContain("大1.pptx");
    expect(msg).not.toContain("大4.pptx");
    expect(msg).toContain("等 5 个");
  });

  it("没有超限文件时不产生提示（不打扰正常上传）", () => {
    expect(describeOversize([], 50)).toBe("");
  });

  it("与既有的类型跳过清单互不影响", () => {
    const { files, skippedNames } = pickSupportedFiles([
      fakeFile("图纸.dwg", 1),
      fakeFile("大.pptx", 165),
    ] as unknown as File[]);
    expect(skippedNames).toEqual(["图纸.dwg"]);
    const { ok, oversize } = splitOversizeFiles(files, 50);
    expect(ok).toHaveLength(0);
    expect(oversize).toHaveLength(1);
    expect(describeSkipped(skippedNames)).toContain("不支持的文件");
  });
});

describe("大文件提示（变更表 #156：上限提到 300 MB 后的预期管理）", () => {
  it("大文件提示线是 200 MB，正好到线也给提示（不让用户以为卡死）", () => {
    expect(LARGE_FILE_HINT_MB).toBe(200);
    const msg = describeLargeFiles([fakeFile("副本狄耐克鸿蒙智慧医院建设方案.pptx", 165), fakeFile("大.pptx", 200)]);
    expect(msg).toContain("解析可能需要几分钟");
    expect(msg).toContain("大.pptx");
    expect(msg).not.toContain("副本狄耐克");
  });

  it("没有大文件时不给提示（不打扰正常上传）", () => {
    expect(describeLargeFiles([fakeFile("小.pptx", 1)])).toBe("");
    expect(describeLargeFiles([])).toBe("");
  });

  it("超过 3 个大文件只列前 3 个并给总数", () => {
    const msg = describeLargeFiles([1, 2, 3, 4].map((i) => fakeFile(`大${i}.pptx`, 200 + i)));
    expect(msg).toContain("大1.pptx");
    expect(msg).not.toContain("大4.pptx");
    expect(msg).toContain("等 4 个");
  });
});
