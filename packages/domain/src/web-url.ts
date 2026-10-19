/**
 * web-url — 网页来源的 URL 规范化与快照命名（变更表 #216）
 *
 * 为什么要规范化：抓取缓存、去重、"同一页面短期内不重复抓"全靠它。
 * 规则见 `docs/技术调研-权威来源检索.md` §7.4：
 * 小写 scheme/host、去默认端口、去 fragment、去 `utm_*`/`gclid`/`spm` 等追踪参数、
 * 参数按 key 排序、去尾斜杠（根路径除外）。
 *
 * 为什么要快照命名规则：引用格式必须是 `文件名:块号`，而现有
 * `FILE_CITATION_RE = /^[^\s/:#]+[:#][^/\s]+$/` 要求文件名**不含** `/` `:` `#` 与空白。
 * 所以快照名只能是 `<域名>-<标题slug>.md`，slug 必须过滤掉这些字符。
 */

/** 需要剔除的追踪参数（前缀匹配） */
const TRACKING_PREFIXES = ["utm_", "gclid", "fbclid", "spm", "scm", "from", "share_"];
/** 精确剔除的参数名 */
const TRACKING_EXACT = new Set([
  "ref",
  "referrer",
  "source",
  "share",
  "share_token",
  "wfr",
  "for",
  "_hsenc",
  "_hsmi",
]);

/** 快照 slug 长度上限：太长会让右栏「来源」显示不下 */
const SLUG_MAX = 40;

/** 判是不是 http(s) URL */
export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(String(s ?? "").trim());
}

/**
 * 规范化 URL（用于缓存键与去重）
 *
 * 规范化失败的（非法 URL）返回原串 trim 后的结果，不抛错——
 * 上层据此判「无法规范化」并拒绝引用，而不是让整个流程崩掉。
 */
export function normalizeUrl(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!isHttpUrl(s)) return s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return s;
  }
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  // 去默认端口（URL 实现已处理，这里兜底手写的 :80/:443）
  if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
    u.port = "";
  }
  u.hash = "";

  // 参数过滤 + 排序
  const kept: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams.entries()) {
    const key = k.toLowerCase();
    if (TRACKING_EXACT.has(key)) continue;
    if (TRACKING_PREFIXES.some((p) => key === p || key.startsWith(p))) continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);

  // 去尾斜杠（根路径除外）
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }
  return u.toString();
}

/**
 * 缓存键：规范化 URL 的稳定散列
 *
 * 不用 Node `crypto`（领域层不碰 IO/平台 API），改用确定性 32 位双散列拼接。
 * 用途只是"同一 URL 不重复抓"，不需要密码学强度。
 */
export function urlKey(raw: string): string {
  const s = normalizeUrl(raw);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** 取注册域（eTLD+1 的近似：常见双段后缀单独处理） */
export function registeredDomain(raw: string): string {
  const s = String(raw ?? "").trim();
  let host = "";
  try {
    host = new URL(s).hostname.toLowerCase();
  } catch {
    host = s.toLowerCase();
  }
  host = host.replace(/^www\./, "");
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;
  // `.gov.cn` `.com.cn` `.edu.cn` `.org.cn` `.net.cn` 这类双段后缀
  const twoLevel = new Set(["gov.cn", "com.cn", "edu.cn", "org.cn", "net.cn", "ac.cn", "gov.uk", "co.uk", "org.uk", "ac.uk", "co.jp", "or.jp", "ne.jp"]);
  const last2 = parts.slice(-2).join(".");
  if (twoLevel.has(last2)) return parts.slice(-3).join(".");
  return last2;
}

/** 把任意文本压成可用作文件名的 slug */
export function slugify(text: string, max = SLUG_MAX): string {
  const s = String(text ?? "")
    // 只保留中日韩文字、字母、数字、连字符
    .replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}A-Za-z0-9-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  const out = s.slice(0, max).replace(/-+$/g, "");
  return out === "" ? "untitled" : out;
}

/** 去掉标题里的站点后缀噪声（`XX通知 - 中国政府网` → `XX通知`） */
export function cleanTitle(title: string): string {
  return String(title ?? "")
    .replace(/\s*[-_|–—]\s*[^-_|–—]{0,20}$/u, (m) => (m.length > 3 ? "" : m))
    .trim();
}

/**
 * 生成快照文件名：`<域名>-<标题slug>.md`
 *
 * 满足 `FILE_CITATION_RE`：不含 `/` `:` `#` 与空白。
 *
 * @param domain - 注册域
 * @param title - 页面标题
 * @param taken - 已占用的文件名集合，冲突时追加 `-2` `-3`…
 */
export function snapshotFileName(domain: string, title: string, taken?: Set<string>): string {
  const d = slugify(domain.replace(/^www\./, ""), 30);
  const t = slugify(cleanTitle(title) || d, SLUG_MAX);
  let name = `${d}-${t}.md`;
  if (!taken) return name;
  if (!taken.has(name)) return name;
  for (let i = 2; i < 100; i++) {
    const candidate = `${d}-${t}-${i}.md`;
    if (!taken.has(candidate)) return candidate;
  }
  // 极端情况：用 urlKey 兜底（调用方应传入唯一 key，这里只保证不返回重复值）
  return `${d}-${t}-${Date.now().toString(36)}.md`;
}

/**
 * 从引用串判断「这是不是裸 URL」
 *
 * 调研文档 §5.4 第 3 条：`source` 是裸 URL 而非快照引用时，直接判**不可复核**，
 * `postcheck` 按实降为 T4 / C。这一条堵住「模型直接写个 URL 蒙混过关」。
 */
export function isBareUrlCitation(source: string): boolean {
  const s = String(source ?? "").trim();
  if (!isHttpUrl(s)) return false;
  // 只有单独一个 URL（没有 `:块号` 后缀）才算裸 URL
  return !/^https?:\/\/\S+[:：]\d+$/i.test(s);
}
