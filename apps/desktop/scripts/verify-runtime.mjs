#!/usr/bin/env node
/**
 * @scene/desktop — 校验打包产物里的运行时与源运行时**逐字节一致**
 *
 * 为什么需要：`electron-builder --dir` 会复用已存在的输出目录、不清 `app.asar.unpacked/`，
 * 于是可能出现"新壳 + 旧运行时"——代码改了、包出来的应用行为还是老的，而且**不报错**
 * （2026-10-12 真实踩过，查了半天）。这道校验把"包里的运行时就是刚装配的那份"变成可断言的事实。
 *
 * 用法：node scripts/verify-runtime.mjs [打包产物可执行文件路径]
 *       （不传就在 release/ 下按宿主架构找，与 smoke-packaged.mjs 同一套定位逻辑）
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { desktopDir, findPackagedApp } from "./find-packaged-app.mjs";

/** 运行时真正需要的文件类型（其余如 .github/、.gitattributes 会被打包器按默认规则丢掉，不参与比对） */
const CRITICAL = /\.(js|mjs|cjs|json|node|sql|wasm|html|css)$/u;

/**
 * 列出目录下所有"关键文件"的相对路径 → 内容哈希。
 * 排除 node_modules 下各依赖自带的 package.json：打包器会按自己的口径重写这些文件（实测 319 个都被重写），
 * 内容天然不同，拿来比会一直误报；而真正要防的"运行时过期"体现在自家代码与原生模块上，
 * 它们照旧逐字节比（换架构/换版本一律露馅）。
 */
function isRewrittenByPackager(rel) {
  return (rel.startsWith("node_modules/") || rel.includes("/node_modules/")) && rel.endsWith("package.json");
}

function fingerprint(dir) {
  const out = new Map();
  const walk = (d, prefix) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else if (CRITICAL.test(rel) && !isRewrittenByPackager(rel)) {
        out.set(rel, createHash("sha256").update(readFileSync(full)).digest("hex"));
      }
    }
  };
  walk(dir, "");
  return out;
}

/** 比对：包内不能缺关键文件；两边都有的必须逐字节一致 */
function compare(name, srcDir, packedDir) {
  const src = fingerprint(srcDir);
  const packed = fingerprint(packedDir);
  const missing = [...src.keys()].filter((k) => !packed.has(k));
  const differing = [...src.keys()].filter((k) => packed.has(k) && packed.get(k) !== src.get(k));
  const same = missing.length === 0 && differing.length === 0;
  const detail = same
    ? `${src.size} 个关键文件一致`
    : `缺 ${missing.length} 个、内容不同 ${differing.length} 个（如 ${(missing[0] ?? differing[0] ?? "").slice(-60)}）`;
  console.log(`  ${same ? "✓" : "✗"} ${name}/ 与打包产物一致 — ${detail}`);
  return same;
}

const bin = process.argv[2] ?? findPackagedApp();
if (!bin || !existsSync(bin)) {
  console.error("没找到打包产物，先跑：pnpm --filter @scene/desktop run pack:dir");
  process.exit(1);
}

/** 从可执行文件路径推回 Resources/app.asar.unpacked */
function unpackedDir(binPath) {
  // macOS：<X>.app/Contents/MacOS/<X> → <X>.app/Contents/Resources/app.asar.unpacked
  const appIdx = binPath.indexOf(`.app${sep}`);
  if (appIdx >= 0) {
    return join(binPath.slice(0, appIdx + 4), "Contents", "Resources", "app.asar.unpacked");
  }
  // Windows：<dir>/win-unpacked/场景通.exe → <dir>/win-unpacked/resources/app.asar.unpacked
  return join(dirname(binPath), "resources", "app.asar.unpacked");
}

const packed = join(unpackedDir(bin), "runtime");
if (!existsSync(packed)) {
  console.error(`打包产物里没有运行时目录：${packed}`);
  process.exit(1);
}

let failed = false;
for (const part of ["server", "web"]) {
  const src = join(desktopDir, "runtime", part);
  if (!existsSync(src)) {
    console.error(`✗ 源运行时不完整（缺 ${part}），先跑 npm run desktop:runtime`);
    failed = true;
    continue;
  }
  if (!compare(part, src, join(packed, part))) failed = true;
}

if (failed) {
  console.error(
    "\n打包产物里的运行时不是最新装配的那份。\n" +
      "多半是输出目录没清干净（electron-builder 不会清 app.asar.unpacked/）。\n" +
      "重出一次：pnpm --filter @scene/desktop run pack:dir",
  );
  process.exit(1);
}
console.log("\n运行时一致性校验通过 ✅");
