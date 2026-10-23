import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 上传入库联真 e2e（第二个 webServer：127.0.0.1:46175，真应用服务 + 真模型链路）
 *
 * 覆盖：
 * 1. 回归——浏览器 FormData 字段顺序（file 部件在前）也能入库
 *    （@fastify/multipart file() 收不到 file 之后的字段，曾致「缺少 product_line_id」400）
 * 2. 资料库「上传文件」：进度条到【完成】汇总
 * 3. 对话窗「导入材料」：进度气泡 + 导入结果回发模型（模型感知新资料）
 */

const LIVE = "http://127.0.0.1:46175";

/**
 * 点「整理成定义」并等对照表出现
 *
 * 对照表选行 = **核心必确认项 ∪ 模型实际填了/推断的项**（领域层给）——
 * 行数按返回数组派生，不写死（曾经写死 6 行）。
 *
 * 联真用例跑真模型 + 本机共享端口，工作区里可能有并行 E2E 实例在抢 46175：
 * 观察到偶发的网络层失败（弹窗内出现「Failed to fetch」，重跑即好）。
 * 这里在**不降低断言强度**的前提下重试一次；业务错误仍会原样失败。
 */
async function consolidateAndWait(dlg: import("@playwright/test").Locator): Promise<void> {
  const btn = dlg.getByRole("button", { name: "整理成定义" });
  await expect(btn).toBeEnabled({ timeout: 120_000 });
  await btn.click();
  await expect(dlg.locator(".align-table").or(dlg.locator(".modal-error"))).toBeVisible({
    timeout: 120_000,
  });
  if (await dlg.locator(".modal-error").count()) await btn.click();
  await expect(dlg.locator(".align-table")).toBeVisible({ timeout: 120_000 });
  await expect(dlg.locator(".align-badge").first()).toBeVisible({ timeout: 120_000 });
  const alignRows = await dlg.locator(".align-table tbody tr").count();
  expect(alignRows).toBeGreaterThanOrEqual(2);
}

/**
 * 第 1 步（场景定义与边界）就绪口径 = **定义已整理**（表1-1 除「场景名称」外任一项有内容），
 * 不再要求逐项确认——定义整过就能推进。就绪与提示由服务端 `readyHint` 给，
 * 这里只断功能口径：整理完「完成本步」就该可点。
 */
async function expectStepOneCompletable(page: import("@playwright/test").Page): Promise<void> {
  await expect(
    page.locator(".flow-rail").getByRole("button", { name: "下一步" }),
  ).toBeEnabled({ timeout: 30_000 });
}

/** 最小可解析 PDF（正文一段文字，供 doc-parser 提取） */
const PDF_FIXTURE = join(tmpdir(), "scene-e2e-upload.pdf");

test.beforeAll(() => {
  mkdirSync(tmpdir(), { recursive: true });
  writeFileSync(
    PDF_FIXTURE,
    "%PDF-1.4\n" +
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj\n" +
      "4 0 obj<</Length 52>>stream\n" +
      "BT /F1 12 Tf 72 720 Td (E2E upload test content) Tj ET\n" +
      "endstream\nendobj\n" +
      "xref\n0 5\ntrailer<</Size 5/Root 1 0 R>>\n%%EOF\n",
  );
});

test.beforeEach(async ({ page }) => {
  await page.goto(`${LIVE}/`);
  await expect(page.locator(".shell")).toBeVisible();
});

