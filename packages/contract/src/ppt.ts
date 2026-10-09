/**
 * @scene/contract — PPT 演示大纲契约（变更表 #141 立、#142 升、#144 升）
 *
 * 「导出PPT文档」= 把某一份交付物的正文交给模型产出一份**页面大纲**（本文件定义它的形状），
 * 再由 `@scene/infra` 确定性地渲染成 SVG、由 ppt-master 技能导出 pptx。
 *
 * 分工（AGENTS.md §三.5 高风险判定落确定性层）：
 *  - **模型**只产内容：每页的小节标签、标题、副题、块/栏/阶段/层/卡片/表格/标签、结论带，
 *    以及每处内容配哪个图标（**只能从 `PPT_ICONS` 里选**，选不出就用 `PPT_DEFAULT_ICON`）；
 *  - **契约**定义页面的形状与限额（页码规模、字段长度、各组数量、图标清单）——单一事实源，
 *    提示词、`parsePptOutline` 校验、SVG 渲染、质量门禁四处都读它，避免各写一份；
 *  - **领域层**逐条校验（`parsePptOutline`）；**基础设施层**只负责画与量（禁模型写 SVG）。
 *
 * 页面口径（用户定调）：默认 B 站蓝色模版、白底、**不要封面与尾页**，只有中间页，
 * 全程自动完成，5–10 页（目标 7 页），突出问题 → 方案 → 价值，**每页信息量 ≈ 4 块 × 3–4 行**。
 *
 * 变更表 #144：**用足 ppt-master 的图标库 + 建立颜色层次 + 字内强调**（用户：「没有充分使用
 * PPT Master 的能力吧，图标也没有，颜色层次也不够，重点也不突出」）。图标清单只收
 * `templates/icons/tabler-outline/` 下**逐个验存**的名字，渲染层一律产 `data-icon` 占位，
 * 由导出层在转档前调技能自带的 `finalize_svg.py --only embed-icons fix-rounded` 替换成真实图标。
 *
 * 变更表 #146：**大纲本身要有明确的质量要求**（用户：「不是不满足标准就报错或者什么的，而是
 * 重新从文件提取大纲，优化大纲，然后再优化 PPT，保证高质量」）。两件事落在这里：
 *  - `PPT_OUTLINE_QUALITY`：大纲质量的词表与阈值（观点型标题的禁词与判断词、记忆点字数、
 *    每页信息量、页间重复比对的最小字数、叙事顺序三段的命中词、自包含禁写项）——
 *    **判据在 `@scene/domain` 的 `checkPptOutlineQuality`，提示词与本组常量同源**；
 *  - `PPT_OUTLINE_ROUNDS`：修复闭环的最大轮数（每轮 = 重新提取 → 优化 → 渲染 → 检查）。
 */

/** 七种页面布局：@see docs/PPT输出要求.md §四 */
export const PPT_LAYOUTS = [
  "网格要点",
  "双栏对比",
  "流程阶段",
  "分层架构",
  "数据卡片",
  "表格",
  "要点清单",
] as const;

export type PptLayout = (typeof PPT_LAYOUTS)[number];

/** 缺布局时的默认布局（兜底排版：一页 5–6 行大字） */
export const PPT_DEFAULT_LAYOUT: PptLayout = "要点清单";

/**
 * 旧布局名的兼容映射（变更表 #141 的取值 → #142 的取值）
 *
 * 大纲不落库、每次现产，但模型可能沿用旧口径（也兼容历史提示词缓存），按新布局排而不是丢页。
 */
export const PPT_LAYOUT_ALIASES: Readonly<Record<string, PptLayout>> = {
  要点: "要点清单",
  图文说明: "要点清单",
};

/** ppt-master 技能里的图标库（占位写成 `data-icon="tabler-outline/<名字>"`） */
export const PPT_ICON_LIB = "tabler-outline";

/**
 * 可用图标清单（变更表 #144）
 *
 * **只收 `templates/icons/tabler-outline/` 下逐个确认存在的名字**——写错一个名字，
 * `finalize_svg.py` 会静默跳过（那一页就少一个图标），所以清单本身就是白名单：
 * 领域层与渲染层都按它兜底，清单外的取值一律换成 `PPT_DEFAULT_ICON`。
 *
 * 名字按用途分组（顺序只是可读性，取值即 SVG 文件名）。
 */
