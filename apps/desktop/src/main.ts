/**
 * @scene/desktop — Electron 主进程（桌面壳）
 *
 * 设计要点（为什么这么做，而不是"直接把浏览器包一层"）：
 *
 * 1. **服务端跑在 Electron 自带的 Node 里**：`ELECTRON_RUN_AS_NODE=1` + `process.execPath`，
 *    于是安装包里不需要额外背一个 Node 运行时（省 ~50MB，也不用管用户机器有没有 Node）。
 *    代价：`better-sqlite3` 必须按 **Electron 的 ABI** 重建——所以运行时是 `runtime/server`
 *    这份隔离副本（`scripts/prepare-server.mjs` 生产），**不动仓库里给 Node 用的那份**，
 *    否则本机 46172 的开发服务和 vitest 会一起坏掉。
 *
 * 2. **端口运行时现选**：开发期固定 46172 是为了并行开发，装到用户机器上就可能撞端口。
 *    这里先让系统分配一个空闲端口（bind 0 → 取号 → 释放），再交给服务端；
 *    同时强制 `APP_HOST=127.0.0.1`——服务端默认 `0.0.0.0`，那会把无鉴权的 API 暴露到局域网。
 *
 * 3. **数据落系统应用目录**：数据库/交付物/导出都在 `app.getPath("userData")` 下，
 *    不写安装目录（macOS 装到 /Applications 后安装目录不可写），也不写用户当前工作目录。
 *
 * 4. **窗口不是浏览器**：站外链接（右栏「看原文」的 URL）交给系统浏览器打开，
 *    站内导航锁死在本机 origin；启动期间先显示启动页，健康检查通过再切到应用。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { join, resolve } from "node:path";
/* 这里刻意用 require 而不是 import：esbuild 打成 CJS 时会把 `import` 的 electron
   套上 __toESM 互操作包装，而 Electron 的模块对象是 getter 式暴露、没有可枚举自有属性，
   包装后 `app`/`BrowserWindow` 全成了 undefined，主进程一启动就崩（真实踩过）。
   require 原样保留，拿到的就是 Electron 真身。 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electron = require("electron") as typeof import("electron");

const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = electron;

/* 防呆：环境里若带着 ELECTRON_RUN_AS_NODE=1，Electron 会以"纯 Node"方式跑本文件，
   require("electron") 只返回一个路径字符串，app 等全是 undefined。
   这种失败方式极难从 TypeError 反推原因（本机就踩过一次），所以直接给一条能照着做的提示。 */
if (typeof electron !== "object" || !electron.app) {
  console.error(
    "启动失败：当前环境带着 ELECTRON_RUN_AS_NODE，Electron 被当成纯 Node 运行了。\n" +
      "请清除该变量后重试，例如：env -u ELECTRON_RUN_AS_NODE <应用可执行文件>",
  );
  process.exit(1);
}

const APP_TITLE = "场景通";
/** 服务端启动上限：超过就认为起不来，给用户一条能照着做的错误信息 */
const SERVER_BOOT_TIMEOUT_MS = 40_000;

interface Runtime {
  serverEntry: string;
  webDist: string;
}

interface Paths {
  root: string;
  db: string;
  deliverables: string;
  exports: string;
  logs: string;
}

let serverProc: ChildProcess | null = null;
let serverLog: WriteStream | null = null;
let win: Electron.BrowserWindow | null = null;
let appPort = 0;
let paths: Paths | null = null;
let bootError: string | null = null;

const isDev = !app.isPackaged;

/** 取一个空闲端口：让系统分配，拿到号立刻释放（随后服务端绑定它） */
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", rej);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      probe.close(() => (port ? res(port) : rej(new Error("拿不到空闲端口"))));
    });
  });
}

/** 运行时位置：打包后在 Resources/ 下；开发时用仓库里的构建产物 */
function runtimePaths(): Runtime {
  const resDir = process.resourcesPath;
  return {
    /* 开发态：__dirname 是 apps/desktop/dist，运行时在 apps/desktop/runtime（上一层）
       打包态：运行时随 asarUnpack 落到 Resources/app.asar.unpacked/runtime 下（真实文件，可被执行） */
    serverEntry: isDev
      ? resolve(__dirname, "../runtime/server/dist/index.js")
      : join(resDir, "app.asar.unpacked", "runtime", "server", "dist", "index.js"),
    webDist: isDev
      ? resolve(__dirname, "../runtime/web")
      : join(resDir, "app.asar.unpacked", "runtime", "web"),
  };
}

/** 用户数据目录（首次运行自动建） */
function preparePaths(): Paths {
  const root = app.getPath("userData");
  const p: Paths = {
    root,
    db: join(root, "data", "scene.db"),
    deliverables: join(root, "data", "deliverables"),
    exports: join(root, "exports"),
    logs: join(root, "logs"),
  };
  for (const dir of [join(root, "data"), p.deliverables, p.exports, p.logs]) {
    mkdirSync(dir, { recursive: true });
  }
  return p;
}

