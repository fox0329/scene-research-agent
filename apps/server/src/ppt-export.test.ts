/**
 * @scene/server — 导出 PPT 测试（变更表 #141）
 *
 * **不真跑用户的技能**（慢，还依赖本机装的依赖）：用 `PPT_MASTER_DIR` 指到一个 fixture 目录，
 * 里面放一个假的 `scripts/svg_to_pptx.py`——它只把命令行与 svg 页数记到日志、写一个占位 pptx。
 * 由此验证：命令行参数正确、产物落到目标目录、临时目录被清理、进度阶段齐、失败只回 notice。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DshClient, FollowEvent, PptPage } from "@scene/contract";
import { createDb, type DbInstance } from "@scene/infra";
import { exportReportPptx, pptFileName } from "./ppt-export.js";

// ─── fixture：假技能（导出器只写占位文件 + 记录命令行） ──────

/** 假导出器：把 argv 与 svg_output 下的页数写进 `PPT_FAKE_LOG`，再写一个占位 pptx */
const FAKE_OK = [
  "import json, os, pathlib, sys",
  "log = os.environ.get('PPT_FAKE_LOG')",
  "out = None",
  "args = sys.argv[1:]",
  "for i, a in enumerate(args):",
  "    if a in ('-o', '--output'):",
  "        out = args[i + 1]",
  "if out is None:",
  "    sys.exit(2)",
  "svgs = sorted(os.listdir(os.path.join(args[0], 'svg_output')))",
  "if log:",
  "    pathlib.Path(log).write_text(json.dumps({'argv': sys.argv, 'svgs': svgs}), encoding='utf-8')",
  "pathlib.Path(out).write_bytes(b'PK\\x03\\x04fake-pptx')",
  "print('导出完成：0 失败')",
].join("\n");

/** 假导出器（失败版）：非 0 退出 + stderr 有话说 */
const FAKE_FAIL = [
  "import sys",
  "sys.stderr.write('Traceback: 假导出器故意失败\\n')",
  "sys.exit(3)",
].join("\n");

function makeSkill(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "scene-ppt-skill-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "svg_to_pptx.py"), body, "utf8");
  return dir;
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

/** 一份合规的 6 页大纲 JSON */
function outlineJson(pages = 6): string {
  const page = (i: number): PptPage => ({
    layout: (["要点", "双栏对比", "数据卡片", "图文说明", "表格", "要点"] as const)[i % 6]!,
    title: `第${i + 1}页标题`,
    takeaway: `第${i + 1}页的一句话要点`,
    bullets: ["要点甲", "要点乙", "要点丙"],
    columns: [
      { head: "今天", bullets: ["纸质记录"] },
      { head: "建成后", bullets: ["自动采集"] },
    ],
    cards: [
      { value: "统一纳管", label: "设备台账" },
      { value: "实时可见", label: "运行状态" },
      { value: "闭环处置", label: "异常工单" },
    ],
    table: { head: ["层次", "承担什么"], rows: [["感知层", "采集现场数据"]] },
  });
  return JSON.stringify({ pages: Array.from({ length: pages }, (_, i) => page(i)) });
}

/** DSH 桩：按调用次序依次吐出给定的返回文本 */
function mockDsh(texts: string[]): DshClient {
  let call = 0;
  return {
    createSession: async () => ({ sessionId: "s" }),
    prompt: () => {
      const text = texts[Math.min(call, texts.length - 1)]!;
      call += 1;
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

function makeHarness(skillBody = FAKE_OK): Harness {
  const db = createDb(":memory:");
  const { scenarioId, scenario } = seed(db);
  const dir = mkdtempSync(join(homedir(), ".scene-ppt-test-"));
  const skill = makeSkill(skillBody);
  const log = join(mkdtempSync(join(tmpdir(), "scene-ppt-log-")), "argv.json");
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
    const logged = JSON.parse(readFileSync(h.log, "utf8")) as { argv: string[]; svgs: string[] };
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
    expect(text).toContain("PPT：正在转成 PPTX…");
    expect(text).toContain("PPT：已导出");
    // 每页一条，不逐帧刷屏
    expect(text.match(/正在渲染第 /g)).toHaveLength(6);
    expect(h.events.every((e) => e.type === "progress")).toBe(true);
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
