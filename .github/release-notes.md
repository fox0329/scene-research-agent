## 场景通桌面版 0.7.7（免签名安装包）

### 本版新增

- **数据备份/恢复**：启动与迁移前自动快照（保留 3 份），设置页可立即备份、恢复某份备份（重启生效）
- **诊断信息导出**：设置页一键导出（版本、数据规模、备份实况、最近日志，不含 Key 与正文）
- **首次使用提示**：未配置模型时工作台顶部直接引导去设置
- **UI 质量**：字号层级修正（右栏不再压过表格、阶段字号加大）、弱化文字对比度达到 WCAG AA、可点区域 ≥24px
- **E2E 全绿**：45 条关键回归（六步推进、上传、交付物导出、设置）

### 下载哪个

| 你的机器 | 下载这个 |
|---|---|
| Mac（Apple 芯片，M1/M2/M3/M4 等） | `SceneMaster-*-mac-arm64.dmg` |
| Windows 10 / 11（64 位） | `SceneMaster-*-win-x64-setup.exe`（安装版，推荐）或 `…-win-x64-portable.exe`（免安装，解压即用） |

> 暂不支持 macOS Intel（x64）机型。

### macOS 首次安装（未签名，需要两步放行）

1. 打开 dmg，把「场景通」拖进「应用程序」
2. 首次打开若被拦：**系统设置 → 隐私与安全性 → 底部「仍要打开」**；
   或在终端执行一条命令：

   ```bash
   xattr -dr com.apple.quarantine /Applications/场景通.app
   ```

### Windows 首次安装

- **安装版**：双击 exe 一路装完即可；**免安装版**：解压后直接运行目录里的 exe
- 若 SmartScreen 弹「Windows 已保护你的电脑」：点 **更多信息 → 仍要运行**

### 导出 PPT 的前提

导出 PPT 需要本机装有 **Python 3.10 或更高版本**（没有时不影响分析与导出 Word / Markdown）：

- macOS：`brew install python3`
- Windows：到 <https://www.python.org/downloads/> 安装，并勾选 “Add python.exe to PATH”

### 校验下载文件

每个 Release 附 `SHA256SUMS.txt`。下载后可核对：

```bash
# macOS
shasum -a 256 SceneMaster-*.dmg
# Windows PowerShell
Get-FileHash .\SceneMaster-*.exe -Algorithm SHA256
```

### 升级前请备份

你的全部数据（场景、材料库、交付物）都在应用数据目录里，覆盖安装不会动它：

- macOS：`~/Library/Application Support/@scene/desktop/data/`
- Windows：`%APPDATA%\@scene\desktop\data\`

升级前建议把整个 `data` 目录拷贝一份留底；应用也会在启动/迁移前自动备份到 `data/backups/`（保留 3 份），设置页可一键备份与恢复。

---

数据都在你自己的电脑上；模型端点与密钥在应用内「设置」里配置。
