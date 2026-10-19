/**
 * WebEnrichDialog — 联网补证（变更表 #216 / #219）
 *
 * 交互约束（design-system v1.9 + AGENTS §四）：
 *   - 视觉值一律走已有 class / Token，不硬编码颜色与尺寸
 *   - 异步必须有三态：加载 / 空 / 降级（引擎不可用时说清原因，不是空白）
 *   - 可点元素一律 `<button type="button">`
 *
 * 产品约束（调研文档 §6.5）：检索结果**先入库才允许引用**。
 * 所以这里只显示"已入库几份、判了什么权威性"，不把搜索结果当答案展示。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  enrichWeb,
  getWebEngine,
  listWebSources,
  type ApiWebEngine,
  type ApiWebEnrichReport,
  type ApiWebSource,
} from "../api";

/** 把用户输入的一坨文本拆成条目（换行/逗号/顿号都当分隔） */
function splitList(raw: string): string[] {
  return raw
    .split(/[\n,，、;；]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 权威性的徽标语气 */
function authorityTone(a: string | undefined): string {
  if (a === "T1") return "success";
  if (a === "T2") return "success";
  if (a === "T3") return "warning";
  return "warning";
}

export const WebEnrichDialog: React.FC<{
  onClose: () => void;
  /** 入库成功后通知外边刷新资料库 */
  onStored?: () => void;
}> = ({ onClose, onStored }) => {
  const [engine, setEngine] = useState<ApiWebEngine | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [topics, setTopics] = useState("");
  const [sites, setSites] = useState("");
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<ApiWebEnrichReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<ApiWebSource[]>([]);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  /** 读引擎状态 + 已入库来源 */
  const refresh = useCallback(async () => {
    try {
      const [e, s] = await Promise.all([getWebEngine(), listWebSources(20)]);
      setEngine(e);
      setSources(s.sources);
      setEngineError(null);
    } catch (err) {
      setEngineError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 打开即把焦点放到关闭按钮；Esc 可关；**Tab 圈在对话框内**。
   *
   * 焦点圈闭不是可选项：实测不圈时 Tab 会跑到对话框背后的资料库列表上
   * （「云枢智控·工业边缘产品线…」），键盘用户会迷失在当前上下文之外。
   * 设计系统 §4.1「键盘可达」要求 Tab 在组内循环。
   */
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        onClose();
        return;
      }
      if (ev.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const items = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      // 正向：在最后一项继续 Tab → 回到第一项；反向同理
      if (!ev.shiftKey && active === last) {
        ev.preventDefault();
        first.focus();
      } else if (ev.shiftKey && (active === first || !root.contains(active))) {
        ev.preventDefault();
        last.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleRun = async () => {
    const t = splitList(topics);
    if (t.length === 0) {
      setError("先写要补什么主题（例如：网络安全等级保护 定级要求）");
      return;
    }
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      const r = await enrichWeb({
        topics: t,
        preferSites: splitList(sites),
        perTopic: 5,
      });
      setReport(r);
      if (r.usable > 0) {
        onStored?.();
        void refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-label="联网补证">
        <div className="modal-h">
          <span>联网补证</span>
          <button ref={closeRef} className="btn btn-sm" type="button" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="modal-b">
          {/* ── 引擎状态：能不能联网必须说清，不能留白 ── */}
          {engineError ? (
            <p className="modal-error">读不到联网状态：{engineError}</p>
          ) : engine === null ? (
            <p className="muted">正在检查联网能力…</p>
          ) : (
            <p className="muted">
              <span className={`badge ${engine.canSearch ? "success" : "warning"}`}>
                {engine.canSearch ? `可联网（${engine.engine}）` : "不能联网"}
              </span>{" "}
              {engine.detail}
            </p>
          )}

          <label className="brief-field">
            <span className="brief-label">要补什么（一行一个主题）</span>
            <textarea
              className="brief-input"
              rows={3}
              value={topics}
              onChange={(e) => setTopics(e.target.value)}
              placeholder={"网络安全等级保护 定级要求\n工业互联网 平台 架构 标准"}
            />
          </label>

          <label className="brief-field">
            <span className="brief-label">只在哪些站里找（可空；填了更权威）</span>
            <input
              className="brief-input"
              value={sites}
              onChange={(e) => setSites(e.target.value)}
              placeholder="gov.cn, openstd.samr.gov.cn"
            />
          </label>

          <p className="muted">
            抓到的内容会先切成可定位的块再入库，之后引用要写「快照名:块号」，
            检查时会真去那一块核对。
          </p>

          <button
            className="btn"
            type="button"
            disabled={running || engine?.canSearch === false}
            onClick={() => void handleRun()}
          >
            {running ? "正在检索与抓取…" : "开始补证"}
          </button>

          {error ? <p className="modal-error">{error}</p> : null}

          {/* ── 结果三态：加载 / 空 / 有内容 ── */}
          {running ? <p className="muted">联网检索中，通常十几秒；超时会自动降级不阻塞。</p> : null}

          {report && report.performed === false ? (
            <p className="muted">
              <span className="badge warning">没有联网</span> {report.skipReason}
            </p>
          ) : null}

          {report && report.performed ? (
            <div>
              <p className="muted">
                检索 {report.searches} 次、抓 {report.fetches} 页 → 入库{" "}
                <strong>{report.usable}</strong> 份可用
                {report.filtered > 0 ? `，挡掉 ${report.filtered} 条不可靠来源` : ""}
              </p>
              {report.items.length === 0 ? (
                <p className="muted">没有拿到可入库的内容（可能关键词太窄或网络不通）。</p>
              ) : (
                <ul className="enrich-list">
                  {report.items.map((it) => (
                    <li key={it.url}>
                      <span className={`badge ${it.ok ? authorityTone(it.authority) : "warning"}`}>
                        {it.ok ? `${it.authority ?? "-"} ${it.category ?? ""}` : "未入库"}
                      </span>{" "}
                      <span className="enrich-url" title={it.url}>
                        {it.url}
                      </span>
                      {it.ok ? (
                        <span className="muted">
                          {" "}
                          · {it.blockCount} 块 · 引用 <code>{it.citation}</code>
                        </span>
                      ) : (
                        <span className="muted"> · {it.error}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {/* ── 已入库的网页来源 ── */}
          <details>
            <summary className="muted">已入库的网页来源（{sources.length}）</summary>
            {sources.length === 0 ? (
              <p className="muted">还没有网页来源。补证成功后这里会列出来。</p>
            ) : (
              <ul className="enrich-list">
                {sources.map((s) => (
                  <li key={s.id}>
                    <span className={`badge ${authorityTone(s.authority)}`}>
                      {s.authority} {s.category}
                    </span>{" "}
                    <span className="enrich-url" title={s.url}>
                      {s.title || s.domain}
                    </span>
                    <span className="muted"> · {s.blockCount} 块</span>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </div>
      </div>
    </div>
  );
};
