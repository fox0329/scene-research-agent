import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../mock/project-data";

/* 抽屉尺寸约束（与原型 v9 定稿一致） */
const DRAWER_DEFAULT_HEIGHT = 300;
const DRAWER_MIN_HEIGHT = 100;
/** 抽屉最大高度占视口比例 */
const DRAWER_MAX_RATIO = 0.75;
/** 打开后延时滚动到底部（等待高度过渡） */
const SCROLL_DELAY_MS = 100;
const TEXTAREA_MAX_HEIGHT = 100;

interface ConversationDrawerProps {
  messages: ChatMessage[];
}

/**
 * 对话抽屉（原型 v9 定稿交互）
 * - 输入栏常驻底部（实底白色、两行高、聚焦淡蓝边线）
 * - 聚焦输入框展开对话流（250ms 高度过渡、半透明浮层）
 * - 拖拽条常亮，可上下拖动调高度（拖动期间禁用过渡保证跟手）
 * - 点击工作区（可编辑单元格/按钮除外）或 Esc 收起
 */
export const ConversationDrawer: React.FC<ConversationDrawerProps> = ({ messages }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [height, setHeight] = useState(DRAWER_DEFAULT_HEIGHT);
  const [isDragging, setIsDragging] = useState(false);
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<ChatMessage[]>([]);
  const streamRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const open = useCallback(() => setIsOpen(true), []);

  const close = useCallback(() => {
    setIsOpen(false);
    inputRef.current?.blur();
  }, []);

  /* 展开后滚到底部 */
  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setTimeout(() => {
      if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }, SCROLL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isOpen, sent.length]);

  /* 点击工作区收起（可编辑单元格与按钮除外，避免打断编辑）；Esc 收起 */
  useEffect(() => {
    if (!isOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(".conv-layer")) return;
      if (target.closest(".ws") && !target.closest(".ed") && !target.closest("button")) {
        close();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen, close]);

  /* 拖拽调高度：mousemove 挂 window，松手移除 */
  const handleResizeDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = height;
      setIsDragging(true);
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: MouseEvent) => {
        const delta = startY - ev.clientY;
        const maxH = window.innerHeight * DRAWER_MAX_RATIO;
        setHeight(Math.max(DRAWER_MIN_HEIGHT, Math.min(maxH, startHeight + delta)));
      };
      const onUp = () => {
        setIsDragging(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [height],
  );

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
  };

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    setSent((prev) => [...prev, { role: "user", time, text }]);
    setDraft("");
    if (inputRef.current) {
      inputRef.current.style.height = "";
    }
    setIsOpen(true);
  }, [draft]);

  const allMessages = [...messages, ...sent];

  return (
    <div className={`conv-layer${isOpen ? " open" : ""}`} aria-label="对话抽屉">
      {/* 拖拽热区：48×4px 圆条，常亮，hover 变主色 */}
      <div
        className="conv-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="拖拽调整对话流高度"
        title="拖拽调整高度"
        onMouseDown={handleResizeDown}
      />

      {/* 对话流：250ms 高度过渡 + 半透明浮层 */}
      <div
        className={`conv-stream-wrap${isOpen ? " open" : ""}${isDragging ? " is-dragging" : ""}`}
        style={{ height: isOpen ? height : 0 }}
      >
        <div className="conv-stream" ref={streamRef} role="log" aria-live="polite">
          {allMessages.map((m, i) => (
            <div key={i} className={`msg ${m.role === "user" ? "u" : "ai"}`}>
              <div className="bub">{m.text}</div>
              <div className="msg-meta">{m.time}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 输入栏：常驻底部 */}
      <div className="conv-input">
        <textarea
          ref={inputRef}
          className="conv-ta"
          placeholder="输入问题或指令..."
          rows={2}
          value={draft}
          onFocus={open}
          onInput={(e) => {
            setDraft(e.currentTarget.value);
            autoGrow(e.currentTarget);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="conv-send" type="button" onClick={send}>
          发送
        </button>
      </div>
    </div>
  );
};
