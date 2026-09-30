#!/usr/bin/env bash
# 安装图片型（扫描）PDF 识别组件：macOS Vision（系统「实况文本」引擎）
# 幂等：重复执行只做增量安装。产物为 scripts/.venv-ocr（不入库）。
set -e
cd "$(dirname "$0")"
python3 -m venv .venv-ocr
.venv-ocr/bin/pip install -q --upgrade pip
.venv-ocr/bin/pip install -q pyobjc-core pyobjc-framework-Quartz pyobjc-framework-Vision
.venv-ocr/bin/python -c 'import Quartz, Vision; print("OCR 组件就绪（macOS Vision）")'
