/**
 * PPT 生成标准（产品内唯一事实源）
 *
 * 为什么单独成模块：这套标准此前散在提示词、渲染常量、门禁代码、`docs/PPT输出要求.md` 四处，
 * 改一处容易漏三处（#249 就踩过：模版字号进了渲染、忘了同步门禁）。现在把
 * **生成要求 / 版式标准 / 注意事项 / 输出检查门限** 收成一份可被代码引用的数据：
 * 提示词从这里取"注意事项"，门禁的每个 code 都必须在这里登记（单测逐条比对源码），
 * 文档只解释、不复述数字。
 *
 * 数值本身仍以 `PPT_LIMITS` / `PPT_TEMPLATE` / `PPT_MIN_QUALITY` / `PPT_QUALITY` 为准，
 * 这里只引用，不复制字面量。
 */
import { PPT_LIMITS, PPT_MIN_FONT, PPT_OUTLINE_QUALITY, PPT_TEMPLATE } from "./ppt.js";

/** 一条生成要求：做什么 + 为什么（`why` 会进提示词，模型靠它判断边界） */
export interface PptGenerationRule {
  id: string;
  rule: string;
  why: string;
}

/**
 * 生成要求（结构 / 叙事 / 密度 / 措辞）
 *
 * 用户定调：以 `PPT模版.pptx` 为质量基线，产出「不能低于模版」（变更表 #249）。
 */
export const PPT_GENERATION_RULES: readonly PptGenerationRule[] = [
  {
    id: "pages",
    rule: `整份 ${PPT_LIMITS.minPages}–${PPT_LIMITS.maxPages} 页，目标 ${PPT_LIMITS.targetPages} 页；第 1 页必须是「${PPT_OUTLINE_QUALITY.coverLayout}」`,
    why: "模版 6 页 5 种结构；少于 6 页讲不清「问题 → 方案 → 价值」，多于 15 页读者记不住",
  },
  {
    id: "narrative",
    rule: "顺序固定：现状与问题 → 方案与建设内容 → 价值与下一步",
    why: "读者的决策顺序是先认问题、再看怎么干、最后看值不值；倒过来就成了自说自话",
  },
  {
    id: "density",
    rule: `正文每页 ≥ ${PPT_LIMITS.targetSentencesPerPage} 条有效短句；结构上写不满的版式（流程 / 卡片 / 清单）按各自上限「写满」算`,
    why: `模版内容页实测 29–57 条文字；我们低于 16 条时页面必然发空（#250 实跑：双栏 4 行撑 450 高的卡就是"卡片大、留白多"）`,
  },
  {
    id: "variety",
    rule: `整份 ≥ ${PPT_OUTLINE_QUALITY.minLayoutVariety} 种结构，同一种最多连续 ${PPT_OUTLINE_QUALITY.maxLayoutRun} 页`,
    why: "一页一个版式节奏，读者才分得清「这是问题、这是架构、这是路线」；连排同版式等于把三页压成一页",
  },
  {
    id: "cover",
    rule: `封面写满：${PPT_LIMITS.blocks.count} 张能力卡（讲什么 / 凭什么 / 给客户什么）+ 3 步落地链 + \`chips\` + 一句话总结`,
    why: "模版的封面本身就是一页内容页，不是空扉页；读者只看第一页也要知道我们卖什么（#253 显式覆盖 #141「不要封面」）",
  },
  {
    id: "truth",
    rule: "数字只许来自报告正文；没有的写「未知」，不许编数字、编厂商、编案例",
    why: "方案是给客户看的，一处编造被追问就整份失信；「未知」是合法的交付状态",
  },
  {
    id: "one-thing",
    rule: "一页只说一件事；同一句话不许出现在两页；标题是一句判断，不是「现状 / 概述 / 背景」这类章节名",
    why: "标题写章节名，读者看完不知道结论是什么；两页说同一件事，说明有一页是凑的",
  },
  {
    id: "copy",
    rule: `标题 ≤ ${PPT_LIMITS.titleChars} 字、副题 ≤ ${PPT_LIMITS.subtitleChars} 字、一句话总结 ≤ ${PPT_LIMITS.highlightChars} 字；不许指代（见正文 / 详见报告）与元话（待客户提供 / 建议采用）`,
    why: "PPT 是被单独翻看的，任何指代都会变成读者找不到的东西",
  },
  {
    id: "no-toc",
    rule: "不做目录页、不做「谢谢 / 结束」尾页",
    why: "6–15 页的篇幅，目录占一页就是浪费；结尾用「下一步」收，不用客套",
  },
  {
    id: "textbox",
    rule: "一条内容 = 一个文本框（含它换行后的续行）；**不同内容各自一个文本框，不许合并**",
    why: "用户定调（#251）：合并不同条目会让两条内容挤成一句，也没法单独挪；一条一个框才便于后期自己调整",
  },
];

