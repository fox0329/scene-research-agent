// 找到正在运行的「场景通」应用 HTTP 端口（Electron 内嵌 Fastify 服务动态端口）
import { execSync } from "node:child_process";

export function findAppPort() {
  if (process.env.APP_URL) return new URL(process.env.APP_URL).port;
  const out = execSync("lsof -nP -iTCP -sTCP:LISTEN", { encoding: "utf8" });
  const pids = execSync("pgrep -f '场景通.app/Contents/Resources/app.asar.unpacked/runtime/server'", {
    encoding: "utf8",
  })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const line of out.split("\n")) {
    const cols = line.split(/\s+/);
    const pid = cols[1];
    if (pids.includes(pid)) {
      const m = line.match(/TCP\s+127\.0\.0\.1:(\d+)\s+\(LISTEN\)/);
      if (m) return m[1];
    }
  }
  throw new Error("未找到运行中的应用端口（应用是否已启动？）");
}

/** 打开应用页面（Chromium 驱动，与 Electron 内嵌渲染器同一份构建产物） */
export async function openApp(chromium, { width = 1600, height = 1000, base } = {}) {
  const url = base ?? process.env.APP_URL ?? `http://127.0.0.1:${findAppPort()}/`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".shell", { timeout: 20_000 });
  return { browser, page, port: new URL(url).port };
}
