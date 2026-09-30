import { test, expect, type Page } from "@playwright/test";

/**
 * 交互规范逐项断言套件
 * 依据：00b-智能体工作流标准 §11.3（阶段推进规则）+ 01-产品定义 §4.2（关键交互定稿表）
 * 断言对象为构建产物（vite preview），视口 1440×900（三栏全展开布局）。
 */

const H48 = 48;

async function openDrawer(page: Page) {
  await page.locator(".conv-ta").click();
  await expect(page.locator(".conv-stream-wrap.open")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".shell")).toBeVisible();
});

/* ───────────────────── §4.2 表头对齐：三栏头部统一 48px ───────────────────── */

test("三栏页头统一 48px 且底边线水平对齐", async ({ page }) => {
  const heads = [
    page.locator(".side .side-hd"),
    page.locator(".main .pgh"),
    page.locator(".det .det-h"),
  ];
  const boxes = [];
  for (const h of heads) {
    await expect(h).toBeVisible();
    const box = await h.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.height)).toBe(H48);
    boxes.push(box!);
  }
  const bottoms = boxes.map((b) => Math.round(b.y + b.height));
  expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThanOrEqual(1);
});

/* ───────────────────── §4.2 对话抽屉 ───────────────────── */

test("输入栏常驻底部：实底、两行高", async ({ page }) => {
  const input = page.locator(".conv-input");
  await expect(input).toBeVisible();
  await expect(page.locator(".conv-ta")).toHaveAttribute("rows", "2");
  const bg = await input.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe("rgb(255, 255, 255)"); // 实底不透明
});

test("聚焦输入框展开对话流：250ms 过渡 + 半透明浮层无毛玻璃", async ({ page }) => {
  await openDrawer(page);
  const wrap = page.locator(".conv-stream-wrap");
  const style = await wrap.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { duration: cs.transitionDuration, blur: cs.backdropFilter };
  });
  expect(style.duration).toContain("0.25s");
  expect(style.blur === "none" || style.blur === "").toBeTruthy();
  const bg = await page.locator(".conv-stream").evaluate((el) => getComputedStyle(el).backgroundColor);
  /* 品牌浅蓝半透明（用户定稿：加一点蓝色、保持透明度） */
  expect(bg).toBe("rgba(219, 234, 254, 0.6)");
});

test("气泡配色：AI 深底白字、用户主色", async ({ page }) => {
  await openDrawer(page);
  const ai = page.locator(".msg.ai .bub").first();
  const user = page.locator(".msg.u .bub").first();
  const aiStyle = await ai.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { color: cs.color, bg: cs.backgroundColor };
  });
  expect(aiStyle.color).toBe("rgb(255, 255, 255)");
  expect(aiStyle.bg).toBe("rgba(24, 24, 27, 0.5)");
  expect(await user.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    "rgba(37, 99, 235, 0.85)",
  );
});

test("拖拽条常亮 48×4px，可上下拖动调高度", async ({ page }) => {
  await openDrawer(page);
  const bar = page.locator(".conv-resize");
  const pill = await bar.evaluate((el) => {
    const cs = getComputedStyle(el, "::before");
    return { w: cs.width, h: cs.height, bg: cs.backgroundColor };
  });
  expect(pill.w).toBe("48px");
  expect(pill.h).toBe("4px");
  expect(pill.bg).not.toBe("rgba(0, 0, 0, 0)"); // 常亮可见，非 hover 才现
  const box = (await bar.boundingBox())!;
  const h0 = (await page.locator(".conv-stream-wrap").boundingBox())!.height;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 80, { steps: 5 });
  const h1 = (await page.locator(".conv-stream-wrap").boundingBox())!.height;
  await page.mouse.up();
  expect(Math.round(h1)).toBeGreaterThanOrEqual(Math.round(h0) + 60);
});

test("Esc 收起对话流", async ({ page }) => {
  await openDrawer(page);
  await page.keyboard.press("Escape");
  await expect(page.locator(".conv-stream-wrap.open")).toHaveCount(0);
});

test("点击表格工作区收起对话流", async ({ page }) => {
  await openDrawer(page);
  await page.locator(".ws").click({ position: { x: 12, y: 12 } });
  await expect(page.locator(".conv-stream-wrap.open")).toHaveCount(0);
});

/* ───────────────────── §4.2 会话管理 ───────────────────── */

async function setExpanded(proj: import("@playwright/test").Locator, want: boolean) {
  const hd = proj.locator(".proj-hd");
  if ((await hd.getAttribute("aria-expanded")) !== String(want)) await hd.click();
  return hd;
}

