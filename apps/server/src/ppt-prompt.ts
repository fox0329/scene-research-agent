/**
 * @scene/server — PPT 大纲提示词（变更表 #141 立、#142 升：信息量与排版；#146 升：大纲质量要求 + 优化评审）
 *
 * 一次模型调用产出**全部页面**（严格 JSON，无围栏、无解释）。口径见 `docs/PPT输出要求.md`：
 * 5–10 页（目标 7 页）、不要封面/目录/尾页、第一页直接进内容、问题 → 方案 → 价值、
 * **每页信息量 ≈ 4 块 × 3–4 行（至少 12 条有效短句）**、七种布局各按自己的字段给内容、
 * **`layout` 与字段必须成套**（声明 `表格` 就必须给 `table`，声明 `流程阶段` 就必须给 `stages`）、
 * 只用报告正文里出现过的名词与数字。
 *
 * 变更表 #146 起，提示词里多一节**《大纲质量要求》**（`PPT_OUTLINE_QUALITY_RULES`）——
 * 观点型标题、记忆点、每页信息量、数字可溯源、页间不重复、叙事顺序、自包含、图标与版式成套，
 * 词表与阈值全部来自契约 `PPT_OUTLINE_QUALITY`（与领域层判据 `checkPptOutlineQuality` **同源**）：
 * 写进提示词的要求，判据一定查；判据查的，提示词一定写了。
 *
 * 提示词是"内容生成"侧；**能不能上这一页由 `@scene/domain` 的 `parsePptOutline` 说了算**
 * （页数、字段长度、组数、禁用词），**够不够好由 `checkPptOutlineQuality` 说了算**，
 * 页面挤不挤由 `@scene/infra` 的 `checkPptDeck` 量，不合格不报错、带着问题重跑
 * （`buildPptOutlineReviewPrompt` + `PPT_OUTLINE_ROUNDS` 轮，见 `apps/server/src/ppt-export.ts`）。
 */

import {
  PPT_DEFAULT_ICON,
  PPT_ICONS,
  PPT_LIMITS,
  PPT_OUTLINE_QUALITY,
  REPORT_KIND_LABEL,
  type PptIssue,
  type PptOutline,
  type ReportKind,
} from "@scene/contract";

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
  `- 图标：每页 1 个 \`icon\`、每个块/栏/阶段/层/卡片各 1 个 \`icon\`、\`table.icons\` 与表头列一一对应（见上面的「图标」一节）。`,
];

/**
 * 大纲质量要求（变更表 #146）——**明确要求，不是几条原则**
 *
 * 用户定调：「PPT 大纲本身要有质量要求，不能只是简单的几条要求，要像 B 站 PPT 大纲生成的技能要求
 * 一样有明确的生成要求」。这里逐条写死：观点型标题（含正反例）、记忆点、每页信息量、
 * 数字可溯源、页间不重复、叙事顺序、自包含、图标与版式成套，最后附一份 ❌→✅ 常见错误清单。
 * 词表与阈值**全部取自契约 `PPT_OUTLINE_QUALITY`**，与领域层 `checkPptOutlineQuality` 同源。
 */
