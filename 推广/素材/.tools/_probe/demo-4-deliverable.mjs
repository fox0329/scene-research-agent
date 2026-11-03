// DEMO 第 4 段：第 7 步交付物 —— 组装 + 预览 + 导出 Word
import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
import { shot, settle } from "./shot.mjs";

const { browser, page } = await openApp(chromium);
const body = () => page.locator(".shell").innerText();

async function currentStep() {
  const cur = page.locator(".flow-node--current").first();
  if (!(await cur.count())) return null;
  const m = ((await cur.getAttribute("aria-label")) ?? "").match(/第\s*(\d+)\s*步/);
  return m ? Number(m[1]) : null;
}

console.log("当前步:", await currentStep());

// 进第 7 步
if ((await currentStep()) !== 7) {
  const next = page.getByRole("button", { name: /^下一步$/ });
  if (await next.count()) {
    await next.first().click();
    await page.waitForTimeout(2500);
  }
}
console.log("进入第 7 步，当前:", await currentStep());
console.log("===== 第 7 步入场 =====");
console.log((await body()).slice(0, 1400));
await shot(page, "期2-实战", "17-第7步-入场");

// 触发组装
const start = page.getByRole("button", { name: /开始本步分析|生成交付物|组装交付物|生成文档/ });
if (await start.count()) {
  console.log("▶ 触发交付物组装");
  await start.first().click();
} else {
  console.log("未找到组装按钮，按钮清单：");
  for (const b of await page.locator("button").all()) {
    const t = (await b.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (t && t.length < 20) console.log("  -", t);
  }
}

// 等交付物出来
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(10_000);
  const t = await body();
  if (/导出|下载|解决方案|建设工作方案/.test(t) && !/组装中|生成中/.test(t)) {
    console.log(`✅ 第 ${i + 1} 轮看到交付物`);
    break;
  }
  if (i % 3 === 0) console.log(`  ⏱ ${(i + 1) * 10}s…`);
}
await settle(page, { quiet: 2500 });
await shot(page, "期2-实战", "18-第7步-交付物");
await shot(page, "期5-上手", "01-交付物");
console.log("===== 交付物页 =====");
console.log((await body()).slice(0, 2600));

// 导出 Word
console.log("\n===== 全部按钮 =====");
for (const b of await page.locator("button").all()) {
  const t = (await b.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (t && t.length < 24) console.log("  -", t);
}
console.log("\n===== 链接/菜单 =====");
for (const a of await page.locator("a").all()) {
  console.log("  a:", (await a.innerText().catch(() => "")).trim().slice(0, 40), "|", await a.getAttribute("href"));
}

const exp = page.getByRole("button", { name: /导出/ });
if (await exp.count()) {
  await exp.first().click();
  await page.waitForTimeout(1500);
  await shot(page, "期5-上手", "02-导出菜单");
  console.log("===== 导出菜单 =====");
  console.log((await page.locator("body").innerText()).slice(-600));
}
await browser.close();
