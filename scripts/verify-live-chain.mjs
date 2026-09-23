/* T5.6 真实链路端到端走查（构建产物单端口 · 独立 DB · 密钥感知）
 *
 * 覆盖确定性真实链路：实时模式 → 产品线/白皮书上传入库（doc-parser 无密钥依赖）
 * → 项目 CRUD → 阶段面板（有密钥走真实分析落库；无密钥断言流内降级【错误】）
 * → 右栏决策支撑真实快照 → 双口径导出落盘 md → decide 推进 → 对话 converse。
 * 由 scripts/verify-m5.sh 拉起配套服务后调用；也可手动：
 *   APP_PORT=4098 DB_PATH=... EXPORT_DIR=... WEB_DIST=apps/web/dist node apps/server/dist/index.js &
 *   BASE_URL=http://127.0.0.1:4098 EXPORT_DIR=/tmp/... node scripts/verify-live-chain.mjs
 * 密钥可用性由 SCENE_HAS_KEY=1 显式声明（verify-m5.sh 按默认供应商 apiKeyEnv 自动探测）。
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(ROOT + "/");
/* 根 devDependency 是 @playwright/test（其再导出 chromium）；playwright 裸包未提升，不直接 require */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:4098";
const EXPORT_DIR = process.env.EXPORT_DIR ?? "/tmp/scene-verify-exports";
const PDF = join(ROOT, "scripts/spike/s3/sample.pdf");
const HAS_KEY = process.env.SCENE_HAS_KEY === "1";

const results = [];
function ok(name, cond, extra = "") {
  results.push(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) {
    console.log(results.join("\n"));
    process.exit(1);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const dialogQueue = [];
page.on("dialog", async (d) => {
  const next = dialogQueue.shift();
  try {
    if (d.type() === "prompt") {
      await d.accept(typeof next?.text === "string" ? next.text : (d.defaultValue || ""));
    } else if (d.type() === "confirm") {
      (next?.accept ?? true) ? await d.accept() : await d.dismiss();
    } else {
      await d.dismiss();
    }
  } catch (e) {
    console.log(`  [dialog err] ${d.type()}: ${e.message}`);
  }
});

/* 1. 实时模式（单端口构建产物） */
await page.goto(BASE);
await page.waitForSelector("text=实时数据", { timeout: 8000 });
ok("1 构建产物单端口起应用，进入实时数据模式", true);

/* 2. 产品线 + 真实白皮书上传入库（无密钥依赖的确定性链路） */
await page.click(".nav-item:has-text('产品资料库')");
/* 等产品线选择器出现（新库时先渲染空态，建线后才有 select；text= 引擎不能混进 CSS 逗号列表，用 locator） */
await page.locator("select[aria-label='选择产品线'], .empty-state-title").first().waitFor({ state: "visible", timeout: 8000 });
const hasTargetLine = () =>
  page.evaluate(
    () =>
      [...document.querySelectorAll("select[aria-label='选择产品线'] option")].some(
        (o) => o.textContent === "端到端测试线",
      ),
  );
if (!(await hasTargetLine())) {
  dialogQueue.push({ text: "端到端测试线" });
  await page.click("button:has-text('新建产品线')");
  /* 等产品线真正选中：上传按钮常驻，早触发会因未选线被拒 */
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("select[aria-label='选择产品线'] option")].some(
        (o) => o.textContent === "端到端测试线",
      ),
    null,
    { timeout: 10_000 },
  );
}
ok("2a 产品线就绪（真实落库并选中）", true);
await page.setInputFiles("main input[type=file]", PDF);
await page.waitForFunction(
  () => /【完成】入库 \d+ 行/.test(document.querySelector(".stale-banner")?.textContent ?? ""),
  null,
  { timeout: 60_000 },
);
const ingestLine = await page.evaluate(
  () =>
    (document.querySelector(".stale-banner")?.textContent ?? "").match(/【完成】入库 \d+ 行/)?.[0],
);
ok("2b 真实白皮书 PDF 上传 → 解析入库 SSE 完成", !!ingestLine, ingestLine);