/** 一种版式的标准（几何 + 容量 + 读者看到的样子） */
export interface PptLayoutStandard {
  layout: string;
  /** 几何：写给人看的具体值（px，画布 1280×720） */
  geometry: string;
  /** 容量：能装多少内容 */
  capacity: string;
  /** 读者应该看到的效果 */
  reads: string;
}

/** 版式标准（与渲染层 `ppt-svg.ts` 的常量一一对应） */
export const PPT_LAYOUT_STANDARDS: readonly PptLayoutStandard[] = [
  {
    layout: "封面",
    geometry: "标题 32px @(80,72)；4 张能力卡 546×148 排 2×2（x=80/654，y=150/314）；3 步链 y=486、高 64；标签行 y=570；总结 y=654",
    capacity: `4 块 × 2 行 + 3 步 + ≤${PPT_LIMITS.chips.max} 个标签 + 1 句总结`,
    reads: "第一页就把四个卖点和落地路径摆出来，不是一张只有标题的扉页",
  },
  {
    layout: "网格要点",
    geometry: "4 块 550×216 @ x=80/650、y=170/400；块间 1px 细线；块头横条 34px",
    capacity: `${PPT_LIMITS.blocks.count} 块 × ${PPT_LIMITS.blocks.minLines}–${PPT_LIMITS.blocks.maxLines} 行`,
    reads: "2×2 四象限，块头一句话 + 小注 + 三条支撑",
  },
  {
    layout: "双栏对比",
    geometry: "两栏各 550 宽 @ x=80/650；**卡高按内容定（300–450）**并整体竖直居中；行距 32–46px 均分，行间 1px 细线",
    capacity: `${PPT_LIMITS.columns.count}–${PPT_LIMITS.columns.max} 栏 × ${PPT_LIMITS.columns.minLines}–${PPT_LIMITS.columns.maxLines} 行`,
    reads: "左右对照（今天 / 建成后），行是清单不是散句；内容少时卡也跟着缩，不留半页空白",
  },
  {
    layout: "流程阶段",
    geometry: "3–5 段等分横排，段间 28px；卡高按内容 220–270 并居中；**3px 横轨**贯穿（画在卡下、间隙露出）+ 间隙里 9×9 箭头",
    capacity: `${PPT_LIMITS.stages.min}–${PPT_LIMITS.stages.max} 段，每段 head + note`,
    reads: "一条时间轴串起来的阶段，不是几个互不相干的卡片加大三角",
  },
  {
    layout: "分层架构",
    geometry: "3–5 层横条 1120×72，间距 20px，整组竖直居中",
    capacity: `${PPT_LIMITS.layers.min}–${PPT_LIMITS.layers.max} 层 × ${PPT_LIMITS.layers.minItems}–${PPT_LIMITS.layers.maxItems} 个组件`,
    reads: "自上而下的能力栈（采集 / 网络 / 平台 / 应用），每层标出组件",
  },
  {
    layout: "数据卡片",
    geometry: "3–4 张等分卡片，整组竖直居中；**卡片右上 01–04 序号**（模版矩阵编号做法）",
    capacity: `${PPT_LIMITS.cards.min}–${PPT_LIMITS.cards.max} 张（数值 + 说明）`,
    reads: "几个硬指标一眼扫完（质保 / 响应 / 可用率），有编号便于口头引用",
  },
  {
    layout: "表格",
    geometry: "表头 52px，行高按行数摊开并整表居中，列宽按内容比例分配",
    capacity: `≤${PPT_LIMITS.table.maxRows} 行 × ≤${PPT_LIMITS.table.maxCols} 列`,
    reads: "只有真需要逐项对齐时才用表；能用图说的不用表",
  },
  {
    layout: "要点清单",
    geometry: "3–6 行，行高按条数摊开，整组竖直居中",
    capacity: `${PPT_LIMITS.bullets.min}–${PPT_LIMITS.bullets.max} 条`,
    reads: "兜底版式：宁可清单写满，也不交只有两三条的空页",
  },
];

/** 注意事项：踩过的坑与边界（提示词只取 `model: true` 的几条） */
export interface PptCaution {
  id: string;
  note: string;
  /** 是否要喂给模型（模型能影响的才给，渲染/工程细节不给） */
  model: boolean;
}

