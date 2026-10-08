/**
 * @scene/server — 导出 PPT 测试（变更表 #141 立、#144 升；#145 升：生成后版面检查；
 * #146 升：**三轮修复闭环**）
 *
 * **不真跑用户的技能**（慢，还依赖本机装的依赖）：用 `PPT_MASTER_DIR` 指到一个 fixture 目录，
 * 里面放假的 `scripts/finalize_svg.py`（图标收尾）与 `scripts/svg_to_pptx.py`（转档）——
 * 两者只把命令行与看到的东西记进 `PPT_FAKE_LOG`（一行一条 JSON），转档器再写一个占位 pptx。
 * 由此验证：**两步的先后次序与参数逐字固定**（#144）、命令行参数正确、产物落到目标目录、
 * 临时目录被清理、进度阶段齐、finalize 失败/缺脚本都只 warn 不阻断、失败只回 notice。
 *
 * #146 追加：编排是**最多三轮的闭环**——每轮「重读正文 → 生成 → 优化（第二次模型调用）→
 * 渲染 → 检查」，上一轮的问题带进下一轮；问题清单为空即通过；三轮都过不了**不报错**，
 * 取问题最少的那一轮照常导出 + notice 点名（#145 的"不达标就拒绝写出"就此作废）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PPT_LIMITS, PPT_OUTLINE_ROUNDS, type DshClient, type FollowEvent, type PptPage, type ReportKind } from "@scene/contract";
import { createDb, type DbInstance } from "@scene/infra";
import { deliverableReportPath } from "./deliverable-report.js";
import { exportReportPptx, pptFileName } from "./ppt-export.js";

// ─── fixture：假技能（finalize 嵌图标 + 转档器写占位文件，都记日志） ──────

/** 两个假脚本共用的记账函数（追加一行 JSON，便于断言"谁先谁后"） */
const LOG_HELPER = [
  "import json, os, pathlib",
  "def log_line(rec):",
  "    p = os.environ.get('PPT_FAKE_LOG')",
  "    if p:",
  "        with open(p, 'a', encoding='utf-8') as fh:",
  "            fh.write(json.dumps(rec, ensure_ascii=False) + '\\n')",
].join("\n");

/**
 * 假 finalize：按真技能的契约**从 svg_output 读、往 svg_final 写**，
 * 把 `<use data-icon=…>` 换成 `<!-- icon: … -->` + 一个假图标组（真技能从图标库取路径），
 * 并把每页的占位数 / 收尾后的残留数写进日志。
 */
const FAKE_FINALIZE = [
  LOG_HELPER,
  "import re, sys",
  "args = sys.argv[1:]",
  "proj = pathlib.Path(args[0])",
  "src = proj / 'svg_output'",
  "dst = proj / 'svg_final'",
  "dst.mkdir(parents=True, exist_ok=True)",
  "pages = []",
  "for f in sorted(src.glob('*.svg')):",
  "    text = f.read_text(encoding='utf-8')",
  "    icons = len(re.findall(r'data-icon=\"', text))",
  "    text = re.sub(r'<use data-icon=\"([^\"]+)\"[^>]*/>',",
  "                  r'<!-- icon: \\1 --><g transform=\"translate(0, 0)\"><path d=\"M0 0h1v1z\"/></g>', text)",
  "    (dst / f.name).write_text(text, encoding='utf-8')",
  "    pages.append({'name': f.name, 'icons': icons, 'residue': text.count('data-icon=\"')})",
  "log_line({'step': 'finalize', 'argv': sys.argv, 'pages': pages})",
  "print('图标已嵌入：%d 页' % len(pages))",
].join("\n");

/** 假 finalize（失败版）：非 0 退出 + stderr 有话说 */
const FAKE_FINALIZE_FAIL = [
  LOG_HELPER,
  "import sys",
  "log_line({'step': 'finalize-fail', 'argv': sys.argv})",
  "sys.stderr.write('fake finalize boom\\n')",
  "sys.exit(4)",
].join("\n");

