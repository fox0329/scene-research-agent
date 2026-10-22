import { test, expect } from "@playwright/test";

/**
 * 资料库表格简化 · 联真 e2e（第二个 webServer：127.0.0.1:46175，真应用服务 + 独立临时库）
 *
 * 为什么放在这里而不是 interaction.spec.ts：那份套件跑 46174（vite preview，**演示模式**
 * `preview.proxy = {}`），/api 由前端 mock 兜住，造不出"两个参数类别"这种真数据。
 * 本套件直连真服务，并自己在临时库里造数，断言的是真链路（PATCH 落库 → 重新取数）。
 *
 * 覆盖（变更表 #98）：① M2 按参数类别分组折叠、组内编辑落到正确的行 ② O 六类共用一个
 * 面板 ③ 溯源不占列、详情落右栏。（原 ③ M6 内部费率骨架随 M6 删除，变更表 #106）
 */

const LIVE = "http://127.0.0.1:46175";

interface Line {
  id: string;
  name: string;
}

/** 造一条产品线（名字带时间戳，避免与并发实例重名） */
async function newLine(page: import("@playwright/test").Page, tag: string): Promise<Line> {
  const res = await page.request.post(`${LIVE}/api/v1/library/product-lines`, {
    data: { name: `E2E-${tag}-${Date.now()}` },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as Line;
}

async function addRow(
  page: import("@playwright/test").Page,
  code: string,
  lineId: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await page.request.post(`${LIVE}/api/v1/library/rows/${code}`, {
    data: { product_line_id: lineId, values },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

/** 打开资料库并切到指定产品线（必须等产品线列表到位，否则 body 停在"还没有产品线"空态） */
async function openLibrary(page: import("@playwright/test").Page, lineName: string) {
  // 首次启动引导会盖住整页；资料库用例不测引导，直接标记已看过
  await page.addInitScript(() => localStorage.setItem("scene.onboarding.v1.done", "1"));
  await page.goto(LIVE);
  await expect(page.locator(".shell")).toBeVisible();
  await page.getByRole("button", { name: "产品资料库" }).click();
  const picker = page.locator('select[aria-label="选择产品线"]');
  await expect(picker).toBeVisible();
  await picker.selectOption({ label: lineName });
  await expect(picker).toHaveValue(/.+/);
}

test("规格书：一个产品一张表（按产品出表，不做类别折叠）", async ({ page }) => {
  const line = await newLine(page, "M2出表");
  const prod = await addRow(page, "M1", line.id, {
    model: "E2E-M2",
    name: "出表用例",
    status: "在售",
    launch_date: "2025-01-01",
    position_desc: "自动化造数",
  });
  for (const [name, value] of [
    ["网口", "2 路千兆"],
    ["串口", "1 路 RS485"],
    ["工作温度", "0~50℃"],
  ] as const) {
    await addRow(page, "M2", line.id, {
      product_id: prod.id,
      param_class: "接口",
      param_name: name,
      value,
      measured: "未提及",
    });
  }

  await openLibrary(page, line.name);
  await page.getByRole("button", { name: "规格书" }).click();

  // 一个产品一张表：没有折叠组，规格行平铺，列里有「参数类别」
  await expect(page.locator(".row-group")).toHaveCount(0);
  await expect(page.locator(".ws table tbody tr")).toHaveCount(3);
  await expect(page.locator(".ws table thead th")).toHaveText([
    "参数类别",
    "参数名称",
    "参数值",
    "实测口径",
    "操作",
  ]);

  // 按产品出表：切到"全部产品（合表）"仍是同一张表，行数不变（只有一个产品）
  await page.locator('select[aria-label="选择产品"]').selectOption("__all__");
  await expect(page.locator(".ws table tbody tr")).toHaveCount(3);
  await expect(page.locator(".row-group")).toHaveCount(0);
});

test("可选材料：五类共用一个面板（类别选择器切换），不再叠成一页", async ({ page }) => {
  const line = await newLine(page, "O合并");
  await openLibrary(page, line.name);
  await page.getByRole("button", { name: "可选材料" }).click();
  const picker = page.locator('select[aria-label="选择可选材料类别"]');
  await expect(picker).toBeVisible();
  await expect(picker.locator("option")).toHaveText([
    "认证",
    "案例",
    "SDK",
    "路线图",
    "生态",
  ]);
  // 标题按选择器变（.pnl-h 里还有选项文本，断言要收在 h2 上）
  await expect(page.locator(".pnl-h h2", { hasText: "认证" })).toHaveCount(1);
  await picker.selectOption("O2");
  await expect(page.locator(".pnl-h h2", { hasText: "案例" })).toHaveCount(1);
  await expect(page.locator(".pnl-h h2", { hasText: "认证" })).toHaveCount(0);
  // 这条线没有案例数据：不再只显示一句空态，而是表头 + 一行可直接填写的空行
  await expect(page.locator(".ws .empty-state-title")).toHaveCount(0);
  await expect(page.locator(".ws table thead th").last()).toHaveText("操作");
  await expect(page.locator(".ws table tbody tr")).toHaveCount(1);
  // 点「新增行」在表尾多一行，不弹 JSON 输入框
  await page.getByRole("button", { name: "新增行" }).click();
  await expect(page.locator(".ws table tbody tr")).toHaveCount(2);
});

test("空的能力清单：直接显示表头与空行，填完必填列自动保存", async ({ page }) => {
  const line = await newLine(page, "M3空表");
  await openLibrary(page, line.name);
  await page.getByRole("button", { name: "能力清单" }).click();

  await expect(page.locator(".ws .empty-state-title")).toHaveCount(0);
  await expect(page.locator(".ws table thead th")).toHaveText([
    "领域",
    "能力名称",
    "描述",
    "成熟度",
    "操作",
  ]);
  await expect(page.locator(".ws table tbody tr")).toHaveCount(1);

  const row = page.locator(".ws table tbody tr").first();
  await row.locator("td").nth(1).click();
  await page.keyboard.type("E2E-空表能力");
  await page.keyboard.press("Tab");

  // 只填名称还不落库；补上描述（M3 的最小必填集）才自动保存
  await page.locator(".ws table tbody tr").first().locator("td").nth(2).click();
  await page.keyboard.type("空表也能直接填写");
  await page.keyboard.press("Tab");
  await expect
    .poll(async () => {
      const res = await page.request.get(`${LIVE}/api/v1/library/tables/M3?product_line_id=${line.id}`);
      return ((await res.json()) as unknown[]).length;
    })
    .toBe(1);

  // 保存成功后草稿行消失；再点新增行仍是在表尾追加一行，不出现弹窗
  await expect(page.locator(".ws table tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "新增行" }).click();
  await expect(page.locator(".ws table tbody tr")).toHaveCount(2);
});

test("溯源不占列：主表只留业务列，来源信息在右栏行详情里", async ({ page }) => {
  const line = await newLine(page, "溯源右栏");
  await addRow(page, "M1", line.id, {
    model: "E2E-TRACE",
    name: "溯源用例",
    status: "在售",
    launch_date: "2025-01-01",
    position_desc: "自动化造数",
  });
  await openLibrary(page, line.name);
  await page.getByRole("button", { name: "产品清单" }).click();
  const heads = page.locator(".ws table thead th");
  await expect(heads).toContainText(["型号", "产品名称", "状态"]);
  await expect(heads).not.toContainText(["溯源"]);
  // 点行 → 右栏出现溯源四列（来源类型/权威性/证据等级/来源标注）
  await page.locator(".ws table tbody tr").first().click();
  const det = page.locator(".det");
  await expect(det).toContainText("来源");
  await expect(det).toContainText("证据");
});

test("新建产品线：走应用内对话框（Electron 不支持 window.prompt，故障清单 #70）", async ({ page }) => {
  /* 空库时选择器不渲染（"还没有产品线"空态），先 API 造一条让页面进入正常态 */
  await newLine(page, "前置线");
  await page.addInitScript(() => localStorage.setItem("scene.onboarding.v1.done", "1"));
  await page.goto(LIVE);
  await expect(page.locator(".shell")).toBeVisible();
  await page.getByRole("button", { name: "产品资料库" }).click();
  const picker = page.locator('select[aria-label="选择产品线"]');
  await expect(picker).toBeVisible();

  /* 点「新建产品线」必须弹出应用内对话框——桌面壳里 window.prompt 直接抛异常，
     旧实现的表现就是"点了毫无反应"（真机反馈 2026-10-14） */
  await page.getByRole("button", { name: "新建产品线" }).click();
  const dialog = page.locator('div[role="dialog"][aria-label="新建产品线"]');
  await expect(dialog).toBeVisible();

  const name = `E2E-新建按钮-${Date.now()}`;
  await dialog.locator("input").fill(name);
  await dialog.getByRole("button", { name: "创建" }).click();

  /* 创建成功：右下弹 toast，产品线选择器里能选到新库 */
  await expect(page.locator(".toast-item").filter({ hasText: "已创建" }).last()).toBeVisible({ timeout: 10_000 });
  await expect(picker.locator(`option:has-text("${name}")`)).toHaveCount(1);
});

test("空资料库：每张表都给表头 + 一行可直接填写的空行", async ({ page }) => {
  const line = await newLine(page, "全空表");
  await openLibrary(page, line.name);

  for (const tab of ["产品清单", "规格书", "能力清单", "边界与限制", "报价"]) {
    await page.getByRole("button", { name: tab }).click();
    await expect(page.locator(".ws table thead th").last()).toHaveText("操作");
    await expect(page.locator(".ws table tbody tr")).toHaveCount(1);
  }

  await page.getByRole("button", { name: "可选材料" }).click();
  const picker = page.locator('select[aria-label="选择可选材料类别"]');
  const optionalHeads: Record<string, string[]> = {
    O1: ["型号", "证书类型", "证书号", "有效期至", "发证机构", "覆盖型号", "证书文件", "操作"],
    O2: ["案例名", "场景", "交付时间", "验收指标与结果", "客户（脱敏）", "部署规模", "可否回访", "证据等级", "操作"],
    O4: ["产品", "资料名称", "版本", "覆盖内容", "操作"],
    O5: ["能力/产品", "当前状态", "计划可用时间", "置信度", "负责人", "操作"],
    O6: ["项", "覆盖范围", "现状", "合作方", "合作深度", "操作"],
  };
  for (const [code, heads] of Object.entries(optionalHeads)) {
    await picker.selectOption(code);
    await expect(page.locator(".ws table thead th")).toHaveText(heads);
    await expect(page.locator(".ws table tbody tr")).toHaveCount(1);
  }
});
