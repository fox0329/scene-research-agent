import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 资料失效横幅 · 联真 e2e（变更表 #107）
 *
 * 为什么放在这里：横幅只在"上游资料被改过、某阶段结果被标待重算"时出现，而标脏的
 * 两个入口（资料行编辑 / 整理资料库）都要真库真链路；且**阶段产出只能由分析生成**，
 * 没有写接口，所以本套件直接往联真服务的临时库种一行 `is_stale = 1` 的结果行。
 *
 * 覆盖用户提的两件事：
 *  ① 横幅讲**用户能对上的流程步**（原来是「2 个阶段…（3、4 阶段）」，对不上界面上的「第 5 步」）；
 *  ② 横幅上给「已知悉」出口 → 只清标记、分析数据一字不动。
 */

const LIVE = "http://127.0.0.1:46175";
const ROOT = process.cwd();
const require_ = createRequire(join(ROOT, "packages", "infra", "package.json"));

/** 联真服务的临时库：playwright.config 以 `/tmp/scene-e2e-<时间戳>.db` 启动 → 取最新一个 */
function newestDb(): string {
  const candidates = readdirSync("/tmp")
    .filter((f) => /^scene-e2e-\d+\.db$/.test(f))
    .map((f) => ({ file: join("/tmp", f), mtime: statSync(join("/tmp", f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) throw new Error("没找到联真临时库（/tmp/scene-e2e-*.db）");
  return candidates[0]!.file;
}

/** 往临时库种一行「阶段 4 · 表5-1」的待重算结果（模拟：M1 改过 → 阶段 4 需重算） */
function seedStaleRow(dbPath: string, scenarioId: string): string {
  const Database = require_("better-sqlite3") as new (path: string) => {
    prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
    close: () => void;
  };
  const db = new Database(dbPath);
  const id = `e2e-stale-${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO stage_data
       (id, scenario_id, stage, table_code, row, is_stale, source_type, created_at, updated_at)
     VALUES (?, ?, 4, '表5-1', ?, 1, 'AI提取', ?, ?)`,
  ).run(id, scenarioId, JSON.stringify({ layer: "感知层", components: "CT15" }), now, now);
  db.close();
  return id;
}

test("资料更新横幅：讲流程步 + 「已知悉」只清标记（联真）", async ({ page }) => {
  // 1) 建场景（API 更快更稳，界面新建会顺带拉起场景定义对话）
  const name = `E2E 失效横幅 ${Date.now()}`;
  const created = await page.request.post(`${LIVE}/api/v1/projects`, { data: { name } });
  expect(created.ok()).toBe(true);
  const project = (await created.json()) as { id: string };

  // 2) 种一行待重算的 表5-1（阶段 4 → 用户看到的是第 5 步）
  seedStaleRow(newestDb(), project.id);

  // 3) 打开这个场景：横幅文案按「第 n 步 + 名称」说，不再写阶段号
  await page.goto(`${LIVE}/`);
  await expect(page.locator(".shell")).toBeVisible();
  await page.locator(".proj-hd", { hasText: name }).click();
  const banner = page.locator(".stale-banner").first();
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("1 步的分析因资料变更待重算");
  await expect(banner).toContainText("第 5 步 方案与实现");
  await expect(banner).not.toContainText("阶段");

  // 4) 服务端也按同一口径返回（steps 是流程步号）
  const before = await page.request.get(`${LIVE}/api/v1/projects/${project.id}/stale`);
  expect((await before.json()) as unknown).toMatchObject({ stages: [4], steps: [5] });

  // 5) 「已知悉」→ 横幅消失，且分析数据一字未动
  await banner.getByRole("button", { name: "已知悉" }).click();
  await expect(page.locator(".stale-banner").first()).toBeHidden();

  const after = await page.request.get(`${LIVE}/api/v1/projects/${project.id}/stale`);
  const info = (await after.json()) as { banner: string | null; stages: number[] };
  expect(info.banner).toBeNull();
  expect(info.stages).toEqual([]);

  const panel = await page.request.get(`${LIVE}/api/v1/projects/${project.id}/stages/4`);
  const rows = ((await panel.json()) as { rows: { table_code: string; row: unknown; is_stale: boolean }[] })
    .rows;
  const kept = rows.find((r) => r.table_code === "表5-1");
  expect(kept?.is_stale).toBe(false);
  expect(kept?.row).toMatchObject({ layer: "感知层", components: "CT15" });
});
