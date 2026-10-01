/**
 * @scene/web — 右栏：阶段面板（双 Tab）
 *
 * 对应 04 §4.2 的分工：
 *  - **Tab ① 补充说明**：中栏表格放不下的说明类信息（来源、证据级、权威性等
 *    右栏补充列）+ **确认清单**（L1 场景本体 / L2 环节与角色 / L3 待确认）
 *  - **Tab ② 阶段总结**：六段骨架 Markdown（可导出）
 *
 * 两条铁律的落点：
 *  - **不出现建议档位与"通过/不通过"**：右栏只呈现信息与缺口
 *  - 缺口清单只说明"还缺什么"，不阻断（用户决定先补还是先往下走）
 */

import React, { useState } from "react";
import type { StageSnapshot } from "./stage-snapshot";
import { CONFIRM_STATE_BADGE } from "./stage-snapshot";

export interface StageRightPanelProps {
  snapshot: StageSnapshot | null;
  /** 联真模式；演示模式显示说明文案 */
  live: boolean;
}

type Tab = "supplement" | "summary";

/** 极简 Markdown 渲染（标题/列表/引用/表格分隔）——避免引入第三方依赖 */
export function renderMarkdown(md: string): React.ReactNode {
  const lines = md.split("\n");
  const out: React.ReactNode[] = [];
  let list: string[] = [];
  let table: string[][] = [];

  const flushList = (): void => {
    if (list.length === 0) return;
    out.push(
      <ul key={`ul-${out.length}`} className="md-ul">
        {list.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  const flushTable = (): void => {
    if (table.length === 0) return;
    const [head, ...body] = table;
    out.push(
      <table key={`tb-${out.length}`} className="schema-table md-table">
        <thead>
          <tr>{head.map((c, i) => <th key={i}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>,
    );
    table = [];
  };

  for (const line of lines) {
    const isTableRow = line.trim().startsWith("|") && line.trim().endsWith("|");
    if (isTableRow) {
      const cells = line.trim().slice(1, -1).split("|").map((c) => c.trim());
      // 分隔行（|---|---|）不入表
      if (!cells.every((c) => /^-+$/.test(c.replace(/:/g, "")))) table.push(cells);
      continue;
    }
    flushTable();

    if (line.startsWith("- ")) {
      list.push(line.slice(2));
      continue;
    }
    flushList();

    if (line.startsWith("### ")) out.push(<h4 key={out.length}>{line.slice(4)}</h4>);
    else if (line.startsWith("## ")) out.push(<h3 key={out.length}>{line.slice(3)}</h3>);
    else if (line.startsWith("# ")) out.push(<h2 key={out.length}>{line.slice(2)}</h2>);
    else if (line.startsWith("> ")) out.push(<blockquote key={out.length}>{line.slice(2)}</blockquote>);
    else if (line.trim() === "" || line.trim() === "---") continue;
    else out.push(<p key={out.length}>{line}</p>);
  }
  flushList();
  flushTable();
  return out;
}

export const StageRightPanel: React.FC<StageRightPanelProps> = ({ snapshot, live }) => {
  const [tab, setTab] = useState<Tab>("supplement");

  // 注意顺序：有快照就渲染（演示态也会产生快照，走同一套结构），
  // 只有既无快照又非联真时才显示演示占位——否则演示态会被占位挡住。
  if (!snapshot) {
    if (!live) {
      return (
        <>
          <div className="det-h">
            <h3>阶段信息</h3>
          </div>
          <div className="det-body">
            <div className="empty-state">
              <div className="empty-state-title">演示模式</div>
              <div className="empty-state-desc">
                连接后端后，这里显示中栏表格的补充说明与阶段总结文档。
              </div>
            </div>
          </div>
        </>
      );
    }
    return (
      <>
        <div className="det-h">
          <h3>阶段信息</h3>
        </div>
        <div className="det-body">
          <div className="loading-strip" role="status" aria-label="加载中" />
        </div>
      </>
    );
  }

  const { completeness, checklist, anchor, supplements } = snapshot;
  const pending = checklist.filter((c) => c.state !== "用户确认" && c.state !== "用户修改");

  const anchorContent = (item: string): string =>
    String(anchor.find((a) => a.item === item)?.content ?? "");

  const anchorState = (item: string): string => {
    const row = anchor.find((a) => a.item === item);
    if (!row) return "系统推断";
    const st = String(row.source_type ?? "");
    if (st === "用户确认") return "用户确认";
    if (st === "用户补充") return "用户修改";
    if (st === "AI推断") return "待确认";
    return "系统推断";
  };

  return (
    <>
      <div className="det-h">
        <h3>
          {snapshot.title ?? `阶段 ${snapshot.stage} · ${snapshot.stageLabel}`}
        </h3>
      </div>

      {/* 完整度状态行：只说明"还缺什么"，不给判定 */}
      <div className="completeness-bar">
        <span>
          信息完整度 {completeness?.tablesWithData ?? 0}/{completeness?.expectedTables ?? 0} 张表
          {completeness ? `（${completeness.percent}%）` : ""}
        </span>
        {completeness && completeness.gaps.length > 0 ? (
          <span className="gap-count">缺口 {completeness.gaps.length} 项</span>
        ) : (
          <span className="gap-none">暂无缺口</span>
        )}
      </div>

      <div className="det-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "supplement"}
          className={`det-tab${tab === "supplement" ? " active" : ""}`}
          onClick={() => setTab("supplement")}
        >
          补充说明
          {checklist.length > 0 ? <span className="tab-count">{pending.length}</span> : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "summary"}
          className={`det-tab${tab === "summary" ? " active" : ""}`}
          onClick={() => setTab("summary")}
        >
          阶段总结
        </button>
      </div>

      <div className="det-body">
        {tab === "supplement" ? (
          <>
            {/* 确认清单（L1 来自表1-1 的必确认行） */}
            {checklist.length > 0 ? (
              <section className="det-sec">
                <h4>
                  确认清单 <span className="det-sec-sub">{pending.length} 项待确认</span>
                </h4>
                <ul className="confirm-list">
                  {checklist.map((c) => {
                    const badge = CONFIRM_STATE_BADGE[c.state] ?? CONFIRM_STATE_BADGE["待确认"]!;
                    return (
                      <li key={`${c.layer}-${c.rowKey}`} className="confirm-item">
                        <div className="confirm-main">
                          <span className={`layer-tag layer-${c.layer}`}>{c.layer}</span>
                          <span className="confirm-label">{c.label}</span>
                          <span className={`state-badge state-badge--${badge.tone}`}>{badge.text}</span>
                        </div>
                        {c.layer === "L1" ? (
                          <div className="confirm-actions">
                            <span className="confirm-content" title={anchorContent(c.label)}>
                              {anchorContent(c.label) || "未提供"}
                            </span>
                            <button
                              type="button"
                              className="btn-mini"
                              onClick={() => snapshot.onAnchorAction(c.label, "确认", anchorContent(c.label))}
                            >
                              确认
                            </button>
                            <button
                              type="button"
                              className="btn-mini"
                              onClick={() => {
                                const next = window.prompt(`修改「${c.label}」`, anchorContent(c.label));
                                if (next !== null) snapshot.onAnchorAction(c.label, "修改", next);
                              }}
                            >
                              修改
                            </button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            {/* 中栏表格的补充说明列 */}
            {supplements.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-title">暂无补充说明</div>
                <div className="empty-state-desc">
                  选中中栏的一张表后，这里显示它的来源、证据级、方法口径等说明类信息。
                </div>
              </div>
            ) : (
              supplements.map((s) => (
                <section className="det-sec" key={s.tableCode}>
                  <h4>
                    {s.tableCode} {s.tableName}
                    <span className="det-sec-sub">补充说明</span>
                  </h4>
                  <table className="schema-table supplement-table">
                    <thead>
                      <tr>
                        {s.columns.map((c) => (
                          <th key={c.key}>{c.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {s.rows.map((r) => (
                        <tr key={r.id}>
                          {s.columns.map((c) => {
                            const v = r.row[c.key];
                            const text = Array.isArray(v) ? v.join("、") : String(v ?? "");
                            return (
                              <td key={c.key}>
                                <input
                                  className="cell-input"
                                  value={text}
                                  placeholder="—"
                                  title={text}
                                  onChange={(e) =>
                                    snapshot.onSupplementChange(r.id, c.key, e.target.value)
                                  }
                                />
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ))
            )}

            {/* 缺口清单 */}
            {completeness && completeness.gaps.length > 0 ? (
              <section className="det-sec">
                <h4>
                  信息缺口 <span className="det-sec-sub">不阻断，可先补或先往下走</span>
                </h4>
                <ul className="gap-list">
                  {completeness.gaps.map((g, i) => (
                    <li key={i}>
                      <span className="gap-kind">{g.kind}</span>
                      {g.detail}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : (
          <section className="det-sec">
            <div className="summary-head">
              <h4>阶段总结文档</h4>
              <div className="summary-actions">
                <button
                  type="button"
                  className="btn-mini"
                  onClick={snapshot.onRefreshSummary}
                  disabled={snapshot.summaryLoading}
                >
                  {snapshot.summaryLoading ? "生成中…" : "重新生成"}
                </button>
              </div>
            </div>
            {snapshot.summary ? (
              <div className="md-body">{renderMarkdown(snapshot.summary)}</div>
            ) : (
              <div className="empty-state">
                <div className="empty-state-title">尚未生成阶段总结</div>
                <div className="empty-state-desc">
                  点击「重新生成」按六段骨架生成：信息摘要 / 关键信息清单 / 说明与方法口径 /
                  来源与抽查 / 信息缺口 / 上下游衔接。
                </div>
              </div>
            )}
          </section>
        )}
      </div>

      {/* 锚行状态提示：确认清单的 L1 就是表1-1 的必确认行 */}
      <div className="det-foot">
        <span className="foot-hint">
          L1 场景本体 {anchor.filter((a) => anchorState(a.item) === "用户确认").length} 项已确认
          ｜ 状态由你确认后写入
        </span>
      </div>
    </>
  );
};
