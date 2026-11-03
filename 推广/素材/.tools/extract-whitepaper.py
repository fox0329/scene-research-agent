#!/usr/bin/env python3
"""把《云枢智控-产品与能力白皮书.docx》按文档顺序抽成 Markdown。

为什么这么做而不是重写内容：这份白皮书已被场景通入库，演示库里的 `source` 写着
「白皮书.docx:表格3」「白皮书.docx:A.1」这类定位。**表格顺序与标题编号一变，
这些出处就全指向别的内容**——演示就假了。所以本脚本只做「原样搬运 + 换皮」：
段落顺序、表格顺序、表头、文字一字不动，只把样式交给产品的 Word 生成器。

三处刻意的映射（都为了保住出处可核查）：
  1. 封面下方的「文档信息」表**必须留在正文第一个表**——原文档里它是表格1，
     后面 表格2..表格12 的编号就是靠它撑起来的。
  2. `1.`/`4.1`/`8.1`/`9.` 这类数字章号**剥掉**，交给 Word 多级列表自动编号，
     剥完仍是 8.1 / 9（章序没动），出处不变。
  3. 附录的 `A.1`..`A.6` **不剥、也不能交给自动编号**（自动编号只会给 12.1），
     改用 `#####`（Heading4，样式里没挂 numPr）让字面 "A.1" 原样留在标题里。

用法：python3 extract-whitepaper.py <源.docx> <输出.md>
"""

import re
import sys
from pathlib import Path

from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph

# 标题里要剥掉的数字章号：`8.1 不做…` / `9. 已知限制…` / `1. 关于本白皮书`
# `4.1 X` 要整段剥掉——只剥 `4.` 会留下 `1 X`。所以分隔符既可以跟空白，
# 也可以是多级点分之后的空白；两条分支合起来才不会半途匹配。
NUM_HEADING = re.compile(r"^\d+(?:\.\d+)*(?:[.．、]\s*|\s+)")
# 附录子节：`A.1 认证` —— 字母编号，不剥，走 Heading4
APPENDIX_HEADING = re.compile(r"^[A-Z]\.\d+\s")

# 这些字符开头的正文段落会被 Markdown 解析器当成语法，转义掉
MD_TRAP = re.compile(r"^([-*|>#]|\d+\.\s)")


def esc_inline(text: str) -> str:
    """表格单元格：`|` 会截断 Markdown 表格，换行会截断行。"""
    return text.replace("|", "\\|").replace("\n", " ").strip()


def para_to_md(style: str, text: str) -> str:
    t = text.strip()
    if not t:
        return ""
    if style.startswith("Heading"):
        level = int(style.split()[-1]) if style.split()[-1].isdigit() else 1
        if APPENDIX_HEADING.match(t):
            # A.1 / A.2 …：字面保留，落到 Heading4（无自动编号）
            return "##### " + t
        stripped = NUM_HEADING.sub("", t).strip() or t
        # python-docx 的 Heading 1/2/3 → Markdown ## / ### / ####
        return "#" * (level + 1) + " " + stripped
    if style == "List Bullet":
        return "- " + t
    if MD_TRAP.match(t):
        return "\\" + t
    return t


def table_to_md(table: Table) -> str:
    rows = [[esc_inline(c.text) for c in r.cells] for r in table.rows]
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    out = ["| " + " | ".join(rows[0]) + " |",
           "|" + "---|" * width]
    for r in rows[1:]:
        out.append("| " + " | ".join(r) + " |")
    return "\n".join(out)


def main() -> None:
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    doc = Document(str(src))
    blocks: list[str] = []
    first_title_done = False
    table_no = 0

    for child in doc.element.body.iterchildren():
        tag = child.tag.split("}")[-1]
        if tag == "p":
            p = Paragraph(child, doc)
            if not p.text.strip():
                continue
            if not first_title_done:
                # 文档第一段 = 封面标题
                blocks.append("# " + p.text.strip())
                first_title_done = True
                continue
            md = para_to_md(p.style.name, p.text)
            if md:
                blocks.append(md)
        elif tag == "tbl":
            table_no += 1
            blocks.append(table_to_md(Table(child, doc)))

    dst.write_text("\n\n".join(blocks) + "\n", encoding="utf-8")
    print(f"✅ 抽出 {table_no} 张表、{len(blocks)} 个块 → {dst}")


if __name__ == "__main__":
    main()
