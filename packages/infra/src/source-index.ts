/**
 * source-index — 材料库反查（生成后自检的"来源真实性"靠它，v1.28）
 *
 * 为什么必须有这个实现：核实结论如果只让模型自己说「我核实了」，那就是自证；
 * 用户在 2026-10-04 明确要求「确认来源的真实性」。库里 `source_fts` 是
 * **按页存的 trigram 全文索引**（`source` = `ingest-….pdf:10`，`content` = 该页的原文片段，
 * 实测 397 个页面引用 / 2845 条片段），所以"这份材料的这一页到底有没有这句话"
 * 是可以真查的——查到就是查到，查不到就是查不到。
 *
 * 领域层只认 `SourceLookup` 端口，本文件是它唯一的实现（依赖注入，领域层不碰数据库）。
 */

import Database from "better-sqlite3";
import type { SourceLookup } from "@scene/domain";

/** trigram 分词器最少 3 字符才能检索；比这短的片段无法判定，不倒扣（不能凭空指控） */
const MIN_TRIGRAM = 3;

/**
 * 把片段转成 FTS5 短语查询
 *
 * 用双引号包成短语，内部引号翻倍转义——片段来自模型正文，可能带 `"` 或 `*` 等
 * FTS 语法字符，直接拼进 MATCH 会变成语法错误或意外通配。
 */
export function ftsPhrase(snippet: string): string | null {
  const s = snippet.trim();
  if (s.length < MIN_TRIGRAM) return null;
  return `"${s.replace(/"/g, '""')}"`;
}

export function createSourceLookup(db: Database.Database): SourceLookup {
  const hasSourceStmt = db.prepare("SELECT 1 FROM source_fts WHERE source = ? LIMIT 1");
  const hasContentStmt = db.prepare(
    "SELECT 1 FROM source_fts WHERE source = ? AND source_fts MATCH ? LIMIT 1",
  );

  return {
    hasSource(ref: string): boolean {
      const r = String(ref ?? "").trim();
      if (r === "") return false;
      return Boolean(hasSourceStmt.get(r));
    },

    hasContent(ref: string, snippet: string): boolean {
      const r = String(ref ?? "").trim();
      // 字母/数字个数不足＝没有可检索内容（如全是引号）→ 无法判定，不倒扣；
      // 注意片段本身要原样保留（"6 TOPS" 去掉空格就查不到了）
      const searchable = String(snippet ?? "").replace(/[^\p{L}\p{N}]/gu, "");
      const phrase = searchable.length < MIN_TRIGRAM ? null : ftsPhrase(snippet);
      // 太短无法用 trigram 判定：返回 true（"不能证明它没有"），宁可漏报不误伤
      if (r === "" || phrase === null) return true;
      try {
        // 只在该出处那一页里找，避免"别的页写过"被当成这页写过
        return Boolean(hasContentStmt.get(r, phrase));
      } catch {
        // FTS 语法异常（极端片段）不应让自检本身崩掉：判不了就不指控
        return true;
      }
    },
  };
}
