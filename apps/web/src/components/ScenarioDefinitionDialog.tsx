/**
 * @scene/web — 场景定义对话（独立页面级弹窗）
 *
 * 用户定调：场景定义**不该让用户一项一项填空**（三段式表单"难度大、不友好、
 * 不是智能体该有的模式"）。所以：
 *   新建场景只输名称 → 打开这个独立对话页 → 模型先给它的理解 + 提 ≤3 个
 *   场景本体问题 → 用户对话回答 → 点「整理成定义」→ 系统把对话整理成表1-1
 *   场景锚 → 关闭后回到流程第 1 步（场景定义与边界），需要表态的项在右栏，
 *   但**不确认也能往下走**（定义的松紧不卡推进）。
 *
 * 三条定调（实现不得偏离）：
 *  1. **定义对话不占流程步**：它属于「新建场景」，落成表1-1 后在第 1 步就地补充/表态
 *  2. **只在用户点「整理成定义」时才写表**，不自动增量改用户的表
 *  3. 对话是独立弹窗/单独页面——不是中栏，不是右下角对话抽屉
 *
 * 语气定调：场景定义允许说不准——整理结果只列出「核心项 + 模型实际填了/推断的项」，
 * 标「推断」的先留「待定」也行，后续行业研究会补全。
 *
 * 演示模式（`demo`，无后端）：用 `mock/demo-flow.ts` 的本地预置对话与本地整理结果，
 * 结构、类名、文案与联真完全一致（E2E 在演示模式跑）。
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  definitionChatStream,
  type ApiAnchorRow,
  type ApiDefinitionConsolidation,
  type ApiDefinitionMessage,
} from "../api";
import { AlignmentTable } from "./AlignmentTable";
import {
  DEMO_DEFINITION_MESSAGES,
  DEMO_DEFINITION_REPLY,
  demoDefinitionConsolidation,
} from "../mock/demo-flow";

/**
 * 首次打开时的引导语
 *
 * 选「自动发一条用户引导消息」而非「让模型先开口」：SSE 流必须由一条用户消息触发，
 * 前端不该伪造模型发言（那会在历史里留下一条并不存在的"系统消息"）。
 * 这句引导语会真实落库，用户下次进来能看到自己的开场白；模型的"先给理解再提问"
 * 由后端定义模式的 system prompt 保证。
 */
const GUIDE_MESSAGE = "我想梳理这个场景";

/** 底部输入框最大高度（超出转滚动，与对话抽屉同口径） */
const TEXTAREA_MAX_HEIGHT = 100;

export interface ScenarioDefinitionDialogProps {
  open: boolean;
  projectId: string;
  /** 场景名（弹窗标题） */
  scenarioName: string;
  /** 演示模式：不发任何请求，用本地预置对话与本地整理结果 */
  demo?: boolean;
  /** 关闭（× / Esc / 「完成，回到第 1 步」） */
  onClose: () => void;
  /** 整理成定义成功：父级据此刷新表1-1 与流程就绪 */
  onConsolidated?: (rows: ApiAnchorRow[]) => void;
  /** 点「完成，回到第 1 步」：父级据此刷新表1-1 与流程就绪 */
  onFinished?: () => void;
}