/** 注意事项（每条都对应一次实跑或用户反馈） */
export const PPT_CAUTIONS: readonly PptCaution[] = [
  {
    id: "no-padding",
    note: `写不满 ${PPT_LIMITS.targetSentencesPerPage} 条时换版式或把话说细，**不许用编造的数字/厂商凑密度**；确实没有就写「未知」`,
    model: true,
  },
  {
    id: "structure-fit",
    note: "先想清楚这页要读者记住哪一句，再挑版式；挑错版式（比如三段流程写成表格）会让读者多花一倍时间",
    model: true,
  },
  {
    id: "no-repeat",
    note: "两页说同一件事时，删掉弱的那页，不要换个说法再讲一遍",
    model: true,
  },
  {
    id: "one-box",
    note: "一条内容一个文本框；不同条目不许并进同一个框（合并后两条内容会连成一句，也没法单独挪）",
    model: false,
  },
  {
    id: "no-empty-card",
    note: "双栏卡片高度随内容走，不许再用固定大卡撑版面；内容少就说明这一页该换版式",
    model: false,
  },
  {
    id: "rail-not-arrow",
    note: "流程要「一条轨 + 小箭头」：只有大三角没有连线，读者看不出先后关系，箭头也不该比卡片抢眼",
    model: false,
  },
  {
    id: "font-floor",
    note: `内容字号 ≥${PPT_MIN_FONT}px（模版 11.25pt）、小节标签/页脚 ≥${PPT_LIMITS.minMetaFontSize}px（模版 10.5pt）；调小字号来塞内容一律不合格`,
    model: false,
  },
  {
    id: "gate-not-block",
    note: "门禁不通过**不阻断导出**：最多三轮「重读正文 → 重写大纲 → 重渲染 → 再检查」，仍未全过就取问题最少的一轮照常导出 + notice 点名；只有「三轮都解析不出大纲」「转档失败」不产文件",
    model: false,
  },
  {
    id: "density-bar",
    note: `版面门禁的密度下限是每页 ${PPT_OUTLINE_QUALITY.minContentPageSentences}/${PPT_LIMITS.minSentencesPerPage} 条（含 6 条固定骨架），大纲要求更高（${PPT_LIMITS.targetSentencesPerPage} 条）；卡片/表格这类结构上到不了 16 条的按结构上限判，不许为了达标硬凑`,
    model: false,
  },
  {
    id: "template-gate-scope",
    note: "「缺封面 / 版式单一 / 版式重复」只对 ≥6 页的成稿判——少于 6 页本身已经被页数下限点名，不重复罚",
    model: false,
  },
];

/** 门禁层级：大纲（模型输出）还是版面（渲染产物） */
export type PptGateLayer = "outline" | "render";

/** 一条输出检查门限 */
export interface PptGateThreshold {
  code: string;
  layer: PptGateLayer;
  /** 判定线（带具体数值） */
  threshold: string;
  /** 判出来之后走哪条路 */
  action: string;
}

/**
 * 输出检查门限总表（每个会被判出来的 code 都必须在这里）
 *
 * 单测 `ppt-standard.test.ts` 会扫 `ppt-quality.ts` / `ppt-outline.ts` 源码里的
 * `code: "…"` 字面量，缺一条就红——门禁加了新判据却忘了写进标准，在这里拦。
 */
