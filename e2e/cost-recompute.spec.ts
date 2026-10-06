import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 表5-5 成本重算 · 联真 e2e（变更表 #103）
 *
 * 为什么放在这里：预览态（46174）是演示数据，没有真后端，造不出"表5-3 有实施计划、
 * M6 有费率、表5-5 的金额却是模型拍的"这种真数据；本套件直连 46175 的真服务，并且
 * **直接往它的临时库种数**——表5-3/表5-5 是阶段产出，没有写接口（只能由分析生成）。
 *
 * 覆盖：M6 费率是权威单价 → 点右栏「按 M6 费率重算成本」→ 表5-5 金额按公式改写、
 * 出处改成"系统计算"、缺单价的项不按 0 元算而是如实报出。
 */

const LIVE = "http://127.0.0.1:46175";
const ROOT = process.cwd();
const require_ = createRequire(join(ROOT, "packages", "infra", "package.json"));

interface Project {
  id: string;
  product_line_id: string;
}

/** 联真服务的临时库：playwright.config 以 `/tmp/scene-e2e-<时间戳>.db` 启动 → 取最新一个 */
function newestDb(): string {
  const dir = "/tmp";
  const candidates = readdirSync(dir)
    .filter((f) => /^scene-e2e-\d+\.db$/.test(f))
    .map((f) => ({ file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) throw new Error("没找到联真临时库（/tmp/scene-e2e-*.db）");
  return candidates[0]!.file;
}

/**
 * 种数：M6 一条实施费率（现场勘察与点位清点 1000 元/人天）、表5-3 一条实施计划（2 人天）、
 * 表5-5 一条人工行（工时 16 小时、单价 1500、费用 3000 —— 故意与 M6 不一致）。
 *
 * 期望重算后：费用 = 2 人天 × 1000 = 2000（人天取表5-3、单价取 M6，行内单价不再作数）。
 * 另加一条 M6 认不出的运营行（物联平台年费），期望报「缺可用单价」且金额不变（不当 0 元）。
 */
function seedCostData(dbPath: string, project: Project): void {
  const Database = require_("better-sqlite3") as new (path: string) => {
    prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
    close: () => void;
  };
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  const put = (
    table: string,
    id: string,
    columns: string[],
    values: unknown[],
  ): void => {
    db.prepare(
      `INSERT INTO ${table} (id, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")})`,
    ).run(id, ...values);
  };

  put(
    "cost_rate",
    `e2e-rate-${Date.now()}`,
    ["product_line_id", "category", "item", "rate", "unit", "standard_hours", "data_source", "created_at", "updated_at"],
    [project.product_line_id, "实施", "现场勘察与点位清点", 1000, "元/人天", 8, "内部报价", now, now],
  );
  put(
    "stage_data",
    `e2e-plan-${Date.now()}`,
    ["scenario_id", "stage", "table_code", "row", "is_stale", "created_at", "updated_at"],
    [
      project.id,
      4,
      "表5-3",
      JSON.stringify({ item: "现场勘察与点位清点", content: "现场勘察", window: "第1周", man_days: 2, owner: "实施" }),
      0,
      now,
      now,
    ],
  );
  put(
    "stage_data",
    `e2e-labor-${Date.now()}`,
    ["scenario_id", "stage", "table_code", "row", "is_stale", "created_at", "updated_at"],
    [
      project.id,
      4,
      "表5-5",
      JSON.stringify({ item: "现场勘察与点位清点", hours: 16, day_rate: 1500, cost: 3000, note: "人工" }),
      0,
      now,
      now,
    ],
  );
  put(
    "stage_data",
    `e2e-ops-${Date.now()}`,
    ["scenario_id", "stage", "table_code", "row", "is_stale", "created_at", "updated_at"],
    [
      project.id,
      4,
      "表5-5",
      JSON.stringify({ item: "物联平台年费（M6 没有这一项）", annual_fee: 5000, note: "运营" }),
      0,
      now,
      now,
    ],
  );
  // 停在阶段 4（第 5 步「方案与实现」），流程轴上这一步才可点
  db.prepare("UPDATE scenario SET current_stage = 4 WHERE id = ?").run(project.id);
  db.close();
}

/**
 * 种投资回报数据：表5-5 一行总投入（178,650）、表6-1 两条能算钱的收益 + 一条算不出钱的。
 *
 * 期望：回收期 = 178650 ÷ 200000 = 0.89 年 → 显示 0.9 年；投资回报率 1.12 倍/年；
 * 并如实提示还有 1 条没填年收益（不当 0 算）。
 */
function seedRoiData(dbPath: string, project: Project): void {
  const Database = require_("better-sqlite3") as new (path: string) => {
    prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
    close: () => void;
  };
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  const put = (id: string, stage: number, tableCode: string, row: Record<string, unknown>): void => {
    db.prepare(
      "INSERT INTO stage_data (id, scenario_id, stage, table_code, row, is_stale, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
    ).run(id, project.id, stage, tableCode, JSON.stringify(row), now, now);
  };

  put(`e2e-roi-cost-${Date.now()}`, 4, "表5-5", { item: "项目总投入（含首年运营）", amount: 178650 });
  put(`e2e-roi-v1-${Date.now()}`, 5, "表6-1", {
    benefit: "巡检人力节省",
    metric: "巡检工时",
    annual_value: 120000,
    baseline: "现在每月 120 工时",
    expected: "降到 40 工时",
    user_feeling: "不用天天爬梯子",
  });
  put(`e2e-roi-v2-${Date.now()}`, 5, "表6-1", {
    benefit: "故障停机减少",
    metric: "年停机时长",
    annual_value: 80000,
    baseline: "年停机 20 小时",
    expected: "降到 4 小时",
    user_feeling: "少挨投诉",
  });
  put(`e2e-roi-v3-${Date.now()}`, 5, "表6-1", {
    benefit: "品牌提升",
    metric: "客户认知度",
    baseline: "未提供",
    expected: "行业标杆案例",
    user_feeling: "拿得出手",
  });
  db.close();
}

test("投资回报卡片：回收期 = 投入 ÷ 年收益，改年收益立刻重算（变更表 #104）", async ({ page }) => {
  const res = await page.request.post(`${LIVE}/api/v1/projects`, {
    data: { name: `E2E投资回报-${Date.now()}` },
  });
  const project = (await res.json()) as Project;
  for (const step of [1, 2, 3, 4, 5]) {
    const done = await page.request.post(`${LIVE}/api/v1/projects/${project.id}/flow/steps/${step}/complete`);
    expect(done.ok()).toBe(true);
  }
  seedRoiData(newestDb(), project);

  await page.goto(LIVE);
  await expect(page.locator(".shell")).toBeVisible();
  await page.getByText(project.name, { exact: false }).first().click();
  await page.locator('button[aria-label^="第 6 步"]').first().click();

  const card = page.locator(".det-section", { hasText: "投资回报" }).first();
  await expect(card).toContainText("总投入 178,650 元");
  await expect(card).toContainText("年收益 200,000 元/年");
  await expect(card).toContainText("回收期 0.9 年");
  await expect(card).toContainText("1.12 倍/年");
  await expect(card).toContainText("还有 1 条没填年收益");

  /* 改年收益（表6-1 中栏第 3 列）→ 回收期与回报率立刻跟着变，不用刷新 */
  const cell = page
    .locator(".pnl .tw")
    .first()
    .locator("tbody tr", { hasText: "巡检人力节省" })
    .locator("td")
    .nth(2);
  await cell.click();
  await cell.evaluate((el) => {
    el.textContent = "320000";
  });
  await cell.blur();
  /* 320000 + 80000 = 400000 → 178650 ÷ 400000 = 0.45 年；400000 ÷ 178650 = 2.24 倍/年 */
  await expect(card).toContainText("年收益 400,000 元/年");
  await expect(card).toContainText("回收期 0.4 年");
  await expect(card).toContainText("2.24 倍/年");
});

test("表5-5 按 M6 费率重算：金额按公式改写、出处标系统计算、缺单价如实报（变更表 #103）", async ({
  page,
}) => {
  const res = await page.request.post(`${LIVE}/api/v1/projects`, {
    data: { name: `E2E成本重算-${Date.now()}` },
  });
  expect(res.ok()).toBe(true);
  const project = (await res.json()) as Project;
  /* 先把前 4 步走完（解锁第 5 步），再种阶段产出——表5-3/表5-5 没有写接口，只能直接入库 */
  for (const step of [1, 2, 3, 4]) {
    const done = await page.request.post(`${LIVE}/api/v1/projects/${project.id}/flow/steps/${step}/complete`);
    expect(done.ok()).toBe(true);
  }
  seedCostData(newestDb(), project);

  await page.goto(LIVE);
  await expect(page.locator(".shell")).toBeVisible();
  await page.getByText(project.name, { exact: false }).first().click();
  await page.locator('button[aria-label^="第 5 步"]').first().click();

  /* 表5-5 的人工块 */
  await page.getByRole("button", { name: /人工成本/ }).first().click();
  const table = page.locator(".pnl .tw").first();
  const row = table.locator("tbody tr", { hasText: "现场勘察与点位清点" }).first();
  await expect(row).toBeVisible();
  await expect(row.locator("td").nth(3)).toHaveText("3000"); // 重算前：模型拍的行内单价算出来的 3000

  /* 右栏动作（中栏只放信息、不放动作） */
  const button = page.getByRole("button", { name: "按 M6 费率重算成本" });
  await expect(button).toBeVisible();
  await button.click();

  /* 金额按 表5-3 人天(2) × M6 单价(1000) 改写 */
  await expect(row.locator("td").nth(3)).toHaveText("2000");
  const note = page.locator(".det-section .schema-table-note").first();
  await expect(note).toContainText("改了 1 行");
  await expect(note).toContainText("合计 7000 元"); // 人工 2000 + 运营 5000（缺单价，沿用原值不按 0 算）
  await expect(note).toContainText("缺可用单价");
  await expect(note).toContainText("物联平台年费（M6 没有这一项）");

  /* 出处（右栏溯源）说明算法与两个来源 */
  const laborSource = await page.request.get(
    `${LIVE}/api/v1/projects/${project.id}/stages/4`,
  );
  const panel = (await laborSource.json()) as {
    rows: { table_code: string; row: Record<string, unknown> }[];
  };
  const labor = panel.rows.find(
    (r) => r.table_code === "表5-5" && r.row["item"] === "现场勘察与点位清点",
  );
  expect(String(labor?.row["source"])).toContain("系统计算");
  expect(String(labor?.row["source"])).toContain("表5-3 人天(2)");
  expect(String(labor?.row["source"])).toContain("M6「现场勘察与点位清点」单价(1000 元/人天)");
});
