import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 中栏信息表 ↔ 右栏「补充说明」的行联动（变更表 #150）· 联真 e2e
 *
 * 用户量到的毛病：能力匹配中栏 29 行、右栏 29 条目，两边严格一一对应却**零联动**——
 * 在中栏看第 17 行，得自己在右栏那条长列表里翻找对应条目，补充说明于是退化成一堆散信息。
 *
 * 本套件锁住四件事（都是"用户看得见"的口径，不是内部状态）：
 *  ① 点中栏第 N 行 → 右栏第 N 个 `.supp-item` 带高亮 class，**且它在右栏可视区内**
 *     （同一行的「核实」条一起亮）；
 *  ② 在右栏第 M 个条目里点字段 → 中栏第 M 行带高亮 class（并在需要时滚进可视）；
 *  ③ 换表后高亮清空——上一张表的当前行不许带到新表上；
 *  ④ 连续点两行不会来回抖——点第 2 行后第 1 行不再高亮，且任何时刻只有一个当前行；
 *  ⑤ 没有对应关系的步骤（第 1 步 / 交付物步）不报错、不产生空高亮。
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
    .map((file) => ({ file: join("/tmp", file), mtime: statSync(join("/tmp", file)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) throw new Error("没找到联真临时库（/tmp/scene-e2e-*.db）");
  return candidates[0]!.file;
}

/**
 * 给第 4 步（能力匹配）种够行数的表
 *
 * 表4-3「需求-能力对照」种 30 行：中栏每一行都有**各不相同**的缺口（右栏条目标签取自它），
 * 于是"第 N 行 ↔ 第 N 个条目"不是靠位置猜的，文本本身就能对上；
 * 表4-1「能力底账」种 10 行，用于"换表后清空"那一测。
 */
function seedStage(dbPath: string, scenarioId: string): void {
  const Database = require_("better-sqlite3") as new (path: string) => Db;
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO stage_data
       (id, scenario_id, stage, table_code, row, is_stale, source_type, created_at, updated_at)
     VALUES (?, ?, 3, ?, ?, 0, 'AI提取', ?, ?)`,
  );
  const at = Date.now();
  for (let i = 0; i < 30; i++) {
    const n = i + 1;
    stmt.run(
      `e2e-link-表4-3-${i}-${at}`,
      scenarioId,
      "表4-3",
      JSON.stringify({
        gap_ref: `缺口 ${n}`,
        match: "支撑",
        our_product: `我方产品 ${n}`,
        ability_basis: `能力 ${n}`,
        boundary_note: `边界说明 ${n}`,
        risk: `风险 ${n}`,
        source: `来源 ${n}`,
      }),
      now,
      now,
    );
  }
  for (let i = 0; i < 10; i++) {
    const n = i + 1;
    stmt.run(
      `e2e-link-表4-1-${i}-${at}`,
      scenarioId,
      "表4-1",
      JSON.stringify({
        ability: `能力项 ${n}`,
        maturity: "已交付",
        limitation: `限制 ${n}`,
        no: `M3-${n}`,
        proof: `证明材料 ${n}`,
        source: `来源 ${n}`,
      }),
      now,
      now,
    );
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

/** 开一个联真项目 + 种数据 + 打开「能力匹配」并切到「需求-能力对照」 */
async function openLinkFixture(page: import("@playwright/test").Page): Promise<string> {
  const name = `E2E 行联动 ${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const created = await page.request.post(`${LIVE}/api/v1/projects`, { data: { name } });
  expect(created.ok()).toBe(true);
  const projectId = ((await created.json()) as { id: string }).id;
  await completeSteps(page, projectId, 5);
  seedStage(newestDb(), projectId);

  await page.goto(`${LIVE}/`);
  await expect(page.locator(".shell")).toBeVisible();
  await page.locator(".proj-hd", { hasText: name }).click();
  await page.locator(".flow-nodes .flow-node", { hasText: "能力匹配" }).click();

  // 切到表4-3：中栏 30 行，右栏 30 个条目，两边按同一个 rowId 对上
  await page.locator(".flow-outputs .chip", { hasText: "需求-能力对照" }).click();
  await expect(page.locator(".ws .schema-table-title")).toContainText("表4-3");
  await expect(page.locator(".ws .tw tbody tr")).toHaveCount(30);
  await expect(page.locator(".det-body .supp-item")).toHaveCount(30);
  return projectId;
}

/** 元素是否落在滚动容器的可视框内（±2px：滚动停靠会有亚像素取整） */
async function boxInside(
  page: import("@playwright/test").Page,
  inner: string,
  outer: string,
): Promise<boolean> {
  const a = await page.locator(inner).boundingBox();
  const b = await page.locator(outer).boundingBox();
  if (!a || !b) return false;
  return a.y >= b.y - 2 && a.y + a.height <= b.y + b.height + 2;
}

/**
 * 设计 Token 的 hex 值 → 浏览器计算出来的 `rgb(r, g, b)`
 *
 * 高亮必须走 Token（不许硬编码颜色），所以断言"算出来的颜色就是 Token 的颜色"，
 * 而不是把色值再抄一遍到测试里。
 */
async function tokenRgb(page: import("@playwright/test").Page, name: string): Promise<string> {
  const hex = await page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Token ${name} 不是 6 位 hex：${hex}`);
  const v = Number.parseInt(m[1]!, 16);
  return `rgb(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255})`;
}

test("行联动①：点中栏第 N 行 → 右栏第 N 个条目高亮并滚进可视（联真）", async ({ page }) => {
  await openLinkFixture(page);

  const midRows = page.locator(".ws .tw tbody tr");
  const suppItems = page.locator(".det-body .supp-item");
  const verifyItems = page.locator(".det-body .verify-item");

  // 点中栏第 17 行（第 17 行 = 索引 16）
  await midRows.nth(16).click();

  // 中栏这一行是当前行
  await expect(midRows.nth(16)).toHaveClass(/\bsel\b/);
  await expect(page.locator(".ws .tw tbody tr.sel")).toHaveCount(1);

  // 右栏**第 17 个**条目带高亮 class，且内容就是第 17 行的缺口（不是靠位置蒙的）
  await expect(suppItems).toHaveCount(30);
  await expect(suppItems.nth(16)).toHaveClass(/supp-item--active/);
  await expect(suppItems.nth(16)).toContainText("缺口 17");
  await expect(page.locator(".det-body .supp-item--active")).toHaveCount(1);

  // 同一行的「核实」条一起亮
  await expect(verifyItems.nth(16)).toHaveClass(/verify-item--active/);
  await expect(page.locator(".det-body .verify-item--active")).toHaveCount(1);

  // 它真的在右栏可视区内（rolled into view，而不是"高亮了但还在屏幕外"）
  expect(await boxInside(page, ".det-body .supp-item--active", ".det-body")).toBe(true);

  // 高亮是**看得见**的，且颜色来自 Token：条目底色 = --cp-s，左槽强调条 = --cp
  const cpS = await tokenRgb(page, "--cp-s");
  const cp = await tokenRgb(page, "--cp");
  const styles = await suppItems.nth(16).evaluate((el) => {
    const bar = getComputedStyle(el, "::before");
    return {
      bg: getComputedStyle(el).backgroundColor,
      barWidth: bar.width,
      barBg: bar.backgroundColor,
    };
  });
  expect(styles.bg).toBe(cpS);
  expect(styles.barWidth).not.toBe("0px");
  expect(styles.barBg).toBe(cp);
  // 中栏那一行的首格也有一条同色强调条（行底色 + 强调条双保险，不是只靠浅底色）
  const tdShadow = await midRows.nth(16).locator("td").first().evaluate(
    (el) => getComputedStyle(el).boxShadow,
  );
  expect(tdShadow).toContain(cp);

  await page.screenshot({ path: "/tmp/link-150-a.png" });

  // 键盘可达：焦点移进另一行的单元格（等价于 Tab 进来，不点鼠标）同样触发联动
  await midRows.nth(20).locator("textarea, [contenteditable]").first().focus();
  await expect(midRows.nth(20)).toHaveClass(/\bsel\b/);
  await expect(page.locator(".ws .tw tbody tr.sel")).toHaveCount(1);
  await expect(suppItems.nth(20)).toHaveClass(/supp-item--active/);
  await expect(midRows.nth(16)).not.toHaveClass(/\bsel\b/);
});

test("行联动②③④⑤：右栏点字段 → 中栏对应行；换表清空；连点不抖；无关步骤不联动（联真）", async ({
  page,
}) => {
  await openLinkFixture(page);

  const midRows = page.locator(".ws .tw tbody tr");
  const suppItems = page.locator(".det-body .supp-item");

  /* ② 右栏 → 中栏：点第 5 个条目里的值编辑器 → 中栏第 5 行成为当前行 */
  await suppItems.nth(4).locator(".supp-value").first().click();
  await expect(page.locator(".ws .tw tbody tr.sel")).toHaveCount(1);
  await expect(midRows.nth(4)).toHaveClass(/\bsel\b/);
  await expect(midRows.nth(4)).toContainText("缺口 5");
  // 中栏这一行也在可视区内（右栏发起的联动由中栏来滚）
  expect(await boxInside(page, ".ws .tw tbody tr.sel", ".ws")).toBe(true);
  await page.screenshot({ path: "/tmp/link-150-b.png" });

  /* ④ 连点两行不来回抖：点第 2 行，第 1 行就不再高亮；任何时刻只有一个当前行 */
  await midRows.nth(0).click();
  await expect(midRows.nth(0)).toHaveClass(/\bsel\b/);
  await midRows.nth(2).click();
  await expect(midRows.nth(2)).toHaveClass(/\bsel\b/);
  await expect(midRows.nth(0)).not.toHaveClass(/\bsel\b/);
  await expect(page.locator(".ws .tw tbody tr.sel")).toHaveCount(1);
  // 右栏跟着切到第 3 条，且只有那一条亮
  await expect(suppItems.nth(2)).toHaveClass(/supp-item--active/);
  await expect(page.locator(".det-body .supp-item--active")).toHaveCount(1);

  /* ③ 换表：高亮清空，上一张表的当前行不带过来 */
  await page.locator(".flow-outputs .chip", { hasText: "能力底账" }).click();
  await expect(page.locator(".ws .schema-table-title")).toContainText("表4-1");
  await expect(page.locator(".ws .tw tbody tr")).toHaveCount(10);
  await expect(page.locator(".ws .tw tbody tr.sel")).toHaveCount(0);
  await expect(page.locator(".det-body .supp-item")).toHaveCount(10);
  await expect(page.locator(".det-body .supp-item--active")).toHaveCount(0);
  await expect(page.locator(".det-body .verify-item--active")).toHaveCount(0);

  /* ⑤ 没有对应关系的步骤：第 1 步没有补充说明 → 不报错、不产生空高亮 */
  await page.locator(".flow-nodes .flow-node", { hasText: "场景定义" }).click();
  await expect(page.locator(".det-body .supp-item")).toHaveCount(0);
  await expect(page.locator(".det-body .supp-item--active")).toHaveCount(0);
  await expect(page.locator(".det-tabs .det-tab")).toHaveCount(1);
  await expect(page.locator(".det-tabs .det-tab").first()).toHaveText("阶段总结");
});

/**
 * 演示态（`vite preview` 无后端 → live=false）走到第 4 步「能力匹配」
 *
 * 演示与联真**同结构**：同一个 `StageSnapshot` 形态、同一套 class。所以联动不是只在联真生效的
 * 旁路——中栏点行、右栏点字段，两边同样按同一个 rowId 高亮。
 */
async function openDemoLinkFixture(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".shell")).toBeVisible();
  await page.locator(".side .proj-hd").first().click();

  const rail = page.locator(".flow-rail");
  // 第 1 步未产出时主按钮位是「开始本步分析」：先让智能体写出画像，才有「下一步」
  if ((await rail.getByRole("button", { name: "下一步" }).count()) === 0) {
    await page.locator(".flow-actions").getByRole("button", { name: /开始本步分析|重算本步/ }).click();
    const dlg = page.getByRole("dialog", { name: "场景定义" });
    await expect(dlg).toBeVisible();
    await dlg.getByRole("button", { name: "整理成定义" }).click();
    await expect(dlg.locator(".definition-summary")).toContainText("更新");
    await dlg.getByRole("button", { name: "完成，回到第 1 步" }).click();
    await expect(dlg).toBeHidden();
  }
  for (let i = 0; i < 3; i++) {
    const next = rail.getByRole("button", { name: "下一步" });
    await expect(next).toBeEnabled();
    await next.click();
  }
  await page.locator(".flow-nodes .flow-node", { hasText: "能力匹配" }).click();
  // 表4-2「我方参与地图」：演示数据 3 行（制水 / 输配 / 原水取水），右栏 3 个条目
  await page.locator(".flow-outputs .chip", { hasText: "我方参与地图" }).click();
  await expect(page.locator(".det-body .supp-item")).toHaveCount(3);
}

test("行联动（演示态）：中栏点行与右栏点字段同样双向高亮（vite preview 无后端）", async ({
  page,
}) => {
  await openDemoLinkFixture(page);

  const midRows = page.locator(".ws .tw tbody tr");
  const suppItems = page.locator(".det-body .supp-item");
  await expect(midRows).toHaveCount(3);

  // 中栏 → 右栏：点第 2 行（输配）→ 右栏第 2 个条目高亮
  await midRows.nth(1).click();
  await expect(midRows.nth(1)).toHaveClass(/\bsel\b/);
  await expect(suppItems.nth(1)).toHaveClass(/supp-item--active/);
  await expect(suppItems.nth(1)).toContainText("输配");
  await expect(page.locator(".det-body .supp-item--active")).toHaveCount(1);

  // 右栏 → 中栏：点第 3 个条目里的值编辑器 → 中栏第 3 行（原水取水）高亮
  await suppItems.nth(2).locator(".supp-value").first().click();
  await expect(midRows.nth(2)).toHaveClass(/\bsel\b/);
  await expect(midRows.nth(2)).toContainText("原水取水");
  await expect(page.locator(".ws .tw tbody tr.sel")).toHaveCount(1);

  // 换表清空（与联真同一条口径）
  await page.locator(".flow-outputs .chip", { hasText: "能力底账" }).click();
  await expect(page.locator(".ws .tw tbody tr.sel")).toHaveCount(0);
  await expect(page.locator(".det-body .supp-item--active")).toHaveCount(0);
});
