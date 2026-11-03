// 探针：看一眼当前应用界面结构（左栏/中栏/右栏文本），为后续自动化与截图定位做准备
import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";

const { browser, page, port } = await openApp(chromium);
console.log(`端口：${port}`);

await page.waitForTimeout(1200);
await page.screenshot({ path: "推广/素材/截图/_probe-初始界面.png", fullPage: false });

const dump = async (sel, label) => {
  const n = await page.locator(sel).count();
  console.log(`\n===== ${label} (${sel}) count=${n} =====`);
  if (n) console.log((await page.locator(sel).first().innerText()).slice(0, 2500));
};
await dump(".side", "左栏");
await dump(".main, .content, main", "主区");
await dump(".right, .detail", "右栏");

console.log("\n===== 按钮清单 =====");
const btns = await page.locator("button").all();
for (const [i, b] of btns.entries()) {
  const t = (await b.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (t) console.log(`${i}\t${t}`);
}

await browser.close();
