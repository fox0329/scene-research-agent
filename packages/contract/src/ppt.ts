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
