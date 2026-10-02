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

test("信息完整度状态行：只说产出进度，不出现建议档位与判定", async ({ page }) => {
  // 完整度只出现在**右栏**（中栏只放信息表）；同一信息不得两栏重复
  await gotoStep2(page);
  const bar = page.locator(".det .completeness-bar").first();
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(/信息完整度 \d+\/\d+ 张表/);
  // 产品不产出判断：整页不应出现建议档位或"通过/不通过"
  const body = await page.locator(".ws").innerText();
  expect(body).not.toMatch(/建议(通过|有条件通过|不通过|进)/);
  expect(body).not.toContain("质量关");
});

test("右栏双 Tab：补充说明 / 阶段总结（确认清单与缺口清单已整块删除）", async ({ page }) => {
  await gotoStep2(page);
  const tabs = page.locator(".det .det-tab");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(0)).toContainText("补充说明");
  await expect(tabs.nth(1)).toContainText("阶段总结");

  // Tab ①：只剩中栏表格的补充说明；**没有**确认清单，也没有缺口清单
  await tabs.nth(0).click();
  await expect(page.locator(".det .confirm-list")).toHaveCount(0);
  await expect(page.locator(".det .gap-list")).toHaveCount(0);
  await expect(page.locator(".det")).not.toContainText("待确认");
  await expect(page.locator(".det")).not.toContainText("缺口");

  // Tab ②：阶段总结默认折叠（首段 + 一句），点「展开全文」才渲染六段骨架
  await tabs.nth(1).click();
  await expect(page.locator(".det .md-body")).toHaveCount(0);
  // 按钮文案随状态变（展开全文⇄收起），所以按类名定位而不是按文案
  const foldToggle = page.locator(".det .fold-toggle");
  await expect(foldToggle).toContainText("展开全文");
  await expect(foldToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".det .fold-summary")).toContainText("本阶段要获得的信息是");
  await foldToggle.click();
  await expect(foldToggle).toHaveAttribute("aria-expanded", "true");
  const md = page.locator(".det .md-body");
  await expect(md).toBeVisible();
  await expect(md).toContainText("信息摘要");
  await expect(md).toContainText("待补齐信息");
});

test("表1-1 只有「项 / 内容」两列：无状态列、无 ✓、无待确认", async ({ page }) => {
  const anchor = page.locator(".ws .schema-table--anchor").first();
  await expect(anchor).toBeVisible();
  await expect(anchor.locator("th")).toHaveCount(2);
  await expect(anchor.locator("th").first()).toHaveText("项");
  await expect(anchor.locator("th").nth(1)).toHaveText("内容");
  await expect(anchor.locator(".confirm-dot")).toHaveCount(0);
  await expect(anchor.locator(".state-badge")).toHaveCount(0);
  // 唯一由用户输入的项被标出来（产品的属主划分要看得见）
  await expect(anchor.locator(".owner-tag")).toHaveCount(1);
});

test("流程轴：8 个节点、当前步高亮、未解锁不可点（v1.5 取代阶段 Tab）", async ({ page }) => {
  const rail = page.locator(".flow-rail");
  await expect(rail).toBeVisible();
  const nodes = rail.getByRole("tab");
  await expect(nodes).toHaveCount(8);

  // 当前步唯一且高亮；初始 0 步完成 → 第 1 步是当前步，其余锁着
  await expect(rail.locator(".flow-node--current")).toHaveCount(1);
  await expect(rail.locator(".flow-node--current")).toHaveAttribute("aria-selected", "true");
  await expect(rail.locator(".flow-node--current")).toContainText("场景定义与边界");
  await expect(rail.locator(".flow-node--done")).toHaveCount(0);
  await expect(rail.locator(".flow-node--locked")).toHaveCount(7);
  await expect(nodes.nth(1)).toBeDisabled();
  await expect(nodes.nth(1)).toHaveAttribute("aria-label", /认识场景/);

  // 当前步的 readyHint 直接显示在轴上；新场景只有场景名称 → 画像还没写出 → 未就绪
  await expect(rail.locator(".flow-hint")).toContainText("第 1/8 步");
  await expect(rail.locator(".flow-hint")).toContainText("场景业务画像");
  await expect(rail.getByRole("button", { name: "完成本步，进入下一步" })).toBeDisabled();
  await expect(page.locator(".ws .pnl").first()).toBeVisible();

  // 智能体写出画像之后 → 就绪可推进（不要求用户逐项确认）
  await draftDefinition(page);
  await expect(rail.locator(".flow-hint")).toContainText("场景业务画像已写出");
  await expect(rail.getByRole("button", { name: "完成本步，进入下一步" })).toBeEnabled();
});

