/**
 * @scene/server — PPT 大纲提示词（变更表 #141 立、#142 升：信息量与排版）
 *
 * 一次模型调用产出**全部页面**（严格 JSON，无围栏、无解释）。口径见 `docs/PPT输出要求.md`：
 * 5–10 页（目标 7 页）、不要封面/目录/尾页、第一页直接进内容、问题 → 方案 → 价值、
 * **每页信息量 ≈ 4 块 × 3–4 行（至少 12 条有效短句）**、七种布局各按自己的字段给内容、
 * **`layout` 与字段必须成套**（声明 `表格` 就必须给 `table`，声明 `流程阶段` 就必须给 `stages`）、
 * 只用报告正文里出现过的名词与数字。
 *
 * 提示词是"内容生成"侧；**能不能上这一页由 `@scene/domain` 的 `parsePptOutline` 说了算**
 * （页数、字段长度、组数、禁用词），页面挤不挤由 `@scene/infra` 的 `checkPptDeck` 量，
 * 页面太空由 `apps/server/src/ppt-export.ts` 的重试兜（见 `THIN_PAGE_MIN`）。
 */

import { PPT_LIMITS, REPORT_KIND_LABEL, type ReportKind } from "@scene/contract";

/** 报告口径名（与标题、导出文件名同源） */
function kindLabel(kind: ReportKind): string {
  return REPORT_KIND_LABEL[kind];
}

/** 首次调用的路标（测试据此分辨两步调用） */
export const PPT_PROMPT_MARKER = "## PPT：把这份交付物排成中间页";

/** 重试路标（提示刻意更短，免得模型又写一堆解释） */
export const PPT_RETRY_PROMPT_MARKER = "## PPT：上一次的大纲不合要求，只按格式重发一次";

/**
 * 版式与字段必须成套（#142 真跑教训）
 *
 * 模型最容易犯的错：**声明了一个版式却不给对应字段**（如 `layout: "表格"` 却没有 `table`），
 * 确定性层只能把它降级成「要点清单」，于是页面上只剩两三条短句——看起来就是一张空页。
 * 所以这条必须写死：给不出字段就换个版式，拿不准就一律用 `网格要点` 写满。
 */
export const PPT_LAYOUT_FIELD_RULES: readonly string[] = [
  "## 版式与字段必须成套（给不全就换版式）",
  "- 写 `表格` ⇒ **必须**同时给合规 `table`（表头 ≥2 列、列 ≤ 5、行 ≤ 6，给不出表就别写 `表格`）；",
  `- 写 \`流程阶段\` ⇒ **必须**给 ${PPT_LIMITS.stages.min}–${PPT_LIMITS.stages.max} 个 \`stages\`，**每个都要有 \`head\` 与 \`note\`**（步骤 / 阶段 / 批次 / 里程碑这类内容一律用它，不要写成表格）；`,
  `- 写 \`分层架构\` ⇒ **必须**给 ${PPT_LIMITS.layers.min}–${PPT_LIMITS.layers.max} 层 \`layers\`，每层 ${PPT_LIMITS.layers.minItems}–${PPT_LIMITS.layers.maxItems} 个 \`items\`；`,
  `- 写 \`网格要点\` ⇒ **必须**给满 ${PPT_LIMITS.blocks.count} 块，每块 ${PPT_LIMITS.blocks.minLines}–${PPT_LIMITS.blocks.maxLines} 行；`,
  `- 写 \`双栏对比\` ⇒ **必须**给满 ${PPT_LIMITS.columns.count} 栏，每栏 ${PPT_LIMITS.columns.minLines}–${PPT_LIMITS.columns.maxLines} 行；`,
  `- 写 \`数据卡片\` ⇒ **必须**给 ${PPT_LIMITS.cards.min}–${PPT_LIMITS.cards.max} 张；`,
  `- **拿不准就一律用 \`网格要点\` 写满 ${PPT_LIMITS.blocks.count} 块**（每块 ${PPT_LIMITS.blocks.minLines}–${PPT_LIMITS.blocks.maxLines} 行）：`,
  "  宁可用网格要点写满，也**不要交一页只有两三条的空页**——交不出内容就别交这一页。",
];

