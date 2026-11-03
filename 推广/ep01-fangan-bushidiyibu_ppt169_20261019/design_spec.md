# ep01-fangan-bushidiyibu - Design Spec

> 人类可读的设计叙述：受众、风格、配色理由、内容大纲。
> 机器可读的执行契约见 `spec_lock.md`；两者冲突时以 `spec_lock.md` 为准。

## I. Project Information

| Item | Value |
| ---- | ----- |
| **Project Name** | 第01期-方案不是第一步 |
| **Canvas Format** | PPT 16:9 (1280×720) |
| **Page Count** | 5 |
| **Design Style** | A) 通用型 + 深蓝科技科普 |
| **Target Audience** | B 站技术向观众：解决方案架构师、售前、集成商、工业物联网从业者 |
| **Use Case** | B 站视频配套 PPT，配合口播文案逐页讲解；观众看完能自查手上的项目 |
| **Created Date** | 2026-10-19 |

---

## II. Canvas Specification

| Property | Value |
| -------- | ----- |
| **Format** | PPT 16:9 |
| **Dimensions** | 1280×720 px |
| **viewBox** | `0 0 1280 720` |
| **Margins** | 左右 80px，上下 56px |
| **Content Area** | 1120×608 px（x: 80–1200，y: 56–664） |

---

## III. Visual Theme

### Theme Style

- **Style**: 深蓝科技科普，清爽通透，无花哨装饰
- **Theme**: 混合主题（封面 / 尾页深蓝渐变底，正文页白底）
- **Tone**: 专业、克制、可信；观点型内容靠版式对比说话，不靠装饰堆砌

### Color Scheme

> 直接沿用 `bilibili-ppt-outline/references/bilibili-blue-design-spec.md` 的配色，锁死不调整。

| Role | HEX | Purpose |
| ---- | --- | ------- |
| **Background** | `#FFFFFF` | 正文页背景 |
| **Secondary bg** | `#E3F2FD` | 卡片 / 容器底色 |
| **Primary** | `#0D47A1` | 标题文字、封面渐变深端、强调元素 |
| **Accent** | `#FF9800` | 警示 / 反面 / 底部结论区、重点强调 |
| **Secondary accent** | `#1565C0` | 次要标题、数据块填充、封面渐变浅端 |
| **Body text** | `#333333` | 主要正文 |
| **Secondary text** | `#6B7280` | 说明文字、页码 |
| **Tertiary text** | `#90CAF9` | 封面 / 尾页副标题、装饰线 |
| **Border/divider** | `#E5E7EB` | 卡片描边、分隔线 |
| **Success** | `#4CAF50` | 正向 / 通过（三道门打勾） |
| **Warning** | `#FF9800` | 与 Accent 同色，反面与警示统一用橙 |

> 禁用红、黄、紫。对比统一用「蓝 vs 橙」，不用蓝绿 / 蓝红。

### Gradient Scheme

```xml
<!-- 封面 / 尾页渐变：#0D47A1 → #1565C0，左上到右下 -->
<linearGradient id="coverGrad" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#0D47A1"/>
  <stop offset="1" stop-color="#1565C0"/>
</linearGradient>
```

---

## IV. Typography System

### Font Plan

**Typography direction**: 现代中文黑体，同族字重对比（Bold 标题 × Regular 正文），无衬线、无装饰。

| Role | Chinese | English | Fallback tail |
| ---- | ------- | ------- | ------------- |
| **Title** | `"Microsoft YaHei"` | `Arial` | `sans-serif` |
| **Body** | `"Microsoft YaHei"` | `Arial` | `sans-serif` |
| **Emphasis** | `"Microsoft YaHei"` | `Arial` | `sans-serif` |
| **Code** | — | `Consolas, "Courier New"` | `monospace` |

**Per-role font stacks**:

- Title: `Arial, "Microsoft YaHei", sans-serif`
- Body: `Arial, "Microsoft YaHei", sans-serif`
- Emphasis: `Arial, "Microsoft YaHei", sans-serif`
- Code: `Consolas, "Courier New", monospace`（本期无代码，仅备用）

### Font Size Hierarchy

**Baseline**: Body font size = 20px

| Purpose | Ratio | Actual px | Weight |
| ------- | ----- | --------- | ------ |
| Cover title | 2.8x | 56px | Bold |
| Page title | 1.7x | 34px | Bold |
| Subtitle | 1.2x | 24px | Bold |
| **Body content** | **1x** | **20px** | Regular |
| Hero number（价格轴数字） | 2.4x | 48px | Bold |
| Annotation / caption | 0.7x | 14px | Regular |
| Page number | 0.6x | 12px | Regular |

