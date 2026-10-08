/**
 * @scene/server — 导出 PPT 测试（变更表 #141 立、#144 升、#145 升：生成后必做版面检查）
 *
 * **不真跑用户的技能**（慢，还依赖本机装的依赖）：用 `PPT_MASTER_DIR` 指到一个 fixture 目录，
 * 里面放假的 `scripts/finalize_svg.py`（图标收尾）与 `scripts/svg_to_pptx.py`（转档）——
 * 两者只把命令行与看到的东西记进 `PPT_FAKE_LOG`（一行一条 JSON），转档器再写一个占位 pptx。
 * 由此验证：**两步的先后次序与参数逐字固定**（#144）、命令行参数正确、产物落到目标目录、
 * 临时目录被清理、进度阶段齐、finalize 失败/缺脚本都只 warn 不阻断、失败只回 notice；
 * #145 追加：**渲染完必跑 `checkPptDeck`**——内容类问题点名后重试一次，仍不达标（或渲染类
 * 问题）**拒绝写出文件、用户原有文件一个字节都不动**。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { DshClient, FollowEvent, PptPage } from "@scene/contract";
import { createDb, type DbInstance } from "@scene/infra";
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

/** 一份合规的 6 页大纲 JSON（六种布局轮着来；每页有效短句都 ≥8，不触发"内容偏少"重试） */
function outlineJson(pages = 6): string {
  const layouts = ["网格要点", "双栏对比", "流程阶段", "分层架构", "数据卡片", "表格"] as const;
  const page = (i: number): PptPage => ({
    layout: layouts[i % layouts.length]!,
    kicker: `小节${i + 1}`,
    icon: "presentation",
    title: `第${i + 1}页标题`,
    subtitle: `第${i + 1}页的一句副题`,
    blocks: [
      { head: "设备台账", note: "谁在现场", icon: "file-text", lines: ["逐台贴码", "型号一次录清", "换机当场更新"] },
      { head: "巡检任务", note: "照班次发单", icon: "calendar-check", lines: ["派发到人", "漏项提醒", "时间留痕"] },
      { head: "异常上报", note: "拍照即上报", icon: "alert-triangle", lines: ["必传照片", "分级通知", "过程可查"] },
      { head: "数据口径", note: "一处录入", icon: "database", lines: ["只录一次", "同一口径", "对账有据"] },
    ],
    columns: [
      { head: "今天", note: "纸质表单", icon: "file-text", lines: ["纸质记录", "人工统计", "事后补录"] },
      { head: "建成后", note: "扫码巡检", icon: "list-check", lines: ["自动采集", "实时看板", "自动派单"] },
    ],
    stages: [
      { head: "样板层", note: "一个楼层先装齐", icon: "building-community" },
      { head: "验证", note: "两周比对纸质记录", icon: "checkup-list" },
      { head: "复制", note: "按楼层分批上线", icon: "devices" },
      { head: "全区", note: "全区纳管出报表", icon: "sitemap" },
    ],
    layers: [
      { head: "应用层", icon: "chart-bar", items: ["巡检看板", "异常工单"] },
      { head: "平台层", icon: "server", items: ["设备纳管", "规则引擎"] },
      { head: "感知层", icon: "wifi", items: ["扫码终端", "温湿度探头"] },
    ],
    cards: [
      { value: "12 个", label: "纳管楼层", icon: "building-skyscraper" },
      { value: "480 台", label: "纳管设备", icon: "devices" },
      { value: "2 天", label: "对账周期", icon: "clock" },
      { value: "1 张表", label: "统一口径", icon: "report-analytics" },
    ],
    table: {
      head: ["阶段", "做什么", "谁负责"],
      icons: ["route", "list-check", "users"],
      rows: [
        ["样板层", "装齐终端并贴码", "运维班"],
        ["单点验证", "比对纸质与系统记录", "信息部"],
      ],
    },
    chips: ["扫码巡检"],
    highlight: `第${i + 1}页的结论带`,
  });
  return JSON.stringify({ pages: Array.from({ length: pages }, (_, i) => page(i)) });
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

/** DSH 桩：按调用次序依次吐出给定的返回文本（`counter` 用来断言"到底调了几次模型"） */
function mockDsh(texts: string[], counter?: { calls: number }): DshClient {
  let call = 0;
  return {
    createSession: async () => ({ sessionId: "s" }),
    prompt: () => {
      const text = texts[Math.min(call, texts.length - 1)]!;
      call += 1;
      if (counter) counter.calls = call;
      return (async function* () {
        yield { type: "text", text };
        yield { type: "done" };
      })();
    },
    cancel: async () => undefined,
  } as unknown as DshClient;
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

/** 一条真跑（假的转档） */
function runExport(h: Harness, over: Partial<Parameters<typeof exportReportPptx>[0]> = {}) {
  return exportReportPptx({
    db: h.db,
    scenario: h.scenario,
    kind: "construction",
    dir: h.dir,
    dshClient: mockDsh([outlineJson()]),
    push: h.push,
    skillDir: h.skill,
    ...over,
  });
}

/** 进度文案（断言阶段用） */
const messages = (events: FollowEvent[]): string => events.map((e) => String(e.message ?? "")).join("｜");

describe("exportReportPptx", () => {
  let h: Harness;
  beforeEach(() => {
    process.env.DELIVERABLE_DIR = mkdtempSync(join(tmpdir(), "scene-ppt-md-"));
    h = makeHarness();
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

  it("进度阶段齐：大纲 → 逐页渲染 → 转 PPTX → 已导出", async () => {
    await runExport(h);
    const text = messages(h.events);
    expect(text).toContain("PPT：正在梳理大纲…");
    expect(text).toContain("PPT：大纲 6 页，正在渲染第 3 页…");
    expect(text).toContain("PPT：正在做版面检查…");
    expect(text).toContain("PPT：版面检查通过（6 页）");
    expect(text).toContain("PPT：正在转成 PPTX…");
    expect(text).toContain("PPT：已导出");
    // 每页一条，不逐帧刷屏
    expect(text.match(/正在渲染第 /g)).toHaveLength(6);
    expect(h.events.every((e) => e.type === "progress")).toBe(true);
    // 版面检查在转档之前（检查不过就不该去转档）
    expect(text.indexOf("版面检查通过")).toBeLessThan(text.indexOf("正在转成 PPTX"));
  });

  it("大纲不合法 → 重试一次；仍不合法 → notice，不产文件", async () => {
    const result = await runExport(h, { dshClient: mockDsh(["我觉得挺好", "还是不写 JSON"]) });
    expect(result.files).toEqual([]);
    expect(result.notice).toContain("PPT 大纲生成失败");
    expect(result.notice).toContain("未导出 PPT");
    expect(readdirSync(h.dir)).toEqual([]);
  });

  it("首次不合法、重试成功 → 照常导出（并把校验调整写进 notice）", async () => {
    const good = outlineJson(6);
    const result = await runExport(h, { dshClient: mockDsh(["不是 JSON", good]) });
    expect(result.files).toHaveLength(1);
    expect(result.notice ?? "").not.toContain("大纲生成失败");
  });

  it("首轮页数少于 5 页下限 → 也重试一次（重试给够页数才导出）", async () => {
    const result = await runExport(h, { dshClient: mockDsh([outlineJson(3), outlineJson(6)]) });
    expect(result.files).toHaveLength(1);
    const text = messages(h.events);
    expect(text).toContain("首次只排了 3 页");
    expect(text).toContain("大纲 6 页，正在渲染第 1 页");
    // 重试仍不到 5 页：不再纠缠，照常导出并在 notice 里说明（页数不能凭空造）
    const thin = await runExport(h, { dshClient: mockDsh([outlineJson(3), outlineJson(4)]) });
    expect(thin.files.length + thin.unchanged.length).toBe(1);
    expect(thin.notice ?? "").toContain("少于 5 页");
  });

  it("某页只有 2 条短句（空页）→ 重试一次；重试达标则采纳，不打扰用户", async () => {
    const result = await runExport(h, { dshClient: mockDsh([thinOutlineJson(6), outlineJson(6)]) });
    expect(result.files).toHaveLength(1);
    const text = messages(h.events);
    expect(text).toContain("第 5 页只有 2 条"); // 重试提示点名到页
    expect(text).toContain("重试一次");
    expect(text).toContain("大纲 6 页，正在渲染第 1 页"); // 采纳的是重试那一份
    expect(result.notice ?? "").not.toContain("内容偏少");
  });

  it("重试后那页还是只有 2 条 → 版面检查不过，拒绝写出并点名第 5 页（#145）", async () => {
    const calls = { calls: 0 };
    const result = await runExport(h, {
      dshClient: mockDsh([thinOutlineJson(6), thinOutlineJson(6)], calls),
    });
    expect(result.files).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.notice).toContain("版面检查未通过");
    expect(result.notice).toContain("第 5 页");
    expect(result.notice).toContain("信息量不足");
    expect(result.notice).toContain("最低要求：内容字号 ≥16px"); // 引用 PPT_MIN_QUALITY，冻结这一档
    expect(result.notice).toContain("保留原有文件不动");
    expect(readdirSync(h.dir)).toEqual([]); // 一个字节都没写出去
    // 内容类问题只再要一次模型（首次 + 空页重试 + 版面重试 = 3 次），不许无限重试
    expect(calls.calls).toBe(3);
  });

  it("首次有空页、重试反而吐垃圾 → 版面检查仍不过，一样拒绝写出（不留半成品）", async () => {
    const calls = { calls: 0 };
    const result = await runExport(h, {
      dshClient: mockDsh([thinOutlineJson(6), "我这次啥也不给"], calls),
    });
    expect(result.files).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.notice).toContain("版面检查未通过");
    expect(result.notice).toContain("第 5 页");
    expect(readLog(h.log)).toEqual([]); // 连转档都没跑
  });

  it("版面检查不过时**不动用户已有的文件**（原有文件保留、也没写半个新的）", async () => {
    const { scenario, kind } = { scenario: h.scenario, kind: "construction" as const };
    const existing = join(h.dir, pptFileName(scenario.name, kind));
    writeFileSync(existing, "上一版正常导出的内容", "utf8");

    const result = await runExport(h, { dshClient: mockDsh([thinOutlineJson(6), thinOutlineJson(6)]) });
    expect(result.files).toEqual([]);
    expect(result.notice).toContain("保留原有文件不动");
    expect(readFileSync(existing, "utf8")).toBe("上一版正常导出的内容");
    expect(readdirSync(h.dir)).toEqual([pptFileName(scenario.name, kind)]);
  });

  it("内容类问题点名后重试一次成功 → 采纳重试的大纲，导出并报「版面检查通过」（#145）", async () => {
    const result = await runExport(h, {
      dshClient: mockDsh([thinOutlineJson(6), thinOutlineJson(6), outlineJson(6)]),
    });
    expect(result.files).toHaveLength(1);
    const text = messages(h.events);
    expect(text).toContain("PPT：正在做版面检查…");
    expect(text).toContain("第 5 页信息量不足"); // 点名到页 + 具体问题
    expect(text).toContain("重试一次");
    expect(text).toContain("PPT：版面检查通过（6 页）");
    expect(result.notice ?? "").not.toContain("版面检查未通过");
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
    // 转档这一步的参数保持原样（不加 -s final：原生转档读 svg_output）
    expect(conv.argv[1]).toBe(fin.argv[1]);
    expect(conv.argv.slice(2)).toEqual(["-o", join(fin.argv[1]!, "out.pptx"), "--no-compat", "-f", "ppt169"]);
    // 进度里明说了这一步，且在"正在转成 PPTX"之前
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
    // 转档器看到 svg_final 时，占位已全部换成图标
    expect(records.find((r) => r.step === "convert")!.finalResidue).toBe(0);
  });

  it("#144 finalize 失败（非 0 退出）→ 只 warn，照常导出 pptx", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bad = makeHarness(FAKE_OK, FAKE_FINALIZE_FAIL);
    try {
      const result = await runExport(bad);
      expect(result.files.length + result.unchanged.length).toBe(1);
      expect(result.notice ?? "").not.toContain("收尾");
      expect(warn.mock.calls.map((c) => String(c[0])).join("｜")).toContain("finalize_svg.py");
      // 收尾失败也照样走到转档（不阻断）
      expect(readLog(bad.log).map((r) => r.step)).toEqual(["finalize-fail", "convert"]);
    } finally {
      bad.cleanup();
      warn.mockRestore();
    }
  });

  it("#144 老技能没有 scripts/finalize_svg.py → 跳过这一步，照常导出（只 warn）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const old = makeHarness(FAKE_OK, null);
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

  it("转档失败（非 0 退出）→ notice 带 stderr 尾巴，不产文件", async () => {
    const bad = makeHarness(FAKE_FAIL);
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

  it("渲染类问题：不重试模型，拒绝写出并把缺陷打进日志（bug 信号）（#145）", async () => {
    // 渲染层已经把版面修到达标了，能走到这里说明是我们的 bug——用注入的方式验证这条链路：
    // 不许拿模型重试去掩盖渲染缺陷，只许拒绝写出 + 日志点名
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
        dshClient: mockDsh([outlineJson(6)], calls),
        push: h.push,
        skillDir: h.skill,
      });
      expect(result.files).toEqual([]);
      expect(result.notice).toContain("版面检查未通过");
      expect(result.notice).toContain("第 2 页未对齐网格：注入的渲染缺陷");
      expect(result.notice).toContain("保留原有文件不动");
      expect(calls.calls).toBe(1); // 渲染类问题一次模型都不多调
      expect(warn.mock.calls.map((c) => String(c[0])).join("｜")).toContain("版面检查未过（渲染类）");
      expect(readLog(h.log)).toEqual([]); // 没走到转档
    } finally {
      warn.mockRestore();
      vi.doUnmock("@scene/infra");
      vi.resetModules();
    }
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
