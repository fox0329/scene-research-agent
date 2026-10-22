/**
 * @scene/desktop — preload（最小桥）
 *
 * 只暴露"这是个桌面应用"以及两个打开目录的动作；其余一律走 HTTP API，
 * 不为桌面版开第二套数据通道（避免出现"浏览器版能用、桌面版另走一路"的分叉）。
 */

/* 同 main.ts：用 require 绕开 esbuild 的 ESM 互操作包装，否则 contextBridge 会是 undefined */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electron = require("electron") as typeof import("electron");

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("sceneDesktop", {
  isDesktop: true as const,
  openDataDir: () => ipcRenderer.invoke("open-data-dir"),
  openExportDir: () => ipcRenderer.invoke("open-export-dir"),
  appInfo: () => ipcRenderer.invoke("app-info"),
});
