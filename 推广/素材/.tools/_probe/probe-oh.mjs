import { chromium } from "@playwright/test";
import { openApp } from "../port.mjs";
import { settle } from "../shot.mjs";
const { browser, page } = await openApp(chromium);
await page.getByRole("button", { name: /产品资料库/ }).first().click();
await settle(page, { quiet: 1500 });
const b = page.getByRole("button", { name: "M2 规格书" }).first();
await b.click();
await settle(page, { quiet: 1500 });

console.log("=== 输入框 / 搜索 ===");
for (const el of await page.locator("input, select").all()) {
  const ph = await el.getAttribute("placeholder"); const al = await el.getAttribute("aria-label");
  const t = await el.getAttribute("type");
  if (ph || al) console.log(`  input type=${t} placeholder=${ph} aria=${al}`);
}
console.log("=== 表头 ===");
for (const th of await page.locator("th").all()) console.log("  ", (await th.innerText()).trim());
console.log("=== 前 12 行首格 ===");
const rows = await page.locator("tbody tr").all();
console.log("  总行数:", rows.length);
for (let i = 0; i < Math.min(12, rows.length); i++) {
  const t = (await rows[i].innerText()).replace(/\s+/g, " ").slice(0, 110);
  console.log(`  ${i}: ${t}`);
}
// 找操作系统行
let found = -1;
for (let i = 0; i < rows.length; i++) {
  const t = await rows[i].innerText();
  if (t.includes("操作系统") || t.includes("OpenHarmony")) { found = i; console.log("  ★ 命中行", i, ":", t.replace(/\s+/g," ").slice(0,150)); }
}
console.log("=== 与 M2 相关的按钮 ===");
for (const btn of await page.locator("button").all()) {
  const t = (await btn.innerText().catch(()=> "")).replace(/\s+/g," ").trim();
  if (t && t.length < 22) console.log("  -", t);
}
await browser.close();
