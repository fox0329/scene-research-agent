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
 *  ⑤ 交付物这一步例外（变更表 #140 立、#147 改、**#148 定**；#246 起只有一份交付物）：
 *     交付物 chip（解决方案）与本步动作（生成报告 / 编辑 / 导出 Word / PPT / Markdown）画在
 *     **流程轴第二行**——就是别的步显示表名的那一行（`.flow-outputs`，在中栏滚动容器 `.ws`
 *     外面、通栏、滚动时始终可见）；中栏不再有这一行，也没有「交付物」标题行（#147 的那套作废）。
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

/** 给某一步的表种一行，让该步 ready（交付物自动生成用例用） */
function seedStageRow(dbPath: string, scenarioId: string, stage: number, code: string): void {
  const Database = require_("better-sqlite3") as new (path: string) => Db;
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO stage_data
       (id, scenario_id, stage, table_code, row, is_stale, source_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 'AI提取', ?, ?)`,
  ).run(
    `e2e-auto-delivery-${code}-${Date.now()}`,
    scenarioId,
    stage,
    code,
    JSON.stringify({ item: "自动生成验证", content: "占位内容" }),
    now,
    now,
  );
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

  // 第一行：6 个阶段名（还是关键词口径；价值验证阶段已删除，2026-10-20）
  const nodes = page.locator(".flow-nodes .flow-node");
  await expect(nodes).toHaveCount(6);
  await expect(nodes.first()).toHaveText("场景定义");

  // 第二行：这一步的输出物（表名）
  const outputs = page.locator(".flow-outputs .chip");
  await expect(outputs).toHaveCount(5);
  await expect(outputs.filter({ hasText: "需求-能力对照" })).toBeVisible();

  // 中栏不再自己来一行表名（上一版压在表格上面的表头已被用户否掉）
  await expect(page.locator(".ws .table-chips--single")).toHaveCount(0);

  // 点第二行的某一项 → 中栏换成那张表
  await outputs.filter({ hasText: "需求-能力对照" }).click();
  // 表头只留表名（用户定调 2026-10-09：表号不上界面）
  await expect(page.locator(".ws .schema-table-title")).toContainText("需求-能力对照");
  await expect(page.locator(".ws .schema-table-title")).not.toContainText("表4-3");
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

  // 场景锚（表1-1）的面板标题同样只留表名——用户复查时问「表1-1 的表头为什么还在」：
  // `SchemaTable` 当天改了，`AnchorFoldPanel` 漏了（表号仍留在契约里做内部交叉引用，只是不上界面）
  await page.locator(".flow-nodes .flow-node", { hasText: "场景定义" }).click();
  await expect(page.locator(".ws .pnl-h h2").first()).toContainText("场景概述");
  await expect(page.locator(".ws")).not.toContainText("表1-1");

  // 切阶段名 → 第二行换成那一步的输出物（第 5 步：架构与接口 / 实施计划 / 交付与运维）
  await page.locator(".flow-nodes .flow-node", { hasText: "方案实现" }).click();
  await expect(page.locator(".flow-outputs .chip").filter({ hasText: "实施计划" })).toBeVisible();
  await expect(page.locator(".flow-outputs .chip").filter({ hasText: "需求-能力对照" })).toHaveCount(0);
});

test("交付物这一步：一份交付物与动作都在流程轴第二行（中栏不再有这一行）（联真）", async ({ page }) => {
  test.setTimeout(90_000);
  const name = `E2E 交付物输出物 ${Date.now()}`;
  const projectId = await newProject(page, name);
  await completeSteps(page, projectId, 5); // 前 5 步完成 → 当前步 = 第 6 步交付物

  await page.goto(`${LIVE}/`);
  await expect(page.locator(".shell")).toBeVisible();
  await page.locator(".proj-hd", { hasText: name }).click();
  await page.locator(".flow-nodes .flow-node", { hasText: "交付物" }).click();

  // 变更表 #148（用户两次纠正，#147 作废）：第二行**在流程轴里、在中栏滚动容器 `.ws` 外面**
  // （它在 .ws 外面 → 滚正文时这一行始终可见，这正是用户要的"移上去"）
  const row = page.locator(".flow-rail .flow-outputs");
  await expect(row).toBeVisible();
  await expect(page.locator(".ws .flow-outputs")).toHaveCount(0);

  // 变更表 #246：交付物合成《<场景>解决方案》；#341 在它右边加「PPT大纲」
  const chips = row.locator(".chip");
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toHaveText("解决方案");
  await expect(chips.nth(1)).toHaveText("PPT大纲");
  await expect(chips.nth(0)).toHaveClass(/active/);
  await expect(row.locator('.pnl-actions[aria-label="交付物"]')).toHaveCount(1);
  await expect(row.locator(".pnl-actions--end")).toHaveCount(1);

  // chip 靠左、动作靠右，两组**同一行**（不是掉到下一行，也不是挤成一团）
  const chipsGroup = row.locator('[aria-label="交付物"]');
  const actions = row.locator(".pnl-actions--end");
  const rowBox = (await row.boundingBox())!;
  const actionsBox = (await actions.boundingBox())!;
  const chipsBox = (await chipsGroup.boundingBox())!;
  const midY = (b: { y: number; height: number }) => b.y + b.height / 2;
  expect(Math.abs(midY(chipsBox) - midY(actionsBox))).toBeLessThanOrEqual(8);
  // chip 在动作左侧、贴这一行左边；动作贴这一行右边
  expect(actionsBox.x).toBeGreaterThan(chipsBox.x + chipsBox.width);
  expect(chipsBox.x - rowBox.x).toBeLessThanOrEqual(20);
  expect(rowBox.x + rowBox.width - (actionsBox.x + actionsBox.width)).toBeLessThanOrEqual(20);

  // 这一行在「交付物」步骤名那一行（.flow-nodes）的**下面**
  const nodesBox = (await page.locator(".flow-nodes").boundingBox())!;
  expect(nodesBox.y + nodesBox.height).toBeLessThanOrEqual(rowBox.y + 2);

  // 动作同一行：生成报告 / 编辑、导出 Word / PPT / Markdown
  await expect(actions).toContainText("生成报告");
  await expect(actions).toContainText("导出Word文档");
  await expect(actions).toContainText("导出PPT文档");
  await expect(actions).toContainText("导出 Markdown");

  // 中栏**不再**有 chip，也**不再**有「交付物」标题行（#147 的那套撤掉）
  await expect(page.locator(".ws .pnl-h .chip")).toHaveCount(0);
  await expect(page.locator(".ws .pnl-h-row")).toHaveCount(0);
  await expect(page.locator(".ws .pnl-h h2", { hasText: "交付物" })).toHaveCount(0);

  // 变更表 #174：没生成报告时中栏**不预填要点版**，只留「生成报告」入口；
  // 编辑与三个导出都不可点（服务端也会用 400 挡住空导出，见 smoke-regressions）
  await expect(page.locator(".ws .empty-state")).toContainText("还没有生成");
  await expect(actions.getByRole("button", { name: "生成报告" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "编辑" })).toBeDisabled();
  for (const label of ["导出Word文档", "导出PPT文档", "导出 Markdown"]) {
    await expect(actions.getByRole("button", { name: label })).toBeDisabled();
  }
  await expect(page.locator(".ws .md-body")).toHaveCount(0);
  await expect(page.locator(".ws .brief-hint")).toHaveCount(0);

  // 变更表 #148 的核心收益：这一行在中栏滚动容器 `.ws` **外面**（贴着它的上沿），
  // 所以上下滚正文时它始终可见——先把中栏顶到可滚，再滚它，这一行纹丝不动
  const wsBox = (await page.locator(".ws").boundingBox())!;
  expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(wsBox.y + 2);
  await page.locator(".ws").evaluate((el) => {
    // 这段高内容只服务本用例（空态撑不满一屏，撑不满就滚不动）
    const spacer = document.createElement("div");
    spacer.id = "e2e-tall-spacer";
    spacer.setAttribute("aria-hidden", "true");
    spacer.style.height = "1600px";
    el.appendChild(spacer);
  });
  const yBefore = (await row.boundingBox())!.y;
  await page.locator(".ws").evaluate((el) => {
    el.scrollTop = 480;
  });
  await page.waitForTimeout(200);
  await expect(page.locator(".ws").evaluate((el) => el.scrollTop)).resolves.toBeGreaterThan(0);
  const yAfter = (await row.boundingBox())!.y;
  expect(Math.abs(yAfter - yBefore)).toBeLessThanOrEqual(2);
  await expect(chips.first()).toBeVisible();

  // v2：交付物步右栏锚定「解决方案」产物，上区来源/备注，下区唯一会话；全文仍不进界面
  await expect(page.locator(".det .thread-head")).toContainText("解决方案");
  await expect(page.locator(".det .artifact-tabs [role=tab]")).toHaveCount(2);
  await expect(page.locator(".det .thread-pane")).toBeVisible();
  await expect(page.locator(".det .md-body")).toHaveCount(0);
  await expect(page.locator(".det .fold-toggle")).toHaveCount(0);
  await expect(page.locator(".det").locator("table")).toHaveCount(0);

  /*
   * 后半段验证「已生成」态的编辑与导出。e2e 不真跑模型生成（慢且依赖模型），
   * 直接用服务端保存接口写入一份报告——它与「生成报告」落盘的是同一个文件、同一条读取路径。
   */
  const seededBody = [
    `# ${name}解决方案`,
    "",
    "## 现状与问题",
    "",
    "客户现状由 e2e 造数写入，用于验证编辑与导出链路。",
    "",
    "## 目标与思路",
    "",
    "先做内部判断，再决定是否投入。",
    "",
    "## 建设内容",
    "",
    "这段字稍后会被 e2e 改成新版本。",
    "",
  ].join("\n");
  const put = await page.request.put(
    `${LIVE}/api/v1/projects/${projectId}/deliverables/solution`,
    { data: { markdown: seededBody } },
  );
  expect(put.ok()).toBe(true);

  await page.reload();
  await expect(page.locator(".shell")).toBeVisible();
  await page.locator(".proj-hd", { hasText: name }).click();
  await page.locator(".flow-nodes .flow-node", { hasText: "交付物" }).click();
  await expect(page.locator(".ws .md-body")).toContainText("客户现状由 e2e 造数写入");

  const actions2 = page.locator(".flow-rail .flow-outputs .pnl-actions--end");
  await expect(actions2.getByRole("button", { name: "重新生成报告" })).toBeVisible();

  // 变更表 #135：中栏可编辑并保存——改的是当前这一份 → 中栏与磁盘都变
  await actions2.getByRole("button", { name: "编辑" }).click();
  const editor = page.locator(".ws .report-editor");
  await expect(editor).toBeVisible();
  await editor.fill(`# ${name}解决方案\n\n## 建设内容\n\n这段字是 e2e 写进去的。\n`);
  await actions2.getByRole("button", { name: "保存" }).click();
  await expect(page.locator(".toast-item").filter({ hasText: "已保存" }).last()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".ws .md-body")).toContainText("这段字是 e2e 写进去的");

  // 变更表 #133 / #246：「导出Word文档」= 选文件夹 → 按模版写 Word，一份交付物只出一个 docx。
  // 系统对话框在 e2e 里没法点，所以拦掉 pick-folder 请求直接给一个临时目录。
  const dir = mkdtempSync(join(homedir(), ".scene-e2e-docx-"));
  try {
    await page.route("**/deliverables/pick-folder", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dir }) }),
    );
    await actions2.locator("button", { hasText: "导出Word文档" }).click();
    await expect(page.locator(".toast-item").filter({ hasText: "Word 已导出" }).last()).toBeVisible({
      timeout: 30_000,
    });
    const files = readdirSync(dir).filter((f) => f.endsWith(".docx"));
    expect(files.length, files.join(",")).toBe(1);
    expect(files[0]).toContain("解决方案");
    // zip 魔数：真是 docx 而不是空文件
    expect(readFileSync(join(dir, files[0]!)).subarray(0, 2).toString("utf8")).toBe("PK");

    // 变更表 #141：点「导出PPT文档」→ 真发一次导出请求；e2e 拦掉 POST 断言 URL / method / body。
    // （进度走另一条 SSE：`…/export-pptx/events?run=`，拦不到也不影响导出结果。）
    const pptRequests: {
      url: string;
      method: string;
      body: { dir?: string; kind?: string; run?: string };
    }[] = [];
    await page.route("**/deliverables/export-pptx", (route) => {
      const request = route.request();
      pptRequests.push({
        url: request.url(),
        method: request.method(),
        body: request.postDataJSON() as { dir?: string; kind?: string; run?: string },
      });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          files: [join(dir, `${name}解决方案.pptx`)],
          unchanged: [],
        }),
      });
    });
    await actions2.locator("button", { hasText: "导出PPT文档" }).click();
    await expect(page.locator(".toast-item").filter({ hasText: "PPT 已导出" }).last()).toBeVisible({
      timeout: 30_000,
    });
    expect(pptRequests).toHaveLength(1);
    expect(pptRequests[0]!.method).toBe("POST");
    expect(pptRequests[0]!.url).toContain(`/api/v1/projects/${projectId}/deliverables/export-pptx`);
    expect(pptRequests[0]!.body.dir).toBe(dir);
    expect(pptRequests[0]!.body.kind).toBe("solution");
    expect(typeof pptRequests[0]!.body.run).toBe("string"); // 进度通道 token
    expect(pptRequests[0]!.body.run!.startsWith("ppt-")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("从第 5 步点下一步：自动进入交付物并写报告（联真）", async ({ page }) => {
  test.setTimeout(60_000);
  const name = `E2E 自动交付物 ${Date.now()}`;
  const projectId = await newProject(page, name);
  await completeSteps(page, projectId, 4); // 当前步 = 第 5 步（方案与实现）
  seedStageRow(newestDb(), projectId, 4, "表5-1"); // 让第 5 步有产出、出现「下一步」

  await page.addInitScript(() => localStorage.setItem("scene.onboarding.v1.done", "1"));
  await page.goto(`${LIVE}/`);
  await expect(page.locator(".shell")).toBeVisible();
  await page.locator(".proj-hd", { hasText: name }).click();

  const rail = page.locator(".flow-rail");
  await expect(rail.locator(".flow-node--current")).toContainText("方案实现", { timeout: 20_000 });
  const next = rail.getByRole("button", { name: "下一步" });
  await expect(next).toBeEnabled({ timeout: 20_000 });

  // 不点「生成报告」：点「下一步」后应自动进入交付物并发出报告生成请求。
  // 这里把长跑请求中止，只验证"自动发起"这一交互，不消耗真实模型时间。
  await page.route("**/deliverables/generate", (route) => route.abort());
  const autoReport = page.waitForRequest(
    (req) => req.method() === "POST" && /\/deliverables\/generate/.test(req.url()),
    { timeout: 20_000 },
  );
  await next.click();
  await autoReport;
  await expect(rail.locator(".flow-node--current")).toContainText("交付物", { timeout: 20_000 });
});
