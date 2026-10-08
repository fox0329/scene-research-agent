import { defineConfig } from "@playwright/test";

/**
 * 交互规范断言套件（M4-T4.3）
 * 被测对象：构建产物（vite preview 伺服 apps/web/dist，守则 5）
 * 端口 46174：E2E 专用测试端口，避开应用 46172/46192+、DSH 46171/46181+、dev 46173
 *
 * 第二个 webServer（46175，联真 e2e 用）：起真应用服务（单端口 UI+API），
 * 独立临时数据库（每次启动时间戳命名，测试间隔离），供应商配置共享主
 * data/providers.local.json（只读使用，走真实模型链路）。
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 20_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:46174",
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      // 必须显式绑 127.0.0.1：vite preview 默认绑 [::1]（仅 IPv6），
      // 而本配置的探活 URL 是 127.0.0.1 → 会一直等不到就绪而 30s 超时。
      command:
        "pnpm --filter @scene/web exec vite preview --host 127.0.0.1 --port 46174 --strictPort",
      url: "http://127.0.0.1:46174",
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command:
        // 先同步 SQL：tsc -b 不会拷贝 .sql，而运行时从 dist/sql/ 读迁移文件
        "node scripts/copy-infra-sql.mjs && APP_PORT=46175 DB_PATH=/tmp/scene-e2e-$(date +%s).db DELIVERABLE_DIR=/tmp/scene-e2e-deliverables-$(date +%s) SCENE_PROVIDERS_FILE=data/providers.local.json node apps/server/dist/index.js",
      url: "http://127.0.0.1:46175/api/v1/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
