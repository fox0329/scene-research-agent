// DEMO 第 2 段：场景 A —— 新建 → 上传本场景资料 → 澄清对话 → 整理成定义
import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
import { shot, settle, waitText } from "./shot.mjs";

const SCENARIO = "汽车零部件压铸车间设备联网与OEE提升";
const MATERIAL = "推广/素材/demo资料/场景A-汽车零部件压铸车间设备联网与OEE提升-客户资料.docx";

const { browser, page } = await openApp(chromium);
const body = () => page.locator(".shell").innerText();

// 1. 新建场景
await page.locator(".side .nbtn").click();
await page.waitForTimeout(700);
await page.locator("input[placeholder*='智慧水务']").fill(SCENARIO);
await shot(page, "期2-实战", "03-新建场景");
await page.getByRole("button", { name: /创建并开始定义/ }).click();
console.log("⏳ 场景已创建，等待澄清对话…");
await waitText(page, /发送/, { timeout: 300_000, label: "对话就绪" });
await page.waitForTimeout(20_000);
await shot(page, "期2-实战", "04-场景澄清对话");
await shot(page, "期1-定位", "09-场景澄清对话");
console.log("===== 澄清对话 =====");
const t1 = await body();
console.log(t1.slice(t1.indexOf("场景定义"), t1.indexOf("场景定义") + 1800));

// 2. 上传本场景资料
await page.getByRole("button", { name: "本场景资料" }).first().click();
await settle(page, { quiet: 1200 });
const inputs = await page.locator("input[type=file]").all();
console.log("本场景资料页 file inputs =", inputs.length);
if (inputs.length) {
  await inputs[0].setInputFiles(MATERIAL);
  console.log("⏳ 已投喂场景资料…");
  await page.waitForTimeout(10_000);
}
await shot(page, "期2-实战", "05-本场景资料入库");
console.log("===== 本场景资料 =====");
const t2 = await body();
console.log(t2.slice(0, 1200));

// 3. 回答澄清问题
const box = page.locator("textarea").last();
await box.click();
await box.fill(
  "范围只聚焦压铸机本体，加上去毛刺与检测这两段关键辅机，熔炼保温炉先不纳入；" +
    "重点是存量设备联网改造，12 台老机优先，新建产线随线配套作为补充。",
);
await page.keyboard.press("Enter");
console.log("⏳ 已回答澄清问题，等待智能体回应…");
await page.waitForTimeout(45_000);
await shot(page, "期2-实战", "06-澄清问答");
console.log("===== 回答后 =====");
const t3 = await body();
console.log(t3.slice(t3.indexOf("场景定义"), t3.indexOf("场景定义") + 2200));

// 4. 整理成定义
const toDef = page.getByRole("button", { name: /整理成定义/ });
if (await toDef.count()) {
  await toDef.first().click();
  console.log("⏳ 已点「整理成定义」，等待回填…");
  await page.waitForTimeout(60_000);
  await shot(page, "期2-实战", "07-整理成定义");
  await shot(page, "期1-定位", "10-整理成定义");
  const t4 = await body();
  console.log("===== 整理成定义后 =====");
  console.log(t4.slice(0, 2600));
} else {
  console.log("未找到「整理成定义」按钮");
}
await browser.close();
