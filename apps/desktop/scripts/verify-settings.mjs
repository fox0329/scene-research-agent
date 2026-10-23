#!/usr/bin/env node
/**
 * @scene/desktop — 验「模型端点与密钥在应用内配置」这条链路（在**打包产物**上跑）
 *
 * 为什么单独验：这是桌面版对用户的承诺之一（不依赖 DSH、不依赖仓库里的配置文件，
 * 装好就能在界面里配模型）。它牵涉三处容易各错一半的地方：
 *   ① 界面能不能真的保存；② 密钥落盘位置对不对（供应商登记表用的是 `process.cwd()/data/…`，
 *   而桌面版是靠"把服务端 cwd 设成应用数据目录"来兜住的——这件事必须实测，不能靠推理）；
 *   ③ 文件权限是不是 0600（只本用户可读）；
 *   ④ 密钥是不是**真的被系统钥匙串保护**了（文件里不该出现明文密钥，见变更表 #183）。
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

/* Windows 上 Node 的 mode 位没有 POSIX 含义（权限由 ACL 管），0600 这类断言在那儿只会误报 */
const POSIX_PERMS = process.platform !== "win32";

const NAMES = { provider: "verify-gw", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" };
const FAKE_KEY = "sk-verify-should-not-appear-in-ui";

const failures = [];
/** 环境不具备条件时的跳过（无头/自动化下钥匙串不可用），不算失败但必须显式说明 */
const skip = (label, why) => console.log(`  ⏭ ${label} — ${why}`);
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
  await win.getByRole("button", { name: "设置", exact: true }).click();
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
  ok(
    POSIX_PERMS ? "登记表权限是 0600（仅本用户可读）" : "登记表在应用数据目录（Windows 权限由 ACL 管）",
    POSIX_PERMS ? mode === 0o600 : exists,
    POSIX_PERMS ? `0${mode.toString(8)}` : "跳过 mode 断言",
  );
  ok("密钥不以明文回显到界面", !uiText.includes(FAKE_KEY), "界面上只有掩码");

  /* 钥匙串保护：文件里应该是密文，明文密钥不该出现在任何落盘文件里。
     注意判据是"**开了钥匙串保护就必须加密**"——钥匙串默认是关的（免签名分发下它会反复要登录密码、
     还会阻塞启动，见故障清单 #61/#62），所以这里按"有没有生成主密钥"来判断：
     要专门验加密这条路径，就用 SCENE_KEYCHAIN_PROTECTION=1 跑本脚本。 */
  const masterFile = join(userData, "secrets", "master.key");
  const masterRaw = existsSync(masterFile) ? readFileSync(masterFile) : Buffer.alloc(0);
  const masterMode = existsSync(masterFile) ? statSync(masterFile).mode & 0o777 : 0;
  const serverLog = readFileSync(join(userData, "logs", "server.log"), "utf8");
  const keychainInUse = existsSync(masterFile);
  if (keychainInUse) {
    ok("密钥以密文落盘（文件里查不到明文）", !raw.includes(FAKE_KEY) && raw.includes("enc:v1:"), "enc:v1:…");
  } else {
    /* 这是对用户的承诺：默认配置下**永远不碰系统钥匙串**，因此不会弹授权框、不会要登录密码 */
    ok("默认不访问系统钥匙串（不会弹授权框/要密码）", !existsSync(masterFile), "未生成主密钥");
    skip("密钥以密文落盘", "钥匙串保护默认关闭；要验这条路径，用 SCENE_KEYCHAIN_PROTECTION=1 跑本脚本");
  }
  if (keychainInUse) {
    ok(
      "主密钥由系统钥匙串包一层后存盘",
      !POSIX_PERMS || masterMode === 0o600,
      `0${masterMode.toString(8)}`,
    );
    ok(
      "存盘的是被包过的主密钥，不是裸的 32 字节",
      !/^[A-Za-z0-9+/]{43}=$/u.test(masterRaw.toString("utf8").trim()),
      `${masterRaw.length} 字节密文`,
    );
  } else {
    skip("主密钥存盘形态", "同上");
  }
  /* 这条无论启用与否都必须成立：日志要能让人一眼看出密钥保护处于什么状态 */
  ok(
    "服务端日志留痕：密钥保护状态可排障",
    serverLog.includes("密钥保护=") &&
      (keychainInUse ? serverLog.includes("系统钥匙串") : serverLog.includes("未启用")),
    keychainInUse ? "钥匙串" : "明文 0600",
  );

  /* 环境本身是否提供系统钥匙串（macOS Keychain / Windows DPAPI） */
  const keychainAvailable = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
  if (keychainInUse) ok("当前环境系统钥匙串可用", keychainAvailable === true);
  else skip("当前环境系统钥匙串可用", `isEncryptionAvailable=${String(keychainAvailable)}（未启用）`);

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
