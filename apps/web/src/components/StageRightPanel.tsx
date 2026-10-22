/**
 * @scene/web — 右栏：阶段总结（条目形式，无表格）
 *
 * v2.10（用户定调 2026-10-21）：「右栏的补充说明不需要，删除。保留阶段总结，
 * 阶段总结只列：调研信息来源的源地址，用户可以打开自己看；还有关于这个阶段的
 * 几个重点的结论性的提醒或建议」。于是右栏只有一个「阶段总结」，正文只两块：
 *  ① **调研信息来源**：可点开的 http(s) 源地址（去重、最多 20 条，新窗口打开）
 *  ② **结论提醒**：领域层 `buildStageBrief` 由表内真实字段 + 固定规则推导，
 *     不调模型、不编造、判不出就只给一句兜底，不凑数
 *
 * v2.11（用户定调 2026-10-21）：「阶段总结全文删除，不需要」——全文不再进右栏，
 * 也不再提供下载入口；它仍由服务端为**交付物装配**生成（`collectStageSummaries`）。
 *
 * v2.12（用户定调 2026-10-22）：右栏标题自成一条 48px 栏（与左栏「方案助手」同字号、
 * 同底边线）；「重新生成」删除——阶段总结只是记录，没有需要重新生成的东西。
 *
 * 同时删除（补充说明 Tab 的连带物，全仓已无消费者）：
 *  - 补充说明条目与核实编辑（`supplements` / `onSupplementChange`）
 *  - 中栏 ↔ 右栏行联动（`activeRowId` / `activeRowOrigin` / `onRowFocus`）；
 *    中栏自己的当前行高亮仍在（由各面板本地 state 控制），与右栏无关
 *  - 双 Tab 条：只剩一个 Tab 就不再画 tablist（画了也没有第二个可切）
 *
 * `renderMarkdown` 仍是中栏报告正文的渲染器（`DeliveryPanel` 复用），本文件保留。
 */

import React, { useEffect, useRef, useState } from "react";
import { splitBold } from "./md-inline";
import { SceneTable } from "./SceneTable";
import type { StageSnapshot } from "./stage-snapshot";

export interface StageRightPanelProps {
  snapshot: StageSnapshot | null;
  /** 联真模式；演示模式显示说明文案 */
  live: boolean;
}

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

/** 行内粗体：报告正文用 `**结论**` 起句，不解析就会把星号原样显示给用户 */
function inline(text: string): React.ReactNode {
  const parts = splitBold(text);
  if (parts.length === 1 && !parts[0]!.bold) return text;
  return parts.map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : p.text));
}

/** 极简 Markdown 渲染（标题/列表/引用/表格）——避免引入第三方依赖 */
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

export const StageRightPanel: React.FC<StageRightPanelProps> = ({ snapshot, live }) => {
  /**
   * 本步没有来源时自动补查一次（每挂载一次只自动跑一次，失败/空结果不再自动重试）
   *
   * 为什么自动：调研是 2026-10-21 才前置到分析里的，之前生成的步骤（如「理解商业」）
   * 库里一条 research_source 都没有，用户看到右栏空白会以为功能没做。
   * 为什么只一次：检索有成本、免注册通道会反爬，反复自动跑只会更糟；重试交给按钮。
   */
  const [researching, setResearching] = useState(false);
  const [researchNote, setResearchNote] = useState<string | null>(null);
  const autoRan = useRef(false);
  const onResearch = snapshot?.onResearch;
  const sourceCount = snapshot?.brief?.sources?.length ?? 0;
  const summaryLoading = snapshot?.summaryLoading ?? false;

  useEffect(() => {
    if (!onResearch || autoRan.current) return;
    if (summaryLoading) return;
    if (!snapshot?.brief) return;
    if (sourceCount > 0) return;
    autoRan.current = true;
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
  }, [onResearch, summaryLoading, snapshot?.brief, sourceCount]);

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

  const { brief } = snapshot;
  const sources = brief?.sources ?? [];
  const advice = brief?.advice ?? [];

  const handleResearch = () => {
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

  return (
    <>
      <div className="det-h summary-hd">
        <h3>阶段总结</h3>
      </div>
      <div className="det-body">
        <section className="det-sec">
          {/* ① 调研信息来源：只收能点开的 http(s) 地址（文件名:页码这类点不开，留在全文里） */}
          <h5 className="summary-sub">调研信息来源</h5>
          {sources.length > 0 ? (
            <ul className="summary-sources">
              {sources.map((s, i) => (
                <li key={`${s.url || s.file}-${i}`}>
                  {s.url !== "" ? (
                    <a href={s.url} target="_blank" rel="noreferrer" title={s.url}>
                      {s.label}
                    </a>
                  ) : (
                    <span className="summary-source-file" title={s.file}>
                      {s.label}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : researching ? (
            <p className="summary-empty" role="status">
              正在补查本步联网调研（检索 + 验真，最多 60 秒）…
            </p>
          ) : (
            <div className="summary-empty">
              <p>
                本步没有取得可打开的来源（这一步在调研功能上线前生成，或检索不可用），相关结论按「未知」处理。
              </p>
              {onResearch ? (
                <button type="button" className="btn-mini" onClick={handleResearch}>
                  补跑本步调研
                </button>
              ) : null}
            </div>
          )}
          {researchNote ? (
            <p className="brief-hint" role="status">
              {researchNote}
            </p>
          ) : null}

          {/* ② 结论提醒：领域层确定性规则推导，判不出时只有一句兜底 */}
          <h5 className="summary-sub">结论提醒</h5>
          {brief === null ? (
            <p className="summary-empty">要点加载中…</p>
          ) : (
            <ul className="summary-advice">
              {advice.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          )}

        </section>
      </div>
    </>
  );
};
