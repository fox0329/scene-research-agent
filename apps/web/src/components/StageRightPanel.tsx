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
 *
 * 信息密度口径（用户投诉"整个页面大量无效信息"后收紧）：
 *  - 确认清单**不再把整段内容抄一遍**：只给 层级 + 项名 + 状态 + 一行截断内容（≤40 字），
 *    完整内容在中栏表1-1 / 表1-2；超过 8 项时折叠，首屏不超过约 6 行
 *  - 阶段总结**默认收起**：只给首段 + 一句，点「展开全文（约 N 字）」再看
 *  - 完整度 100% 时**不再同时喊"缺口 N 项"**（那是自相矛盾）
 */

import React, { useEffect, useState } from "react";
import { FoldSection } from "./FoldSection";
import {
  CHECKLIST_CLIP,
  CONFIRM_STATE_BADGE,
  checklistContentText,
  type ChecklistViewItem,
  type StageSnapshot,
} from "./stage-snapshot";
import { anchorFoldSummary, anchorSummary } from "./definition-progress";
import { plainText } from "./text-display";

export interface StageRightPanelProps {
  snapshot: StageSnapshot | null;
  /** 联真模式；演示模式显示说明文案 */
  live: boolean;
}

type Tab = "supplement" | "summary";

/** 确认清单超长时的折叠阈值（首屏目标 ≤ 6 行） */
const CHECKLIST_COLLAPSE_OVER = 8;
/** 折叠态最多显示几行 */
const CHECKLIST_FOLDED_ROWS = 6;

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
  /** 确认清单折叠（超过阈值才出现该开关；同样只在组件 state，不持久化） */
  const [checklistFolded, setChecklistFolded] = useState(true);
  const stageKey = snapshot ? `${snapshot.stage}#${snapshot.title ?? ""}` : "";
  useEffect(() => {
    setChecklistFolded(true);
  }, [stageKey]);

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

  const { completeness, checklist, anchor, supplements, rows } = snapshot;
  const pending = checklist.filter((c) => c.state !== "用户确认" && c.state !== "用户修改");
  /* 表态口径按返回数组派生（核心项 ∪ 模型填了/推断的项），不假设行数 */
  const l1Items = checklist.filter((c) => c.layer === "L1");
  const l1Total = l1Items.length;
  const l1Done = l1Items.filter((c) => c.state === "用户确认" || c.state === "用户修改").length;
  /** 表1-1 折叠摘要口径（与中栏折叠行同一句；快照没给就按锚行现算） */
  const anchorStats = snapshot.anchorSummary ?? anchorSummary(anchor);

  const emptyMsg = "本步还没有产出——做完本步分析后这里会生成阶段总结";
  const full = snapshot.summary ?? "";
  const preview = summarizeMarkdown(full);
  const fullLength = plainText(full).replace(/\s/gu, "").length;

  const foldChecklist = checklist.length > CHECKLIST_COLLAPSE_OVER;
  const shownChecklist = foldChecklist && checklistFolded
    ? checklist.slice(0, CHECKLIST_FOLDED_ROWS)
    : checklist;
  const hiddenChecklist = checklist.length - shownChecklist.length;

  const anchorContent = (item: string): string =>
    String(anchor.find((a) => a.item === item)?.content ?? "");

  /** 清单一行：层级 + 项名 + 状态 + 截断内容（完整内容看中栏） */
  const renderChecklistItem = (c: ChecklistViewItem): React.ReactElement => {
    const badge = CONFIRM_STATE_BADGE[c.state] ?? CONFIRM_STATE_BADGE["待确认"]!;
    const content = checklistContentText(c.tableCode, c.rowKey, c.content ?? "");
    return (
      <li key={`${c.layer}-${c.rowKey}`} className="confirm-item">
        {/* 第一行：层级 + 项名 + 状态（项名只此一处，不再把整段内容抄一遍） */}
        <div className="confirm-main">
          <span className={`layer-tag layer-${c.layer}`}>{c.layer}</span>
          <span className="confirm-label">{c.label}</span>
          <span className={`state-badge state-badge--${badge.tone}`}>{badge.text}</span>
        </div>
        {/* 第二行：一行截断内容 + 就地表态（完整内容在中栏表格） */}
        <div className="confirm-actions">
          <span className="confirm-content" title={plainText(c.content ?? "") || "完整内容看中栏表格"}>
            {content}
          </span>
          {c.layer === "L1" ? (
            <>
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
            </>
          ) : null}
        </div>
      </li>
    );
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
        {/* 100% 时不再同时喊"缺口 N 项"——那是自相矛盾（缺口清单在同 Tab 下方） */}
        {completeness && completeness.percent >= 100 ? (
          <span className="gap-none">信息齐全</span>
        ) : completeness && completeness.gaps.length > 0 ? (
          <span className="gap-count">{completeness.gaps.length} 项缺口（不阻断）</span>
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
            {/* 确认清单（L1 选行由领域层给：核心项 ∪ 模型实际填了/推断的项） */}
            {checklist.length > 0 ? (
              <section className="det-sec">
                <h4>
                  确认清单 <span className="det-sec-sub">{pending.length} 项待你表态</span>
                </h4>
                <p className="brief-hint">
                  只列需要你表态的项（核心项 + 系统实际填了/推断的项）；内容只给一行（≤{CHECKLIST_CLIP} 字），
                  完整内容与就地编辑在中栏表1-1 / 表1-2。其余项可以先留「待定」，后续研究补全，不阻断往下走。
                </p>
                <ul className="confirm-list">
                  {shownChecklist.map(renderChecklistItem)}
                </ul>
                {foldChecklist ? (
                  <p className="fold-line">
                    <button
                      type="button"
                      className="btn-mini fold-toggle"
                      aria-expanded={!checklistFolded}
                      onClick={() => setChecklistFolded((v) => !v)}
                    >
                      {checklistFolded
                        ? `展开剩余 ${hiddenChecklist} 项表态`
                        : `收起，只看需要我表态的 ${Math.min(CHECKLIST_FOLDED_ROWS, checklist.length)} 项`}
                    </button>
                    {checklistFolded ? (
                      <span className="fold-hint">
                        环节级表态在中栏表1-2，逐项可就地确认
                      </span>
                    ) : null}
                  </p>
                ) : null}
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
                  来源与抽查 / 信息缺口 / 上下游衔接。
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

      {/* 锚行状态提示：确认清单的 L1 就是「需要你表态的场景本体项」 */}
      <div className="det-foot">
        <span className="foot-hint">
          {anchorFoldSummary(anchorStats)}
          ｜ 场景本体 {l1Done}/{l1Total} 项已表态
          ｜ 其余可留「待定」，状态由你表态后写入
        </span>
      </div>
    </>
  );
};
