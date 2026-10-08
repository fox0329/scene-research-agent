/**
 * @scene/server — PPT 大纲提示词（变更表 #141）
 *
 * 一次模型调用产出**全部页面**（严格 JSON，无围栏、无解释）。口径见 `docs/PPT输出要求.md`：
 * 5–10 页（目标 6–8）、不要封面/目录/尾页、第一页直接进内容、问题 → 方案 → 价值、
 * 五种布局各按自己的字段给内容、只用报告正文里出现过的数字。
 *
 * 提示词是"内容生成"侧；**能不能上这一页由 `@scene/domain` 的 `parsePptOutline` 说了算**
 * （页数、字段长度、禁用词），模型写的任何东西都要过那道闸。
 */

import { REPORT_KIND_LABEL, type ReportKind } from "@scene/contract";

/** 报告口径名（与标题、导出文件名同源） */
function kindLabel(kind: ReportKind): string {
  return REPORT_KIND_LABEL[kind];
}

/** 首次调用的路标（测试据此分辨两步调用） */
export const PPT_PROMPT_MARKER = "## PPT：把这份交付物排成中间页";

/** 首次输出没法解析时的重试路标（提示刻意更短，免得模型又写一堆解释） */
export const PPT_RETRY_PROMPT_MARKER = "## PPT：上一次的输出无法解析，只按格式重发一次";

/** 页面口径（逐条写死，模型不用猜） */
export const PPT_PAGE_RULES: readonly string[] = [
  "**5–10 页，目标 6–8 页**；不要封面页、不要目录页、不要「谢谢 / 结束」这类尾页——第一页直接进内容。",
  "叙事必须走「问题 → 方案 → 价值」：开头 1–2 页讲现状与问题（读者今天的处境与代价），",
  "中间 3–5 页讲方案、建设内容与路径，最后 1–2 页讲价值与收益。",
  "每页：`title` ≤ 20 字、`takeaway` 一句话 ≤ 40 字、`bullets` 3–5 条且每条 ≤ 40 字；",
  "`双栏对比` 的 `columns` 恰好 2 组；`数据卡片` 的 `cards` 3–4 张（`value` ≤ 8 字、`label` ≤ 14 字）；",
  "`表格` 的 `table` ≤ 6 行 × ≤ 5 列；`图文说明` 用 `bullets` 给左侧说明。",
  "**只用这份报告正文里出现过的数字**（金额、台数、比例一律不许新造，也不要把报告里的数字换算或加总）。",
  "不许出现「待客户提供」「待补齐」这类占位，不许出现「建议采用 / 推荐 / 值得投入 / 应当优先」这类决策建议，",
  "也不许把 Word 里的表号、来源、页码、证据等级、核实结论写进 PPT。",
  "说人话：一页一件事，读者扫一眼就知道这页在说什么；不要空话套话。",
];

/** 五种布局各要什么（与契约 `PptPage` 一一对应） */
export const PPT_LAYOUT_SPEC: readonly string[] = [
  "- `要点`：用 `bullets`（3–5 条）；讲现状、判断、做法都行。",
  "- `双栏对比`：用 `columns`（恰好 2 组，每组 `head` ≤ 12 字 + 2–3 条 `bullets`）；对比「今天 / 建成后」或两种做法。",
  "- `数据卡片`：用 `cards`（3–4 张，`value` 是短语或报告里有的数字，`label` 说明它是什么）。",
  "- `图文说明`：用 `bullets`（3–5 条）讲结构或流程，右侧会画一张示意图，不要自己描述图。",
  "- `表格`：用 `table`（`head` ≤ 5 列、`rows` ≤ 6 行），承载分层、清单、分工这类结构。",
];

/** 输出格式（三个调用共用同一段） */
export const PPT_JSON_SPEC: readonly string[] = [
  "## 输出（**只输出这一段 JSON**）",
  "- **不要任何解释、不要 Markdown 代码围栏、不要前后缀**——你的回复会被直接 `JSON.parse`；",
  "- 形状照抄（字段没有就省略或给空值，不要自创字段）：",
  '{"pages":[{"layout":"要点|双栏对比|数据卡片|图文说明|表格","title":"…","takeaway":"…",',
  '"bullets":["…"],"columns":[{"head":"…","bullets":["…"]}],"cards":[{"value":"…","label":"…"}],',
  '"table":{"head":["…"],"rows":[["…"]]}}]}',
];

/** 首次调用：把整篇交付物排成中间页 */
export function buildPptOutlinePrompt(
  kind: ReportKind,
  scenarioName: string,
  markdown: string,
): { system: string; user: string } {
  const system = [
    `你是给《${scenarioName}${kindLabel(kind)}》做汇报 PPT 的排版编辑，读者是客户的业务负责人与决策人。`,
    "你只做一件事：把这份报告压缩成几页**能直接讲**的中间页。",
    "",
    "## 页面口径",
    ...PPT_PAGE_RULES,
    "",
    "## 五种布局怎么用",
    ...PPT_LAYOUT_SPEC,
    "",
    ...PPT_JSON_SPEC,
  ].join("\n");
  const user = [
    PPT_PROMPT_MARKER,
    "",
    `## 交付物`,
    `${scenarioName}${kindLabel(kind)}`,
    "",
    "## 正文",
    markdown,
  ].join("\n");
  return { system, user };
}

/** 重试：上一次没给出合规 JSON，只重复格式要求 */
export function buildPptRetryPrompt(
  kind: ReportKind,
  scenarioName: string,
): { system: string; user: string } {
  const system = [
    `你上一次给《${scenarioName}${kindLabel(kind)}》的输出无法解析为 JSON。现在**只重复输出那一段 JSON**。`,
    "",
    "## 页面口径（不变）",
    ...PPT_PAGE_RULES,
    "",
    ...PPT_JSON_SPEC,
  ].join("\n");
  const user = [
    PPT_RETRY_PROMPT_MARKER,
    `（《${scenarioName}${kindLabel(kind)}》的 PPT 大纲：上一次的输出无法解析为 JSON，请只按格式重发一次）`,
    "只输出 JSON。",
  ].join("\n");
  return { system, user };
}
