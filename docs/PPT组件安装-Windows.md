# 场景通 PPT 组件（Windows）

> **0.9.2 起已内置**：Windows 安装包自带这套组件，装完直接导出 PPT，不需要再单独安装。
> 本文保留给 0.9.1 及更早版本，或需要单独重装组件的场景。

## 这是什么

场景通的「导出 PPT」不是内置转换器：它调用 `ppt-master` 技能的 `svg_to_pptx.py`，还需要 Python 3.10+ 和 `python-pptx` 等依赖。macOS 开发机装了这套环境；Windows 安装包没带，所以点「导出 PPT」会提示「找不到 ppt-master 技能」。

这个组件包把 **Python 运行时 + ppt-master 导出脚本 + 图标库** 打在一起，Windows 上解压后双击一个 bat 就能装好，不需要你单独装 Python，也不需要 `pip install`。

- 文件：`SceneTong-PPT-Component-Windows.zip`（约 30 MB）
- SHA256：`d7475d4265ba3a4c59f96e175821726432e02ab6b78d72e849da9c3ce21a82b1`
- 安装位置：`%LOCALAPPDATA%\场景通\ppt`
- 不写系统目录，不需要管理员权限；数据不联网、不上传

## 安装

1. 把 zip 下到 Windows，放到「下载」或「桌面」等普通目录（不要在 DSH/公司管控工作区里解压运行）；
2. 解压到一个普通文件夹；
3. 先完全退出场景通；
4. 双击 `安装PPT组件.bat`，看到 `Python 3.12.x | python-pptx 1.0.2` 即成功；
5. 重新打开场景通，交付物面板点「导出 PPT」。

安装脚本会设置两个**用户**环境变量，场景通启动时读取：

- `PPT_PYTHON` = `%LOCALAPPDATA%\场景通\ppt\python\python.exe`
- `PPT_MASTER_DIR` = `%LOCALAPPDATA%\场景通\ppt\skill`

## 卸载

双击 `卸载PPT组件.bat`，或手动删除 `%LOCALAPPDATA%\场景通\ppt` 并删掉上面两个用户环境变量。卸载不影响场景、资料库、交付物。

## 排障

- 双击 bat 一闪而过：在该文件夹空白处 Shift+右键 →「在终端中打开」，执行 `powershell -ExecutionPolicy Bypass -File .\install.ps1`，把报错发回；
- 安装成功但应用仍提示找不到技能：确认场景通已完全退出再打开（环境变量只在启动时读取）；仍不行看 `%APPDATA%\@scene\desktop\logs\server.log`；
- 导出仍失败：把 `server.log` 最后 50 行发回。

## 分发说明

`ppt-master` 技能目录没有 LICENSE 文件。这个组件包**仅用于你本机验证**，不要公开上传到 GitHub Release 或对外分发；确认技能可再分发后，再考虑随安装包发布或改为内置转换器。
