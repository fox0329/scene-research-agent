import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
import { settle } from "./shot.mjs";
const { browser, page } = await openApp(chromium);
await page.waitForTimeout(2500);
console.log("modal-backdrop 数量 =", await page.locator(".modal-backdrop").count());
console.log("textarea 数量 =", await page.locator("textarea").count());
console.log("=== 底部输入栏区域 DOM ===");
const html = await page.locator(".shell").evaluate(e => e.innerHTML);
const i = html.indexOf("textarea");
console.log(html.slice(Math.max(0, i - 700), i + 600));
console.log("\n=== 含“关闭”的按钮 ===");
for (const b of await page.getByRole("button", { name: "关闭" }).all()) {
  console.log(await b.evaluate(e => e.outerHTML.slice(0, 220)));
}
await page.keyboard.press("Escape");
await page.waitForTimeout(1200);
console.log("\nEsc 后 modal-backdrop 数量 =", await page.locator(".modal-backdrop").count());
console.log("Esc 后 textarea 数量 =", await page.locator("textarea").count());
await browser.close();