export const PPT_GATE_THRESHOLDS: readonly PptGateThreshold[] = [
  // ── 版面（渲染产物，`ppt-quality.ts`） ──
  { code: "信息量不足", layer: "render", threshold: `每页非空文字 < ${PPT_LIMITS.minSentencesPerPage} 条`, action: "点名到页，重试一次大纲" },
  { code: "图标不足", layer: "render", threshold: `每页图标 < 3 个`, action: "点名到页，重试一次大纲" },
  { code: "重点不突出", layer: "render", threshold: "每页强调 < 3 处（字内强调段 + ≥15px 粗体）", action: "点名到页，重试一次大纲" },
  { code: "字号过小", layer: "render", threshold: `内容 < ${PPT_MIN_FONT}px、元信息 < ${PPT_LIMITS.minMetaFontSize}px（小节标签/页脚/页码豁免）`, action: "渲染层 bug：只 warn，照样导出" },
  { code: "超出安全边", layer: "render", threshold: "文字或图形距画布四边 < 40px", action: "渲染层 bug：只 warn" },
  { code: "文本相交", layer: "render", threshold: "两段文字两个方向重叠都 > 4px", action: "渲染层 bug：只 warn" },
  { code: "文本越界", layer: "render", threshold: "文字估算宽度超出画布或所在容器", action: "渲染层 bug：只 warn" },
  { code: "未对齐网格", layer: "render", threshold: `偏差 > 2px（块 550×216、栏宽 550 高 ${"300–450"}、层/清单/表格 1120、卡片与阶段等分）`, action: "渲染层 bug：只 warn" },
  { code: "留白不均", layer: "render", threshold: `内容区底部空白 > 120px`, action: "渲染层 bug：只 warn" },
  { code: "行首标点", layer: "render", threshold: "任何一行以「，。、；：！？」）》」开头", action: "渲染层 bug：只 warn" },
  { code: "孤字行", layer: "render", threshold: `换行后末行 < 3 个字`, action: "渲染层 bug：只 warn" },
  { code: "颜色层次不足", layer: "render", threshold: `每页不同颜色 < 5 种`, action: "渲染层 bug：只 warn" },
  { code: "缺小节标签", layer: "render", threshold: "缺 `kicker` 行（页图标 + 小节小字）", action: "渲染层 bug：只 warn" },
  { code: "缺一句话总结", layer: "render", threshold: "缺底部 `highlight` 一行", action: "渲染层 bug：只 warn" },
  { code: "缺页码", layer: "render", threshold: "缺页脚右侧 `NN / MM`", action: "渲染层 bug：只 warn" },
  { code: "缺封面", layer: "render", threshold: `第 1 页缺封面（${PPT_LIMITS.blocks.count} 张能力卡 + 3 步链）`, action: "点名到页，重试一次大纲" },
  { code: "页面太空", layer: "render", threshold: "整页形状数低于下限（拆句后文字被合并的情形容错）", action: "渲染层 bug：只 warn" },

  // ── 大纲（模型输出，`ppt-outline.ts`） ──
  { code: "非观点型标题", layer: "outline", threshold: "标题是章节名（现状/概述/背景…）或 ≤8 字无判断词", action: "进下一轮反馈" },
  { code: "标题超长", layer: "outline", threshold: `标题 > ${PPT_LIMITS.titleChars} 字（截断后判）`, action: "进下一轮反馈" },
  { code: "缺记忆点", layer: "outline", threshold: `缺 \`highlight\` 或 > ${PPT_LIMITS.highlightChars} 字`, action: "进下一轮反馈" },
  { code: "信息量不足", layer: "outline", threshold: `少于本版式判定线（min(${PPT_LIMITS.targetSentencesPerPage}, 结构上限)）`, action: "进下一轮反馈" },
  { code: "数字不在正文", layer: "outline", threshold: "出现正文里没有的数字（全角半角归一后比对）", action: "进下一轮反馈" },
  { code: "两页重复", layer: "outline", threshold: "≥6 字整句在两页重复（每页最多报 3 处）", action: "进下一轮反馈" },
  { code: "叙事顺序错", layer: "outline", threshold: "首次出现顺序不是 问题 < 方案 < 价值", action: "进下一轮反馈" },
  { code: "不自包含", layer: "outline", threshold: "出现指代（见正文/详见报告）或元话（待客户提供/建议采用/谢谢观看）", action: "进下一轮反馈" },
  { code: "图标不合规", layer: "outline", threshold: "图标不在白名单", action: "进下一轮反馈" },
  { code: "图标重复", layer: "outline", threshold: "同一页两个元素用同一个图标", action: "进下一轮反馈" },
  { code: "版式与字段不成套", layer: "outline", threshold: "layout 与字段不匹配（表格无 table、流程不足 3 段等）", action: "降级到可用版式后照渲染" },
  { code: "缺封面", layer: "outline", threshold: `第 1 页不是「${PPT_OUTLINE_QUALITY.coverLayout}」（或封面内容不全被降级）`, action: "进下一轮反馈" },
  { code: "版式单一", layer: "outline", threshold: `整份结构 < ${PPT_OUTLINE_QUALITY.minLayoutVariety} 种（只判 ≥6 页成稿）`, action: "进下一轮反馈" },
  { code: "版式重复", layer: "outline", threshold: `同一种结构连续 > ${PPT_OUTLINE_QUALITY.maxLayoutRun} 页（只判 ≥6 页成稿）`, action: "进下一轮反馈" },
];

/** 全部已登记的门禁 code（去重；单测与源码对账用） */
export const PPT_GATE_CODES: readonly string[] = Array.from(new Set(PPT_GATE_THRESHOLDS.map((g) => g.code))).sort();

/** 模版基线的一句话摘要（提示词与文档共用） */
export const PPT_TEMPLATE_SUMMARY =
  `模版：13.33×7.5in、白底、标题 ${PPT_TEMPLATE.font.titlePt}pt、正文 ${PPT_TEMPLATE.font.bodyPt}pt、` +
  `页脚 ${PPT_TEMPLATE.font.microPt}pt + 右下「NN / MM」、内容页 29–57 条文字`;

/** 注意事项里要喂给模型的那几条（提示词用） */
export const PPT_MODEL_CAUTIONS: readonly string[] = PPT_CAUTIONS.filter((c) => c.model).map((c) => c.note);
