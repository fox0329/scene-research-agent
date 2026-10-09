import React, { useCallback, useState } from "react";
import { api, type ApiSourcePassage } from "../api";

/**
 * 来源原文（变更表 #179）
 *
 * 用户要求原话：「每个阶段查询的信息来源的链接没有显示出来，建议放在右栏，
 * 用户可以点击链接直接看原文，这样更能体现报告来源的真实性」。
 *
 * 三条口径：
 *  - **只在右栏出现**（G-R9：中栏说结果，来源归右栏）——中栏那一格还是只写结论；
 *  - **点开看的是材料里那一句原话**：来源串（`文件名:页码`）去全局全文索引等值取用，
 *    取到什么显示什么，取不到就明说"这条来源没有可核对的材料原文"（不假装查过）；
 *  - **来源里自带 URL 就直跳**：那种来源的原文在网页上，按钮直接变成链接新窗口打开，
 *    不必绕道索引。
 *
 * 形态上只给一个「看原文」按钮 + 展开区，**不重复显示来源串**——来源文字由外层
 * 字段（可编辑的补充说明框）或行详情展示，重复一遍只会把窄栏挤满。
 */

interface Props {
  /** 来源串原文（`文件名:页码`、URL 或「用户输入」这类说明） */
  source: string;
}

const SourceReference: React.FC<Props> = ({ source }) => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passages, setPassages] = useState<ApiSourcePassage[] | null>(null);

  const text = source.trim();
  const inlineUrl = /https?:\/\/[^\s，。；）)"']+/u.exec(text)?.[0] ?? null;

  /**
   * 懒加载：只在用户点开时取（右栏一次挂几十条来源，进面板就全查一遍没有意义）
   *
   * 取过就不再取（`passages !== null` 短路）——同一个来源串的结果是确定性只读数据。
   */
  const toggle = useCallback(async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (passages !== null) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.sourcePassages(text);
      setPassages(res.passages);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [open, passages, text]);

  if (text === "") return null;

  // 来源自带链接：直接给链接（用户要的"点一下就能看原文"）
  if (inlineUrl !== null) {
    return (
      <a
        className="src-ref-btn"
        href={inlineUrl}
        target="_blank"
        rel="noopener noreferrer"
        title="打开来源原文（新窗口）"
      >
        看原文
      </a>
    );
  }

  return (
    <span className="src-ref">
      <button
        className="src-ref-btn"
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        title="看材料库索引里这一条来源的原文"
      >
        {open ? "收起原文" : "看原文"}
      </button>

      {open ? (
        <div className="src-ref-body" role="region" aria-label="来源原文">
          {loading ? <p className="src-ref-hint">正在取原文…</p> : null}
          {error !== null ? <p className="src-ref-hint">取原文失败：{error}</p> : null}
          {!loading && error === null && passages !== null && passages.length === 0 ? (
            <p className="src-ref-hint">
              这条来源没有可核对的材料原文（「用户输入」「行业通例（模型知识）」这类出处不在材料库里）。
            </p>
          ) : null}
          {passages?.map((p) => (
            <blockquote className="src-ref-quote" key={`${p.table_code}-${p.content.slice(0, 24)}`}>
              {p.content}
            </blockquote>
          ))}
        </div>
      ) : null}
    </span>
  );
};

export { SourceReference };