test.describe("上传入库（联真）", () => {
  test.beforeAll(async ({ playwright }) => {
    /* 共用前置：建产品线 + 建项目（AI 通知需要项目上下文） */
    const req = await playwright.request.newContext({ baseURL: LIVE });
    await req.post("/api/v1/library/product-lines", { data: { name: "E2E产品线" } });
    await req.post("/api/v1/projects", { data: { name: "E2E项目" } });
    await req.dispose();
  });

  test("资料库上传文件：file 在前的浏览器字段顺序也能入库（product_line_id 回归）", async ({ page }) => {
    test.setTimeout(90_000); // 解析 + 入库 + 汇总，联真链路可能 >20s
    await page.getByRole("button", { name: "产品资料库" }).click();
    /* setInputFiles 直接注入隐藏 input，浏览器原生 change 事件（React onChange 生效） */
    await page.locator('.pga input[type=file][accept]').setInputFiles(PDF_FIXTURE);
    /*
     * 进度条走到「1 个文件」的入库结果汇总。关键回归只有一条：
     * **不能再出现「缺少 product_line_id」**（file 部件在前的浏览器 FormData 曾触发 400）。
     *
     * 结果前缀不写死【完成】：这份最小 PDF 只验证字段顺序与链路打通，正文里没有可归入
     * 资料库表格的结构化记录，服务端如实回【注意】「1 个文件未产出可校验记录」——两种
     * 前缀都算入库链路成功，真正判失败的是【错误】与缺字段 400。
     */
    const banner = page.locator(".stale-banner");
    await expect(banner).toContainText(/【(?:完成|注意)】\s*1\s*个文件/, { timeout: 75_000 });
    await expect(banner).not.toContainText("缺少 product_line_id");
    await expect(banner).not.toContainText("【错误】");
  });

  test("表格列降维 + 分割线 + 拖拽调宽（#19；#308 右栏行详情已删）", async ({ page, playwright }) => {
    /* 造一行 M1 数据（含曾用名与溯源） */
    const req = await playwright.request.newContext({ baseURL: LIVE });
    const lines = (await (await req.get("/api/v1/library/product-lines")).json()) as {
      id: string;
    }[];
    const seeded = await req.post("/api/v1/library/rows/M1", {
      data: {
        product_line_id: lines[0]!.id,
        values: {
          model: "E2E-1",
          name: "E2E产品",
          status: "在售",
          launch_date: "2026-01",
          position_desc: "端到端验证",
          former_name: "旧名",
        },
      },
    });
    expect(seeded.ok()).toBeTruthy();
    await req.dispose();

    await page.getByRole("button", { name: "产品资料库" }).click();
    /* Tab 标签是业务名「产品清单」，不再显示内部表号 M1 */
    await page.locator(".stab", { hasText: "产品清单" }).click();
    /*
     * 降维口径（v2.11）：M1 中栏只留 型号/产品名称/状态 + 操作，共 4 列；
     * 溯源四列、曾用名/发布日期/定位描述都不占列——全量改到右栏行详情（变更表 #98）。
     */
    await expect(page.locator("table th")).toHaveCount(4);
    const ths = await page.locator("table th").allTextContents();
    expect(ths).not.toContain("溯源");
    expect(ths).not.toContain("来源标注");
    expect(ths).not.toContain("曾用名");
    await expect(page.locator("table .trace-badge")).toHaveCount(0);
    /* 列分割线 */
    const border = await page
      .locator("table th")
      .first()
      .evaluate((el) => getComputedStyle(el).borderRightWidth);
    expect(border).toBe("1px");
    /* 真实鼠标拖拽表头右缘热区 → 该列变宽 */
    const th = page.locator("table th").first();
    const w0 = (await th.boundingBox())!.width;
    const rz = (await th.locator(".th-resize").first().boundingBox())!;
    await page.mouse.move(rz.x + rz.width / 2, rz.y + 8);
    await page.mouse.down();
    await page.mouse.move(rz.x + 50, rz.y + 8, { steps: 4 });
    await page.mouse.up();
    const w1 = (await th.boundingBox())!.width;
    expect(w1).toBeGreaterThan(w0 + 30);
    /* 行点击不再打开右栏行详情（#308）：右栏只有资料助手 */
    await page.locator("tbody tr").first().click();
    await expect(page.locator(".row-detail")).toHaveCount(0);
    await expect(page.locator(".det")).toContainText("资料助手");
  });
});


/* ─── 场景定义（第一输入）对话式 → 整理成表1-1 → 对照确认 ─────────── */

