/**
 * web-store — 网页快照的落地存储（变更表 #216）
 *
 * 职责：把「一次抓取」变成「资料库里的一份可复核材料」。
 *
 * 为什么必须有这一层：调研文档 §6.2 的核心取舍是
 * **把联网从「生成环节」挪到「入库环节」**——模型看到的永远是
 * "已入库的材料"，不是"搜索 API 的返回"。这样现有溯源体系
 * （`hasSource` / `hasContent` / `sourcePassages` / 右栏「看原文」）
 * 一行都不用改就能覆盖网页来源。
 *
 * 铁律：**块里存的是真原文**。材料表那边 `source_fts.content` 是业务字段拼接
 * （既有实现债，已用 `source_page` 补偿），网页这边不给模型/实现留这个口子。
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  chunkMarkdown,
  stripBoilerplate,
  extractPublishedAt,
  gradeWebSource,
  snapshotFileName,
  urlKey,
  registeredDomain,
  extractDocNo,
  scanInjection,
  shouldBlockInjection,
  type WebBlock,
} from "@scene/domain";

/** 一次抓取的原始结果（抓取层产出，存储层消费） */
export interface WebCapture {
  /** 原始 URL */
  url: string;
  /** 跟随重定向后的最终 URL */
  finalUrl?: string;
  /** 页面标题 */
  title: string;
  /** Markdown 正文（已清洗） */
  markdown: string;
  /** 页面声明的发布日期 */
  publishedAt?: string;
  /** 发布机构 */
  publisher?: string;
  httpStatus?: number;
  contentType?: string;
  etag?: string;
  lastModified?: string;
  /** 产出这份快照的检索 query */
  query?: string;
}

/** 落库结果（供调用方记录/展示） */
export interface WebStoreResult {
  id: string;
  snapshotName: string;
  blockCount: number;
  /** 权威性 T1–T4 */
  authority: string;
  category: string;
  /** 是否禁止引用（判不出来/注入/黑名单） */
  blocked: boolean;
  /** 可审计的理由 */
  reasons: string[];
  /** 降级因子 */
  downgrades: string[];
  /** 注入特征 */
  injectionFlags: string[];
}

/** sha256（Node crypto 只在 infra 层用，领域层不碰） */
function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** 取已占用的快照名（避免同名冲突） */
function takenSnapshotNames(db: Database.Database): Set<string> {
  const rows = db.prepare("SELECT snapshot_name AS n FROM web_source WHERE snapshot_name != ''").all() as Array<{
    n: string;
  }>;
  return new Set(rows.map((r) => r.n));
}

/**
 * 保存一次抓取
 *
 * 幂等：同一 URL（按 `url_key`）重复抓取时**覆盖**旧快照与其块，
 * 不累积脏数据。这也是"页面改了之后重新抓一次"的正常路径。
 *
 * @param db - 数据库
 * @param cap - 抓取结果
 * @returns 落库摘要（含权威性判定与理由）
 */
