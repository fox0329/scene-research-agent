---
deck_id: 拓维信息蓝色模版
kind: deck
category: brand
summary: 企业宣讲、公司介绍、战略发布、行业覆盖与资质展示、生态合作汇报
canvas_format: ppt169
page_count: 8
primary_color: "#0070C0"
replication_mode: standard
keywords: [拓维信息, 蓝色商务, 企业宣讲, 行业覆盖, 鸿蒙AI]
placeholders:
  01_cover: ["{{TITLE}}", "{{SUBTITLE}}", "{{FOOTER_TAG}}"]
  02_toc: ["{{TOC_ITEM_1_TITLE}}", "{{TOC_ITEM_2_TITLE}}", "{{TOC_ITEM_3_TITLE}}"]
  03_chapter: ["{{CHAPTER_NUM}}", "{{CHAPTER_TITLE}}", "{{CHAPTER_DESC}}"]
  03a_content_text_image: ["{{PAGE_TITLE}}", "{{BODY_LINE_1}}", "{{BODY_LINE_2}}", "{{BODY_LINE_3}}", "{{BODY_LINE_4}}", "{{CRED_1}}", "{{CRED_2}}", "{{CRED_3}}", "{{IMAGE_AREA}}"]
  03b_content_card_grid: ["{{PAGE_TITLE}}", "{{STAT_HEAD}}", "{{STAT_NUM_1}}", "{{STAT_LABEL_1}}", "{{STAT_NUM_2}}", "{{STAT_LABEL_2}}", "{{CARD_1_HEAD}}", "{{CARD_1_BODY}}", "{{CARD_2_HEAD}}", "{{CARD_2_BODY}}", "{{CARD_3_HEAD}}", "{{CARD_3_BODY}}", "{{CARD_4_HEAD}}", "{{CARD_4_BODY}}", "{{CARD_5_HEAD}}", "{{CARD_5_BODY}}"]
  03c_content_pillars: ["{{PAGE_TITLE}}", "{{HEAD_LINE_1}}", "{{HEAD_LINE_2}}", "{{PILLAR_1}}", "{{PILLAR_1_TAGS}}", "{{PILLAR_2}}", "{{PILLAR_2_TAGS}}", "{{BASELINE}}"]
  03d_content_stats: ["{{PAGE_TITLE}}", "{{STAT_INTRO}}", "{{STAT_1_NUM}}", "{{STAT_1_LABEL}}", "{{STAT_1_DESC}}", "{{STAT_2_NUM}}", "{{STAT_2_LABEL}}", "{{STAT_2_DESC}}", "{{STAT_3_NUM}}", "{{STAT_3_LABEL}}", "{{STAT_3_DESC}}", "{{STAT_4_NUM}}", "{{STAT_4_LABEL}}", "{{STAT_4_DESC}}"]
  04_ending: ["{{SLOGAN}}", "{{SLOGAN_SUB}}"]
---

# 拓维信息蓝色模版 — Design Specification

> 适用于企业宣讲、公司介绍、战略发布、行业覆盖与资质展示、生态合作汇报等品牌商务场景。

---

## I. Template Overview

| Property | Description |
|---|---|
| **Template Name** | 拓维信息蓝色模版（拓维信息 蓝色扁平商务宣讲风格） |
| **Use Cases** | 企业宣讲、公司介绍、战略发布、行业覆盖与资质展示、生态合作汇报 |
| **Design Tone** | 蓝色商务、扁平沉稳、数据驱动、资质背书 |
| **Theme Mode** | Light（白底 + 靛蓝标题 + 主蓝强调） |

本模版从 `拓维信息模版.pptx`（24 页）提炼。一屏可识别特征：**靛蓝竖条 `#1D2A8C` + 绿色方块 `#22943A` 叠加 chrome + 右上品牌 logo + 主蓝 `#0070C0` 卡片/底条强调**。与“开鸿智谷蓝色模版”不同：拓维版走**扁平实色**路线（无渐变大字），强调**卡片矩阵 + 底部资质条**的行业覆盖型宣讲，更偏 ToB 商务。

---

## II. Color Scheme

