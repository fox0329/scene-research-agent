/**
 * @scene/web — 资料库右栏（变更表 #305 / #307）
 *
 * 只放「资料助手」对话（#308：行详情已从右栏删除）；上传与链接/路径入库同前。
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ingestStream,
  libraryChat,
  libraryChatStream,
  libraryIngestPath,
} from "../api";
import { stripToolEcho } from "./tool-echo";
import { pickSupportedFiles } from "../constants";
import { describeUploadOutcome } from "./ingest-receipt";
import { notifyDataChanged } from "../data-events";

/** #309：资料助手输入框高度（拖上边缘调高，与产物会话同一套交互） */
const INPUT_H_KEY = "scene.library.input-h.v1";
const INPUT_DEF_H = 64;
const INPUT_MIN_H = 48;
const INPUT_MAX_H = 320;

function clampInputH(value: number): number {
  return Math.min(INPUT_MAX_H, Math.max(INPUT_MIN_H, Math.round(value)));
}

function readInputH(): number {
  try {
    const raw = Number(localStorage.getItem(INPUT_H_KEY));
    return Number.isFinite(raw) && raw >= INPUT_MIN_H && raw <= INPUT_MAX_H
      ? Math.round(raw)
      : INPUT_DEF_H;
  } catch {
    return INPUT_DEF_H;
  }
}

function saveInputH(value: number): void {
  try {
    localStorage.setItem(INPUT_H_KEY, String(value));
  } catch {
    /* 隐私模式忽略 */
  }
}

type ChatMsg = {
  id: string;
  role: "用户" | "系统";
  content: string;
  created_at: string;
};

/** 判断这行字是不是"要入库的地址"：http(s) 链接或绝对路径 */
function looksLikeTarget(text: string): boolean {
  const t = text.trim();
  return /^https?:\/\/\S+$/u.test(t) || (t.startsWith("/") && !t.includes("\n"));
}

export const LibraryRightPanel: React.FC<{
  lineId?: string;
  live: boolean;
}> = ({ lineId, live }) => {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [inputH, setInputH] = useState(readInputH);
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
      /* 先物化：input.files 是活引用，onChange 里清空 value 后它会变空（实测 .name 报错） */
      const file = files.item(0);
      if (!file) return;
      const { files: supported, skippedNames } = pickSupportedFiles([file]);
      if (supported.length === 0) {
        setNote(
          skippedNames.length
            ? `不支持这个文件：${skippedNames[0]}。仅支持 PDF / .docx / .xlsx / .pptx / 文本；旧版 .doc 请先另存为 .docx。`
            : "没有可上传的文件",
        );
        return;
      }
      setNote(`正在上传 ${file.name}…`);
      try {
        let inserted = 0;
        let recognized = 0;
        let modelIssue = "";
        for await (const ev of ingestStream(file, lineId)) {
          if (ev.type === "done") {
            const d = ev as { rows_inserted?: number; recognized_rows?: number; model_issue?: string };
            inserted = Number(d.rows_inserted ?? 0);
            recognized = Number(d.recognized_rows ?? inserted);
            modelIssue = String(d.model_issue ?? "");
          } else if (ev.type === "error") {
            throw new Error(String((ev as { message?: string }).message ?? "入库失败"));
          }
        }
        const summary = describeUploadOutcome(file.name, inserted, recognized, modelIssue);
        setNote(summary);
        append("系统", summary);
      } catch (err) {
        setNote(`上传失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [append, lineId],
  );

  /* 拖输入框上边缘调高：mousemove 全程挂在 document 上，出热区不掉跟 */
  const onInputResizeStart = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startY = event.clientY;
    const startH = inputH;
    const onMove = (e: MouseEvent): void => {
      setInputH(clampInputH(startH - (e.clientY - startY)));
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setInputH((h) => {
        saveInputH(h);
        return h;
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

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
        if (ev.type === "operation") {
          notifyDataChanged();
        } else if (ev.type === "text") {
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

  return (
    <div className="lib-panel">
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
            messages.map((m) => {
              const body =
                m.role === "用户" ? m.content : stripToolEcho(m.content.replace(/\*\*/g, ""));
              if (!body) return null;
              return (
                <div key={m.id} className={`thread-msg${m.role === "用户" ? " user" : ""}`}>
                  <div className="thread-msg-meta">{m.role === "用户" ? "你" : "助手"}</div>
                  <div className="thread-msg-bubble">{body}</div>
                </div>
              );
            })
          )}
        </div>

        {note ? <p className="thread-status">{note}</p> : null}

        <div className="thread-composer">
          <div className="thread-input-shell">
            <div
              className="thread-input-resize"
              role="separator"
              aria-label="调整输入框高度"
              aria-orientation="horizontal"
              title="拖动调整输入框高度"
              onMouseDown={onInputResizeStart}
            />
            <textarea
              className="thread-textarea"
              rows={2}
              style={{ height: inputH }}
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
    </div>
  );
};
