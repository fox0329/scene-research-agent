/**
 * @scene/web — 右栏：阶段面板（条目形式，无表格）
 *
 * 对应 04 §4.2 的分工（**只讲当前步骤，不整理整个过程**——用户定调 v2.9）：
 *  - **Tab ① 补充说明**：中栏**当前表**放不下的说明类信息（长文本全文、来源、
 *    证据等级、权威性、周期……）——这些列**只存在于右栏**，中栏看不到
 *  - **Tab ② 步骤总结**：本步表集的五段骨架 Markdown（可导出）
 *
 * 变更表 #149（用户定调）：「右栏不要有表格，因为右栏本身宽度就有限，用表格根本很难看
 * 内容。用条目的形式就行」「没有价值的删除，一定要确保右栏的内容对于用户理解中栏的
 * 输出有价值」。于是右栏收敛为：
 *  - 一律**条目形式**：一条信息 = 一个条目标签 + 若干行「字段名 → 值」；
 *    长文本用可自动增高的多行编辑器，正文看得见、改得动（旧版塞进单行 input，全文只在
 *    `title` 悬浮里）
 *  - 删掉与流程轴/中栏/Tab② 重复或失效的内容：页头「第 n/7 步」、完整度裸数字条、
 *    两份交付物名与说明、生成前提（引用的确认动作已取消）、导出文件名规则与口号、
 *    装配原料的逐步名与状态、固定口径套话与自检过程留痕
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

import React, { useEffect, useMemo, useRef, useState } from "react";
import { enumValues, middleColumns, tableDef } from "@scene/contract";
import { AutoGrowTextarea } from "./AutoGrowTextarea";
import { FoldSection } from "./FoldSection";
import { splitBold } from "./md-inline";
import { SceneTable } from "./SceneTable";
import { SourceReference } from "./SourceReference";
import type { StageSnapshot } from "./stage-snapshot";
import { plainText } from "./text-display";

export interface StageRightPanelProps {
  snapshot: StageSnapshot | null;
  /** 联真模式；演示模式显示说明文案 */
  live: boolean;
}

type Tab = "supplement" | "summary";

/**
 * 渲染选项
 *
 * `tables: false` 是**右栏专用**：右栏只有 240–480 宽，多列表格会把每列挤到几十像素，
 * 内容根本读不下去（用户定调 #149）——管道表降为「字段：值 · 字段：值」的条目行。
 * 中栏（交付物正文，`DeliveryPanel`）保持默认，表格照旧排。
 */
export interface RenderMarkdownOptions {
  tables?: boolean;
  /**
   * 表格用中栏那套组件渲染（带列宽拖拽），用于**交付物报告**
   *
   * 用户定调 2026-10-09：「交付物阶段生成的报告里面的表格，也应该和其他表格一样可以自由地
   * 调整列宽」。走 `SceneTable` 而不是另写一套：列宽适配/拖拽/双击复位/本地留存全复用，
   * 行为与中栏一致。`storageKeyPrefix` 按"场景 + 交付物口径"给，避免两份报告互相串宽度。
   * 右栏阶段总结不启用（窄栏里拖宽没意义，用户已确认只改报告）。
   */
  resizableTables?: { storageKeyPrefix: string };
}

/** 极简 Markdown 渲染（标题/列表/引用/表格）——避免引入第三方依赖 */
/** 行内粗体：报告正文用 `**结论**` 起句，不解析就会把星号原样显示给用户 */
function inline(text: string): React.ReactNode {
  const parts = splitBold(text);
  if (parts.length === 1 && !parts[0]!.bold) return text;
  return parts.map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : p.text));
}

/** 一行的主标识：该表中栏列里第一个非空值（右栏条目与核实段共用同一取法） */
function rowLabel(tableCode: string, row: Record<string, unknown>): string {
  const def = tableDef(tableCode);
  const mid = def ? middleColumns(def) : [];
  for (const c of mid) {
    const v = String(row[c.key] ?? "").trim();
    if (v !== "") return v;
  }
  return "(未命名条目)";
}