export const PPT_OUTLINE_QUALITY_RULES: readonly string[] = [
  "## 大纲质量要求（每一条都会被逐页检查，请照着写）",
  "",
  "### 1. 标题必须是观点，不是章节名",
  `- 每页 \`title\` ≤ ${PPT_LIMITS.titleChars} 字，**一句话的判断 / 结论**，读完能记住；`,
  `- **不许**只写「${PPT_OUTLINE_QUALITY.weakTitleWords.slice(0, 8).join("、")}」这类章节名（短标题里带这些词直接判不合格）；`,
  "- ✅「四条硬规则管住现场」「今天的巡检，账对不上」「先跑通一层，再谈全区」；",
  "- ❌「项目概述」「背景」「现状」「小结」「设备清单」（最后一个是名词堆：既不是判断，也没有动词）。",
  "",
  "### 2. 每页都要有记忆点",
  `- \`highlight\`（底部结论带）**每页必有**、≤ ${PPT_OUTLINE_QUALITY.highlightChars} 字、是能记住的一句话；不许空着，也不许把标题抄一遍。`,
  "",
  "### 3. 每页都要写满",
  `- 每页**至少 ${PPT_OUTLINE_QUALITY.minSentencesPerPage} 条有效短句**（≈ 4 块 × 3–4 行）；`,
  "- 结构上到不了 12 条的版式要**把字段写满**：`流程阶段` 每个阶段都要有 `note`（5 段 10 条）、",
  "  `数据卡片` 给满 4 张（8 条）、`表格` 行与列都写满、`要点清单` 写 5–6 行。",
  "",
  "### 4. 数字只能来自报告正文",
  "- 大纲里出现的**每一个数字**（含 `%` 与 个/台/天/倍 这类量词）都必须在这份报告正文里出现过——",
  "  **不许换算、不许加总、不许估、不许新造**；报告里没有的数字，就改写成不含新数字的定性结论。",
  "",
  "### 5. 不许两页说同一件事",
  "- 同一句话（去掉标点后算）不许出现在两页；相邻页尤其要换事实、换角度，",
  "  不能换个版式把同一批话再排一遍。",
  "",
  "### 6. 顺序：问题 → 方案 → 价值",
  "- 讲「现状 / 问题 / 痛点 / 难点 / 风险」的页必须排在讲「方案 / 建设 / 架构 / 路径」的页**之前**，",
  "  后者再排在讲「价值 / 收益 / 成效」的页之前（判定只看 `kicker` / `title` / `subtitle` / `highlight`）。",
  "",
  "### 7. 自包含",
  `- 不许出现「${PPT_OUTLINE_QUALITY.selfContainedBanned.slice(0, 4).join(" / ")} / 待客户提供 / 建议采用 / 谢谢观看 / 目录」这类话——`,
  "  PPT 是独立文件，所有要素要直接写清，读者看不到报告。",
  "",
  "### 8. 图标与版式成套",
  `- \`icon\` 只能从白名单里选（选不出用 \`${PPT_DEFAULT_ICON}\`）；`,
  "- `layout` 声明的版式必须给全它自己的字段（见下面「版式与字段必须成套」一节）。",
  "",
  "### 常见错误（❌ → ✅）",
  "- ❌ 标题写「项目概述」 → ✅ 标题写「四条硬规则管住现场」（一句判断）；",
  "- ❌ 一页只有两三条短句 → ✅ 用 `网格要点` 写满 4 块 × 3–4 行（≥12 条）；",
  "- ❌ 编一个「节省 30%」 → ✅ 只写报告里出现过的数字，没有数字就写定性结论；",
  "- ❌ 两页都用同一批块 → ✅ 每页换一批事实，同一件事只说一次；",
  "- ❌ 先讲价值再讲问题 → ✅ 先问题、再方案、最后价值；",
  "- ❌ 写「详见报告第三章」 → ✅ 把那条事实直接写出来。",
];

/** 问题清单 → 提示词里的点对点条目（最多 12 条，太多反而没人看） */
export function pptIssueLines(issues: readonly PptIssue[]): string[] {
  if (issues.length === 0) {
    return [
      "- （上一轮没有判出问题）整体按上面的《大纲质量要求》再过一遍：补强信息量、把标题改成观点句、去掉重复。",
    ];
  }
  return issues.slice(0, 12).map((i) => `- 第 ${i.page} 页${i.code}：${i.detail}`);
}

/** 上一轮的问题（喂进下一轮的生成 / 重试提示词；没有就不加这一节） */
function feedbackSection(issues: readonly PptIssue[]): string[] {
  if (issues.length === 0) return [];
  return [
    "## 上一轮的问题（这一轮必须点对点改掉，别再犯）",
    ...pptIssueLines(issues),
    "",
  ];
}

/** 七个布局各要什么（与契约 `PptPage` 一一对应） */
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

/**
 * 图标清单与用法（变更表 #144）
 *
 * 技能的图标库有 11,631 个 SVG，但**只有清单里的名字确认存在**——名字写错一处，那一处的图标就
 * 静默消失（`finalize_svg.py` 只替换它认得的名字）。所以清单**原样**给模型，并写死兜底与对义提示。
 */
