// 脱敏后补拍：只导航、不触发任何分析，把所有含表格的界面重拍一遍
import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
import { shot, settle } from "./shot.mjs";

const SCEN_A = "汽车零部件压铸车间设备联网与OEE提升";
const SCEN_B = "市政污水处理厂设备监控与能耗管理";

const { browser, page } = await openApp(chromium);

/** 把任何疑似密钥、账号、本机路径在截图前遮掉 */
async function maskSecrets() {
  const n = await page.evaluate(() => {
    let hit = 0;
    const bad = /(sk-[A-Za-z0-9_\-]{4,}|Bearer\s+[A-Za-z0-9._\-]{8,}|\/Users\/[A-Za-z0-9_.\-]+)/;
    for (const el of document.querySelectorAll("input, textarea")) {
      if (el.type === "password") {
        el.style.filter = "blur(7px)";
        hit++;
      }
      if (el.value && bad.test(el.value)) {
        el.value = "●●●●●●●●";
        el.style.filter = "blur(4px)";
        hit++;
      }
    }
    for (const el of document.querySelectorAll("body *")) {
      if (el.children.length === 0 && el.textContent && bad.test(el.textContent)) {
        el.textContent = "●●●●●●●●";
        el.style.filter = "blur(4px)";
        hit++;
      }
    }
    return hit;
  });
  if (n) console.log(`  🔒 已遮罩 ${n} 处疑似敏感内容`);
}

async function pickScenario(name) {
  const row = page.locator(".side .proj").filter({ hasText: name }).first();
  if (!(await row.count())) {
    console.log(`  ⚠️ 找不到场景「${name}」`);
    return false;
  }
  await row.locator(".proj-hd").click();
  await settle(page, { quiet: 1200 });
  return true;
}

async function gotoStep(n, title) {
  const node = page.locator(".flow-node").nth(n - 1);
  if (!(await node.count())) {
    console.log(`  ⚠️ 找不到第 ${n} 步节点`);
    return false;
  }
  const cls = (await node.getAttribute("class")) ?? "";
  if (cls.includes("locked")) {
    console.log(`  ⚠️ 第 ${n} 步未解锁，跳过（${title}）`);
    return false;
  }
  await node.click();
  await settle(page, { quiet: 1600 });
  return true;
}

async function clickChip(label) {
  const chip = page.locator(".chip, .chip-mini, button.chip").filter({ hasText: label }).first();
  if (await chip.count()) {
    await chip.click();
    await settle(page, { quiet: 1200 });
    return true;
  }
  return false;
}

/* ── 1. 产品资料库各表 ── */
await page.getByRole("button", { name: /产品资料库/ }).first().click();
await settle(page, { quiet: 1500 });
await shot(page, "期2-实战", "00-产品资料库全貌");
for (const [code, file] of [
  ["质量总评", "01-产品资料库-质量总评"],
  ["已导入资料", "02-产品资料库-已导入资料"],
  ["M1 产品清单", "03-产品资料库-M1产品清单"],
  ["M2 规格书", "04-产品资料库-M2规格书"],
  ["M3 能力清单", "05-产品资料库-M3能力清单"],
  ["M4 边界声明", "06-产品资料库-M4边界声明"],
  ["M5 已知限制", "07-产品资料库-M5已知限制"],
  ["O 可选材料", "08-产品资料库-可选材料"],
]) {
  const b = page.getByRole("button", { name: code }).first();
  if (!(await b.count())) continue;
  await b.click();
  await settle(page, { quiet: 1300 });
  await shot(page, "期1-定位", file);
  if (code === "质量总评") await shot(page, "期4-可信", "03-质量总评与完成度");
}

/* ── 2. 设置页（脱敏）── */
await page.getByRole("button", { name: "设置" }).first().click();
await settle(page, { quiet: 1800 });
await maskSecrets();
await shot(page, "期5-上手", "00-设置页-已脱敏");
await shot(page, "期1-定位", "16-设置页-已脱敏");
console.log("设置页文本片段：");
console.log((await page.locator(".shell").innerText()).slice(0, 900));

/* ── 3. 场景 A 七个步骤 ── */
await pickScenario(SCEN_A);
const A_STEPS = [
  [1, "场景定义", [["场景概述", "20-第1步-场景概述"]]],
  [2, "认识场景", [
    ["门槛与合规", "12-第2步-门槛与合规"],
    ["场景要素清单", "12b-第2步-场景要素清单"],
    ["分层架构", "12c-第2步-分层架构"],
    ["要素间关系", "12d-第2步-要素间关系"],
    ["物理与合规约束", "12e-第2步-物理与合规约束"],
  ]],
  [3, "理解商业", [
    ["利润池", "13-第3步-利润池"],
    ["方案形态", "13b-第3步-方案形态"],
    ["竞争对手对照", "13c-第3步-竞争对手对照"],
    ["替代方案", "13d-第3步-替代方案"],
    ["未满足需求", "13e-第3步-未满足需求"],
  ]],
  [4, "能力匹配", [
    ["能力底账", "14-第4步-能力底账"],
    ["需求-能力对照", "14b-第4步-需求能力对照"],
    ["竞争力判断", "14c-第4步-竞争力判断"],
    ["我方参与地图", "14d-第4步-我方参与地图"],
  ]],
  [5, "方案实现", [["方案架构", "15-第5步-方案架构"]]],
  [6, "价值验证", [
    ["价值与指标", "16-第6步-价值与指标"],
    ["试点与验收", "16b-第6步-试点与验收"],
  ]],
  [7, "交付物", [["解决方案", "18-第7步-解决方案"]]],
];

for (const [n, title, chips] of A_STEPS) {
  console.log(`\n=== 场景 A 第 ${n} 步 ${title} ===`);
  if (!(await gotoStep(n, title))) continue;
  for (const [label, file] of chips) {
    if (label !== "场景概述" && label !== "方案架构") await clickChip(label);
    else await clickChip(label);
  }
  // 逐 chip 重拍：上一轮循环已经把 chip 点完了，这里重来一遍出图
  for (const [label, file] of chips) {
    await clickChip(label);
    await shot(page, "期2-实战", file);
    if (n === 2 && label === "门槛与合规") await shot(page, "期1-定位", "17-门槛与合规");
    if (n === 3 && label === "替代方案") await shot(page, "期1-定位", "18-替代方案");
    if (n === 4 && label === "能力底账") await shot(page, "期1-定位", "19-能力底账");
    if (n === 6 && label === "价值与指标") await shot(page, "期1-定位", "20-价值与指标");
    if (n === 7) {
      await shot(page, "期5-上手", `0${label === "解决方案" ? 3 : 4}-交付物-${label}`);
      await shot(page, "期5-上手", "02-交付物预览");
    }
  }
}

/* ── 4. 场景 B 前两步 ── */
await pickScenario(SCEN_B);
for (const [n, title, chips] of [
  [1, "场景定义", [["场景概述", "30-场景B-第1步"]]],
  [2, "认识场景", [
    ["门槛与合规", "31-场景B-第2步-门槛与合规"],
    ["场景要素清单", "32-场景B-第2步-场景要素清单"],
  ]],
]) {
  console.log(`\n=== 场景 B 第 ${n} 步 ${title} ===`);
  if (!(await gotoStep(n, title))) continue;
  for (const [label, file] of chips) {
    await clickChip(label);
    await shot(page, "期1-定位", file);
  }
}
await shot(page, "期1-定位", "33-场景B-全貌");

console.log("\n✅ 补拍完成");
await browser.close();
