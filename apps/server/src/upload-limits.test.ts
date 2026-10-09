import { describe, expect, it } from "vitest";
import { describeUploadFailure } from "./upload-limits.js";

describe("上传失败成因翻译（变更表 #155）", () => {
  it("multipart 的 FST_REQ_FILE_TOO_LARGE → 点名上限，不猜文件大小", () => {
    const msg = describeUploadFailure(
      { code: "FST_REQ_FILE_TOO_LARGE", statusCode: 413 },
      50,
    );
    expect(msg).toContain("50 MB");
    expect(msg).toContain("压缩");
    // 服务端这时只读到被截断的流，真实体积未知——不许编一个数字出来
    expect(msg).not.toMatch(/\d+\s*MB\s*的文件/);
  });

  it("只认状态码 413 的同类错误", () => {
    expect(describeUploadFailure({ statusCode: 413 }, 50)).toContain("50 MB");
  });

  it("其他异常不拦：返回 null，交回原来的表单校验提示", () => {
    expect(describeUploadFailure(new Error("boom"), 50)).toBeNull();
    expect(describeUploadFailure({ code: "FST_INVALID_MULTIPART_CONTENT_TYPE" }, 50)).toBeNull();
    expect(describeUploadFailure(null, 50)).toBeNull();
  });
});