test("场景定义对话（联真）：新建只输名称 → 自动开「场景定义」对话 → 整理成表1-1", async ({
  page,
}) => {
  // 真实模型链路可能较慢（无模型时后端会降级，不阻断）
  test.setTimeout(150_000);

  await page.goto(`${LIVE}/`);
  await expect(page.locator(".shell")).toBeVisible();

  // 新建只问名称（不再有三段式表单）
  await page.getByRole("button", { name: /新建项目|^新建$/ }).first().click();
  const newDlg = page.getByRole("dialog", { name: "新建场景" });
  await expect(newDlg).toBeVisible();
  await expect(newDlg.locator(".brief-input")).toHaveCount(1);
  const sceneName = `E2E 智慧水务 ${Date.now()}`;
  await newDlg.locator(".brief-input").fill(sceneName);
  await newDlg.getByRole("button", { name: "创建并开始定义" }).click();
  await expect(newDlg).toBeHidden();

  // 建完项目直接进入独立的「场景定义」对话（不是中栏、不是抽屉）
  const dlg = page.getByRole("dialog", { name: "场景定义" });
  await expect(dlg).toBeVisible({ timeout: 20_000 });
  await expect(dlg).toContainText(sceneName);
  await expect(dlg.locator(".definition-ta")).toBeVisible();
  await expect(dlg.getByRole("button", { name: "整理成定义" })).toBeVisible();

  // 首次打开自动发一条引导消息（由定义模式 system prompt 保证模型先给理解再提问）
  const userBubbles = dlg.locator(".msg.u .bub");
  const aiBubbles = dlg.locator(".msg.ai .bub");
  await expect(userBubbles.first()).toBeVisible({ timeout: 20_000 });
  // 真实模型回复慢：等到非空回复（无模型时后端降级也会给一条说明）
  await expect
    .poll(async () => ((await aiBubbles.first().textContent()) ?? "").trim().length, {
      timeout: 120_000,
    })
    .toBeGreaterThan(0);

  // 用户再补一条场景本体信息（真实模型会回复），回复落定后按钮重新可用
  await dlg.locator(".definition-ta").fill("客户是市政水务集团，只看出厂到管网，先做内部判断。");
  await dlg.getByRole("button", { name: "发送" }).click();
  await expect(userBubbles).toHaveCount(2, { timeout: 20_000 });

  // 整理成定义：对照表选行 = 核心项 ∪ 模型填了/推断的项（行数动态），带对照结论
  await consolidateAndWait(dlg);
  await dlg.getByRole("button", { name: "完成，回到第 1 步" }).click();
  await expect(dlg).toBeHidden();

  // 中栏第 1 步「场景定义与边界」：只有常驻的表1-1（动作全在流程轴上，中栏不留按钮）
  await expect(page.locator(".ws").getByRole("button", { name: /场景定义对话/ })).toHaveCount(0);
  await expect(
    page.locator(".flow-actions").getByRole("button", { name: /开始本步分析|重算本步/ }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".ws .definition-step")).toHaveCount(0);
  await expect(page.locator(".ws .completeness-bar")).toHaveCount(0);
  const anchor = page.locator(".ws .schema-table--anchor").first();
  await expect(anchor).toBeVisible({ timeout: 20_000 });
  // 表1-1 只有「项 / 内容」两列：无状态列、无 ✓、无待确认
  await expect(anchor.locator("th")).toHaveCount(2);
  await expect(anchor.locator(".state-badge")).toHaveCount(0);
  // 智能体确实把业务画像写出来了（这正是"只输名称"路径要验证的东西）
  const written = await anchor.locator(".cell-input").evaluateAll((els) =>
    els.filter((el) => (el as HTMLTextAreaElement).value.trim() !== "").length,
  );
  expect(written).toBeGreaterThanOrEqual(2);
  // 表1-1 在第 1 步**可就地编辑**：有内容的行渲染成可换行的多行编辑器（不是只读文本）
  await expect(anchor.locator(".cell-input").first()).not.toHaveValue("");

  // 回归：**新建路径**（弹窗由 App 打开）整理完成后，流程状态必须跟着刷新——
  // 曾经漏了这一步，表现为聊完/整理完/关掉弹窗后流程轴仍拿着旧状态。
  // 新口径：整理过就能推进，不需要逐项确认
  await expectStepOneCompletable(page);
  await page
    .locator(".flow-rail")
    .getByRole("button", { name: "下一步" })
    .click();
  await expect(page.locator(".flow-rail .flow-node--done")).toContainText("场景定义");
  await expect(page.locator(".flow-rail .flow-node--current")).toContainText("认识场景", {
    timeout: 20_000,
  });
});

/* ─── 流程逐页推进（v1.5，8 步）：第 1 步（定义 + 表态）→ 完成本步 → 第 2 步「认识场景」 ─── */

