import { defineConfig } from "@playwright/test";

/**
 * 交互规范断言套件（M4-T4.3）
 * 被测对象：构建产物（vite preview 伺服 apps/web/dist，守则 5）
 * 端口 4180：E2E 专用测试端口，避开应用 4081/4082+、DSH 3081/3082+、dev 5173
 *
 * 第二个 webServer（4181，联真 e2e 用）：起真应用服务（单端口 UI+API），
 * 独立临时数据库（每次启动时间戳命名，测试间隔离），供应商配置共享主
 * data/providers.local.json（只读使用，走真实模型链路）。
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 20_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4180",
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      command: "pnpm --filter @scene/web exec vite preview --port 4180 --strictPort",
      url: "http://127.0.0.1:4180",
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command:
        "APP_PORT=4181 DB_PATH=/tmp/scene-e2e-$(date +%s).db SCENE_PROVIDERS_FILE=data/providers.local.json node apps/server/dist/index.js",
      url: "http://127.0.0.1:4181/api/v1/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
