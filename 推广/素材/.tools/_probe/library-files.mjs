/** 点开「已导入资料」，把文件列表整段打印出来（这就是截图 02 里那块内容）。 */
import { chromium } from "@playwright/test";
import { openApp } from "../port.mjs";

const { browser, page } = await openApp(chromium, { base: "http://127.0.0.1:46172/" });
await page.getByRole("button", { name: /产品资料库/ }).first().click();
await page.waitForTimeout(2500);
const btn = page.getByRole("button", { name: "已导入资料" }).first();
if (await btn.count()) { await btn.click(); await page.waitForTimeout(1500); }
const txt = await page.locator(".shell").innerText();
const i = txt.indexOf("已导入资料");
console.log(txt.slice(i, i + 700));
console.log("\n──── 表格行 ────");
for (const tr of await page.locator("table tr").all()) {
  const t = (await tr.innerText()).replace(/\s+/g, " ").trim();
  if (t && !/^维度|^#/.test(t)) console.log("  " + t);
}
await browser.close();
