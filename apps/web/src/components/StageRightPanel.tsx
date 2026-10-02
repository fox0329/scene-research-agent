/**
 * @scene/web — 右栏：阶段面板（双 Tab）
 *
 * 对应 04 §4.2 的分工：
 *  - **Tab ① 补充说明**：中栏表格放不下的说明类信息（来源、证据级、权威性等
 *    右栏补充列）
 *  - **Tab ② 阶段总结**：六段骨架 Markdown（可导出）
 *
 * 三条铁律的落点：
 *  - **不出现建议档位与"通过/不通过"**：右栏只呈现信息
 *  - **同一信息不得两栏重复**：表1-1 的进度已在中栏（折叠行/表格）说清，
 *    右栏页脚不再复述一遍（旧版这里重复了「已填 N 项」）
 *  - v1.19 删除的两块（用户定调）：
 *    ① **确认清单**——「用户确认就默认可以了」「不用显示待确认」，逐项表态概念整体取消
 *    ② **缺口清单**——那 9 条缺口里没有一条是用户能回答的（"6 行无来源""未标推断"
 *       是智能体的溯源文书，另几条属于第 2 步才产出的表）。缺口已改为**分属主**，
 *       由智能体自己排补，用户界面不再呈现（见 `@scene/domain` 的 `userGaps`）
 */

import React, { useState } from "react";
import { FoldSection } from "./FoldSection";
import type { StageSnapshot } from "./stage-snapshot";
import { plainText } from "./text-display";

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

/**
 * 阶段总结折叠态口径：首段 + 一句
 *
 * 折叠态只给"读一眼就知道这份总结讲了什么"的量。六段骨架开头常是标题行 +
 * 「场景/产品线/生成时间/信息完整度」这类元信息行，全算进去等于没摘要——
 * 所以只取**正文段落**（跳过标题行与元信息行），最多拼 3 行。
 */
export function summarizeMarkdown(md: string): string {
  const metaFieldRe = /^(场景|产品线|生成时间|信息完整度|阶段|步骤)\s*[:：]/u;
  const parts: string[] = [];
  for (const rawLine of md.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line === "---") continue;
    if (/^#{1,6}\s/u.test(line)) continue; // 标题行：骨架标题不是内容
    const text = line
      .replace(/^>\s*/u, "")
      .replace(/^[-*]\s+/u, "")
      .replace(/\*\*/gu, "")
      .replace(/\|/gu, " ")
      .replace(/\s{2,}/gu, " ")
      .trim();
    if (text === "" || /^-+$/u.test(text.replace(/\s/gu, ""))) continue;
    // 「用户诉求」块：折叠态已被元信息挤满，不在摘要里重复
    if (text.startsWith("用户诉求")) continue;
    // 元信息行（"场景：X ｜ 产品线：Y …"）：折叠态不给，展开后能看到
    if (metaFieldRe.test(text) && (text.match(/[:：]/gu) ?? []).length >= 2) continue;
    parts.push(text);
    if (parts.length >= 3) break;
  }
  return parts.join(" ｜ ");
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

  const { completeness, supplements, rows } = snapshot;

  const emptyMsg = "本步还没有产出——做完本步分析后这里会生成阶段总结";
  const full = snapshot.summary ?? "";
  const preview = summarizeMarkdown(full);
  const fullLength = plainText(full).replace(/\s/gu, "").length;

  return (
    <>
      <div className="det-h">
        <h3>
          {snapshot.title ?? `阶段 ${snapshot.stage} · ${snapshot.stageLabel}`}
        </h3>
      </div>

      {/* 完整度状态行：只说明本阶段表产出的进度，不虚报缺口（缺口已转智能体待办） */}
      {completeness ? (
        <div className="completeness-bar">
          <span>
            信息完整度 {completeness.tablesWithData}/{completeness.expectedTables} 张表（
            {completeness.percent}%）
          </span>
        </div>
      ) : null}

      <div className="det-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "supplement"}
          className={`det-tab${tab === "supplement" ? " active" : ""}`}
          onClick={() => setTab("supplement")}
        >
          补充说明
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
            {/* 本步还没有产出：一句话空态，不渲染六段空骨架 */}
            {rows.length === 0 && !snapshot.summary ? (
              <div className="empty-state">
                <div className="empty-state-title">本步还没有产出</div>
                <div className="empty-state-desc">{emptyMsg}</div>
              </div>
            ) : !snapshot.summary ? (
              <div className="empty-state">
                <div className="empty-state-title">尚未生成阶段总结</div>
                <div className="empty-state-desc">
                  点击「重新生成」按六段骨架生成：信息摘要 / 关键信息清单 / 说明与方法口径 /
                  来源与抽查 / 待补齐信息 / 上下游衔接。
                </div>
              </div>
            ) : (
              <FoldSection
                title="阶段总结"
                summary={preview || "（总结只有标题，点开看全文）"}
                expandLabel={`展开全文（约 ${fullLength} 字）`}
              >
                <div className="md-body">{renderMarkdown(snapshot.summary)}</div>
              </FoldSection>
            )}
          </section>
        )}
      </div>
    </>
  );
};
