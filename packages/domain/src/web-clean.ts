/**
 * web-clean — 网页正文的确定性清洗（变更表 #216）
 *
 * 为什么必须有：实测抓回来的真实政府页面，前两块「原文」是：
 *   块1：`- 国务院关于印发…的通知_国务院文件_中国政府网 / 首页 / - | / - 简 / - 繁 / - EN / - 登录 …`
 *   块2：`首页（https://www.gov.cn/） > 政策（…） > 国务院政策文件库（…） > 国务院`
 * 这些是导航与面包屑。如果模型引用块1，所谓"原文"就是一堆菜单项——
 * G-R8「该页确有这句话」在形式上成立，在实质上毫无意义。
 *
 * 清洗只做**确定性**的事（不调模型）：
 *   ① 去导航/面包屑/工具栏/分享控件
 *   ② 把"标签：/ 值"两行合成一行（政府文件的元数据表就是这种形态）
 *   ③ 去纯符号行
 *
 * 另一个必须修的问题：政府页的发布日期常只写在元数据表里
 * （`发布日期：2022年01月12日`），`<meta>` 里没有。原实现抽不到 →
 * 误判「无发布日期」→ 每个政府页都被白降一级（实测 T1 被降成 T2）。
 * 所以这里提供 `extractPublishedAt` 从正文兜底抽日期。
 */

/** 站点框架词（单独成行或列表项时整行丢弃） */
const CHROME_WORDS = new Set([
  "简",
  "繁",
  "EN",
  "登录",
  "注册",
  "退出",
  "邮箱",
  "无障碍",
  "个人中心",
  "打印",
  "收藏",
  "分享",
  "扫一扫",
  "字号",
  "默认",
  "大",
  "超大",
  "返回顶部",
  "关闭",
  "更多",
  "首页",
  "上一页",
  "下一页",
  "分享到",
  "微信",
  "微博",
  "QQ空间",
  "字号：大",
  "字号：中",
  "字号：小",
]);

/** 工具栏/控件行（正则） */
const CHROME_LINE_RE = new RegExp(
  [
    "^(字号|打印本页|打印|收藏|分享到?|扫一扫|返回顶部|关闭窗口|更多)$",
    "^(字体|字号)\\s*[:：]",
    "^(责任编辑|来源|编辑)\\s*[:：]\\s*$",
  ].join("|"),
  "u",
);

/** 面包屑 */
const BREADCRUMB_RE = /^(首页|主页|当前位置|您的位置|现在位置)\s*[：:>＞]/u;