/** 拉起服务端；返回健康检查是否通过 */
async function startServer(): Promise<void> {
  if (!paths) throw new Error("数据目录未初始化");
  const { serverEntry, webDist } = runtimePaths();
  if (!existsSync(serverEntry)) {
    throw new Error(`服务端入口不存在：${serverEntry}（先跑 npm run desktop:runtime 生成运行时）`);
  }
  appPort = await freePort();
  serverLog = createWriteStream(join(paths.logs, "server.log"), { flags: "a" });

  serverProc = spawn(process.execPath, [serverEntry], {
    cwd: paths.root,
    env: {
      ...process.env,
      // 关键：以 Node 方式运行 Electron 可执行文件，安装包因此不必自带 Node
      ELECTRON_RUN_AS_NODE: "1",
      APP_HOST: "127.0.0.1",
      APP_PORT: String(appPort),
      DB_PATH: paths.db,
      DELIVERABLE_DIR: paths.deliverables,
      EXPORT_DIR: paths.exports,
      WEB_DIST: webDist,
      NODE_ENV: "production",
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverLog.write(`[desktop] app=${app.getVersion()} entry=${serverEntry}\n[desktop] web=${webDist}\n[desktop] userData=${paths.root}\n`);
  serverProc.stdout?.pipe(serverLog);
  serverProc.stderr?.pipe(serverLog);
  serverProc.on("exit", (code) => {
    if (code && code !== 0) bootError = `服务端进程退出（退出码 ${code}），日志见 ${join(paths!.logs, "server.log")}`;
  });

  await waitHealthy();
}

/** 轮询健康检查：服务端起不来时不要永久转圈，要给出可照做的原因 */
async function waitHealthy(): Promise<void> {
  const url = `http://127.0.0.1:${appPort}/api/v1/health`;
  const deadline = Date.now() + SERVER_BOOT_TIMEOUT_MS;
  let lastErr = "";
  while (Date.now() < deadline) {
    if (bootError) throw new Error(bootError);
    try {
      const r = await fetch(url);
      if (r.ok) return;
      lastErr = `HTTP ${r.status}`;
    } catch (err: unknown) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  const logPath = paths ? join(paths.logs, "server.log") : "日志";
  throw new Error(`本地服务启动超时（${lastErr}）；日志见 ${logPath}`);
}

function stopServer(): void {
  if (!serverProc || serverProc.killed) return;
  const child = serverProc;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 3000).unref();
}

/** 启动页：服务端就绪前的几秒不能让用户看白屏 */
function loadingPage(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`
    <html><head><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;background:#fafafa;color:#3f3f46;
        font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
      .w{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
      .t{font-size:15px;font-weight:600;color:#18181b}
      .s{font-size:13px;color:#71717a}
      .b{width:180px;height:3px;border-radius:2px;background:#e4e4e7;overflow:hidden}
      .b i{display:block;width:40%;height:100%;background:#2563eb;animation:m 1.1s ease-in-out infinite}
      @keyframes m{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
    </style></head><body><div class="w">
      <div class="t">${APP_TITLE} 正在启动</div>
      <div class="b"><i></i></div>
      <div class="s">正在准备本地服务…</div>
    </div></body></html>`)}`;
}

function errorPage(message: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`
    <html><head><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;background:#fafafa;color:#3f3f46;
        font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
      .w{max-width:560px;margin:0 auto;padding:12vh 28px}
      h1{font-size:17px;color:#18181b;margin:0 0 10px}
      p{font-size:13px;line-height:1.7;color:#52525b}
      code{background:#f4f4f5;padding:2px 6px;border-radius:4px;font-size:12px}
    </style></head><body><div class="w">
      <h1>${APP_TITLE} 没能启动本地服务</h1>
      <p>${message.replace(/</g, "&lt;")}</p>
      <p>可照做：关闭并重开应用；仍不行就把 <code>日志目录</code> 里的 <code>server.log</code> 发给开发者。</p>
    </div></body></html>`)}`;
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 700,
    title: APP_TITLE,
    backgroundColor: "#fafafa",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => (win = null));

  /* 站外链接交系统浏览器：右栏「看原文」的 URL 不该在应用窗口里开成"网页" */
  win.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    if (/^https?:/u.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  /* 应用内只允许停留本机 origin，其他一律外开 */
  win.webContents.on("will-navigate", (e: Electron.Event, url: string) => {
    if (!url.startsWith(`http://127.0.0.1:${appPort}`)) {
      e.preventDefault();
      if (/^https?:/u.test(url)) void shell.openExternal(url);
    }
  });
  /* 开发者工具默认不开：它在冒烟测试里会多出一个窗口（干扰取窗口），日志也全是无关报错。
     需要时用 SCENE_DEVTOOLS=1 显式打开。 */
  if (process.env.SCENE_DEVTOOLS === "1") win.webContents.openDevTools({ mode: "detach" });
}

function buildMenu(): void {
  const openDir = (which: "data" | "export") => () => {
    if (!paths) return;
    void shell.openPath(which === "data" ? paths.root : paths.exports);
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? ([{ role: "appMenu", submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "quit" }] }] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: "文件",
      submenu: [
        { label: "打开数据目录", click: openDir("data") },
        { label: "打开导出目录", click: openDir("export") },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu", label: "编辑" },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "forceReload", label: "强制重新加载" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
        ...(isDev ? ([{ role: "toggleDevTools", label: "开发者工具" }] as Electron.MenuItemConstructorOptions[]) : []),
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "本地服务地址",
          click: () => {
            void dialog.showMessageBox({
              type: "info",
              message: `${APP_TITLE} 本地服务`,
              detail: `http://127.0.0.1:${appPort}\n\n数据目录：${paths?.root ?? "-"}`,
              buttons: ["好"],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc(): void {
  ipcMain.handle("open-data-dir", () => (paths ? shell.openPath(paths.root) : undefined));
  ipcMain.handle("open-export-dir", () => (paths ? shell.openPath(paths.exports) : undefined));
  ipcMain.handle("app-info", () => ({
    version: app.getVersion(),
    port: appPort,
    dataDir: paths?.root ?? "",
  }));
}

/* 单实例：第二次启动只是把已有窗口抬起来，不再起第二个服务端 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    paths = preparePaths();
    registerIpc();
    buildMenu();
    createWindow();
    win?.loadURL(loadingPage());
    try {
      await startServer();
      await win?.loadURL(`http://127.0.0.1:${appPort}/`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await win?.loadURL(errorPage(message));
    }
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("will-quit", stopServer);
}
