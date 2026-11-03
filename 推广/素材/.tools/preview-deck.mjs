/** 把 .deck-build/svg_final/ 的成品 SVG 用 Chromium 截成 PNG，供人眼复核版式。
 *  直接 goto .svg 会让 Chromium 按「图片文档」打开（没有 head），所以读文本内联进 HTML。 */
import { chromium } from "@playwright/test";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "demo资料", ".deck-build", "svg_final");
const out = join(here, "..", "demo资料", ".deck-build", "preview");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
for (const f of readdirSync(src).filter((x) => x.endsWith(".svg")).sort()) {
  const svg = readFileSync(join(src, f), "utf8").replace(/<\?xml[^>]*\?>/, "");
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}svg{display:block}</style></head><body>${svg}</body></html>`,
    { waitUntil: "load" },
  );
  await page.waitForTimeout(120);
  await page.screenshot({ path: join(out, f.replace(/\.svg$/, ".png")) });
}
await browser.close();
console.log(`✅ ${readdirSync(out).length} 张预览图 → ${out}`);
