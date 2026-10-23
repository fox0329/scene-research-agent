/**
 * @scene/web — 右栏：产物唯一会话（v2）
 *
 * 产品定调（变更表 #295）：
 *   1. 左栏不动，仍然围绕场景；
 *   2. 右栏以「某个阶段的某个产物」为最小单元；
 *   3. 一个产物只有一条会话，不提供会话列表/新建/切换；
 *   4. 历史完整保留，压缩只发生在模型上下文里。
 *
 * 结构：产物头 → 信息来源/备注页签 → 上区（可拖拽）→ 水平分隔条 → 会话区 → 底部输入。
 * 上区与下区的比例存 localStorage；鼠标拖动、方向键、Home/End、双击复位都可用。
 *
 * 注意：这里不重复计算来源/提醒。来源与结论提醒仍来自各阶段面板冒泡的
 * `StageSnapshot.brief`；本组件只负责展示与会话。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FLOW_LAST_STEP, flowStep } from "@scene/contract";
import {
  api,
  artifactMessageStream,
  type ApiArtifactRef,
  type ApiArtifactThread,
  type ApiDefinitionMessage,
} from "../api";
import type { StageSnapshot } from "./stage-snapshot";

export interface ArtifactRightPanelProps {
  snapshot: StageSnapshot | null;
  /** 联真模式；演示模式不请求后端，只显示本地说明 */
  live: boolean;
  /** 场景 id（产物会话按场景隔离）；缺省时只能看来源/备注 */
  projectId?: string;
}

/** 上区默认/最小/最大高度百分比 */
const DEFAULT_TOP_PCT = 30;
const MIN_TOP_PCT = 22;
const MAX_TOP_PCT = 58;
const TOP_PCT_KEY = "scene.artifact.split.v1";
/** 输入框最大高度 */
const TEXTAREA_MAX_HEIGHT = 100;

