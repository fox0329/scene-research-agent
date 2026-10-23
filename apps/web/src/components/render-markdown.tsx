/**
 * @scene/web — 极简 Markdown 渲染（中栏交付物报告复用）
 *
 * 只支持标题/列表/引用/表格，避免引入第三方依赖。`tables: false` 是旧右栏
 * 窄栏专用；v2 右栏已不再渲染报告全文，但保留该选项给未来窄容器复用。
 */

import React from "react";
import { splitBold } from "./md-inline";
import { SceneTable } from "./SceneTable";

/**
 * 渲染选项
 *
 * `tables: false` 时，多列表格降为「字段：值 · 字段：值」的条目行，适合窄容器；
 * 中栏（交付物正文，`DeliveryPanel`）保持默认，表格照旧排。
 */
export interface RenderMarkdownOptions {
  tables?: boolean;
  /**
   * 表格用中栏那套组件渲染（带列宽拖拽），用于**交付物报告**
   *
   * 走 `SceneTable` 而不是另写一套：列宽适配/拖拽/双击复位/本地留存全复用。
   * `storageKeyPrefix` 按"场景 + 交付物口径"给，避免两份报告互相串宽度。
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
