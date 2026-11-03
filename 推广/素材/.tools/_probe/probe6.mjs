// 探针 6：新建场景 → 对话定义界面
import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";

const { browser, page } = await openApp(chromium);
const dump = async (label, sel = ".shell", n = 3500) => {
  console.log(`\n===== ${label} =====`);
  console.log((await page.locator(sel).innerText()).slice(0, n));
};

await page.locator(".side .nbtn").click();
await page.waitForTimeout(800);
await dump("新建弹层");
const nameInput = page.locator("input[placeholder*='智慧水务']");
if (await nameInput.count()) {
  await nameInput.fill("汽车零部件压铸车间设备联网与OEE提升");
}
await page.getByRole("button", { name: /创建并开始定义/ }).click();
console.log("已提交创建，等待澄清对话…");
for (const t of [8000, 15000, 20000, 30000]) {
  await page.waitForTimeout(t);
  const body = await page.locator(".shell").innerText();
  if (/场景定义|澄清|请确认|上传/.test(body)) break;
}
await dump("场景创建后");
await page.screenshot({ path: "推广/素材/截图/_probe6-场景定义.png" });
console.log("\n===== 输入控件 =====");
for (const el of await page.locator("input, textarea").all()) {
  console.log(`[${await el.getAttribute("type") ?? "-"}] ph=${await el.getAttribute("placeholder") ?? "-"}`);
}
console.log("file inputs =", await page.locator("input[type=file]").count());
console.log("\n===== 按钮 =====");
for (const b of await page.locator("button").all()) {
  const t = (await b.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (t && t.length < 24) console.log(`- ${t}`);
}
await browser.close();
