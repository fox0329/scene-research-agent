// 把「云枢 OS（基于 OpenHarmony 5.0）」这条规格连同它的出处一起拍成可视化证据
import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
import { shot, settle } from "./shot.mjs";

const { browser, page } = await openApp(chromium);
await page.getByRole("button", { name: /产品资料库/ }).first().click();
await settle(page, { quiet: 1500 });
await page.getByRole("button", { name: "M2 规格书" }).first().click();
await settle(page, { quiet: 1500 });

const rows = await page.locator("tbody tr").all();
let target = null;
for (const r of rows) {
  if ((await r.innerText()).includes("OpenHarmony")) { target = r; break; }
}
if (!target) { console.log("❌ 没找到 OpenHarmony 行"); await browser.close(); process.exit(1); }

await target.scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
await target.click();                       // 选中 → 详情列应显示该行
await settle(page, { quiet: 1500 });

console.log("=== 该行 ===");
console.log((await target.innerText()).replace(/\s+/g, " "));
console.log("\n=== 详情列（右侧）===");
for (const sel of [".det", ".detail", "aside", ".main + *", ".det-col"]) {
  const el = page.locator(sel).first();
  if (await el.count()) {
    const t = (await el.innerText()).trim();
    if (t && t.length < 3000) { console.log(`[${sel}]`); console.log(t.slice(0, 900)); break; }
  }
}
await shot(page, "期1-定位", "04b-产品资料库-M2-操作系统-OpenHarmony");
await shot(page, "期5-上手", "06-资料库-规格与出处");
await shot(page, "期4-可信", "06-规格行与出处可查");
console.log("\n✅ 已截图");
await browser.close();
