// DEMO 第 5 段：场景 B（市政污水处理厂）—— 建场景 → 定义对话 → 资料入库 → 第 2 步
import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
import { shot, settle, waitText } from "./shot.mjs";

const NAME = "市政污水处理厂设备监控与能耗管理";
const MATERIAL = "推广/素材/demo资料/场景B-市政污水处理厂设备监控与能耗管理-客户资料.docx";

const { browser, page } = await openApp(chromium);
const body = () => page.locator(".shell").innerText();

async function curStep() {
  const c = page.locator(".flow-node--current").first();
  if (!(await c.count())) return null;
  const m = ((await c.getAttribute("aria-label")) ?? "").match(/第\s*(\d+)\s*步/);
  return m ? Number(m[1]) : null;
}

// 1. 新建场景 B
await page.locator(".side .nbtn").click();
await page.waitForTimeout(800);
await page.locator("input[placeholder*='智慧水务']").fill(NAME);
await shot(page, "期1-定位", "11-新建场景B");
await page.getByRole("button", { name: /创建并开始定义/ }).click();
console.log("⏳ 场景 B 已创建，等待澄清对话…");
await waitText(page, /发送/, { timeout: 300_000, label: "对话就绪" });
await page.waitForTimeout(22_000);
await shot(page, "期1-定位", "12-场景B-定义对话");
const t0 = await body();
console.log("===== 场景 B 澄清 =====");
const i0 = t0.indexOf("场景边界");
console.log(t0.slice(i0, i0 + 1600));

// 2. 回答
const box = page.locator('[role=dialog] textarea').last();
if (await box.count()) {
  await box.click();
  await box.fill(
    "范围是 2 座厂区加 6 座泵站的设备与能耗，不碰工艺控制回路；" +
      "重点是不更换既有 SCADA，先把泵站无人值守和分项计量做起来。",
  );
  await page.keyboard.press("Enter");
  console.log("⏳ 已回答…");
  await page.waitForTimeout(45_000);
}

// 3. 整理成定义
const toDef = page.getByRole("button", { name: /整理成定义/ });
if (await toDef.count()) {
  await toDef.first().click();
  console.log("⏳ 整理成定义…");
  await page.waitForTimeout(70_000);
}
await page.getByRole("button", { name: /关闭场景定义对话/ }).click().catch(() => {});
await settle(page, { quiet: 1500 });
await shot(page, "期1-定位", "13-场景B-第1步");
console.log("当前步:", await curStep());

// 4. 场景 B 私有资料
await page.getByRole("button", { name: "本场景资料" }).first().click();
await settle(page, { quiet: 1200 });
const openBtn = page.getByRole("button", { name: /上传本场景材料/ }).first();
if (await openBtn.count()) {
  await openBtn.click();
  await page.waitForTimeout(1200);
}
const inputs = await page.locator("input[type=file]").all();
console.log("场景 B 资料 file inputs =", inputs.length);
if (inputs.length) {
  await inputs[0].setInputFiles(MATERIAL);
  console.log("⏳ 投喂场景 B 资料…");
  await waitText(page, /入库结果|【完成】/, { timeout: 900_000, label: "场景B资料入库" });
  await page.waitForTimeout(1500);
  await shot(page, "期1-定位", "14-场景B-资料入库");
  const t = await body();
  const j = t.indexOf("入库结果");
  console.log(t.slice(j, j + 400));
}
await page.getByRole("button", { name: "关闭" }).first().click().catch(() => {});
await settle(page);

// 5. 第 2 步
const next = page.getByRole("button", { name: /^下一步$/ });
if (await next.count()) {
  await next.first().click();
  await page.waitForTimeout(2500);
}
const start = page.getByRole("button", { name: /开始本步分析/ });
if (await start.count()) {
  console.log("▶ 触发场景 B 第 2 步");
  await start.first().click();
}
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(10_000);
  const t = await body();
  if (/重算本步/.test(t) && !/分析中/.test(t)) {
    console.log(`✅ 场景 B 第 2 步完成（${(i + 1) * 10}s）`);
    break;
  }
  if (i % 3 === 0) console.log(`  ⏱ ${(i + 1) * 10}s…`);
}
await settle(page, { quiet: 2000 });
await shot(page, "期1-定位", "15-场景B-第2步");
console.log("===== 场景 B 第 2 步 =====");
console.log((await body()).slice(0, 2000));
await browser.close();