| Role | Hex | Usage |
|---|---|---|
| **Primary** | `#0070C0` | 卡片头、强调文字、底部资质条、胶囊、TOC 高亮条、TOC 头 |
| **Primary Deep** | `#1D2A8C` | 页标题文字、左上 chrome 竖条、结尾遮罩 |
| **Accent Green** | `#22943A` | 内容页 chrome 绿色装饰方块 |
| **Accent Cyan** | `#007BC6` | 目录/章节页 chrome 蓝色装饰方块 |
| **Accent Green 2** | `#2C9C4D` | 目录/章节页 chrome 绿色装饰方块 |
| **Body Text** | `#404040` | 正文要点、卡片正文 |
| **Dark Text** | `#0D0D0D` | 大标题、战略页导语 |
| **Card BG** | `#F9FAFB` | 卡片浅灰底（配柔和投影） |
| **Panel BG** | `#FFFFFF` | 页面白底 |

> **配色约定**：扁平实色为主，不用渐变填充（区别于开鸿蓝的渐变质感）。数据强调用大号主蓝 `#0070C0` 数字。

---

## III. Signature Design Elements

### Content Page Chrome（03a–03d 共用，还原 layout_12）
- **左上靛蓝竖条**: `x=0.09, y=37.64, 22.74×34.02, #1D2A8C`
- **叠加绿方块**: `x=16.73, y=33.4, 11.34×11.34, #22943A`
- **右上品牌 Logo**: `image1.png` @ `x=1109.97, y=18.73, 123.36×51.68`
- **页标题**: `x=52.24, y=62.12`, 32px bold, `#1D2A8C`

### Structural Page Chrome（目录/章节，还原 layout_32）
- **蓝色装饰方块**: `#007BC6` + **绿色装饰方块**: `#2C9C4D` 叠加（左上 logo 簇）
- **两枚微型 logo**: `image4.png` + `image5.png`
- **右上品牌 Logo**: `image9.png` @ `x=1131.11, y=24.36, 125.51×52.62`

### Cover Page（还原 slide_01）
- `image18.png` 全幅品牌背景 + 居中白色主标题（72px bold）+ 副标 + 页脚标签

### Ending Page（还原 slide_24，遮罩改蓝）
- `image2.jpeg` 全幅背景 + **左侧蓝色渐变遮罩**（`#1D2A8C` opacity 0.48→0，源为红色 `#A21317`，按蓝色模版规整）+ 居中白色口号

---

## IV. Page Roster

| File | Role | Description |
|---|---|---|
| `01_cover.svg` | cover | 全幅 `image18.png` + 居中白色主/副标题 + 页脚标签（literal 还原 slide1） |
| `02_toc.svg` | toc | 目录 chrome + 「目录 Contents」头 + 三段高亮列表（第一/二/三/四部分） |
| `03_chapter.svg` | chapter | 目录 chrome + 大号章号 + 章节标题 + 描述（按品牌语言适配，单段高亮） |
| `03a_content_text_image.svg` | content | 左侧多行要点 + 右侧配图区 + 底部主蓝资质条（还原 slide3） |
| `03b_content_card_grid.svg` | content | 顶部超大数字统计 + 5 张浅灰卡（主蓝头 + 要点正文 + 柔和投影）（还原 slide4） |
| `03c_content_pillars.svg` | content | 大标题双行 + 两枚主蓝圆角胶囊 + 支撑标签 + 底部基座条（还原 slide5） |
| `03d_content_stats.svg` | content | 导语 + 4 组超大主蓝数字 + 标签 + 描述（抽自 slide4 头部统计 motif） |
| `04_ending.svg` | ending | 全幅 `image2.jpeg` + 左侧蓝色遮罩 + 居中白色口号（literal 还原 slide24，遮罩改蓝） |

---

## V. Assets

| Filename | Source | Pixels | Usage |
|---|---|---|---|
| `assets/image1.png` | layout_12 | 283×118 | 内容页右上品牌 logo（横向字标） |
| `assets/image9.png` | layout_32 | 1639×688 | 目录/章节页右上品牌 logo |
| `assets/image4.png` | layout_32 | 77×53 | 目录/章节页 chrome 微型 logo |
| `assets/image5.png` | layout_32 | 50×50 | 目录/章节页 chrome 微型 logo |
| `assets/image18.png` | slide_01 | 1286×724 | 封面全幅背景 |
| `assets/image2.jpeg` | slide_24 | 1467×825 | 结尾页全幅背景 |

> 源 PPT 另含约 191 张内容照片（产品/案例/示意图），属内容素材非模版结构，未打包；生成时由项目侧提供。
