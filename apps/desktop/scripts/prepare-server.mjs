#!/usr/bin/env node
/**
 * @scene/desktop — 装配桌面版运行时
 *
 * 产出两份东西到 `apps/desktop/runtime/`：
 *   server/  ← 服务端的**独立可分发副本**（自包含 node_modules，零符号链接）
 *   web/     ← 前端构建产物
 *
 * 三条硬约束（每一条都是踩过坑换来的）：
 *
 * 1. **必须自包含、不能留指向仓库 store 的符号链接。**
 *    默认的 pnpm 布局里 `node_modules/<pkg>` 是指向 `.pnpm/...` 的链接，
 *    直接在它上面重建原生模块会顺链改到**仓库根目录那份**——那份是给系统 Node 用的，
 *    一改，本机开发服务与 vitest 立刻 ABI 不匹配（2026-10-12 真实发生过一次）。
 *    所以这里用 `deploy --node-linker=hoisted` 让它直接产出扁平真实目录（npm 风格），
 *    不用 cpSync 去反解链接——实测 `cpSync(dereference: true)` 对**目录**符号链接不生效。
 *
 * 2. **原生模块用预编译，不编译。**
 *    桌面版里服务端跑在 Electron 的 Node 里，`better-sqlite3` 必须是 Electron ABI 的二进制；
 *    用 `prebuild-install --runtime=electron` 直接下预编译包，既不需要 Xcode / VS 工具链，
 *    CI 也快得多也稳得多。当前组合：better-sqlite3 v11.10.0 提供 Electron ABI 135 的
 *    darwin-arm64 / darwin-x64 / win32-x64 预编译，对应 Electron 36.x（见 package.json）。
 *    升级 better-sqlite3 或 Electron 时先确认这对组合有预编译：
 *    https://github.com/WiseLibs/better-sqlite3/releases
 *
 * 3. **分发包不能带开发数据。** 剪掉 `data/`（里面有开发机的真实数据库）、`src/`、test、d.ts。
 *
 * 收尾还有一道**自检**：验证仓库里给 Node 用的那份 better-sqlite3 仍然可用。
 * 它坏了就等于把开发环境搞坏了——这类问题必须在装配时就炸出来，而不是等用户发现。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const repo = resolve(desktopDir, "../..");
const runtimeDir = join(desktopDir, "runtime");
const serverOut = join(runtimeDir, "server");
const webOut = join(runtimeDir, "web");

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}


/**
 * 破坏性操作围栏。
 *
 * 为什么必须有：这个脚本会 `rm -rf` 目录树，而 2026-10-12 真的发生过一次意外——
 * `apps/server/src`（60 个文件）和 `tsconfig.json` 被删掉了（已从 git 全部恢复）。
 * 定位过程也说明问题：一旦某个路径算错，损失就是"删源码"。
 * 所以这里给所有删除动作加白名单：只允许动 `apps/desktop/runtime` 与系统临时目录，
 * 越界直接失败并打印实际路径——宁可装配不出来，也不许误删。
 */
const tmpRoot = (() => {
  try {
    return realpathSync(tmpdir());
  } catch {
    return tmpdir();
  }
})();

function assertInside(target, what) {
  const abs = resolve(target);
  const roots = [runtimeDir, tmpRoot];
  const ok = roots.some((r) => abs === r || abs.startsWith(r + sep));
  if (!ok) {
    fail(`拒绝执行「${what}」：目标越界 → ${abs}\n  只允许动：${roots.join(" ｜ ")}`);
  }
  return abs;
}

function safeRm(target, what = "删除目录") {
  rmSync(assertInside(target, what), { recursive: true, force: true });
}

function requireArtifacts() {
  const needed = [
    ["apps/server/dist/index.js", "服务端构建产物"],
    ["apps/web/dist/index.html", "前端构建产物"],
    ["packages/infra/dist/sql/001_init.sql", "SQL 迁移文件（copy-infra-sql 负责拷贝）"],
  ];
  const missing = needed.filter(([p]) => !existsSync(join(repo, p)));
  if (missing.length) {
    console.error("缺少构建产物，请先跑 `pnpm build`：");
    for (const [p, label] of missing) console.error(`  - ${label}：${p}`);
    process.exit(1);
  }
}