export const PPT_ICONS = [
  // 场景与载体
  "presentation",
  "device-desktop",
  "device-mobile",
  "devices",
  "video",
  "headphones",
  "microphone",
  "speakerphone",
  // 网络与平台
  "network",
  "cloud",
  "server",
  "database",
  "wifi",
  "antenna",
  "plug",
  "cpu",
  "settings",
  "adjustments",
  "bolt",
  "activity",
  // 安全与目标
  "shield-check",
  "target",
  "route",
  "gauge",
  "trending-up",
  "chart-bar",
  "report-analytics",
  // 人与协作
  "users",
  "briefcase",
  "building-skyscraper",
  "building-community",
  "door-enter",
  "door-exit",
  // 时间与计划
  "clock",
  "calendar-check",
  "list-check",
  "checkup-list",
  // 结构与关系
  "puzzle",
  "hierarchy",
  "sitemap",
  "arrows-split",
  // 状态与提示
  "bulb",
  "file-text",
  "info-circle",
  "circle-check",
  "alert-circle",
  "alert-triangle",
] as const;

/** 可选图标名（`PPT_ICONS` 的成员；模型给的名字必须先过 `normalizePptIcon`） */
export type PptIcon = (typeof PPT_ICONS)[number];

/** 兜底图标（清单里没有 / 选不出时一律用它：一页至少要有图标，宁可用同一个） */
export const PPT_DEFAULT_ICON: PptIcon = "presentation";

/**
 * 内容文字的最小字号（变更表 #145，用户定调「最小字体可以调大一点」）
 *
 * 渲染层里所有**内容类**文字——正文行、小注、表格格、能力标签、层与阶段说明、清单次要说明、
 * 卡片说明——一律 ≥ 这个值；页脚与页码这类元信息文字允许低一档，但也不低于
 * `PPT_LIMITS.minMetaFontSize`。质量门禁按它判「字号过小」（`packages/infra/src/ppt-quality.ts`）：
 * **这是最低要求，不是建议**——改小它等于降低交付标准。
 */
export const PPT_MIN_FONT = 16;

/**
 * 图标名归一（防错名字，确定性层与渲染层**共用这一处**）
 *
 * 容错两种写法：带库前缀的 `tabler-outline/cloud` 与裸名字 `cloud`；
 * 清单外的取值（含历史遗留的 `device-desktop-video` 这类不存在的名字）一律回落兜底图标。
 */
export function normalizePptIcon(value: unknown): PptIcon {
  const raw = typeof value === "string" ? value.trim() : "";
  const name = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  return (PPT_ICONS as readonly string[]).includes(name) ? (name as PptIcon) : PPT_DEFAULT_ICON;
}

/** 网格要点的一块（2×2 之一） */
export interface PptBlock {
  /** 块头（≤14 字，如「设备台账」） */
  head: string;
  /** 小注（≤24 字，可空） */
  note: string;
  /** 内容行（3–4 条，每条 ≤26 字） */
  lines: string[];
  /** 块头左侧图标（`PPT_ICONS` 里的名字，块头横条上的 28×28 图标） */
  icon: string;
}

/** 双栏对比的一组（两栏并排之一） */
export interface PptColumn {
  /** 栏头（≤14 字） */
  head: string;
  /** 小注（≤24 字，可空） */
  note: string;
  /** 栏内内容行（3–5 条，每条 ≤26 字） */
  lines: string[];
  /** 栏头左侧图标（栏头色块上的 26×26 白图标） */
  icon: string;
}

/** 流程阶段的一个（3–5 个横排之一） */
export interface PptStage {
  /** 阶段名（≤14 字） */
  head: string;
  /** 阶段说明（≤24 字，可空） */
  note: string;
  /** 序号圆点上方的图标（22×22） */
  icon: string;
}

/** 分层架构的一层（3–4 层之一） */
export interface PptLayer {
  /** 层名（≤14 字） */
  head: string;
  /** 层内组件（2–4 个，每个 ≤10 字） */
  items: string[];
  /** 层头左侧图标（26×26） */
  icon: string;
}

/** 数据卡片的一张（值 + 说明） */
export interface PptCard {
  value: string;
  label: string;
  /** 卡片顶部图标（28×28，居中） */
  icon: string;
}

