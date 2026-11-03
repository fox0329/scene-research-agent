// 探针 7：摸清「上传 → 提取 → 入库」机制（用临时资料，跑完删线）
import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
import { shot, settle, waitText } from "./shot.mjs";

const { browser, page } = await openApp(chromium);
const dump = async (label, n = 3000) => {
  console.log(`\n===== ${label} =====`);
  console.log((await page.locator(".shell").innerText()).slice(0, n));
};

await page.getByRole("button", { name: /产品资料库/ }).first().click();
await settle(page);

// 建一条探针线
await page.getByRole("button", { name: "新建产品线" }).first().click();
await page.waitForTimeout(500);
await page.locator("input[placeholder*='产品线']").fill("（探针）临时线");
await page.getByRole("button", { name: "创建" }).click();
await settle(page);
console.log("✅ 探针产品线已建");

// 上传
const files = await page.locator("input[type=file]").all();
console.log("file inputs =", files.length);
await files[0].setInputFiles("推广/素材/demo资料/_探针临时资料.docx");
console.log("已投投喂文件，等待提取…");

await page.waitForTimeout(15000);
await dump("上传后 15s");
await shot(page, "共用", "_probe7-上传后");

// 轮询到出现可确认/入库的界面
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(10000);
  const body = await page.locator(".shell").innerText();
  const done = /待确认|确认入库|已导入|提取完成|新增 \d+ 行|行资料/.test(body);
  console.log(`轮询 ${i + 1}: 长度=${body.length} 命中=${done}`);
  if (done && i >= 1) break;
}
await dump("提取结果");
await shot(page, "共用", "_probe7-提取结果");

console.log("\n===== 按钮 =====");
for (const b of await page.locator("button").all()) {
  const t = (await b.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (t && t.length < 26) console.log(`- ${t}`);
}
await browser.close();