test("流程推进：完成本步 → 当前步前移；已完成步可回看重跑", async ({ page }) => {
  const rail = page.locator(".flow-rail");
  const completeBtn = rail.getByRole("button", { name: "完成本步，进入下一步" });

  // 第 1 步就绪口径 = 「智能体写出业务画像」：先让智能体写出来，再推进
  await draftDefinition(page);
  await expect(rail.locator(".flow-hint")).toContainText("场景业务画像已写出");
  await expect(completeBtn).toBeEnabled();
  await completeBtn.click();

  await expect(rail.locator(".flow-node--done")).toHaveCount(1);
  await expect(rail.locator(".flow-node--done")).toContainText("场景定义与边界");
  await expect(rail.locator(".flow-node--current")).toContainText("认识场景");
  await expect(rail.locator(".flow-node--locked")).toHaveCount(6);
  // 第 2 步「认识场景」：中栏只有本步表集（步标题/完整度都在别处）
  await expect(page.locator(".ws .table-chips").first()).toBeVisible();
  await expect(page.locator(".ws .completeness-bar")).toHaveCount(0);

  // 点已完成节点回看：显示该步内容 + 「回到这一步重跑」
  await rail.getByRole("tab", { name: /^第 1 步 · 场景定义与边界（/ }).click();
  await expect(rail.locator(".flow-hint")).toContainText("正在回看第 1 步");
  await expect(page.locator(".flow-reopen")).toBeVisible();
  await page.getByRole("button", { name: "回到这一步重跑" }).click();
  await expect(rail.locator(".flow-node--current")).toContainText("场景定义与边界");
  await expect(rail.locator(".flow-node--done")).toHaveCount(0);
  await expect(rail.locator(".flow-node--locked")).toHaveCount(7);
});

test("解锁全部步骤：未解锁节点可点，可直接跳到任一步", async ({ page }) => {
  const rail = page.locator(".flow-rail");
  await rail.getByRole("button", { name: "解锁全部步骤" }).click();
  await expect(rail.locator(".flow-node--locked")).toHaveCount(0);
  await expect(rail.getByRole("button", { name: "已解锁全部步骤" })).toBeDisabled();

  // 不按顺序直接跳到第 3 步「理解商业」；当前步仍是第 1 步，轴给出回到当前步的入口
  await rail.getByRole("tab", { name: /理解商业/ }).click();
  await expect(rail.locator(".flow-node--current")).toContainText("场景定义与边界");
  await expect(rail.getByRole("button", { name: /回到当前步/ })).toBeVisible();
  await expect(page.locator(".ws .completeness-bar")).toHaveCount(0);

  // 第 8 步交付物（最后一步）：列出 8 步状态 + 导出按钮；右栏是交付物说明
  await rail.getByRole("tab", { name: /交付物/ }).click();
  await expect(page.locator(".ws .delivery-panel")).toBeVisible();
  await expect(page.locator(".ws .delivery-step")).toHaveCount(8);
  await expect(page.locator(".ws").getByRole("button", { name: "生成并导出交付物" })).toBeVisible();
  await page.locator(".det .det-tab").nth(1).click();
  await page.locator(".det .fold-toggle").click();
  await expect(page.locator(".det .md-body")).toContainText("交付物说明");
});

/* ────── 第 1 步「场景定义与边界」：定义对话（不占步） + 表1-1（用户给名字，智能体写画像） ────── */

