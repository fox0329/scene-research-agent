# 场景通-L1-Demo-PPT - Design Spec

> Human-readable design narrative. Machine-readable execution contract: `spec_lock.md`.

## I. Project Information

| Item | Value |
| ---- | ----- |
| **Project Name** | 场景通-L1-Demo-PPT |
| **Canvas Format** | PPT 16:9 (1280×720) |
| **Page Count** | 10 |
| **Design Style** | B) General Consulting + 拓维信息蓝色扁平商务 |
| **Target Audience** | L1 内部评委（产品/业务/技术） |
| **Use Case** | 内部 L1 产品 Demo 评审，10 页主 deck |
| **Created Date** | 2026-10-27 |

---

## II. Canvas Specification

| Property | Value |
| -------- | ----- |
| **Format** | PPT 16:9 |
| **Dimensions** | 1280×720 |
| **viewBox** | `0 0 1280 720` |
| **Margins** | 左右 52px，上 36px，下 40px |
| **Content Area** | x=52..1228，y=110..640；底部结论条 y=656..720 |

---

## III. Visual Theme

### Theme Style

- **Style**: 拓维信息蓝色扁平商务；B2B 产品评审，截图为主、结构图为辅
- **Theme**: Light
- **Tone**: 克制、清楚、可信；不做发布会式大字，不堆装饰

### Color Scheme

| Role | HEX | Purpose |
| ---- | --- | ------- |
| **Background** | `#FFFFFF` | 页面白底 |
| **Secondary bg** | `#F9FAFB` | 卡片浅灰底 |
| **Primary** | `#0070C0` | 卡片头、强调文字、底部结论条、数字 |
| **Deep** | `#1D2A8C` | 页标题、左上 chrome 竖条、深色文字 |
| **Accent Green** | `#22943A` | chrome 绿色方块、可替换层标识 |
| **Accent Cyan** | `#007BC6` | 小面积辅助强调 |
| **Body text** | `#404040` | 正文 |
| **Dark text** | `#0D0D0D` | 大标题/导语 |
| **Secondary text** | `#6B7280` | 图注、说明 |
| **Border/divider** | `#D6E7F8` | 截图边框、分隔线 |

> 模板锁定：主蓝 `#0070C0`、深蓝 `#1D2A8C`、绿 `#22943A`；扁平实色，不用渐变（封面/结尾遮罩除外）。

### Gradient Scheme

不使用装饰渐变。封面仅用 `#1D2A8C` 60% 半透明遮罩压暗截图，保证白字可读。

---

## IV. Typography System

**Typography direction**: 中文黑体为主，扁平商务；标题与正文同一家族，靠字重和字号拉开层级。

| Role | Chinese | English | Fallback tail |
| ---- | ------- | ------- | ------------- |
| **Title** | `"Microsoft YaHei", "PingFang SC"` | `Arial` | `sans-serif` |
| **Body** | `"Microsoft YaHei", "PingFang SC"` | `Arial` | `sans-serif` |
| **Emphasis** | `"Microsoft YaHei", "PingFang SC"` | `Arial` | `sans-serif` |
| **Code** | — | `Consolas, "Courier New"` | `monospace` |

**Per-role font stacks**

- Title: `"Microsoft YaHei", "PingFang SC", Arial, sans-serif`
- Body: `"Microsoft YaHei", "PingFang SC", Arial, sans-serif`
- Emphasis: same as Body
- Code: `Consolas, "Courier New", monospace`

> 模板 precedence：使用模板的微软雅黑/苹方栈；PPT-safe，Windows/macOS 均可回退。

**Baseline**: Body = 20px（中等密度）。

| Purpose | Ratio | Size | Weight |
| ------- | ----- | ---- | ------ |
| Cover title | 3.2× | 64px | Bold |
| Page title | 1.6× | 32px | Bold |
| Subtitle | 1.1× | 22px | SemiBold |
| Body | 1× | 20px | Regular |
| Annotation | 0.7× | 14px | Regular |
| Hero number | 2.8× | 56px | Bold |

Formula policy: `text-only`（本 deck 无公式）。

---

## V. Layout Principles

### Page Structure

- **Header**: y=0..100；左上 chrome 竖条 + 绿方块 + 右上 logo；标题 x=52,y=62。
- **Content**: y=110..640；左右安全边 52px。
- **Footer**: 底部 `#0070C0` 结论条 y=656..720，白字；右下角页码。

### Layout Patterns

- P1：全幅截图 + 深蓝遮罩 + 居中标题（模板 cover）。
- P2：三栏问题卡（无截图），底部结论条。
- P3：横向 6 步流程 + 步骤轴截图条。
- P4：左文右图，两图上下叠。
- P5：上流程、下两图并排。
- P6：左文右图，表格 + 来源面板叠放。
- P7：左右对比，中间箭头。
- P8：三张产物卡，每卡一图。
- P9：三组价值数字 + 工作台背景弱化。
- P10：四层架构图 + 三个工作类型卡（补充页）。

### Spacing

