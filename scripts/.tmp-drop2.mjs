import { chromium } from "@playwright/test";
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 950 } });
const net = [];
p.on("request", (r) => { if (r.url().includes("/stages/1/")) net.push(`${ts()} → ${r.method()} ${r.url().split("/api/v1")[1].slice(0, 70)}`); });
p.on("requestfailed", (r) => { if (r.url().includes("/advance")) net.push(`${ts()} ✗ 连接失败 ${r.failure()?.errorText}`); });
p.on("console", (m) => { const t = m.text(); if (/错误|恢复|完成|提示/.test(t)) net.push(`${ts()} [console] ${t.slice(0, 110)}`); });

await p.goto("http://127.0.0.1:4086/", { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
await p.locator(".side .proj-hd", { hasText: "智慧会议室" }).first().click();
await p.waitForTimeout(1200);
const btns = async () => (await p.locator(".flow-actions button").allInnerTexts()).join(" | ");
const lines = async () => (await p.locator(".ws").first().innerText().catch(() => "")).slice(0, 0);
const start = p.locator(".flow-actions button", { hasText: /开始本步分析|重算本步/ }).first();
console.log(ts(), "起点:", await btns(), "| 点:", (await start.innerText()).trim());
await start.click();

let lastLabel = "";
let converged = false;
for (let i = 0; i < 60; i += 1) {
  await p.waitForTimeout(3000);
  const label = await btns();
  if (label !== lastLabel) { console.log(ts(), "流程轴:", label); lastLabel = label; }
  const stream = await p.locator(".ws").first().innerText().catch(() => "");
  if (stream.includes("恢复")) console.log(ts(), "中栏出现恢复提示");
  if (!/分析中/.test(label)) { console.log(ts(), "★ 收敛完成（未卡在分析中）"); converged = true; break; }
}
console.log("--- 网络轨迹 ---");
console.log(net.join("\n"));
console.log("收敛:", converged);
await b.close();
