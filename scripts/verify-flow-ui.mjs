/**
 * 真实应用（4081）流程 UI 验收脚本
 *
 * 与 e2e/*.spec.ts 的区别：不启动任何 webServer，直接驱动**正在运行的应用**，
 * 验证的正是用户刷新页面后会看到的东西。用于集成时的人工/自动核对。
 *
 * 用法：node scripts/verify-flow-ui.mjs
 */
// @playwright/test 是根 devDependency，且 re-export 浏览器 API（playwright 本体未提升到根）
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:4081";
const results = [];
const ok = (name, cond, extra = "") => {
  results.push(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) {
    console.log(results.join("\n"));
    process.exit(1);
  }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));

await page.goto(`${BASE}/`);
await page.waitForSelector(".shell", { timeout: 15_000 });

// 1. 左栏：基础设施区（产品资料库 / 知识库）常驻
await page.getByRole("button", { name: "产品资料库" }).first().waitFor({ timeout: 8000 });
ok(
  "1 左栏常驻基础设施（产品资料库 / 知识库）",
  (await page.getByRole("button", { name: "产品资料库" }).count()) > 0 &&
    (await page.getByRole("button", { name: "知识库" }).count()) > 0,
);

// 2. 场景列表显示流程进度「第 n/9 步」
const listText = await page.locator(".side").innerText();
ok("2 场景列表显示「第 n/9 步」", /第 \d+\/9 步/.test(listText), (listText.match(/第 \d+\/9 步/) ?? [""])[0]);

// 3. 进入一个场景 → 顶部是流程进度轴（不再是 8 个阶段 tab）
const rail = page.locator(".flow-rail");
if (!(await rail.isVisible().catch(() => false))) {
  // 未自动进入场景：按场景名点左栏（验收脚本用全新临时库，场景名由脚本创建）
  const name = process.env.SCENARIO_NAME ?? "流程验收场景";
  const entry = page.locator(`.side :text("${name}")`).first();
  if (await entry.count()) await entry.click();
  else await page.locator(".side").getByRole("button").nth(1).click().catch(() => undefined);
}
await rail.waitFor({ timeout: 15_000 });
const nodes = await rail.locator(".flow-node").count();
ok("3 进入场景后是流程进度轴（9 步），不再是阶段 tab", nodes === 9, `${nodes} 个节点`);
ok("3b 旧的 8 阶段 tab 已移除", (await page.locator(".stabs").count()) === 0);

// 4. 三态与推进按钮
const done = await rail.locator(".flow-node--done").count();
const current = await rail.locator(".flow-node--current").count();
const locked = await rail.locator(".flow-node--locked").count();
const ready = await rail.locator(".flow-node--ready").count();
// 锁步：可推进只在「解锁全部」后出现；四态之和恒为 9
ok(
  "4 流程轴四态渲染（已完成/当前/可推进/未解锁）",
  current === 1 && done + current + locked + ready === 9,
  `done=${done} current=${current} ready=${ready} locked=${locked}`,
);
// 解锁全部后未解锁数应为 0，且按钮显示已解锁
const unlockedAll = (await rail.getByRole("button", { name: "已解锁全部步骤" }).count()) === 1;
if (unlockedAll) {
  ok("4c 已解锁全部：未解锁节点为 0", locked === 0);
}

const completeBtn = rail.getByRole("button", { name: "完成本步，进入下一步" });
ok("4b 有「完成本步，进入下一步」按钮", (await completeBtn.count()) === 1);

// 5. 右栏双 Tab（补充说明 / 阶段总结）
await page.locator(".det .det-tab").first().waitFor({ timeout: 8000 });
const tabs = await page.locator(".det .det-tab").count();
ok("5 右栏双 Tab", tabs === 2);

// 6. 产品不产出判断：整页不得出现建议档位/质量关
const shellText = await page.locator(".shell").innerText();
ok(
  "6 不产出判断（无建议档位与质量关）",
  !/建议(通过|有条件通过|不通过|进)/.test(shellText) && !shellText.includes("质量关"),
);

// 7. 已完成步骤可点回看
if (done > 0) {
  await rail.locator(".flow-node--done").first().click();
  await page.waitForTimeout(300);
  ok("7 已完成步骤可点回看", /正在回看/.test(await rail.innerText()));
} else {
  ok("7 已完成步骤可点回看（当前无已完成步，跳过）", true);
}

// 8. 流转一圈：完成本步 → 进度前移（在当前步 ready 时）
const hint = await rail.innerText();
if (!(await completeBtn.isDisabled())) {
  const before = await rail.locator(".flow-node--done").count();
  await completeBtn.click();
  await page.waitForFunction(
    (n) => document.querySelectorAll(".flow-rail .flow-node--done").length > n,
    before,
    { timeout: 15_000 },
  );
  ok("8 点「完成本步」→ 流程实际前移", true, `${before} → ${before + 1}`);
} else {
  ok("8 「完成本步」按数据判定禁用（未就绪不可点）", true, hint.split("\n").slice(-2)[0] ?? "");
}

await browser.close();
console.log(results.join("\n"));
console.log("\n真实应用流程 UI 验收：全部通过 ✅");