- 安全边 52px；内容块间距 24px；卡片间距 24px；卡片内边距 24px；圆角 12px。
- 截图边框 1px `#D6E7F8`，圆角 8px；截图不叠字。

---

## VI. Icon Usage Specification

- **Library**: `tabler-outline`，stroke 2px，少量使用。
- **Inventory**: `arrow-right`, `check`, `database`, `file-text`, `route`, `layout-grid`
- 主要用于 P2/P3/P10 的流程箭头和小标签；截图页不加大图标。

| Purpose | Icon Path | Page |
| ------- | --------- | ---- |
| 流程箭头 | `tabler-outline/arrow-right` | P3, P10 |
| 结果/勾选 | `tabler-outline/check` | P8, P9 |
| 资料库 | `tabler-outline/database` | P4 |
| 文件/交付物 | `tabler-outline/file-text` | P8 |
| 方法/步骤 | `tabler-outline/route` | P3 |
| 结构/平台 | `tabler-outline/layout-grid` | P10 |

---

## VII. Visualization Reference List

本 deck 无数据图表；P3 的 6 步流程与 P10 的四层架构为原生 SVG 结构图，不套 charts 模板。`no-template-match`，由 Executor 按 §IX 绘制。

---

## VIII. Image Resource List

| Filename | Dimensions | Ratio | Purpose | Type | Layout pattern | Acquire Via | Status | Reference | text_policy | page_role |
| -------- | --------- | ----- | ------- | ---- | -------------- | ----------- | ------ | --------- | ----------- | --------- |
| P1-workbench.png | 1600×900 | 1.78 | 封面/价值页工作台背景 | Screenshot | #1 full-bleed background with floating title | user | Existing | 场景通工作台全貌 | | |
| P3-steps.png | 1350×120 | 11.25 | 6 步流程轴 | Screenshot | #14 horizontal banner strip cutting through mid-section | user | Existing | 产品 6 步流程轴 | | |
| P4-library.png | 1600×900 | 1.78 | 产品资料库列表 | Screenshot | #53 vertical image stack | user | Existing | 资料库主视图 | | |
| P4-library-detail.png | 1100×720 | 1.53 | 产品清单/条目表 | Screenshot | #53 vertical image stack | user | Existing | 资料条目局部 | | |
| P5-new-scene.png | 1600×900 | 1.78 | 新建场景弹窗 | Screenshot | #19 image floating in whitespace with thin frame and caption | user | Existing | 新建场景入口 | | |
| P5-table1.png | 1050×650 | 1.62 | 表 1-1 场景概述 | Screenshot | #19 image floating in whitespace with thin frame and caption | user | Existing | 场景定义落表 | | |
| P6-table.png | 1050×700 | 1.50 | 门槛与合规表 | Screenshot | #19 image floating in whitespace with thin frame and caption | user | Existing | 分析表局部 | | |
| P6-source-crop.png | 320×430 | 0.74 | 右栏来源面板 | Screenshot | #54 overlapping image stack | user | Existing | 来源/证据等级 | | |
| P7-chat.png | 1600×900 | 1.78 | 右栏输入改表指令 | Screenshot | #48 side-by-side comparison (before/after, A/B, then/now) | user | Existing | 右栏对话输入 | | |
| P5-definition.png | 1600×900 | 1.78 | 场景定义对话 + 已落表 | Screenshot | #48 side-by-side comparison (before/after, A/B, then/now) | user | Existing | 改表后的场景概述 | | |
| P8-solution.png | 1600×900 | 1.78 | 解决方案正文 | Screenshot | #56 image triptych | user | Existing | 交付物-解决方案 | | |
| P8-outline.png | 1600×900 | 1.78 | PPT 大纲页 | Screenshot | #56 image triptych | user | Existing | 交付物-PPT 大纲 | | |
| P8-export.png | 560×80 | 7.00 | 导出按钮组 | Screenshot | #56 image triptych | user | Existing | 导出 Word/PPT | | |
| P1-workbench.png | 1600×900 | 1.78 | P9 价值页背景 | Screenshot | #12 faded image as backdrop with oversized overlay text | user | Existing | 价值页背景 | | |

> 13 个唯一文件，14 处使用；全部用户提供，不调用 AI/Web 图片。数据截图使用 `no-crop`，不裁掉表格文字。

---

## IX. Content Outline

### Slide 01 - 封面

- **Layout**: 全幅工作台截图 + 深蓝遮罩 + 居中白字（模板 01_cover）
- **Title**: 场景通
- **Subtitle**: AI 原生的售前调研工作台
- **Info**: L1 产品 Demo｜2026.10
- **Core message**: 场景通不是聊天框，是把售前调研做成一条可交付工作流。

### Slide 02 - 一个场景，先卡在找资料

- **Layout**: 三栏问题卡（无截图）+ 底部结论条
- **Title**: 一个场景，先卡在找资料
- **Core message**: 方案慢，不是写不出来，是调研阶段材料散、维度漏、来源虚。
- **Content**:
  - 材料散：邮件、网盘、聊天记录，找齐要半天。
  - 维度漏：合规、竞争、交付边界，没人提醒就漏。
  - 来源虚：客户一问数字，答不上来。
  - 底部：从调研到方案：1–2 周

