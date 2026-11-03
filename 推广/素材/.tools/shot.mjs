// 截图工具：统一口径（2x 像素密度、必要区域、隐去本机痕迹）+ 分步留痕
import { mkdirSync } from "node:fs";

export const SHOT_ROOT = "推广/素材/截图";

export function shotPath(group, name) {
  const dir = `${SHOT_ROOT}/${group}`;
  mkdirSync(dir, { recursive: true });
  return `${dir}/${name}.png`;
}

/** 等界面稳定：网络空闲 + 无「生成中」类文案 */
export async function settle(page, { timeout = 30_000, quiet = 800 } = {}) {
  await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
  await page.waitForTimeout(quiet);
}

export async function shot(page, group, name, { full = false, clip } = {}) {
  await settle(page);
  const path = shotPath(group, name);
  await page.screenshot({ path, fullPage: full, clip });
  console.log(`  📸 ${path}`);
  return path;
}

/** 从页面文本里抓一个数值（抓不到返回 null，不抛错） */
export async function textOf(page, selector) {
  try {
    return (await page.locator(selector).first().innerText()).trim();
  } catch {
    return null;
  }
}

/** 等待文本出现 */
export async function waitText(page, re, { timeout = 300_000, interval = 3000, label = "" } = {}) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeout) {
    const body = await page.locator(".shell").innerText().catch(() => "");
    last = body;
    if (re.test(body)) return body;
    await page.waitForTimeout(interval);
  }
  throw new Error(`等待超时${label ? `（${label}）` : ""}：${re}\n最近文本片段：${last.slice(0, 600)}`);
}
