#!/usr/bin/env node
/**
 * 在 release/ 下找到未压缩的打包产物可执行文件（各平台布局不同）。
 * smoke-packaged.mjs 与 verify-settings.mjs 共用。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const desktopDir = resolve(here, "..");
export const releaseDir = join(desktopDir, "release");

export function findPackagedApp() {
  if (!existsSync(releaseDir)) return null;
  const all = readdirSync(releaseDir).filter((n) => statSync(join(releaseDir, n)).isDirectory());
  /* 优先选与宿主架构匹配的那份：多次出包后 release/ 下会同时有 mac-arm64 与 mac(x64)，
     选错就会"拿另一个架构的包去冒烟"，结论不可信。 */
  const hostDir = process.arch === "arm64" ? "mac-arm64" : "mac";
  const dirs = [...all.filter((n) => n === hostDir), ...all.filter((n) => n !== hostDir)];
  for (const d of dirs) {
    if (process.platform === "darwin" && d.startsWith("mac")) {
      const appDir = readdirSync(join(releaseDir, d)).find((n) => n.endsWith(".app"));
      if (!appDir) continue;
      const bin = join(releaseDir, d, appDir, "Contents", "MacOS", appDir.replace(/\.app$/u, ""));
      if (existsSync(bin)) return bin;
    }
    if (process.platform === "win32" && d === "win-unpacked") {
      const exe = readdirSync(join(releaseDir, d)).find((n) => n.endsWith(".exe"));
      if (exe) return join(releaseDir, d, exe);
    }
  }
  return null;
}

/** 启动打包产物的子进程环境：必须剔除 ELECTRON_RUN_AS_NODE（否则 Electron 变成纯 Node） */
export function packagedEnv(extra = {}) {
  const env = { ...process.env, NODE_ENV: "production", ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