/** 页面口径（逐条写死，模型不用猜） */
export const PPT_PAGE_RULES: readonly string[] = [
  `**${PPT_LIMITS.minPages}–${PPT_LIMITS.maxPages} 页，目标 ${PPT_LIMITS.targetPages} 页**；不要封面页、不要目录页、不要「谢谢 / 结束」这类尾页——第一页直接进内容。`,
  "叙事走「问题 → 方案 → 价值」：开头 1–2 页讲现状与问题（读者今天的处境与代价），",
  "中间 3–4 页讲方案、建设内容与路径，最后 1–2 页讲价值与收益。",
  "",
  "## 信息量（硬要求，最要紧的一条）",
  `- **一页至少 ${PPT_LIMITS.minSentencesPerPage} 条有效短句**：网格要点就是 4 块 × 3–4 行；双栏对比是两栏各 3–5 行；`,
  "  流程阶段每个阶段都要有说明；分层架构每层 2–4 个组件；表格要写满行与列。**空页、只有两三条的大页一律不合格。**",
  "- 内容必须**从这份报告正文里提炼**：可以用正文里出现过的名词、口径、数字，**但不许编造**",
  "  （金额、台数、比例、时间一律照抄正文，不许换算、不许加总、不许估）。",
  "- 不许出现「待客户提供」「待补齐」这类占位，不许出现「建议采用 / 推荐 / 值得投入 / 应当优先」这类决策建议，",
  "  也不许把 Word 里的表号、来源、页码、证据等级、核实结论写进 PPT。",
  "- 每条短句都说人话、能独立看懂，一条一件事；不要空话套话，不要「赋能、闭环、抓手」这类壳子词。",
  "",
  ...PPT_LAYOUT_FIELD_RULES,
  "",
  "## 字段限额（超了会被截断，按这个尺寸写）",
  `- 每页都要有：\`kicker\` 小节标签 ≤ ${PPT_LIMITS.kickerChars} 字、\`title\` ≤ ${PPT_LIMITS.titleChars} 字、`,
  `  \`subtitle\` 一句副题 ≤ ${PPT_LIMITS.subtitleChars} 字、\`highlight\` 底部结论带 ≤ ${PPT_LIMITS.highlightChars} 字。`,
  `- \`网格要点\`：\`blocks\` **恰好 ${PPT_LIMITS.blocks.count} 块**（2×2），每块 \`head\` ≤ ${PPT_LIMITS.blocks.headChars} 字、`,
  `  \`note\` ≤ ${PPT_LIMITS.blocks.noteChars} 字（可空）、\`lines\` ${PPT_LIMITS.blocks.minLines}–${PPT_LIMITS.blocks.maxLines} 条、每条 ≤ ${PPT_LIMITS.blocks.lineChars} 字。`,
  `- \`双栏对比\`：\`columns\` **恰好 ${PPT_LIMITS.columns.count} 组**，每组 \`head\` ≤ ${PPT_LIMITS.columns.headChars} 字、`,
  `  \`note\` ≤ ${PPT_LIMITS.columns.noteChars} 字（可空）、\`lines\` ${PPT_LIMITS.columns.minLines}–${PPT_LIMITS.columns.maxLines} 条、每条 ≤ ${PPT_LIMITS.columns.lineChars} 字。`,
  `- \`流程阶段\`：\`stages\` ${PPT_LIMITS.stages.min}–${PPT_LIMITS.stages.max} 个，每个 \`head\` ≤ ${PPT_LIMITS.stages.headChars} 字、\`note\` ≤ ${PPT_LIMITS.stages.noteChars} 字（**每个都要有 note**）。`,
  `- \`分层架构\`：\`layers\` ${PPT_LIMITS.layers.min}–${PPT_LIMITS.layers.max} 层，每层 \`head\` ≤ ${PPT_LIMITS.layers.headChars} 字、\`items\` ${PPT_LIMITS.layers.minItems}–${PPT_LIMITS.layers.maxItems} 个、每个 ≤ ${PPT_LIMITS.layers.itemChars} 字。`,
  `- \`数据卡片\`：\`cards\` ${PPT_LIMITS.cards.min}–${PPT_LIMITS.cards.max} 张，\`value\` ≤ ${PPT_LIMITS.cards.valueChars} 字、\`label\` ≤ ${PPT_LIMITS.cards.labelChars} 字。`,
  `- \`表格\`：\`table\` ≤ ${PPT_LIMITS.table.maxRows} 行 × ≤ ${PPT_LIMITS.table.maxCols} 列（表头 ≥2 列），表头 ≤ ${PPT_LIMITS.table.headChars} 字、单元格 ≤ ${PPT_LIMITS.table.cellChars} 字（**要写满行与列**）。`,
  `- \`要点清单\`（兜底）：\`bullets\` ${PPT_LIMITS.bullets.min}–${PPT_LIMITS.bullets.max} 行、每行 ≤ ${PPT_LIMITS.bullets.chars} 字；只在上面六种都排不出时用。`,
  `- \`chips\` 技术/能力标签 ${PPT_LIMITS.chips.max} 个以内、每个 ≤ ${PPT_LIMITS.chips.chars} 字（排不排得下由页面决定，给最有信息量的几个）。`,
];