/** 假转档器：记 argv、svg_output 页数与"转档时 svg_final 里还有多少 data-icon 残留"，再写占位 pptx */
const FAKE_OK = [
  LOG_HELPER,
  "import sys",
  "out = None",
  "args = sys.argv[1:]",
  "for i, a in enumerate(args):",
  "    if a in ('-o', '--output'):",
  "        out = args[i + 1]",
  "if out is None:",
  "    sys.exit(2)",
  "proj = pathlib.Path(args[0])",
  "svgs = sorted(os.listdir(proj / 'svg_output'))",
  "final_dir = proj / 'svg_final'",
  "residue = None",
  "if final_dir.exists():",
  "    residue = sum(p.read_text(encoding='utf-8').count('data-icon=\"') for p in sorted(final_dir.glob('*.svg')))",
  "log_line({'step': 'convert', 'argv': sys.argv, 'svgs': svgs, 'finalResidue': residue})",
  "pathlib.Path(out).write_bytes(b'PK\\x03\\x04fake-pptx')",
  "print('导出完成：0 失败')",
].join("\n");

/** 假转档器（失败版）：非 0 退出 + stderr 有话说 */
const FAKE_FAIL = [
  "import sys",
  "sys.stderr.write('Traceback: 假导出器故意失败\\n')",
  "sys.exit(3)",
].join("\n");

