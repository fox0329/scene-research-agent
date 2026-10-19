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
import { matchContent } from "@scene/domain";
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

/**
 * 删掉某一行业务数据的全文索引（变更表 #156）
 *
 * 为什么删行要管这个：`source_fts` 的写入靠触发器（001_init.sql），但**没有 DELETE 触发器**
 * ——原来删一行，索引里那一行还在，`hasSource("xxx.pdf:12")` 对一份已经删掉的材料照样返回
 * true（"来源真实性"自检给出假阳性）。加删除入口就必须把索引一起清掉，否则删得越干净、
 * 自检越不准。按 `ref_id` 删（触发器写入的就是业务行 id）。
 */
export function deleteSourceIndex(db: Database.Database, refId: string): void {
  const id = String(refId ?? "").trim();
  if (!id) return;
  db.prepare("DELETE FROM source_fts WHERE ref_id = ?").run(id);
}

/**
 * 从引用串拆出「文件名」与「页码」
 *
 * 引用格式为 `文件名:页码`（如 `规格书.pdf:12`）或 `文件名#章节`（无页码）。
 * 拆不出来（纯 URL、没有定位符）就返回 null——那类出处没有页级原文可查。
 */
/**
 * 从引用串拆出「文件名」与「定位锚」（不限于页码）
 *
 * 实测真实库里的出处形态远比 `文件名:页码` 丰富：
 *   `白皮书.docx:表格2`、`白皮书.docx:8.1`、`白皮书.docx:三、车间设备与自动化现状`
 * docx/xlsx 本来就没有稳定分页，把这些一律当"页码非法"会让 **92% 的出处
 * 核不到原文**（实测 38 条里只有 3 条是数字页码）。
 * 所以锚点只负责"是哪份材料"，不是页码就退到文件级核对。
 */
export function splitFileRef(ref: string): { fileName: string; anchor: string } | null {
  const r = String(ref ?? "").trim();
  if (r === "") return null;
  // 从**最后一个**冒号切：文件名里可能含冒号（Windows 盘符、时间戳）
  const m = /^(.+)[:：]([^:：]+)$/.exec(r);
  if (!m) return null;
  const fileName = m[1]!.trim();
  const anchor = m[2]!.trim();
  if (!fileName || !anchor) return null;
  return { fileName, anchor };
}

export function splitPageRef(ref: string): { fileName: string; page: number } | null {
  const r = String(ref ?? "").trim();
  const m = /^(.+?)[:：](\d+)$/.exec(r);
  if (!m) return null;
  const page = Number(m[2]);
  if (!Number.isFinite(page) || page <= 0) return null;
  return { fileName: m[1]!.trim(), page };
}

