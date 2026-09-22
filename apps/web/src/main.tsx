/**
 * @scene/web — React 应用入口
 *
 * 技术栈：React 18 + Vite 6 + TypeScript + Tailwind + Shadcn/ui
 * 路由：React Router v7
 * 数据：TanStack Query + TanStack Table
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// TODO: 引入全局样式（Tailwind + design-system tokens）
// import "./styles/globals.css";

// TODO: 引入路由配置
// import { RouterProvider } from "react-router-dom";
// import { router } from "./router";

function App() {
  // TODO: 替换为正式路由
  return (
    <div className="flex h-screen items-center justify-center">
      <h1 className="text-2xl font-bold">场景通 — skeleton OK</h1>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
