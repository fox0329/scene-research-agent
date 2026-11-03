// DEMO 第 3 段：逐步推进 2→6 步（每步跑模型分析 + 留痕截图）
import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
import { shot, settle } from "./shot.mjs";

const FROM = Number(process.env.FROM_STEP ?? 2);
const TO = Number(process.env.TO_STEP ?? 6);
const GROUPS = { 2: "期2-实战", 3: "期2-实战", 4: "期2-实战", 5: "期2-实战", 6: "期2-实战" };

const { browser, page } = await openApp(chromium);
const body = () => page.locator(".shell").innerText();

/** 当前处在第几步（从流程轴的 aria-label 取） */
async function currentStep() {
  const cur = page.locator(".flow-node--current").first();
  if (!(await cur.count())) return null;
  const al = (await cur.getAttribute("aria-label")) ?? "";
  const m = al.match(/第\s*(\d+)\s*步/);
  return m ? Number(m[1]) : null;
}

/** 等本步分析跑完：出现「重算本步」且主按钮不再是「分析中」 */
async function waitStepDone(step, { timeout = 2_400_000 } = {}) {
  const started = Date.now();
  let lastLog = 0;
  while (Date.now() - started < timeout) {
    const t = await body();
    const running = /分析中|生成中|正在分析|跑分析|停止/.test(t);
    const hasRedo = /重算本步/.test(t);
    const hasNext = /下一步/.test(t);
    if (Date.now() - lastLog > 20_000) {
      console.log(`    ⏱ 第 ${step} 步进行中… ${Math.round((Date.now() - started) / 1000)}s ${running ? "(分析中)" : ""}`);
      lastLog = Date.now();
    }
    if (hasRedo && hasNext && !running) return t;
    await page.waitForTimeout(4000);
  }
  throw new Error(`第 ${step} 步超时未完成`);
}

console.log("当前步:", await currentStep());

for (let step = FROM; step <= TO; step++) {
  const cur = await currentStep();
  console.log(`\n===== 进入第 ${step} 步（当前 ${cur}） =====`);

  if (cur !== step) {
    // 前进：点「下一步」或流程轴上的目标节点
    const next = page.getByRole("button", { name: /^下一步$/ });
    if (await next.count()) {
      await next.first().click();
      await page.waitForTimeout(2500);
    } else {
      const node = page.locator(".flow-node").nth(step - 1);
      await node.click().catch(() => {});
      await page.waitForTimeout(2000);
    }
  }

  // 需要跑分析就点「开始本步分析」
  const start = page.getByRole("button", { name: /开始本步分析/ });
  if (await start.count()) {
    console.log(`  ▶ 触发第 ${step} 步分析`);
    await start.first().click();
    await page.waitForTimeout(5000);
  } else {
    console.log("  （无需触发，可能已在跑或已产出）");
  }

  const t = await waitStepDone(step);
  const head = t.slice(0, 220).replace(/\n+/g, " | ");
  console.log(`  ✅ 第 ${step} 步完成：${head}`);
  await shot(page, GROUPS[step] ?? "期2-实战", `1${step}-第${step}步-中栏`);
  await shot(page, "期2-实战", `1${step}-第${step}步-全貌`);
}
console.log("\n✅ 推进完成");
await browser.close();
