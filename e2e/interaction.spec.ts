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

  // Tab ②：本步总结默认折叠（首段 + 一句），点「展开全文」才渲染五段骨架
  await tabs.nth(1).click();
  await expect(page.locator(".det .md-body")).toHaveCount(0);
  // 按钮文案随状态变（展开全文⇄收起），所以按类名定位而不是按文案
  const foldToggle = page.locator(".det .fold-toggle");
  await expect(foldToggle).toContainText("展开全文");
  await expect(foldToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".det .fold-summary")).toContainText("本步要获得的信息是");
  await foldToggle.click();
  await expect(foldToggle).toHaveAttribute("aria-expanded", "true");
  const md = page.locator(".det .md-body");
  await expect(md).toBeVisible();
  await expect(md).toContainText("信息摘要");
  await expect(md).toContainText("待补齐信息");
  // 只讲本步：不带用户诉求全文、不带上下游衔接（用户定调"不要整理整个过程"）
  await expect(md).not.toContainText("用户诉求");
  await expect(md).not.toContainText("上下游衔接");
});

test("右栏核实段：每条信息给出核实结论与「准确·客观·为什么」，不挤进补充说明表", async ({ page }) => {
  await gotoStep2(page);
  const det = page.locator(".det");
  // 补充说明表只有出处类列，核实两列**不横排**进去（否则右栏 8 列挤成 27px/列）
  const head = det.locator(".supplement-table th");
  await expect(head.filter({ hasText: "核实" })).toHaveCount(0);

  // 核实单独一段：结论可选（六档 + 未核）、说明是可编辑长文本
  const verify = det.locator(".verify-list");
  await expect(verify).toBeVisible();
  const first = verify.locator(".verify-item").first();
  await expect(first.locator(".verify-label")).not.toBeEmpty();
  const sel = first.locator("select.verify-verdict");
  await expect(sel).toHaveValue("已核实");
  await expect(sel.locator("option")).toHaveCount(7); // 未核 + 六档
  const text = first.locator("textarea.verify-text");
  await expect(text).toHaveValue(/准确：/);
  await expect(text).toHaveValue(/客观：/);
  await expect(text).toHaveValue(/为什么：/);

  // 无法核实会标黄（提示"不能当结论用"），但仍然是可编辑的输入
  const third = verify.locator(".verify-item").nth(2);
  await expect(third.locator("select.verify-verdict")).toHaveValue("无法核实");
  await expect(third.locator("select.verify-verdict")).toHaveClass(/warn/);
  await third.locator("select.verify-verdict").selectOption("已核实");
  await expect(third.locator("select.verify-verdict")).not.toHaveClass(/warn/);
});

