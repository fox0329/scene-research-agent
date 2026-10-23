/**
 * @scene/web — 资料库右栏（变更表 #305 / #307）
 *
 * 上下排列：上区「行详情」（选中行才出现），下区「资料助手」对话；
 * 两区之间可拖分隔条调高度（与产物右栏同一套交互），比例写 localStorage。
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ingestStream,
  libraryChat,
  libraryChatStream,
  libraryIngestPath,
} from "../api";
import type { RowDetail } from "./RowDetailPanel";
import { RowDetailPanel } from "./RowDetailPanel";

type ChatMsg = {
  id: string;
  role: "用户" | "系统";
  content: string;
  created_at: string;
};

const DEFAULT_TOP_PCT = 40;
const MIN_TOP_PCT = 20;
const MAX_TOP_PCT = 65;
const TOP_PCT_KEY = "scene.library.split.v1";

function clampPct(v: number): number {
  return Math.min(MAX_TOP_PCT, Math.max(MIN_TOP_PCT, Math.round(v)));
}

function readTopPct(): number {
  try {
    const raw = Number(localStorage.getItem(TOP_PCT_KEY));
    return Number.isFinite(raw) && raw >= MIN_TOP_PCT && raw <= MAX_TOP_PCT
      ? Math.round(raw)
      : DEFAULT_TOP_PCT;
  } catch {
    return DEFAULT_TOP_PCT;
  }
}

/** 判断这行字是不是"要入库的地址"：http(s) 链接或绝对路径 */
function looksLikeTarget(text: string): boolean {
  const t = text.trim();
  return /^https?:\/\/\S+$/u.test(t) || (t.startsWith("/") && !t.includes("\n"));
}

