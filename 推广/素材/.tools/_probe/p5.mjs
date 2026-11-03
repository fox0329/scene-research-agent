import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
const { browser, page } = await openApp(chromium);
console.log("=== .side 按钮 ===");
for (const b of await page.locator(".side button").all()) {
  const t = (await b.innerText().catch(()=> "")).replace(/\s+/g," ").trim();
  const cls = await b.getAttribute("class");
  console.log(JSON.stringify(t), "|", cls);
}
console.log("=== 全部含“新建”的元素 ===");
for (const b of await page.getByText("新建", { exact: true }).all()) {
  console.log(await b.evaluate(e => e.outerHTML.slice(0,200)));
}
await browser.close();