function clampPct(value: number): number {
  return Math.min(MAX_TOP_PCT, Math.max(MIN_TOP_PCT, Math.round(value)));
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

function saveTopPct(value: number): void {
  try {
    localStorage.setItem(TOP_PCT_KEY, String(value));
  } catch {
    /* 隐私模式写不进去不影响拖动 */
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  // 跨天历史只给 HH:mm 会分不清是哪天
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 来源域名：同名标题靠它区分（只用于显示，解析失败就不显示） */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return "";
  }
}

/** 产物 key：切换产物时用它判断是否要重取会话 */
function artifactKey(artifact: NonNullable<StageSnapshot["artifact"]>): string {
  return `${artifact.step}:${artifact.type}:${artifact.id}`;
}

export const ArtifactRightPanel: React.FC<ArtifactRightPanelProps> = ({
  snapshot,
  live,
  projectId,
}) => {
  const artifact = snapshot?.artifact;
  const [tab, setTab] = useState<"sources" | "notes">("sources");
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const [topPct, setTopPct] = useState(readTopPct);
  const stackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const sourceCount = snapshot?.brief?.sources?.length ?? 0;
  const adviceCount = snapshot?.brief?.advice?.length ?? 0;

  useEffect(() => {
    setTab("sources");
  }, [artifact ? artifactKey(artifact) : ""]);

  /** 拖动：按分隔条在容器中的位置换算百分比，限制 22%–58% */
  const beginDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const stack = stackRef.current;
    if (!stack) return;
    event.preventDefault();
    draggingRef.current = true;
    const rect = stack.getBoundingClientRect();
    const move = (e: PointerEvent): void => {
      if (!draggingRef.current) return;
      const pct = ((e.clientY - rect.top) / rect.height) * 100;
      setTopPct(clampPct(pct));
    };
    const up = (): void => {
      draggingRef.current = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  useEffect(() => {
    saveTopPct(topPct);
  }, [topPct]);

  /** Tab 组：方向键在来源/备注之间切换并把焦点带过去（design-spec §4.1） */
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    // 用 ref 读当前值：连续按键时闭包里的 tab 可能还没提交
    const next = tabRef.current === "sources" ? "notes" : "sources";
    setTab(next);
    requestAnimationFrame(() => document.getElementById(`artifact-tab-${next}`)?.focus());
  };

  const onSplitterKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const delta = event.key === "ArrowUp" ? -4 : 4;
      setTopPct((pct) => clampPct(pct + delta));
    } else if (event.key === "Home") {
      event.preventDefault();
      setTopPct(MIN_TOP_PCT);
    } else if (event.key === "End") {
      event.preventDefault();
      setTopPct(MAX_TOP_PCT);
    }
  };

  const stageLabel = artifact
    ? artifact.step === FLOW_LAST_STEP
      ? "交付物"
      : `阶段 ${flowStep(artifact.step).stage ?? ""} · ${flowStep(artifact.step).title}`
    : "阶段总结";

  return (
    <>
      <div className="artifact-head">
        <div className="artifact-eyebrow">{stageLabel}</div>
        <div className="artifact-title-row">
          <h2 className="artifact-title" title={artifact?.title}>
            {artifact?.title ?? "阶段总结"}
          </h2>
        </div>
        <div className="artifact-meta">
          <span className={`dot ${sourceCount > 0 ? "success" : "muted"}`} />
          <span>
            {sourceCount > 0 ? `${sourceCount} 条来源` : "暂无来源"}
            {" · "}
            {adviceCount > 0 ? `${adviceCount} 条提醒` : "暂无提醒"}
          </span>
        </div>
      </div>

      <div className="detail-tabs artifact-tabs" role="tablist" aria-label="产物信息">
        <button
          type="button"
          role="tab"
          id="artifact-tab-sources"
          aria-controls="artifact-tabpanel"
          aria-selected={tab === "sources"}
          className={`detail-tab${tab === "sources" ? " active" : ""}`}
          onClick={() => setTab("sources")}
          onKeyDown={onTabKeyDown}
        >
          信息来源 <span className="badge">{sourceCount}</span>
        </button>
        <button
          type="button"
          role="tab"
          id="artifact-tab-notes"
          aria-controls="artifact-tabpanel"
          aria-selected={tab === "notes"}
          className={`detail-tab${tab === "notes" ? " active" : ""}`}
          onClick={() => setTab("notes")}
          onKeyDown={onTabKeyDown}
        >
          备注 <span className="badge">{adviceCount}</span>
        </button>
      </div>

      <div
        className="artifact-stack"
        ref={stackRef}
        style={{ gridTemplateRows: `${topPct}% var(--size-8) minmax(0, 1fr)` }}
      >
        <div
          className="artifact-inspector"
          id="artifact-tabpanel"
          role="tabpanel"
          aria-labelledby={tab === "sources" ? "artifact-tab-sources" : "artifact-tab-notes"}
        >
          {tab === "sources" ? (
            <SourcesPane snapshot={snapshot} />
          ) : (
            <NotesPane snapshot={snapshot} />
          )}
        </div>

        <div
          className="artifact-split"
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整信息来源与会话区高度"
          aria-valuemin={MIN_TOP_PCT}
          aria-valuemax={MAX_TOP_PCT}
          aria-valuenow={topPct}
          tabIndex={0}
          onPointerDown={beginDrag}
          onDoubleClick={() => setTopPct(DEFAULT_TOP_PCT)}
          onKeyDown={onSplitterKeyDown}
        >
          <span className="artifact-split-grip" aria-hidden="true" />
        </div>

        <ThreadPane
          live={live}
          projectId={projectId}
          artifact={artifact}
          sourceCount={sourceCount}
        />
      </div>
    </>
  );
};

