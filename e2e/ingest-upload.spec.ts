import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 上传入库联真 e2e（第二个 webServer：127.0.0.1:4181，真应用服务 + 真模型链路）
 *
 * 覆盖：
 * 1. 回归——浏览器 FormData 字段顺序（file 部件在前）也能入库
 *    （@fastify/multipart file() 收不到 file 之后的字段，曾致「缺少 product_line_id」400）
 * 2. 资料库「上传文件」：进度条到【完成】汇总
 * 3. 对话窗「导入材料」：进度气泡 + 导入结果回发模型（模型感知新资料）
 */

const LIVE = "http://127.0.0.1:4181";

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
    await page.getByRole("button", { name: "产品资料库" }).click();
    /* setInputFiles 直接注入隐藏 input，浏览器原生 change 事件（React onChange 生效） */
    await page.locator('.pga input[type=file][accept]').setInputFiles(PDF_FIXTURE);
    /* 进度条走到【完成】汇总；关键是不再出现「缺少 product_line_id」 */
    const banner = page.locator(".stale-banner");
    await expect(banner).toContainText(/【完成】1 个文件/, { timeout: 60_000 });
    await expect(banner).not.toContainText("缺少 product_line_id");
  });

  test("表格列降维 + 分割线 + 拖拽调宽 + 右栏行详情（变更表 #19）", async ({ page, playwright }) => {
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
    await page.locator(".stab", { hasText: "M1" }).click();
    /* 降维：7 列含「溯源」徽标列，来源四列与曾用名不再占列（等表格异步加载完） */
    await expect(page.locator("table th")).toHaveCount(7);
    const ths = await page.locator("table th").allTextContents();
    expect(ths).toContain("溯源");
    expect(ths).not.toContain("来源标注");
    expect(ths).not.toContain("曾用名");
    await expect(page.locator(".trace-badge").first()).toBeVisible();
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
    /* 行点击 → 右栏行详情（补充信息 + 溯源全量） */
    await page.locator("tbody tr").first().click();
    await expect(page.locator(".row-detail")).toBeVisible();
    await expect(page.locator(".det-h h3")).toContainText("行详情 · M1 产品清单");
    const labels = await page.locator(".row-detail .rd-label").allTextContents();
    expect(labels).toContain("曾用名");
    expect(labels).toContain("来源标注");
  });

  test("对话直接导入：消息里写文件路径即入库，结果回显且模型感知", async ({ page }) => {
    await page.locator(".conv-ta").click(); // 展开抽屉
    await page
      .locator(".conv-ta")
      .fill(`请导入 ${PDF_FIXTURE} 这份材料，导入后告诉我入了哪些表`);
    await page.keyboard.press("Enter");
    /* 导入报告随流回显：识别进度 → 每文件入库行数（含每表分布） */
    await expect(page.locator(".conv-stream")).toContainText("识别到 1 个文件", {
      timeout: 30_000,
    });
    await expect(page.locator(".conv-stream")).toContainText(`✅ ${PDF_FIXTURE}`, {
      timeout: 60_000,
    });
    await expect(page.locator(".conv-stream")).toContainText("入库", { timeout: 10_000 });
    /* 模型收到导入结果（系统消息含报告），回复落定且非错误 */
    await expect(page.locator(".conv-stream")).toContainText("【材料导入结果】", {
      timeout: 30_000,
    });
    const bubbles = page.locator(".conv-stream .bub");
    await expect
      .poll(async () => bubbles.last().textContent(), { timeout: 90_000 })
      .not.toContain("【错误】未收到回复内容");
  });
});

/* ─── 场景诉求（第一输入）三段式 → 起草场景锚 → 对照确认 ─────────── */