/** 纯符号行（`- |` `|` `---` `·`） */
const PUNCT_ONLY_RE = /^[\s\-–—_|·•/\\>*=~`]+$/u;

/**
 * 其余站点框架行（实测政府页会带这些）
 *
 * - `javascript:;`：空链接占位
 * - 孤立 URL：只有地址没有文字，是导航不是内容
 * - 纯时间戳：`2022-01-12 16:55:00`（日期已由 extractPublishedAt 取走）
 */
const RESIDUE_RE = new RegExp(
  [
    "^javascript:",
    "^https?://\\S+$",
    "^\\d{4}-\\d{2}-\\d{2}\\s+\\d{1,2}:\\d{2}(:\\d{2})?$",
  ].join("|"),
  "iu",
);

/** 短标签行：`索  引  号：` / `发文机关:`，值在下一行 */
const LABEL_LINE_RE = /^([^\n：:]{2,16})\s*[：:]\s*$/u;

/**
 * 日期关键词 + 日期
 *
 * **顺序有意义**：政府页同时有「成文日期」与「发布日期」，
 * 成文日期在前。对"时效性"而言发布日期才是要的那个，
 * 所以发布日期类关键词必须先试（实测原来抓到 2021-12-12 成文日期，
 * 而真正的发布日期是 2022-01-12）。
 */
const DATE_KEY_GROUPS: readonly RegExp[] = [
  /(?:发布(?:日期|时间)|发布时间|pubdate|published)\s*[：:]?\s*(\d{4})\s*[-年/.]\s*(\d{1,2})\s*[-月/.]\s*(\d{1,2})/iu,
  /(?:印发日期|发文日期|签发日期)\s*[：:]?\s*(\d{4})\s*[-年/.]\s*(\d{1,2})\s*[-月/.]\s*(\d{1,2})/iu,
  /(?:成文日期|更新日期|最后更新|修订日期)\s*[：:]?\s*(\d{4})\s*[-年/.]\s*(\d{1,2})\s*[-月/.]\s*(\d{1,2})/iu,
];

/** 裸日期（仅在正文前 3000 字里找，避免抓到正文中的历史日期） */
const BARE_DATE_RE = /(\d{4})\s*[-年/.]\s*(\d{1,2})\s*[-月/.]\s*(\d{1,2})\s*日?/u;

/**
 * 清洗网页 Markdown 正文
 *
 * @param markdown - 抓回来的原始 Markdown
 * @returns 去掉框架后的正文（保留标题、段落、元数据行的结构）
 */
export function stripBoilerplate(markdown: string): string {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.trim();

    // 保留空行（段落边界对切块有意义）
    if (line === "") {
      kept.push("");
      continue;
    }
    if (PUNCT_ONLY_RE.test(line)) continue;
    if (BREADCRUMB_RE.test(line)) continue;
    if (CHROME_LINE_RE.test(line)) continue;
    if (RESIDUE_RE.test(line)) continue;
    // 面包屑变体：一行里有 2 个以上链接 且 带 `>` 分隔
    if ((line.match(/https?:\/\//g) ?? []).length >= 2 && /[>＞]/.test(line)) continue;

    // 列表项形式的框架词：`- 简` / `- |`
    const li = /^[-*]\s+(.+)$/u.exec(line);
    if (li?.[1]) {
      const item = li[1].trim();
      if (CHROME_WORDS.has(item) || PUNCT_ONLY_RE.test(item)) continue;
    }
    // 纯框架词
    if (CHROME_WORDS.has(line)) continue;

    // 标题形式的元数据标签：`# 索  引  号：` 且下一行是值 → 合成一行
    //
    // **必须去掉 `#`**：元数据行若保留标题标记，会被切成"标题 + 空正文"的节，
    // 空节在 `chunkMarkdown` 里不产块 → 发文字号/发布日期直接不进块、
    // 不进 FTS、无法被引用（实测政府页的 `发文字号：国发〔2021〕29号` 就是这样丢的）。
    const headingLabel = /^#{1,4}\s+(.+?)\s*$/u.exec(line);
    if (headingLabel?.[1] && LABEL_LINE_RE.test(headingLabel[1])) {
      const next = nextNonEmpty(lines, i + 1);
      if (next !== null && !/^#{1,4}\s/u.test(next.value) && next.value.length <= 60) {
        kept.push(`${headingLabel[1].trim()}${next.value.trim()}`);
        i = next.index;
        continue;
      }
      // 下一行是标题或过长：至少保留标签本身（不丢信息）
      kept.push(headingLabel[1].trim());
      continue;
    }

    // 普通标签行 → 与下一行的值合并
    if (LABEL_LINE_RE.test(line)) {
      const next = nextNonEmpty(lines, i + 1);
      if (next !== null && !/^#{1,4}\s/u.test(next.value) && !LABEL_LINE_RE.test(next.value) && next.value.length <= 60) {
        kept.push(`${line}${next.value.trim()}`);
        i = next.index;
        continue;
      }
    }

    kept.push(line);
  }

  // 连续空行压成一个（段落边界只需一个）
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 找下一非空行（返回行号，便于跳过已消费的行） */
function nextNonEmpty(
  lines: string[],
  from: number,
): { index: number; value: string } | null {
  for (let i = from; i < lines.length; i++) {
    const v = (lines[i] ?? "").trim();
    if (v !== "") return { index: i, value: v };
  }
  return null;
}

/**
 * 从正文抽发布日期
 *
 * 优先"日期关键词 + 日期"（可靠）；没有关键词时只在**前 3000 字**里找裸日期，
 * 避免把正文里提到的历史事件日期当成发布日期。
 *
 * @param text - 正文（建议传清洗后的）
 * @returns ISO 日期 `YYYY-MM-DD`，抽不到返回空串
 */
export function extractPublishedAt(text: string): string {
  const s = String(text ?? "");
  for (const re of DATE_KEY_GROUPS) {
    const m = re.exec(s);
    if (m) {
      const iso = toIso(m[1]!, m[2]!, m[3]!);
      if (iso !== "") return iso;
    }
  }

  const head = s.slice(0, 3000);
  const bare = BARE_DATE_RE.exec(head);
  if (bare) {
    const iso = toIso(bare[1]!, bare[2]!, bare[3]!);
    return isValidIso(iso) ? iso : "";
  }
  return "";
}

/** 拼成 ISO 并校验合法（2月30日这种要拒掉） */
function toIso(y: string, m: string, d: string): string {
  const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return isValidIso(iso) ? iso : "";
}

function isValidIso(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  // 回读校验：拒绝 2024-02-30 这类被 Date 悄悄滚动的日期
  return new Date(t).toISOString().slice(0, 10) === iso;
}
