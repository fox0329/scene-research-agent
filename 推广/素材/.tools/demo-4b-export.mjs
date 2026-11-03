// DEMO 第 4 段（续）：生成报告 → 预览两份交付物 → 导出 Word
import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
import { shot, settle } from "./shot.mjs";

const { browser, page } = await openApp(chromium);
const body = () => page.locator(".shell").innerText();

await settle(page, { quiet: 1500 });
console.log("===== 入场 =====");
console.log((await body()).slice(0, 1500));
await shot(page, "期2-实战", "17-第7步-入场");
await shot(page, "期5-上手", "01-第7步交付物");

// 生成报告
const gen = page.getByRole("button", { name: "生成报告" });
if (await gen.count()) {
  console.log("▶ 点击「生成报告」");
  await gen.first().click();
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(10_000);
    const t = await body();
    const word = page.getByRole("button", { name: "导出Word文档" });
    const enabled = (await word.count()) && (await word.first().isEnabled());
    if (enabled) {
      console.log(`✅ 报告已生成（${(i + 1) * 10}s）`);
      break;
    }
    if (i % 3 === 0) console.log(`  ⏱ ${(i + 1) * 10}s…`);
  }
} else {
  console.log("未找到「生成报告」按钮");
}

await settle(page, { quiet: 2500 });
await shot(page, "期2-实战", "18-第7步-交付物");
await shot(page, "期5-上手", "02-交付物预览");
console.log("===== 交付物页 =====");
const t = await body();
console.log(t.slice(0, 3000));
console.log("\n=== 交付物页含两份文档标题？===", /解决方案/.test(t), /建设工作方案/.test(t));
console.log("=== 篇幅相关信息 ===");
for (const m of t.matchAll(/[^\n]*字数[^\n]*/g)) console.log("  ", m[0]);
for (const m of t.matchAll(/[^\n]*(\d{3,5})\s*字[^\n]*/g)) console.log("  ", m[0].slice(0, 120));

// 切两份文档各截一张
for (const [name, file] of [
  ["解决方案", "03-交付物-解决方案"],
  ["建设工作方案", "04-交付物-建设工作方案"],
]) {
  const b = page.getByRole("button", { name, exact: true }).first();
  if (await b.count()) {
    await b.click();
    await settle(page, { quiet: 1500 });
    await shot(page, "期5-上手", file);
    const txt = await body();
    console.log(`\n--- ${name} 页面前 500 字 ---`);
    console.log(txt.slice(0, 500));
  }
}

// 导出 Word
const exp = page.getByRole("button", { name: "导出Word文档" });
if ((await exp.count()) && (await exp.first().isEnabled())) {
  const dl = page.waitForEvent("download", { timeout: 120_000 }).catch(() => null);
  await exp.first().click();
  await page.waitForTimeout(1200);
  await shot(page, "期5-上手", "05-导出菜单");
  console.log("\n===== 导出后提示 =====");
  console.log((await body()).slice(-800));
  const d = await dl;
  if (d) {
    const p = "推广/素材/demo数据/" + d.suggestedFilename();
    await d.saveAs(p);
    console.log("✅ 已保存下载:", p);
  } else console.log("（未捕获到浏览器下载事件，可能走的是服务端落盘）");
} else {
  console.log("导出按钮仍不可用");
}
console.log("\n=== 剩余按钮 ===");
for (const b of await page.locator("button").all()) {
  const x = (await b.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (x && x.length < 24) console.log("  -", x);
}
await browser.close();