### Slide 03 - 不是聊天框，是 6 步工作流

- **Layout**: 6 步横向流程 + 3 个数字 + 步骤轴截图
- **Title**: 不是聊天框，是 6 步工作流
- **Core message**: 场景通把调研拆成固定步骤和固定表，AI 每一步先跑一遍。
- **Content**:
  - 场景定义 → 认识场景 → 理解商业 → 能力匹配 → 方案与实现 → 交付物
  - 6 步 · 26 张信息表 · 2 份产物（解决方案 + PPT 大纲）

### Slide 04 - 产品资料一次入库，跨场景复用

- **Layout**: 左文右图，两图上下叠
- **Title**: 产品资料一次入库，跨场景复用
- **Core message**: 产品资料不是每次重新收集，而是一次入库、统一维护、跨场景引用。
- **Content**:
  - 产品清单、规格书、能力、边界、案例
  - AI 解析成结构化条目
  - 一次导入，统一维护；新建场景直接引用

### Slide 05 - AI 先理解场景，再让用户确认

- **Layout**: 上三步流程，下两图并排
- **Title**: AI 先理解场景，再让用户确认
- **Core message**: 不是让用户先填 26 张表，而是 AI 先讲清、先提问，再把回答整理成定义。
- **Content**:
  - 先讲清行业 → 问 2–3 个关键问题 → 整理成场景定义
  - 不是先填 26 张表

### Slide 06 - 每一步 AI 先调研、先填表

- **Layout**: 左文右图，表格 + 来源面板叠放
- **Title**: 每一步 AI 先调研、先填表
- **Core message**: 表格不是用户从零填，是 AI 先给初稿；每条结论都能回到来源。
- **Content**:
  - 6 步分析、26 张表
  - 表格可确认、可修改
  - 右栏来源可追溯，查不到写“未知”
  - 人只做校对和判断

### Slide 07 - 右栏一句话，中栏立即更新

- **Layout**: 左右对比，中间箭头
- **Title**: 右栏一句话，中栏立即更新
- **Core message**: 改表不用找单元格，用自然语言说一句，AI 调工具改。
- **Content**:
  - 输入：把这条改成按会议室逐间推进
  - 结果：中栏“采购特征”立即更新
  - 不用找单元格，不用记字段名

### Slide 08 - 从表格到可讲的文件

- **Layout**: 三张产物卡（每卡一图）
- **Title**: 从表格到可讲的文件
- **Core message**: 解决方案和 PPT 大纲同一次生成，改完可直接导出。
- **Content**:
  - 解决方案：有章节、有来源、有边界
  - PPT 大纲：按方案正文展开，可直接改
  - 导出：Word / PPT
  - 同一次生成，不用二次整理

### Slide 09 - 省下的不只是时间，是团队资产

- **Layout**: 三组价值数字 + 工作台背景弱化（模板 03d）
- **Title**: 省下的不只是时间，是团队资产
- **Core message**: 价值不止快，还有可信和可复用。
- **Content**:
  - 1–2 周 → 1–2 天｜调研周期
  - 每条结论有来源｜方案可信
  - 越用越厚｜资料与场景资产
  - 金句：去掉 AI，产品只剩空表和空文档。

### Slide 10 - 补充：场景通不是一个工具，是一套架构的实例

- **Layout**: 左侧四层架构图 + 右侧三个工作类型卡（无截图）
- **Title**: 场景通不是一个工具，是一套架构的实例
- **Core message**: 换工作类型，换的是方法层和输出契约；运行时、工具链、交互壳复用。
- **Content**:
  - 基础设施：DSH 运行时（会话/工具调用/流式/模型接入）
  - 工具层：文档解析、联网检索、模型、Word/PPT 生成
  - 方法层：6 步、26 表、提示词、质量门禁（场景调研）
  - 交付/资产层：解决方案 + PPT、产品库、模板、案例
  - 示例：场景调研 / 投标文件评审 / 客户需求分析
  - 边界：不是通用低代码平台，是第一个可运行实例

---

## X. Speaker Notes Requirements

- 文件：`notes/total.md`，按 `# P1`…`# P10` 分页；后续 `total_md_split.py` 拆分。
- 每页 2–4 句：本页要落的一个观点、与上一页的过渡、下一句提示。
- 不照念屏幕文字；口播稿见 `sources/口播.md`。

---

## XI. Technical Constraints Reminder

1. viewBox `0 0 1280 720`；背景用 `<rect>`。
2. 文本换行用 `<tspan>`；禁止 `<foreignObject>`。
3. 透明度用 `fill-opacity` / `stroke-opacity`；禁止 `rgba()`。
4. 禁止 `mask`、`<style>`、`class`、`textPath`、`animate*`、`script`。
5. 禁止 `<g opacity>`；透明度逐个元素设置。
6. XML 保留字转义；不要用 HTML 命名实体。
7. 图片用 `<image href="../images/...">`，`preserveAspectRatio` 按 `no-crop` 处理；截图不叠字。
