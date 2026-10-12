#!/usr/bin/env node
/**
 * @scene/desktop — 打包壳代码（主进程 + preload）
 *
 * 为什么用 esbuild 而不是 tsc：主进程/preload 是**消费端**，不进 tsc project references
 * 的增量图；esbuild 一次产出 CJS 两个文件，且不生成 .d.ts 污染源码目录
 * （仓库有条硬规矩：`find packages apps -path '*​/src/*' -name '*.js'` 必须为 0）。
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(here, "../src/main.ts"), resolve(here, "../src/preload.ts")],
  outdir: resolve(here, "../dist"),
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  sourcemap: false,
  logLevel: "info",
});

console.log("壳代码已构建 → apps/desktop/dist/{main,preload}.cjs");
