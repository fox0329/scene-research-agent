## 场景通桌面版 0.8.0（免签名安装包）

### 本版变化

- **修复产品资料导入失败**：规格书只写参数、没写产品状态时，不再把整条产品与规格一起丢掉；状态按「待确认」入库，可后续手工改。
- **导入报错不再被藏住**：多文件上传结束后会保留全部失败原因；服务端也会记录失败与 0 行原因，便于排障。
- **移除数据备份/恢复功能**：设置页不再有「数据备份」，应用也不再自动备份。升级、换电脑或批量改资料前，请退出应用后自行复制整个应用数据目录；旧版本留下的 `data/backups/` 不会被删除。

## 场景通桌面版 0.7.9（免签名安装包）

### 本版修复

- **没开钥匙串保护时，不再探测钥匙串**：此前设置页读取版本会顺带调用 `safeStorage.isEncryptionAvailable()`，macOS 把它当成访问钥匙串，覆盖安装后可能弹“想要使用钥匙串中的机密信息”。现在只有显式设置 `SCENE_KEYCHAIN_PROTECTION=1` 才会探测，默认路径不碰钥匙串。
- 免签名应用更新后，macOS 仍可能因代码身份变化问一次；点「始终允许」即可，之后这次安装通常不再提示。

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

升级前建议把整个 `data` 目录拷贝一份留底。0.8.0 起应用不再自动备份；0.7.x 会在启动/迁移前自动备份到 `data/backups/`（保留 3 份）。

---

数据都在你自己的电脑上；模型端点与密钥在应用内「设置」里配置。
