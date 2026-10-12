#!/usr/bin/env node
/**
 * @scene/desktop — 对**打包产物**跑冒烟
 *
 * 先用 `electron-builder --dir` 出未压缩的应用目录，再启动它本体做一遍冒烟。
 * 为什么单独这一步：有些问题只有打包后才暴露——真实踩过 electron-builder 把运行时的
 * node_modules 裁掉，开发态怎么跑都正常，装出来的应用一启动就报 Cannot find package '@scene/infra'。
 *
 * 用法：node apps/desktop/scripts/smoke-packaged.mjs
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPackagedApp, releaseDir } from "./find-packaged-app.mjs";

const here = dirname(fileURLToPath(import.meta.url));

if (!existsSync(releaseDir)) {
  console.error("没有 release 目录，先跑：pnpm --filter @scene/desktop run pack:dir");
  process.exit(1);
}

const bin = findPackagedApp();
if (!bin) {
  console.error(`在 ${releaseDir} 里没找到打包后的可执行文件`);
  process.exit(1);
}

console.log(`对打包产物跑冒烟：${bin}\n`);
execFileSync(process.execPath, [join(here, "smoke.mjs")], {
  stdio: "inherit",
  env: { ...process.env, SCENE_SMOKE_APP: bin },
});
