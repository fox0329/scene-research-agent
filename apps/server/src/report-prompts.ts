/**
 * @scene/server — 交付物报告提示词（变更表 #112）
 *
 * 用户定调：「首先应该是报告，不是记录 … 要的是总结，不是罗列」「整体章节应该是
 * 差不多了，都是场景定义、认识、存在的问题，我们的方案，能够提供的价值，总结。
 * 只是内部侧重客观、风险，外部侧重痛点、方案、价值。」
 *
 * 于是这里只做三件事：
 *  1. 把**已经做完的调研结论**（各表数据，按章分好块）交给模型，让它**归纳**成报告；
 *  2. 用硬规则把它按在报告该有的样子上（不给决策建议、写不出的就说缺、不许把
 *     行业通例当成本客户事实）；
 *  3. 规定输出格式（`## 章名` 六章纯 Markdown），服务端按章装配、逐章兜底。
 *
 * 数据不在这里格式化：原料由 `@scene/infra` 的 `reportChapterDigest()` 产出——
 * 与"模型没写成时用的兜底版"同源，避免两处口径漂移。
 */

import type { ChapterDigest } from "@scene/infra";

export type ReportKind = "internal" | "external";

export interface ReportPromptInput {
  scenarioName: string;
  /** 场景锚（表1-1）的原始行，供模型把握边界 */
  anchor: readonly Record<string, unknown>[];
  /** 每章的确定性原料（含小节标题与要点） */
  chapters: readonly ChapterDigest[];
  /** 尚无数据的表（报告里要如实写成待补） */
  missingTables: readonly string[];
}

/** 两份报告共用的硬规则 */
const HARD_RULES = `## 硬规则（违反即视为缺陷）

1. **这是报告，不是清单**：你要做的是**归纳**——把同一类问题合并成一条结论，说清"是什么、为什么、影响到谁"。
   **禁止**逐行搬运表格、禁止把每一行都写成一条 bullet、禁止出现"表X-X"这类内部表号。
2. **每条结论必须立得住**：数据里标了「行业通例（模型知识）」「单一来源」的，结论里必须**降调**
   （写"行业通行做法如此，本客户是否同样如此待验证"），**不许当成本客户事实**。
3. **不给决策建议**：不写"建议先做试点""推荐采用""值得投入""应当优先"——产品只给事实、判定与缺口，
   进不进、什么时候进由用户决定。
4. **写不出来的就说缺**：数据里没有的（本客户基线、现场设备清单、合同条款等）写成「待补」并说明缺什么；
   宁可短，不许编。
5. **说人话**：术语首次出现要有解释；一句话说清一件事，不堆形容词，不用"赋能/抓手/闭环"这类空话。
6. **数字要带口径**：出现数字必须写清是"行业通例量级"还是"本客户实测"，以及量的是什么。`;

/** 内部版：客观与风险优先 */
const INTERNAL_ROLE = `你是解决方案架构师的调研报告撰写人。你要写的是**内部调研报告**：给"决定要不要进这个场景"的自己人看。

内部版的侧重（用户定调）：**客观、风险**——
- 每条结论都要能追到数据；数据本身不牢的（单一来源、无法核实、行业通例），**必须在本章里点出来**；
- 风险与不确定要单独说透：什么会被卡住（门槛/否决方）、哪里没有依据、哪条结论只是推断；
- 边界要写清：我方**不做什么**、做到哪一步为止；`;

/** 对外版：痛点 → 方案 → 价值 */
const EXTERNAL_ROLE = `你是给客户做汇报的方案撰写人。你要写的是**对外汇报材料**：给客户的业务与 IT 负责人看。

对外版的侧重（用户定调）：**痛点、方案、价值**——
- 痛点要说客户自己的话（他们今天怎么干、哪里难受、代价是什么），不写我方内部判断与商务口径；
- 方案要说清"我方做什么、到哪一步、接口在哪、不做什么"；
- 价值要给"指标 + 怎么测"，数值标明是行业量级还是待实测；
- **不许出现**内部表号、来源标注、证据等级、缺口清单这类内部痕迹。`;

