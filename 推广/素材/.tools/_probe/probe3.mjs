// 探针 3：产品线创建与上传入口
import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";

const { browser, page } = await openApp(chromium);

await page.getByRole("button", { name: /产品资料库/ }).first().click();
await page.waitForTimeout(800);
await page.getByRole("button", { name: "新建产品线" }).first().click();
await page.waitForTimeout(800);

console.log("===== 新建产品线弹层 =====");
console.log((await page.locator("body").innerText()).slice(-1200));
console.log("\n===== 弹层内控件 =====");
for (const el of await page.locator("input, textarea").all()) {
  console.log(`[${await el.getAttribute("type") ?? "-"}] ph=${await el.getAttribute("placeholder") ?? "-"}`);
}
await page.screenshot({ path: "推广/素材/截图/_probe3-新建产品线.png" });

// 填一个名字试探
const input = page.locator("input[type=text], input:not([type])").last();
await input.fill("边缘控制器与工业网关");
await page.waitForTimeout(300);
const btns = await page.locator("button").all();
console.log("\n===== 弹层按钮 =====");
for (const b of btns) {
  const t = (await b.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (t && t.length < 20) console.log(`- ${t}`);
}
await browser.close();