/** 七种布局各要什么（与契约 `PptPage` 一一对应） */
export const PPT_LAYOUT_SPEC: readonly string[] = [
  "- `网格要点`：**默认布局，最密**。`blocks` 四块各讲一件事（如 设备台账 / 巡检任务 / 异常上报 / 数据口径），每块 3–4 条做法。",
  "- `双栏对比`：`columns` 两栏对比「今天 / 建成后」或两种做法，各 3–5 行，左栏在今天、右栏在建成后。",
  "- `流程阶段`：`stages` 讲推进路径（试点 → 复制 → 全量 这类），每阶段一句说明，别只写阶段名。",
  "- `分层架构`：`layers` 自上而下给层（应用层 / 平台层 / 网络层 / 感知层），每层 2–4 个组件名。",
  "- `数据卡片`：`cards` 给关键数字或关键结论（`value` 是短词或正文里有的数字，`label` 说明它是什么），3–4 张。",
  "- `表格`：`table` 承载分层、分工、清单这类结构，列 ≤ 5、行 ≤ 6，别把长句塞进格子——**行与列都要写满**。",
  "- `要点清单`：只在实在排不出上面六种时用，5–6 行大字，一行一件事。",
  "- **一份 PPT 里 `网格要点` 应占一半以上**，同一布局不要连着超过两页。",
  "- **上面每种版式都必须带上它自己的字段**（`表格`→`table`、`流程阶段`→`stages`、`分层架构`→`layers`…）：",
  "  只写 `layout` 不给字段，这一页会被降级成兜底清单，页面上就只剩两三条——**宁可改用 `网格要点` 写满四块**。",
];

/** 输出格式（三个调用共用同一段；示例与契约字段、限额逐字一致） */
export const PPT_JSON_SPEC: readonly string[] = [
  "## 输出（**只输出这一段 JSON**）",
  "- **不要任何解释、不要 Markdown 代码围栏、不要前后缀**——你的回复会被直接 `JSON.parse`；",
  "- 只写这一页用到的字段也行，但字段名必须与下面完全一致，**不要自创字段**；",
  "- 四页完整示例（覆盖四种版式，照这个形状写、照这个密度写，内容换成这份报告的）：",
  "```",
  JSON.stringify({
    pages: [
      {
        layout: "网格要点",
        kicker: "项目硬规则",
        title: "四条硬规则管住现场",
        subtitle: "把口径写进系统，巡检不再靠人记",
        blocks: [
          { head: "设备台账", note: "谁在现场、什么型号", lines: ["按区域建台账，逐台贴码", "型号与位置一次录清", "换机改码当场更新"] },
          { head: "巡检任务", note: "照班次自动发单", lines: ["每班次派发到人", "漏项当场提醒", "完成时间自动留痕"] },
          { head: "异常上报", note: "现场拍照即上报", lines: ["异常必传现场照片", "按等级通知到人", "处理过程全程可查"] },
          { head: "数据口径", note: "一处录入全系统共用", lines: ["台账只在一处录入", "报表按同一口径出数", "月度对账有据可依"] },
        ],
        chips: ["扫码巡检", "自动派单"],
        highlight: "口径写进系统，现场按码走",
      },
      {
        layout: "双栏对比",
        kicker: "今天与建成后",
        title: "同一件事两种做法",
        subtitle: "左边是今天的代价，右边是建成后的样子",
        columns: [
          { head: "今天的做法", note: "纸质表单为主", lines: ["巡检靠纸质表单，一天一交", "数据事后补录，口径对不上", "异常靠电话上报，常常漏"] },
          { head: "建成后的做法", note: "扫码巡检、自动留痕", lines: ["扫码巡检，当场提交", "数据实时入库，口径唯一", "异常自动派单到人"] },
        ],
        highlight: "同样的活，换个干法",
      },
      {
        layout: "流程阶段",
        kicker: "推进路径",
        title: "四步走到全量覆盖",
        subtitle: "先在一个楼层跑通，再复制到全区",
        stages: [
          { head: "样板层建设", note: "一个楼层先装齐，跑通扫码巡检" },
          { head: "单点验证", note: "连续两周比对纸质记录，口径对齐" },
          { head: "分批复制", note: "按楼层分批上线，每批一周" },
          { head: "全区运行", note: "全区纳管，报表自动出数" },
        ],
        highlight: "先跑通一层，再谈全区",
      },
      {
        layout: "表格",
        kicker: "分工与节奏",
        title: "谁在哪一步做什么",
        subtitle: "每一行一件交付物，责任到人、节点到周",
        table: {
          head: ["阶段", "做什么", "谁负责", "周期", "验收依据"],
          rows: [
            ["样板层", "装齐终端并贴码", "运维班", "第 1 周", "扫码记录连续"],
            ["单点验证", "比对纸质与系统记录", "信息部", "第 2 周", "差异逐条说明"],
            ["分批复制", "按楼层分批上线", "运维班", "第 3–6 周", "每批抽检通过"],
            ["全区运行", "全区纳管出报表", "信息部", "第 7 周", "报表口径一致"],
          ],
        },
        chips: ["运维班", "信息部"],
        highlight: "责任到人，节点到周",
      },
    ],
  }),
  "```",
];

