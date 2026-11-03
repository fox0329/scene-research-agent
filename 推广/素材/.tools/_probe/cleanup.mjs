import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
import { settle } from "./shot.mjs";
const { browser, page } = await openApp(chromium);

await page.getByRole("button", { name: /产品资料库/ }).first().click();
await settle(page);
const sel = page.locator('select[aria-label="选择产品线"]');
if (await sel.count()) {
  const opts = await sel.locator("option").allTextContents();
  const target = opts.find((t) => t.includes("探针"));
  if (target) {
    await sel.selectOption({ label: target });
    await settle(page);
    await page.getByRole("button", { name: "删除资料库" }).click();
    await page.waitForTimeout(600);
    console.log("=== 删除确认 ===");
    console.log((await page.locator("body").innerText()).slice(-300));
    const btn = page.getByRole("button", { name: /^(删除|确定|确认|是)/ }).last();
    if (await btn.count()) await btn.click();
    await settle(page);
    console.log("✅ 已删产品线:", target);
  } else console.log("没有探针产品线，跳过");
}

// 删场景
const proj = page.locator(".side .proj").filter({ hasText: "汽车零部件压铸车间" }).first();
if (await proj.count()) {
  await proj.locator(".more-btn").first().click();
  await page.waitForTimeout(600);
  console.log("=== 场景菜单 ===");
  console.log((await page.locator("body").innerText()).slice(-300));
  const del = page.getByRole("menuitem", { name: /删除/ });
  const delBtn = (await del.count()) ? del : page.getByRole("button", { name: /删除/ });
  if (await delBtn.count()) {
    await delBtn.last().click();
    await page.waitForTimeout(600);
    const c = page.getByRole("button", { name: /^(删除|确定|确认|是)/ }).last();
    if (await c.count()) await c.click();
    await settle(page);
    console.log("✅ 场景已删");
  }
}
await browser.close();
