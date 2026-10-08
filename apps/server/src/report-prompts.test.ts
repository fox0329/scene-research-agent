import { describe, it, expect } from "vitest";
import { reportChapterHeading, reportChapters } from "@scene/contract";
import type { ReportKind } from "@scene/contract";
import type { ChapterDigest } from "@scene/infra";
import { reportMaxChars } from "@scene/domain";
import {
  buildChapterPrompt,
  buildReportPrompt,
  chapterProseBudget,
} from "./report-prompts.js";

/** 某一口径的确定性原料（与 `reportChapterDigest()` 同构：章 key + 章名 + 该章素材） */
const digestOf = (kind: ReportKind): ChapterDigest[] =>
  reportChapters(kind).map((c) => ({
    key: c.key,
    title: reportChapterHeading(kind, c.key),
    markdown: `${c.label}的原料要点`,
  }));

const digest = digestOf("solution");
const constructionDigest = digestOf("construction");

const base = {
  scenarioName: "智慧会议室",
  anchor: [{ item: "场景名称", content: "智慧会议室" }],
  chapters: digest,
  missingTables: ["表3-1 利润池"],
};

const constructionBase = { ...base, chapters: constructionDigest };

describe("解决方案提示词（变更表 #112 / #136）", () => {
  it("章节名与小节名原样进提示词，且章名不带序号（序号交给 Word）", () => {
    const { system } = buildReportPrompt("solution", base);
    for (const c of reportChapters("solution")) {
      expect(system).toContain(`## ${reportChapterHeading("solution", c.key)}`);
      expect(system).not.toContain(`一、${c.label}`);
      for (const sec of c.sections) expect(system).toContain(sec.title);
    }
  });

  it("说明章节号由 Word 自动编号，并要求章名只写一次", () => {
    const { system } = buildReportPrompt("solution", base);
    expect(system).toContain("章节号由 Word 文档自动编号");
    expect(system).toContain("正文与标题都不要自己写序号");
    expect(system).toContain("章名只写一次");
  });

  it("禁止正文用「一、二、」编号（会与章节层级混淆），并给出替代写法", () => {
    const { system } = buildReportPrompt("solution", base);
    expect(system).toContain("不许再用「一、二、三、」编号");
    expect(system).toContain("价值一");
  });

  it("要求报告长出自己的方案构件，并明说「不是前面内容的总结」", () => {
    const { system, user } = buildReportPrompt("solution", base);
    expect(user).toContain("方案构件");
    expect(user).toContain("不要写成前面内容的总结");
    // 价值是四列表格（含怎么核）——内部版那种「价值N/度量口径」段落已随 #136 退场
    for (const word of ["设计原则", "编号", "怎么核", "| 价值 | 现在 | 采用后 | 怎么核 |"]) {
      expect(system, word).toContain(word);
    }
  });

  it("只有一份口径：读者是客户的业务与 IT 负责人，不再出现两版说法", () => {
    const all = `${buildReportPrompt("solution", base).system}\n${buildReportPrompt("solution", base).user}`;
    expect(all).toContain("客户的业务与 IT 负责人");
    expect(all).toContain("不给决策建议");
    for (const gone of ["内部版", "对外版", "内部调研报告", "对外汇报材料", "两份"]) {
      expect(all, gone).not.toContain(gone);
    }
  });

  it("已退场的章节与构件不进提示词（无风险章、无术语表、无内部版小节）", () => {
    const { system } = buildReportPrompt("solution", base);
    expect(system).not.toContain("主要风险点");
    expect(system).not.toContain("术语表");
    // 场景边界/典型问题/价值表在契约里就是「章下直接写」，不再有套小节标题的那一版
    expect(system).toContain("「场景边界」：**章下直接写，不要单独加 `###` 标题**");
    expect(system).toContain("「典型问题」：**章下直接写，不要单独加 `###` 标题**");
    expect(system).toContain("`### 设计原则`");
    expect(system).toContain("`### 实施要点`");
    // 价值表后面不再要求写四条边界段落（用户定稿已删，变更表 #131/#136），只剩那句禁令
    expect(system).not.toContain("表格下面**再写四条边界**");
    expect(system).toContain("**不要**再写「不替代 / 不参与 / 不承担 / 受限条件」四条边界段落");
  });

  it("原料、场景锚、缺口表都带给模型（不让它自己猜表）", () => {
    const { user } = buildReportPrompt("solution", base);
    expect(user).toContain("智慧会议室");
    expect(user).toContain("表3-1 利润池");
    expect(user).toContain("现状");
  });

  it("重写时把上一版的硬伤清单带回去，并要求逐条规避", () => {
    const { user } = buildReportPrompt("solution", base, "- 【泄漏内部信息】出现表号：表3-8");
    expect(user).toContain("上一次的问题");
    expect(user).toContain("表3-8");
    expect(user).toContain("不得出现决策建议措辞");
  });

  it("篇幅只有单一口径（变更表 #136：不再分内部/对外两套数字）", () => {
    const { system } = buildReportPrompt("solution", base);
    expect(system).toContain("2500–3200");
    expect(system).not.toContain("2500–4000");
    expect(system).not.toContain("内部版每章");
  });

  it("补写提示词同样是单一口径（变更表 #139：它现在也用于超预算章的回炉重写）", () => {
    const chapter = buildChapterPrompt("solution", digest.slice(1, 2), "智慧会议室");
    expect(chapter.user).toContain("只写下面这几节");
    expect(`${chapter.system}\n${chapter.user}`).not.toContain("术语表");
    // 逐章重申该章预算与「章首段是总纲」——篇幅靠预算在前面管住，不靠事后压缩删内容
    expect(chapter.user).toContain("本章正文预算不超过 300 字");
    expect(chapter.user).toContain("第一段是本章总纲");
  });

  it("逐章回炉线是变更表 #136 定下的那一档（solution 五章）", () => {
    expect(chapterProseBudget("solution", "status")).toBe(1000);
    expect(chapterProseBudget("solution", "problems")).toBe(300);
    expect(chapterProseBudget("solution", "solution")).toBe(1350);
    expect(chapterProseBudget("solution", "value")).toBe(200);
    expect(chapterProseBudget("solution", "next")).toBe(400);
    expect(chapterProseBudget("solution", "不存在的章")).toBe(450);
  });
});

