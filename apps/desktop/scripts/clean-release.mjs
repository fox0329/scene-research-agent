#!/usr/bin/env node
/**
 * @scene/desktop — 出包前清掉上一次的产物目录
 *
 * 为什么必须清：`electron-builder --dir` 往已存在的输出目录里写时，**不会清掉**
 * `app.asar.unpacked/` 下的旧文件。而 Electron 解析被 unpack 的路径时优先用 unpacked 副本，
 * 于是"新壳 + 旧运行时"这种组合会**静默**成立——表现是代码明明改了、装出来的应用行为还是老的
 * （2026-10-12 真实踩过：密钥加密已经写进 runtime，打包产物里还是旧 provider-store.js）。
 *
 * 用法：node scripts/clean-release.mjs mac-arm64 mac   （参数是 release/ 下的目标目录名）
 */

import { existsSync, rmSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const releaseDir = resolve(here, "..", "release");

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("用法：node scripts/clean-release.mjs <release 下的目录名>...");
  process.exit(1);
}

for (const name of targets) {
  /* 破坏性操作围栏：只允许删 release/ 下的一级目录，且名字里不许出现路径分隔符 */
  const target = resolve(releaseDir, name);
  if (name.includes("/") || name.includes("\\") || name === "" || target === releaseDir) {
    console.error(`拒绝删除可疑目标：${name}`);
    process.exit(1);
  }
  if (!target.startsWith(releaseDir + sep)) {
    console.error(`拒绝删除 release 之外的路径：${target}`);
    process.exit(1);
  }
  if (!existsSync(target)) continue;
  rmSync(target, { recursive: true, force: true });
  console.log(`  清理旧产物：release/${name}`);
}
