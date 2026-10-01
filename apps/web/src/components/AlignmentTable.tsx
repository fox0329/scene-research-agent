/**
 * @scene/web — 对照式结论表（共享件）
 *
 * 以用户原话为基准，逐项标出系统理解属于哪种对齐结论。四态文案与配色**只此一份**：
 *  - 场景定义对话「整理成定义」结果（服务端返回 alignment 数组）
 *  - 其它需要对照系统理解与用户原话的地方（同形状即可复用）
 *
 * 只渲染，不做判定：四态由服务端 / 领域层算出（`alignmentWithBrief` 或定义整理接口）。
 */

import React from "react";

/**
 * 四态徽标文案（单一来源，勿在别处重写）
 *
 * 语气口径（用户定调）：场景定义**允许说不准**——推断项不是"欠账"，
 * 而是"可以留待定、后续行业研究再补全"，因此提示里不出现"必须确认"。
 */
export const ALIGN_LABEL: Record<string, { text: string; hint: string }> = {
  一致: { text: "与你说的一致", hint: "已由你确认/补充" },
  系统补充: { text: "系统从资料补充", hint: "来自材料，你没说过——不对就改" },
  推断: { text: "系统推断", hint: "系统猜的：可以先留「待定」，后续研究会补全" },
  待补充: { text: "待补充", hint: "说不准就先留「待定」" },
};

/** 对照结论的一行（服务端 `ApiDefinitionAlignment` / 领域层 `AlignmentItem` 同形状） */
export interface AlignmentItem {
  rowKey: string;
  label: string;
  content: string;
  alignment: "一致" | "系统补充" | "推断" | "待补充";
  note?: string;
}

export interface AlignmentTableProps {
  items: readonly AlignmentItem[];
  /** 需要用户确认的场景本体问题（可为空） */
  questions?: readonly string[];
  /** 表上方的说明文字（各调用场景措辞不同） */
  hint?: string;
  /** 问题清单小标题 */
  questionsTitle?: string;
}

export const AlignmentTable: React.FC<AlignmentTableProps> = ({
  items,
  questions = [],
  hint,
  questionsTitle = "需要你确认的场景本体问题",
}) => (
  <div className="align-wrap">
    {hint ? <p className="brief-hint">{hint}</p> : null}
    <table className="schema-table align-table">
      <thead>
        <tr>
          <th style={{ width: "28%" }}>项</th>
          <th>系统理解</th>
          <th style={{ width: "23%" }}>对照结论</th>
        </tr>
      </thead>
      <tbody>
        {items.length === 0 ? (
          <tr>
            <td colSpan={3} className="align-empty">
              这段对话还没整理出可对照的项
            </td>
          </tr>
        ) : null}
        {items.map((a) => (
          <tr key={a.rowKey}>
            <td>{a.label}</td>
            <td title={a.content}>{a.content || "（未提供）"}</td>
            <td>
              <span className={`align-badge align-${a.alignment}`}>
                {ALIGN_LABEL[a.alignment]?.text ?? a.alignment}
              </span>
              <span className="align-hint">
                {a.note ?? ALIGN_LABEL[a.alignment]?.hint}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    {questions.length > 0 ? (
      <div className="align-questions">
        <h4>{questionsTitle}</h4>
        <ul>
          {questions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ul>
      </div>
    ) : null}
  </div>
);
