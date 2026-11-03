// 触发并拍摄「资料更新 → 下游待重算」横幅。
// 做两次真实编辑：先改回原值（触发失效），再改回复核后的值（最终值只带一处标记）。
import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
import { shot, settle } from "./shot.mjs";

const NOTE = "（已与客户现场复核）";
const { browser, page } = await openApp(chromium);
const row = page.locator(".side .proj").filter({ hasText: "汽车零部件压铸车间" }).first();
await row.locator(".proj-hd").click();
await settle(page, { quiet: 1500 });

// 第 2 步 → 表2-2 场景要素清单（它是阶段 2 与 4 的上游）
await page.locator(".flow-node").nth(1).click();
await settle(page, { quiet: 1600 });
await page.locator(".chip").filter({ hasText: "场景要素清单" }).first().click();
await settle(page, { quiet: 1400 });

const cell = page.locator(".cell-input").first();
const kept = await cell.inputValue();                       // 复核后的值（带一处标记）
const clean = kept.replace(NOTE, "");                       // 原始值

await cell.click(); await cell.fill(clean); await page.keyboard.press("Tab");
console.log("⏳ 第 1 次编辑（改回原值），等待失效标记…");
await page.waitForTimeout(3500);
await cell.click(); await cell.fill(kept); await page.keyboard.press("Tab");
console.log("⏳ 第 2 次编辑（写回复核值）…");
await settle(page, { quiet: 2000 });

const t = await page.locator(".shell").innerText();
const i = t.search(/建议重算|待重算|资料已更新|因资料变更/);
console.log("===== 横幅文本 =====");
console.log(i >= 0 ? t.slice(Math.max(0, i - 60), i + 260) : "（未出现横幅）");
console.log("===== 该格最终值 =====");
console.log((await cell.inputValue()).slice(-70));

await shot(page, "期1-定位", "21-失效横幅");
await shot(page, "期1-定位", "22-失效横幅-全貌");
await shot(page, "期4-可信", "05-失效横幅与受影响步骤");
await browser.close();