export const LibraryRightPanel: React.FC<{
  lineId?: string;
  live: boolean;
  rowDetail: RowDetail | null;
  onCloseDetail: () => void;
}> = ({ lineId, live, rowDetail, onCloseDetail }) => {
  const [topPct, setTopPct] = useState(readTopPct);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!live || !lineId) return;
    let alive = true;
    setLoading(true);
    libraryChat(lineId)
      .then((r) => {
        if (alive) setMessages(r.messages as ChatMsg[]);
      })
      .catch(() => {
        /* 打开失败不阻塞输入 */
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [live, lineId]);

  /* 分隔条：鼠标拖动（全程 document 跟手），比例写 localStorage */
  const beginResize = useCallback(
    (startY: number) => {
      const el = stackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const start = topPct;
      const onMove = (e: MouseEvent): void => {
        setTopPct(clampPct(start + ((e.clientY - startY) / rect.height) * 100));
      };
      const onUp = (): void => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        setTopPct((pct) => {
          try {
            localStorage.setItem(TOP_PCT_KEY, String(pct));
          } catch {
            /* 隐私模式忽略 */
          }
          return pct;
        });
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [topPct],
  );

  const append = useCallback((role: ChatMsg["role"], content: string) => {
    setMessages((cur) => [
      ...cur,
      {
        id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role,
        content,
        created_at: new Date().toISOString(),
      },
    ]);
  }, []);

  const uploadFiles = useCallback(
    async (files: FileList | null) => {
      if (!lineId || !files?.length) return;
      setNote(`正在上传 ${files[0]!.name}…`);
      try {
        let inserted = 0;
        for await (const ev of ingestStream(files[0]!, lineId)) {
          if (ev.type === "done") {
            const rows = (ev as { rows?: number }).rows;
            if (typeof rows === "number") inserted = rows;
          }
        }
        setNote(`已入库 ${inserted} 行`);
        append("系统", `已上传并入库：${files[0]!.name}（${inserted} 行）`);
      } catch (err) {
        setNote(`上传失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [append, lineId],
  );

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!lineId || !live || sending || !text) return;
    setSending(true);
    setDraft("");
    setNote(null);
    append("用户", text);
    try {
      /* 纯链接/绝对路径：直接入库，不进模型 */
      if (looksLikeTarget(text)) {
        setNote("正在入库…");
        const r = await libraryIngestPath(lineId, text);
        const msg = `已入库 ${r.inserted} 行（${r.file}）`;
        setNote(msg);
        append("系统", msg);
        return;
      }
      let reply = "";
      let streamed = false;
      for await (const ev of libraryChatStream(lineId, text)) {
        if (ev.type === "text") {
          const piece = String((ev as { text?: unknown }).text ?? "");
          if (!piece) continue;
          reply += piece;
          if (!streamed) {
            streamed = true;
            append("系统", piece);
          } else {
            setMessages((cur) => {
              const next = [...cur];
              const last = next[next.length - 1];
              if (last?.role === "系统") {
                next[next.length - 1] = { ...last, content: last.content + piece };
              }
              return next;
            });
          }
        }
      }
      if (!reply) append("系统", "（没有收到回复）");
      const fresh = await libraryChat(lineId);
      setMessages(fresh.messages as ChatMsg[]);
    } catch (err) {
      append("系统", `【错误】${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
    }
  }, [append, draft, lineId, live, sending]);

  const chat = (
    <div className="lib-chat">
      <div className="thread-head">
        <strong>资料助手</strong>
      </div>
      <div className="lib-chat-scroll" role="log" aria-live="polite">
        {!live ? (
          <p className="thread-empty">演示模式</p>
        ) : loading ? (
          <div className="loading-strip" role="status" aria-label="加载资料对话" />
        ) : messages.length === 0 ? (
          <div className="thread-empty">
            <strong>资料助手</strong>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`thread-msg${m.role === "用户" ? " user" : ""}`}>
              <div className="thread-msg-meta">{m.role === "用户" ? "你" : "助手"}</div>
              <div className="thread-msg-bubble">{m.content.replace(/\*\*/g, "")}</div>
            </div>
          ))
        )}
      </div>

      {note ? <p className="thread-status">{note}</p> : null}

      <div className="thread-composer">
        <div className="thread-input-shell">
          <textarea
            className="thread-textarea"
            rows={2}
            style={{ height: 64 }}
            value={draft}
            disabled={!live || !lineId || sending}
            placeholder={
              lineId
                ? "问资料库，或粘贴链接 / 绝对路径直接入库…"
                : "先在左侧选择一个产品线"
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="thread-input-actions">
            <button
              type="button"
              className="btn ghost sm"
              title="上传文件入库"
              disabled={!live || !lineId || sending}
              onClick={() => fileRef.current?.click()}
            >
              📎 上传
            </button>
            <span className="thread-input-hint">Enter 发送 · Shift+Enter 换行</span>
            <button
              type="button"
              className="btn primary sm"
              disabled={!live || !lineId || sending || !draft.trim()}
              onClick={() => void submit()}
            >
              {sending ? "发送中…" : "发送"}
            </button>
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={(e) => {
            void uploadFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );

  /* 没选行：对话占满；选了行：上详情下对话，中间可拖 */
  if (!rowDetail) {
    return <div className="lib-panel">{chat}</div>;
  }

  return (
    <div
      ref={stackRef}
      className="lib-panel"
      style={{
        display: "grid",
        gridTemplateRows: `${topPct}% var(--size-8) minmax(0, 1fr)`,
      }}
    >
      <div className="lib-detail">
        <RowDetailPanel detail={rowDetail} onClose={onCloseDetail} />
      </div>
      <div
        className="artifact-splitter"
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整行详情与资料助手高度"
        tabIndex={0}
        onMouseDown={(e) => {
          e.preventDefault();
          beginResize(e.clientY);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            setTopPct((pct) => clampPct(pct + (e.key === "ArrowDown" ? 4 : -4)));
          }
        }}
        onDoubleClick={() => setTopPct(DEFAULT_TOP_PCT)}
      />
      <div className="lib-chat-wrap">{chat}</div>
    </div>
  );
};
