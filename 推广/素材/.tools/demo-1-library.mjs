// DEMO 第 1 段：产品资料库 —— 建产品线 → 上传三份资料 → 入库 → 质量总评
import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
import { shot, settle, waitText } from "./shot.mjs";

const DIR = "推广/素材/demo资料";
const LINE = "云枢智控·工业边缘产品线";
const FILES = [
  `${DIR}/云枢智控-产品与能力白皮书.docx`,
  `${DIR}/云枢智控-产品规格参数表.xlsx`,
  `${DIR}/云枢智控-产品介绍.pptx`,
];

const { browser, page } = await openApp(chromium);
const body = () => page.locator(".shell").innerText();

await page.getByRole("button", { name: /产品资料库/ }).first().click();
await settle(page);

// 建产品线
await page.getByRole("button", { name: "新建产品线" }).first().click();
await page.waitForTimeout(500);
await shot(page, "期1-定位", "01-新建产品线");
await page.locator("input[placeholder*='产品线']").fill(LINE);
await page.getByRole("button", { name: "创建" }).click();
await settle(page);
console.log("✅ 产品线:", LINE);

// 上传三份资料（四种格式覆盖面：docx / xlsx / pptx）
const input = page.locator("input[type=file]").first();
await input.setInputFiles(FILES);
console.log("⏳ 已投喂 3 个文件，等待解析 + 模型提取…");
await page.waitForTimeout(8000);
await shot(page, "期2-实战", "01-上传解析中");
await shot(page, "期4-可信", "01-上传解析中");

await waitText(page, /入库结果|【完成】/, { timeout: 900_000, label: "入库结果" });
await page.waitForTimeout(1500);
console.log("===== 入库结果 =====");
const t = await body();
console.log(t.slice(t.indexOf("入库结果"), t.indexOf("入库结果") + 700));
await shot(page, "期2-实战", "02-入库结果");
await shot(page, "期4-可信", "02-入库结果");
await page.getByRole("button", { name: "关闭" }).first().click().catch(() => {});
await settle(page);

// 各表留痕
for (const [code, file] of [
  ["M1 产品清单", "03-产品资料库-M1产品清单"],
  ["M2 规格书", "04-产品资料库-M2规格书"],
  ["M3 能力清单", "05-产品资料库-M3能力清单"],
  ["M4 边界声明", "06-产品资料库-M4边界声明"],
  ["M5 已知限制", "07-产品资料库-M5已知限制"],
  ["O 可选材料", "08-产品资料库-可选材料"],
]) {
  const btn = page.getByRole("button", { name: code }).first();
  if (await btn.count()) {
    await btn.click();
    await settle(page, { quiet: 1200 });
    const txt = await body();
    console.log(`   ${code}: ${txt.includes("暂无") || txt.includes("无数据") ? "（空）" : "有数据"}`);
    await shot(page, "期1-定位", file);
  } else {
    console.log(`   ${code}: 未找到标签`);
  }
}

// 质量总评 + 完成度
await page.getByRole("button", { name: "质量总评" }).first().click();
await settle(page, { quiet: 1500 });
const q = await body();
console.log("\n===== 质量总评 =====");
const qi = q.indexOf("质量总评");
console.log(q.slice(qi, qi + 1400));
await shot(page, "期4-可信", "03-质量总评与完成度");

await page.screenshot({ path: "推广/素材/截图/期2-实战/00-产品资料库全貌.png", fullPage: false });
console.log("✅ 第 1 段完成");
await browser.close();
