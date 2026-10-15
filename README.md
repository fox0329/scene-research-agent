# 场景通

把「这场景能不能进、怎么进、值不值」的调研，从几周压到几天的桌面智能体。

面向解决方案架构师：接一个客户场景，从材料入库、场景定义，到 7 步分析（33 张信息表）、
两份交付物（解决方案 + 建设工作方案），一次走完，并可导出 Word / PPT / Markdown。

---

## 一、下载与安装（使用者只看这一节）

**👉 到 [Releases 页面](../../releases/latest) 下载，选自己机器对应的包：**

| 你的机器 | 下载这个 |
|---|---|
| Mac（Apple 芯片，M1/M2/M3/M4 等） | `场景通-*-mac-arm64.dmg` |
| Windows 10 / 11（64 位） | `场景通-*-win-x64.exe` |

> 暂不支持 macOS Intel（x64）机型。

### macOS 首次安装（安装包未签名，需要两步放行）

1. 打开 dmg，把「场景通」拖进「应用程序」
2. 首次打开若被拦：**系统设置 → 隐私与安全性 → 底部「仍要打开」**；
   或在终端执行一条命令：

   ```bash
   xattr -dr com.apple.quarantine /Applications/场景通.app
   ```

### Windows 首次安装

双击 exe 安装。若 SmartScreen 弹「Windows 已保护你的电脑」：
点 **更多信息 → 仍要运行**。

### 导出 PPT 的前提

导出 PPT 需要本机装有 **Python 3.10 或更高版本**（没有时不影响分析与导出 Word/Markdown）：

- macOS：`brew install python3`
- Windows：到 <https://www.python.org/downloads/> 安装，并勾选 “Add python.exe to PATH”

### 升级前请备份

你的全部数据（场景、材料库、交付物）都在应用数据目录里，覆盖安装不会动它：

- macOS：`~/Library/Application Support/@scene/desktop/data/`
- Windows：`%APPDATA%\@scene\desktop\data\`

升级前建议把整个 `data` 目录拷贝一份留底。

---

## 二、首次使用三步

1. **配置模型**：打开「设置」，填模型供应商的 API Key（或本地 DSH 地址）
2. **建产品资料库**：上传我方材料（产品白皮书、能力清单、案例）——阶段 3 起会引用这些材料
3. **新建场景**：客户场景材料入库 → 对话定义场景 → 按 7 步推进，最后在「交付物」导出

---

## 三、开发者

### 技术栈

pnpm monorepo：Electron 桌面壳 + React/Vite 前端 + Fastify 服务端 + 领域层（判定逻辑）
+ DeepSeek Harness（DSH）做内容生成。判定类逻辑全部落在确定性层（可单测、可审计）。

### 常用命令

```bash
pnpm install
pnpm build                    # 契约/领域/基础设施/服务端/前端全量构建
pnpm exec vitest run          # 单元测试
pnpm run dsh:start            # 启动项目内 DSH（端口 46171）
```

### 打包与发布

```bash
# 本机打包（Apple 芯片）
pnpm --filter @scene/desktop pack:mac:arm64
```

正式发布走 GitHub Actions（`.github/workflows/desktop.yml`）：

1. 改代码 → 升 `apps/desktop/package.json` 版本号 → 提交并推 `main`
2. 打 tag 并推送：`git tag -a vX.Y.Z -m "…" && git push origin vX.Y.Z`
3. CI 在各自平台原生构建（Apple 芯片 / Windows）并各跑一遍真启动冒烟，
   产物齐备后由**单独的发布任务**统一挂到 Release

### 文档

- 产品定义：`01-产品定义.md`
- 工作流标准（现行 7 阶段 / 33 表）：`04-业务过程重定义.md` + `packages/contract/src/tables.ts`
- 故障与变更记录：`docs/故障及解决清单.md`、`docs/项目变更表.md`
- 协作与开发规则：`AGENTS.md`
