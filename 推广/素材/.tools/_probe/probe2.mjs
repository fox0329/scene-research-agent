// 探针 2：空库状态下的界面结构 —— 产品资料库与新建场景入口
import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";

const { browser, page } = await openApp(chromium);

const dump = async (label) => {
  console.log(`\n===== ${label} =====`);
  const txt = await page.locator(".shell").innerText();
  console.log(txt.slice(0, 3000));
};

await dump("初始（空库）首页");

// 进产品资料库
await page.getByRole("button", { name: /产品资料库/ }).first().click();
await page.waitForTimeout(1200);
await dump("产品资料库");
await page.screenshot({ path: "推广/素材/截图/_probe2-产品资料库空态.png" });

// 回首页，点新建
await page.keyboard.press("Escape").catch(() => {});
const create = page.getByRole("button", { name: /^新建/ }).first();
await create.click();
await page.waitForTimeout(1000);
await dump("新建场景");
await page.screenshot({ path: "推广/素材/截图/_probe2-新建场景.png" });

// 列出所有输入控件
console.log("\n===== 输入控件 =====");
for (const el of await page.locator("input, textarea, select").all()) {
  const ph = await el.getAttribute("placeholder");
  const name = await el.getAttribute("name");
  const type = await el.getAttribute("type");
  console.log(`[${type ?? "-"}] name=${name ?? "-"} placeholder=${ph ?? "-"}`);
}
console.log("\n===== 文件输入 =====");
console.log("input[type=file] 数量 =", await page.locator("input[type=file]").count());

await browser.close();