export const PPT_ICON_RULES: readonly string[] = [
  "## 图标（每页都要有；从下面这份清单里挑，一个字母都不要改）",
  `- 清单：${PPT_ICONS.join("、")}。`,
  `- 每一页给一个 \`icon\`（这一页讲什么就给什么，≤1 个）；每个 \`blocks\` / \`columns\` / \`stages\` / \`layers\` / \`cards\` 元素各给一个 \`icon\`（该块讲什么就给什么）；`,
  `  \`table.icons\` 与表头列一一对应（几列就给几个，列讲什么就给什么）。`,
  `- **只能从上面清单里选，选不出就用 \`${PPT_DEFAULT_ICON}\`**；不许自创名字（清单外的名字会被丢掉，那一处就没图标了）。`,
  "- 按意思挑，不要每块都用同一个：台账/清单→file-text、设备→device-desktop、网络→network、云→cloud、服务器→server、",
  "  数据库→database、安全→shield-check、目标→target、路线→route、数据→chart-bar、人员→users、时间→clock、视频→video、",
  "  设置→settings、计划→calendar-check、核对→checkup-list、风险→alert-triangle、增长→trending-up、能力→puzzle、接入→plug、",
  "  移动端→device-mobile、无线→wifi、算力→cpu、实时→activity、调优→adjustments、供电→bolt、公司→building-skyscraper 或 briefcase、",
  "  进出门禁→door-enter / door-exit、音频→headphones 或 microphone、汇报→speakerphone、报表→report-analytics、指标→gauge、",
  "  分流→arrows-split、分工→hierarchy 或 sitemap、完成→circle-check、提示→info-circle 或 bulb、告警→alert-circle。",
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
        icon: "list-check",
        title: "四条硬规则管住现场",
        subtitle: "把口径写进系统，巡检不再靠人记",
        blocks: [
          { head: "设备台账", note: "谁在现场、什么型号", icon: "file-text", lines: ["按区域建台账，逐台贴码", "型号与位置一次录清", "换机改码当场更新"] },
          { head: "巡检任务", note: "照班次自动发单", icon: "calendar-check", lines: ["每班次派发到人", "漏项当场提醒", "完成时间自动留痕"] },
          { head: "异常上报", note: "现场拍照即上报", icon: "alert-triangle", lines: ["异常必传现场照片", "按等级通知到人", "处理过程全程可查"] },
          { head: "数据口径", note: "一处录入全系统共用", icon: "database", lines: ["台账只在一处录入", "报表按同一口径出数", "月度对账有据可依"] },
        ],
        chips: ["扫码巡检", "自动派单"],
        highlight: "口径写进系统，现场按码走",
      },
      {
        layout: "双栏对比",
        kicker: "今天与建成后",
        icon: "arrows-split",
        title: "同一件事两种做法",
        subtitle: "左边是今天的代价，右边是建成后的样子",
        columns: [
          { head: "今天的做法", note: "纸质表单为主", icon: "file-text", lines: ["巡检靠纸质表单，一天一交", "数据事后补录，口径对不上", "异常靠电话上报，常常漏", "月底对账要两天，还常对不上"] },
          { head: "建成后的做法", note: "扫码巡检、自动留痕", icon: "list-check", lines: ["扫码巡检，当场提交", "数据实时入库，口径唯一", "异常自动派单到人", "月底对账当天出，差异可追"] },
        ],
        highlight: "同样的活，换个干法",
      },
      {
        layout: "流程阶段",
        kicker: "推进路径",
        icon: "route",
        title: "四步走到全量覆盖",
        subtitle: "先在一个楼层跑通，再复制到全区",
        stages: [
          { head: "样板层建设", note: "一个楼层先装齐，跑通扫码巡检", icon: "building-community" },
          { head: "单点验证", note: "连续两周比对纸质记录，口径对齐", icon: "checkup-list" },
          { head: "首批复制", note: "按楼层分批上线，每批一周", icon: "devices" },
          { head: "全区推广", note: "剩余楼层按批次推进，逐批验收", icon: "sitemap" },
          { head: "全区运行", note: "全区纳管，报表自动出数", icon: "chart-bar" },
        ],
        highlight: "先跑通一层，再谈全区",
      },
      {
        layout: "表格",
        kicker: "分工与节奏",
        icon: "briefcase",
        title: "谁在哪一步做什么",
        subtitle: "每一行一件交付物，责任到人、节点到周",
        table: {
          head: ["阶段", "做什么", "谁负责", "周期", "验收依据"],
          icons: ["route", "list-check", "users", "clock", "circle-check"],
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
  previousIssues: readonly PptIssue[] = [],
): { system: string; user: string } {
  const system = [
    `你是给《${scenarioName}${kindLabel(kind)}》做汇报 PPT 的排版编辑，读者是客户的业务负责人与决策人。`,
    "你只做一件事：把这份报告压缩成几页**密排、能直接讲**的中间页。",
    "判断标准只有一条：**每一页都要写满有用的话**——读者扫一眼就知道这页在说什么、能不能落地。",
    "",
    "## 页面口径",
    ...PPT_PAGE_RULES,
    "",
    ...PPT_OUTLINE_QUALITY_RULES,
    "",
    ...feedbackSection(previousIssues),
    "## 七种布局怎么用",
    ...PPT_LAYOUT_SPEC,
    "",
    ...PPT_ICON_RULES,
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
 * @param previousIssues 上一轮判出的问题（变更表 #146：带进下一轮，点对点改）
 */
export function buildPptRetryPrompt(
  kind: ReportKind,
  scenarioName: string,
  reason?: string,
  previousIssues: readonly PptIssue[] = [],
): { system: string; user: string } {
  const why = reason ?? "上一次的输出无法解析为 JSON";
  const system = [
    `你上一次给《${scenarioName}${kindLabel(kind)}》的 PPT 大纲不合格：**${why}**。现在只重发那一段 JSON，并按下面两条改。`,
    "",
    "## 这次必须改掉的三件事",
    `- **每一页都写到 ${PPT_LIMITS.minSentencesPerPage} 条以上有效短句**：被点名的页要整页重写，不要只补一句；`,
    `  步骤 / 阶段类内容写成 \`流程阶段\`（${PPT_LIMITS.stages.min}–${PPT_LIMITS.stages.max} 个 \`stages\`，每个都有 \`note\`），表格式内容写成 \`表格\`（带完整 \`table\`）。`,
    `- **给不出某种版式的字段就改用 \`网格要点\` 写满 ${PPT_LIMITS.blocks.count} 块**（每块 ${PPT_LIMITS.blocks.minLines}–${PPT_LIMITS.blocks.maxLines} 行）——`,
    "  **宁可用网格要点写满，也不要再交一页只有两三条的空页**。页数与叙事不变（5–10 页、问题 → 方案 → 价值、无封面目录尾页）。",
    "- **每处内容都要有图标、每页都要有重点**：每一页、每个块 / 栏 / 阶段 / 层 / 卡片 / 表头列都必须给 `icon`（从下面白名单里挑，",
    "  分不清就写 `presentation`）；每页至少 4 处看得出重点（大写数字、关键结论、带数字的成效）。",
    "",
    "## 页面口径（不变）",
    ...PPT_PAGE_RULES,
    "",
    ...PPT_OUTLINE_QUALITY_RULES,
    "",
    ...feedbackSection(previousIssues),
    // 重试也是整页重发，图标清单必须一起带上（否则新写的块又只能回落 presentation）
    ...PPT_ICON_RULES,
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

/** 优化评审的路标（测试据此分辨"生成"与"优化"两步调用） */
export const PPT_REVIEW_PROMPT_MARKER = "## PPT：只输出优化后的完整 JSON（大纲评审）";

/**
 * 优化评审（变更表 #146）：把上一轮的大纲 JSON + 问题清单一起喂进去，要求点对点改
 *
 * 用户定调「优化大纲，然后再优化 PPT」——所以每轮在生成之后**多一次评审调用**：
 *  - **只输出优化后的完整 JSON**（schema 不变、不要围栏、不要解释）；
 *  - **不许删内容**：只能补强 / 改写 / 调序 / 换版式（页数不得减少、块与行只能更密不能更稀）；
 *  - **必须点对点解决列出的每一条问题**（问题都点名到页）。
 * 失败（非 JSON / 报错）时调用方保留生成的那一份，绝不因此丢整轮产物。
 */
export function buildPptOutlineReviewPrompt(args: {
  kind: ReportKind;
  scenarioName: string;
  outline: PptOutline;
  issues: readonly PptIssue[];
  /** 第几轮（写进提示，便于模型知道这是第几次优化） */
  round: number;
}): { system: string; user: string } {
  const { kind, scenarioName, outline, issues, round } = args;
  const system = [
    `你是《${scenarioName}${kindLabel(kind)}》汇报 PPT 的大纲评审。第 ${round} 轮大纲已经生成，`,
    "你的活儿是**把它改到过得了《大纲质量要求》**，然后**只输出优化后的完整 JSON**。",
    "",
    "## 改稿纪律（三条硬规则）",
    "- **只输出优化后的完整 JSON**：整份大纲照原 schema 重发，不要解释、不要 Markdown 围栏、不要前后缀；",
    "- **不许删内容**：只能补强 / 改写 / 调序 / 换版式——页数不得减少，每页的块与行只能更密不能更稀；",
    "- **必须点对点解决下面列出的每一条问题**（每条都点名到页）：信息量不足的页改写成 `网格要点` 写满 4 块，",
    "  标题空泛的页改成一句判断，重复的页换一批事实，数字不在正文的一律换掉或改成定性说法。",
    "",
    ...PPT_OUTLINE_QUALITY_RULES,
    "",
    "## 七种布局怎么用",
    ...PPT_LAYOUT_SPEC,
    "",
    ...PPT_PAGE_RULES,
    "",
    ...PPT_ICON_RULES,
    "",
    ...PPT_JSON_SPEC,
  ].join("\n");
  const user = [
    PPT_REVIEW_PROMPT_MARKER,
    "",
    `## 待优化的大纲（第 ${round} 轮，JSON）`,
    JSON.stringify(outline),
    "",
    `## 必须解决的问题（共 ${issues.length} 条，逐条改掉）`,
    ...pptIssueLines(issues),
    "",
    "只输出 JSON。",
  ].join("\n");
  return { system, user };
}
