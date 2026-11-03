// DEMO 第 2 段（续）：本场景资料入库 → 场景定义对话 → 整理成定义
import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
import { shot, settle, waitText } from "./shot.mjs";

const MATERIAL = "推广/素材/demo资料/场景A-汽车零部件压铸车间设备联网与OEE提升-客户资料.docx";
const { browser, page } = await openApp(chromium);
const body = () => page.locator(".shell").innerText();

// a. 本场景资料入库
await page.getByRole("button", { name: "本场景资料" }).first().click();
await settle(page, { quiet: 1200 });
await shot(page, "期2-实战", "05-本场景资料入口");
const inputs = await page.locator("input[type=file]").all();
console.log("本场景资料 file inputs =", inputs.length);
if (inputs.length) {
  await inputs[0].setInputFiles(MATERIAL);
  console.log("⏳ 已投喂场景资料…");
  await waitText(page, /入库结果|【完成】|行资料/, { timeout: 600_000, label: "场景资料入库" });
  await page.waitForTimeout(1500);
}
await shot(page, "期2-实战", "06-本场景资料入库");
const t1 = await body();
console.log("===== 本场景资料 =====");
console.log(t1.slice(0, 900));
await page.getByRole("button", { name: "关闭" }).first().click().catch(() => {});
await settle(page);

// b. 打开场景定义对话
await page.getByRole("button", { name: /开始本步分析|重新打开场景定义对话/ }).first().click();
await page.waitForTimeout(2500);
console.log("dialog 数量 =", await page.locator("[role=dialog]").count());
await shot(page, "期2-实战", "07-场景定义对话");
await shot(page, "期1-定位", "09-场景定义对话");

// c. 回答两个取舍
const box = page.locator('[role=dialog] textarea').last();
await box.click();
await box.fill(
  "范围只聚焦压铸机本体，加上去毛刺与检测这两段关键辅机，熔炼保温炉先不纳入；" +
    "重点是存量设备联网改造，12 台老机优先，新建产线随线配套作为补充。",
);
await page.keyboard.press("Enter");
console.log("⏳ 已回答，等待智能体回应…");
await page.waitForTimeout(50_000);
await shot(page, "期2-实战", "08-澄清问答");
const t2 = await body();
const i = Math.max(t2.indexOf("我想梳理这个场景"), 0);
console.log("===== 对话 =====");
console.log(t2.slice(i, i + 2200));

// d. 整理成定义
const toDef = page.getByRole("button", { name: /整理成定义/ });
if (await toDef.count()) {
  await toDef.first().click();
  console.log("⏳ 已点「整理成定义」…");
  await page.waitForTimeout(70_000);
  await shot(page, "期2-实战", "09-整理成定义");
  await shot(page, "期1-定位", "10-整理成定义");
}
// e. 关闭弹窗看表1-1
await page.getByRole("button", { name: /关闭场景定义对话/ }).click().catch(() => {});
await settle(page, { quiet: 1500 });
await shot(page, "期2-实战", "10-第1步-场景概述表");
const t3 = await body();
console.log("===== 第 1 步产物 =====");
console.log(t3.slice(0, 2200));
await browser.close();