/** 上区 · 信息来源：只列能打开的 http(s) 地址；文件名来源按文本显示 */
const SourcesPane: React.FC<{ snapshot: StageSnapshot | null }> = ({ snapshot }) => {
  const [researching, setResearching] = useState(false);
  const [researchNote, setResearchNote] = useState<string | null>(null);
  const autoRan = useRef<string | null>(null);
  const sources = snapshot?.brief?.sources ?? [];
  const onResearch = snapshot?.onResearch;
  const artifact = snapshot?.artifact;
  // 调研是「步」级能力：同一张表切子块不重复补查，换步才重新判断
  const key = artifact ? String(artifact.step) : "none";

  useEffect(() => {
    if (!onResearch || snapshot?.summaryLoading || !snapshot?.brief) return;
    if (sources.length > 0) return;
    if (autoRan.current === key) return;
    autoRan.current = key;
    setResearching(true);
    setResearchNote(null);
    onResearch()
      .then((r) =>
        setResearchNote(
          r.saved > 0
            ? `已补查本步调研，取得 ${r.saved} 条来源`
            : "已补查，但没有取得可用来源（检索不可用或结果无关）",
        ),
      )
      .catch(() => setResearchNote("补查失败，可点「补跑本步调研」重试"))
      .finally(() => setResearching(false));
  }, [onResearch, snapshot?.summaryLoading, snapshot?.brief, sources.length, key]);

  const handleResearch = (): void => {
    if (!onResearch || researching) return;
    setResearching(true);
    setResearchNote(null);
    onResearch()
      .then((r) =>
        setResearchNote(
          r.saved > 0
            ? `已补查本步调研，取得 ${r.saved} 条来源`
            : "已补查，但没有取得可用来源（检索不可用或结果无关）",
        ),
      )
      .catch(() => setResearchNote("补查失败，可重试"))
      .finally(() => setResearching(false));
  };

  if (!snapshot?.brief) {
    return (
      <p className="summary-empty">
        {snapshot?.summaryLoading ? "来源加载中…" : "来源暂不可用，切回中栏重试"}
      </p>
    );
  }

  if (sources.length > 0) {
    return (
      <section className="artifact-sec">
        <div className="artifact-sec-title">来源 · {sources.length} 条</div>
        <ul className="summary-sources">
          {sources.map((s, i) => (
            <li key={`${s.url || s.file}-${i}`}>
              {s.url !== "" ? (
                <>
                  <a href={s.url} target="_blank" rel="noreferrer" title={s.url}>
                    {s.label}
                  </a>
                  <span className="summary-src-host">{hostOf(s.url)}</span>
                </>
              ) : (
                <span className="summary-source-file" title={s.file}>
                  {s.label}
                </span>
              )}
            </li>
          ))}
        </ul>
        {researchNote ? <p className="brief-hint" role="status">{researchNote}</p> : null}
      </section>
    );
  }

  return (
    <section className="artifact-sec">
      <div className="artifact-sec-title">来源 · 0 条</div>
      <div className="summary-empty">
        <p>本步没有取得可打开的来源，相关结论按「未知」处理。</p>
        <p className="summary-empty-reason">
          {snapshot?.brief?.researchFailure
            ? `上次联网调研失败：${snapshot.brief.researchFailure}`
            : "这一步在调研功能上线前生成，或检索不可用。"}
        </p>
        {onResearch ? (
          <button type="button" className="btn-mini" onClick={handleResearch} disabled={researching}>
            {researching ? "正在补查…" : "补跑本步调研"}
          </button>
        ) : null}
        {researchNote ? <p className="brief-hint" role="status">{researchNote}</p> : null}
      </div>
    </section>
  );
};

