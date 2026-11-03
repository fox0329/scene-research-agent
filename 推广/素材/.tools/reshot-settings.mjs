import { chromium } from "@playwright/test";
import { openApp } from "./port.mjs";
import { shot, settle } from "./shot.mjs";
const { browser, page } = await openApp(chromium);
await page.getByRole("button", { name: "设置" }).first().click();
await settle(page, { quiet: 1800 });
const n = await page.evaluate(() => {
  const bad = /(Key 已配置|sk-[A-Za-z0-9_\-]{4,}|Bearer\s+\S+|https?:\/\/\S+|\/Users\/[A-Za-z0-9_.\-]+|已配置\s*[0-9a-f]{2,})/;
  let hit = 0;
  for (const el of document.querySelectorAll("body *")) {
    if (el.children.length === 0 && el.textContent && bad.test(el.textContent)) {
      el.textContent = bad.source.includes("https") && /^https?:\/\//.test(el.textContent) ? "●●● 接口地址已脱敏 ●●●" : "●●● 已配置（脱敏）";
      el.style.filter = "blur(5px)";
      hit++;
    }
  }
  for (const el of document.querySelectorAll("input, textarea")) {
    if (el.type === "password" || (el.value && bad.test(el.value))) {
      el.value = "●●●●●●●●";
      el.style.filter = "blur(6px)";
      hit++;
    }
  }
  for (const el of document.querySelectorAll("code, .mono, [class*=url]")) {
    if (el.textContent) { el.textContent = "●●● 已脱敏 ●●●"; el.style.filter = "blur(5px)"; hit++; }
  }
  return hit;
});
// 供应商名也脱敏（真实服务商名不进公开截图）
const renamed = await page.evaluate(() => {
  const map = [["拓维 deepseek flash", "供应商 A（OpenAI 兼容）"], ["Zhipu GLM", "供应商 B（OpenAI 兼容）"], ["DeepSeek-V4.1-Flash", "模型 A"], ["glm-5.3-flash", "模型 B-1"], ["glm-5.3", "模型 B-2"], ["deepseek-flash", "model-a"]];
  let hit = 0;
  for (const el of document.querySelectorAll("body *")) {
    if (el.children.length) continue;
    for (const [from, to] of map) {
      if (el.textContent && el.textContent.includes(from)) { el.textContent = el.textContent.split(from).join(to); hit++; }
    }
  }
  return hit;
});
console.log("供应商名脱敏处数:", renamed);
console.log("遮罩处数:", n);
await shot(page, "期5-上手", "00-设置页-已脱敏");
await shot(page, "期1-定位", "16-设置页-已脱敏");
const txt = await page.locator(".shell").innerText();
const leak = /(sk-[A-Za-z0-9_\-]{4,}|bigmodel|\/Users\/|已配置\s*[0-9a-f]{2,})/.exec(txt);
console.log("残留敏感串:", leak ? leak[0] : "无");
console.log(txt.slice(0, 700));
await browser.close();
