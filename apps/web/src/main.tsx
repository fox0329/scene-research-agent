/**
 * @scene/web — React 应用入口
 *
 * 技术栈：React 18 + Vite 6 + TypeScript
 * 样式：原生 CSS + design-system tokens（CSS 变量）
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/app.css";

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);