---

## V. Layout Principles

### Page Structure

- **Header area**: y 56–130，页面标题（左对齐 x=80）+ 副标题 / 标签（右对齐）
- **Content area**: y 150–620，主内容区
- **Footer area**: y 640–680，底部结论条 / 页码（右下角）

### Layout Pattern Library（按内容选择，不套固定网格）

| Page | Pattern | 理由 |
| ---- | ------- | ---- |
| P1 | Single column centered | 封面，七问标签墙居中 |
| P2 | Symmetric split (5:5) + 网格 | 左侧两场景对比，右侧六项清单 |
| P3 | Top-bottom split | 上价格轴，下两张场景卡 + 四标签 |
| P4 | Process flow（三段链）+ 2×2 矩阵 | 门禁链横向推进，价值四问四宫格 |
| P5 | Single column centered | 结尾，三步回顾 + 大字观点 |

### Spacing Specification

**Universal**:

| Element | Current Project |
| ------- | --------------- |
| Safe margin | 80px（左右）/ 56px（上下） |
| Content block gap | 32px |
| Icon-text gap | 12px |

**Card-based layouts**:

| Element | Current Project |
| ------- | --------------- |
| Card gap | 28px |
| Card padding | 24px |
| Card border radius | 12px |
| Three-column card width | 352px |

---

## VI. Icon Usage Specification

### Source

- **Library**: `tabler-outline`（线性轻量，配深蓝科技风）
- **Stroke width**: 2
- **Usage**: `<use data-icon="tabler-outline/icon-name" .../>`

### Recommended Icon List

| Purpose | Icon Path | Page |
| ------- | --------- | ---- |
| 场景 / 工厂 | `tabler-outline/building-factory` | P2 |
| 防爆 / 警示 | `tabler-outline/alert-triangle` | P2 |
| 通过 / 打勾 | `tabler-outline/circle-check` | P4 |
| 门槛 / 门 | `tabler-outline/door-enter` | P4 |
| 价格 / 成本 | `tabler-outline/currency-yen` | P3 |
| 清单 | `tabler-outline/list-check` | P2 |
| 层次 | `tabler-outline/hierarchy-2` | P3 |
| 目标 | `tabler-outline/target-arrow` | P5 |

---

## VII. Visualization Reference List

| Page | Template | Path | Summary-quote (verbatim) | Usage |
| ---- | -------- | ---- | -------------------------------------------------------- | ----- |
| P4 | process_flow | `templates/charts/process_flow.svg` | "Pick for 3-8 sequential steps connected by simple arrows — approval workflows, customer onboarding, build pipelines. Skip if the flow branches or loops." | 三道门 → 产品价值 → 方案 的顺序链 |
| P3 | comparison_columns | `templates/charts/comparison_columns.svg` | "Pick for 2-4 pricing/service tier cards in side-by-side columns (marketing layout). Skip for qualitative feature comparison — use comparison_table." | 教育场景 vs 会议室场景两张卡 |
| P5 | numbered_steps | `templates/charts/numbered_steps.svg` | "Pick for 3-6 horizontal sequential steps with numeric emphasis — how-it-works section, getting started guides, setup tutorials." | 结尾三步回顾 |

**Runners-up considered**:

- `chevron_process` | rejected for P4: 本期是"门禁"而非阶段交付物，chevron 的"每阶段带产出"语义会误导
- `comparison_table` | rejected for P3: 只有两个场景且字段少，表格密度过高，用卡片更通透
- `funnel_chart` | rejected for P2: 六项清单是并列关系不是逐层转化，funnel 的单调递减语义不成立

---

## VIII. Image Resource List

本期为观点型内容，**无图片、无 AI 生成图、无公式**。全部版式由 SVG 原生图形构成（卡片、价格轴、箭头链、四宫格）。

| Filename | Dimensions | Ratio | Purpose | Type | Layout pattern | Acquire Via | Status | Reference | text_policy | page_role |
| -------- | --------- | ----- | ------- | ---- | -------------- | ----------- | ------ | --------- | ----------- | --------- |
| — | — | — | 本期无图片资源 | — | — | — | — | — | — | — |

---

## IX. Content Outline

### Part 1: 全片（5 页，与口播文案 1:1）

#### Slide 01 - 封面：起点不是产品