/** 上区 · 备注：本步结论提醒（确定性推导），没有就明确空态 */
const NotesPane: React.FC<{ snapshot: StageSnapshot | null }> = ({ snapshot }) => {
  const brief = snapshot?.brief;
  const advice = brief?.advice ?? [];
  if (!brief) return <p className="summary-empty">备注加载中…</p>;
  return (
    <section className="artifact-sec">
      <div className="artifact-sec-title">备注 · {advice.length} 条</div>
      <div className="note-caption">
        <span className="badge">AI 结论</span> 由当前产物字段与来源确定性推导
      </div>
      {brief.note ? <p className="summary-note">{brief.note}</p> : null}
      {advice.length > 0 ? (
        <ul className="summary-advice">
          {advice.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      ) : (
        <p className="summary-empty">本步还没有可下结论的提醒；门槛、赢面与能力匹配表产出后会出现。</p>
      )}
    </section>
  );
};

/** 下区 · 唯一会话 */
const ThreadPane: React.FC<{
  live: boolean;
  projectId?: string;
  artifact: StageSnapshot["artifact"];
  sourceCount: number;
}> = ({ live, projectId, artifact, sourceCount }) => {
  const [thread, setThread] = useState<ApiArtifactThread | null>(null);
  const [messages, setMessages] = useState<ApiDefinitionMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [streamText, setStreamText] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const seqRef = useRef(0);
  /** 用户是否贴在底部：贴底才自动跟随，向上翻历史时不抢滚动条 */
  const pinnedRef = useRef(true);
  /** 当前产物 key：发送跨产物时用它丢弃旧流的回调 */
  const keyRef = useRef("");

  const ref = useMemo<ApiArtifactRef | null>(
    () =>
      artifact
        ? {
            step: artifact.step,
            type: artifact.type,
            id: artifact.id,
            block: artifact.block ?? null,
            title: artifact.title,
          }
        : null,
    [artifact],
  );

  /** 稳定键：父级每次刷新都会新建 artifact 对象，只按 step/type/id 判断是否换产物 */
  const refKey = artifact ? artifactKey(artifact) : "";
  keyRef.current = refKey;

  const appendLocal = useCallback((role: "用户" | "系统", content: string) => {
    seqRef.current += 1;
    setMessages((prev) => [
      ...prev,
      {
        id: `local-${seqRef.current}`,
        role,
        content,
        created_at: new Date().toISOString(),
      },
    ]);
  }, []);

  /** 产物切换：重取该产物的唯一会话；打开不创建 */
  useEffect(() => {
    if (!live || !projectId || !ref) {
      setThread(null);
      setMessages([]);
      setLoading(false);
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    setSummaryOpen(false);
    setStreamText(null);
    // 切产物时先清掉上一件产物的消息，避免加载失败还把旧对话显示在新产物下
    setThread(null);
    setMessages([]);
    api
      .artifactThread(projectId, ref)
      .then((state) => {
        if (!alive) return;
        setThread(state);
        setMessages(state.messages);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(errText(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // ref 的对象身份每次快照刷新都会变；用稳定 key 避免发消息期间把本地流冲掉
  }, [live, projectId, refKey, retry]); // eslint-disable-line react-hooks/exhaustive-deps

  /*
   * 产物内容变化（编辑表格、重算总结）时只刷新元数据（stale / 摘要），
   * 不重载 messages——否则会把正在看的滚动位置和本地流式回复冲掉。
   * 父级每次快照刷新都会新建 artifact 对象，正好作为「产物内容变了」的信号。
   */
  useEffect(() => {
    if (!live || !projectId || !ref) return;
    let alive = true;
    api
      .artifactThread(projectId, ref)
      .then((state) => {
        if (alive) setThread(state);
      })
      .catch(() => {
        /* 元数据刷新失败不打断阅读，下次发送/切换会重试 */
      });
    return () => {
      alive = false;
    };
    // ref 的对象身份每次快照刷新都会变，故意只依赖 artifact；稳定 key 的加载在上面
  }, [artifact, live, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  /* 新消息 / 流式增量后滚到底部；双 rAF 等网格布局算完，否则第一次打开停在半截 */
  useEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    let outer = 0;
    let inner = 0;
    outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [messages.length, streamText, loading, summaryOpen]);

  const onThreadScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const submit = useCallback(async () => {
    const content = draft.trim();
    if (!content || sending || !ref || !projectId || !live) return;
    setDraft("");
    if (inputRef.current) inputRef.current.style.height = "";
    const sentKey = refKey;
    setSending(true);
    setError(null);
    setSummaryOpen(false);
    pinnedRef.current = true;
    appendLocal("用户", content);
    setStreamText("");
    let reply = "";
    let failed = false;
    try {
      for await (const ev of artifactMessageStream(projectId, ref, content)) {
        if (keyRef.current !== sentKey) {
          setSending(false);
          return;
        }
        if (ev.type === "text") {
          reply += String(ev.text ?? "");
          setStreamText(reply);
        } else if (ev.type === "error") {
          failed = true;
          reply += `${reply ? "\n" : ""}【错误】${String(ev.message ?? "未知错误")}`;
          setStreamText(reply);
        }
      }
    } catch (err: unknown) {
      failed = true;
      reply += `${reply ? "\n" : ""}【错误】${errText(err)}`;
    }
    setSending(false);
    if (keyRef.current !== sentKey) return;
    setStreamText(null);
    appendLocal("系统", reply || "【错误】未收到回复内容");
    /* 成功后刷新一次元数据（压缩摘要 / 产物是否更新）；失败保留本地错误，不冲掉 */
    if (!failed && projectId && ref) {
      try {
        const state = await api.artifactThread(projectId, ref);
        setThread(state);
        setMessages(state.messages);
      } catch {
        /* 刷新失败不影响刚才看到的消息 */
      }
    }
  }, [appendLocal, draft, live, projectId, ref, sending]);

  const autoGrow = (el: HTMLTextAreaElement): void => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const stageTitle = artifact ? flowStep(artifact.step).title : "产物";

  return (
    <div className="thread-pane">
      <div className="thread-head">
        <div className="thread-title-row">
          <strong>{artifact?.title ?? "产物会话"}</strong>
          <span className="badge">{live ? "唯一会话" : "演示模式"}</span>
        </div>
        <div className="thread-sub">
          <span>{artifact?.block ? `当前子块 · ${artifact.block}` : stageTitle}</span>
          <span>·</span>
          <span>历史完整保留</span>
          {sourceCount > 0 ? (
            <>
              <span>·</span>
              <span>{sourceCount} 条来源</span>
            </>
          ) : null}
        </div>
      </div>

      <div
        className="thread-scroll"
        ref={scrollRef}
        role="log"
        aria-live="polite"
        onScroll={onThreadScroll}
      >
        {!live ? (
          <p className="thread-empty">
            演示模式：连上后端后，针对当前产物的追问会保存在这条唯一会话里。
          </p>
        ) : loading ? (
          <div className="loading-strip" role="status" aria-label="加载产物会话" />
        ) : error && messages.length === 0 ? (
          <div className="thread-empty">
            <strong>会话加载失败</strong>
            <p>{error}</p>
            <button
              type="button"
              className="btn-mini"
              onClick={() => setRetry((n) => n + 1)}
            >
              重试
            </button>
          </div>
        ) : (
          <>
            {thread?.stale ? (
              <div className="thread-stale" role="status">
                产物已更新，新消息将基于当前内容；历史消息仍保留。
              </div>
            ) : null}
            {thread?.compacted ? (
              <>
                <div className="compress-divider">
                  <span>上下文已压缩 · 保留 {thread.kept} 条关键记忆</span>
                  <button
                    type="button"
                    className="candidate-action"
                    aria-expanded={summaryOpen}
                    onClick={() => setSummaryOpen((v) => !v)}
                  >
                    {summaryOpen ? "收起摘要" : "查看摘要"}
                  </button>
                </div>
                {summaryOpen ? (
                  <div className="summary-card">
                    <strong>压缩后保留的记忆</strong>
                    <p>{thread.summary || "（暂无可展示的摘要）"}</p>
                  </div>
                ) : null}
              </>
            ) : null}
            {messages.length === 0 && streamText === null ? (
              <div className="thread-empty">
                <strong>还没有对话</strong>
                <p>
                  针对「{artifact?.title ?? "当前产物"}」问依据、改法或缺口；第一次发送才会创建这条会话。
                </p>
              </div>
            ) : null}
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
            {streamText !== null ? (
              <MessageBubble
                message={{
                  id: "streaming",
                  role: "系统",
                  content: streamText || "正在思考…",
                  created_at: new Date().toISOString(),
                }}
              />
            ) : null}
            {sending ? (
              <p className="thread-status" role="status">
                模型正在回复…
              </p>
            ) : null}
            {error && messages.length > 0 ? (
              <p className="thread-status error" role="status">
                {error}
              </p>
            ) : null}
          </>
        )}
      </div>

      <div className="thread-composer">
        <div className="thread-input-shell">
          <div className="thread-input-top">
            <span className="thread-input-scope">产物 · {artifact?.title ?? "未选择"}</span>
          </div>
          <textarea
            ref={inputRef}
            className="thread-textarea"
            rows={2}
            value={draft}
            disabled={!live || loading || sending || !artifact}
            placeholder={live ? "针对这个产物追问，或输入「补一条来源」…" : "演示模式不可发送"}
            onChange={(e) => setDraft(e.target.value)}
            onInput={(e) => autoGrow(e.currentTarget)}
            onKeyDown={onKeyDown}
            aria-label="针对当前产物发送消息"
          />
          <div className="thread-input-actions">
            <span className="thread-input-hint">Enter 发送 · Shift+Enter 换行</span>
            <button
              type="button"
              className="btn primary sm"
              disabled={!live || sending || !draft.trim() || !artifact}
              onClick={() => void submit()}
            >
              {sending ? "发送中…" : "发送"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/** 消息气泡：用户靠右、助手靠左；保留换行 */
const MessageBubble: React.FC<{ message: ApiDefinitionMessage }> = ({ message }) => {
  const isUser = message.role === "用户";
  return (
    <div className={`thread-msg${isUser ? " user" : ""}`}>
      <div className="thread-msg-meta">
        {fmtTime(message.created_at)} · {isUser ? "你" : "助手"}
      </div>
      <div className="thread-msg-bubble">{message.content}</div>
    </div>
  );
};
