// 清理：删掉探针产品线与探针场景（同时摸清删除入口）
import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
import { settle } from "./shot.mjs";

const { browser, page } = await openApp(chromium);

// 1. 删探针产品线
await page.getByRole("button", { name: /产品资料库/ }).first().click();
await settle(page);
const line = page.locator(".side, .main").getByText("（探针）临时线").first();
if (await line.count()) {
  await line.click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "删除资料库" }).click();
  await page.waitForTimeout(600);
  console.log("===== 删除确认弹层 =====");
  console.log((await page.locator("body").innerText()).slice(-500));
  const confirm = page.getByRole("button", { name: /^(删除|确定|确认)/ });
  if (await confirm.count()) await confirm.last().click();
  await settle(page);
  console.log("✅ 探针产品线已删");
}

// 2. 删探针场景
const sc = page.locator(".side").getByText("汽车零部件压铸车间设备联网与OEE提升").first();
if (await sc.count()) {
  const row = page.locator(".side").locator("div").filter({ hasText: "汽车零部件压铸车间设备联网与OEE提升" }).last();
  const dots = row.locator("button").filter({ hasText: "⋯" });
  const n = await dots.count();
  if (n) {
    await dots.last().click();
    await page.waitForTimeout(600);
    console.log("===== 场景菜单 =====");
    console.log((await page.locator("body").innerText()).slice(-400));
  } else {
    console.log("未找到场景 ⋯ 菜单，改用 hover");
  }
}
await browser.close();