/** 表格页的一张表（≤6 行 × ≤5 列） */
export interface PptTable {
  head: string[];
  rows: string[][];
  /** 每个表头格左侧的小图标（与列一一对应，表头色块上的 14×14 白图标） */
  icons: string[];
}

/** 一页（不要封面、不要目录、不要尾页：`pages[0]` 就是第一张内容页） */
export interface PptPage {
  layout: PptLayout;
  /** 小节标签（左上胶囊，≤8 字，如「项目硬规则」） */
  kicker: string;
  /** 小节标签左侧的页图标（22×22，`PPT_ICONS` 里的名字，每页 ≤1 个） */
  icon: string;
  /** 页面标题（≤20 字） */
  title: string;
  /** 一句副题（标题下一行，≤32 字；替代旧 `takeaway`） */
  subtitle: string;
  /** 网格要点：**恰好 4 块**（2×2）；其它布局为空数组 */
  blocks: PptBlock[];
  /** 双栏对比：恰好 2 组；其它布局为空数组 */
  columns: PptColumn[];
  /** 流程阶段：3–5 个；其它布局为空数组 */
  stages: PptStage[];
  /** 分层架构：3–4 层；其它布局为空数组 */
  layers: PptLayer[];
  /** 数据卡片：3–4 张；其它布局为空数组 */
  cards: PptCard[];
  /** 表格页的表；非表格页为 null */
  table: PptTable | null;
  /** 技术 / 能力标签（0–5 个，每个 ≤10 字） */
  chips: string[];
  /** 底部结论带（每页都要有，一句话 ≤34 字） */
  highlight: string;
  /** @deprecated #141 旧字段：只作 `subtitle` 缺失时的回退来源 */
  takeaway?: string;
  /** @deprecated #141 旧字段：只作 `blocks` 缺失时的回退来源（转成 1–2 块 / 要点清单） */
  bullets?: string[];
}

/** 一份 PPT 的大纲（模型只输出这个 JSON） */
export interface PptOutline {
  pages: PptPage[];
}

/**
 * 页面与字段限额（确定性层按它 clamp / 截断，渲染层按它排版，质量门禁按它判密度）
 *
 * 这些值是「读者在 1280×720 屏幕上能一眼看完」的上限，不是建议：
 * 超了由 `parsePptOutline` 确定性截断，绝不让模型自由发挥。
 */
export const PPT_LIMITS = {
  /** 页数下限：少于这个数说明模型没按口径写（无法凭空造页，领域层只记录提示） */
  minPages: 5,
  /** 页数上限：超了截掉尾部页面 */
  maxPages: 10,
  /** 目标页数（进提示词） */
  targetPages: 7,
  /** 小节标签 ≤ 8 字 */
  kickerChars: 8,
  /** 标题 ≤ 20 字 */
  titleChars: 20,
  /** 一句副题 ≤ 32 字 */
  subtitleChars: 32,
  /** 底部结论带 ≤ 34 字（每页都要有一条） */
  highlightChars: 34,
  /** 网格要点：**恰好 4 块**（2×2）；块头 ≤14、小注 ≤24、每块 3–4 行、每行 ≤26 */
  blocks: {
    count: 4,
    min: 3,
    headChars: 14,
    noteChars: 24,
    minLines: 3,
    maxLines: 4,
    lineChars: 26,
  },
  /** 双栏对比：恰好 2 组；栏头 ≤14、小注 ≤24、每组 3–5 行、每行 ≤26 */
  columns: {
    count: 2,
    headChars: 14,
    noteChars: 24,
    minLines: 3,
    maxLines: 5,
    lineChars: 26,
  },
  /** 流程阶段：3–5 个；阶段名 ≤14、说明 ≤24 */
  stages: { min: 3, max: 5, headChars: 14, noteChars: 24 },
  /** 分层架构：3–4 层；层名 ≤14、每层 2–4 个组件、组件 ≤10 */
  layers: { min: 3, max: 4, headChars: 14, minItems: 2, maxItems: 4, itemChars: 10 },
  /** 数据卡片：3–4 张，值 ≤8 字、说明 ≤14 字 */
  cards: { min: 3, max: 4, valueChars: 8, labelChars: 14 },
  /** 表格：≤6 行 × ≤5 列，表头 ≤8 字、单元格 ≤20 字 */
  table: { maxRows: 6, maxCols: 5, headChars: 8, cellChars: 20 },
  /** 要点清单（兜底）：3–6 行、每行 ≤26 字 */
  bullets: { min: 3, max: 6, chars: 26 },
  /** 技术/能力标签：0–5 个、每个 ≤10 字 */
  chips: { max: 5, chars: 10 },
  /** 内容量硬要求：每页至少 12 条有效短句（进提示词，也是质量门禁的判据） */
  minSentencesPerPage: 12,
  /** 内容文字最小字号（= `PPT_MIN_FONT`；渲染层与质量门禁同源） */
  minFontSize: PPT_MIN_FONT,
  /** 页脚 / 页码这类元信息文字的最小字号（内容一律 ≥ `minFontSize`） */
  minMetaFontSize: 15,
} as const;

