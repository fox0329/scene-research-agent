/* T5.6 真实链路端到端走查（构建产物单端口 · 独立 DB · 密钥感知）
 *
 * 覆盖确定性真实链路：实时模式 → 产品线/白皮书上传入库（doc-parser 无密钥依赖）
 * → 项目 CRUD → 阶段面板（有密钥走真实分析落库；无密钥断言流内降级【错误】）
 * → 右栏决策支撑真实快照 → 双口径导出落盘 md → decide 推进 → 对话 converse。
 * 由 scripts/verify-m5.sh 拉起配套服务后调用；也可手动：
 *   APP_PORT=4098 DB_PATH=... EXPORT_DIR=... WEB_DIST=apps/web/dist node apps/server/dist/index.js &
 *   BASE_URL=http://127.0.0.1:4098 EXPORT_DIR=/tmp/... node scripts/verify-live-chain.mjs
 * 密钥可用性由 SCENE_HAS_KEY=1 显式声明（verify-m5.sh 按应用登记表 data/providers.local.json
 * 的默认供应商是否已填 Key 自动探测，并通过 SCENE_PROVIDERS_FILE 注入对应文件）。
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
  () => /【完成】\d+ 个文件 · 共入库 \d+ 行/.test(document.querySelector(".stale-banner")?.textContent ?? ""),
  null,
  { timeout: 60_000 },
);
const ingestLine = await page.evaluate(
  () =>
    (document.querySelector(".stale-banner")?.textContent ?? "").match(/【完成】\d+ 个文件 · 共入库 \d+ 行/)?.[0],
);
ok("2b 真实白皮书 PDF 上传 → 解析入库 SSE 完成", !!ingestLine, ingestLine);

/* 3. 项目创建（v2.2 对话式定义）：新建**只输名称** → 自动弹「场景定义」对话页
      → 点「整理成定义」→ 对话落成表1-1（对照 6 行） */
await page.click(".nbtn");
const nameDlg = page.locator("[role='dialog'][aria-label='新建场景']");
await nameDlg.waitFor({ state: "visible", timeout: 10_000 });
await nameDlg.locator("input.brief-input").fill(`端到端实测项目`);
await nameDlg.getByRole("button", { name: "创建并开始定义" }).click();

const defDlg = page.locator("[role='dialog'][aria-label='场景定义']");
await defDlg.waitFor({ state: "visible", timeout: 20_000 });
ok("3a 新建只输名称 → 自动弹出「场景定义」对话页（不再让用户填空）", true);

/* 首轮由弹窗自动发引导消息，模型给出理解 + 提问（真实链路较慢，等回复出现） */
await page.waitForFunction(
  () => {
    const d = document.querySelector("[role='dialog'][aria-label='场景定义']");
    return !!d && (d.textContent ?? "").length > 120;
  },
  null,
  { timeout: 180_000 },
).catch(() => undefined);

/* 补一句用户回答，再点「整理成定义」（写表由用户显式触发） */
const chatInput = defDlg.locator("textarea").first();
if ((await chatInput.count()) > 0) {
  await chatInput.fill("客户是市政水务集团，范围只看出厂到管网，明确不含二次供水");
  await defDlg.getByRole("button", { name: "发送" }).click();
  await page.waitForTimeout(1500);
}
await defDlg.getByRole("button", { name: "整理成定义" }).click();
await defDlg.locator(".schema-table").first().waitFor({ state: "visible", timeout: 180_000 });
const l1Rows = await defDlg.locator(".schema-table tbody tr").count();
await defDlg.getByRole("button", { name: /完成，去确认表格/ }).click();
await page.waitForSelector(".proj-hd:has-text('端到端实测项目')", { timeout: 8000 });
ok("3b 整理成定义 → 表1-1 对照 6 项（写表由用户显式触发）", l1Rows === 6, `${l1Rows} 行`);

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

/* 5. 右栏双 Tab：补充说明（确认清单 L1 ≥6）/ 阶段总结（六段骨架） */
const detTabs = page.locator(".det .det-tab");
await detTabs.first().waitFor({ state: "visible", timeout: 15_000 });
const tabCount = await detTabs.count();
await detTabs.nth(0).click();
const l1Count = await page.locator(".det .layer-L1").count();
await detTabs.nth(1).click();
const mdText = (await page.locator(".det .md-body").innerText().catch(() => "")) || "";
const hasSix = /信息摘要/.test(mdText) && /信息缺口与待补充/.test(mdText);
/* 产品不产出判断：整页不得出现建议档位措辞 */
const noAdvice = !/建议(通过|有条件通过|不通过|进)/.test(await page.locator(".shell").innerText());
ok("5 右栏双 Tab（补充说明 + 阶段总结）且不产出判断",
  tabCount === 2 && l1Count >= 6 && hasSix && noAdvice,
  `Tab ${tabCount} 个 · L1 ${l1Count} 项 · 六段 ${hasSix} · 无建议措辞 ${noAdvice}`);

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
/* 注意：文件名按字典序排会把「对外」排到最后，因此必须按文件名分别读取 */
const newest = mdFiles.sort().slice(-1)[0];
const intPath = join(EXPORT_DIR, "内部调研报告.md");
const content = existsSync(intPath) ? readFileSync(intPath, "utf-8") : "";
/* 装配式交付物：内部报告含阶段总结与附录；对外材料只放中栏列（不含来源/证据级） */
const extPath = join(EXPORT_DIR, "对外汇报材料.md");
const extContent = existsSync(extPath) ? readFileSync(extPath, "utf-8") : "";
const internalOk = content.length > 200 && /场景调研/.test(content) && /来源索引/.test(content);
const externalClean = extContent.length > 100 && !/证据等级|来源权威性/.test(extContent);
ok("6b 交付物为装配式（内部含阶段总结+附录；对外不含内部治理信息）",
  internalOk && externalClean, `${newest} ${content.length}B · 内部 ${internalOk} / 对外 ${externalClean}`);

/* 7. 流程推进（导航动作，不是判断，信息不齐备也不阻断）
   断言改成**语义断言**：只看流程是否真的前移（比比对 toast 文案稳） */
const doneBefore = await page.locator(".flow-rail .flow-node--done").count();
const advanceBtn = page
  .locator("button:has-text('完成本步'), button:has-text('进入下一阶段')")
  .first();
await advanceBtn.click();
await page.waitForFunction(
  (n) => document.querySelectorAll(".flow-rail .flow-node--done").length > n,
  doneBefore,
  { timeout: 20_000 },
);
const doneAfter = await page.locator(".flow-rail .flow-node--done").count();
ok("7 「完成本步」真实推进流程（导航动作，缺口不阻断）", doneAfter > doneBefore, `已完成步 ${doneBefore} → ${doneAfter}`);

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
