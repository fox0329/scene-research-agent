import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
      "@scene/contract": "/src/__stub__/contract.ts",
      "@scene/domain": "/src/__stub__/domain.ts",
    },
  },
});