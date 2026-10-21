import { test, expect } from "@playwright/test";

/**
 * 三条关键回归（联真 · 46175）
 *
 * 这组用例不追求"模型写出内容"，只锁住三条最容易一改就断的链路：
 *  ① 六步推进：新建场景 → 写出第 1 步定义 → 第 2 步解锁并能进入（进度可见）
 *  ② 设置页模型配置：假 provider 的「测试连接」失败提示可见（只打本机无效端口，不发外部请求）
 *  ③ 交付物导出入口：无报告时界面有「生成报告」，服务端导出接口返回 4xx 而不是 500
 *
 * 说明：第 1 步的画像由真实模型写；这里通过服务端的锚行保存接口写入同样形状的数据，
 * 只验证"定义已就绪 → 可推进 → 第 2 步解锁"的流程，不依赖模型可用性（无 Key 时也不会红）。
 */

const LIVE = "http://127.0.0.1:46175";

test("六步推进冒烟：新建场景 → 完成第 1 步 → 第 2 步解锁并进入", async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const name = `E2E 六步冒烟 ${Date.now()}`;
  await page.goto(`${LIVE}/`);
  await expect(page.locator(".shell")).toBeVisible();

  // 1) 新建场景：只输名称（与产品当前入口一致）
  await page.getByRole("button", { name: /新建项目|^新建$/ }).first().click();
  const newDlg = page.getByRole("dialog", { name: "新建场景" });
  await expect(newDlg).toBeVisible();
  await newDlg.locator(".brief-input").fill(name);
  await newDlg.getByRole("button", { name: "创建并开始定义" }).click();
  await expect(newDlg).toBeHidden();

  // 建完会直接打开「场景定义」对话；本用例不跑模型，关掉它
  const defDlg = page.getByRole("dialog", { name: "场景定义" });
  await expect(defDlg).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await expect(defDlg).toHaveCount(0);

  // 2) 用与服务端「整理成定义」同形状的锚行写出第 1 步画像（避免依赖模型）
  const list = (await (await page.request.get(`${LIVE}/api/v1/projects`)).json()) as {
    id: string;
    name: string;
  }[];
  const project = list.find((p) => p.name === name);
  expect(project, `新建项目应出现在项目列表：${name}`).toBeTruthy();
  const seeded = await page.request.put(`${LIVE}/api/v1/projects/${project!.id}/anchor`, {
    data: {
      rows: [
        { item: "场景名称", content: name, source_type: "用户补充" },
        { item: "场景边界", content: "只覆盖厂区内部，不含外部管网" },
        { item: "生产对象", content: "自来水" },
        { item: "核心生产系统", content: "泵站与 SCADA" },
        { item: "买方类型", content: "市政水务集团" },
        { item: "采购特征", content: "集团集采 + 区域实施" },
      ],
    },
  });
  expect(seeded.ok()).toBe(true);

  // 3) 刷新后进入第 1 步：定义已就绪，按钮就是「下一步」
  await page.reload();
  await expect(page.locator(".shell")).toBeVisible();
  await page.locator(".proj-hd", { hasText: name }).click();
  const rail = page.locator(".flow-rail");
  await expect(rail.locator(".flow-node--current")).toContainText("场景定义");
  const next = rail.getByRole("button", { name: "下一步" });
  await expect(next).toBeEnabled({ timeout: 20_000 });
  await expect(page.locator(".proj-hd.active .proj-step")).toContainText("第 1/6 步");

  // 4) 完成第 1 步 → 第 2 步解锁并进入
  await next.click();
  await expect(rail.locator(".flow-node--done")).toContainText("场景定义");
  await expect(rail.locator(".flow-node--current")).toContainText("认识场景", { timeout: 20_000 });
  await expect(page.locator(".proj-hd.active .proj-step")).toContainText("第 2/6 步");
  await expect(rail.locator(".flow-node--locked")).toHaveCount(4); // 第 3-6 步仍锁着
  await expect(page.locator(".flow-outputs").first()).toBeVisible({ timeout: 20_000 });

  // 5) 服务端状态与界面一致，且页面没有未捕获异常
  const flow = (await (
    await page.request.get(`${LIVE}/api/v1/projects/${project!.id}/flow`)
  ).json()) as { currentStep: number; completedCount: number };
  expect(flow.currentStep).toBe(2);
  expect(flow.completedCount).toBe(1);
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("设置页模型配置：假 provider 测试连接失败提示可见（不发外部请求）", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${LIVE}/`);
  await expect(page.locator(".shell")).toBeVisible();
  await page.getByRole("button", { name: "设置" }).click();
  await expect(page.locator(".ws-settings")).toBeVisible();

  await page.getByRole("button", { name: "添加供应商" }).first().click();
  const form = page.locator(".provider-form");
  await expect(form).toBeVisible();

  const tag = Date.now();
  await form.getByLabel("供应商名称").fill(`e2e-fake-${tag}`);
  // 9 号端口 = discard，本机立即拒绝：只验证失败提示，不会打到任何外部服务
  await form.getByLabel(/链接（OpenAI 兼容 baseURL）/).fill("http://127.0.0.1:9/v1");
  await form.getByLabel(/API Key/).fill("sk-e2e-invalid");

  const testBtn = form.getByRole("button", { name: "测试连接" });
  await expect(testBtn).toBeEnabled();
  await testBtn.click();

  const err = form.locator(".conn-check--err");
  await expect(err).toBeVisible({ timeout: 30_000 });
  await expect(err).toContainText("❌");
  await expect(err).not.toBeEmpty();
  await expect(form.locator(".conn-check--ok")).toHaveCount(0);
});

test("交付物导出接口：无报告时界面有「生成报告」，POST export 返回 4xx 而非 500", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const name = `E2E 导出守卫 ${Date.now()}`;
  const created = await page.request.post(`${LIVE}/api/v1/projects`, { data: { name } });
  expect(created.ok()).toBe(true);
  const projectId = ((await created.json()) as { id: string }).id;
  // 前 5 步标完成（不跑模型）→ 当前步 = 交付物
  for (let step = 1; step <= 5; step += 1) {
    const res = await page.request.post(
      `${LIVE}/api/v1/projects/${projectId}/flow/steps/${step}/complete`,
    );
    expect(res.ok()).toBe(true);
  }

  // 界面：无报告时只有生成入口，不预填正文
  await page.goto(`${LIVE}/`);
  await expect(page.locator(".shell")).toBeVisible();
  await page.locator(".proj-hd", { hasText: name }).click();
  await page.locator(".flow-nodes .flow-node", { hasText: "交付物" }).click();
  const actions = page.locator(".flow-rail .flow-outputs .pnl-actions--end");
  await expect(actions.getByRole("button", { name: "生成报告" })).toBeVisible();
  await expect(page.locator(".ws .empty-state")).toContainText("还没有生成");
  await expect(page.locator(".ws .md-body")).toHaveCount(0);

  // 接口：三处导出都必须先过「交付物还没生成」守卫，返回 4xx（绝不是 500）
  for (const path of ["export", "export-docx", "export-pptx"]) {
    const res = await page.request.post(
      `${LIVE}/api/v1/projects/${projectId}/deliverables/${path}`,
      { data: { dir: "/tmp" } },
    );
    expect(res.status(), path).toBeGreaterThanOrEqual(400);
    expect(res.status(), path).toBeLessThan(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? "", path).toContain("交付物还没生成");
  }
});