/** 按目录名整棵剪除（src/data/.git/docs/test） */
function pruneDirs(dir, depth = 0) {
  if (depth > 8) return;
  for (const name of readdirSync(dir)) {
    if (["src", "data", ".git", "docs", "test", "tests"].includes(name)) {
      safeRm(join(dir, name), `剪除 ${name}`);
      continue;
    }
    const full = join(dir, name);
    if (existsSync(full) && lstatSync(full).isDirectory()) pruneDirs(full, depth + 1);
  }
}

/** 按文件名散剪（tsconfig / d.ts / map / test 文件），并对残留链接兜底实体化 */
function prune(dir, depth = 0) {
  if (depth > 8) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = lstatSync(full); // 关键：不跟随链接
    if (st.isSymbolicLink()) {
      if (existsSync(full)) {
        /* hoisted 布局下不该再有"能解析的链接"；出现了就说明 pnpm 布局变了，
           必须显式处理（删掉可能悄悄弄坏运行时，留着则分发到别人机器上会断） */
        fail(`运行时里出现了意料之外的符号链接：\n  ${full}\n  说明 pnpm 的产物布局变了，装配脚本需要相应调整。`);
      }
      assertInside(full, "删除悬空链接");
      rmSync(full, { force: true }); // 悬空链接（如仅开发用的 @types/node）直接去掉
      continue;
    }
    if (st.isDirectory()) {
      /* .bin 里全是命令shim（符号链接），运行时直接 node dist/index.js，用不到 */
      if (name === ".bin") {
        safeRm(full, "剪除 .bin");
        continue;
      }
      prune(full, depth + 1);
      continue;
    }
    const killer =
      name === "tsconfig.json" ||
      name === "tsconfig.tsbuildinfo" ||
      name.endsWith(".d.ts") ||
      name.endsWith(".d.ts.map") ||
      name.endsWith(".js.map") ||
      /\.test\.(js|d\.ts)$/u.test(name);
    if (killer) {
      assertInside(full, "剪除文件");
      rmSync(full, { force: true });
    }
  }
}

/** 运行时必须自包含：扫一遍确认没有残留符号链接 */
function assertNoSymlinks(dir) {
  const found = [];
  const walk = (d, depth = 0) => {
    if (depth > 8 || found.length > 5) return;
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (lstatSync(full).isSymbolicLink()) {
        found.push(full.slice(dir.length + 1));
        continue;
      }
      if (lstatSync(full).isDirectory()) walk(full, depth + 1);
    }
  };
  walk(dir);
  if (found.length) {
    fail(`运行时里还有符号链接（分发到别人机器上会指向不存在的东西）：\n  ${found.join("\n  ")}`);
  }
}

function dirSizeMb(dir) {
  let total = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) total += st.size;
    }
  };
  walk(dir);
  return (total / 1024 / 1024).toFixed(1);
}

/** 原生模块自检：确认仓库里给 Node 用的那份 better-sqlite3 还能真的建库（ABI 对不对） */
function assertNodeNativeStillWorks() {
  const probe = "const D=require('better-sqlite3');const d=new D(':memory:');d.exec('create table t(x)');console.log('ok')";
  try {
    const out = execFileSync(process.execPath, ["-e", probe], {
      cwd: join(repo, "packages/infra"),
      encoding: "utf8",
    });
    if (!out.includes("ok")) fail("仓库里给 Node 用的 better-sqlite3 自检异常（输出不含 ok）");
  } catch (err) {
    fail(
      "仓库里给 Node 用的 better-sqlite3 已不可用（很可能被按 Electron ABI 覆盖了）：\n" +
        `  ${err instanceof Error ? err.message.split("\n")[0] : String(err)}\n` +
        "  修复（用预编译包，不需要编译器）：\n" +
        "    cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && \\\n" +
        "      node ../../../prebuild-install@*/node_modules/prebuild-install/bin.js \\\n" +
        "        --runtime=node --target=$(node -p process.versions.node)",
    );
  }
}

requireArtifacts();