/** 首次调用：把整篇交付物排成中间页 */
export function buildPptOutlinePrompt(
  kind: ReportKind,
  scenarioName: string,
  markdown: string,
): { system: string; user: string } {
  const system = [
    `你是给《${scenarioName}${kindLabel(kind)}》做汇报 PPT 的排版编辑，读者是客户的业务负责人与决策人。`,
    "你只做一件事：把这份报告压缩成几页**密排、能直接讲**的中间页。",
    "判断标准只有一条：**每一页都要写满有用的话**——读者扫一眼就知道这页在说什么、能不能落地。",
    "",
    "## 页面口径",
    ...PPT_PAGE_RULES,
    "",
    "## 七种布局怎么用",
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

/**
 * 重试：上一次的大纲不合要求（解析不出来 / 页数太少 / 有空页），点名原因后要求重发
 *
 * @param reason 上一次卡在哪（`apps/server/src/ppt-export.ts` 的 `retryReason` 给），会逐字写进提示
 */
export function buildPptRetryPrompt(
  kind: ReportKind,
  scenarioName: string,
  reason?: string,
): { system: string; user: string } {
  const why = reason ?? "上一次的输出无法解析为 JSON";
  const system = [
    `你上一次给《${scenarioName}${kindLabel(kind)}》的 PPT 大纲不合格：**${why}**。现在只重发那一段 JSON，并按下面两条改。`,
    "",
    "## 这次必须改掉的两件事",
    `- **每一页都写到 ${PPT_LIMITS.minSentencesPerPage} 条以上有效短句**：被点名的页要整页重写，不要只补一句；`,
    `  步骤 / 阶段类内容写成 \`流程阶段\`（${PPT_LIMITS.stages.min}–${PPT_LIMITS.stages.max} 个 \`stages\`，每个都有 \`note\`），表格式内容写成 \`表格\`（带完整 \`table\`）。`,
    `- **给不出某种版式的字段就改用 \`网格要点\` 写满 ${PPT_LIMITS.blocks.count} 块**（每块 ${PPT_LIMITS.blocks.minLines}–${PPT_LIMITS.blocks.maxLines} 行）——`,
    "  **宁可用网格要点写满，也不要再交一页只有两三条的空页**。页数与叙事不变（5–10 页、问题 → 方案 → 价值、无封面目录尾页）。",
    "",
    "## 页面口径（不变）",
    ...PPT_PAGE_RULES,
    "",
    ...PPT_JSON_SPEC,
  ].join("\n");
  const user = [
    PPT_RETRY_PROMPT_MARKER,
    `（《${scenarioName}${kindLabel(kind)}》的 PPT 大纲：${why}，请按格式与信息量要求重发一次）`,
    "只输出 JSON。",
  ].join("\n");
  return { system, user };
}