/** 假技能目录：转档器必有；finalize 传 null 就是"老版本技能"（没有收尾脚本） */
function makeSkill(body: string, finalizeBody: string | null = FAKE_FINALIZE): string {
  const dir = mkdtempSync(join(tmpdir(), "scene-ppt-skill-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "svg_to_pptx.py"), body, "utf8");
  if (finalizeBody !== null) writeFileSync(join(dir, "scripts", "finalize_svg.py"), finalizeBody, "utf8");
  return dir;
}

/** 日志里的一行（两个假脚本一起按顺序记） */
interface LogRecord {
  step: string;
  argv: string[];
  svgs?: string[];
  finalResidue?: number | null;
  pages?: { name: string; icons: number; residue: number }[];
}

/** 读假脚本的日志（一行一条 JSON，按发生次序） */
function readLog(log: string): LogRecord[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LogRecord);
}

// ─── 场景与 DSH 桩 ─────────────────────────────────────────

function seed(db: DbInstance, name = "PPT 场景"): { scenarioId: string; scenario: ReturnType<DbInstance["scenarioRepo"]["insert"]> } {
  const line = db.productLineRepo.insert({ name: "默认产品线" });
  const scenario = db.scenarioRepo.insert({
    name,
    product_line_id: line.id,
    status: "进行中",
    current_stage: 0,
  });
  return { scenarioId: scenario.id, scenario };
}

/**
 * 交付物正文（大纲里的数字都出现在这里——判据④「数字只许来自报告正文」要过）
 *
 * 1–6 是各页 kicker / 标题 / 副题里的页号，12 / 480 / 2 / 1 是数据卡片的值。
 */
const DEFAULT_MD = [
  "# PPT 场景建设工作方案",
  "",
  "本方案共 10 部分，覆盖 12 个会议室，现场纳管设备 480 台，对账周期压到 2 天，最终只用 1 张表。",
  "第1部分讲现状与痛点，第2部分讲方案，第3部分讲建设路径，第4部分讲价值，第5部分讲节奏，",
  "第6部分讲分工，第7部分讲试点，第8部分讲推广，第9部分讲验收，第10部分讲复盘。",
].join("\n");

/** 生成器词池：组合出**逐页互不相同**的短句（判据⑤「两页重复」要靠它） */
const G_HEADS = [
  "设备台账",
  "巡检任务",
  "异常上报",
  "数据口径",
  "人员分工",
  "系统对接",
  "现场施工",
  "验收标准",
  "培训交接",
  "运维值守",
  "告警处置",
  "报表口径",
];
const G_NOTE_A = ["设备现场", "巡检班次", "异常处置", "数据口径", "人员职责", "系统对接", "施工安排"];
const G_NOTE_B = ["按区域落地", "按班次执行", "按等级通知", "按口径统一", "按岗位分派"];
const G_LINE_A = [
  "逐台贴码登记",
  "照单派发任务",
  "拍照上报异常",
  "一处录入台账",
  "按岗定责到人",
  "按协议对接接口",
  "分批进场施工",
  "逐项核验交付",
  "分批交接培训",
  "轮值留痕值守",
  "分级通知告警",
  "按天核对数据",
];
const G_LINE_B = ["当场留痕", "到人可查", "有据可依", "口径唯一", "边界清楚", "接口明确", "差异可查"];
/** 页标记（把每一页的短句彻底区分开，去掉标点后也不会撞车） */
const G_MARK = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛"];

/**
 * 小节标签：**按页号单调**地走「问题 → 方案 → 价值」
 *
 * 判据⑥按 kicker / title / subtitle / highlight 判叙事顺序，所以页数超过 6 页（版式循环回来）
 * 也不能让"问题页"再出现一次。
 */
function kickerFor(i: number): string {
  if (i === 0) return "现状与痛点";
  return i <= 3 ? "建设方案" : "价值与收益";
}

/** 第 i 页（0 起）的一页合规大纲页（字段齐全、短句够、标题是观点、内容逐页不同） */
function goodPage(i: number, over: Partial<PptPage> = {}): PptPage {
  const mark = G_MARK[i % G_MARK.length]!;
  const at = (k: number): number => i * 4 + k;
  const head = (k: number): string => G_HEADS[at(k) % G_HEADS.length]!;
  const note = (k: number): string =>
    `${G_NOTE_A[at(k) % G_NOTE_A.length]!}${G_NOTE_B[at(k) % G_NOTE_B.length]!}，${mark}组`;
  const lines = (k: number, n: number): string[] =>
    Array.from(
      { length: n },
      (_, j) => `${G_LINE_A[(at(k) * 4 + j) % G_LINE_A.length]!}${G_LINE_B[(at(k) * 4 + j) % G_LINE_B.length]!}，${mark}组负责`,
    );
  return {
    layout: "网格要点",
    kicker: kickerFor(i),
    icon: "list-check",
    title: `第${i + 1}条硬规则管住现场`,
    subtitle: `第${i + 1}批内容写清边界，现场按码走`,
    blocks: [0, 1, 2, 3].map((k) => ({
      head: head(k),
      note: note(k),
      icon: "file-text",
      lines: lines(k, 3),
    })),
    columns: [],
    stages: [],
    layers: [],
    cards: [],
    table: null,
    chips: [],
    highlight: `第${i + 1}页的一句话结论`,
    ...over,
  };
}

/** 六种版式各一页（页数 >6 时继续轮），每页都判据合格 */
function layoutPage(i: number): PptPage {
  const layouts = ["网格要点", "双栏对比", "流程阶段", "分层架构", "数据卡片", "表格"] as const;
  const layout = layouts[i % layouts.length]!;
  const mark = G_MARK[i % G_MARK.length]!;
  const base = goodPage(i, { layout });
  const at = (k: number): number => i * 4 + k;
  switch (layout) {
    case "网格要点":
      return base; // goodPage 自带 4 块 × 3 行
    case "双栏对比":
      return {
        ...base,
        blocks: [],
        columns: [0, 1].map((k) => ({
          head: G_HEADS[at(k) % G_HEADS.length]!,
          note: `${G_NOTE_A[at(k) % G_NOTE_A.length]!}，${mark}组`,
          icon: "arrows-split",
          lines: Array.from(
            { length: 4 },
            (_, j) => `${G_LINE_A[(at(k) * 5 + j) % G_LINE_A.length]!}${G_LINE_B[(at(k) * 5 + j) % G_LINE_B.length]!}，${mark}组`,
          ),
        })),
      };
    case "流程阶段":
      return {
        ...base,
        blocks: [],
        stages: [0, 1, 2, 3, 4].map((k) => ({
          head: G_HEADS[at(k) % G_HEADS.length]!,
          note: `${G_NOTE_A[at(k) % G_NOTE_A.length]!}${G_NOTE_B[at(k) % G_NOTE_B.length]!}，${mark}组`,
          icon: "route",
        })),
      };
    case "分层架构":
      return {
        ...base,
        blocks: [],
        layers: [0, 1, 2].map((k) => ({
          head: G_HEADS[at(k) % G_HEADS.length]!,
          icon: "hierarchy",
          items: [0, 1, 2].map((j) => `${mark}组${G_NOTE_B[(at(k) + j) % G_NOTE_B.length]!}`.slice(0, 10)),
        })),
      };
    case "数据卡片":
      return {
        ...base,
        blocks: [],
        cards: [0, 1, 2, 3].map((k) => ({
          value: ["12 个", "480 台", "2 天", "1 张表"][k]!,
          label: `${G_HEADS[at(k) % G_HEADS.length]!}，${mark}组`.slice(0, 14),
          icon: "chart-bar",
        })),
      };
    case "表格":
      return {
        ...base,
        blocks: [],
        table: {
          head: ["阶段", "做什么", "谁负责", "验收"],
          icons: ["route", "list-check", "users", "circle-check"],
          rows: [0, 1, 2, 3].map((k) => [
            `${mark}批`,
            `${G_LINE_A[at(k) % G_LINE_A.length]!}，${mark}组`.slice(0, 20),
            `${mark}组`,
            `${G_LINE_B[(at(k) + 1) % G_LINE_B.length]!}为准`,
          ]),
        },
      };
  }
}

/** 一份 n 页、判据**全部合格**的大纲 JSON */
function outlineJson(pages = 6): string {
  return JSON.stringify({ pages: Array.from({ length: pages }, (_, i) => layoutPage(i)) });
}

/** 把第 at 页的标题改成章节式空词（一处「非观点型标题」问题） */
function weakTitleJson(pages = 6, count = 1): string {
  const deck = JSON.parse(outlineJson(pages)) as { pages: PptPage[] };
  for (let k = 0; k < count && k < deck.pages.length; k += 1) {
    deck.pages[k]!.title = "项目概述";
  }
  return JSON.stringify(deck);
}

/** 把第 1 页的一句话抄到第 5 页（一处「两页重复」问题，点名第 5 页） */
function duplicateJson(pages = 6): string {
  const deck = JSON.parse(outlineJson(pages)) as { pages: PptPage[] };
  deck.pages[4]!.highlight = deck.pages[0]!.highlight;
  return JSON.stringify(deck);
}

/**
 * 一份"第 5 页是空页"的大纲 —— 真跑抓到的情形：
 * 第 5 页声明 `layout: "表格"` 却不给 `table`，降级成兜底清单后只剩 2 条短句。
 */
function thinOutlineJson(pages = 6): string {
  const deck = JSON.parse(outlineJson(pages)) as { pages: PptPage[] };
  const at = Math.min(4, deck.pages.length - 1);
  deck.pages[at] = {
    ...deck.pages[at]!,
    layout: "表格",
    blocks: [],
    columns: [],
    stages: [],
    layers: [],
    cards: [],
    table: null,
    bullets: ["协议未收录的私有协议需另行适配", "老设备不支持远程升级"],
  };
  return JSON.stringify(deck);
}

/** 模型调用记录（断言"反馈带没带上一次的问题""正文有没有重读"用） */
interface PromptRecord {
  system: string;
  user: string;
}

/**
 * DSH 桩：按调用次序依次吐出给定的返回文本
 *
 * @param counter 记调用次数（断言"到底调了几次模型"）
 * @param prompts 记每次 system / user（断言提示词里带了什么）
 * @param onCall 每次调用**之前**的回调（用来在轮与轮之间改盘上的正文，验证"每轮重读"）
 */
function mockDsh(
  texts: string[],
  opts: { counter?: { calls: number }; prompts?: PromptRecord[]; onCall?: (index: number) => void } = {},
): DshClient {
  let call = 0;
  return {
    createSession: async () => ({ sessionId: "s" }),
    prompt: (_h: unknown, input: { system: string; user: string }) => {
      const index = call;
      const text = texts[Math.min(index, texts.length - 1)]!;
      call += 1;
      opts.onCall?.(index);
      opts.prompts?.push({ system: input.system, user: input.user });
      if (opts.counter) opts.counter.calls = call;
      return (async function* () {
        yield { type: "text", text };
        yield { type: "done" };
      })();
    },
    cancel: async () => undefined,
  } as unknown as DshClient;
}

/** 只有生成调用（`## 正文` 那一类）的提示词记录 */
function generationPrompts(prompts: readonly PromptRecord[]): PromptRecord[] {
  return prompts.filter((p) => p.user.includes("## 正文"));
}

interface Harness {
  db: DbInstance;
  scenarioId: string;
  scenario: ReturnType<DbInstance["scenarioRepo"]["insert"]>;
  dir: string;
  skill: string;
  log: string;
  events: FollowEvent[];
  push: (event: FollowEvent) => void;
  cleanup: () => void;
}

function makeHarness(skillBody = FAKE_OK, finalizeBody: string | null = FAKE_FINALIZE): Harness {
  const db = createDb(":memory:");
  const { scenarioId, scenario } = seed(db);
  const dir = mkdtempSync(join(homedir(), ".scene-ppt-test-"));
  const skill = makeSkill(skillBody, finalizeBody);
  const log = join(mkdtempSync(join(tmpdir(), "scene-ppt-log-")), "steps.jsonl");
  process.env.PPT_FAKE_LOG = log;
  const events: FollowEvent[] = [];
  return {
    db,
    scenarioId,
    scenario,
    dir,
    skill,
    log,
    events,
    push: (event) => events.push(event),
    cleanup: () => {
      delete process.env.PPT_FAKE_LOG;
      delete process.env.DELIVERABLE_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(skill, { recursive: true, force: true });
      rmSync(log, { recursive: true, force: true });
    },
  };
}

/** 把交付物正文写到盘上（`getReport` 优先读它；每轮重读就是重读这个文件） */
function writeReport(h: Harness, markdown: string, kind: ReportKind = "construction"): void {
  writeFileSync(deliverableReportPath(h.scenarioId, kind), markdown, "utf8");
}

/** 一条真跑（假的转档） */
function runExport(h: Harness, over: Partial<Parameters<typeof exportReportPptx>[0]> = {}) {
  return exportReportPptx({
    db: h.db,
    scenario: h.scenario,
    kind: "construction",
    dir: h.dir,
    dshClient: mockDsh([outlineJson(), outlineJson()]),
    push: h.push,
    skillDir: h.skill,
    ...over,
  });
}

/** 进度文案（断言阶段用） */
const messages = (events: FollowEvent[]): string => events.map((e) => String(e.message ?? "")).join("｜");

describe("exportReportPptx — 第一轮就通过（#146）", () => {
  let h: Harness;
  beforeEach(() => {
    process.env.DELIVERABLE_DIR = mkdtempSync(join(tmpdir(), "scene-ppt-md-"));
    h = makeHarness();
    writeReport(h, DEFAULT_MD);
  });
  afterEach(() => h.cleanup());

  it("命令行参数正确、产物落到目标目录、临时目录被清理", async () => {
    const result = await runExport(h);
    expect(result.files).toHaveLength(1);
    const saved = result.files[0]!;
    expect(saved.startsWith(h.dir)).toBe(true);
    expect(saved.endsWith(pptFileName("PPT 场景", "construction"))).toBe(true);
    expect(saved.endsWith("PPT 场景建设工作方案.pptx")).toBe(true);
    expect(readFileSync(saved).subarray(0, 2).toString("utf8")).toBe("PK");

    // 假导出器记下的命令行：项目目录 + -o 输出 + --no-compat + -f ppt169
    const logged = readLog(h.log).find((r) => r.step === "convert")!;
    const argv = logged.argv;
    expect(argv[1]!.includes("scene-ppt-")).toBe(true); // 临时项目目录
    expect(logged.svgs).toEqual([
      "01_page.svg",
      "02_page.svg",
      "03_page.svg",
      "04_page.svg",
      "05_page.svg",
      "06_page.svg",
    ]);
    expect(argv.slice(2)).toEqual(["-o", join(argv[1]!, "out.pptx"), "--no-compat", "-f", "ppt169"]);
    // 临时项目目录跑完就删
    expect(existsSync(argv[1]!)).toBe(false);
  });

  it("同一份内容再导一次 → 记 unchanged（先读后写）", async () => {
    const first = await runExport(h);
    expect(first.files).toHaveLength(1);
    const again = await runExport(h);
    expect(again.files).toEqual([]);
    expect(again.unchanged).toEqual(first.files);
  });

  it("进度阶段齐：第 1 轮提取 → 优化 → 逐页渲染 → 版面检查通过 → 转 PPTX → 已导出", async () => {
    await runExport(h);
    const text = messages(h.events);
    expect(text).toContain("PPT：正在从正文提取大纲（第 1 轮）…");
    expect(text).toContain("PPT：正在优化大纲…");
    expect(text).toContain("PPT：大纲 6 页，正在渲染第 3 页…");
    expect(text).toContain("PPT：正在做版面检查…");
    expect(text).toContain("PPT：版面检查通过（6 页）");
    expect(text).toContain("PPT：正在转成 PPTX…");
    expect(text).toContain("PPT：已导出");
    // 每页一条，不逐帧刷屏
    expect(text.match(/正在渲染第 /g)).toHaveLength(6);
    expect(h.events.every((e) => e.type === "progress")).toBe(true);
    // 版面检查在转档之前
    expect(text.indexOf("版面检查通过")).toBeLessThan(text.indexOf("正在转成 PPTX"));
  });

  it("第一轮就通过：只调 1 次生成 + 1 次优化（共 2 次模型调用），notice 干净", async () => {
    const calls = { calls: 0 };
    const prompts: PromptRecord[] = [];
    const result = await runExport(h, {
      dshClient: mockDsh([outlineJson(), outlineJson()], { counter: calls, prompts }),
    });
    expect(result.files).toHaveLength(1);
    expect(calls.calls).toBe(2);
    expect(generationPrompts(prompts)).toHaveLength(1); // 只生成了一次
    expect(prompts[1]!.user).toContain("## PPT：只输出优化后的完整 JSON（大纲评审）");
    expect(result.notice ?? "").not.toContain("未达标");
    expect(result.notice ?? "").not.toContain("版面检查未通过");
  });

  it("优化产物被采纳（评审给 7 页，导出的就是 7 页）", async () => {
    const result = await runExport(h, { dshClient: mockDsh([outlineJson(6), outlineJson(7)]) });
    expect(result.files).toHaveLength(1);
    expect(readLog(h.log).find((r) => r.step === "convert")!.svgs).toHaveLength(7);
    expect(messages(h.events)).toContain("PPT：版面检查通过（7 页）");
  });

  it("技能不存在 → notice「找不到 ppt-master 技能」，不产文件、不抛错", async () => {
    const result = await runExport(h, { skillDir: join(tmpdir(), "not-a-skill-dir") });
    expect(result.files).toEqual([]);
    expect(result.notice).toContain("PPT 导出组件未就绪：找不到 ppt-master 技能");
    expect(readdirSync(h.dir)).toEqual([]);
  });

  it("PPT 文件名与 Word / Markdown 同口径（两份交付物各一份名）", () => {
    expect(pptFileName("智慧会议室", "solution")).toBe("智慧会议室解决方案.pptx");
    expect(pptFileName("智慧会议室", "construction")).toBe("智慧会议室建设工作方案.pptx");
    expect(pptFileName("带/斜杠:场景", "solution")).toBe("带_斜杠_场景解决方案.pptx");
  });
});

describe("exportReportPptx — 不合格就重跑（#146 修复闭环）", () => {
  let h: Harness;
  beforeEach(() => {
    process.env.DELIVERABLE_DIR = mkdtempSync(join(tmpdir(), "scene-ppt-md-"));
    h = makeHarness();
    writeReport(h, DEFAULT_MD);
  });
  afterEach(() => h.cleanup());

  it("第一轮不通过、第二轮通过：反馈带上第一轮问题，并且每轮重读正文", async () => {
    const prompts: PromptRecord[] = [];
    const calls = { calls: 0 };
    const result = await runExport(h, {
      dshClient: mockDsh([outlineJson(), duplicateJson(), outlineJson(), outlineJson()], {
        counter: calls,
        prompts,
        // 第 1 轮结束前（评审那一次调用）把正文改掉：第 2 轮取正文必须读到新的
        onCall: (index) => {
          if (index === 1) writeReport(h, `${DEFAULT_MD}\n第二轮补充的正文：现场还要求夜间值守。`);
        },
      }),
    });
    // 两轮各 2 次调用（生成 + 优化），第 2 轮通过
    expect(calls.calls).toBe(4);
    expect(result.files).toHaveLength(1);
    const generations = generationPrompts(prompts);
    expect(generations).toHaveLength(2);
    // 重读正文：第 2 轮的生成提示里带着新写的正文
    expect(generations[1]!.user).toContain("第二轮补充的正文");
    expect(generations[0]!.user).not.toContain("第二轮补充的正文");
    // 反馈：第 1 轮判出的问题（两页重复，点名第 2 页）进了第 2 轮的生成与优化提示
    expect(prompts[2]!.system).toContain("## 上一轮的问题（这一轮必须点对点改掉，别再犯）");
    expect(prompts[2]!.system).toContain("两页重复");
    expect(prompts[3]!.user).toContain("两页重复");
    expect(messages(h.events)).toContain("PPT：正在从正文提取大纲（第 2 轮）…");
  });

  it("三轮都不通过 → 照常导出 + notice 点名未达标（不拒绝写出、不抛错）", async () => {
    const calls = { calls: 0 };
    const result = await runExport(h, {
      dshClient: mockDsh([duplicateJson(), duplicateJson()], { counter: calls }),
    });
    expect(calls.calls).toBe(PPT_OUTLINE_ROUNDS * 2); // 三轮 × (生成 + 优化)
    expect(result.files).toHaveLength(1); // 文件确实产出来了
    expect(existsSync(join(h.dir, pptFileName("PPT 场景", "construction")))).toBe(true);
    expect(result.notice).toContain("已生成，但仍有");
    expect(result.notice).toContain("未达标");
    expect(result.notice).toContain("第 5 页两页重复");
    expect(result.notice).toContain("大纲最低要求：");
    expect(result.notice).not.toContain("版面检查未通过"); // 旧口径不许再出现
    expect(result.notice).not.toContain("PPT 未导出");
    expect(messages(h.events)).toContain("PPT：正在从正文提取大纲（第 3 轮）…");
  });

  it("三轮都不通过 → 导出的是**问题最少的那一轮**（哪怕它不是最后一轮）", async () => {
    // 第 1 轮 1 处问题（两页重复）、第 2 轮 2 处（两页空词标题）、第 3 轮 3 处 → 取第 1 轮（6 页）
    const result = await runExport(h, {
      dshClient: mockDsh([
        duplicateJson(6),
        duplicateJson(6),
        weakTitleJson(7, 2),
        weakTitleJson(7, 2),
        weakTitleJson(5, 3),
        weakTitleJson(5, 3),
      ]),
    });
    expect(result.files).toHaveLength(1);
    expect(readLog(h.log).find((r) => r.step === "convert")!.svgs).toHaveLength(6);
    expect(result.notice).toContain("第 1 轮");
  });

  it("空页（第 5 页只有 2 条）→ 轮内重试一次；重试达标就采纳，不打扰用户", async () => {
    const calls = { calls: 0 };
    const result = await runExport(h, {
      dshClient: mockDsh([thinOutlineJson(6), outlineJson(6), outlineJson(6)], { counter: calls }),
    });
    expect(result.files).toHaveLength(1);
    const text = messages(h.events);
    expect(text).toContain("第 5 页只有 2 条"); // 重试提示点名到页
    expect(text).toContain("重试一次");
    expect(text).toContain("PPT：版面检查通过（6 页）");
    expect(result.notice ?? "").not.toContain("内容偏少");
    expect(calls.calls).toBe(3); // 生成 + 轮内重试 + 优化
  });

  it("解析不出来 → 轮内重试一次；重试成功照常导出", async () => {
    const calls = { calls: 0 };
    const result = await runExport(h, {
      dshClient: mockDsh(["不是 JSON", outlineJson(6), outlineJson(6)], { counter: calls }),
    });
    expect(result.files).toHaveLength(1);
    expect(messages(h.events)).toContain("重试一次");
    expect(calls.calls).toBe(3);
  });

  it("三轮都不合法 → notice 生成失败，不产文件（这条仍然阻断：没有内容就没有 PPT）", async () => {
    const calls = { calls: 0 };
    const result = await runExport(h, {
      dshClient: mockDsh(["我觉得挺好", "还是不写 JSON"], { counter: calls }),
    });
    expect(result.files).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.notice).toContain("PPT 大纲生成失败");
    expect(result.notice).toContain("未导出 PPT");
    expect(readdirSync(h.dir)).toEqual([]);
    expect(calls.calls).toBe(PPT_OUTLINE_ROUNDS * 2);
  });

  it("模型报错 → notice，不产文件", async () => {
    const result = await runExport(h, {
      dshClient: {
        createSession: async () => ({ sessionId: "s" }),
        prompt: () =>
          (async function* () {
            yield { type: "error", message: "模型调用出错" };
          })(),
        cancel: async () => undefined,
      } as unknown as DshClient,
    });
    expect(result.files).toEqual([]);
    expect(result.notice).toContain("PPT 大纲生成失败");
  });

  it("渲染类问题：只 warn 点名，**不再拒绝导出**（#145 的「拒绝写出」作废）", async () => {
    vi.resetModules();
    vi.doMock("@scene/infra", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@scene/infra")>();
      return { ...actual, checkPptDeck: () => [{ page: 2, code: "未对齐网格", detail: "注入的渲染缺陷" }] };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { exportReportPptx: patched } = await import("./ppt-export.js");
      const calls = { calls: 0 };
      const result = await patched({
        db: h.db,
        scenario: h.scenario,
        kind: "construction",
        dir: h.dir,
        dshClient: mockDsh([outlineJson(6), outlineJson(6)], { counter: calls }),
        push: h.push,
        skillDir: h.skill,
      });
      expect(result.files).toHaveLength(1); // 照常导出
      expect(result.notice).toContain("第 2 页未对齐网格：注入的渲染缺陷");
      expect(warn.mock.calls.map((c) => String(c[0])).join("｜")).toContain("版面检查未过（渲染类）");
      expect(readLog(h.log).map((r) => r.step)).toEqual(["finalize", "convert"]);
      expect(calls.calls).toBe(PPT_OUTLINE_ROUNDS * 2); // 每轮都判出这个问题 → 三轮
    } finally {
      warn.mockRestore();
      vi.doUnmock("@scene/infra");
      vi.resetModules();
    }
  });

  it("转档失败（非 0 退出）→ notice 带 stderr 尾巴，不产文件", async () => {
    const bad = makeHarness(FAKE_FAIL);
    process.env.DELIVERABLE_DIR = mkdtempSync(join(tmpdir(), "scene-ppt-md-"));
    writeReport(bad, DEFAULT_MD);
    try {
      const result = await runExport(bad);
      expect(result.files).toEqual([]);
      expect(result.unchanged).toEqual([]);
      expect(result.notice).toContain("转档失败");
      expect(result.notice).toContain("假导出器故意失败");
      expect(readdirSync(bad.dir)).toEqual([]);
    } finally {
      bad.cleanup();
    }
  });

  it("#144 先 finalize（--only embed-icons fix-rounded）再转档：同一个临时项目目录、逐字一样的参数", async () => {
    const result = await runExport(h);
    expect(result.files).toHaveLength(1);
    const records = readLog(h.log);
    expect(records.map((r) => r.step)).toEqual(["finalize", "convert"]);
    const fin = records[0]!;
    const conv = records[1]!;
    expect(fin.argv[0]!.endsWith("finalize_svg.py")).toBe(true);
    expect(fin.argv[1]!.includes("scene-ppt-")).toBe(true);
    expect(fin.argv.slice(2)).toEqual(["--only", "embed-icons", "fix-rounded"]);
    expect(conv.argv[1]).toBe(fin.argv[1]);
    expect(conv.argv.slice(2)).toEqual(["-o", join(fin.argv[1]!, "out.pptx"), "--no-compat", "-f", "ppt169"]);
    const text = messages(h.events);
    expect(text).toContain("PPT：正在嵌入图标…");
    expect(text.indexOf("正在嵌入图标")).toBeLessThan(text.indexOf("正在转成 PPTX"));
  });

  it("#144 每页都有图标占位（≥4 个/页），收尾之后一个 data-icon 残留都不剩", async () => {
    await runExport(h);
    const records = readLog(h.log);
    const fin = records.find((r) => r.step === "finalize")!;
    expect(fin.pages).toHaveLength(6);
    for (const page of fin.pages!) {
      expect(page.icons, `${page.name} 只有 ${page.icons} 个图标占位`).toBeGreaterThanOrEqual(4);
      expect(page.residue, `${page.name} 收尾后还有占位残留`).toBe(0);
    }
    expect(records.find((r) => r.step === "convert")!.finalResidue).toBe(0);
  });

  it("#144 finalize 失败（非 0 退出）→ 只 warn，照常导出 pptx", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.DELIVERABLE_DIR = mkdtempSync(join(tmpdir(), "scene-ppt-md-"));
    const bad = makeHarness(FAKE_OK, FAKE_FINALIZE_FAIL);
    writeReport(bad, DEFAULT_MD);
    try {
      const result = await runExport(bad);
      expect(result.files.length + result.unchanged.length).toBe(1);
      expect(result.notice ?? "").not.toContain("收尾");
      expect(warn.mock.calls.map((c) => String(c[0])).join("｜")).toContain("finalize_svg.py");
      expect(readLog(bad.log).map((r) => r.step)).toEqual(["finalize-fail", "convert"]);
    } finally {
      bad.cleanup();
      warn.mockRestore();
    }
  });

  it("#144 老技能没有 scripts/finalize_svg.py → 跳过这一步，照常导出（只 warn）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.DELIVERABLE_DIR = mkdtempSync(join(tmpdir(), "scene-ppt-md-"));
    const old = makeHarness(FAKE_OK, null);
    writeReport(old, DEFAULT_MD);
    try {
      const result = await runExport(old);
      expect(result.files.length + result.unchanged.length).toBe(1);
      expect(readLog(old.log).map((r) => r.step)).toEqual(["convert"]);
      expect(messages(old.events)).not.toContain("正在嵌入图标");
      expect(warn.mock.calls.map((c) => String(c[0])).join("｜")).toContain("跳过图标嵌入");
    } finally {
      old.cleanup();
      warn.mockRestore();
    }
  });

  it("合同里的页数口径没被改歪（5–10 页、目标 7 页、三轮闭环）", () => {
    expect(PPT_LIMITS.minPages).toBe(5);
    expect(PPT_LIMITS.maxPages).toBe(10);
    expect(PPT_OUTLINE_ROUNDS).toBe(3);
  });
});