console.log("── 1/4 装配服务端运行时（deploy --node-linker=hoisted）──");
console.log(`    目标：${serverOut}`);
mkdirSync(runtimeDir, { recursive: true });
/* 先 deploy 到工作区外的临时目录，再整体拷进来。
   为什么不在原地 deploy：pnpm deploy 对"工作区内的目标路径"解析会受 cwd 影响，
   曾把产物歪写到 apps/server/apps/desktop/...（真实发生过），先用临时目录隔离掉这类风险。 */
const deployTmp = mkdtempSync(join(tmpRoot, "scene-deploy-"));
try {
  execFileSync(
    "pnpm",
    ["--filter", "@scene/server", "deploy", "--prod", "--node-linker=hoisted", deployTmp],
    { cwd: repo, stdio: ["ignore", "ignore", "inherit"] },
  );
  safeRm(serverOut, "清理旧运行时");
  cpSync(deployTmp, serverOut, { recursive: true });
} finally {
  safeRm(deployTmp, "清理 deploy 临时目录");
}

console.log("── 2/4 剪除 src/data/test/d.ts 与 .bin ────────────");
/* node_modules/.bin 里只有符号链接，运行时用不到（我们直接 node dist/index.js） */
safeRm(join(serverOut, "node_modules", ".bin"), "剪除 .bin");
pruneDirs(serverOut);
prune(serverOut);
assertNoSymlinks(serverOut);

console.log("── 3/4 复制前端产物 ───────────────────────────────");
safeRm(webOut, "清理旧前端产物");
cpSync(join(repo, "apps/web/dist"), webOut, { recursive: true });

console.log("── 4/4 原生模块换 Electron ABI 预编译 ─────────────");
const electronPkg = join(desktopDir, "node_modules", "electron", "package.json");
if (!existsSync(electronPkg)) fail("找不到 electron 包（先跑 `pnpm install`）");
const electronVersion = JSON.parse(readFileSync(electronPkg, "utf8")).version;

const sqliteDir = join(serverOut, "node_modules", "better-sqlite3");
if (!existsSync(sqliteDir)) fail(`运行时里没有 better-sqlite3：${sqliteDir}`);
const prebuildBin = [
  join(sqliteDir, "node_modules", "prebuild-install", "bin.js"),
  join(serverOut, "node_modules", "prebuild-install", "bin.js"),
].find((p) => existsSync(p));
if (!prebuildBin) fail("运行时里找不到 prebuild-install（better-sqlite3 的生产依赖里应该有）");

/* 架构必须与打包目标一致：原生模块是架构相关的，arm64 的包塞进 x64 应用里，用户一跑就崩。
   默认取宿主架构；交叉打包时用 `--arch=x64` 显式指定（打包脚本会传）。 */
const archArg = process.argv.find((a) => a.startsWith("--arch="));
const arch = (archArg ? archArg.slice("--arch=".length) : process.arch) === "arm64" ? "arm64" : "x64";
try {
  execFileSync(
    process.execPath,
    [prebuildBin, "--runtime=electron", `--target=${electronVersion}`, `--arch=${arch}`],
    { cwd: sqliteDir, stdio: ["ignore", "ignore", "inherit"] },
  );
} catch {
  fail(
    `better-sqlite3 没有 Electron ${electronVersion} / ${process.platform}-${arch} 的预编译。\n` +
      "  两条出路：① 换一个该 ABI 有预编译的 Electron 版本；② 装好编译工具链（mac: Xcode CLT；win: VS Build Tools）后自行编译。",
  );
}
const binding = join(sqliteDir, "build", "Release", "better_sqlite3.node");
if (!existsSync(binding)) fail(`预编译没有落到预期位置：${binding}`);
let bindingDesc = `${process.platform}-${arch}`;
try {
  bindingDesc = execFileSync("file", [binding], { encoding: "utf8" }).split(":").slice(1).join(":").trim();
} catch {
  /* Windows 上没有 file 命令，用平台兜底 */
}

console.log("── 自检：仓库里给 Node 用的那份没被动过 ────────────");
assertNodeNativeStillWorks();

console.log(`\n运行时就绪 → ${serverOut}`);
console.log(`  server/ ${dirSizeMb(serverOut)} MB（Electron ${electronVersion} / ${arch}）`);
console.log(`  web/    ${dirSizeMb(webOut)} MB`);
console.log(`  原生模块：${bindingDesc}`);
