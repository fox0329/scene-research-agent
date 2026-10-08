import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 流程轴两行（阶段名 + 本步输出物）· 联真 e2e（变更表 #111）
 *
 * 用户定调（2026-10-06）：
 *  「将每个阶段对应的表格行移到阶段名称下面，两行显示，这样用户上下移动表格内容，
 *   表格的名称能始终显示。」「直接将阶段的内容列表，放到上面场景定义、认识场景、
 *   理解商业等几个阶段名称下面就行，用户点击某个阶段下面一行就显示该阶段的几个输出物。」
 *
 * 本套件锁住五件事：
 *  ① 第一行仍是 7 个阶段名，第二行是**当前正在看的那一步**的输出物；
 *  ② 点第二行的某一项 → 中栏真的换成它（表 → 那张表的表格）；
 *  ③ 第二行在中栏滚动容器 `.ws` 外面 → 上下滚表格时它始终可见（用户要解决的正是这个）；
 *  ④ 中栏不再自己再来一行表名（上一版曾在表格上面压一层粘性表头，用户否掉了）；
 *  ⑤ 交付物这一步例外（变更表 #140）：两份交付物（解决方案 / 建设工作方案）的切换入口
 *     在**中栏顶部**与动作同一行、靠右，流程轴第二行在这一步不再画这两个 chip。
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

test("交付物这一步：两份交付物在中栏顶部切换，流程轴第二行不再画它们（联真）", async ({ page }) => {
  const name = `E2E 交付物输出物 ${Date.now()}`;
  const projectId = await newProject(page, name);
  await completeSteps(page, projectId, 7);

  await page.goto(`${LIVE}/`);
  await expect(page.locator(".shell")).toBeVisible();
  await page.locator(".proj-hd", { hasText: name }).click();
  await page.locator(".flow-nodes .flow-node", { hasText: "交付物" }).click();

  // 变更表 #140：两份交付物的 chip 移到**中栏顶部**（原来挂在流程轴第二行，变更表 #137）
  const chips = page.locator(".ws .pnl-h .chip");
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toHaveText("解决方案");
  await expect(chips.nth(1)).toHaveText("建设工作方案");
  await expect(chips.filter({ hasText: "解决方案" })).toHaveClass(/active/);

  // 与左侧动作**同一行**、贴右（不是掉到下一行，也不是挤在按钮中间）
  const actions = page.locator(".ws .pnl-actions").first();
  const headBox = (await page.locator(".ws .pnl-h").boundingBox())!;
  const actionsBox = (await actions.boundingBox())!;
  const chipsBox = (await page.locator(".ws .pnl-actions--end").boundingBox())!;
  const midY = (b: { y: number; height: number }) => b.y + b.height / 2;
  expect(Math.abs(midY(chipsBox) - midY(actionsBox))).toBeLessThanOrEqual(8);
  expect(chipsBox.x).toBeGreaterThan(actionsBox.x + actionsBox.width);
  expect(headBox.x + headBox.width - (chipsBox.x + chipsBox.width)).toBeLessThanOrEqual(20);

  // 动作同一行：改名后的导出 Word、只是入口的导出 PPT、以及保留的导出 Markdown
  await expect(actions).toContainText("生成报告");
  await expect(actions).toContainText("导出Word文档");
  await expect(actions).toContainText("导出PPT文档");
  await expect(actions).toContainText("导出 Markdown");

  // 默认看「解决方案」：中栏是它的正文
  await expect(page.locator(".ws .delivery-steps")).toHaveCount(0);
  // 还没跑模型 → 正文上方说清「当前是要点版」，并给出生成入口（v1.32）
  await expect(page.locator(".ws .brief-hint")).toContainText("要点版");
  await expect(actions).toContainText("生成报告");
  // 变更表 #136：解决方案正文是「<场景名>解决方案」，五章、章标题不带手写序号
  await expect(page.locator(".ws .md-body")).toContainText("解决方案");
  for (const h of ["现状", "场景与问题", "方案", "价值", "下一步"]) {
    await expect(page.locator(".ws .md-body")).toContainText(h);
  }
  await expect(page.locator(".ws .md-body")).not.toContainText("主要风险点");
  await expect(page.locator(".ws .md-body")).not.toContainText("附录");

  // 变更表 #137：点「建设工作方案」→ 中栏正文换成那一份（construction 章名出现，solution 章名消失）
  await chips.filter({ hasText: "建设工作方案" }).click();
  await expect(chips.filter({ hasText: "建设工作方案" })).toHaveClass(/active/);
  await expect(chips.filter({ hasText: "解决方案" })).not.toHaveClass(/active/);
  await expect(page.locator(".ws .md-body")).toContainText("建设背景与必要性");
  await expect(page.locator(".ws .md-body")).toContainText("建设内容");
  await expect(page.locator(".ws .md-body")).not.toContainText("场景与问题");

  // 变更表 #140：流程轴第二行在这一步**不再画**这两个 chip（切换入口只在中栏顶部一处）
  await expect(page.locator(".flow-outputs")).toHaveCount(0);
  await expect(page.locator(".flow-outputs .chip")).toHaveCount(0);

  // 导出 PPT 只是入口（用户定调「先加个入口」）：点一下给提示，不做真实导出
  await actions.locator("button", { hasText: "导出PPT文档" }).click();
  await expect(page.locator(".toast-item").filter({ hasText: "PPT 导出开发中" }).last()).toBeVisible();

  // 装配原料清单按 G-R9 归右栏「阶段总结」
  await page.locator(".det-tabs .det-tab", { hasText: "阶段总结" }).click();
  await expect(page.locator(".det-body")).toContainText("装配原料");

  // 变更表 #135：中栏可编辑并保存——改的是**当前这一份**（建设工作方案）→ 中栏与磁盘都变
  await actions.locator("button", { hasText: "编辑" }).click();
  const editor = page.locator(".ws .report-editor");
  await expect(editor).toBeVisible();
  await editor.fill("# E2E 改过的建设工作方案\n\n## 建设内容\n\n这段字是 e2e 写进去的。\n");
  await actions.locator("button", { hasText: "保存" }).click();
  await expect(page.locator(".toast-item").filter({ hasText: "已保存" }).last()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".ws .md-body")).toContainText("这段字是 e2e 写进去的");

  // 变更表 #133：「导出Word文档」= 选文件夹 → 按模版写 Word（#137：一次两份）。
  // 系统对话框在 e2e 里没法点，所以拦掉 pick-folder 请求直接给一个临时目录。
  const dir = mkdtempSync(join(homedir(), ".scene-e2e-docx-"));
  try {
    await page.route("**/deliverables/pick-folder", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dir }) }),
    );
    await actions.locator("button", { hasText: "导出Word文档" }).click();
    await expect(page.locator(".toast-item").filter({ hasText: "Word 已导出" }).last()).toBeVisible({
      timeout: 30_000,
    });
    const files = readdirSync(dir).filter((f) => f.endsWith(".docx"));
    expect(files.length, files.join(",")).toBe(2);
    expect(files.some((f) => f.includes("解决方案")), files.join(",")).toBe(true);
    expect(files.some((f) => f.includes("建设工作方案")), files.join(",")).toBe(true);
    for (const f of files) {
      // zip 魔数：真是 docx 而不是空文件
      expect(readFileSync(join(dir, f)).subarray(0, 2).toString("utf8")).toBe("PK");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
