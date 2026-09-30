import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 开发态联真：/api → 应用主实例 4081（AGENTS 端口规则；preview 不配代理，E2E 走演示模式）
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4081",
        changeOrigin: true,
      },
    },
  },
  // preview.proxy 默认继承 server.proxy：显式清空，E2E/预览恒走演示模式，
  // 不受本机 4081 真实后端是否在跑的影响（否则 mock 断言会被联真数据干扰）
  preview: {
    proxy: {},
  },
  resolve: {
    alias: {
      // v1.4：前端需要**运行时的表定义**（34 张表的列/枚举/固定行），
      // 因此 @scene/contract 指向真实源码；表定义只有注册表这一个事实源。
      "@scene/contract": resolve(here, "../../packages/contract/src/index.ts"),
      // 确认清单等纯逻辑也只在领域层写一份（可单测），前端复用而不是重写
      "@scene/domain": resolve(here, "../../packages/domain/src/index.ts"),
    },
  },
});