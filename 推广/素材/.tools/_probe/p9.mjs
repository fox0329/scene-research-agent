import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
import { settle } from "./shot.mjs";
const { browser, page } = await openApp(chromium);
await page.getByRole("button", { name: /产品资料库/ }).first().click();
await settle(page);
console.log("select 数量 =", await page.locator("select").count());
for (const s of await page.locator("select").all()) {
  console.log("outerHTML:", (await s.evaluate(e => e.outerHTML)).slice(0, 400));
}
console.log("\n=== 场景行 DOM ===");
const sideHtml = await page.locator(".side").evaluate(e => e.innerHTML);
console.log(sideHtml.slice(0, 2500));
await browser.close();