/** 输出格式（两份共用） */
const OUTPUT_FORMAT = `## 输出格式（严格遵守）

纯 Markdown，**不要**任何前言、寒暄、结语或代码块围栏。六个章节，每章以 \`## 章名\` 开头，
章名必须原样使用：\`## 一、场景定义\`、\`## 二、场景认识\`、\`## 三、存在的问题\`、\`## 四、我们的方案\`、
\`## 五、能够提供的价值\`、\`## 六、总结\`。
章内可用 \`### 小标题\` 与短段落、短列表；**不要**用 \`#\`、\`####\` 及更深的层级，不要在正文里写文件名或页码。`;

/** 依 kind 组系统提示词 */
function buildSystem(kind: ReportKind): string {
  const role = kind === "internal" ? INTERNAL_ROLE : EXTERNAL_ROLE;
  const length =
    kind === "internal"
      ? "篇幅：正文 4000–8000 字（约 8–15 页）；宁可写透，不要凑字。"
      : "篇幅：正文 2500–4500 字（约 5–8 页）；客户不会读完长文。";
  return [
    role,
    "",
    "## 你拿到的数据",
    "下面每一章都配好了该章的**调研结论原料**（已按小节整理）。原料是「事实层」：",
    "你可以归纳、排序、指出矛盾与缺口，但**不得引入原料之外的信息**，也不得改动数字。",
    "",
    HARD_RULES,
    "",
    OUTPUT_FORMAT,
    "",
    length,
  ].join("\n");
}

/** 场景锚：让模型先把边界读准 */
function renderAnchor(anchor: readonly Record<string, unknown>[]): string {
  if (anchor.length === 0) return "（尚未产出场景锚表1-1）";
  return anchor
    .map((r) => `- ${String(r["item"] ?? "")}：${String(r["content"] ?? "").replace(/\s+/g, " ")}`)
    .join("\n");
}

/** 每章原料：章名 + 该章的数据块（模型据此归纳） */
function renderChapters(chapters: readonly ChapterDigest[]): string {
  return chapters
    .map((c) => [`### ${c.title}`, c.markdown].join("\n"))
    .join("\n\n");
}

/**
 * 组装报告提示词
 *
 * @param retry 上一次的违规清单：有值时要求模型重写并逐条规避
 */
export function buildReportPrompt(
  kind: ReportKind,
  input: ReportPromptInput,
  retry?: string,
): { system: string; user: string } {
  const parts = [
    `## 场景`,
    `${input.scenarioName}`,
    "",
    "### 场景边界（表1-1 原始行）",
    renderAnchor(input.anchor),
    "",
    "## 各章原料",
    renderChapters(input.chapters),
  ];
  if (input.missingTables.length > 0) {
    parts.push(
      "",
      "## 尚无数据的表（在报告里如实写成「待补」，不要编）",
      input.missingTables.join("、"),
    );
  }
  parts.push(
    "",
    "## 你的任务",
    `把上面的原料写成一份**${kind === "internal" ? "内部调研报告" : "对外汇报材料"}**：按六个章节归纳成报告，`,
    "每章先给结论性的总述，再给必要的支撑；同类信息合并，不要把每一行都列出来。",
  );
  if (retry) {
    parts.push(
      "",
      "## 上一次的问题（必须重写，逐条规避）",
      retry,
      "",
      "重写时注意：这六章仍要齐全；对外材料不得出现内部表号 / 来源 / 证据级；不得出现决策建议措辞。",
    );
  }
  return { system: buildSystem(kind), user: parts.join("\n") };
}

/**
 * 补写提示词：只写缺的那几章
 *
 * 整篇写容易漏章（模型常把第一章当上下文），补写时把范围缩到"就写这几节"，
 * 命中率明显更高；原料同样给全量。
 */
export function buildChapterPrompt(
  kind: ReportKind,
  chapters: readonly ChapterDigest[],
  scenarioName: string,
): { system: string; user: string } {
  const user = [
    `## 场景`,
    scenarioName,
    "",
    "## 只写下面这几节（其余章节已经写好，不要重复、不要写别的章节）",
    renderChapters(chapters),
    "",
    "## 输出格式（必须严格遵守）",
    ...chapters.map((c) => `- 第 ${c.title} 一节，以「## ${c.title}」开头`),
    "",
    "每节先用一段话给出这一节的结论，再给必要的支撑；同类信息合并，不要逐行罗列。",
    "不要写开场白、不要写目录、不要用代码块包裹。",
  ].join("\n");
  return { system: buildSystem(kind), user };
}