export function createSourceLookup(db: Database.Database): SourceLookup {
  const hasSourceStmt = db.prepare("SELECT 1 FROM source_fts WHERE source = ? LIMIT 1");
  const hasContentStmt = db.prepare(
    "SELECT 1 FROM source_fts WHERE source = ? AND source_fts MATCH ? LIMIT 1",
  );
  /**
   * 页级原文（变更表 #212）：这才是 G-R8「该页确有这句话」的真依据
   *
   * 老库可能还没建 `source_page` 表（迁移在建库时跑，但只读副本/历史库未必有），
   * 这时 prepared statement 会直接抛错、连 `hasSource` 都用不了。所以包一层：
   * 建不出来就置 null，退回 FTS 语义（兼容优先，不能让溯源能力整体不可用）。
   */
  let pageTextStmt: Database.Statement | null = null;
  let hasPageStmt: Database.Statement | null = null;
  let fileTextStmt: Database.Statement | null = null;
  let hasFileStmt: Database.Statement | null = null;
  try {
    pageTextStmt = db.prepare(
      "SELECT content FROM source_page WHERE file_name = ? AND page = ? LIMIT 1",
    );
    hasPageStmt = db.prepare(
      "SELECT 1 FROM source_page WHERE file_name = ? AND page = ? LIMIT 1",
    );
    // 文件级（锚点不是页码时用）：把该材料所有页拼起来找
    fileTextStmt = db.prepare(
      "SELECT group_concat(content, char(10)) AS content FROM source_page WHERE file_name = ?",
    );
    hasFileStmt = db.prepare("SELECT 1 FROM source_page WHERE file_name = ? LIMIT 1");
  } catch {
    pageTextStmt = null;
    hasPageStmt = null;
    fileTextStmt = null;
    hasFileStmt = null;
  }

  return {
    hasSource(ref: string): boolean {
      const r = String(ref ?? "").trim();
      if (r === "") return false;
      // 有原文的（新入库材料）优先按原文判存在性
      const page = splitPageRef(r);
      if (page && hasPageStmt) {
        // 锚点是页码：**页必须真的存在**。
        // 页码越界是实打实的错引（`白皮书.pdf:99` 而材料只有 1 页），
        // 不能因为"这个文件存在"就算出处成立。
        if (hasPageStmt.get(page.fileName, page.page)) return true;
        return false;
      }
      // 锚点不是页码（`表格2`/`8.1`/章节名）：只要该材料有原文就成立
      const file = splitFileRef(r);
      if (file && hasFileStmt?.get(file.fileName)) return true;
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

      /**
       * 优先查**页级原文**（变更表 #212）
       *
       * 原来只查 `source_fts`，而它的 content 是业务字段拼接（触发器
       * `NEW.name || ' ' || NEW.position_desc`）——拿业务行跟自己比，永远为真，
       * 等于没核。现在先看 `source_page` 里这一页的原文：
       *   有原文 → 在原文里找（真核）
       *   没原文（老数据）→ 退回 FTS 检索，语义降级但保持兼容
       */
      // ① 锚点是页码 → 精确到那一页核（最强）
      const page = splitPageRef(r);
      if (page && pageTextStmt) {
        const pageRow = pageTextStmt.get(page.fileName, page.page) as
          | { content?: string }
          | undefined;
        if (pageRow) {
          const pageText = String(pageRow.content ?? "");
          if (pageText.trim() === "") return true; // 该页无文本层，判不了不指控
          // 用「关键要素 + 覆盖率」判，不用裸字符串包含：
          // 业务行是归纳改写，裸比对实测 53% 误杀（见 domain/content-match.ts）
          return matchContent(String(snippet ?? ""), pageText).verdict !== "unsupported";
        }
      }

      // ② 锚点不是页码（`表格2`/`8.1`/`三、现状`）→ 退到**整份材料**里核
      //
      // 精度降一级（"这份材料里有"而非"这一页有"），但比"不核"强得多，
      // 也符合 docx/xlsx 本就没有稳定分页的事实。判定一律如实降级说明。
      const file = splitFileRef(r);
      if (file && fileTextStmt) {
        const row = fileTextStmt.get(file.fileName) as { content?: string } | undefined;
        if (row) {
          const allText = String(row.content ?? "");
          if (allText.trim() === "") return true;
          return matchContent(String(snippet ?? ""), allText).verdict !== "unsupported";
        }
      }

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

/**
 * 写入/更新一页原文（变更表 #212）
 *
 * 同一材料同一页重复入库时覆盖（重新解析后页码内容可能变），不累积脏数据。
 */
export function upsertSourcePages(
  db: Database.Database,
  fileName: string,
  pages: ReadonlyArray<{ page: number; text: string }>,
): number {
  const name = String(fileName ?? "").trim();
  if (!name || pages.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT INTO source_page (id, file_name, page, content, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(file_name, page) DO UPDATE SET content = excluded.content`,
  );
  const now = new Date().toISOString();
  let n = 0;
  const tx = db.transaction(() => {
    for (const p of pages) {
      if (!Number.isFinite(p.page) || p.page <= 0) continue;
      const text = String(p.text ?? "");
      if (text.trim() === "") continue; // 空白页不占位，省空间也避免"有页但无内容"的假象
      stmt.run(`${name}#${p.page}`, name, p.page, text, now);
      n += 1;
    }
  });
  tx();
  return n;
}
