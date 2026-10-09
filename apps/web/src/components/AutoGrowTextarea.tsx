/**
 * @scene/web — 自适应高度的多行编辑器（中栏表格与右栏条目共用）
 *
 * 为什么不是 `<input>`：单行输入框既显示不了换行，行高也永远只有一行；
 * 右栏补充说明里有整段文字（依据 / 现在谁在供 / 路径关键节点），塞进 input 等于
 * 只看得见开头的几个字。
 *
 * 为什么不用固定 `rows={4}`：内容短时留白、内容长时框内滚动，都不叫"行高随内容"。
 * 这里按 scrollHeight 长高，并用 ResizeObserver 跟随宽度变化重算
 * （栏被拖窄 → 换行变多 → 行随之变高）。
 *
 * 两种提交口径：
 *  - `commitOnBlur`（中栏表格）：输入只改本地草稿，失焦才回调——避免逐键落库；
 *  - 缺省（右栏条目）：每次输入即回调，与短字段的 inline 编辑同一手感。
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface AutoGrowTextareaProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  /** 追加在基础样式之后（默认 `cell-input cell-input--multi`） */
  className?: string;
  /** true = 失焦才回调（草稿留在本地）；缺省 = 每次输入都回调 */
  commitOnBlur?: boolean;
}

export const AutoGrowTextarea: React.FC<AutoGrowTextareaProps> = ({
  value,
  onChange,
  ariaLabel,
  placeholder = "",
  className,
  commitOnBlur = false,
}) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(value);
  /** 外部值变化就同步草稿（渲染期同步，避免先闪一帧旧值） */
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }

  const grow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // scrollHeight 只算到 padding，不含边框；border-box 下要补回边框高度，
    // 否则设置出来的框比内容矮 2px，最后一行被 overflow:hidden 悄悄裁掉
    const border = el.offsetHeight - el.clientHeight;
    const next = `${el.scrollHeight + border}px`;
    if (el.style.height !== next) el.style.height = next;
  }, []);

  useLayoutEffect(() => {
    grow();
  }, [grow, value, draft]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => grow());
    ro.observe(el);
    return () => ro.disconnect();
  }, [grow]);

  return (
    <textarea
      ref={ref}
      className={className ?? "cell-input cell-input--multi"}
      rows={1}
      value={commitOnBlur ? draft : value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => {
        if (commitOnBlur) setDraft(e.target.value);
        else onChange(e.target.value);
      }}
      onBlur={() => {
        if (commitOnBlur && draft !== value) onChange(draft);
      }}
    />
  );
};