export function saveWebCapture(db: Database.Database, cap: WebCapture): WebStoreResult {
  const url = String(cap.url ?? "").trim();
  if (url === "") throw new Error("saveWebCapture: url 不能为空");
  const markdown = String(cap.markdown ?? "");
  if (markdown.trim() === "") throw new Error("saveWebCapture: 正文为空，不能入库");

  // ① 去导航/面包屑/工具栏（实测不清洗时块1就是一堆菜单项，"原文"名存实亡）
  const cleaned = stripBoilerplate(markdown);
  if (cleaned.trim() === "") throw new Error("saveWebCapture: 清洗后正文为空，不能入库");

  // ② 发布日期兜底：政府页的日期常只写在元数据表里，`<meta>` 抽不到
  const publishedAt = String(cap.publishedAt ?? "").trim() || extractPublishedAt(cleaned);

  const finalUrl = String(cap.finalUrl ?? url).trim() || url;
  const domain = registeredDomain(finalUrl);
  const key = urlKey(url);

  // ① 注入检测（不可信输入的第一道关）
  const injection = scanInjection(cleaned);
  const injectionBlocked = shouldBlockInjection(injection);

  // ② 权威性判定（确定性规则）
  const verdict = gradeWebSource({
    url: finalUrl,
    title: cap.title,
    text: cleaned,
    publishedAt,
    publisher: cap.publisher,
    contentType: cap.contentType,
    injectionHit: injection.hit,
  });

  const blocked = verdict.blocked || injectionBlocked;

  // ③ 切块（确定性）
  const blocks: WebBlock[] = chunkMarkdown(cleaned);
  if (blocks.length === 0) throw new Error("saveWebCapture: 切不出任何块，不能入库");

  // ④ 快照名（满足 FILE_CITATION_RE：不含 / : # 与空白）
  const existing = db.prepare("SELECT id, snapshot_name AS n FROM web_source WHERE url_key = ?").get(key) as
    | { id: string; n: string }
    | undefined;
  const snapshotName =
    existing && existing.n
      ? existing.n
      : snapshotFileName(domain, cap.title || url, takenSnapshotNames(db));

  const id = existing?.id ?? `w_${key}_${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  const docNo = extractDocNo(`${cap.title ?? ""}\n${cleaned.slice(0, 3000)}`) ?? "";

  const tx = db.transaction(() => {
    // 覆盖旧快照：先删块（触发 DELETE 清理 FTS），再写新块
    db.prepare("DELETE FROM web_source_block WHERE web_source_id = ?").run(id);

    db.prepare(
      `INSERT INTO web_source (
         id, url, url_key, final_url, domain, title, publisher, published_at, fetched_at,
         http_status, content_type, etag, last_modified, snapshot_name, snapshot_sha256,
         block_count, doc_no, category, authority, authority_reason, trust_flags,
         injection_flags, status, query, created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         url=excluded.url, final_url=excluded.final_url, domain=excluded.domain,
         title=excluded.title, publisher=excluded.publisher, published_at=excluded.published_at,
         fetched_at=excluded.fetched_at, http_status=excluded.http_status,
         content_type=excluded.content_type, etag=excluded.etag,
         last_modified=excluded.last_modified, snapshot_name=excluded.snapshot_name,
         snapshot_sha256=excluded.snapshot_sha256, block_count=excluded.block_count,
         doc_no=excluded.doc_no, category=excluded.category, authority=excluded.authority,
         authority_reason=excluded.authority_reason, trust_flags=excluded.trust_flags,
         injection_flags=excluded.injection_flags, status=excluded.status, query=excluded.query`,
    ).run(
      id,
      url,
      key,
      finalUrl,
      domain,
      String(cap.title ?? ""),
      String(cap.publisher ?? ""),
      publishedAt,
      now,
      Number(cap.httpStatus ?? 0),
      String(cap.contentType ?? ""),
      String(cap.etag ?? ""),
      String(cap.lastModified ?? ""),
      snapshotName,
      sha256(cleaned),
      blocks.length,
      docNo,
      verdict.category,
      verdict.authority,
      JSON.stringify(verdict.reasons),
      JSON.stringify(verdict.downgrades),
      JSON.stringify(injection.kinds),
      blocked ? "不可引用" : "有效",
      String(cap.query ?? ""),
      now,
    );

    const insBlock = db.prepare(
      `INSERT INTO web_source_block (id, web_source_id, block_no, heading, text, char_start, char_end, sha256)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    for (const b of blocks) {
      insBlock.run(
        `${id}#${b.blockNo}`,
        id,
        b.blockNo,
        b.heading,
        b.text,
        b.charStart,
        b.charEnd,
        sha256(b.text),
      );
    }
  });
  tx();

  return {
    id,
    snapshotName,
    blockCount: blocks.length,
    authority: verdict.authority,
    category: verdict.category,
    blocked,
    reasons: verdict.reasons,
    downgrades: verdict.downgrades,
    injectionFlags: injection.kinds,
  };
}

/**
 * 生成引用串：`快照名:块号`
 *
 * 这是**唯一**允许写进业务行 `source` 字段的网页引用形态。
 * 裸 URL 会被判「不可复核」（`isBareUrlCitation`），不允许当引用。
 */
export function webCitation(snapshotName: string, blockNo: number): string {
  return `${snapshotName}:${blockNo}`;
}

/** 一份网页来源的块（右栏「看原文」用） */
export function webBlocks(
  db: Database.Database,
  webSourceId: string,
): Array<{ blockNo: number; heading: string; text: string }> {
  return db
    .prepare(
      `SELECT block_no AS blockNo, heading, text FROM web_source_block
        WHERE web_source_id = ? ORDER BY block_no`,
    )
    .all(webSourceId) as Array<{ blockNo: number; heading: string; text: string }>;
}

/** 按快照名取块（从引用串反查原文） */
export function webBlocksBySnapshot(
  db: Database.Database,
  snapshotName: string,
): Array<{ blockNo: number; heading: string; text: string }> {
  const row = db.prepare("SELECT id FROM web_source WHERE snapshot_name = ?").get(snapshotName) as
    | { id: string }
    | undefined;
  return row ? webBlocks(db, row.id) : [];
}

/** 列出网页来源（管理/展示用） */
export function listWebSources(
  db: Database.Database,
  opts: { status?: string; limit?: number } = {},
): Array<{
  id: string;
  url: string;
  domain: string;
  title: string;
  authority: string;
  category: string;
  blockCount: number;
  fetchedAt: string;
  status: string;
}> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const where = opts.status ? "WHERE status = ?" : "";
  const params = opts.status ? [opts.status, limit] : [limit];
  return db
    .prepare(
      `SELECT id, url, domain, title, authority, category,
              block_count AS blockCount, fetched_at AS fetchedAt, status
         FROM web_source ${where}
        ORDER BY fetched_at DESC LIMIT ?`,
    )
    .all(...params) as never;
}

/**
 * 删除一份网页来源（连同块与索引）
 *
 * `source_fts` 没有 web_source 的 DELETE 触发器覆盖整表删除场景，
 * 所以块删除由 `trg_web_block_fts_delete` 逐行清理，这里只删两表。
 */
export function deleteWebSource(db: Database.Database, id: string): boolean {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM web_source_block WHERE web_source_id = ?").run(id);
    const r = db.prepare("DELETE FROM web_source WHERE id = ?").run(id);
    return r.changes > 0;
  });
  return tx();
}
