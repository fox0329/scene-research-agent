import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 中栏两行粘性表头 + 交付物两份报告 · 联真 e2e（变更表 #110）
 *
 * 用户定调（2026-10-06）：
 *  ① 「将每个阶段对应的表格行移到阶段名称下面，两行显示，这样用户上下移动表格内容，
 *     表格的名称能始终显示。」→ 断言：滚中栏 500px 后，阶段名与表名行仍在视口顶部，
 *     且第一行讲的是**用户能对上的**第 n 步名称；
 *  ② 「交付物阶段，不要显示一个检查清单，而是和其他阶段一样，显示具体的内容，
 *     具体来说就是两份报告，在中栏显示出来」→ 断言：中栏没有检查清单、有报告正文、
 *     两个 chip 能切换内部/对外两份口径；装配原料清单按 G-R9 归右栏「阶段总结」。
 */

const LIVE = "http://127.0.0.1:46175";
const ROOT = process.cwd();
const require_ = createRequire(join(ROOT, "packages", "infra", "package.json"));

type Db = {
  prepare: (sql: string) => { run: (...args: unknown[]) => unknown; all: () => unknown[] };
  close: () => void;
};

/** 联真服务的临时库：playwright.config 以 `/tmp/scene-e2e-<时间戳>.db` 启动 → 取最新一个 */
function newestDb(): string {
  const candidates = readdirSync("/tmp")
    .filter((f) => /^scene-e2e-\d+\.db$/.test(f))
    .map((f) => ({ file: join("/tmp", f), mtime: statSync(join("/tmp", f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) throw new Error("没找到联真临时库（/tmp/scene-e2e-*.db）");
  return candidates[0]!.file;
}

/**
 * 给第 4 步（能力匹配）的表种够多的行，把中栏撑到可滚动。
 * 为什么要种：粘性表头只有"内容比视口高"时才有意义，否则断言不到真东西。
 */
function seedTallStage(dbPath: string, scenarioId: string): void {
  const Database = require_("better-sqlite3") as new (path: string) => Db;
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO stage_data
       (id, scenario_id, stage, table_code, row, is_stale, source_type, created_at, updated_at)
     VALUES (?, ?, 3, ?, ?, 0, 'AI提取', ?, ?)`,
  );
  for (const code of ["表4-1", "表4-2", "表4-3", "表4-4", "表4-5"]) {
    for (let i = 0; i < 30; i++) {
      stmt.run(
        `e2e-tall-${code}-${i}-${Date.now()}`,
        scenarioId,
        code,
        JSON.stringify({ item: `第 ${i + 1} 项`, content: `占位内容 ${i + 1}`, match: "支撑" }),
        now,
        now,
      );
    }
  }
  db.close();
}

/** 把前 n 步标完成（不跑模型，纯造状态），让第 n+1 步成为当前步 */
async function completeSteps(page: import("@playwright/test").Page, projectId: string, n: number) {
  for (const step of Array.from({ length: n }, (_, i) => i + 1)) {
    const res = await page.request.post(
      `${LIVE}/api/v1/projects/${projectId}/flow/steps/${step}/complete`,
    );
    expect(res.ok()).toBe(true);
  }
}

async function newProject(page: import("@playwright/test").Page, name: string): Promise<string> {
  const created = await page.request.post(`${LIVE}/api/v1/projects`, { data: { name } });
  expect(created.ok()).toBe(true);
  return ((await created.json()) as { id: string }).id;
}

test("中栏两行粘性表头：滚表格时阶段名与表名始终可见（联真）", async ({ page }) => {
  const name = `E2E 粘性表头 ${Date.now()}`;
  const projectId = await newProject(page, name);
  await completeSteps(page, projectId, 3); // 第 4 步「能力匹配」成为当前步
  seedTallStage(newestDb(), projectId);

  await page.goto(`${LIVE}/`);
  await expect(page.locator(".shell")).toBeVisible();
  await page.locator(".proj-hd", { hasText: name }).click();

  const head = page.locator(".ws .pnl-head");
  await expect(head).toBeVisible();
  // 第 1 行：用户界面上的第 n 步 + 阶段名（不是内部阶段号）
  await expect(head.locator("h2")).toHaveText("第 4 步 · 能力匹配");
  // 第 2 行：本步的表名
  await expect(head.locator(".chip").first()).toHaveText("能力底账");
  await expect(head).toContainText("需求-能力对照");

  const topBefore = (await head.boundingBox())!.y;
  await page.locator(".ws").evaluate((el) => {
    el.scrollTop = 500;
  });
  await page.waitForTimeout(200);

  // 滚动后表头仍贴在顶部（允许 4px 内的渲染误差）
  const topAfter = (await head.boundingBox())!.y;
  expect(Math.abs(topAfter - topBefore)).toBeLessThanOrEqual(4);
  // 表名行本身也在视口里（这才是用户要的"表格的名称能始终显示"）
  await expect(head.locator(".chip").first()).toBeInViewport();
  await expect(page.locator(".ws").evaluate((el) => el.scrollTop)).resolves.toBeGreaterThan(0);
});

test("交付物：中栏显示两份报告正文（联真）", async ({ page }) => {
  const name = `E2E 交付物 ${Date.now()}`;
  const projectId = await newProject(page, name);
  await completeSteps(page, projectId, 7);

  await page.goto(`${LIVE}/`);
  await expect(page.locator(".shell")).toBeVisible();
  await page.locator(".proj-hd", { hasText: name }).click();
  await page.locator(".flow-rail .flow-node", { hasText: "交付物" }).click();

  const head = page.locator(".ws .pnl-head");
  await expect(head.locator("h2")).toHaveText("第 7 步 · 交付物");
  await expect(head.locator(".chip")).toHaveCount(2);
  await expect(head.locator(".chip").first()).toHaveText("内部调研版");

  // 中栏不再有检查清单，而是报告正文
  await expect(page.locator(".ws .delivery-steps")).toHaveCount(0);
  const body = page.locator(".ws .md-body");
  await expect(body).toBeVisible();
  await expect(body).toContainText("内部调研报告");
  // 内部版独有的装配痕迹：附录（来源索引 / 信息覆盖概览）
  await expect(body).toContainText("来源索引");

  // 切到对外汇报版：同一位置换成另一份口径（对外版不装附录）
  await page.locator(".ws .pnl-head .chip", { hasText: "对外汇报版" }).click();
  await expect(page.locator(".ws .md-body")).toContainText("汇报材料");
  await expect(page.locator(".ws .md-body")).not.toContainText("内部调研报告");
  await expect(page.locator(".ws .md-body")).not.toContainText("来源索引");

  // 装配原料清单按 G-R9 归右栏「阶段总结」，不占中栏
  await page.locator(".det-tabs .det-tab", { hasText: "阶段总结" }).click();
  await expect(page.locator(".det-body")).toContainText("装配原料");
});