describe("建设工作方案提示词（变更表 #137）", () => {
  it("七章名原样进提示词且不带「一、」，并含 Word 自动编号说明", () => {
    const { system } = buildReportPrompt("construction", constructionBase);
    for (const c of reportChapters("construction")) {
      expect(system).toContain(`## ${reportChapterHeading("construction", c.key)}`);
      expect(system).not.toContain(`一、${c.label}`);
      for (const sec of c.sections) expect(system).toContain(sec.title);
    }
    expect(system).toContain("章节号由 Word 文档自动编号");
    expect(system).toContain("正文与标题都不要自己写序号");
    expect(system).toContain("章名只写一次");
  });

  it("五张表（+ 分层表）的真实列名都写进提示词，不是泛泛说「给一张表」", () => {
    const { system } = buildReportPrompt("construction", constructionBase);
    for (const header of [
      "| 层次 | 我方组件与部署 | 承担什么 |",
      "| 设备类别 | 感知设备 | 感知手段 | 研判结论（状态结果） |",
      "| 风险等级 | 判定依据（状态结论） | 安检频次 |",
      "| 设备名称 | 感知对象 | 主要用途 |",
      "| 序号 | 里程碑事项 | 时间节点 | 责任部门 |",
    ]) {
      expect(system, header).toContain(header);
    }
    // 分层表 ≥4 行、清单表 ≥3 行、计划表 9 条里程碑
    expect(system).toContain("**≥4 行**");
    expect(system).toContain("**≥3 行**");
    expect(system).toContain("9 条里程碑");
  });

  it("要客户自己评估/提供的列一律不进表：成本评估、预计金额、配置规模都不再出现（用户定调）", () => {
    const { system, user } = buildReportPrompt("construction", constructionBase);
    const all = `${system}\n${user}`;
    for (const gone of ["成本评估", "成本表", "预计金额", "配置规模", "分试点与推广两段口径"]) {
      expect(all, gone).not.toContain(gone);
    }
    // 设备清单表只留三列，并明写不要为这类列留「待客户提供」占位
    expect(system).toContain("| 设备名称 | 感知对象 | 主要用途 |");
    expect(system).toContain("只写这三列");
    expect(system).toContain("要客户自己评估或提供");
    expect(system).toContain("也不要为它们留「待客户提供」占位");
    // 逐章区间与回炉线一致（变更表 #139 补丁：按真实分布抬到 650/650/1700/700/200/550/250）
    expect(system).toContain("背景约 400–650");
    expect(system).toContain("内容约 1400–1600");
    expect(system).toContain("目标约 400–600");
    expect(system).toContain("保障约 400–550");
    expect(system).toContain("路径约 500–700");
    expect(system).toContain("本章 400–650 字");
    expect(system).toContain("（本章 400–550 字）");
    expect(system).toContain("本章 500–700 字");
    expect(chapterProseBudget("construction", "path")).toBe(700);
    // 「本章 N 字」只出现在版式里那七处，不许再有旧的 400–500 / 500 口径
    expect(system).not.toContain("本章 400–500 字");
    expect(system).not.toContain("（本章 400–500 字）");
  });

  it("客户没给的数字不许编，缺数写「待客户提供 / 待现场勘查确定」", () => {
    const { system } = buildReportPrompt("construction", constructionBase);
    expect(system).toContain("客户没给的数字不许编");
    expect(system).toContain("待客户提供");
    expect(system).toContain("待现场勘查确定");
    expect(system).toContain("禁止编造具体金额或台数");
  });

  it("把「建议采用 / 推荐 / 值得投入」列为禁止（原文的不给决策建议保留）", () => {
    const { system } = buildReportPrompt("construction", constructionBase);
    expect(system).toContain("不给决策建议");
    expect(system).toContain("「建议采用」「推荐」「值得投入」");
    expect(system).toContain("不是选项比较");
  });

  it("总字数预算写在提示词里：正文 2,000–5,000 字、目标 4,300 字左右", () => {
    const { system } = buildReportPrompt("construction", constructionBase);
    expect(system).toContain("2,000–5,000");
    expect(system).toContain("目标 4,300 字左右");
    expect(system).not.toContain("4,200–5,200");
    expect(system).not.toContain("2500–3200");
    expect(system).not.toContain("2,500–3,200");
    // 逐章回炉线也要是建设方案那七档，别把解决方案的章序当预算
    expect(system).not.toContain("现状约 900");
  });

  it("construction 总上限 5000，且逐章预算之和不超过总上限（solution 预算与上限未动）", () => {
    const sum = (kind: ReportKind): number =>
      reportChapters(kind).reduce((acc, c) => acc + chapterProseBudget(kind, c.key), 0);
    // construction：650+600+1600+700+200+550+250 = 4,550 ≤ 5,000（#139 补丁后只是写作指引，贴近目标 4,300）
    expect(sum("construction")).toBe(4_550);
    expect(sum("construction")).toBeLessThanOrEqual(reportMaxChars("construction"));
    // solution 的预算与上限都没动：1000+300+1350+200+400 = 3,250 < 4,500
    expect(sum("solution")).toBe(3_250);
    expect(sum("solution")).toBeLessThanOrEqual(reportMaxChars("solution"));
  });

  it("章首段规则进通用硬规则（报告提示词与补写提示词都在）", () => {
    const report = buildReportPrompt("construction", constructionBase).system;
    expect(report).toContain("每章第一段是本章总纲");
    expect(report).toContain("不以分号列举或半句开头");
    expect(report).toContain("不超过 120 字");
    const chapter = buildChapterPrompt("construction", constructionDigest.slice(0, 1), "智慧会议室");
    expect(chapter.system).toContain("每章第一段是本章总纲");
    expect(chapter.user).toContain("第一段是本章总纲");
    // 解决方案口径共用同一批硬规则
    expect(buildReportPrompt("solution", base).system).toContain("每章第一段是本章总纲");
  });

  it("口径隔离：两份提示词不互相出现对方的章名", () => {
    const construction = buildReportPrompt("construction", constructionBase).system;
    for (const gone of ["## 现状", "## 场景与问题", "## 方案", "## 价值", "## 下一步"]) {
      expect(construction, gone).not.toContain(gone);
    }
    const solution = buildReportPrompt("solution", base).system;
    for (const gone of [
      "## 建设背景与必要性",
      "## 建设目标与思路",
      "## 建设内容",
      "## 建设路径",
      "## 工作安排",
      "## 保障措施",
      "## 监管协同展望",
    ]) {
      expect(solution, gone).not.toContain(gone);
    }
    // 角色与读者也各自独立
    expect(construction).toContain("建设工程方案撰写人");
    expect(construction).toContain("客户的业务负责人与项目决策人");
    expect(solution).not.toContain("建设工程方案撰写人");
  });

  it("逐章回炉线两份口径各取精确值（变更表 #139 重排），未知章兜底 450", () => {
    expect(chapterProseBudget("construction", "background")).toBe(650);
    expect(chapterProseBudget("construction", "goals")).toBe(600);
    expect(chapterProseBudget("construction", "content")).toBe(1600);
    expect(chapterProseBudget("construction", "path")).toBe(700);
    expect(chapterProseBudget("construction", "schedule")).toBe(200);
    expect(chapterProseBudget("construction", "safeguards")).toBe(550);
    expect(chapterProseBudget("construction", "outlook")).toBe(250);
    expect(chapterProseBudget("construction", "不存在的章")).toBe(450);
    // 隔离：解决方案的章 key 在建设方案口径里没有预算 → 兜底
    expect(chapterProseBudget("construction", "status")).toBe(450);
    expect(chapterProseBudget("solution", "background")).toBe(450);
  });

  it("补写提示词带口径名与章序号（《X建设工作方案》第 3 章「建设内容」）", () => {
    const chapter = buildChapterPrompt("construction", constructionDigest.slice(2, 3), "智慧会议室");
    expect(chapter.user).toContain("《智慧会议室建设工作方案》");
    expect(chapter.user).toContain("第 3 章「建设内容」");
    expect(chapter.user).toContain("只写下面这几节");
    expect(chapter.system).not.toContain("术语表");
    const solution = buildChapterPrompt("solution", digest.slice(1, 2), "智慧会议室");
    expect(solution.user).toContain("《智慧会议室解决方案》");
    expect(solution.user).toContain("第 2 章「场景与问题」");
  });

  it("报告任务句带口径名，并点出建设方案自己的构件（硬表，不再有两阶段成本）", () => {
    const { user } = buildReportPrompt("construction", constructionBase);
    expect(user).toContain("《智慧会议室建设工作方案》");
    expect(user).toContain("不要写成前面内容的总结");
    expect(user).toContain("里程碑计划表");
    expect(user).toContain("新增设备清单");
    // 成本口径整条退场（用户定调：表里不要需要客户自己评估的内容）
    expect(user).not.toContain("试点 / 推广");
    expect(user).not.toContain("成本");
  });

  it("共用硬规则在建设方案里同样在位（不是总结 / 结论降调 / 写不出就说缺 / 说人话 / 数字带口径 / 不记流水账）", () => {
    const { system } = buildReportPrompt("construction", constructionBase);
    for (const rule of [
      "这是方案，不是前面内容的总结",
      "每条结论必须立得住",
      "写不出来的就说缺",
      "说人话",
      "数字要带口径",
      "不许写自我说明与免责声明",
      "不许记流水账",
      "不许再用「一、二、三、」编号",
      "正文里不写文件名、页码、内部表号",
    ]) {
      expect(system, rule).toContain(rule);
    }
  });

  it("重写时把硬伤清单带回建设方案，并要求逐条规避（含不许编数）", () => {
    const { user } = buildReportPrompt("construction", constructionBase, "- 【编造金额】出现材料里没有的 181 万元");
    expect(user).toContain("上一次的问题");
    expect(user).toContain("181 万元");
    expect(user).toContain("不得出现决策建议措辞");
    expect(user).toContain("金额与台数不许编");
  });
});
