#!/usr/bin/env node
/**
 * @scene/desktop — 桌面壳冒烟（本地与 CI 共用）
 *
 * 验的是"装出来的应用真的能用"，不是"代码能编译"：
 *   1) 窗口起来了、标题对；
 *   2) 页面来自本地服务（不是 file://），端口是运行时现选的，不是写死的 46172；
 *   3) 本地服务健康检查通过；
 *   4) 前端壳真的渲染出来（空数据目录 → 应有「还没有项目」空态）；
 *   5) **数据库文件真的被创建**——这是 better-sqlite3 按 Electron ABI 加载成功的铁证，
 *      原生模块 ABI 不匹配时，这一步必定失败（而不是等到用户点某个按钮才炸）；
 *   6) 控制台无报错（含 React 的更新死循环警告，故障 #52 的回归哨兵）。
 *
 * 用独立 userData 目录：冒烟不碰用户真实数据，也就不会污染本机场景库。
 *
 * 用法：node apps/desktop/scripts/smoke.mjs
 */

import { _electron as electronLauncher } from "@playwright/test";
import electronBinary from "electron"; // 这个包的默认导出就是 Electron 可执行文件路径
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const runtimeServer = join(desktopDir, "runtime/server/dist/index.js");
const shell = join(desktopDir, "dist/main.cjs");

/* 两种模式：
   ① 默认——跑 apps/desktop 这份构建（开发/CI 快速回归）；
   ② SCENE_SMOKE_APP=<打包后可执行文件路径>——跑**真正要发给用户的安装产物**。
   为什么要有第二种：有些问题只有打包之后才暴露（真实踩过：electron-builder 把运行时的
   node_modules 裁掉，开发态一切正常，装出来的应用一跑就报 Cannot find package '@scene/infra'）。 */
const packagedApp = process.env.SCENE_SMOKE_APP;

if (packagedApp) {
  if (!existsSync(packagedApp)) {
    console.error(`指定的打包产物不存在：${packagedApp}`);
    process.exit(1);
  }
} else {
  for (const [p, label] of [
    [shell, "壳代码（先跑 pnpm --filter @scene/desktop run build:shell）"],
    [runtimeServer, "服务端运行时（先跑 npm run desktop:runtime）"],
  ]) {
    if (!existsSync(p)) {
      console.error(`缺少${label}：${p}`);
      process.exit(1);
    }
  }
}

const userData = mkdtempSync(join(tmpdir(), "scene-desktop-smoke-"));
const failures = [];
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures.push(label);
};

/* 必须显式给 executablePath：Playwright 自己去找 electron 时是从它的位置解析，
   解析不到我们这份 apps/desktop/node_modules 里的 Electron（会报"Process failed to launch"）。 */
/* 必须剔除 ELECTRON_RUN_AS_NODE：它会让 Electron 以纯 Node 方式跑主进程，
   require("electron") 变成路径字符串，应用一启动就崩（本机环境里真有这个变量）。 */
const childEnv = { ...process.env, NODE_ENV: "production" };
delete childEnv.ELECTRON_RUN_AS_NODE;

/* 打包产物：可执行文件直接给 Playwright；开发态：给 Electron 二进制 + 应用目录参数 */
const app = packagedApp
  ? await electronLauncher.launch({
      executablePath: packagedApp,
      args: [`--user-data-dir=${userData}`],
      env: childEnv,
    })
  : await electronLauncher.launch({
      executablePath: typeof electronBinary === "string" ? electronBinary : undefined,
      args: [desktopDir, `--user-data-dir=${userData}`],
      env: childEnv,
    });

try {
  const win = await app.firstWindow({ timeout: 90_000 });
  const consoleErrors = [];
  win.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  win.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await win.waitForLoadState("domcontentloaded");
  /* 服务端启动 + 健康检查通过后，窗口才会从启动页切到应用页面 */
  await win.locator(".empty-state-title, .app, .flow-rail").first().waitFor({ timeout: 90_000 });
  await win.waitForTimeout(2000);

  const url = win.url();
  const port = Number(new URL(url).port);
  const health = await win.evaluate(async (p) => {
    const r = await fetch(`http://127.0.0.1:${p}/api/v1/health`);
    return { status: r.status, body: await r.json() };
  }, port);

  const dbPath = join(userData, "data", "scene.db");
  const logPath = join(userData, "logs", "server.log");
  const emptyTitle = await win.locator(".empty-state-title").first().textContent().catch(() => null);

  ok("窗口标题是应用名", (await win.title()).includes("场景通"), await win.title());
  ok("页面来自本地服务（不是 file://）", url.startsWith("http://127.0.0.1:"), url);
  ok("端口运行时现选（非 46172）", port > 0 && port !== 46172, `port=${port}`);
  ok("本地服务健康检查通过", health.status === 200 && health.body.status === "ok", JSON.stringify(health.body));
  ok("前端壳渲染出来（空态）", (emptyTitle ?? "").includes("还没有项目"), `「${(emptyTitle ?? "").trim()}」`);
  ok("数据库真的建出来了（Electron ABI 铁证）", existsSync(dbPath), dbPath.replace(userData, "<userData>"));
  ok("服务日志落盘（便于用户反馈问题）", existsSync(logPath), readdirSync(join(userData, "logs")).join(","));
  ok("控制台无报错（含 React 死循环警告）", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" / "));

  await win.screenshot({ path: join(desktopDir, "release/smoke.png") }).catch(() => {});
} finally {
  await app.close().catch(() => {});
  rmSync(userData, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n桌面壳冒烟失败 ${failures.length} 项：${failures.join("、")}`);
  process.exit(1);
}
console.log("\n桌面壳冒烟通过 ✅");
