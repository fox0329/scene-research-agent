// DEMO 第 2 段（补）：把场景 A 客户资料上传到「本场景资料」私有库
import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
import { shot, settle, waitText } from "./shot.mjs";

const MATERIAL = "推广/素材/demo资料/场景A-汽车零部件压铸车间设备联网与OEE提升-客户资料.docx";
const { browser, page } = await openApp(chromium);
const body = () => page.locator(".shell").innerText();

await page.getByRole("button", { name: "本场景资料" }).first().click();
await settle(page, { quiet: 1500 });

// 打开上传入口
const openBtn = page.getByRole("button", { name: /上传本场景材料|上传材料/ }).first();
if (await openBtn.count()) {
  await openBtn.click();
  await page.waitForTimeout(1500);
}
console.log("file inputs =", await page.locator("input[type=file]").count());
await shot(page, "期2-实战", "05-本场景资料入口");

const input = page.locator("input[type=file]").first();
await input.setInputFiles(MATERIAL);
console.log("⏳ 已投喂场景资料，等待入库…");
await waitText(page, /入库结果|【完成】|行资料/, { timeout: 900_000, label: "场景资料入库" });
await page.waitForTimeout(2000);
await shot(page, "期2-实战", "06-本场景资料入库");
await shot(page, "期4-可信", "04-场景资料入库");
const t = await body();
console.log("===== 入库后 =====");
console.log(t.slice(0, 1600));
await browser.close();