/**
 * 一条"点名到页"的问题（变更表 #146）
 *
 * 大纲质量判据（`@scene/domain` 的 `checkPptOutlineQuality`）与版面质量门禁
 * （`@scene/infra` 的 `checkPptDeck`）产出**同一种形状**，导出编排才能把两份问题清单
 * 合成一条反馈喂给下一轮（"第 N 页 + 问题码 + 人话说明"）。
 */
export interface PptIssue {
  /** 第几页（1 起） */
  page: number;
  /** 问题码（中文短词，能直接进 notice 与提示词） */
  code: string;
  /** 人话说明（带具体数字，便于定位） */
  detail: string;
}

/**
 * 中文数字的字（变更表 #151）
 *
 * 覆盖 `一–九`、`十百千万`、`两 / 俩`（= 2）、`半`。**不收 `零`**：「零故障」「零和」这类词
 * 太常见，收了只会制造误报（宁可漏判也不误报）。`分` 也不收——它只在「三分之一」这种
 * 分数式里才出现，而分数由 `numberCnPattern` 的第一支单独处理（收了「分」就会把
 * 「十分重视」当数字）。
 */
const CN_NUMERAL = "[一二三四五六七八九十百千万两俩半]+";

/**
 * 中文数字后面必须跟上的语境（量词 / 单位 / `成` / `倍`），变更表 #151
 *
 * **多字单位排在前**（`分钟` / `小时` 整词收，`分` / `时` 单字不收）：`分` 单收会把
 * 「十分重视」变成数字；`分钟` 整词收则「十分钟」照样判。`元` 收，但光杆的
 * `万元` 由 `cnNumeralOk` 挡住（数字部分必须含 `一–九/两/俩/半`，或正好是 `十`）。
 */
const CN_UNITS = [
  "小时",
  "分钟",
  "公里",
  "成",
  "倍",
  "个",
  "台",
  "间",
  "天",
  "周",
  "月",
  "年",
  "万",
  "亿",
  "元",
  "次",
  "人",
  "张",
  "条",
  "层",
  "块",
  "列",
  "行",
  "页",
  "项",
  "套",
  "辆",
  "米",
  "户",
  "家",
  "所",
  "种",
  "类",
  "份",
  "组",
  "批",
  "级",
  "处",
  "件",
  "度",
  "步",
  "轮",
  "名",
  "位",
  "款",
  "只",
  "支",
  "座",
] as const;

/**
 * 大纲的质量要求（变更表 #146）
 *
 * 用户定调：**PPT 大纲本身要有质量要求，不能只是几条原则**（「要像 B 站 PPT 大纲生成的技能要求
 * 一样有明确的生成要求」）。本组常量是**唯一来源**：
 *  - `@scene/domain` 的 `checkPptOutlineQuality` 按它逐条判定（确定性层，可单测、可审计）；
 *  - `apps/server/src/ppt-prompt.ts` 把同一批词表与阈值**逐字**写进提示词（模型与判据同源）；
 *  - `docs/PPT输出要求.md` §八 是本组的散文版本。
 *
 * 改这里等于改交付标准：只许收紧，不许放宽。
 */
