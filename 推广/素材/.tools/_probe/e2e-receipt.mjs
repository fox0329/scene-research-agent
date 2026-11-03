/** 端到端验「逐文件入库回执」：在**副本库**上真上传一次 PPT，看界面报的行数。
 *  只上传 pptx（9 页演示 PPT）——它正是「传了却一行不落」的那个文件。
 *
 *  **必须先起一个副本库上的服务**（会用真模型抽取，跑一次约 1 分钟）：
 *    cp "$HOME/Library/Application Support/@scene/desktop/data/scene.db" /tmp/e2e-receipt.db
 *    APP_PORT=46176 DB_PATH=/tmp/e2e-receipt.db node apps/server/dist/index.js &
 *    node 推广/素材/.tools/_probe/e2e-receipt.mjs
 *    kill $(lsof -ti tcp:46176)
 *
 *  绝不要指向演示库（46172）：重跑入库会把入库行数从 222 顶到 266，
 *  推广文稿与截图里那套数字就对不上了。 */
import { chromium } from "@playwright/test";
import { join } from "node:path";

const URL = "http://127.0.0.1:46176/";
// 相对自身定位，别写本机绝对路径（隐私扫描的「本机路径」规则会命中）
const PPTX = join(import.meta.dirname, "..", "..", "demo资料", "云枢智控-产品介绍.pptx");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("console", (m) => { if (m.type() === "error") console.log("  [浏览器错误]", m.text().slice(0, 160)); });
await page.goto(URL, { waitUntil: "load" });
await page.waitForTimeout(1500);

// 从左侧导航进「产品资料库」（上传入口在那一屏）
await page.locator("button", { hasText: /产品资料库/ }).first().click();
await page.waitForTimeout(1500);
const line = page.locator('select[aria-label="选择产品线"]');
if (await line.count()) { await line.selectOption({ index: 0 }).catch(() => {}); await page.waitForTimeout(1000); }
const imported = page.getByRole("button", { name: "已导入资料" }).first();
if (await imported.count()) { await imported.click(); await page.waitForTimeout(800); }

// 上传 PPT：文件输入是隐藏的，直接喂
const input = page.locator('input[type="file"]').first();
await input.setInputFiles(PPTX);
console.log("已投喂 PPT，等模型抽取（可能要一会儿）…");

// 等「入库结果」区出现收尾行
const deadline = Date.now() + 8 * 60_000;
let text = "";
while (Date.now() < deadline) {
  text = await page.locator("body").innerText();
  if (/【完成】|【错误】/.test(text)) break;
  await page.waitForTimeout(3000);
}
await browser.close();

const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
const from = lines.findIndex((s) => /共 1 个文件|（1\/1）/.test(s));
console.log("\n──── 界面上的入库回执 ────");
for (const s of lines.slice(Math.max(0, from === -1 ? lines.length - 12 : from)).slice(0, 14)) console.log("  " + s);

const ok = [
  [/【完成】1 个文件/, "报出文件数"],
  [/(入库 \d+ 行|0 行（未产出可校验记录）)/, "报出该文件自己的行数"],
  [/未产出可校验记录：云枢智控-产品介绍\.pptx|入库 [1-9]\d* 行/, "0 行则点名、有行则报行数"],
];
console.log("\n──── 判定 ────");
let pass = true;
for (const [re, label] of ok) { const hit = re.test(text); if (!hit) pass = false; console.log(`  ${hit ? "✅" : "❌"} ${label}`); }
console.log(pass ? "\n✅ 端到端通过" : "\n❌ 端到端不通过");
process.exit(pass ? 0 : 1);
