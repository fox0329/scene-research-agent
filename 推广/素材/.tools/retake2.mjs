// 脱敏后补拍（第二轮）：把第一轮漏掉的「中栏」默认视图与交付物页重拍，覆盖旧图
import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
import { shot, settle } from "./shot.mjs";

const SCEN_A = "汽车零部件压铸车间设备联网与OEE提升";
const { browser, page } = await openApp(chromium);

const row = page.locator(".side .proj").filter({ hasText: SCEN_A }).first();
await row.locator(".proj-hd").click();
await settle(page, { quiet: 1500 });

async function gotoStep(n) {
  const node = page.locator(".flow-node").nth(n - 1);
  await node.click();
  await settle(page, { quiet: 1800 });
}

// 每一步的默认（第一张表）视图 —— 覆盖旧的「中栏」图
const DEFAULT_VIEWS = [
  [1, "10-第1步-场景概述表"],
  [1, "20-第1步-场景概述"],
  [2, "12-第2步-中栏"],
  [3, "13-第3步-中栏"],
  [4, "14-第4步-中栏"],
  [5, "15-第5步-中栏"],
  [6, "16-第6步-中栏"],
];

for (const [n, file] of DEFAULT_VIEWS) {
  await gotoStep(n);
  await shot(page, "期2-实战", file);
  console.log("📸", file);
}

// 第 7 步：交付物页 + 导出菜单
await gotoStep(7);
await settle(page, { quiet: 2000 });
await shot(page, "期2-实战", "17-第7步-入场");
await shot(page, "期2-实战", "18-第7步-交付物");
await shot(page, "期5-上手", "01-交付物");
await shot(page, "期5-上手", "01-第7步交付物");

const exp = page.getByRole("button", { name: "导出Word文档" });
if ((await exp.count()) && (await exp.first().isEnabled())) {
  await exp.first().click();
  await page.waitForTimeout(2500);
  await shot(page, "期5-上手", "05-导出菜单");
  const t = await page.locator("body").innerText();
  console.log("导出后界面片段：");
  console.log(t.slice(-500));
}
console.log("✅ 第二轮补拍完成");
await browser.close();