test("第 1 步：中栏只有表1-1；步标题/引导语/状态行/完整度/确认按钮全部消失", async ({ page }) => {
  const ws = page.locator(".ws");
  const anchor = ws.locator(".schema-table--anchor").first();

  // 中栏只有这一张表：没有步标题卡、没有引导语、没有完整度条、没有「确认无误」
  await expect(ws.locator(".definition-step")).toHaveCount(0);
  await expect(ws.locator(".completeness-bar")).toHaveCount(0);
  await expect(ws.getByRole("button", { name: "确认无误" })).toHaveCount(0);
  await expect(ws).not.toContainText("要获得的信息");
  await expect(ws).not.toContainText("待确认");
  await expect(ws).not.toContainText("待表态");
  await expect(ws).not.toContainText("项已有内容");
  await expect(ws.locator(".definition-status")).toHaveCount(0);
  await expect(ws.locator(".definition-stat")).toHaveCount(0);

  // 就绪提示只在流程轴上出现一次（不再在中栏复述）
  await expect(page.locator(".flow-rail .flow-hint")).toContainText("先说一句场景名称");

  // 不是表单：三段式字段已删除
  await expect(ws.locator(".brief-input")).toHaveCount(0);

  // 表1-1 常驻、可就地编辑：6 行都可改，只有一项由用户输入
  await expect(anchor).toBeVisible();
  await expect(anchor.locator("tbody tr")).toHaveCount(6);
  await expect(anchor.locator("input.cell-input")).toHaveCount(6);
  await expect(anchor.locator(".owner-tag")).toHaveCount(1);

  // 独立弹窗（不是中栏、不是右下角抽屉）：入口是表头右侧那个按钮
  const entry = ws.getByRole("button", { name: /场景定义对话/ });
  await entry.click();
  const dlg = page.getByRole("dialog", { name: "场景定义" });
  await expect(dlg).toBeVisible();
  await expect(dlg).toHaveAttribute("aria-modal", "true");
  await expect(dlg.locator(".definition-ta")).toBeVisible();
  await expect(dlg.getByRole("button", { name: "整理成定义" })).toBeVisible();
  // 对话流：模型先给理解再提问（左）+ 用户消息（右）
  await expect(dlg.locator(".msg.ai .bub").first()).toBeVisible();
  await expect(dlg.locator(".msg.u .bub").first()).toBeVisible();

  // 整理成定义：智能体把画像写出来 → 写表统计 + 对照结论 + 待回答问题
  await dlg.getByRole("button", { name: "整理成定义" }).click();
  await expect(dlg.locator(".definition-summary")).toContainText("更新");
  await expect(dlg.locator(".align-badge").first()).toBeVisible();
  const alignRows = await dlg.locator(".align-table tbody tr").count();
  expect(alignRows).toBeGreaterThanOrEqual(2); // 行数按返回数组，不写死
  await expect(dlg.locator(".align-questions li").first()).toBeVisible();

  // 「完成，回到第 1 步」关闭弹窗：表1-1 就地更新，画像写出 → 就绪
  await dlg.getByRole("button", { name: "完成，回到第 1 步" }).click();
  await expect(dlg).toBeHidden();
  await expect(anchor).toBeVisible();
  await expect(page.locator(".flow-rail .flow-hint")).toContainText("场景业务画像已写出");

  // 就绪即可推进：**不要求用户逐项确认**
  const completeBtn = page.locator(".flow-rail").getByRole("button", {
    name: "完成本步，进入下一步",
  });
  await expect(completeBtn).toBeEnabled();
  await expect(ws).not.toContainText("待确认");
});


test("场景定义弹窗：Esc 关闭，且关闭后第 1 步仍只剩表1-1", async ({ page }) => {
  await page.locator(".ws").getByRole("button", { name: /场景定义对话/ }).click();
  const dlg = page.getByRole("dialog", { name: "场景定义" });
  await expect(dlg).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(page.locator(".ws .schema-table--anchor")).toBeVisible();
  await expect(page.locator(".ws .definition-step")).toHaveCount(0);
});