test("流程逐页推进（联真）：完成本步走的是 /flow 接口，完成本步后解锁下一步", async ({
  page,
  playwright,
}) => {
  test.setTimeout(150_000);

  const name = `E2E流程 ${Date.now()}`;
  const req = await playwright.request.newContext({ baseURL: LIVE });
  const created = (await (
    await req.post("/api/v1/projects", { data: { name } })
  ).json()) as { id: string };
  await req.dispose();

  await page.goto(`${LIVE}/`);
  await expect(page.locator(".shell")).toBeVisible();
  await page.locator(".proj-hd", { hasText: name }).click();

  const rail = page.locator(".flow-rail");
  await expect(rail.locator(".flow-node--current")).toContainText("场景定义");
  // 就绪与否由服务端按表1-1 判定（前端只显示、不阻断）；这里只要求当前步就是第 1 步
  // 进度卡只一行：就绪提示在运行按钮的 title 里，不再占一行
  // 八步同形：第 1 步还没画像时主按钮位是「开始本步分析」（点了打开场景定义对话）
  await expect(rail.locator(".flow-hint")).toHaveCount(0);
  const startBtn = page.locator(".flow-actions").getByRole("button", { name: "开始本步分析" });
  if (await startBtn.count()) {
    await expect(startBtn).toHaveAttribute("title", /场景业务画像/);
  }

  // 第 1 步：在独立「场景定义」对话里把场景聊清楚，点「整理成定义」写表1-1
  await page.locator(".flow-actions").getByRole("button", { name: /开始本步分析|重算本步/ }).click();
  const completeBtn = rail.getByRole("button", { name: "下一步" });
  const defDlg = page.getByRole("dialog", { name: "场景定义" });
  await expect(defDlg).toBeVisible({ timeout: 20_000 });
  await expect(
    defDlg.locator(".msg.ai .bub").first(),
  ).toBeVisible({ timeout: 120_000 });
  // 用户补一条场景本体信息（真实模型会回复），回复落定后按钮重新可用——
  // 这条内容就是「整理成定义」能写出表1-1、进而本步就绪的依据
  await defDlg
    .locator(".definition-ta")
    .fill("客户是市政水务集团，范围只看出厂到管网，明确不含二次供水；想搞清楚值不值得进");
  await defDlg.getByRole("button", { name: "发送" }).click();
  await expect
    .poll(
      async () =>
        ((await defDlg.locator(".msg.ai .bub").nth(1).textContent()) ?? "").trim().length,
      { timeout: 120_000 },
    )
    .toBeGreaterThan(0);
  await consolidateAndWait(defDlg);
  await defDlg.getByRole("button", { name: "完成，回到第 1 步" }).click();
  await expect(defDlg).toBeHidden();

  // 第 1 步（场景定义与边界）：整理过即就绪 → 直接可推进（不再逐项确认 L1）
  await expectStepOneCompletable(page);
  await completeBtn.click();
  await expect(rail.locator(".flow-node--done")).toHaveCount(1);
  await expect(rail.locator(".flow-node--done")).toContainText("场景定义");

  // 第 2 步「认识场景」：只显示本步表集（表名在流程轴第二行），左栏场景列表同步显示第 2/6 步
  await expect(rail.locator(".flow-node--current")).toContainText("认识场景");
  await expect(page.locator(".flow-outputs").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".proj-hd.active .proj-step")).toContainText("第 2/6 步", {
    timeout: 20_000,
  });
  // 项目确实落库了：flow 接口与 UI 一致
  const check = await playwright.request.newContext({ baseURL: LIVE });
  const flow = (await (await check.get(`/api/v1/projects/${created.id}/flow`)).json()) as {
    currentStep: number;
    completedCount: number;
  };
  await check.dispose();
  expect(flow.currentStep).toBe(2);
  expect(flow.completedCount).toBe(1);
});

/* ─── 资料来源（v2.9）：默认直接引用基础产品资料；取消勾选即生效（没有「保存引用」） ─── */

test("本场景资料（联真）：通用库默认勾选、取消即生效、没有保存按钮", async ({ page, playwright }) => {
  test.setTimeout(90_000);
  const req = await playwright.request.newContext({ baseURL: LIVE });
  // 一个通用资料库（scenario_id 为空 = 基础产品资料）+ 一个新建场景
  const line = (await (
    await req.post("/api/v1/library/product-lines", { data: { name: `基础库${Date.now()}` } })
  ).json()) as { id: string; name: string };
  const created = (await (
    await req.post("/api/v1/projects", { data: { name: `E2E资料引用 ${Date.now()}` } })
  ).json()) as { id: string };

  // 默认：新建场景**不做任何操作**，这个通用库就在引用集合里（服务端口径）
  const before = (await (await req.get(`/api/v1/projects/${created.id}/material-sources`)).json()) as {
    linked: { id: string }[];
  };
  expect(before.linked.map((l) => l.id)).toContain(line.id);

  await page.goto(`${LIVE}/`);
  await page.locator(".proj-hd", { hasText: "E2E资料引用" }).click();
  await page.getByRole("button", { name: "本场景资料" }).click();
  const panel = page.locator(".pnl.material-panel");
  // 按库名精确定位（同一个 e2e 服务里可能有别的用例建的通用库）
  const box = panel.locator(".ms-check", { hasText: line.name }).locator("input");
  await expect(box).toBeChecked();
  // 没有「保存引用」这个来回：勾选状态本身就是引用关系
  await expect(panel.getByRole("button", { name: /保存引用/ })).toHaveCount(0);

  // 取消勾选 → 立即落库（该库不再参与本场景分析）
  await box.uncheck();
  await expect
    .poll(async () => {
      const r = (await (
        await req.get(`/api/v1/projects/${created.id}/material-sources`)
      ).json()) as { linked: { id: string }[] };
      return r.linked.map((l) => l.id).includes(line.id);
    }, { timeout: 15_000 })
    .toBe(false);

  // 再勾回来 → 恢复引用
  await box.check();
  await expect
    .poll(async () => {
      const r = (await (
        await req.get(`/api/v1/projects/${created.id}/material-sources`)
      ).json()) as { linked: { id: string }[] };
      return r.linked.map((l) => l.id).includes(line.id);
    }, { timeout: 15_000 })
    .toBe(true);
  await req.dispose();
});