test("场景诉求三段式：新建项目问「想梳理什么」→ 起草表1-1 → 对照确认", async ({ page }) => {
  // 真实模型链路可能较慢（无模型时会降级为按线索预填，不阻断）
  test.setTimeout(150_000);

  await page.goto(`${LIVE}/`);
  await expect(page.locator(".shell")).toBeVisible();

  // 新建项目应弹出三段的「场景诉求」（不再是一个 window.prompt）
  await page.getByRole("button", { name: /新建项目|^新建$/ }).first().click();
  const dlg = page.locator(".modal[aria-label='场景诉求']");
  await expect(dlg).toBeVisible();

  // ① 场景名称
  await dlg.locator("input.brief-input").first().fill(`E2E 智慧水务 ${Date.now()}`);
  await dlg.getByRole("button", { name: "下一步" }).click();

  // ② 你想搞清楚什么（必填，未填应拦住）
  await dlg.getByRole("button", { name: "下一步" }).click();
  await expect(dlg.locator(".modal-error")).toContainText("想搞清楚什么");
  await dlg.locator("textarea.brief-input").fill("这个场景值不值得进");
  await dlg.getByRole("button", { name: "下一步" }).click();

  // ③ 线索（选填）
  await dlg.locator("input.brief-input").nth(0).fill("市政水务集团");
  await dlg.locator("input.brief-input").nth(2).fill("只看出厂到管网");
  await dlg.getByRole("button", { name: "起草场景锚" }).click();

  // ④ 对照式确认：四态分类 + 对照表
  await expect(dlg.locator(".align-table")).toBeVisible({ timeout: 120_000 });
  await expect(dlg.locator(".align-badge").first()).toBeVisible();
  await expect(dlg.locator(".align-table tbody tr")).toHaveCount(6); // L1 六项

  await dlg.getByRole("button", { name: /去确认/ }).click();
  await expect(dlg).toBeHidden();

  // 中栏出现常驻场景锚（表1-1），且带 L1 必确认标记
  const anchor = page.locator(".ws .schema-table--anchor").first();
  await expect(anchor).toBeVisible({ timeout: 20_000 });
  expect(await anchor.locator(".confirm-dot").count()).toBeGreaterThanOrEqual(6);
});

/* ─── 流程逐页推进（v1.5）：诉求内嵌面板 → 完成本步 → 锚确认 → 进入第 3 步 ─── */

test("流程逐页推进（联真）：完成本步走的是 /flow 接口，确认锚行后解锁下一步", async ({
  page,
  playwright,
}) => {
  test.setTimeout(120_000);

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
  await expect(rail.locator(".flow-node--current")).toContainText("场景诉求");
  // 诉求未填 → 数据判定为未就绪：按钮不可点，readyHint 直接说缺什么
  const completeBtn = rail.getByRole("button", { name: "完成本步，进入下一步" });
  await expect(completeBtn).toBeDisabled();
  await expect(completeBtn).toHaveAttribute("title", /想搞清楚什么/);

  // 第 1 步面板内嵌诉求字段（不是弹窗）；保存后按钮变为可点
  await page.locator(".ws .brief-textarea").fill("这个场景值不值得进");
  await page.locator(".ws").getByRole("button", { name: "保存诉求" }).click();
  await expect(completeBtn).toBeEnabled({ timeout: 20_000 });

  await completeBtn.click();
  await expect(rail.locator(".flow-node--done")).toHaveCount(1);
  await expect(rail.locator(".flow-node--current")).toContainText("场景定义与边界");

  // 第 2 步：右栏确认清单逐项确认（L1 六项）→ 本步就绪
  await expect(page.locator(".det .confirm-list")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".det .layer-L1")).toHaveCount(6);
  for (let i = 0; i < 6; i++) {
    await page
      .locator(".det .confirm-item")
      .nth(i)
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await expect(page.locator(".det .layer-L1").nth(i)).toBeVisible();
  }
  await expect(completeBtn).toBeEnabled({ timeout: 20_000 });
  await completeBtn.click();

  // 第 3 步「认识场景」：只显示本步表集，左栏场景列表同步显示第 3/9 步
  await expect(rail.locator(".flow-node--done")).toHaveCount(2);
  await expect(rail.locator(".flow-node--current")).toContainText("认识场景");
  await expect(page.locator(".ws .table-chips").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".proj-hd.active .proj-step")).toContainText("第 3/9 步", {
    timeout: 20_000,
  });
  // 项目确实落库了：flow 接口与 UI 一致
  const check = await playwright.request.newContext({ baseURL: LIVE });
  const flow = (await (await check.get(`/api/v1/projects/${created.id}/flow`)).json()) as {
    currentStep: number;
    completedCount: number;
  };
  await check.dispose();
  expect(flow.currentStep).toBe(3);
  expect(flow.completedCount).toBe(2);
});