test("随时回编辑：关键表格单元格可逐格编辑，失焦后值保留", async ({ page }) => {
  // 流程轴解锁后跳到第 2 步「认识场景」：本步表集里有可编辑单元格
  const rail = page.locator(".flow-rail");
  await rail.getByRole("button", { name: "解锁全部步骤" }).click();
  await rail.getByRole("tab", { name: /认识场景/ }).click();
  const cell = page.locator(".ws .ed").first();
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

/* ────────── 信息密度收紧：中栏表1-1 折叠 / 右栏清单不抄全文 / 完整度不再自相矛盾 ────────── */

/**
 * 演示态第 1 步就绪：打开「场景定义」对话 → 整理成定义（智能体写出业务画像）→ 关闭
 *
 * 新口径下用户只输入场景名称，**画像是智能体在「整理成定义」时写的**——
 * 所以任何要走到第 2 步的用例都得先让智能体把画像写出来（这正是产品的第一步动作）。
 */
async function draftDefinition(page: Page) {
  await page.locator(".ws").getByRole("button", { name: /场景定义对话/ }).click();
  const dlg = page.getByRole("dialog", { name: "场景定义" });
  await expect(dlg).toBeVisible();
  await dlg.getByRole("button", { name: "整理成定义" }).click();
  await expect(dlg.locator(".definition-summary")).toContainText("更新");
  await dlg.getByRole("button", { name: "完成，回到第 1 步" }).click();
  await expect(dlg).toBeHidden();
}

async function gotoStep2(page: Page) {
  // 前面的用例可能停在资料库/知识库/设置视图：先点左栏场景项回到工作台
  if ((await page.locator(".flow-rail").count()) === 0) {
    await page.locator(".side .proj-hd").first().click();
  }
  const rail = page.locator(".flow-rail");
  const unlock = rail.getByRole("button", { name: "解锁全部步骤" });
  if (await unlock.isEnabled()) await unlock.click();
  await rail.getByRole("tab", { name: /认识场景/ }).click();
  await expect(page.locator(".ws .table-chips").first()).toBeVisible();
}

test("中栏表1-1：分析步默认折叠成一行摘要，展开后仍可就地编辑", async ({ page }) => {
  await draftDefinition(page); // 先让智能体写出画像，摘要才有内容可说
  await gotoStep2(page);

  // 第 2 步默认折叠：整张表**不挂载**，只给一行摘要
  const anchorTable = page.locator(".ws .schema-table--anchor");
  await expect(anchorTable).toHaveCount(0);
  const summary = page.locator(".ws .fold-summary");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("表1-1 场景概述 · 业务画像已写 5/5 项");

  // 折叠/展开一律 <button> 且 aria-expanded 正确（键盘可达）
  // 注意：按钮文案会随状态变（展开⇄收起），断言要按类名定位而不是按文案
  const toggle = page.locator(".ws .fold-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  // 展开后能力不丢：表1-1 全文可见（六项业务画像，两列，无状态列）
  await expect(anchorTable).toBeVisible();
  await expect(anchorTable.locator("th").first()).toHaveText("项");
  await expect(anchorTable.locator("tbody tr")).toHaveCount(6);
  await expect(anchorTable.locator(".confirm-dot")).toHaveCount(0);

  // 收起回摘要态，避免影响后续用例
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(anchorTable).toHaveCount(0);
});


test("右栏不再有确认清单/缺口清单（智能体的待办不进用户界面）", async ({ page }) => {
  await gotoStep2(page);
  await page.locator(".det .det-tab").nth(0).click();

  await expect(page.locator(".det .confirm-list")).toHaveCount(0);
  await expect(page.locator(".det .gap-list")).toHaveCount(0);
  await expect(page.locator(".det .det-foot")).toHaveCount(0);
  const text = await page.locator(".det").innerText();
  expect(text).not.toContain("待确认");
  expect(text).not.toContain("缺口");
  expect(text).not.toContain("表态");
});


test("右栏完整度状态行不再喊「缺口 N 项」", async ({ page }) => {
  await gotoStep2(page);
  const bar = page.locator(".det .completeness-bar").first();
  await expect(bar).toContainText("信息完整度");
  const text = await bar.innerText();
  expect(text).not.toContain("缺口");
  expect(text).not.toContain("不阻断");
});