test("项目名点击展开/收起会话列表", async ({ page }) => {
  const proj = page.locator(".proj").first();
  const hd = await setExpanded(proj, false); // 当前项目默认展开 → 点击收起
  await expect(proj.locator(".proj-convs")).toBeHidden();
  await hd.click();
  await expect(hd).toHaveAttribute("aria-expanded", "true");
  await expect(proj.locator(".proj-convs .cvi").first()).toBeVisible();
});

test("项目与会话均有 ⋯ 菜单（重命名/归档/删除）", async ({ page }) => {
  const proj = page.locator(".proj").first();
  await setExpanded(proj, true); // 展开会话
  await proj.locator(".proj-hd-wrap .more-btn").first().click();
  const items = page.locator(".ctx-menu[role='menu'] .ctx-item");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveText(/重命名/);
  await expect(items.nth(1)).toHaveText(/归档/);
  await expect(items.nth(2)).toHaveText(/删除/);
  await page.keyboard.press("Escape"); // 项目菜单关闭后再操作会话 ⋯
  await expect(page.locator(".ctx-menu[role='menu']")).toBeHidden();
  const convMore = proj.locator(".proj-convs .more-btn").first();
  await convMore.click();
  const menu = page.locator(".ctx-menu[role='menu']");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("重命名");
});

/* ────────────── §4.2 信息版：完整度提示 + 双 Tab（替代旧建议卡） ────────────── */

test("信息完整度状态行：只说明缺口，不出现建议档位与判定", async ({ page }) => {
  const bar = page.locator(".ws .completeness-bar").first();
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(/信息完整度 \d+\/\d+ 张表/);
  // 产品不产出判断：整页不应出现建议档位或"通过/不通过"
  const body = await page.locator(".ws").innerText();
  expect(body).not.toMatch(/建议(通过|有条件通过|不通过|进)/);
  expect(body).not.toContain("质量关");
});

test("右栏双 Tab：补充说明（含确认清单）/ 阶段总结", async ({ page }) => {
  const tabs = page.locator(".det .det-tab");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(0)).toContainText("补充说明");
  await expect(tabs.nth(1)).toContainText("阶段总结");

  // Tab ①：确认清单（L1 场景本体必确认）
  await tabs.nth(0).click();
  await expect(page.locator(".det .confirm-list")).toBeVisible();
  await expect(page.locator(".det .layer-L1").first()).toBeVisible();
  const l1Count = await page.locator(".det .layer-L1").count();
  expect(l1Count).toBeGreaterThanOrEqual(6); // 表1-1 的 6 项必确认

  // Tab ②：阶段总结六段骨架
  await tabs.nth(1).click();
  const md = page.locator(".det .md-body");
  await expect(md).toBeVisible();
  await expect(md).toContainText("信息摘要");
  await expect(md).toContainText("信息缺口与待补充");
});

test("表1-1 场景锚常驻且带必确认标记", async ({ page }) => {
  const anchor = page.locator(".ws .schema-table--anchor").first();
  await expect(anchor).toBeVisible();
  await expect(anchor.locator("th").first()).toHaveText("项");
  // 6 项 L1 必确认带 ✓ 标记
  const confirmDots = await anchor.locator(".confirm-dot").count();
  expect(confirmDots).toBeGreaterThanOrEqual(6);
});

