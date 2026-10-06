import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 流程轴两行（阶段名 + 本步输出物）· 联真 e2e（变更表 #111）
 *
 * 用户定调（2026-10-06）：
 *  「将每个阶段对应的表格行移到阶段名称下面，两行显示，这样用户上下移动表格内容，
 *   表格的名称能始终显示。」「直接将阶段的内容列表，放到上面场景定义、认识场景、
 *   理解商业等几个阶段名称下面就行，用户点击某个阶段下面一行就显示该阶段的几个输出物。」
 *
 * 本套件锁住四件事：
 *  ① 第一行仍是 7 个阶段名，第二行是**当前正在看的那一步**的输出物；
 *  ② 点第二行的某一项 → 中栏真的换成它（表 → 那张表的表格；交付物 → 那份报告）；
 *  ③ 第二行在中栏滚动容器 `.ws` 外面 → 上下滚表格时它始终可见（用户要解决的正是这个）；
 *  ④ 中栏不再自己再来一行表名（上一版曾在表格上面压一层粘性表头，用户否掉了）。
 */

const LIVE = "http://127.0.0.1:46175";
const ROOT = process.cwd();
const require_ = createRequire(join(ROOT, "packages", "infra", "package.json"));

type Db = {
  prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
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

/** 给第 4 步的表种够多的行，把中栏撑到可滚动（不然断言不到"滚动时仍可见"） */
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

/** 把前 n 步标完成（不跑模型，纯造状态） */
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

test("流程轴：阶段名一行 + 本步输出物一行，点第二行换中栏内容（联真）", async ({ page }) => {
  const name = `E2E 流程轴两行 ${Date.now()}`;
  const projectId = await newProject(page, name);
  await completeSteps(page, projectId, 5); // 走到第 6 步：往前看第 4 步、往后看第 6 步都能点
  seedTallStage(newestDb(), projectId);

  await page.goto(`${LIVE}/`);
  await expect(page.locator(".shell")).toBeVisible();
  await page.locator(".proj-hd", { hasText: name }).click();
  await page.locator(".flow-nodes .flow-node", { hasText: "能力匹配" }).click();

  // 第一行：7 个阶段名（还是关键词口径）
  const nodes = page.locator(".flow-nodes .flow-node");
  await expect(nodes).toHaveCount(7);
  await expect(nodes.first()).toHaveText("场景定义");

  // 第二行：这一步的输出物（表名）
  const outputs = page.locator(".flow-outputs .chip");
  await expect(outputs).toHaveCount(5);
  await expect(outputs.filter({ hasText: "需求-能力对照" })).toBeVisible();

  // 中栏不再自己来一行表名（上一版压在表格上面的表头已被用户否掉）
  await expect(page.locator(".ws .table-chips--single")).toHaveCount(0);

  // 点第二行的某一项 → 中栏换成那张表
  await outputs.filter({ hasText: "需求-能力对照" }).click();
  await expect(page.locator(".ws .schema-table-title")).toContainText("表4-3");
  await expect(outputs.filter({ hasText: "需求-能力对照" })).toHaveClass(/active/);

  // 上下滚表格内容 → 第二行仍钉在视口里（这正是用户要解决的问题）
  const yBefore = (await page.locator(".flow-outputs").boundingBox())!.y;
  await page.locator(".ws").evaluate((el) => {
    el.scrollTop = 480;
  });
  await page.waitForTimeout(200);
  const yAfter = (await page.locator(".flow-outputs").boundingBox())!.y;
  expect(Math.abs(yAfter - yBefore)).toBeLessThanOrEqual(2);
  await expect(outputs.filter({ hasText: "需求-能力对照" })).toBeInViewport();
  await expect(page.locator(".ws").evaluate((el) => el.scrollTop)).resolves.toBeGreaterThan(0);

  // 切阶段名 → 第二行换成那一步的输出物（第 6 步：价值与指标 / 试点与验收）
  await page.locator(".flow-nodes .flow-node", { hasText: "价值验证" }).click();
  await expect(page.locator(".flow-outputs .chip").filter({ hasText: "试点与验收" })).toBeVisible();
  await expect(page.locator(".flow-outputs .chip").filter({ hasText: "需求-能力对照" })).toHaveCount(0);
});

test("交付物这一步：第二行是两份报告，点哪份中栏显示哪份（联真）", async ({ page }) => {
  const name = `E2E 交付物输出物 ${Date.now()}`;
  const projectId = await newProject(page, name);
  await completeSteps(page, projectId, 7);

  await page.goto(`${LIVE}/`);
  await expect(page.locator(".shell")).toBeVisible();
  await page.locator(".proj-hd", { hasText: name }).click();
  await page.locator(".flow-nodes .flow-node", { hasText: "交付物" }).click();

  // 第二行＝交付物这一步的输出物：两份报告（不是表）
  const outputs = page.locator(".flow-outputs .chip");
  await expect(outputs).toHaveCount(2);
  await expect(outputs.nth(0)).toHaveText("内部调研版");
  await expect(outputs.nth(1)).toHaveText("对外汇报版");

  // 中栏没有检查清单，直接是报告正文
  await expect(page.locator(".ws .delivery-steps")).toHaveCount(0);
  // 还没跑模型 → 正文上方说清「当前是要点版」，并给出生成入口（v1.32）
  await expect(page.locator(".ws .brief-hint")).toContainText("要点版");
  await expect(page.locator(".ws .pnl-actions")).toContainText("生成报告");
  // v1.32：交付物正文是「报告」（模型撰写的六章总结 / 未生成时是要点版）
  await expect(page.locator(".ws .md-body")).toContainText("场景调研报告");
  await expect(page.locator(".ws .md-body")).toContainText("来源索引");

  // 点第二行的「对外汇报版」→ 同一位置换成另一份口径（对外版不装附录）
  await outputs.filter({ hasText: "对外汇报版" }).click();
  // v1.32：对外材料标题是「<场景名> 解决方案」（报告口径，不是"记录"）
  await expect(page.locator(".ws .md-body")).toContainText("解决方案");
  await expect(page.locator(".ws .md-body")).not.toContainText("来源索引");
  await expect(outputs.filter({ hasText: "对外汇报版" })).toHaveClass(/active/);

  // 装配原料清单按 G-R9 归右栏「阶段总结」
  await page.locator(".det-tabs .det-tab", { hasText: "阶段总结" }).click();
  await expect(page.locator(".det-body")).toContainText("装配原料");
});
