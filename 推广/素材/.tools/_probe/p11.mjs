import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
const { browser, page } = await openApp(chromium);
await page.waitForTimeout(2500);
console.log("=== .shell 直接子元素 ===");
console.log(await page.locator(".shell").evaluate(e =>
  [...e.children].map(c => `${c.tagName}.${c.className}`).join("\n")));
console.log("\n=== 全部 button（含 aria-label） ===");
for (const b of await page.locator("button").all()) {
  const t = (await b.innerText().catch(()=> "")).replace(/\s+/g," ").trim();
  const al = await b.getAttribute("aria-label");
  const cl = await b.getAttribute("class");
  console.log(`${JSON.stringify(t).padEnd(22)} | aria=${al ?? "-"} | ${cl}`);
}
await browser.close();