/* 3. 项目创建（侧栏「新建」→ prompt → 自动进工作台） */
dialogQueue.push({ text: "端到端实测项目" });
await page.click(".nbtn");
await page.waitForSelector(".proj-hd:has-text('端到端实测项目')", { timeout: 8000 });
await page.waitForSelector("text=导出交付物", { timeout: 8000 });
ok("3 项目创建（真实落库、自动进入工作台）", true);

/* 4. 阶段分析 SSE 链路：密钥在 → 真实落库；密钥缺 → 流内降级【错误】 */
const startBtn = page.locator("button:has-text('开始本阶段分析')");
let analysisNote = "面板已有结果（跳过发起）";
if (await startBtn.count()) {
  await startBtn.click();
  if (HAS_KEY) {
    await page.waitForFunction(
      () => /【完成】分析结果已落库/.test(document.body.innerText),
      null,
      { timeout: 300_000 },
    );
    analysisNote = "真实分析落库完成";
  } else {
    await page.waitForFunction(
      () => /【错误】/.test(document.body.innerText),
      null,
      { timeout: 60_000 },
    );
    analysisNote = "无密钥降级：流内【错误】上屏（SSE 通路验证）";
  }
}
ok("4 阶段分析 SSE 链路（真实或降级）实时上屏", true, analysisNote);

/* 5. 右栏决策支撑：真实快照（联真版专属文案，非 mock） */
await page.waitForFunction(
  () => {
    const det = document.querySelector(".det");
    return det && /来源与证据/.test(det.innerText) && /GET stages/.test(det.innerText);
  },
  null,
  { timeout: 10_000 },
);
const detSummary = await page.evaluate(() => {
  const t = document.querySelector(".det").innerText;
  return (t.match(/\d+ 行（用户确认 \d+）/) ?? [""])[0];
});
ok("5 右栏决策支撑为真实数据快照（非 mock 文案）", true, detSummary);

/* 6. 交付物双口径导出：服务端落盘 md + toast 回显路径 */
const filesBefore = existsSync(EXPORT_DIR) ? readdirSync(EXPORT_DIR).length : 0;
await page.click("button:has-text('导出交付物')");
await page.waitForFunction(
  () => /双口径导出完成/.test(document.body.innerText),
  null,
  { timeout: 30_000 },
);
const mdFiles = readdirSync(EXPORT_DIR).filter((f) => f.endsWith(".md"));
ok("6a 双口径导出 toast 回显服务端路径", mdFiles.length > filesBefore, mdFiles.slice(-2).join(", "));
const newest = mdFiles.sort().slice(-1)[0];
const content = readFileSync(join(EXPORT_DIR, newest), "utf-8");
ok("6b 导出 md 非空且含报告结构", content.length > 200 && /#/.test(content), `${newest} ${content.length}B`);

/* 7. decide「继续」真实推进阶段 */
await page.click("button:has-text('完成阶段')");
await page.waitForFunction(
  () => /已确认继续，项目进入阶段/.test(document.body.innerText),
  null,
  { timeout: 10_000 },
);
ok("7 decide「继续」真实推进阶段", true);

/* 8. 对话 converse 闭环存在性（细节覆盖见 M5-T5.5 验收） */
await page.click(".conv-ta");
await page.fill(".conv-ta", "端到端走查：这个场景能不能进？");
await page.press(".conv-ta", "Enter");
await page.waitForFunction(
  () =>
    [...document.querySelectorAll(".msg.ai .bub")].some(
      (e) => e.textContent.length > 0 && !/^思考中…$/.test(e.textContent),
    ),
  null,
  { timeout: 90_000 },
);
const aiBubble = await page.locator(".msg.ai .bub").last().textContent();
ok("8 对话抽屉真实会话回复落定", !!aiBubble, aiBubble.slice(0, 40));

await browser.close();
console.log(results.join("\n"));
console.log(
  HAS_KEY
    ? "\nT5.6 真实链路走查（含真实 LLM 分析）：全部通过 ✅"
    : "\nT5.6 真实链路走查（无密钥降级模式）：全部通过 ✅；真实 LLM 分析段待配置密钥后复跑",
);
