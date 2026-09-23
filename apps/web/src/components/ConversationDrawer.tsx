import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../mock/project-data";
import { api, conversationMessageStream } from "../api";

/* 抽屉尺寸约束（与原型 v9 定稿一致） */
const DRAWER_DEFAULT_HEIGHT = 300;
const DRAWER_MIN_HEIGHT = 100;
/** 抽屉最大高度占视口比例 */
const DRAWER_MAX_RATIO = 0.75;
/** 打开后延时滚动到底部（等待高度过渡） */
const SCROLL_DELAY_MS = 100;
const TEXTAREA_MAX_HEIGHT = 100;
/** 首发消息自动建会话：标题取消息前 30 字（会话标题上限 50 字符） */
const AUTO_TITLE_LEN = 30;

interface ConversationDrawerProps {
  /** 演示模式消息源（mock）；联真模式忽略 */
  messages: ChatMessage[];
  /** 联真模式：发送走 converse SSE，历史走 listMessages */
  live?: boolean;
  /** 联真模式当前项目 id（无会话时首发消息自动建会话） */
  projectId?: string | null;
  /** 联真模式当前选中会话（左栏会话点击提升而来） */
  conversationId?: string | null;
  /** 自动建会话成功回调：父级刷新列表并选中 */
  onConversationCreated?: (conv: { id: string; title: string }) => void;
}

/** ISO 时间 → HH:MM（无效值给空串，气泡时间行留白） */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function nowTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 对话抽屉（原型 v9 定稿交互）
 * - 输入栏常驻底部（实底白色、两行高、聚焦淡蓝边线）
 * - 聚焦输入框展开对话流（250ms 高度过渡、半透明浮层）
 * - 拖拽条常亮，可上下拖动调高度（拖动期间禁用过渡保证跟手）
 * - 点击工作区（可编辑单元格/按钮除外）或 Esc 收起
 *
 * 联真模式（M5-T5.5）：
 * - 切换会话时拉取真实历史（GET messages）
 * - 发送 → POST messages SSE 流：text 增量进 AI 气泡，error 落【错误】气泡
 * - 无会话时首发消息以内容摘要自动建会话（DSH 不可用则气泡内降级提示）
 */