export const PPT_OUTLINE_QUALITY = {
  /** 一句话说明这组常量的性质（防止以后被悄悄关掉） */
  note: "PPT 大纲的质量要求（变更表 #146，用户定调）：判据在 @scene/domain 的 checkPptOutlineQuality，只许收紧不许放宽",
  /**
   * ① 观点型标题：**章节式空词**——标题只是"现状 / 概述 / 背景"这类章节名就判不合格
   *
   * 命中词之后再看长度：标题短于 `weakTitleShortChars`，或去掉空词后剩不下几个字
   * （`weakTitleRestChars`），才判弱；像「现状不改，代价只会更高」这种带判断的长句放行。
   */
  weakTitleWords: [
    "现状",
    "概述",
    "背景",
    "介绍",
    "说明",
    "概况",
    "总览",
    "小结",
    "前言",
    "引言",
    "总结",
    "回顾",
    "复盘",
    "摘要",
    "导语",
  ] as const,
  /** 命中空词后，标题短于这个字数一律判弱 */
  weakTitleShortChars: 8,
  /** 命中空词后，去掉空词还剩不到这个字数也判弱（标题基本就是章节名） */
  weakTitleRestChars: 4,
  /**
   * ① 观点型标题：**判断语气**（含动词 / 判断词即可，不做过度 NLP）
   *
   * 判定就是"标题里有没有这些词之一"——词表**宁宽不严**（宁可放过一句平庸的标题，
   * 也不误杀一句好标题）；连带数字的标题（如「四步走到全量覆盖」之外的「3 周上线」）也算有判断。
   * 同一张词表也被 ⑤ 判"这一条像不像一句话"复用（变更表 #146 补充）。
   */
  judgmentWords: [
    // 情态与判断
    "是",
    "要",
    "须",
    "需",
    "应",
    "能",
    "可",
    "会",
    "不",
    "未",
    "无",
    "有",
    "把",
    "让",
    "使",
    "靠",
    "将",
    "该",
    "才",
    "就",
    "只",
    // 动作与结果（多字）
    "管住",
    "写进",
    "落到",
    "统一",
    "打通",
    "兼容",
    "替代",
    "承载",
    "完成",
    "解决",
    "避免",
    "减少",
    "增加",
    "提升",
    "降低",
    "节省",
    "缩短",
    "消除",
    "建立",
    "构建",
    "形成",
    "支撑",
    "覆盖",
    "纳管",
    "对齐",
    "收敛",
    "移交",
    "复用",
    "推广",
    "试点",
    "验证",
    "复制",
    "上线",
    "归档",
    "留痕",
    "派单",
    "上报",
    "核算",
    "对账",
    "巡检",
    "录入",
    "采集",
    "拆分",
    "合并",
    "分级",
    "分派",
    "分工",
    "协同",
    "联动",
    "监控",
    "预警",
    "沉淀",
    "迭代",
    "优化",
    "重构",
    "升级",
    "做法",
    "步骤",
    "路径",
    "账本",
    "台账",
    "采用",
    "支持",
    "负责",
    "实现",
    // 动作（单字，宁宽不严）
    "换",
    "走",
    "做",
    "用",
    "建",
    "定",
    "给",
    "增",
    "减",
    "降",
    "提",
    "省",
    "免",
    "统",
    "打",
    "覆",
    "替",
    "缩",
    "消",
    "控",
    "治",
    "接",
    "调",
    "核",
    "录",
    "采",
    "派",
    "管",
    "落",
    "写",
    "压",
  ] as const,
  /** ② 记忆点（`highlight`）最多几个字（= `PPT_LIMITS.highlightChars`，每页必须有一条） */
  highlightChars: PPT_LIMITS.highlightChars,
  /** ③ 每页最少几条有效短句（结构上限不足的版式按"写满"算，见 `pptLayoutSentenceMax`） */
  minSentencesPerPage: PPT_LIMITS.minSentencesPerPage,
  /**
   * ④ 数字可溯源：正文里找不到的数字就是编造
   *
   * 这是**硬判据**（变更表 #146 改口径：宁可多报一处，也不许把编造的数字送给客户）；
   * 比对前把全角数字折成半角、去掉空白，整数还接受报告里的中文数字写法（8 ↔ 八）。
   */
  numberPattern: "\\d+(?:\\.\\d+)?",
  /**
   * ④ 数字可溯源：**中文数字也算数字**（变更表 #151）
   *
   * 原来只查阿拉伯数字，「三成」「五类」「两倍」「三分之一」这类写法能溜过去（正文里根本没有的
   * 说法也会上 PPT）。本式按**语境**提取"像数值"的中文数字，三个分支（括号是捕获组，领域层用
   * 它们取数字部分做"像不像一个数"的判定）：
   *  ① 分数 / 百分比：`三分之一`、`百分之三十`（`分之` 是明确的数学语境，一律算数）；
   *  ② 数字 + 量词 / 单位 / 成 / 倍：`三成`、`五类`、`十二项`、`两倍`、`半小时`、`三十万`；
   *  ③ 光杆数字里的**规范写法**：`十二`、`三十`、`三十五`、`一百`、`两千`、`三万`。
   *
   * 反例（一个都不许命中，见 `apps/.../ppt-outline.test.ts` 的反例清单）：`一致` / `统一` /
   * `一起` / `一线` / `十分` / `一线品牌` / `万元` / `千万不要` / `百般` / `一成不变` / `一度`——
   * 挡住它们的是三条**语境门槛**，不是词表：① 后面必须跟量词 / 成 / 倍；② 光杆只认规范写法；
   * ③ 数字部分必须含 `一–九/两/俩/半`，或正好是 `十`（光杆的 `十/百/千/万` 是"单位词"，不算数）。
   * 取舍仍是**宁可漏判也不误报**：每误报一次 PPT 白跑一轮（2–3 分钟）。
   */
  numberCnPattern: `(${CN_NUMERAL})分之(${CN_NUMERAL})|(${CN_NUMERAL})(?:${CN_UNITS.join("|")})|(?:[一二三四五六七八九两]十[一二三四五六七八九]?|十[一二三四五六七八九]|[一二三四五六七八九两][百千万][一二三四五六七八九十百千万]*)`,
  /** ④ 数字可溯源：中文数字后面算数的量词 / 单位（与 `numberCnPattern` 同源，进提示词） */
  numberCnUnits: CN_UNITS,
  /** ⑤ 页间不重复：归一化后短于这个字数的句子不参与比对（"今天""建成后"这类短语允许重名） */
  duplicateMinChars: 6,
  /** ⑤ 页间不重复：同一页最多报几条重复（免得一条重复刷满问题清单） */
  duplicatePerPage: 3,
  /**
   * ⑤ 页间不重复：**只有"像一句话"的重复才判**（变更表 #146 补充）
   *
   * 真跑误报：「人体存在传感器」这类**专有名词**在第 4 页讲建设内容、第 5 页讲设备清单时各提一次，
   * 完全正常，却被当成"两页说了同一件事"。所以重复项必须满足任一条才算句子：
   * ① 含标点（`duplicatePunct`）；② 归一化后 ≥ `duplicateSentenceMinChars` 字；
   * ③ 含 `judgmentWords` 里**两个字以上**的判断/动作词。纯名词/动作短语一律不判。
   *
   * ③ 之所以限定「两个字以上」（变更表 #146 补充 2）：`judgmentWords` 里的单字动词（走 / 用 / 定 / 核…）
   * 是为**标题**判定收的"宁宽不严"，拿来判句子里会误命中——真跑报过「人走自动释放」（命中「走」）这种
   * 6 字动作短语。判句子的词只能取多字的（写进 / 打通 / 采用 / 支持…）。
   */
  duplicatePunct: "，。；：、",
  /**
   * ⑤ 页间不重复：归一化后到这个字数就算"像一句话"（不再要求有标点或动词）
   *
   * 用户定调 2026-10-08（变更表 #146 补充 4）：**11 字判断句跨页复述可以接受，≥14 字才算整句重复**——
   * 门槛定 10 字时真跑报过「端层不开放第三方认证」（11 字）这种跨页复述，白跑一轮。
   * 阈值只是三条判据之一，另两条（含标点 / 含两个字以上的判断动作词）**保持不变**，任一命中即判。
   */
  duplicateSentenceMinChars: 14,
  /**
   * ⑥ 叙事顺序：页按「现状与问题 → 方案与建设 → 价值与收益」排
   *
   * 归类**只看 `kicker`**（模型给这一页定的栏目名，最可靠），`kicker` 归不进才看 `title`；
   * `subtitle` / `highlight` / 块内容一律不参与——真跑被它们坑过：一页标题写「四类问题一起解决」
   * 被当成"问题页"、末页写「把机制用起来，问题不回潮」被当成"问题页"（变更表 #146 补充 2）。
   * 另外判定是**等值或以该词开头**，不是"出现过"：「把机制用起来」不含首词，不归类。
   */
  narrative: [
    {
      label: "现状与问题",
      words: ["现状", "问题", "痛点", "挑战", "难点", "风险", "代价"],
    },
    {
      label: "方案与建设",
      words: ["方案", "建设", "架构", "路径", "做法", "内容", "安排"],
    },
    {
      label: "价值与收益",
      words: ["价值", "收益", "成效", "效果", "回报"],
    },
  ] as const,
  /**
   * ⑥ 叙事顺序：**末页豁免组**（展望 / 保障 / 下一步 / 监管 / 协同）
   *
   * 末页收尾本来就会回望问题（「问题不回潮」「风险可控」），把它算成"问题页"排到方案页后面
   * 是纯误报；末页归到这一组就整页不参与顺序判定（变更表 #146 补充 2）。
   */
  narrativeClosing: {
    label: "收尾与保障",
    words: ["展望", "保障", "下一步", "监管", "协同"],
  },
  /**
   * ⑦ 自包含：这些词一旦出现，说明大纲在"指别人去看原文"，PPT 是独立文件，一律不许写
   *
   * 注意「目录」**不在这里**（变更表 #146 补充）：报告正文里它常是正当内容词
   * （「按客户信创目录逐项核定」「设备目录」），只在它充当**一页的结构性标签**时才算禁语，
   * 见 `selfContainedDirLabels` / `dirLabelMaxChars`。
   */
  selfContainedBanned: [
    "参考正文",
    "详见正文",
    "见正文",
    "见报告",
    "参考原文档",
    "参考源文件",
    "待客户提供",
    "待补齐",
    "建议采用",
    "谢谢观看",
  ] as const,
  /**
   * ⑦ 自包含：**结构性标签**（不是子串）——页面的框（kicker / title / subtitle / highlight）
   * 去空白后等于下面任一个，或以「目录」结尾且总长 ≤ `dirLabelMaxChars`，才算"这是目录页"
   */
  selfContainedDirLabels: ["目录", "内容目录", "本页目录", "本期目录", "本章目录"] as const,
  /** ⑦ 自包含：以「目录」结尾的结构性标签最多几个字（「内容目录」4 字算，「按客户目录逐项核定」11 字不算） */
  dirLabelMaxChars: 6,
  /** ⑧ 图标与版式：白名单外的图标名一律不合格（渲染前就被 `normalizePptIcon` 兜掉，这里是判据） */
  iconWhitelist: PPT_ICONS,
  /**
   * ⑧ 图标与版式：**同一页不许重复使用同一个图标**（变更表 #151）
   *
   * 用户原本要的是"图标与该字段 / 标题的关键词完全不匹配时报出来"，但"图标含义贴不贴切"没有
   * 可靠判定依据（读不了图、也没有公认的对义表），硬做只会制造误报、让 PPT 白跑轮次。所以换成
   * 这条**客观可判**的：一页里两个元素用同一个图标名 = 单调且失去区分度，命中报 `图标重复`，
   * detail 点名页码与图标名。判在**大纲阶段**（`checkPptOutlineQuality`）——图标名在大纲里就有，
   * 渲染层只是照抄，等渲染完再判是同一件事判两遍。
   *
   * 「一页的图标数不得少于该页元素数」**不单列**：领域层 `iconOf` 会给每个元素兜一个图标
   * （缺 / 写错 → `PPT_DEFAULT_ICON`），渲染层还会画页图标与结论带 `bulb`，所以"每页图标数 ≥
   * 元素数"在结构上必然成立（是条永远判不出的空判据）；可达的那条线是渲染门禁的
   * `PPT_MIN_QUALITY.minIconsPerPage`（每页 ≥4 个图标），见 `packages/infra/src/ppt-quality.ts`。
   */
  iconReuseBanned: true,
} as const;

/**
 * 大纲修复闭环的最大轮数（变更表 #146）
 *
 * 用户定调：**不满足标准不报错**，而是「重新从文件提取大纲，优化大纲，然后再优化 PPT，保证高质量」。
 * 每轮 = 重新读正文 → 生成大纲 → 优化大纲（一次评审调用）→ 渲染 → 检查；上一轮的全部问题
 * 带进下一轮。三轮都过不了就按"问题最少的那一轮"照常导出 + notice 点名，**不拒绝写出、不阻断**。
 */
export const PPT_OUTLINE_ROUNDS = 3;
