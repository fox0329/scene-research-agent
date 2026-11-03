// 探针 4：创建产品线 + 新建场景后的对话定义界面
import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";

const { browser, page } = await openApp(chromium);
const dump = async (label, sel = "body") => {
  console.log(`\n===== ${label} =====`);
  console.log((await page.locator(sel).innerText()).slice(0, 3500));
};

// 1. 建产品线
await page.getByRole("button", { name: /产品资料库/ }).first().click();
await page.waitForTimeout(600);
if (await page.getByRole("button", { name: "新建产品线" }).count()) {
  await page.getByRole("button", { name: "新建产品线" }).first().click();
  await page.waitForTimeout(500);
  await page.locator("input[placeholder*='产品线']").fill("云枢智控·工业边缘产品线");
  await page.getByRole("button", { name: "创建" }).click();
  await page.waitForTimeout(1200);
  console.log("✅ 产品线已创建");
}
await dump("产品资料库（已建线）", ".shell");

// 2. 新建场景
await page.getByRole("button", { name: /^新建$/ }).first().click();
await page.waitForTimeout(600);
await page.locator("input[placeholder*='智慧水务']").fill("汽车零部件压铸车间设备联网与OEE提升");
await page.getByRole("button", { name: /创建并开始定义/ }).click();
await page.waitForTimeout(20000);
await dump("场景创建后", ".shell");
await page.screenshot({ path: "推广/素材/截图/_probe4-场景定义对话.png" });

console.log("\n===== 输入控件 =====");
for (const el of await page.locator("input, textarea").all()) {
  console.log(`[${await el.getAttribute("type") ?? "-"}] ph=${await el.getAttribute("placeholder") ?? "-"}`);
}
console.log("input[type=file] 数量 =", await page.locator("input[type=file]").count());
await browser.close();
