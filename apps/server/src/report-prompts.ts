/**
 * @scene/server — 交付物报告提示词（变更表 #112 / #113）
 *
 * 用户先说：「首先应该是报告，不是记录 … 要的是总结，不是罗列」（#112）；
 * 看过一版之后又给参照件纠偏：「**不要把报告做成前面内容的总结，而是形成自己的价值**」（#113）。
 *
 * 参照件（`城市门站调压站-智能化提升方案.docx`）的价值不在章节名，而在**报告自己长出了
 * 方案构件**：设计原则、总体架构分层、主/辅职责对照、编号连接关系、端侧选配"或"关系、
 * 实施要点、每条带度量口径的核心价值、能力边界、下一步（步骤/内容/交付物）、术语表——
 * 这些**没有一张来自调研表**，是作者自己的主张。
 *
 * 所以这里规定三件事：
 *  1. 章节与小节：按契约 `reportChaptersOf(kind)` 逐条列出（章节序号按口径生成）；
 *  2. 构件：每章必须自建哪些东西（表格 / 编号连接 / 原则 / 价值口径 / 边界 / 术语表）；
 *  3. 硬规则：素材是**证据**不是结论——不许复述、不许把行业通例当客户事实、不许给决策建议、
 *     写不出来就说缺。
 *
 * 素材不在这里格式化：由 `@scene/infra` 的 `reportChapterDigest()` 产出——与"模型没写成时
 * 用的兜底版"同源，避免两处口径漂移。
 */

import {
  reportChaptersOf,
  reportChapterHeading,
  type ReportArtifact,
  type ReportKind,
  type ReportSection,
} from "@scene/contract";
import type { ChapterDigest } from "@scene/infra";

export type { ReportKind };

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

1. **这是方案，不是前面内容的总结**：读者没看过我们内部的调研表，他读到的应该是**一份能独立成立的方案**。
   素材只是证据——你要基于它给出**我们自己的主张**：设计原则、总体架构、职责怎么分、接口在哪、
   每项价值对应哪个指标、我们明确不做什么、下一步做什么。
   **禁止**逐行搬运表格、**禁止**把每一行写成一条 bullet、**禁止**出现"表X-X"这类内部表号，
   **禁止**写成"先讲了位 … 又说了 …"这种摘要腔。
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

/** 构件的中文说法（写进提示词，让模型知道这一章要产出什么） */
const ARTIFACT_HINT: Record<ReportArtifact, string> = {
  table: "自建一张 Markdown 表格（表头 + 数据行）",
  "numbered-connections": "用 ①②③… 给每条连接/接口编号，编号与说明一一对应",
  principles: "写成「原则一 / 原则二 / 原则三」，每条一句话说清主张",
  "value-with-metric": "每条价值都要带「度量口径」——量什么、怎么量、现在有没有基线",
  boundary: "明确写出「不做什么」（不替代什么、不参与什么、不承担什么）",
  glossary: "术语 + 说明两列",
};

/** 一节要写什么：小节名 + 该自建的构件 */
function renderSection(sec: ReportSection): string {
  const arts = sec.artifacts ?? [];
  if (arts.length === 0) return `  - \`### ${sec.title}\`（文字叙述）`;
  return `  - \`### ${sec.title}\`：必须${arts.map((a) => ARTIFACT_HINT[a]).join("；并且")}`;
}

/** 输出格式：章节与小节由契约给出，序号按口径生成 */
function outputFormat(kind: ReportKind): string {
  const lines = reportChaptersOf(kind).flatMap((c) => [
    `- \`## ${reportChapterHeading(kind, c.key)}\``,
    ...c.sections.map(renderSection),
  ]);
  const glossary = kind === "internal" ? "## 附录 C、术语表" : "## 附录、术语表";
  return [
    "## 输出格式（严格遵守）",
    "",
    "纯 Markdown，**不要**任何前言、寒暄、结语或代码块围栏。按下面的章节与小节写，标题**原样使用**：",
    ...lines,
    `- \`${glossary}\`：把报告里出现、而客户或新人可能不熟的术语逐个解释（介质 / 协议 / 标准 / 系统名 / 业务口径都算），`,
    "  只解释通行含义，不要自己发明定义；两张表列：术语、说明。",
    "",
    "层级只到 `###`（不要 `#`、`####` 及更深）；正文里不写文件名、页码、内部表号。",
  ].join("\n");
}

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
    outputFormat(kind),
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

/** 某一章在小节上的要求（术语表这类附录章没有小节） */
function reportSectionsOf(kind: ReportKind, key: string): readonly ReportSection[] {
  return reportChaptersOf(kind).find((c) => c.key === key)?.sections ?? [];
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
    `把上面的素材写成一份**${kind === "internal" ? "内部调研报告" : "对外汇报材料（方案）"}**。`,
    "记住：**不要写成前面内容的总结**——素材是证据，报告要长出自己的**方案构件**：",
    "设计原则、总体架构、职责划分、编号连接关系、选型、价值与度量口径、能力边界、下一步。",
    "这些都由你立起来；读者不必看过我们的调研表也能读懂这份报告。",
    "每章先给一段结论性的总述，再给必要的支撑；同类信息合并，不要逐行罗列。",
  );
  if (retry) {
    parts.push(
      "",
      "## 上一次的问题（必须重写，逐条规避）",
      retry,
      "",
      "重写时注意：章节与小节仍要齐全；该自建的构件（原则 / 表格 / 编号连接 / 价值口径 / 边界 / 术语表）",
      "必须真的写出来；对外材料不得出现内部表号、来源、证据级；不得出现决策建议措辞。",
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
    chapters
      .map((c) =>
        [
          `### ${c.title}`,
          reportSectionsOf(kind, c.key).map(renderSection).join("\n"),
          c.key === "glossary" ? `  - 术语表：术语 + 说明两列，只解释通行含义` : "",
          "",
          c.markdown,
        ]
          .filter((x) => x !== "")
          .join("\n"),
      )
      .join("\n\n"),
    "",
    "## 输出格式（必须严格遵守）",
    ...chapters.map((c) => `- 以「## ${c.title}」开头，本节内容完整写出`),
    "",
    "每节先用一段话给出这一节的结论，再给必要的支撑；同类信息合并，不要逐行罗列。",
    "不要写开场白、不要写目录、不要用代码块包裹。",
  ].join("\n");
  return { system: buildSystem(kind), user };
}
