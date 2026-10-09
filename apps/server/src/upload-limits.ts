/**
 * 上传失败的成因翻译（变更表 #155）
 *
 * `@fastify/multipart` 在超过 `limits.fileSize` 时抛出 `FST_REQ_FILE_TOO_LARGE`（英文
 * `request file too large`）。原来这个异常被当成"表单不合法"兜住，用户看到的是
 * 「需要 multipart 表单」——问题明明出在文件太大，提示却指向表单格式，排查方向被带偏。
 * 这里把它翻成人话，并且**只说上限、不猜文件大小**（multipart 到这一步已经把流截断了，
 * 服务端拿不到真实体积；精确体积由前端上传前预检给出）。
 */
export function describeUploadFailure(err: unknown, limitMb: number): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  if (code === "FST_REQ_FILE_TOO_LARGE" || status === 413) {
    return `文件超过上传上限 ${limitMb} MB：请先压缩或按章节拆分后再上传`;
  }
  return null;
}
