import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
import { shot, settle } from "./shot.mjs";
const { browser, page } = await openApp(chromium);
const body = () => page.locator(".shell").innerText();
const row = page.locator(".side .proj").filter({ hasText: "市政污水处理厂" }).first();
await row.locator(".proj-hd").click();
await settle(page, { quiet: 1500 });
const redo = page.getByRole("button", { name: /重算本步/ });
if (await redo.count()) {
  console.log("▶ 重算场景 B 第 2 步");
  await redo.first().click();
  await page.waitForTimeout(4000);
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(10_000);
    const t = await body();
    if (!/分析中|生成中/.test(t) && /下一步/.test(t)) {
      console.log(`✅ 完成（${(i + 1) * 10}s）`);
      break;
    }
    if (i % 3 === 0) console.log(`  ⏱ ${(i + 1) * 10}s…`);
  }
}
await settle(page, { quiet: 2000 });
const t = await body();
console.log(t.slice(t.indexOf("门槛与合规"), t.indexOf("门槛与合规") + 700));
await shot(page, "期1-定位", "15-场景B-第2步");
await browser.close();
