import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";

/**
 * 三栏壳列宽状态：拖宽（偏离 #1，已批准）+ 缘收起（偏离 #2）
 * 配方来源：design-system app-shell-layout.md（React 拖拽骨架 §3.4）
 * 范围：左 200-320 / 右 240-720（#297：上限 480→720，给对话更大空间）；宽度写 localStorage 重启保留。
 */

export const SIDE_RANGE = { min: 200, max: 320, def: 256 } as const;
export const DET_RANGE = { min: 240, max: 720, def: 280 } as const;

const KEY_SIDE = "shell.side-w";
const KEY_DET = "shell.det-w";

type DragTarget = "side" | "det" | null;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function loadWidth(key: string, range: { min: number; max: number; def: number }): number {
  const raw = Number(window.localStorage.getItem(key));
  if (Number.isFinite(raw) && raw >= range.min && raw <= range.max) return raw;
  return range.def;
}

export function useColumnLayout() {
  const [sideW, setSideW] = useState(() => loadWidth(KEY_SIDE, SIDE_RANGE));
  const [detW, setDetW] = useState(() => loadWidth(KEY_DET, DET_RANGE));
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [detCollapsed, setDetCollapsed] = useState(false);
  const [dragging, setDragging] = useState<DragTarget>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => window.localStorage.setItem(KEY_SIDE, String(sideW)), [sideW]);
  useEffect(() => window.localStorage.setItem(KEY_DET, String(detW)), [detW]);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);

  /** 拖宽：左栏跟手，右栏反向（往左拖变宽） */
  const beginResize = useCallback((which: Exclude<DragTarget, null>, e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = which === "side" ? sideW : detW;
    setDragging(which);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      setSideW((w) => (which === "side" ? clamp(startW + dx, SIDE_RANGE.min, SIDE_RANGE.max) : w));
      setDetW((w) => (which === "det" ? clamp(startW - dx, DET_RANGE.min, DET_RANGE.max) : w));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragging(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [sideW, detW]);

  /** 注入 .shell 的 CSS 变量（grid 轨道由此驱动） */
  const shellStyle = {
    "--app-side-w": `${sideW}px`,
    "--app-det-w": `${detW}px`,
  } as React.CSSProperties;

  const shellClass = [
    "shell",
    sideCollapsed && "side-collapsed",
    detCollapsed && "det-collapsed",
    dragging === "side" && "drag-side",
    dragging === "det" && "drag-det",
  ].filter(Boolean).join(" ");

  return {
    shellStyle,
    shellClass,
    beginResize,
    sideCollapsed,
    detCollapsed,
    toggleSide: () => setSideCollapsed((v) => !v),
    toggleDet: () => setDetCollapsed((v) => !v),
  };
}
