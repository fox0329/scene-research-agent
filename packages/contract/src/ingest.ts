/**
 * 资料上传口径（contract v1.x）
 *
 * 为什么这个数字要放在契约里：服务端 multipart 上限与前端上传前的预检**必须是同一个数**，
 * 否则会出现"前端放行、服务端 413"这种只有用户才会发现的错位（变更表 #155 的真实现象：
 * 165 MB 的 PPT 上传被 50 MB 上限挡掉，界面只回一句英文 `request file too large`）。
 */
export const FILE_UPLOAD_LIMIT_MB = 50;