export const ConversationDrawer: React.FC<ConversationDrawerProps> = ({
  messages,
  live = false,
  projectId = null,
  conversationId = null,
  onConversationCreated,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [height, setHeight] = useState(DRAWER_DEFAULT_HEIGHT);
  const [isDragging, setIsDragging] = useState(false);
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<ChatMessage[]>([]);
  /** 联真模式：已落定的消息（历史 + 本地完成的往返），流式中的 AI 气泡单独存 */
  const [liveMsgs, setLiveMsgs] = useState<ChatMessage[]>([]);
  const [streamText, setStreamText] = useState<string | null>(null);
  const streamingRef = useRef(false);
  /**
   * sendLive 正在本地管理的会话 id。
   * 自动建会话时 conversationId 由 null→id，会触发历史拉取；
   * 而错误回复不落库，晚到的 listMessages 会用只含用户消息的历史
   * 覆盖掉刚落定的 AI 气泡。故对该会话跳过拉取，直到用户切走。
   */
  const selfManagedConvRef = useRef<string | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const open = useCallback(() => setIsOpen(true), []);

  const close = useCallback(() => {
    setIsOpen(false);
    inputRef.current?.blur();
  }, []);

  /* 联真模式：切换会话拉真实历史（sendLive 本地管理的会话跳过） */
  useEffect(() => {
    if (!live) return;
    if (!conversationId) {
      /* 流式中允许短暂 null（父级列表对账抖动）：不清本地列表也不解除接管标记 */
      if (!streamingRef.current) {
        setLiveMsgs([]);
        selfManagedConvRef.current = null;
      }
      return;
    }
    // sendLive 正在/刚刚本地落定的会话：以本地列表为准，跳过拉取，
    // 否则晚到的历史（不含未落库的错误回复）会覆盖掉 AI 气泡。
    if (conversationId === selfManagedConvRef.current) return;
    // 真实导航到别的会话：重置接管标记，正常拉取
    selfManagedConvRef.current = null;
    let cancelled = false;
    api
      .listMessages(conversationId)
      .then((rows) => {
        if (cancelled || streamingRef.current) return;
        setLiveMsgs(
          rows.map((m) => ({
            role: m.role === "用户" ? "user" : "ai",
            time: fmtTime(m.created_at),
            text: m.content,
          })),
        );
      })
      .catch(() => {
        /* 拉历史失败保持当前视图，发送时仍有流内错误提示兜底 */
      });
    return () => {
      cancelled = true;
    };
  }, [live, conversationId]);

  /* 展开后滚到底部 */
  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setTimeout(() => {
      if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }, SCROLL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isOpen, sent.length, liveMsgs.length, streamText]);

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

  const clearDraft = () => {
    setDraft("");
    if (inputRef.current) inputRef.current.style.height = "";
  };

  const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

  /** 联真模式发送：用户气泡先落定，AI 气泡随 SSE 增量生长，结束后并入列表 */
  const sendLive = async (text: string) => {
    if (!projectId) return;
    let convId = conversationId;
    if (!convId) {
      /* 无会话：以消息摘要自动建会话（DSH 不可用时此处即降级提示） */
      const title =
        text.length > AUTO_TITLE_LEN ? `${text.slice(0, AUTO_TITLE_LEN)}…` : text;
      try {
        const created = await api.createConversation(projectId, title);
        convId = created.id;
        onConversationCreated?.({ id: created.id, title: created.title });
      } catch (err: unknown) {
        setLiveMsgs((prev) => [
          ...prev,
          { role: "user", time: nowTime(), text },
          { role: "ai", time: nowTime(), text: `【错误】${errMsg(err)}` },
        ]);
        return;
      }
    }
    // 从此刻起该会话以本地列表为事实源（null→id 的 prop 变化会触发拉取效应）
    selfManagedConvRef.current = convId;
    streamingRef.current = true;
    setLiveMsgs((prev) => [...prev, { role: "user", time: nowTime(), text }]);
    setStreamText("");
    let reply = "";
    try {
      for await (const ev of conversationMessageStream(convId, text)) {
        if (ev.type === "text") {
          reply += String(ev.text ?? "");
          setStreamText(reply);
        } else if (ev.type === "error") {
          reply += `${reply ? "\n" : ""}【错误】${String(ev.message ?? "未知错误")}`;
          setStreamText(reply);
        }
      }
    } catch (err: unknown) {
      reply += `${reply ? "\n" : ""}【错误】${errMsg(err)}`;
    }
    streamingRef.current = false;
    setStreamText(null);
    /* 用户中途切走则不追加（历史落库成功回复，切回时由拉取效应恢复） */
    if (selfManagedConvRef.current === convId) {
      setLiveMsgs((prev) => [
        ...prev,
        { role: "ai", time: nowTime(), text: reply || "【错误】未收到回复内容" },
      ]);
    }
  };

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    if (live) {
      setIsOpen(true);
      /* 无项目/流式中：保留草稿不发送，抽屉内提示可见 */
      if (!projectId || streamingRef.current) return;
      clearDraft();
      void sendLive(text);
      return;
    }
    /* 演示模式：本地 mock 追加，行为与原型一致 */
    setSent((prev) => [...prev, { role: "user", time: nowTime(), text }]);
    clearDraft();
  }, [draft, live, projectId, conversationId, onConversationCreated]);

  const busy = live && streamText !== null;
  const allMessages: ChatMessage[] = live
    ? [
        ...liveMsgs,
        ...(streamText !== null
          ? [{ role: "ai" as const, time: nowTime(), text: streamText || "思考中…" }]
          : []),
        ]
    : [...messages, ...sent];

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
          {live && allMessages.length === 0 ? (
            <div className="conv-hint">
              {projectId
                ? "输入问题或指令，发送后自动建立会话并流式回复"
                : "请先在项目工作台选择一个项目"}
            </div>
          ) : null}
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
        <button
          className="conv-send"
          type="button"
          onClick={send}
          disabled={busy}
          aria-busy={busy}
        >
          发送
        </button>
      </div>
    </div>
  );
};