- **Layout**: Single column centered，深蓝渐变全幅底
- **Title**: 做解决方案的起点，不是我们有什么产品
- **Core message**: 产品没问题、方案也合理，项目却做不成——因为起点找错了。
- **Content**:
  - 副标题：产品没问题、方案也合理，项目为什么还是做不成？
  - 七问标签墙（第一行 4 个 / 第二行 3 个）：什么场景 · 传统方案 · 真实痛点 · 竞争方 / 进入门槛 · 产品真实价值 · 成本优势
  - 底部结论条：起点不是我们有什么产品，而是对这个需求的深入理解
  - 右下角互动提示：弹幕告诉我——你是先写方案，还是先做调研？

#### Slide 02 - 场景认知：同一套 PLC 采集，换个行业就不成立

- **Layout**: Symmetric split 5:5（左对比 / 右清单）
- **Title**: 产品能不能用，不由功能决定，由行业的门槛决定
- **Core message**: 同一功能在不同行业的门槛完全不同，第一件事是把场景的行业属性查清。
- **Visualization**: comparison（自制双卡 + ≠ 分隔）+ 六项清单网格
- **Content**:
  - 左卡 A（蓝框）：普通工业厂房 → 实时性、可靠性
  - 左卡 B（橙框）：燃气场站 → 防爆等级
  - 中间：≠
  - 右六项：技术门槛 / 商业门槛 / 合规门槛 / 准入标准与认证 / 供应商与头部 / 设备组成与协作
  - 底部结论条：产品能不能用，不由功能决定，由行业的门槛决定

#### Slide 03 - 商业规则：先看这个场景卖多少钱

- **Layout**: Top-bottom split（上价格轴 / 下场景卡 + 清单）
- **Title**: 场景能不能进，先看这个场景卖多少钱
- **Core message**: 成本结构进不去的场景，产品再好也没用。
- **Visualization**: 价格轴（自制）+ comparison_columns（两张场景卡）
- **Content**:
  - 价格轴：500 元 ←→ 10000 元以上；橙色标记「成本 2000 的平板」落在左侧约 1/5
  - 场景卡 ×2：教育场景（预算敏感、走量）/ 会议室场景（品牌、生态）
  - 判断句：不是贵一点，是根本不成立
  - 四项标签：上下游 / 利润分配 / 竞争对手 / 行业趋势

#### Slide 04 - 三道门都过了，才轮到谈产品价值

- **Layout**: Process flow 横向三段 + 2×2 四宫格
- **Title**: 先过三道门，再谈产品价值，最后才是方案
- **Core message**: 顺序就是方法——门没过就写方案，方案只会替自己找理由。
- **Visualization**: process_flow（三道门 → 价值四问 → 方案）
- **Content**:
  - 三道门（并列，缺一不可）：有钱赚 / 没壁垒 / 有竞争力；每块右上角绿色对勾
  - 箭头上标注：全部通过
  - 价值四问 2×2：解决什么 / 什么角色 / 跟谁协作 / 强在哪
  - 方案段（橙框，标注"最后一步"）：架构 / 成本 / 计划
  - 警示条：顺序反了，方案就会替自己找理由

#### Slide 05 - 结尾：隔行如隔山

- **Layout**: Single column centered，深蓝渐变全幅底（与封面呼应）
- **Title**: 隔行如隔山：先做这个行业的半个内行
- **Core message**: 没有对行业的深入了解，方案大概率只是汇报材料。
- **Visualization**: numbered_steps（三步回顾）
- **Content**:
  - 三步横条：① 看清场景 ② 看清商业规则 ③ 拿这三条卡自己的产品
  - 大字：隔行如隔山
  - 副句：没有对行业的深入了解，方案大概率只是汇报材料
  - 预告条：下期——如何用 AI 快速深入了解一个行业和场景
  - 互动按钮：点赞 / 关注 / 投币

---

## X. Speaker Notes Requirements

每页一个 note 文件，保存到 `notes/`，文件名与 SVG 对应（如 `01_cover.md`）。内容取自口播文案对应页的关键句 + 过渡句。

---

## XI. Technical Constraints Reminder

### SVG Generation Must Follow

1. viewBox: `0 0 1280 720`
2. 背景用 `<rect>`
3. 文字换行用 `<tspan>`（禁用 `<foreignObject>`）
4. 透明度用 `fill-opacity` / `stroke-opacity`；禁用 `rgba()`
5. 禁用：`mask`、`<style>`、`class`、`foreignObject`
6. 禁用：`textPath`、`animate*`、`script`
7. 排版符号写原始 Unicode（`—`、`→`、`≠` 等）；禁用 HTML 命名实体；XML 保留字符转义
8. `clipPath` 仅可用于 `<image>`（本期无 image，不用）

### PPT Compatibility Rules

- 禁用 `<g opacity="...">`（组透明度），逐个子元素设置
- 仅内联样式；禁用外部 CSS 与 `@font-face`