test("中栏表格：拖分格线只与右邻列互换宽度，表宽恒等于中栏宽、无横向滚动条", async ({ page }) => {
  await gotoStep2(page);
  const table = page.locator(".ws table").first();
  const geo = () =>
    table.evaluate((el) => {
      const wrap = el.parentElement as HTMLElement;
      const ths = [...el.querySelectorAll("th")];
      return {
        cols: ths.length,
        handles: el.querySelectorAll(".th-resize").length,
        ths: ths.map((th) => Math.round(th.getBoundingClientRect().width)),
        lefts: ths.map((th) => Math.round(th.getBoundingClientRect().left)),
        tableW: Math.round(el.getBoundingClientRect().width),
        wrapW: wrap.clientWidth,
        scrollW: wrap.scrollWidth,
        /** 列宽写成百分比且**之和恰好 100%**：亚像素取整/浏览器缩放下也不会撑出中栏 */
        pctSum: [...el.querySelectorAll("col")].reduce(
          (a, c) => a + Number.parseFloat((c as HTMLElement).style.width || "0"),
          0,
        ),
        pctAll: [...el.querySelectorAll("col")].every((c) =>
          ((c as HTMLElement).style.width || "").endsWith("%"),
        ),
      };
    });
  /** 只动第 1 列的右缘（用户定调：向右调整分格线不许影响所有右边的列） */
  const dragFirst = async (dx: number) => {
    const rz = (await table.locator("th").first().locator(".th-resize").boundingBox())!;
    await page.mouse.move(rz.x + 2, rz.y + 6);
    await page.mouse.down();
    await page.mouse.move(rz.x + 2 + dx, rz.y + 6, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(120);
  };

  const g0 = await geo();
  expect(g0.cols).toBeGreaterThanOrEqual(3);
  // 手柄只装在"列与列之间"：末列右缘就是表右缘，没有边界可移
  expect(g0.handles).toBe(g0.cols - 1);
  // 初始（按内容自适应）：表宽 = 中栏宽，不出横向滚动
  expect(Math.abs(g0.tableW - g0.wrapW)).toBeLessThanOrEqual(1);
  expect(g0.scrollW).toBeLessThanOrEqual(g0.wrapW);
  // 列宽一律百分比、且之和恰好 100%（这是"绝不超出中栏"的结构性保证）
  expect(g0.pctAll).toBe(true);
  expect(g0.pctSum).toBeCloseTo(100, 2);

  // 向右拖 +70：第 1 列加 70、右邻第 2 列等量减 70；第 3 列起**宽度与位置都不动**
  await dragFirst(70);
  const g1 = await geo();
  expect(Math.abs(g1.ths[0]! - (g0.ths[0]! + 70))).toBeLessThanOrEqual(2);
  expect(Math.abs(g1.ths[1]! - (g0.ths[1]! - 70))).toBeLessThanOrEqual(2);
  for (let i = 2; i < g1.cols; i += 1) {
    expect(Math.abs(g1.ths[i]! - g0.ths[i]!), `第 ${i + 1} 列宽度不该被联动`).toBeLessThanOrEqual(1);
    expect(Math.abs(g1.lefts[i]! - g0.lefts[i]!), `第 ${i + 1} 列位置不该移动`).toBeLessThanOrEqual(1);
  }
  // 表宽不变（= 中栏宽），底部不出现横向移动条
  expect(Math.abs(g1.tableW - g0.wrapW)).toBeLessThanOrEqual(1);
  expect(g1.scrollW).toBeLessThanOrEqual(g1.wrapW);
  expect(g1.pctSum).toBeCloseTo(100, 2);

  // 一路向右拖到右邻的可读下限：到线即停，被拖列不再变宽
  await dragFirst(1200);
  const g2 = await geo();
  expect(g2.ths[1]!).toBeGreaterThanOrEqual(64);
  expect(g2.ths[1]!).toBeLessThanOrEqual(66);
  for (let i = 2; i < g2.cols; i += 1) {
    expect(Math.abs(g2.ths[i]! - g0.ths[i]!), `第 ${i + 1} 列宽度不该被联动`).toBeLessThanOrEqual(1);
    expect(Math.abs(g2.lefts[i]! - g0.lefts[i]!), `第 ${i + 1} 列位置不该移动`).toBeLessThanOrEqual(1);
  }
  expect(Math.abs(g2.tableW - g0.wrapW)).toBeLessThanOrEqual(1);
  expect(g2.scrollW).toBeLessThanOrEqual(g2.wrapW);

  // 向左拖：第 1 列变窄（到下限），空出的宽给右邻第 2 列，表宽仍等于中栏宽
  await dragFirst(-1200);
  const g3 = await geo();
  expect(g3.ths[0]!).toBeLessThan(g2.ths[0]!);
  expect(g3.ths[1]!).toBeGreaterThan(g2.ths[1]!);
  for (let i = 2; i < g3.cols; i += 1) {
    expect(Math.abs(g3.ths[i]! - g0.ths[i]!), `第 ${i + 1} 列宽度不该被联动`).toBeLessThanOrEqual(1);
  }
  expect(Math.abs(g3.tableW - g0.wrapW)).toBeLessThanOrEqual(1);
  expect(g3.scrollW).toBeLessThanOrEqual(g3.wrapW);

  // 双击分割线 → 回到按内容自适应（撤销手动列宽）
  const rz3 = (await table.locator("th").first().locator(".th-resize").boundingBox())!;
  await page.mouse.dblclick(rz3.x + 2, rz3.y + 6);
  await expect.poll(async () => (await geo()).ths[0]!).toBeGreaterThan(g3.ths[0]!);
  expect((await geo()).scrollW).toBeLessThanOrEqual((await geo()).wrapW);
});

test("中栏表格：长内容换行显示，行高随内容长（表1-1 内容格是多行编辑器）", async ({ page }) => {
  await page.locator(".side .proj-hd").first().click();
  const anchor = page.locator(".ws .schema-table--anchor").first();
  await expect(anchor).toBeVisible();

  // 就是两列（表头与表体都不该有第三个格子）
  await expect(anchor.locator("th")).toHaveCount(2);
  await expect(anchor.locator("tbody tr").first().locator("td")).toHaveCount(2);
  // 内容格是 <textarea>：单行输入框显示不了换行，行高也永远只有一行
  const ta = anchor.locator("textarea.cell-input").nth(1);
  await expect(ta).toBeVisible();
  const row = anchor.locator("tbody tr").nth(1);
  const h0 = (await row.boundingBox())!.height;

  await ta.fill(
    "客户的水厂漏损率长期偏高，夜间最小流量异常，分区计量不完整，管网台账与现场不一致；" +
      "这一格专门用来验证长内容会在格子里换行显示，而不是被截断成一行省略号。",
  );
  await ta.blur();
  await expect.poll(async () => Math.round((await row.boundingBox())!.height)).toBeGreaterThan(h0 + 20);

  // 换行显示：不横向溢出，也不在框内滚（高度按内容长满）
  const box = await ta.evaluate((el) => ({
    whiteSpace: getComputedStyle(el).whiteSpace,
    scrollW: el.scrollWidth,
    clientW: el.clientWidth,
    scrollH: el.scrollHeight,
    clientH: el.clientHeight,
  }));
  expect(box.whiteSpace).toBe("pre-wrap");
  expect(box.scrollW).toBeLessThanOrEqual(box.clientW + 1);
  expect(Math.abs(box.scrollH - box.clientH)).toBeLessThanOrEqual(2);
});

test("表1-1 只有「项 / 内容」两列：无状态列、无 ✓、无待确认", async ({ page }) => {
  const anchor = page.locator(".ws .schema-table--anchor").first();
  await expect(anchor).toBeVisible();
  await expect(anchor.locator("th")).toHaveCount(2);
  // 表体每行也只有两个格子（曾经有个隐形的"填充列"，用户一眼就看出来了）
  await expect(anchor.locator("tbody tr").first().locator("td")).toHaveCount(2);
  await expect(anchor.locator("th").first()).toHaveText("项");
  await expect(anchor.locator("th").nth(1)).toHaveText("内容");
  await expect(anchor.locator(".confirm-dot")).toHaveCount(0);
  await expect(anchor.locator(".state-badge")).toHaveCount(0);
  // 唯一由用户输入的项被标出来（产品的属主划分要看得见）
  await expect(anchor.locator(".owner-tag")).toHaveCount(1);
});

test("流程轴：7 个节点、当前步高亮、未解锁不可点（v1.5 取代阶段 Tab）", async ({ page }) => {
  const rail = page.locator(".flow-rail");
  await expect(rail).toBeVisible();
  const nodes = rail.getByRole("tab");
  await expect(nodes).toHaveCount(7);

  // 当前步唯一且高亮；初始 0 步完成 → 第 1 步是当前步，其余锁着
  await expect(rail.locator(".flow-node--current")).toHaveCount(1);
  await expect(rail.locator(".flow-node--current")).toHaveAttribute("aria-selected", "true");
  await expect(rail.locator(".flow-node--current")).toContainText("场景定义");
  await expect(rail.locator(".flow-node--done")).toHaveCount(0);
  await expect(rail.locator(".flow-node--locked")).toHaveCount(6);
  await expect(nodes.nth(1)).toBeDisabled();
  await expect(nodes.nth(1)).toHaveAttribute("aria-label", /认识场景/);

  // 进度卡只一行：7 个节点 + 行末「下一步」，没有第二行提示、没有「解锁全部步骤」
  await expect(rail.locator(".flow-hint")).toHaveCount(0);
  await expect(rail.getByRole("button", { name: /解锁/ })).toHaveCount(0);
  await expect(rail.locator(".flow-node-no")).toHaveCount(0); // 序号已去掉
  await expect(rail.locator(".flow-node-dot")).toHaveCount(0); // 圆点也不要
  // 保留关键词（用户定调）：7 个节点各显示简化标题，完整标题在 aria-label / title 里
  await expect(rail.locator(".flow-node-tt")).toHaveCount(7);
  const keywords = await rail.locator(".flow-node-tt").allTextContents();
  expect(keywords).toEqual([
    "场景定义",
    "认识场景",
    "理解商业",
    "能力匹配",
    "方案实现",
    "价值验证",
    "交付物",
  ]);
  await expect(nodes.nth(3)).toHaveAttribute("title", /第 4 步 · 能力匹配/);

  // 就绪提示不占行：它是运行按钮的悬停提示（新场景画像还没写出 → 未就绪）
  // 七步同形：未产出时主按钮位是「开始本步分析」（第 1 步也不例外，只是它打开对话）
  const start = rail.getByRole("button", { name: "开始本步分析" });
  await expect(start).toBeEnabled();
  await expect(start).toHaveAttribute("title", /场景业务画像/);
  await expect(rail.getByRole("button", { name: "下一步" })).toHaveCount(0);
  await expect(page.locator(".ws .pnl").first()).toBeVisible();

  // 智能体写出画像之后 → 主按钮位变「下一步」，另给次级「重算本步」（与认识场景同形）
  await draftDefinition(page);
  const next = rail.getByRole("button", { name: "下一步" });
  await expect(next).toBeEnabled();
  await expect(next).toHaveAttribute("title", /场景业务画像已写出/);
  await expect(rail.getByRole("button", { name: "重算本步" })).toBeVisible();
  await expect(rail.getByRole("button", { name: "开始本步分析" })).toHaveCount(0);
});

test("流程推进：完成本步 → 当前步前移；已完成步可回看重跑", async ({ page }) => {
  const rail = page.locator(".flow-rail");
  const completeBtn = rail.getByRole("button", { name: "下一步" });

  // 第 1 步就绪口径 = 「智能体写出业务画像」：先让智能体写出来，再推进
  await draftDefinition(page);
  await expect(completeBtn).toHaveAttribute("title", /场景业务画像已写出/);
  await expect(completeBtn).toBeEnabled();
  await completeBtn.click();

  await expect(rail.locator(".flow-node--done")).toHaveCount(1);
  await expect(rail.locator(".flow-node--done")).toContainText("场景定义");
  await expect(rail.locator(".flow-node--current")).toContainText("认识场景");
  await expect(rail.locator(".flow-node--locked")).toHaveCount(5);
  // 第 2 步「认识场景」：中栏只有本步表集（步标题/完整度都在别处）
  await expect(page.locator(".ws .table-chips").first()).toBeVisible();
  await expect(page.locator(".ws .completeness-bar")).toHaveCount(0);

  // 点已完成节点回看：七步同形——轴上只有「重算本步」与「下一步」，中栏没有重跑提示条，
  // 也没有「回到这一步/回到当前步」这类导航按钮（用户定调：回到哪一步直接点阶段名称）
  await rail.getByRole("tab", { name: /^第 1 步 · 场景定义与边界（/ }).click();
  await expect(page.locator(".flow-reopen")).toHaveCount(0);
  await expect(page.locator(".flow-actions button")).toHaveCount(2);
  await expect(rail.getByRole("button", { name: "重算本步" })).toBeVisible();
  const backNext = rail.getByRole("button", { name: "下一步" });
  await expect(backNext).toBeVisible();
  await expect(backNext).toBeDisabled(); // 回看中不推进
  await expect(backNext).toHaveAttribute("title", /点流程轴上的「认识场景」回到当前步/);
  await expect(rail.getByRole("button", { name: /回到/ })).toHaveCount(0);

  // 点阶段名称 = 回到哪一步：点「认识场景」就回到当前步，标记不动
  await rail.getByRole("tab", { name: /^第 2 步 · 认识场景（/ }).click();
  await expect(rail.locator(".flow-node--current")).toContainText("认识场景");
  await expect(rail.locator(".flow-node--done")).toHaveCount(1);
});

test("回看已完成步：轴上只有「正在看的那一步」有底色", async ({ page }) => {
  // 用户定调 2026-10-04：「点某个阶段查看信息……用个底色渲染标注一下，
  // 要不然都不知道当前在哪个阶段看信息」。
  // 原实现只给「可推进」的选中步底色，点已完成的步（如「能力匹配」）回看时没有任何底色。
  const rail = page.locator(".flow-rail");
  await draftDefinition(page);
  await rail.getByRole("button", { name: "下一步" }).click();
  await expect(rail.locator(".flow-node--current")).toContainText("认识场景");

  // 回看第 1 步（已完成）
  await rail.getByRole("tab", { name: /第 1 步 · 场景定义与边界/ }).click();
  await page.mouse.move(5, 850); // 移开鼠标，排除 hover 底色的干扰
  await page.waitForTimeout(250);

  const tinted = await rail.locator(".flow-node").evaluateAll((nodes) =>
    nodes
      .filter((n) => getComputedStyle(n).backgroundColor !== "rgba(0, 0, 0, 0)")
      .map((n) => n.textContent?.trim()),
  );
  expect(tinted).toEqual(["场景定义"]); // 有且只有正在看的那一步

  // 当前步（认识场景）改用描边表达，不再抢底色
  const current = rail.locator(".flow-node--current");
  await expect(current).toContainText("认识场景");
  expect(
    await current.evaluate((n) => ({
      bg: getComputedStyle(n).backgroundColor,
      border: getComputedStyle(n).borderColor,
    })),
  ).toEqual({ bg: "rgba(0, 0, 0, 0)", border: "rgb(37, 99, 235)" });
});

test("锁步推进：没有「解锁全部步骤」，未解锁节点点不动", async ({ page }) => {
  const rail = page.locator(".flow-rail");
  // 用户定调：不需要「解锁全部步骤」这个功能
  await expect(rail.getByRole("button", { name: /解锁/ })).toHaveCount(0);

  // 第 2 步锁着，点了也不动（disabled 不进 Tab 序列，也不响应点击）
  const second = rail.getByRole("tab", { name: /认识场景/ });
  await expect(second).toBeDisabled();
  await second.click({ force: true }).catch(() => undefined);
  await expect(rail.locator(".flow-node--current")).toContainText("场景定义");

  // 完成第 1 步后第 2 步才开；此时仍没有解锁入口
  await draftDefinition(page);
  await rail.getByRole("button", { name: "下一步" }).click();
  await expect(rail.locator(".flow-node--current")).toContainText("认识场景");
  await expect(rail.locator(".flow-node--locked")).toHaveCount(5); // 第 3-7 步
  await expect(rail.getByRole("button", { name: /解锁/ })).toHaveCount(0);

  // 回看第 1 步：点阶段名称即可来回，轴上不留导航按钮；不出现完整度条（完整度只在右栏）
  await rail.getByRole("tab", { name: /^第 1 步 · 场景定义与边界（/ }).click();
  await expect(page.locator(".ws .schema-table--anchor")).toBeVisible(); // 中栏回到表1-1
  await expect(page.locator(".ws .completeness-bar")).toHaveCount(0);
  await expect(rail.getByRole("button", { name: /回到/ })).toHaveCount(0);

  // 点回当前步的阶段名称后，第 7 步交付物仍锁着（锁步推进）
  await rail.getByRole("tab", { name: /^第 2 步 · 认识场景（/ }).click();
  await expect(rail.getByRole("tab", { name: /交付物/ })).toBeDisabled();
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

  // 就绪提示不占行：它是流程轴运行按钮的悬停提示（也不在中栏复述）
  // 七步同形：第 1 步未产出时主按钮位是「开始本步分析」（点了打开场景定义对话）
  await expect(page.locator(".flow-rail .flow-hint")).toHaveCount(0);
  const start = page.locator(".flow-actions").getByRole("button", { name: "开始本步分析" });
  await expect(start).toHaveAttribute("title", /先说一句场景名称|场景业务画像/);

  // 不是表单：三段式字段已删除
  await expect(ws.locator(".brief-input")).toHaveCount(0);

  // 表1-1 常驻、可就地编辑：6 行都可改，只有一项由用户输入
  await expect(anchor).toBeVisible();
  await expect(anchor.locator("tbody tr")).toHaveCount(6);
  // 内容格是**可换行**的多行编辑器（textarea）：长内容不截断、行高随内容长
  await expect(anchor.locator(".cell-input")).toHaveCount(6);
  await expect(anchor.locator("textarea.cell-input")).toHaveCount(6);
  await expect(anchor.locator(".owner-tag")).toHaveCount(1);

  // 独立弹窗（不是中栏、不是右下角抽屉）：入口是流程轴上的本步运行按钮（八步同形）
  const entry = page.locator(".flow-actions").getByRole("button", { name: /开始本步分析|重算本步/ });
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
  await expect(
    page.locator(".flow-rail").getByRole("button", { name: "下一步" }),
  ).toHaveAttribute("title", /场景业务画像已写出/);

  // 就绪即可推进：**不要求用户逐项确认**
  const completeBtn = page.locator(".flow-rail").getByRole("button", {
    name: "下一步",
  });
  await expect(completeBtn).toBeEnabled();
  await expect(ws).not.toContainText("待确认");
});


test("场景定义弹窗：Esc 关闭，且关闭后第 1 步仍只剩表1-1", async ({ page }) => {
  await page.locator(".flow-actions").getByRole("button", { name: /开始本步分析|重算本步/ }).click();
  const dlg = page.getByRole("dialog", { name: "场景定义" });
  await expect(dlg).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(page.locator(".ws .schema-table--anchor")).toBeVisible();
  await expect(page.locator(".ws .definition-step")).toHaveCount(0);
});

test("随时回编辑：关键表格单元格可逐格编辑，失焦后值保留", async ({ page }) => {
  // 推进到第 2 步「认识场景」：本步表集里有可编辑单元格
  await gotoStep2(page);
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
  await page.locator(".flow-actions").getByRole("button", { name: /开始本步分析|重算本步/ }).click();
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
  // 锁步推进（没有「解锁全部」）：第 1 步未产出时主按钮位是「开始本步分析」，
  // 先让智能体写出画像（八步同形后不再有常驻的「下一步」）
  if ((await rail.getByRole("button", { name: "下一步" }).count()) === 0) {
    await draftDefinition(page);
  }
  const next = rail.getByRole("button", { name: "下一步" });
  await expect(next).toBeEnabled();
  await next.click();
  await expect(page.locator(".ws .table-chips").first()).toBeVisible();
}

test("八步同形：第 1 步的动作也在流程轴上，中栏不留按钮、不留「回到这一步重跑」提示条", async ({
  page,
}) => {
  const actions = page.locator(".flow-actions");
  // 未产出：主按钮位是「开始本步分析」（与认识场景一字不差），中栏没有「场景定义对话」按钮
  await expect(actions.getByRole("button", { name: "开始本步分析" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "重算本步" })).toHaveCount(0);
  await expect(page.locator(".ws").getByRole("button", { name: /场景定义对话/ })).toHaveCount(0);
  await expect(page.locator(".flow-reopen")).toHaveCount(0);

  // 点流程轴上的运行按钮 → 打开场景定义对话（动作在轴上，中栏只放表）
  await actions.getByRole("button", { name: "开始本步分析" }).click();
  const dlg = page.getByRole("dialog", { name: "场景定义" });
  await expect(dlg).toBeVisible();
  await dlg.getByRole("button", { name: "整理成定义" }).click();
  await expect(dlg.locator(".definition-summary")).toContainText("更新");
  await dlg.getByRole("button", { name: "完成，回到第 1 步" }).click();
  await expect(dlg).toBeHidden();

  // 已产出：次级「重算本步」+ 主按钮「下一步」，与认识场景完全同形
  await expect(actions.getByRole("button", { name: "重算本步" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "下一步" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "开始本步分析" })).toHaveCount(0);
});

test("分析步中栏：只有一行表名 + 表格，且不出现上一步的表1-1、不出现动作按钮", async ({ page }) => {
  await draftDefinition(page); // 先让智能体写出画像，才走得到第 2 步
  await gotoStep2(page);

  // ① 上一步的表1-1 场景概述不在这一步出现（要回看自己回去看）
  await expect(page.locator(".ws .schema-table--anchor")).toHaveCount(0);
  await expect(page.locator(".ws .fold-summary")).toHaveCount(0);
  await expect(page.locator(".ws .fold-toggle")).toHaveCount(0);

  // ② 「本步信息表」这种小标题不要；表名一行放下，且不带表号
  await expect(page.getByText("本步信息表")).toHaveCount(0);
  const chips = page.locator(".ws .table-chips").first().locator(".chip");
  await expect(chips.first()).toBeVisible();
  const names = await chips.allInnerTexts();
  expect(names.length).toBeGreaterThan(0);
  for (const n of names) {
    expect(n).not.toMatch(/表\d+-\d+/); // 表号什么的不需要
    expect(n.trim()).not.toMatch(/^\d+$/);
  }

  // ③ 中栏没有动作按钮：分析与推进都在流程轴上
  await expect(page.locator(".ws").getByRole("button", { name: /开始本步分析|重算本步分析|完成本步/ })).toHaveCount(0);
  await expect(page.locator(".flow-actions").getByRole("button", { name: /下一步|开始本步分析|重算本步/ })).toHaveCount(1);
});



/**
 * 列宽自动适配（用户定调 2026-10-02）
 *
 * 「每个表格生成时调整列宽到行高最小的状态，别让用户自己一个个调整」
 * 断言口径：① 每张表挂上来就已是适配结果（无 120px 兜底、无横向滚动条）；
 * ② **自动适配的宽不写 localStorage**（旧实现把它当"用户手动宽度"存下来，于是
 * 内容更新后仍沿用旧宽，用户只能一列列拖）；③ 用户拖过才留存，双击恢复自适应。
 */
test("表格列宽自动适配：生成即是最紧凑布局，未手动拖就不留存", async ({ page }) => {
  await draftDefinition(page);
  await gotoStep2(page);

  const read = () =>
    page.evaluate(() => {
      const table = document.querySelector(".ws table") as HTMLTableElement | null;
      if (!table) return null;
      const ths = [...table.querySelectorAll("thead th")];
      const wrap = table.closest(".tw") as HTMLElement;
      const widths = ths.map((th) => Math.round(th.getBoundingClientRect().width));
      return {
        widths,
        container: wrap.clientWidth,
        scroll: table.scrollWidth > wrap.clientWidth + 1,
        stored: Object.keys(window.localStorage).filter((k) => k.startsWith("scene.colwidths")),
      };
    });

  // ① 数据刚由「下一步」触发的本步分析写进来，表格**已经**是适配结果（这就是"生成时"）
  //    表格可能比表名一行晚一拍出现，等它挂上来再读（否则读到空面板）
  await page.locator(".ws table").first().waitFor({ timeout: 10_000 });
  const generated = (await read())!;
  expect(generated.widths.length).toBeGreaterThan(1);
  expect(generated.widths.some((w) => w !== 120)).toBe(true); // 不是整表掉回兜底宽
  const firstChip = page.locator(".ws .table-chips").first().locator(".chip").first();
  await firstChip.click();
  await page.waitForTimeout(300);

  const fitted = (await read())!;
  expect(fitted.widths.length).toBeGreaterThan(1);
  // 每列都在可读下限之上
  for (const w of fitted.widths) expect(w).toBeGreaterThanOrEqual(64);
  // 列宽之和 ≤ 中栏宽（末列承接余量），因此不出现横向滚动条
  expect(fitted.widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(fitted.container + 1);
  expect(fitted.scroll).toBe(false);
  // 列宽各不相同：按内容分配，不是平均分也不是兜底宽
  expect(new Set(fitted.widths).size).toBeGreaterThan(1);
  // **自动适配不留存**
  expect(fitted.stored).toEqual([]);

  // 用户手动拖第一列的分割线 → 只有这一列变宽，且此时才留存
  const resize = page.locator(".ws .th-resize").first();
  const box = (await resize.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const dragged = (await read())!;
  expect(dragged.widths[0]!).toBeGreaterThan(fitted.widths[0]!);
  expect(dragged.stored.length).toBe(1);

  // 双击分割线：回到按内容自适应（撤销手动列宽并清掉留存）
  await resize.dblclick();
  await page.waitForTimeout(300);
  const reset = (await read())!;
  expect(reset.stored).toEqual([]);
  expect(reset.widths[0]!).toBeLessThan(dragged.widths[0]!);
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

test("第 1 步「整理成定义」结果里带生成后自检（真实吗·客观吗·有价值吗）", async ({ page }) => {
  // G-R8：自检是生成过程的固定环节——第 1 步同样是"生成"，界面上必须看得见它跑过
  await page.goto("/");
  await page.locator(".flow-actions").getByRole("button", { name: /开始本步分析|重算本步/ }).click();
  const dlg = page.getByRole("dialog", { name: "场景定义" });
  await expect(dlg).toBeVisible();
  await dlg.getByRole("button", { name: "整理成定义" }).click();
  // 结果区：写表统计之后紧跟一行自检（检了多少项 / 自动改正多少项）
  await expect(dlg.getByText(/生成后自检/)).toBeVisible();
  await expect(dlg.getByText(/检\s*\d+\s*项/)).toBeVisible();
});

