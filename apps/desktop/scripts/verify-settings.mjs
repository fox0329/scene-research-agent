#!/usr/bin/env node
/**
 * @scene/desktop — 验「模型端点与密钥在应用内配置」这条链路（在**打包产物**上跑）
 *
 * 为什么单独验：这是桌面版对用户的承诺之一（不依赖 DSH、不依赖仓库里的配置文件，
 * 装好就能在界面里配模型）。它牵涉三处容易各错一半的地方：
 *   ① 界面能不能真的保存；② 密钥落盘位置对不对（供应商登记表用的是 `process.cwd()/data/…`，
 *   而桌面版是靠"把服务端 cwd 设成应用数据目录"来兜住的——这件事必须实测，不能靠推理）；
 *   ③ 文件权限是不是 0600（只本用户可读）。
 *
 * 只在临时 userData 目录里做，不碰用户真实配置。
 *
 * 用法：SCENE_SMOKE_APP=<可执行文件> node apps/desktop/scripts/verify-settings.mjs
 *       （不传 SCENE_SMOKE_APP 时自动在 release/ 下找）
 */

import { _electron as electronLauncher } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPackagedApp, packagedEnv } from "./find-packaged-app.mjs";

const NAMES = { provider: "verify-gw", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" };
const FAKE_KEY = "sk-verify-should-not-appear-in-ui";

const failures = [];
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures.push(label);
};

const bin = process.env.SCENE_SMOKE_APP ?? findPackagedApp();
if (!bin || !existsSync(bin)) {
  console.error("没找到打包产物，先跑：pnpm --filter @scene/desktop run pack:dir");
  process.exit(1);
}
console.log(`对打包产物验证「应用内配置模型」：${bin}\n`);

const userData = mkdtempSync(join(tmpdir(), "scene-settings-verify-"));
const app = await electronLauncher.launch({
  executablePath: bin,
  args: [`--user-data-dir=${userData}`],
  env: packagedEnv(),
});

try {
  const win = await app.firstWindow({ timeout: 90_000 });
  const consoleErrors = [];
  win.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  win.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await win.locator(".empty-state-title, .flow-rail").first().waitFor({ timeout: 90_000 });

  /* 进「设置」（导航底部的齿轮按钮） */
  await win.locator(".side-foot .nav-item").click();
  await win.getByText("模型配置").first().waitFor({ timeout: 30_000 });

  /* 新建供应商并填写：名称 / 链接 / Key / 模型 ID */
  await win.getByRole("button", { name: "添加供应商" }).first().click();
  await win.locator('input[placeholder*="deepseek-official"]').fill(NAMES.provider);
  await win.locator('input[placeholder*="api.example.com"]').fill(NAMES.baseUrl);
  await win.locator('input[type="password"]').fill(FAKE_KEY);
  await win.locator('input[placeholder*="手动补充模型 ID"]').fill(NAMES.model);
  await win.locator(".model-list-add button").click();
  await win.getByRole("button", { name: "保存" }).click();

  /* 保存后：列表里出现这条供应商 */
  await win.getByText(NAMES.provider).first().waitFor({ timeout: 20_000 });
  await win.waitForTimeout(1200);

  const providerFile = join(userData, "data", "providers.local.json");
  const exists = existsSync(providerFile);
  const mode = exists ? statSync(providerFile).mode & 0o777 : 0;
  const raw = exists ? readFileSync(providerFile, "utf8") : "";
  const uiText = await win.locator("body").innerText();

  ok("界面上能新建并保存供应商", await win.getByText(NAMES.provider).first().isVisible(), NAMES.provider);
  ok("端点与模型写进了登记表", raw.includes(NAMES.baseUrl) && raw.includes(NAMES.model), NAMES.baseUrl);
  ok("密钥落盘在应用数据目录（不是安装目录/仓库）", exists, providerFile.replace(userData, "<userData>"));
  ok("登记表权限是 0600（仅本用户可读）", mode === 0o600, `0${mode.toString(8)}`);
  ok("密钥不以明文回显到界面", !uiText.includes(FAKE_KEY), "界面上只有掩码");
  ok("控制台无报错", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" / "));

  await win.screenshot({ path: join(userData, "settings.png") }).catch(() => {});
} finally {
  await app.close().catch(() => {});
  rmSync(userData, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n应用内配置模型：失败 ${failures.length} 项：${failures.join("、")}`);
  process.exit(1);
}
console.log("\n应用内配置模型：通过 ✅");