/** ISO / 本地时间 → HH:MM；无效值给空串（气泡时间行留白） */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const ScenarioDefinitionDialog: React.FC<ScenarioDefinitionDialogProps> = ({
  open,
  projectId,
  scenarioName,
  demo = false,
  onClose,
  onConsolidated,
  onFinished,
}) => {
  const [messages, setMessages] = useState<ApiDefinitionMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** 流式中的模型回复（null = 当前没有流） */
  const [streamText, setStreamText] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [view, setView] = useState<"chat" | "result">("chat");
  const [result, setResult] = useState<ApiDefinitionConsolidation | null>(null);
  const [consolidating, setConsolidating] = useState(false);

  const streamRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const seqRef = useRef(0);
  /** 打开前的焦点元素：关闭后还回去（键盘用户不会掉到 body 上） */
  const returnFocusRef = useRef<HTMLElement | null>(null);
  /** 发送中标记（ref 版：供回调与事件处理读取，避免闭包读到旧 state） */
  const sendingRef = useRef(false);
  /** 已为哪个项目自动发过引导语（防 StrictMode 双跑 / 重开重复发送） */
  const guidedRef = useRef<string | null>(null);
  /** onClose 的最新引用（Esc 监听器不随父级重渲染重挂） */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const appendLocal = useCallback((role: "用户" | "系统", content: string) => {
    seqRef.current += 1;
    setMessages((prev) => [
      ...prev,
      { id: `local-${seqRef.current}`, role, content, created_at: nowIso() },
    ]);
  }, []);

  /** 发消息：用户气泡先落定，模型气泡随 SSE 增量生长 */
  const send = useCallback(
    async (raw: string) => {
      const content = raw.trim();
      if (!content || sendingRef.current) return;
      sendingRef.current = true;
      setSending(true);
      setError(null);
      appendLocal("用户", content);

      let reply = "";
      try {
        if (demo) {
          reply = DEMO_DEFINITION_REPLY;
        } else {
          setStreamText("");
          for await (const ev of definitionChatStream(projectId, content)) {
            if (ev.type === "text") {
              reply += String(ev.text ?? "");
              setStreamText(reply);
            } else if (ev.type === "error") {
              reply += `${reply ? "\n" : ""}【错误】${String(ev.message ?? "未知错误")}`;
              setStreamText(reply);
            }
          }
        }
      } catch (err: unknown) {
        reply += `${reply ? "\n" : ""}【错误】${errText(err)}`;
      }
      setStreamText(null);
      appendLocal("系统", reply || "【错误】未收到回复内容");
      sendingRef.current = false;
      setSending(false);
    },
    [appendLocal, demo, projectId],
  );

  /** 打开：拉定义状态；对话为空则自动发引导语（见 GUIDE_MESSAGE 注释） */
  useEffect(() => {
    if (!open) {
      guidedRef.current = null;
      return;
    }
    let alive = true;
    setView("chat");
    setResult(null);
    setError(null);
    setStreamText(null);
    setDraft("");

    if (demo) {
      setMessages(DEMO_DEFINITION_MESSAGES.map((m) => ({ ...m })));
      setLoading(false);
      return () => {
        alive = false;
      };
    }

    setLoading(true);
    api
      .getDefinition(projectId)
      .then((state) => {
        if (!alive) return;
        setMessages(state.messages);
        setLoading(false);
        if (state.messages.length === 0 && guidedRef.current !== projectId) {
          guidedRef.current = projectId;
          void send(GUIDE_MESSAGE);
        }
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setLoading(false);
        setError(errText(err));
      });
    return () => {
      alive = false;
    };
  }, [open, demo, projectId, send]);

  /** Esc 关闭（aria-modal 弹窗的基本键盘契约）+ 关闭后把焦点还给触发元素 */
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      returnFocusRef.current?.focus?.();
    };
    /* 只跟 open 走：onClose 每次渲染都可能换身份，进依赖会让焦点反复跳 */
  }, [open]);

  /* 打开时聚焦输入框；回到对话视图也聚焦 */
  useEffect(() => {
    if (open && view === "chat") inputRef.current?.focus();
  }, [open, view]);

  /* 新消息 / 流式增量后滚到底部 */
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streamText, view, loading]);

  const autoGrow = (el: HTMLTextAreaElement): void => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
  };

  const submitDraft = (): void => {
    const text = draft.trim();
    if (!text || sendingRef.current) return;
    setDraft("");
    if (inputRef.current) inputRef.current.style.height = "";
    void send(text);
  };

  /** 「整理成定义」：这是唯一写表入口（用户显式动作，不自动改表） */
  const consolidate = useCallback(async () => {
    if (sendingRef.current || consolidating) return;
    setConsolidating(true);
    setError(null);
    try {
      const r = demo ? demoDefinitionConsolidation() : await api.consolidateDefinition(projectId);
      setResult(r);
      setView("result");
      /* 整理失败要说出来：以前只收 text、把模型的 error 事件丢掉，
         表现成"点了整理、表1-1 一片空白、也没任何提示"，用户只能猜（故障清单 #63） */
      if (r.error) setError(`整理失败：${r.error}`);
      onConsolidated?.(r.rows);
    } catch (err: unknown) {
      setError(errText(err));
    } finally {
      setConsolidating(false);
    }
  }, [consolidating, demo, onConsolidated, projectId]);

  if (!open) return null;

  const busy = sending || consolidating;
  const hasDefinition = (result?.rows.length ?? 0) > 0;

  const renderMessage = (m: ApiDefinitionMessage): React.ReactNode => {
    /* 自动开场白是系统替用户发的（落库仍是用户角色，模型上下文才接得上）：
       界面上必须标出来，不能让用户以为"我没打过这句话"。 */
    const isGuide = m.role === "用户" && m.content === GUIDE_MESSAGE;
    return (
      <div key={m.id} className={`msg ${m.role === "用户" ? "u" : "ai"}`}>
        <div className="bub">{isGuide ? `（系统引导）${m.content}` : m.content}</div>
        <div className="msg-meta">{isGuide ? "系统自动发出 · " : ""}{fmtTime(m.created_at)}</div>
      </div>
    );
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="definition-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="场景定义"
      >
        {/* 顶部：场景名 + 一句说明 + 关闭 */}
        <div className="definition-h">
          <div>
            <h2>{scenarioName}</h2>
            <p>把场景聊清楚就好，不用填表；说不准的地方先放着也可以</p>
          </div>
          <button
            className="btn"
            type="button"
            aria-label="关闭场景定义对话"
            onClick={onClose}
          >
            关闭
          </button>
        </div>

        <div className="definition-b">
          {view === "chat" ? (
            <div className="definition-stream" ref={streamRef} role="log" aria-live="polite">
              {loading ? <div className="loading-strip" role="status" aria-label="加载中" /> : null}
              {!loading && messages.length === 0 ? (
                <p className="conv-hint">还没有对话——说一句你对这个场景的想法就能开始</p>
              ) : null}
              {messages.map((m) => renderMessage(m))}
              {streamText !== null
                ? renderMessage({
                    id: "streaming",
                    role: "系统",
                    content: streamText || "正在思考…",
                    created_at: nowIso(),
                  })
                : null}
              {sending ? (
                <p className="definition-status-line" role="status">
                  模型正在回复…
                </p>
              ) : null}
            </div>
          ) : (
            <div className="definition-result">
              {hasDefinition ? (
                <p className="definition-summary" role="status">
                  已按这段对话整理成表1-1：更新 <strong>{result?.updated ?? 0}</strong> 项，跳过{" "}
                  <strong>{result?.skipped ?? 0}</strong> 项
                  {(result?.skipped ?? 0) > 0
                    ? "（你已确认过的行不会被覆盖）"
                    : "（说不准的项留空或写「待定」都可以）"}
                </p>
              ) : (
                <p className="definition-summary" role="status">
                  这段对话还没有可整理成表1-1 的内容——再聊几句你的场景，或直接在第 1 步表格里手工补充
                  （补充不齐也不影响往下走）
                </p>
              )}
              {result?.postcheck ? (
                <p className="definition-postcheck" role="status">
                  生成后自检（真实吗 · 客观吗 · 有价值吗）：检{" "}
                  <strong>{result.postcheck.checked}</strong> 项，自动改正{" "}
                  <strong>{result.postcheck.fixed}</strong> 项
                  {result.postcheck.downgraded > 0
                    ? `，${result.postcheck.downgraded} 项因出处无法定位按实降为「无法核实」`
                    : ""}
                </p>
              ) : null}
              {(result?.open_questions?.length ?? 0) > 0 ? (
                <p className="definition-open-warning" role="status">
                  还有 {result?.open_questions?.length} 个关键问题没回答：现在关闭也能继续，但后续调研只能按行业通例展开，结论可能偏泛。建议先补一句再整理。
                </p>
              ) : null}
              <AlignmentTable
                items={result?.alignment ?? []}
                questions={result?.open_questions ?? []}
                hint="这里只对「核心项 + 系统实际填了/推断的项」——标「推断」的是系统替你猜的，说得准就改，说不准就先留「待定」，后续研究补全；不影响往下走"
                questionsTitle="还不知道、但后面研究能补上的"
              />
            </div>
          )}

          {error ? <p className="modal-error">{error}</p> : null}
        </div>

        {/* 底部：对话视图 = 输入框 + 发送 + 整理成定义；结果视图 = 继续聊 / 完成 */}
        <div className="definition-f">
          {view === "chat" ? (
            <>
              <textarea
                ref={inputRef}
                className="definition-ta"
                rows={2}
                aria-label="场景定义对话输入"
                placeholder="说你对这个场景的理解（Enter 发送 / Shift+Enter 换行）"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  autoGrow(e.target);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submitDraft();
                  }
                }}
              />
              <button
                className="btn"
                type="button"
                disabled={busy || draft.trim().length === 0}
                onClick={submitDraft}
              >
                {sending ? "发送中…" : "发送"}
              </button>
              <button
                className="btn primary"
                type="button"
                disabled={busy}
                onClick={() => void consolidate()}
              >
                {consolidating ? "整理中…" : "整理成定义"}
              </button>
            </>
          ) : (
            <>
              <span className="definition-spacer" />
              <button className="btn" type="button" onClick={() => setView("chat")}>
                继续聊
              </button>
              <button
                className="btn primary"
                type="button"
                onClick={() => {
                  onFinished?.();
                  onClose();
                }}
              >
                完成，回到第 1 步
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