test("随时回看任意阶段：阶段 Tab 切换（断点续做的 UI 侧）", async ({ page }) => {
  const tabs = page.locator(".stabs").getByRole("tab");
  await expect(tabs).toHaveCount(8);
  await page.getByRole("tab", { name: /门槛/ }).click();
  await expect(page.getByRole("tab", { name: /门槛/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".ws .pnl").first()).toBeVisible();
});

test("随时回编辑：关键表格单元格可逐格编辑，失焦后值保留", async ({ page }) => {
  // 阶段 0 表格：可编辑单元格存在
  await page.getByRole("tab", { name: /材料/ }).click();
  const cell = page.locator(".ed").first();
  await expect(cell).toHaveAttribute("contenteditable", "true");
  // 资料库 M1 清单：编辑落到数据（handleCellChange 实链路）
  await page.getByRole("button", { name: "产品资料库" }).click();
  const m1 = page.locator(".ed").first();
  await m1.click();
  await m1.evaluate((el) => {
    el.textContent = "自动化改值";
  });
  await m1.blur();
  await expect(m1).toHaveText("自动化改值");
});

/* ───────────────────── §4.2 列宽与收起（偏离 #1/#2 已批准配方） ───────────────────── */

async function widthOf(loc: import("@playwright/test").Locator) {
  return loc.evaluate((el) => el.getBoundingClientRect().width);
}

test("左栏可拖宽：跟手 + 上限 320 钳制", async ({ page }) => {
  const side = page.locator(".side");
  const w0 = await widthOf(side);
  expect(Math.round(w0)).toBe(256); // 默认宽
  const rz = (await page.locator(".col-resizer--side").boundingBox())!;
  await page.mouse.move(rz.x + rz.width / 2, rz.y + 200);
  await page.mouse.down();
  await page.mouse.move(rz.x + 40 + rz.width / 2, rz.y + 200, { steps: 4 });
  await page.mouse.up();
  expect(Math.round(await widthOf(side))).toBe(296);
  // 继续大拖幅 → 钳制在 320
  const rz2 = (await page.locator(".col-resizer--side").boundingBox())!;
  await page.mouse.move(rz2.x + rz2.width / 2, rz2.y + 200);
  await page.mouse.down();
  await page.mouse.move(rz2.x + 400, rz2.y + 200, { steps: 6 });
  await page.mouse.up();
  expect(await widthOf(side)).toBeLessThanOrEqual(321);
});

test("右栏可拖宽：反向跟手 + 上限 480 钳制", async ({ page }) => {
  const det = page.locator(".det");
  const w0 = await widthOf(det);
  expect(Math.round(w0)).toBe(280);
  const rz = (await page.locator(".col-resizer--det").boundingBox())!;
  await page.mouse.move(rz.x + rz.width / 2, rz.y + 200);
  await page.mouse.down();
  await page.mouse.move(rz.x - 100 + rz.width / 2, rz.y + 200, { steps: 4 });
  await page.mouse.up();
  expect(Math.round(await widthOf(det))).toBe(380);
});

test("列宽刷新后保留（localStorage）", async ({ page }) => {
  const rz = (await page.locator(".col-resizer--side").boundingBox())!;
  await page.mouse.move(rz.x + rz.width / 2, rz.y + 200);
  await page.mouse.down();
  await page.mouse.move(rz.x + 60, rz.y + 200, { steps: 4 });
  await page.mouse.up();
  const w = await widthOf(page.locator(".side"));
  await page.reload();
  expect(Math.abs((await widthOf(page.locator(".side"))) - w)).toBeLessThanOrEqual(1);
});

test("缘收起柄：层级高于热区，四态布局可切换", async ({ page }) => {
  const railZ = await page.locator(".col-resizer--side").evaluate((el) => getComputedStyle(el).zIndex);
  const toggleZ = await page.locator(".edge-toggle--side").evaluate((el) => getComputedStyle(el).zIndex);
  expect(Number(toggleZ)).toBeGreaterThan(Number(railZ));

  // 全展开 → 左收
  await page.locator(".edge-toggle--side").click();
  await expect(page.locator(".shell")).toHaveClass(/side-collapsed/);
  expect(await widthOf(page.locator(".side"))).toBe(0);
  // 左收 → 双收
  await page.locator(".edge-toggle--det").click();
  await expect(page.locator(".shell")).toHaveClass(/det-collapsed/);
  expect(await widthOf(page.locator(".det"))).toBe(0);
  // 双收 → 恢复全展开
  await page.locator(".edge-toggle--side").click();
  await page.locator(".edge-toggle--det").click();
  expect(await widthOf(page.locator(".side"))).toBeGreaterThan(200);
  expect(await widthOf(page.locator(".det"))).toBeGreaterThan(240);
});

test("收起态下拖拽热区隐藏（不可误拖）", async ({ page }) => {
  await page.locator(".edge-toggle--side").click();
  await expect(page.locator(".col-resizer--side")).toBeHidden();
});

/* ───────────────────── §11.3 决定与反馈（Toast） ───────────────────── */

test("可点击元素键盘可达：Tab 聚焦显示焦点环（2px 内缩）", async ({ page }) => {
  await page.locator(".conv-ta").blur().catch(() => {});
  await page.keyboard.press("Tab");
  const ring = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { tag: el.tagName, width: cs.outlineWidth, offset: cs.outlineOffset, style: cs.outlineStyle };
  });
  expect(ring).not.toBeNull();
  expect(ring!.tag).toBe("BUTTON"); // 可点元素一律 <button>
  expect(ring!.width).toBe("2px");
  expect(ring!.offset).toBe("-2px"); // 焦点环内缩于元素边界
  expect(ring!.style).not.toBe("none");
});

test("设置保存给出 Toast 反馈", async ({ page }) => {
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".toast-item")).toContainText("已保存模型配置");
});
