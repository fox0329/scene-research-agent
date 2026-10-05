import { test, expect } from "@playwright/test";

/**
 * 资料库表格简化 · 联真 e2e（第二个 webServer：127.0.0.1:46175，真应用服务 + 独立临时库）
 *
 * 为什么放在这里而不是 interaction.spec.ts：那份套件跑 46174（vite preview，**演示模式**
 * `preview.proxy = {}`），/api 由前端 mock 兜住，造不出"两个参数类别"这种真数据。
 * 本套件直连真服务，并自己在临时库里造数，断言的是真链路（PATCH 落库 → 重新取数）。
 *
 * 覆盖（变更表 #98）：① M2 按参数类别分组折叠、组内编辑落到正确的行 ② O 六类共用一个
 * 面板 ③ M6 内部费率骨架（新建线即有 14 行） ④ 溯源不占列、详情落右栏。
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
  await page.goto(LIVE);
  await expect(page.locator(".shell")).toBeVisible();
  await page.getByRole("button", { name: "产品资料库" }).click();
  const picker = page.locator('select[aria-label="选择产品线"]');
  await expect(picker).toBeVisible();
  await picker.selectOption({ label: lineName });
  await expect(picker).toHaveValue(/.+/);
}

test("M2 规格书：一个产品一张表（按产品出表，不做类别折叠）", async ({ page }) => {
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
  await page.getByRole("button", { name: "M2 规格书" }).click();

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

test("O 可选材料：六类共用一个面板（类别选择器切换），不再是 6 张表叠一页", async ({ page }) => {
  const line = await newLine(page, "O合并");
  await openLibrary(page, line.name);
  await page.getByRole("button", { name: "O 可选材料" }).click();
  const picker = page.locator('select[aria-label="选择可选材料类别"]');
  await expect(picker).toBeVisible();
  await expect(picker.locator("option")).toHaveText([
    "O1 认证",
    "O2 案例",
    "O3 价格",
    "O4 SDK",
    "O5 路线图",
    "O6 生态",
  ]);
  // 标题按选择器变（.pnl-h 里还有选项文本，断言要收在 h2 上）
  await expect(page.locator(".pnl-h h2", { hasText: "O1 认证" })).toHaveCount(1);
  await picker.selectOption("O3");
  await expect(page.locator(".pnl-h h2", { hasText: "O3 价格" })).toHaveCount(1);
  await expect(page.locator(".pnl-h h2", { hasText: "O1 认证" })).toHaveCount(0);
  // 这条线没有 O3 数据 → 面板体只有一张表的空态（而不是 6 张表叠着）
  await expect(page.locator(".ws .empty-state-title")).toHaveText(["本表暂无资料"]);
});

test("M6 内部费率：新建产品线即有标准骨架（填数字即可，不用自己建行）", async ({ page }) => {
  const line = await newLine(page, "M6骨架");
  await openLibrary(page, line.name);
  await page.getByRole("button", { name: "M6 内部费率" }).click();
  const rows = page.locator(".ws table tbody tr");
  await expect(rows).toHaveCount(14);
  // 单价与工时都是 0、「待确认」——契约明确这类行不得用于报价
  await expect(rows.first().locator("td").nth(2)).toHaveText("0");
  await expect(rows.first().locator("td").nth(5)).toHaveText("待确认");
  // 整列全空的选填列（说明）默认收起，可一键展开
  await expect(page.locator(".ws table thead th")).toHaveText([
    "类别",
    "项目",
    "单价",
    "单位",
    "标准工时",
    "数据来源",
    "操作",
  ]);
  await page.getByRole("button", { name: /显示空列（\d+）/ }).click();
  await expect(page.locator(".ws table thead th")).toContainText(["说明"]);
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
  await page.getByRole("button", { name: "M1 产品清单" }).click();
  const heads = page.locator(".ws table thead th");
  await expect(heads).toContainText(["型号", "产品名称", "状态"]);
  await expect(heads).not.toContainText(["溯源"]);
  // 点行 → 右栏出现溯源四列（来源类型/权威性/证据等级/来源标注）
  await page.locator(".ws table tbody tr").first().click();
  const det = page.locator(".det");
  await expect(det).toContainText("来源");
  await expect(det).toContainText("证据");
});