/** 单元格值 → 展示文本（多值列按「、」连起来，与中栏同一口径） */
function cellText(v: unknown): string {
  return Array.isArray(v) ? v.join("、") : String(v ?? "");
}

export function renderMarkdown(
  md: string,
  options: RenderMarkdownOptions = {},
): React.ReactNode {
  const renderTables = options.tables ?? true;
  /** 报告里第几张表：列宽留存键要按**表序**稳定，不能用 out.length（它会随正文长度变） */
  let tableSeq = 0;
  const lines = md.split("\n");
  const out: React.ReactNode[] = [];
  let list: string[] = [];
  let table: string[][] = [];

  const flushList = (): void => {
    if (list.length === 0) return;
    out.push(
      <ul key={`ul-${out.length}`} className="md-ul">
        {list.map((t, i) => (
          <li key={i}>{inline(t)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  const flushTable = (): void => {
    if (table.length === 0) return;
    const [head, ...body] = table;
    // 右栏不排表格：一行一条，把表头折进每个值前面（表头本身 + 0 行的极端情况也照此处理）
    if (!renderTables) {
      for (const r of body.length > 0 ? body : [head]) {
        const pairs = r
          .map((c, i) => (c === "" ? "" : `${head[i] ?? ""}：${c}`))
          .filter((s) => s !== "");
        if (pairs.length > 0) out.push(<p key={`tb-${out.length}`}>{inline(pairs.join(" · "))}</p>);
      }
      table = [];
      return;
    }
    if (options.resizableTables) {
      const seq = tableSeq++;
      const colKeys = head.map((_, i) => `c${i}`);
      out.push(
        <SceneTable
          key={`tb-${out.length}`}
          columns={head.map((c, i) => ({
            key: colKeys[i]!,
            label: c,
            render: (v: unknown) => inline(String(v ?? "")),
          }))}
          data={body.map((r) => Object.fromEntries(colKeys.map((k, i) => [k, r[i] ?? ""])))}
          storageKey={`${options.resizableTables.storageKeyPrefix}:t${seq}`}
          tableClassName="schema-table md-table"
        />,
      );
      table = [];
      return;
    }
    out.push(
      <table key={`tb-${out.length}`} className="schema-table md-table">
        <thead>
          <tr>{head.map((c, i) => <th key={i}>{inline(c)}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>
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

    if (line.startsWith("### ")) out.push(<h4 key={out.length}>{inline(line.slice(4))}</h4>);
    else if (line.startsWith("## ")) out.push(<h3 key={out.length}>{inline(line.slice(3))}</h3>);
    else if (line.startsWith("# ")) out.push(<h2 key={out.length}>{inline(line.slice(2))}</h2>);
    else if (line.startsWith("> "))
      out.push(<blockquote key={out.length}>{inline(line.slice(2))}</blockquote>);
    else if (line.trim() === "" || line.trim() === "---") continue;
    else out.push(<p key={out.length}>{inline(line)}</p>);
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

  /**
   * 核实（v1.27）：每条信息准确吗·客观吗·为什么
   *
   * 为什么不与补充说明并排：右栏只有 240–480 宽，并排会挤成几十像素一列；
   * 核实说明是长文本，纵向一条一条排才读得下去——它也是这份产物最该被看见的内容。
   */
  const verifyRows = useMemo(() => {
    if (!snapshot) return [];
    const mine = snapshot.activeTable
      ? snapshot.rows.filter((r) => r.table_code === snapshot.activeTable)
      : snapshot.rows;
    return mine.map((r) => {
      const verdict = String((r.row as Record<string, unknown>)["verification_verdict"] ?? "").trim();
      const text = String((r.row as Record<string, unknown>)["verification"] ?? "");
      return {
        id: r.id,
        tableCode: r.table_code,
        label: rowLabel(r.table_code, r.row as Record<string, unknown>),
        verdict,
        text,
      };
    });
  }, [snapshot]);

  const bodyRef = useRef<HTMLDivElement>(null);
  /** 有没有对应的右栏条目：没有就落阶段总结（第 1 步、交付物步） */
  const hasSupplement = (snapshot?.supplements.length ?? 0) > 0;
  const activeTab: Tab = hasSupplement ? tab : "summary";
  const activeRowId = snapshot?.activeRowId ?? null;
  const activeRowOrigin = snapshot?.activeRowOrigin ?? null;

  /**
   * 中栏点了某一行 → 把右栏里**同一个 rowId** 的条目滚进可视（变更表 #150）
   *
   * 三条防抖口径：
   *  - 只有 `origin === "mid"` 才滚：右栏自己发起的联动不回滚自己（它本来就在视野里）；
   *  - 依赖只有「当前行 + 发起方 + 当前 Tab」：同一行反复上报（在同一行内换字段）不重跑，
   *    所以不会把用户刚滚开的右栏硬拉回来；
   *  - `block: "nearest"`：只在条目不在可视区时才动，绝不居中，右栏不会跳来跳去。
   * 用户自己滚右栏不改任何状态（不监听 scroll），因此不会反过来改中栏的选中行。
   */
  useEffect(() => {
    if (activeTab !== "supplement" || activeRowOrigin !== "mid" || !activeRowId) return;
    const root = bodyRef.current;
    if (!root) return;
    const target = Array.from(root.querySelectorAll<HTMLElement>("[data-row-id]")).find(
      (el) => el.dataset["rowId"] === activeRowId,
    );
    target?.scrollIntoView({ block: "nearest" });
  }, [activeTab, activeRowId, activeRowOrigin]);

  // 首帧（快照还没冒泡上来）不渲染占位块：闪一下的指引没有价值，联真态给一句极短状态即可
  if (!snapshot) {
    return (
      <div className="det-body">
        {live ? (
          <p className="brief-hint" role="status">
            加载中…
          </p>
        ) : null}
      </div>
    );
  }

  const { supplements } = snapshot;

  const emptyMsg = "本步还没有产出——做完本步分析后这里会生成本步总结";
  const full = snapshot.summary ?? "";
  const preview = summarizeMarkdown(full);
  const fullLength = plainText(full).replace(/\s/gu, "").length;

  return (
    <>
      <div className="det-tabs" role="tablist">
        {hasSupplement ? (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "supplement"}
            className={`det-tab${activeTab === "supplement" ? " active" : ""}`}
            onClick={() => setTab("supplement")}
          >
            补充说明
          </button>
        ) : null}
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "summary"}
          className={`det-tab${activeTab === "summary" ? " active" : ""}`}
          onClick={() => setTab("summary")}
        >
          阶段总结
        </button>
      </div>

      <div className="det-body" ref={bodyRef}>
        {activeTab === "supplement" ? (
          <>
            {/* 中栏表格的补充说明列：一条信息一条目，字段名 → 值纵排（窄栏不排表格） */}
            {supplements.map((s) => (
              <section className="det-sec" key={s.tableCode}>
                <h4>
                  {s.tableCode} {s.tableName}
                  <span className="det-sec-sub">补充说明</span>
                </h4>
                <div className="supp-list">
                  {s.rows.map((r) => {
                    const label = rowLabel(s.tableCode, r.row);
                    return (
                      <div
                        className={`supp-item${r.id === activeRowId ? " supp-item--active" : ""}`}
                        key={r.id}
                        /* 联动靠 rowId 与中栏那一行对上（变更表 #150） */
                        data-row-id={r.id}
                        /* `onFocus` 走 focusin：条目里任一字段（值编辑器）获得焦点即算"看这一条"。
                           不加 onClick——可点的交互面就是字段本身，点字段必然聚焦，键盘 Tab 同样成立 */
                        onFocus={() => snapshot.onRowFocus(r.id, "right")}
                      >
                        <div className="supp-label">{label}</div>
                        <div className="supp-fields">
                          {s.columns.map((c) => {
                            const text = cellText(r.row[c.key]);
                            const fieldLabel = `${label} · ${c.label}`;
                            return (
                              <div className="supp-field" key={c.key}>
                                <span className="supp-field-name">{c.label}</span>
                                {/* 值一律用可增高的多行编辑器：右栏窄，单行 input 只能看到开头几个字
                                    （旧版全文只塞在 title 悬浮里）；也不按字数在 input/textarea 之间切换——
                                    输入途中换控件会丢焦点，长出来的那一瞬间用户就断在半个词上 */}
                                <AutoGrowTextarea
                                  className="cell-input cell-input--multi supp-value"
                                  value={text}
                                  placeholder="—"
                                  ariaLabel={fieldLabel}
                                  onChange={(v) => snapshot.onSupplementChange(r.id, c.key, v)}
                                />
                                {/* 来源旁边给「看原文」（变更表 #179）：出处是引用痕迹，
                                    用户要能点开核对——材料库全文索引里查那一句，取到什么显示什么 */}
                                {c.key === "source" ? <SourceReference source={text} /> : null}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}

            {/* 核实：结论 + 准确·客观·为什么（长文本，纵向排） */}
            {verifyRows.length > 0 ? (
              <section className="det-sec">
                <h4>
                  核实
                  <span className="det-sec-sub">这条准确吗 · 客观吗 · 为什么</span>
                </h4>
                <div className="verify-list">
                  {verifyRows.map((r) => (
                    <div
                      className={`verify-item${r.id === activeRowId ? " verify-item--active" : ""}`}
                      key={r.id}
                      data-row-id={r.id}
                      /* 同一行的核实条与补充说明同源高亮：在中栏点到哪一行，两边一起亮 */
                      onFocus={() => snapshot.onRowFocus(r.id, "right")}
                    >
                      <div className="verify-head">
                        <span className="verify-label" title={r.label}>
                          {r.label}
                        </span>
                        <select
                          className={`cell-input verify-verdict${
                            r.verdict === "无法核实" || r.verdict === "有反证" ? " warn" : ""
                          }`}
                          value={r.verdict}
                          aria-label="核实结论"
                          onChange={(e) =>
                            snapshot.onSupplementChange(r.id, "verification_verdict", e.target.value)
                          }
                        >
                          <option value="">（未核）</option>
                          {enumValues("verification_verdict").map((v) => (
                            <option key={v} value={v}>
                              {v}
                            </option>
                          ))}
                        </select>
                      </div>
                      <AutoGrowTextarea
                        className="cell-input cell-input--multi verify-text"
                        value={r.text}
                        placeholder="准确：对得上哪份材料的哪一处、能否复算；客观：事实还是推断、谁的口径、有无利益相关方；为什么：凭什么采信、哪里不确定"
                        ariaLabel={`${r.label} · 核实说明`}
                        onChange={(v) => snapshot.onSupplementChange(r.id, "verification", v)}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        ) : (
          <section className="det-sec">
            <div className="summary-head">
              <h4>本步总结文档</h4>
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
            {snapshot.rows.length === 0 && !snapshot.summary ? (
              <div className="empty-state">
                <div className="empty-state-title">本步还没有产出</div>
                <div className="empty-state-desc">{emptyMsg}</div>
              </div>
            ) : !snapshot.summary ? (
              <div className="empty-state">
                <div className="empty-state-title">尚未生成本步总结</div>
                <div className="empty-state-desc">
                  点击「重新生成」按五段骨架生成本步内容：信息摘要 / 关键信息清单 /
                  说明与方法口径 / 核实结论 / 待补齐信息。只讲这一步，不讲整个过程。
                </div>
              </div>
            ) : (
              <FoldSection
                title="本步总结"
                summary={preview || "（总结只有标题，点开看全文）"}
                expandLabel={`展开全文（约 ${fullLength} 字）`}
              >
                {/* 右栏只有 240–480 宽：总结里的管道表也按条目排，不排表格（#149） */}
                <div className="md-body">
                  {renderMarkdown(snapshot.summary, { tables: false })}
                </div>
              </FoldSection>
            )}
          </section>
        )}
      </div>
    </>
  );
};
