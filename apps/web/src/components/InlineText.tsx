/**
 * @scene/web — 行内粗体文本（对话气泡 / 对照表共用）
 *
 * 模型回复里常用 `**商用后厨**` 表示强调；对话气泡原先直接渲染字符串，
 * 用户会看到未解析的星号。这里复用报告同一套 `splitBold`，只把成对的
 * `**...**` 变成 `<strong>`，落单星号原样保留（不吞正文）。
 */
import React from "react";
import { splitBold } from "./md-inline";

export const InlineText: React.FC<{ text: string }> = ({ text }) => {
  const parts = splitBold(text);
  if (parts.length === 1 && !parts[0]!.bold) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        part.bold ? <strong key={i}>{part.text}</strong> : <React.Fragment key={i}>{part.text}</React.Fragment>,
      )}
    </>
  );
};
