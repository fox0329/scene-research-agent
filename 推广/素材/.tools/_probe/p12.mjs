import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
const { browser, page } = await openApp(chromium);
await page.waitForTimeout(2500);
console.log("=== .main 子元素树（两层） ===");
console.log(await page.locator(".main").evaluate(e =>
  [...e.children].map(c => `${c.tagName}.${c.className}\n` + [...c.children].map(d=>`   ${d.tagName}.${d.className}`).join("\n")).join("\n")));
console.log("\n=== .main 末尾 1500 字符 DOM ===");
const h = await page.locator(".main").evaluate(e => e.innerHTML);
console.log(h.slice(-1600));
await browser.close();
