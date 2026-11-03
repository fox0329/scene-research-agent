#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""场景通演示资料生成器 —— 云枢智控（YunShu Controls）虚构产品资料包。

产出（全部写入本脚本所在目录，幂等覆盖）：
  1. 云枢智控-产品规格参数表.xlsx
  2. 场景A-汽车零部件压铸车间设备联网与OEE提升-客户资料.docx
  3. 场景B-市政污水处理厂设备监控与能耗管理-客户资料.docx

所有公司、品牌、型号、客户、地名、人名均为虚构设定，仅用于对外演示。
本脚本只写上述 3 个「非成稿素材」，不触碰仓库内其它任何文件。
白皮书与产品介绍 PPT 是「成稿」，改由产品自己的输出链路生成——内容是抽出来的 Markdown /
大纲 JSON，排版走 @scene/infra 的报告与幻灯片渲染器，见：
  ../../.tools/build-whitepaper.mjs   （Word）
  ../../.tools/build-deck.mjs --emit  （PPT，ppt-master + B站蓝色模板）

运行：python3 generate.py     （需 python-docx / python-pptx / openpyxl）
"""

from __future__ import annotations

import base64
import hashlib
import re
import sys
from datetime import datetime
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, Cm, RGBColor as DocxRGB

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font as XlFont, PatternFill, Side
from openpyxl.utils import get_column_letter

from pptx import Presentation
from pptx.dml.color import RGBColor as PptxRGB
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN
from pptx.util import Inches, Pt as PptxPt

OUT_DIR = Path(__file__).resolve().parent

DOC_WHITEPAPER = "云枢智控-产品与能力白皮书.docx"
DOC_SPECS = "云枢智控-产品规格参数表.xlsx"
DOC_DECK = "云枢智控-产品介绍.pptx"
DOC_SCENE_A = "场景A-汽车零部件压铸车间设备联网与OEE提升-客户资料.docx"
DOC_SCENE_B = "场景B-市政污水处理厂设备监控与能耗管理-客户资料.docx"

OUTPUT_FILES = [DOC_WHITEPAPER, DOC_SPECS, DOC_DECK, DOC_SCENE_A, DOC_SCENE_B]

# 固定时间戳：保证多次运行产出内容一致（幂等可校验）
FIXED_TS = datetime(2025, 11, 1, 9, 0, 0)

COMPANY = "云枢智控"
COMPANY_EN = "YunShu Controls"
FICTION_NOTE = "虚构演示资料：公司、产品、型号、客户、案例与数据均为虚构设定，无任何真实企业或个人。"
MAIL = "contact@yunshu-controls.example"

# ---------------------------------------------------------------- 样式常量
EA_FONT = "微软雅黑"
LAT_FONT = "Calibri"
C_DARK = "14304A"
C_ACCENT = "2E9BB5"
C_LIGHT = "EEF4F7"
C_GREY = "5B6B78"
C_BODY = "23313D"

# ---------------------------------------------------------------- 脱敏黑名单
# 目的：交付前全文扫描，确认没有真实厂商 / 地名 / 人名混入。
# 以 base64 存放，避免黑名单本身出现在同一交付目录下的脚本里。
_DENY_B64 = (
    "Vgnopb/pl6jlrZAKVgnlj5HpgqPnp5EKVgnlipvlirIKVgnkvIrkuYvlr4YKVgnkuInoj7EKVgnmsYflt50KVgnmlr3ogJDlvrcK"
    "VgnmrKflp4bpvpkKVgnlgI3npo8KVgnotJ3liqDojrEKVgnlj7Dovr4KVgnnoJTljY4KVgnnvZflhYvpn6blsJQKVgnoj7LlsLzl"
    "hYvmlq8KVgnprY/lvrfnsbPli5IKVgnotavmlq/mm7wKVgnmkanojo4KVgnlkozliKnml7YKVgnlrp3kv6EKVgnmoJHmoLnkupLo"
    "gZQKVgnljaHlpaXmlq8KVgnljY7kuLoKVgnpmL/ph4zkupEKVgnohb7orq/kupEKVgnnmb7luqbmmbrog73kupEKVgnoib7pu5jn"
    "lJ8KVgnpnI3lsLzpn6blsJQKVgnmqKrmsrMKVgnln7rmganlo6sKVgnlurfogJDop4YKVgnmtbflurflqIHop4YKVgnlpKfljY7o"
    "gqHku70KVgnlh4zkupHlhYkKVgnlupPljaEKVgnlronlt50KVgnpgqPmmboKVgnlt53ltI4KVgnniLHmma7nlJ8KVgnlvq7ova8K"
    "Vgnovr7ntKIKVgnmlrDmnb4KVgnln4Pmlq/pob8KVgnln4PlpKvnibkKVgnphY3lpKkKVgnoioLljaEKVgnpgajljZoKVgnkvJjl"
    "grIKVgnotornloYKVgnmgJ3ngbUKVgnplYHkvL0KVgnlvq7kur8KVgnliJvmlrDlpYfmmboKVgnml7fop4YKVgnllYbmsaQKVgnk"
    "vp3lm74KVgnkupHku44KVgnnrKzlm5vojIPlvI8KVgnmmI7nlaUKVgnmtbflsJQKVgnnvo7nmoQKVgnmoLzlipsKVgnmr5Tkupro"
    "v6oKVgnlroHlvrfml7bku6MKVgnkuK3ovaYKVgnkuK3nn7PljJYKVgnkuK3nn7PmsrkKVgnlm73lrrbnlLXnvZEKVgnljZfmlrnn"
    "lLXnvZEKVgnnq4vorq8KVgnlr4zlo6vlurcKVgnmvY3mn7QKVgnkuInkuIDph43lt6UKVgnlvpDlt6UKVgnmn7Plt6UKVgnmjK/l"
    "jY4KVgnkuK3lhbQKVgnmtarmva4KVgnnlKjlj4sKVgnph5HonbYKVgnpvI7mjbcKVgnmsYnlvpcKVgnmkanlsJTlhYPmlbAKVgnp"
    "u5HmuZYKVgnomJHoj4fnianogZQKVgnlr4TkupEKVgnmmIbku5HmlbDmja4KVgnlpKnms73mmbrkupEKVgnkuJzmlrnlm73kv6EK"
    "Vgnlv73nsbMKVgnnvo7kupHmmbrmlbAKVgnmoLzliJvkuJzmmboKVgnogZTmg7MKVgnkuqzkuJzmlrkKVgnlj7Dnp6/nlLUKVgnk"
    "uK3oiq/lm73pmYUKVgnplb/msZ/lrZjlgqgKVgnlhYbmmJPliJvmlrAKVgnlhajlv5cKVgnnkZ7oiq/lvq4KVgnmmbbmmagKVgnl"
    "kJvmraMKVgnpvpnoiq8KVgnpo57ohb4KVgnlhYboiq8KVgnmtbfmgJ0KVgnntKvlhYkKVgnlsZXplJAKVgnnv7HmjbcKVgnnp7vo"
    "v5wKVgnlub/lkozpgJoKVgnnvo7moLwKVgnmnInmlrkKVgnoiq/orq/pgJoKVgnmsYfpobYKVgnlo6vlhbDlvq4KVgnljY7mtqbl"
    "vq4KVgnpl7vms7AKVgnljY7li6QKVgnpvpnml5cKVgnkuK3np5HliJvovr4KVgnmtqblkowKVgnova/pgJrliqjlipsKVgnor5ro"
    "v4gKVgnnu5/kv6EKVgnpupLpup/ova/ku7YKVgnmt7Hluqbnp5HmioAKVgnlm77lsJTlhYsKVgnlgI3liqDnpo8KVgnopb/lhYsK"
    "VgnlirPmmJPmtYsKVgnlt7TpsoHlpKsKVgnmmJPnpo/pl6gKVgnloKHnm58KVgnlqIHlm74KVgnnmq7lsJTno4EKVgnmlr3ov4jo"
    "tZsKVgnlr4zlo6vnlLXmnLoKVgnmnb7kuIsKVgnmlrDljY7kuIkKVgnplJDmjbcKVgnov4jmma4KVgnmgJ3np5EKVgnmm5nlhYkK"
    "Vgnplb/ln44KVgnlkIzmlrkKVgnpnZ7lpJUKVgnnj57nn7MKVgnlpKfml48KVgnljY7kuK3mlbDmjqcKVgnlub/lt57mlbDmjqcK"
    "VgnljaHor7rmma4KVgnlsJTlv4XlnLAKVgnli4Pogq/nibkKVgnmnY7nvqQKVgnoib7liKnnibkKVgnlj5HmoLwKVgnmtbflvrfm"
    "sYkKVgnmtbflvrfmsYkKVgnpm7flsLznu40KVgnolKHlj7gKVgnkuInkuLAKVgnpqazlsJQKVgnlronmjbfkvKYKVgnmmK/lvrcK"
    "Vgnms7DlhYsKVgnnpo/npoTlhYsKVgnmqKrmsrPnlLXmnLoKUAnljJfkuqwKUAnkuIrmtbcKUAnlub/lt54KUAnmt7HlnLMKUAnl"
    "pKnmtKUKUAnph43luoYKUAnoi4/lt54KUAnml6DplKEKUAnluLjlt54KUAnljZfkuqwKUAnljZfpgJoKUAnlvpDlt54KUAnmiazl"
    "t54KUAnnm5Dln44KUAnms7Dlt54KUAnplYfmsZ8KUAnov57kupHmuK8KUAnlrr/ov4EKUAnmt67lrokKUAnmna3lt54KUAnlroHm"
    "s6IKUAnmuKnlt54KUAnlmInlhbQKUAnmuZblt54KUAnnu43lhbQKUAnph5HljY4KUAnlj7Dlt54KUAnkuL3msLQKUAnooaLlt54K"
    "UAnoiJ/lsbEKUAnlkIjogqUKUAnoipzmuZYKUAnmtY7ljZcKUAnpnZLlspsKUAnng5/lj7AKUAnmvY3lnYoKUAnmt4TljZoKUAnk"
    "uLTmsoIKUAnpg5Hlt54KUAnmtJvpmLMKUAnmrabmsYkKUAnplb/mspkKUAnmoKrmtLIKUAnljZfmmIwKUAnnpo/lt54KUAnljqbp"
    "l6gKUAnms4nlt54KUAnmiJDpg70KUAnnu7XpmLMKUAnlvrfpmLMKUAnopb/lrokKUAnlrp3puKEKUAnmsojpmLMKUAnlpKfov54K"
    "UAnpno3lsbEKUAnplb/mmKUKUAnlk4jlsJTmu6gKUAnlpKfluoYKUAnnn7PlrrbluoQKUAnllJDlsbEKUAnkv53lrpoKUAnlpKrl"
    "jp8KUAnlkbzlkozmtannibkKUAnljIXlpLQKUAnlhbDlt54KUAnopb/lroEKUAnpk7blt50KUAnkuYzpsoHmnKjpvZAKUAnmi4no"
    "kKgKUAnmmIbmmI4KUAnotLXpmLMKUAnljZflroEKUAnmn7Plt54KUAnmtbflj6MKUAnkuInkupoKUAnkvZvlsbEKUAnkuJzojp4K"
    "UAnnj6DmtbcKUAnkuK3lsbEKUAnmg6Dlt54KUAnmsZ/pl6gKUAnmsZXlpLQKUAnmuZvmsZ8KUAnmsZ/oi4/nnIEKUAnmtZnmsZ/n"
    "nIEKUAnlub/kuJznnIEKUAnlsbHkuJznnIEKUAnmsrPljZfnnIEKUAnmsrPljJfnnIEKUAnmuZbljJfnnIEKUAnmuZbljZfnnIEK"
    "UAnlm5vlt53nnIEKUAnpmZXopb/nnIEKUAnnpo/lu7rnnIEKUAnlronlvr3nnIEKUAnmsZ/opb/nnIEKUAnovr3lroHnnIEKUAnl"
    "kInmnpfnnIEKUAnpu5HpvpnmsZ/nnIEKUAnlsbHopb/nnIEKUAnkupHljZfnnIEKUAnotLXlt57nnIEKUAnlub/opb8KUAnmtbfl"
    "jZfnnIEKUAnnlJjogoPnnIEKUAnpnZLmtbfnnIEKUAnmlrDnloYKUAnopb/ol48KUAnlhoXokpnlj6QKUAnlroHlpI8KUAnplb/k"
    "uInop5IKUAnnj6DkuInop5IKUAnkuqzmtKXlhoAKUAnlpKfmub7ljLoKUAnljY7kuK0KUAnljY7ljZcKUAnljY7ljJcKUAnopb/l"
    "jJcKUAnopb/ljZcKUAnkuJzljJcKUAnmmIblsbEKUAnluLjnhp8KUAnlvKDlrrbmuK8KUAnmsZ/pmLQKUAnlrpzlhbQKUAnmhYjm"
    "uqoKUAnkvZnlp5oKUAnor7jmmqgKUAnmmYvmsZ8KUAnpvpnlsqkKUAnojobnlLAKUAnmvLPlt54KUAnotaPlt54KUAnkuZ3msZ8K"
    "UAnlrpzmmIwKUAnopYTpmLMKUAnlsrPpmLMKUAnluLjlvrcKUAnooaHpmLMKUAnmtY7lroEKUAnms7DlrokKUAnlqIHmtbcKUAnk"
    "uJzokKUKUAnmlrDkuaEKUAnnhKbkvZwKUAnorrjmmIwKUAnmuZjmva0KUAnlrpzlrr4KUAnms7jlt54KUAnmm7LpnZYKUAnpgbXk"
    "uYkKUAnmoYLmnpcKUAnojILlkI0KUAnmj63pmLMKUAnmuIXov5wKUAnpn7blhbMKUAnpmLPmsZ8KUAnogofluoYKUAnmooXlt54K"
    "UAnmva7lt54KUAnkupHmta4KUAnmsrPmupAKUAnmsZXlsL4KUAnlrZ3mhJ8KUAnojYblt54KUAnpu4Tnn7MKUAnljYHloLAKUAno"
    "mozln6AKUAnpqazpno3lsbEKUAnlronluoYKUAnpmJzpmLMKUAnlha3lrokKUAnljZflubMKUAnlroHlvrcKUAnmma/lvrfplYcK"
    "UAnokI3kuaEKUAnmlrDkvZkKUAnpubDmva0KUAnlkInlrokKUAnmiprlt54KUAnkuIrppbYKUAnml6XnhacKUAnlvrflt54KUAno"
    "gYrln44KUAnmu6jlt54KUAnoj4/ms70KUAnmnqPluoQKUAnlvIDlsIEKUAnlubPpobblsbEKUAnlronpmLMKUAnpuaTlo4EKUAnm"
    "v67pmLMKUAnmvK/msrMKUAnkuInpl6jls6EKUAnljZfpmLMKUAnllYbkuJgKUAnkv6HpmLMKUAnlkajlj6MKUAnpqbvpqazlupcK"
    "UAnpgq/pg7gKUAnpgqLlj7AKUAnmsqflt54KUAnlu4rlnYoKUAnooaHmsLQKUAnpmLPms4kKUAnplb/msrsKUAnmmYvln44KUAnm"
    "nJTlt54KUAnmmYvkuK0KUAnov5Dln44KUAnlv7vlt54KUAnkuLTmsb4KUAnlkJXmooEKUAnplKblt54KUAnokKXlj6MKUAnpmJzm"
    "lrAKUAnovr3pmLMKUAnnm5jplKYKUAnpk4Hlsq0KUAnokavoiqblspsKUAnpvZDpvZDlk4jlsJQKUAnniaHkuLnmsZ8KUAnkvbPm"
    "nKjmlq8KUAnlhYvmi4nnjpvkvp0KUAnlpKfnkIYKUAnkuL3msZ8KUAnlkrjpmLMKUAnmuK3ljZcKUAnlu7blrokKUAnmsYnkuK0K"
    "UAnmpobmnpcKUAnlronlurcKUAnllYbmtJsKUAnlpKnmsLQKUAnphZLms4kKUAnlpKnmsLQKUAnmlabnhYwKTgnku7vmraPpnZ4K"
    "TgnpqazkupEKTgnpqazljJbohb4KTgnpm7flhpsKTgnokaPmmI7nj6AKTgnmm7nlvrfml7oKTgnnjovkvKDnpo8KTgnmnY7kuabn"
    "po8KTgnmm77mr5PnvqQKTgnlvKDkuIDpuKMKTgnliJjlvLrkuJwKTgnnjovlgaXmnpcKTgnorrjlrrbljbAKTgnmnY7lvablro8K"
    "TgnkuIHno4oKTgnlkajpuL/npY4KTgnpu4Tls6UKTgnnjovlhbQKTgnlvKDlsI/pvpkKTgnkvZnmib/kuJwKTgnlvpDnm7TlhpsK"
    "Tgnmsarmu5QKTgnmnY7mg7MKTgnkvZXlsI/puY8KTgnmnY7mlowKTgnnjovnn7MKTgnmn7PkvKDlv5cKTgnmnajlhYPluoYKTgnp"
    "mYjlpKnnn7MKTgnmsaTmmZPpuKUKTgnljbDlpYcKTgnmnLHnj5EKTgnlkajmm6YKTgnnjovlnZoKTgnlvKDli4cKTgnpmYjnnb8K"
    "Tgnlrr/ljY4KTgnnqIvnu7QKTgnmooHlu7rnq6AKTgnlrZnlro/mlowKTgnpg4Hkuq4KTgnlrpfluoblkI4KTgnpkp/nnZLnnZIK"
    "Tgnnp6boi7HmnpcKTgnpu4Tls6UKTAlBQkIKTAlGQU5VQwpMCU1PWEEKTAlTaWVtZW5zCkwJUm9ja3dlbGwKTAlTY2huZWlkZXIK"
    "TAlPbXJvbgpMCUJlY2tob2ZmCkwJQWR2YW50ZWNoCkwJV2VpZG11bGxlcgpMCUhpcnNjaG1hbm4KTAlNaXRzdWJpc2hpCkwJWWFz"
    "a2F3YQpMCUtVS0EKTAlLYXdhc2FraQpMCU5hY2hpCkwJRXBzb24KTAlLZXllbmNlCkwJQ29nbmV4CkwJSGlrdmlzaW9uCkwJRGFo"
    "dWEKTAlFbWVyc29uCkwJSG9uZXl3ZWxsCkwJWW9rb2dhd2EKTAlIdWF3ZWkKTAlBbGliYWJhCkwJVGVuY2VudApMCUJhaWR1CkwJ"
    "WGlhb21pCkwJTWljcm9zb2Z0CkwJQXp1cmUKTAlBV1MKTAlTQVAKTAlPcmFjbGUKTAlEYXNzYXVsdApMCUF1dG9kZXNrCkwJU29s"
    "aWRXb3JrcwpMCUdvb2dsZQpMCUludGVsCkwJTlZJRElBCkwJUXVhbGNvbW0KTAlNZWRpYVRlawpMCVJvY2tjaGlwCkwJQWxsd2lu"
    "bmVyCkwJQnJvYWRjb20KTAlOWFAKTAlJbmZpbmVvbgpMCVJlbmVzYXMKTAlNaWNyb2NoaXAKTAlYaWxpbngKTAlBbHRlcmEKTAlT"
    "VE1pY3JvCkwJU2NobmVpZGVyIEVsZWN0cmljCkwJRGVsdGEgRWxlY3Ryb25pY3MKTAlQaG9lbml4IENvbnRhY3QKTAlDaXNjbwpM"
    "CUp1bmlwZXIKTAlIM0MKTAlSdWlqaWUKTAlUUC1MSU5LCkwJTkVUR0VBUgpMCUFyaXN0YQpMCURlbGwKTAlIUEUKTAlMZW5vdm8K"
    "TAlJQk0KTAlUdXJjawpMCVNJQ0sKTAlMZXV6ZQpMCUJhbGx1ZmYKTAlCYXVtZXIKTAlSaXR0YWwKTAlQaWx6CkwJU2NobWVyc2Fs"
    "CkwJUGFuYXNvbmljCkwJRnVqaQpMCUVuZHJlc3MKTAlQZXBwZXJsCkwJSGV4YWdvbgpMCVJlbmlzaGF3CkwJWmVpc3MKTAlNaXR1"
    "dG95bwpMCUZsdWtlCkwJS2V5c2lnaHQKTAlUZWt0cm9uaXgKTAlCb3NjaApMCVJleHJvdGgKTAlEYW5mb3NzCkwJU0VXCkwJTGVu"
    "emUKTAlWYWNvbgpMCVdlZwpMCU1hcmVsbGkKTAlDb250aW5lbnRhbApMCVZhbGVvCkwJWkYKTAlXZWJhc3RvCkwJTWFnbmEKTAlG"
    "YXVyZWNpYQpMCVBsYXN0aWMgT21uaXVtCkwJRm94Y29ubgpMCVBlZ2F0cm9uCkwJV2lzdHJvbgpMCVF1YW50YQpMCUNvbXBhbApM"
    "CUludmVudGVjCg=="
)
_DENY_RAW = base64.b64decode(_DENY_B64).decode("utf-8")
DENY_CJK: list[str] = []
DENY_LATIN: list[str] = []
for _line in _DENY_RAW.splitlines():
    if not _line.strip():
        continue
    _kind, _, _word = _line.partition("\t")
    if _kind == "L":
        DENY_LATIN.append(_word)
    else:
        DENY_CJK.append(_word)

# ---------------------------------------------------------------- 产品设定
PRODUCT_LINES = [
    ("边缘控制器", "YS-EC3200 紧凑型边缘控制器", "在售", "2024-06",
     "单机台 / 单工位数据采集与联锁控制，替代“小型 PLC + 网关”组合"),
    ("边缘控制器", "YS-EC5200 高性能边缘控制器", "在售", "2025-03",
     "多机台汇聚 + 边缘 AI 推理，内置软 PLC，可前置处理视觉质检"),
    ("边缘控制器", "YS-EC5600 高可靠边缘控制器", "在研", "计划 2026-09",
     "双机热备、宽温，面向流程行业关键回路（SIL2 为设计目标）"),
    ("工业网关", "YS-GW2100 多协议工业网关", "在售", "2023-11",
     "存量设备协议接入与上云，纯采集不含控制"),
    ("工业网关", "YS-GW4300 5G 边缘网关", "在售", "2025-01",
     "5G / 有线双上行 + 本地规则引擎 + 本地时序存储"),
    ("边缘智能平台", "YS-CloudLink 设备管理平台", "在售", "2023-09",
     "设备接入、远程配置、OTA、告警、数据服务"),
    ("边缘智能平台", "YS-VisionEdge 视觉质检套件", "在售", "2025-06",
     "小样本缺陷检测，需配合 YS-EC5200 的 NPU"),
    ("边缘智能平台", "YS-Pad10 工业平板", "停售", "2022-05",
     "现场 HMI 移动终端（已被 YS-EC5200 内置 Web HMI 取代）"),
]

PROTOCOLS = "Modbus RTU/TCP、OPC UA、IEC 60870-5-104、Profinet、EtherNet/IP"
OS_EC3200 = "云枢 OS（基于 OpenHarmony 5.0）"
OS_EC5200 = "云枢 OS + 软 PLC（IEC 61131-3）"
PENDING = "待定"
NOT_LISTED = "本次规格清单未列明"

# 规格参数表：型号 × 参数项 × 数值
SPEC_ROWS: list[tuple[str, str, str]] = []


def _spec(model: str, item: str, value: str) -> None:
    SPEC_ROWS.append((model, item, value))


# YS-EC3200（15 行）
_spec("YS-EC3200", "产品状态", "在售")
_spec("YS-EC3200", "上市时间", "2024-06")
_spec("YS-EC3200", "CPU", "4×Cortex-A55 @1.8GHz")
_spec("YS-EC3200", "内存 / 存储", "1GB DDR4 / 8GB eMMC")
_spec("YS-EC3200", "AI 算力", "无 NPU")
_spec("YS-EC3200", "现场接口", "2×RS485、1×CAN")
_spec("YS-EC3200", "网络接口", "2×千兆网口")
_spec("YS-EC3200", "工作温度", "-25~60℃")
_spec("YS-EC3200", "供电", "24V DC")
_spec("YS-EC3200", "安装方式", "DIN35 导轨")
_spec("YS-EC3200", "防护等级", "IP20")
_spec("YS-EC3200", "典型功耗", "6W")
_spec("YS-EC3200", "操作系统", OS_EC3200)
_spec("YS-EC3200", "协议支持", PROTOCOLS)
_spec("YS-EC3200", "软件能力",
      "多协议设备接入；存量设备旁路改造接入（不改原 PLC 程序与机械结构）；"
      "能耗数据采集与分项计量（需外接智能电表）；数据上云（MQTT / HTTPS）")

# YS-EC5200（17 行）
_spec("YS-EC5200", "产品状态", "在售")
_spec("YS-EC5200", "上市时间", "2025-03")
_spec("YS-EC5200", "CPU", "8 核（4×Cortex-A76 + 4×Cortex-A55）@2.4GHz")
_spec("YS-EC5200", "内存 / 存储", "4GB DDR4 / 32GB eMMC")
_spec("YS-EC5200", "AI 算力", "NPU 6 TOPS")
_spec("YS-EC5200", "现场接口", "4×RS485、2×CAN")
_spec("YS-EC5200", "网络接口", "4×千兆网口、2×SFP 光口")
_spec("YS-EC5200", "采集性能", "边缘侧高频数据采集，单机约 2000 点/秒")
_spec("YS-EC5200", "工作温度", "-40~70℃")
_spec("YS-EC5200", "供电", "双电源冗余")
_spec("YS-EC5200", "安装方式", "DIN35 导轨")
_spec("YS-EC5200", "防护等级", "IP20")
_spec("YS-EC5200", "典型功耗", "15W")
_spec("YS-EC5200", "操作系统", OS_EC5200)
_spec("YS-EC5200", "协议支持", PROTOCOLS)
_spec("YS-EC5200", "软件能力",
      "软 PLC 控制（IEC 61131-3）；边缘 AI 推理（6 TOPS NPU）；边缘规则引擎与本地联锁；"
      "断网续传与本地缓存（默认 7 天，可扩至 30 天）；OPC UA Server 与 REST 接口；"
      "边缘侧数据白名单出网与脱敏")
_spec("YS-EC5200", "平台协同", "可作为 YS-VisionEdge 的推理载体（单台支持 2 路相机）")

# YS-EC5600（在研，11 行）
_spec("YS-EC5600", "产品状态", "在研")
_spec("YS-EC5600", "计划上市时间", "2026-09")
_spec("YS-EC5600", "产品定位", "双机热备、宽温，面向流程行业关键回路")
_spec("YS-EC5600", "可靠性设计", "双机热备")
_spec("YS-EC5600", "工作温度", "-40~75℃")
_spec("YS-EC5600", "功能安全", "SIL2（设计目标）")
_spec("YS-EC5600", "CPU / 内存 / 存储", PENDING)
_spec("YS-EC5600", "AI 算力", PENDING)
_spec("YS-EC5600", "现场接口 / 网络接口", PENDING)
_spec("YS-EC5600", "供电 / 安装方式 / 防护等级 / 典型功耗", PENDING)
_spec("YS-EC5600", "操作系统 / 协议支持 / 软件能力", PENDING)

# YS-GW2100（13 行）
_spec("YS-GW2100", "产品状态", "在售")
_spec("YS-GW2100", "上市时间", "2023-11")
_spec("YS-GW2100", "CPU", "2×Cortex-A53 @1.2GHz")
_spec("YS-GW2100", "内存 / 存储", "512MB / 8GB")
_spec("YS-GW2100", "AI 算力", "无 NPU")
_spec("YS-GW2100", "现场接口", "1×RS485、1×RS232")
_spec("YS-GW2100", "网络接口", "2×千兆网口")
_spec("YS-GW2100", "采集性能", "采集吞吐约 2000 点/秒")
_spec("YS-GW2100", "工作温度", "-20~65℃")
_spec("YS-GW2100", "典型功耗", "4W")
_spec("YS-GW2100", "供电 / 安装方式 / 防护等级 / 操作系统", NOT_LISTED)
_spec("YS-GW2100", "协议支持", PROTOCOLS)
_spec("YS-GW2100", "软件能力",
      "纯采集不含控制；多协议设备接入；存量设备旁路改造接入（不改原 PLC 程序与机械结构）；"
      "能耗数据采集与分项计量（需外接智能电表）；数据上云（MQTT / HTTPS）")

# YS-GW4300（12 行）
_spec("YS-GW4300", "产品状态", "在售")
_spec("YS-GW4300", "上市时间", "2025-01")
_spec("YS-GW4300", "CPU / 内存 / 存储", "基于 YS-GW2100 平台（2×Cortex-A53 @1.2GHz / 512MB / 8GB）")
_spec("YS-GW4300", "无线模组", "5G NR / LTE")
_spec("YS-GW4300", "现场接口", "1×RS485、1×RS232")
_spec("YS-GW4300", "网络接口", "2×千兆网口，5G / 有线双上行")
_spec("YS-GW4300", "采集性能", "采集吞吐约 2000 点/秒")
_spec("YS-GW4300", "工作温度", "-20~65℃")
_spec("YS-GW4300", "典型功耗", "9W")
_spec("YS-GW4300", "供电 / 安装方式 / 防护等级 / 操作系统", NOT_LISTED)
_spec("YS-GW4300", "协议支持", PROTOCOLS)
_spec("YS-GW4300", "软件能力",
      "本地时序数据存储（保留 30 天）；本地规则引擎（最多 200 条）；"
      "断网续传与本地缓存（默认 7 天，可扩至 30 天）；边缘侧数据白名单出网与脱敏；"
      "数据上云（MQTT / HTTPS）")

# YS-CloudLink（8 行）
_spec("YS-CloudLink", "产品状态", "在售")
_spec("YS-CloudLink", "上市时间", "2023-09")
_spec("YS-CloudLink", "交付形态", "私有化部署")
_spec("YS-CloudLink", "部署限制", "不支持公有云多租户（本期只做本地化 / 私有化部署）")
_spec("YS-CloudLink", "接入规模", "单实例建议接入 ≤5000 台设备或 ≤500 点位包")
_spec("YS-CloudLink", "组态能力", "Web HMI 组态，浏览器访问，无需安装客户端")
_spec("YS-CloudLink", "接口能力", "OpenAPI 与 Webhook")
_spec("YS-CloudLink", "软件能力",
      "设备接入、远程配置、OTA 升级、告警、数据服务；统一设备模型与测点命名规范；"
      "设备台账与资产健康度；与 MES / SCADA 对接（提供 OPC UA Server 与 REST 接口）")

# YS-VisionEdge（7 行）
_spec("YS-VisionEdge", "产品状态", "在售")
_spec("YS-VisionEdge", "上市时间", "2025-06")
_spec("YS-VisionEdge", "部署依赖", "需配合 YS-EC5200 的 NPU")
_spec("YS-VisionEdge", "算法能力", "小样本缺陷检测")
_spec("YS-VisionEdge", "样本要求", "每类缺陷 20–50 张样本起步")
_spec("YS-VisionEdge", "相机路数", "单台 YS-EC5200 支持 2 路相机")
_spec("YS-VisionEdge", "限制说明", "YS-EC3200 与 YS-GW 系列不具备推理能力，不支持")

# YS-Pad10（6 行）
_spec("YS-Pad10", "产品状态", "停售")
_spec("YS-Pad10", "上市时间", "2022-05")
_spec("YS-Pad10", "功能状态", "不再提供新功能")
_spec("YS-Pad10", "维保截止", "2026-12")
_spec("YS-Pad10", "产品定位", "现场 HMI 移动终端")
_spec("YS-Pad10", "替代说明", "已被 YS-EC5200 内置 Web HMI 取代")

CAPABILITIES = [
    ("多协议设备接入（Modbus RTU/TCP、OPC UA、IEC 60870-5-104、Profinet、EtherNet/IP）",
     "GW2100 / GW4300 / EC3200 / EC5200"),
    ("存量设备旁路改造接入（不改原 PLC 程序与机械结构）", "GW2100 / GW4300 / EC3200"),
    ("边缘侧高频数据采集（单机约 2000 点/秒）", "GW2100 / GW4300 / EC5200"),
    ("边缘规则引擎与本地联锁", "GW4300 / EC5200"),
    ("软 PLC 控制（IEC 61131-3）", "EC5200"),
    ("边缘 AI 推理（6 TOPS NPU）", "EC5200"),
    ("小样本视觉缺陷检测", "VisionEdge + EC5200"),
    ("设备远程配置与 OTA 升级", "CloudLink"),
    ("断网续传与本地缓存（默认 7 天，可扩至 30 天）", "GW4300 / EC5200"),
    ("本地时序数据存储（保留 30 天）", "GW4300"),
    ("统一设备模型与测点命名规范", "CloudLink"),
    ("告警与工单对接（Webhook / OpenAPI）", "CloudLink"),
    ("数据上云（MQTT / HTTPS，可对接第三方物联网平台）", "全系列"),
    ("设备台账与资产健康度", "CloudLink"),
    ("能耗数据采集与分项计量（需外接智能电表）", "GW2100 / GW4300 / EC3200"),
    ("与 MES / SCADA 对接（提供 OPC UA Server 与 REST 接口）", "CloudLink / EC5200"),
    ("边缘侧数据白名单出网与脱敏", "GW4300 / EC5200"),
    ("组态化看板（浏览器访问，无需安装客户端）", "CloudLink"),
]

BOUNDARIES = [
    ("不做 PLC 下位的运动控制与安全回路控制",
     "安全功能须由独立的安全 PLC 承载。云枢智控的控制器只做数据采集、联锁逻辑与工艺侧"
     "前置处理，不进入安全回路，不承担安全功能认证责任。这样划分既符合现场既有安全设计，"
     "也避免把信息安全与功能安全两类风险混在一起。"),
    ("不提供自研 MES / ERP 业务系统，只做数据对接",
     "工单、排产、账务、质量放行这些业务逻辑与客户的组织流程强耦合，客户通常已有体系且"
     "更换成本极高。我们只负责把设备数据做准、做全、按标准接口送出去，业务系统仍由客户"
     "既有的 MES / ERP 承载。"),
    ("不做工业网络的三层交换与路由设备，不替代工业交换机",
     "工业交换机的选型与网络架构设计属于网络设备厂商的专业范围。我们提供的是边缘侧设备"
     "与上云通道，网络层仍按客户既有规范建设，我们不参与设备竞争也不承担网络层责任。"),
    ("不承接客户 OT 网络的整体设计与施工总包",
     "OT 网络涉及生产安全、等保合规与停产窗口，需要具备相应资质与现场经验的集成商承担。"
     "我们提供产品、点表梳理方法与技术支持，由客户或其指定的集成商负责整体设计与施工。"),
    ("不提供公有云多租户 SaaS 版本（本期只做本地化 / 私有化部署）",
     "制造与市政客户的设备数据普遍有出域限制，私有化部署更符合客户的数据归属与审批要求。"
     "公有云多租户版本列入路线图（CloudLink 2.0，2027），本期不交付。"),
    ("不做机械臂 / AGV 等移动设备的运动控制",
     "移动设备的运动控制与本体深度绑定，需要本体厂商的控制器与安全策略配合。我们可以采集"
     "机器人的运行状态与节拍数据（例如锐臂 RB-6 这类去毛刺机器人的状态与报警），但不做其"
     "运动控制。"),
]

LIMITATIONS = [
    "单台 YS-GW2100 满负载协议转换上限约 2000 点/秒，超过需横向增加网关。选型时按“目标测点"
    "数 × 刷新频率”估算点位流量，并预留 30% 余量；点数密集的车间建议按区域分片，多台网关"
    "并行接入。",
    "YS-GW4300 本地时序库保留 30 天，超期需上云或扩容。若客户要求本地留存超过 30 天，需要"
    "在方案中同时规划平台侧存储或外置存储，不能只依赖网关本地库。",
    "YS-VisionEdge 必须配合 YS-EC5200 的 NPU，EC3200 与 GW 系列不具备推理能力。视觉质检"
    "方案的最小单元是“EC5200 + VisionEdge + 相机”，不要按纯软件套件立项。",
    "YS-Pad10 已停售，不再提供新功能，维保至 2026-12。现场 HMI 需求应改用 YS-EC5200 内置的 "
    "Web HMI；已采购 Pad10 的客户需在维保到期前完成替换评估。",
    "YS-CloudLink 目前只支持私有化部署，不支持公有云多租户。多厂区客户需要在每个部署实例"
    "之间规划数据汇总方式，不能假设一个实例直连全部厂区。",
    "边缘规则引擎单设备最多 200 条规则，超出需拆分。规则数量与测点数、触发频率相关，复杂"
    "联锁建议下沉到软 PLC 逻辑或按设备分组拆分到多台控制器。",
    "断网本地缓存默认 7 天，长期断网会丢最早数据（可选配扩至 30 天）。对断网时长敏感的"
    "场景，选型时明确缓存容量，并在方案中约定断网告警策略。",
    "不支持 Profibus-DP / DeviceNet 等已淘汰现场总线，需外接协议转换器。这类总线在老设备"
    "上仍可见，需要在勘察阶段用点表盘点确认，并把转换器纳入方案边界。",
]

APPENDIX = [
    ("A.1 认证", [
        "已取得：CE、FCC、CCC；IEC 61131-2；EMC 4 级；RoHS / REACH。",
        "尚未取得：UL 与 IEC 62443-4-2（IEC 62443-4-2 认证列入 2026 Q4 计划）。",
        "注意：涉及北美市场准入或明确要求 IEC 62443-4-2 的项目，需在投标前确认认证状态。",
    ]),
    ("A.2 案例", [
        "某汽车零部件压铸厂：32 台设备联网，2025 年交付，OEE 提升 11 个百分点。",
        "某市政污水厂：6 座泵站远程监控，2024 年交付，巡检工时下降 35%。",
    ]),
    ("A.3 价格带（含税参考价）", [
        "YS-EC3200 约 3800 元/台；YS-EC5200 约 9800 元/台；YS-GW2100 约 2600 元/台；"
        "YS-GW4300 约 7600 元/台。",
        "YS-CloudLink 私有化：每厂 8–15 万元（含 500 点位）。",
        "以上为含税参考价，不含现场施工、线缆辅材与第三方协议转换器。",
    ]),
    ("A.4 资料", [
        "安装手册、Modbus 点表模板、OPC UA 建模指南、组态示例工程。",
    ]),
    ("A.5 路线图", [
        "YS-EC5600：2026 Q3。",
        "CloudLink 2.0 多租户：2027。",
        "IEC 62443-4-2 认证：2026 Q4 计划。",
    ]),
    ("A.6 生态", [
        "与 3 家区域集成商签订交付合作。",
        "已适配 12 家主流 PLC 品牌的点表。",
    ]),
]


def normalize_zip(path: Path) -> None:
    """把 OOXML 包的成员时间戳改写为固定值，保证多次运行产出字节一致。

    python-docx / openpyxl / python-pptx 内部用当前时间作为 zip 成员时间戳，
    不处理的话每次运行的文件哈希都会变；内容虽然一致，但无法用哈希校验幂等。
    """
    import os
    import zipfile

    fixed_w3cdtf = FIXED_TS.strftime("%Y-%m-%dT%H:%M:%SZ").encode("ascii")
    core_ts_re = re.compile(
        rb"(<dcterms:(?:created|modified)[^>]*>)[^<]*(</dcterms:(?:created|modified)>)")

    tmp = path.with_name(path.name + ".tmp")
    with zipfile.ZipFile(path, "r") as zin, \
            zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            if info.filename == "docProps/core.xml":
                # openpyxl 保存时会把 modified 覆写为当前时间，这里统一归一化
                data = core_ts_re.sub(lambda m: m.group(1) + fixed_w3cdtf + m.group(2), data)
            ni = zipfile.ZipInfo(info.filename,
                                 date_time=(FIXED_TS.year, FIXED_TS.month,
                                            FIXED_TS.day, FIXED_TS.hour,
                                            FIXED_TS.minute, FIXED_TS.second))
            ni.compress_type = info.compress_type
            ni.external_attr = info.external_attr
            ni.internal_attr = info.internal_attr
            ni.create_system = info.create_system
            zout.writestr(ni, data)
    os.replace(tmp, path)


# ================================================================ docx 工具
def _set_rfonts(rpr, latin: str = LAT_FONT, ea: str = EA_FONT) -> None:
    rf = rpr.find(qn("w:rFonts"))
    if rf is None:
        rf = OxmlElement("w:rFonts")
        rpr.append(rf)
    rf.set(qn("w:ascii"), latin)
    rf.set(qn("w:hAnsi"), latin)
    rf.set(qn("w:eastAsia"), ea)


def init_doc() -> Document:
    doc = Document()
    normal = doc.styles["Normal"]
    normal.font.name = LAT_FONT
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = DocxRGB.from_string(C_BODY)
    _set_rfonts(normal.element.get_or_add_rPr())
    normal.paragraph_format.line_spacing = 1.32
    normal.paragraph_format.space_after = Pt(6)

    for lvl, size, color, before in ((1, 16, C_DARK, 16), (2, 13, C_DARK, 12),
                                     (3, 11.5, C_ACCENT, 10), (4, 10.5, C_ACCENT, 8)):
        st = doc.styles["Heading %d" % lvl]
        st.font.name = LAT_FONT
        st.font.size = Pt(size)
        st.font.bold = True
        st.font.color.rgb = DocxRGB.from_string(color)
        st.font.italic = False
        _set_rfonts(st.element.get_or_add_rPr())
        st.paragraph_format.space_before = Pt(before)
        st.paragraph_format.space_after = Pt(6)
        st.paragraph_format.line_spacing = 1.2

    for sec in doc.sections:
        sec.top_margin = Cm(2.2)
        sec.bottom_margin = Cm(2.0)
        sec.left_margin = Cm(2.4)
        sec.right_margin = Cm(2.4)

    core = doc.core_properties
    core.created = FIXED_TS
    core.modified = FIXED_TS
    core.author = COMPANY
    core.last_modified_by = COMPANY
    core.comments = FICTION_NOTE
    return doc


def set_footer(doc: Document, text: str) -> None:
    for sec in doc.sections:
        para = sec.footer.paragraphs[0]
        para.text = ""
        para.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = para.add_run(text)
        run.font.size = Pt(8)
        run.font.color.rgb = DocxRGB.from_string(C_GREY)
        run.font.name = LAT_FONT
        _set_rfonts(run._element.get_or_add_rPr())


def para(doc: Document, text: str, size: float = 10.5, bold: bool = False,
         italic: bool = False, color: str = C_BODY, align=None,
         space_after: float = 6, indent: float = 0.0) -> None:
    p = doc.add_paragraph()
    if align is not None:
        p.alignment = align
    p.paragraph_format.space_after = Pt(space_after)
    if indent:
        p.paragraph_format.left_indent = Cm(indent)
    run = p.add_run(text)
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.italic = italic
    run.font.color.rgb = DocxRGB.from_string(color)
    run.font.name = LAT_FONT
    _set_rfonts(run._element.get_or_add_rPr())


def lead_para(doc: Document, lead: str, body: str) -> None:
    """加粗小标题 + 正文，写在同一段里（白皮书常见的条目写法）。"""
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(6)
    p.paragraph_format.left_indent = Cm(0.4)
    r1 = p.add_run(lead)
    r1.font.bold = True
    r1.font.size = Pt(10.5)
    r1.font.color.rgb = DocxRGB.from_string(C_DARK)
    r1.font.name = LAT_FONT
    _set_rfonts(r1._element.get_or_add_rPr())
    r2 = p.add_run("　" + body)
    r2.font.size = Pt(10.5)
    r2.font.color.rgb = DocxRGB.from_string(C_BODY)
    r2.font.name = LAT_FONT
    _set_rfonts(r2._element.get_or_add_rPr())


def bullets(doc: Document, items: list[str]) -> None:
    for it in items:
        p = doc.add_paragraph(style="List Bullet")
        p.paragraph_format.space_after = Pt(3)
        run = p.add_run(it)
        run.font.size = Pt(10.5)
        run.font.name = LAT_FONT
        _set_rfonts(run._element.get_or_add_rPr())


def caption(doc: Document, text: str) -> None:
    para(doc, text, size=9, color=C_GREY, italic=True, space_after=3)


def shade(cell, fill: str) -> None:
    tcpr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:fill"), fill)
    tcpr.append(shd)


def _cell(cell, text: str, bold: bool = False, size: float = 9.0,
          color: str = C_BODY, align=None) -> None:
    cell.text = ""
    p = cell.paragraphs[0]
    p.paragraph_format.space_before = Pt(1.5)
    p.paragraph_format.space_after = Pt(1.5)
    p.paragraph_format.line_spacing = 1.15
    if align is not None:
        p.alignment = align
    run = p.add_run(text)
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.name = LAT_FONT
    run.font.color.rgb = DocxRGB.from_string(color)
    _set_rfonts(run._element.get_or_add_rPr())
    cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER


def table(doc: Document, headers: list[str], rows: list[list[str]],
          widths: list[float] | None = None, size: float = 9.0) -> None:
    t = doc.add_table(rows=1, cols=len(headers))
    try:
        t.style = "Table Grid"
    except KeyError:  # pragma: no cover
        pass
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    hdr = t.rows[0]
    trpr = hdr._tr.get_or_add_trPr()
    th = OxmlElement("w:tblHeader")
    trpr.append(th)
    for i, htext in enumerate(headers):
        _cell(hdr.cells[i], htext, bold=True, size=size, color="FFFFFF")
        shade(hdr.cells[i], C_DARK)
    for r_i, row in enumerate(rows):
        cells = t.add_row().cells
        for i, val in enumerate(row):
            _cell(cells[i], val, size=size)
            if r_i % 2 == 1:
                shade(cells[i], C_LIGHT)
    if widths:
        for row in t.rows:
            for i, w in enumerate(widths):
                row.cells[i].width = Cm(w)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def kv_table(doc: Document, pairs: list[tuple[str, str]]) -> None:
    t = doc.add_table(rows=0, cols=2)
    try:
        t.style = "Table Grid"
    except KeyError:  # pragma: no cover
        pass
    t.autofit = False
    for k, v in pairs:
        cells = t.add_row().cells
        _cell(cells[0], k, bold=True, size=9.5, color=C_DARK)
        shade(cells[0], C_LIGHT)
        _cell(cells[1], v, size=9.5)
        cells[0].width = Cm(3.6)
        cells[1].width = Cm(12.4)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def cover(doc: Document, title: str, subtitle: str) -> None:
    para(doc, "", size=6, space_after=30)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(title)
    run.font.size = Pt(26)
    run.font.bold = True
    run.font.color.rgb = DocxRGB.from_string(C_DARK)
    run.font.name = LAT_FONT
    _set_rfonts(run._element.get_or_add_rPr())
    para(doc, subtitle, size=12.5, color=C_ACCENT, align=WD_ALIGN_PARAGRAPH.CENTER,
         space_after=4)
    para(doc, COMPANY + "（" + COMPANY_EN + "）", size=11, color=C_GREY,
         align=WD_ALIGN_PARAGRAPH.CENTER, space_after=18)


def spec_table_for(doc: Document, model: str, skip: tuple[str, ...] = ("产品状态",)) -> None:
    rows = [[item, value] for m, item, value in SPEC_ROWS
            if m == model and item not in skip]
    table(doc, ["参数项", "数值"], rows, widths=[4.2, 11.8])


# ================================================================ 1. 白皮书
def build_whitepaper() -> Path:
    doc = init_doc()
    cover(doc, COMPANY + " 产品与能力白皮书",
          "工业边缘智能设备与平台 ｜ Product & Capability White Paper")
    kv_table(doc, [
        ("文档名称", COMPANY + " 产品与能力白皮书"),
        ("版本", "V1.0"),
        ("编制", COMPANY + " 产品与方案部"),
        ("适用范围", "离散制造（汽车零部件、通用机械）与市政公用（水务）方向"),
        ("产品线", "边缘控制器 YS-EC 系列、工业网关 YS-GW 系列、边缘智能平台 YS 平台系列"),
        ("文档性质", FICTION_NOTE),
        ("更新日期", "2025-11"),
    ])
    doc.add_page_break()

    # 1
    doc.add_heading("1. 关于本白皮书", level=1)
    para(doc, "本文面向制造业与市政公用行业的设备管理、自动化与信息化负责人，以及集成商与"
              "设计院的方案人员，说明云枢智控的产品构成、关键规格、能力清单、能力边界与选型"
              "注意事项。我们希望在选型早期就把“哪些能接、哪些不接、接了要付什么代价”讲清楚，"
              "减少后期返工。")
    para(doc, "全文分三部分：第一部分是公司与产品线（第 2–6 章），第二部分是能力与边界"
              "（第 7–9 章），第三部分是典型场景、交付资料与附录（第 10–13 章）。")
    para(doc, "阅读本文前，请先了解以下口径约定：", bold=True)
    bullets(doc, [
        "产品状态分为在售、在研、停售三种。在研产品的规格为设计目标，实际以正式发布版本为准。",
        "“典型功耗”为常温、典型负载下的整机实测均值，不是峰值功耗；柜内散热设计请按峰值"
        "留余量。",
        "“点位”指一次可寻址的采集测点，例如一个寄存器映射值或一个状态位；单机约 2000 点/秒"
        "指协议转换与采集的吞吐能力。",
        "工作温度、防护等级为整机指标，不含外接机柜、辅材与第三方协议转换器。",
        "本文不包含报价；含税参考价格带见附录 A.3，正式报价以项目配置清单为准。",
    ])

    # 2
    doc.add_heading("2. 公司与定位", level=1)
    para(doc, COMPANY + "（" + COMPANY_EN + "）是工业边缘智能设备与平台供应商，专注离散制造"
              "与市政公用两个方向。我们的基本判断是：工业现场的数据价值不在“全部上云”，而在"
              "“就近把设备数据接出来、算清楚、用起来”。因此产品重心放在边缘侧——把协议转换、"
              "数据清洗、规则判断与轻量控制放在离设备最近的地方，平台上只承载管理与必要的"
              "数据服务。")
    para(doc, "公司产品由三条产品线组成。边缘控制器（YS-EC 系列）面向机台与工位，承担数据"
              "采集、联锁控制与边缘 AI 推理；工业网关（YS-GW 系列）面向存量设备与分散站点，"
              "解决协议接入与上云通道；边缘智能平台（YS 平台系列）负责设备管理、远程配置、"
              "告警与数据服务。三条线可以单独交付，也可以按“网关 + 控制器 + 平台”组合交付。")
    para(doc, "面向离散制造，我们重点解决设备联网、OEE 与停机归因、关键过程参数追溯以及"
              "能耗分项计量；面向市政公用，重点解决站点无人值守、设备远程监控、能耗分析与"
              "台账工单贯通。两个方向的共同点是：现场设备存量多、协议杂、布线条件参差，"
              "且改造必须在不停产的前提下完成。")

    # 3
    doc.add_heading("3. 产品总览", level=1)
    para(doc, "目前共有 8 个型号，其中在售 6 个、在研 1 个、停售 1 个。停售型号保留维保，"
              "不再提供新功能。")
    table(doc, ["产品线", "型号", "状态", "上市时间", "定位"],
          [[a, b, c, d, e] for a, b, c, d, e in PRODUCT_LINES],
          widths=[2.3, 4.6, 1.3, 2.1, 5.7], size=8.5)
    para(doc, "组合逻辑上，单机台改造优先用 YS-EC3200；一个区域内有 5 台以上机台需要汇聚、"
              "或需要现场做视觉质检时用 YS-EC5200；只有采集上云需求、且不允许改动既有控制"
              "逻辑时用 YS-GW2100；现场没有布线或布线成本过高时用 YS-GW4300；需要统一设备"
              "台账、远程配置与多方数据对接时配 YS-CloudLink。")

    # 4
    doc.add_heading("4. 边缘控制器 YS-EC 系列", level=1)
    para(doc, "YS-EC 系列安装在机台侧，向下用现场总线与 IO 与设备控制器通信，向上通过"
              "工业以太网把数据送到车间汇聚点或平台。它的角色是“机台数据出口 + 轻量逻辑"
              "执行者”：数据采集与联锁在这里完成，控制程序的既有逻辑不做改动。")

    doc.add_heading("4.1 YS-EC3200 紧凑型边缘控制器（在售，2024-06）", level=2)
    para(doc, "YS-EC3200 定位是替代现场常见的“小型 PLC + 网关”组合：一个 DIN35 导轨上的"
              "紧凑盒子同时完成协议接入与联锁逻辑，减少一层设备、一层故障点和一套点表维护"
              "工作。典型场景是单机台、单工位的改造，例如一台压铸机的状态与工艺参数采集，"
              "或一条检测线的结果计数与报警联动。")
    para(doc, "它的接口偏精炼：2 路 RS485 与 1 路 CAN 足以覆盖一台设备的控制器与少量仪"
              "表，2 个千兆网口可实现上下行隔离；6W 的典型功耗意味着大多数现场可以沿用既有"
              "的小型电源与导轨位置，不需要为改造重新配电。它没有 NPU，不承担推理任务。")
    caption(doc, "表 4-1 YS-EC3200 关键规格")
    spec_table_for(doc, "YS-EC3200")
    para(doc, "选型提示：EC3200 适合“一台设备一个盒子”的均匀改造；若一个工位需要聚合多台"
              "设备的测点，或者现场要做缺陷检测，请直接选 EC5200，不要用多台 EC3200 拼。")

    doc.add_heading("4.2 YS-EC5200 高性能边缘控制器（在售，2025-03）", level=2)
    para(doc, "YS-EC5200 是系列中的主力型号，面向一个区域内多台设备的汇聚场景。8 核处理器"
              "（4×Cortex-A76 + 4×Cortex-A55）与 4GB 内存让它可以同时跑采集、软 PLC 逻辑与"
              "推理任务；6 TOPS 的 NPU 用于承载 YS-VisionEdge 的缺陷检测，单台可支持 2 路"
              "相机。4 个千兆网口加 2 个 SFP 光口，便于把上行与设备侧网络在物理上分开，"
              "在车间主干为百兆、汇聚层需要升级的现场尤其有用。")
    para(doc, "内置软 PLC 支持 IEC 61131-3 编程，可以承载工艺侧的前置逻辑与联锁；"
              "-40~70℃ 的宽温与双电源冗余让它可以装在缺少空调的车间配电间或现场机柜内。"
              "断网时本地缓存默认 7 天、可扩至 30 天，网络恢复后按序续传。")
    caption(doc, "表 4-2 YS-EC5200 关键规格")
    spec_table_for(doc, "YS-EC5200")
    para(doc, "选型提示：EC5200 是“边缘 AI + 软 PLC”的最小交付单元。需要视觉质检时，"
              "EC5200 与 YS-VisionEdge 一并规划，无法只买软件套件。")

    doc.add_heading("4.3 YS-EC5600 高可靠边缘控制器（在研，计划 2026-09）", level=2)
    para(doc, "YS-EC5600 面向流程行业的关键回路，设计目标是双机热备与更宽的工作温度，"
              "功能安全以 SIL2 为设计目标。它解决的是“控制器本身不能是单点”的问题：主备"
              "切换、状态同步与故障隔离在设计和验证上的工作量远大于常规型号，因此目前对外"
              "只公布定位与可靠性目标，其余规格待定。")
    para(doc, "在研产品的规格不构成交付承诺。若有项目需要提前评估，请在方案阶段与我们确认"
              "发布时间与规格冻结情况。")
    caption(doc, "表 4-3 YS-EC5600 已知规格（其余待定）")
    spec_table_for(doc, "YS-EC5600")

    # 5
    doc.add_heading("5. 工业网关 YS-GW 系列", level=1)
    para(doc, "YS-GW 系列的定位是“只采集、不控制”。在很多客户现场，设备控制器由原厂维保，"
              "任何程序改动都要走变更审批，甚至可能影响质保；网关通过旁路方式从既有通信口"
              "读取数据，不动原 PLC 程序，也不动机械结构，是存量改造中阻力最小的技术路线。")

    doc.add_heading("5.1 YS-GW2100 多协议工业网关（在售，2023-11）", level=2)
    para(doc, "YS-GW2100 是最基础的一档：2×Cortex-A53 @1.2GHz、512MB 内存、8GB 存储，"
              "1 路 RS485 与 1 路 RS232 覆盖常见的串口设备，2 个千兆网口接车间网络。"
              "协议侧支持 Modbus RTU/TCP、OPC UA、IEC 60870-5-104、Profinet 与 EtherNet/IP，"
              "采集吞吐约 2000 点/秒，典型功耗 4W，-20~65℃ 工作温度，适合装在现场小箱体内。")
    caption(doc, "表 5-1 YS-GW2100 关键规格")
    spec_table_for(doc, "YS-GW2100")

    doc.add_heading("5.2 YS-GW4300 5G 边缘网关（在售，2025-01）", level=2)
    para(doc, "YS-GW4300 在 GW2100 的基础上增加了两件现场最需要的东西：5G NR / LTE 模组，"
              "以及本地时序库与规则引擎。前者解决“没有布线”的问题——5G 与有线双上行可以在"
              "布线困难的区域先上线，后续再回铺光纤；后者解决“断网期间数据怎么办”的问题："
              "本地时序库保留 30 天，规则引擎最多 200 条，断网期间的判据在网关上照常执行，"
              "网络恢复后再续传。")
    para(doc, "典型功耗 9W，仍可按现场小箱体的散热条件安装。规则引擎适合做阈值判断、状态"
              "组合与简单计数这类逻辑；复杂的顺序控制与工艺逻辑应放到 EC5200 的软 PLC 里，"
              "不要用规则堆叠去模拟程序逻辑。")
    caption(doc, "表 5-2 YS-GW4300 关键规格")
    spec_table_for(doc, "YS-GW4300")

    doc.add_heading("5.3 网关与控制器怎么选", level=2)
    para(doc, "判断标准只有两条：是否需要控制，以及需要聚合多少设备。需要执行任何控制逻辑"
              "（哪怕是工艺侧的联锁）就必须用 EC 系列，网关只做采集；只需要采集时，看规模"
              "选 GW2100 或 GW4300。单台 GW2100 的协议转换上限约 2000 点/秒，点数更多时"
              "横向增加网关，或改用采集能力更强的 EC5200。")

    # 6
    doc.add_heading("6. 边缘智能平台 YS 平台系列", level=1)
    para(doc, "平台系列回答的是“设备接进来之后怎么管”。它不承担业务系统的职责，只做设备"
              "侧的管理与数据服务：接入、配置、升级、告警、模型与命名、台账与健康度，以及"
              "把数据交给客户既有的业务系统。")

    doc.add_heading("6.1 YS-CloudLink 设备管理平台（在售，2023-09）", level=2)
    para(doc, "YS-CloudLink 采用私有化部署，单实例建议接入不超过 5000 台设备或 500 点位包。"
              "它提供设备接入、远程配置、OTA 升级、告警与数据服务，内置 Web HMI 组态，"
              "现场和管理层用浏览器就能看板，不需要安装客户端。对外通过 OpenAPI 与 Webhook "
              "对接客户的工单与业务系统，并提供 OPC UA Server 与 REST 接口与 MES / SCADA"
              " 交互。")
    para(doc, "统一设备模型与测点命名规范是平台里最容易被低估的一项能力：它决定了不同车间、"
              "不同批次接入的设备能不能被同一套看板和报表复用。我们在项目初期就会输出点表"
              "模板，把命名规则固定下来。")
    caption(doc, "表 6-1 YS-CloudLink 关键规格")
    spec_table_for(doc, "YS-CloudLink")

    doc.add_heading("6.2 YS-VisionEdge 视觉质检套件（在售，2025-06）", level=2)
    para(doc, "YS-VisionEdge 面向外观缺陷检测，特点是“小样本”：每类缺陷 20–50 张样本即可"
              "起步，适合缺陷样本稀少、难以收集的压铸、注塑、机加工件。它必须配合 "
              "YS-EC5200 的 NPU 使用，单台 EC5200 支持 2 路相机。")
    para(doc, "需要明确的是：EC3200 与 GW 系列不具备推理能力，不能承担视觉质检任务；"
              "视觉方案的立项单位是“控制器 + 套件 + 相机”，而不是单独的软件。")
    caption(doc, "表 6-2 YS-VisionEdge 关键规格")
    spec_table_for(doc, "YS-VisionEdge")

    doc.add_heading("6.3 YS-Pad10 工业平板（已停售，2022-05）", level=2)
    para(doc, "YS-Pad10 是早期的现场 HMI 移动终端，目前已经停售，不再提供新功能，维保至 "
              "2026-12。它的功能已被 YS-EC5200 内置的 Web HMI 取代：现场人员用平板或手机"
              "浏览器访问即可，不再需要专用终端。仍在使用的客户建议在维保到期前完成替换"
              "评估。")
    caption(doc, "表 6-3 YS-Pad10 产品状态")
    spec_table_for(doc, "YS-Pad10")

    # 7
    doc.add_heading("7. 能力清单", level=1)
    para(doc, "下表是当前可交付的能力清单，按能力项与支撑型号对照。能力项只写可以验证的"
              "内容：能接什么协议、能达到什么吞吐、有没有 NPU、缓存多久，不写形容词。")
    table(doc, ["序号", "能力", "支撑型号"],
          [[str(i + 1), name, models] for i, (name, models) in enumerate(CAPABILITIES)],
          widths=[1.2, 10.4, 4.4], size=8.5)

    doc.add_heading("7.1 三条主线的能力说明", level=2)
    para(doc, "多协议接入与旁路改造是存量设备联网的入口能力。五类协议覆盖了当前大多数"
              "车间与市政现场的控制器与仪表；旁路方式保证不改动原 PLC 程序与机械结构，"
              "既降低停产风险，也避免与原厂维保条款冲突。老设备的协议往往不在列表内"
              "（例如 Profibus-DP / DeviceNet），需要在勘察阶段用点表盘点确认。")
    para(doc, "边缘计算与视觉质检是差异化的部分。约 2000 点/秒的采集能力意味着一个中等"
              "规模的车间可以由少量边缘设备承担；6 TOPS 的 NPU 让缺陷检测在机台侧完成，"
              "只把判定结果与必要图像上传，减少带宽与数据出域压力。")
    para(doc, "平台侧能力围绕“管得住、交得出”设计：远程配置与 OTA 降低多点位运维成本，"
              "统一设备模型保证多车间数据可比，OpenAPI 与 Webhook 把告警接到客户既有的"
              "工单体系。数据上云支持 MQTT / HTTPS，可对接客户指定的第三方物联网平台。")

    # 8
    doc.add_heading("8. 我们不做什么", level=1)
    para(doc, "边界比能力更能说明一家公司的取舍。以下六条是明确不做、也不会在项目里临时"
              "承诺的范围。把它们写进白皮书，是为了让客户在方案阶段就能判断责任如何划分。")
    for i, (name, reason) in enumerate(BOUNDARIES, 1):
        doc.add_heading("8.%d %s" % (i, name), level=2)
        para(doc, reason)

    # 9
    doc.add_heading("9. 已知限制与选型注意", level=1)
    para(doc, "以下是已知的限制。它们不是缺陷，而是选型时的前提条件；提前知道可以避免"
              "在实施期才发现方案不成立。")
    for i, item in enumerate(LIMITATIONS, 1):
        lead_para(doc, "限制 %d：" % i, item)

    # 10
    doc.add_page_break()
    doc.add_heading("10. 典型应用场景", level=1)
    para(doc, "以下两个场景来自我们在离散制造与市政公用方向的典型项目形态。场景中的客户"
              "与数据均为虚构演示设定。")

    doc.add_heading("10.1 汽车零部件压铸车间设备联网与 OEE 提升", level=2)
    para(doc, "客户为华东某汽车零部件一级供应商，压铸车间有 28 台压铸机（其中 12 台为 "
              "2015 年前投产的老机，品牌为华铸 HZ-800 与恒控 HC-300）、6 台锐臂 RB-6 "
              "去毛刺机器人与 4 条检测线，现场 PLC 以德控 DC-300 与日控 NC-200 为主。"
              "车间的 MES 建于 2016 年，只有工单与产量模块，没有设备数据，OEE 靠班组长"
              "手工估算。")
    para(doc, "核心诉求是四件事：3 个月内 28 台设备全部联网；OEE 实时可视并按班次与机台"
              "拆分；停机原因自动归集为换模、故障、待料、其他四类；关键过程参数（压射速度、"
              "铸造压力、模温、循环时间）留存 1 年以上可追溯。硬约束是不改原 PLC 程序和"
              "机械结构、不中断生产，改造只能在周末停线窗口内完成，单次窗口不超过 8 小时。")
    para(doc, "对应到产品组合：老机与分散区域用 YS-GW2100 旁路采集，布线困难区域用 "
              "YS-GW4300 的 5G 上行；需要在一个区域聚合多台设备、或需要在机台侧做前置"
              "判据时用 YS-EC5200；全厂设备台账、OEE 看板、停机原因归类与数据留存由 "
              "YS-CloudLink 承担，并通过 OpenAPI 把工单与停机原因回写到既有 MES。")

    doc.add_heading("10.2 市政污水处理厂设备监控与能耗管理", level=2)
    para(doc, "客户为华东某地级市水务集团下属污水处理厂，处理规模 12 万吨/日，包含 2 座"
              "厂区与 6 座提升泵站。2013 年建设的 SCADA 只覆盖主要工艺回路，6 座泵站名义"
              "上无人值守，实际只有电话报警；能耗按厂区总表计量，没有分项；设备台账与维修"
              "记录分散在电子表格中，运维 9 人轮班巡检。")
    para(doc, "客户诉求集中在远程监控与能耗：6 座泵站实现无人值守远程监控（液位、流量、"
              "水泵状态、电流）；水泵、鼓风机、脱水机等主要设备做分项计量与能耗分析；"
              "设备台账与工单打通；关键数据留存满足等保与审计要求。硬约束是与既有 SCADA "
              "并存、不替换，不能停机改造，既有 SCADA 由原厂维保、接口需原厂配合，质保期"
              "要求 3 年。")
    para(doc, "对应到产品组合：泵站侧用 YS-GW4300 做液位、流量、水泵状态与电流的采集与"
              "断网续传，厂区侧用 YS-GW2100 接入既有仪表与电表；能耗分项计量需外接智能"
              "电表，方案中要单列；泵站与厂区的数据统一进入 YS-CloudLink，由平台做台账、"
              "告警与能耗分析，并通过 Webhook 与 OpenAPI 与集团统一平台的工单和上报口径"
              "对接。")

    # 11
    doc.add_heading("11. 交付与资料", level=1)
    para(doc, "随产品交付的技术资料包括：安装手册、Modbus 点表模板、OPC UA 建模指南与"
              "组态示例工程。点表模板与建模指南建议在项目勘察阶段就开始使用，把测点命名"
              "规范前置固定，可显著降低后期返工。")
    para(doc, "生态方面，我们已与 3 家区域集成商签订交付合作，由其承担现场勘察、施工与"
              "调试；同时已适配 12 家主流 PLC 品牌的点表，常见控制器的点表梳理可以在勘察"
              "阶段一次性完成。")

    # 12
    doc.add_page_break()
    doc.add_heading("12. 附录 A 可选材料", level=1)
    for title, items in APPENDIX:
        doc.add_heading(title, level=2)
        bullets(doc, items)

    doc.add_heading("13. 版本记录与免责声明", level=1)
    table(doc, ["版本", "日期", "变更说明"], [
        ["V1.0", "2025-11", "首次发布：产品线、关键规格、能力清单、边界与已知限制。"],
    ], widths=[2.0, 3.0, 11.0], size=9.0)
    para(doc, "免责声明：" + FICTION_NOTE + "本文所载规格、价格带与案例数据仅用于演示与"
              "说明，不构成任何商业承诺。在研产品的规格与时间以正式发布为准。", size=9.5,
         color=C_GREY)

    set_footer(doc, COMPANY + " 产品与能力白皮书 V1.0 ｜ " + FICTION_NOTE)
    out = OUT_DIR / DOC_WHITEPAPER
    doc.save(out)
    normalize_zip(out)
    return out


# ================================================================ 2. 规格参数表
def build_specs() -> Path:
    wb = Workbook()
    ws = wb.active
    ws.title = "产品规格参数表"

    headers = ["型号", "参数项", "数值"]
    ws.append(headers)
    for model, item, value in SPEC_ROWS:
        ws.append([model, item, value])

    head_font = XlFont(name=EA_FONT, size=11, bold=True, color="FFFFFF")
    head_fill = PatternFill("solid", fgColor=C_DARK)
    thin = Side(style="thin", color="C6D2DA")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    band = PatternFill("solid", fgColor=C_LIGHT)
    body_font = XlFont(name=EA_FONT, size=10, color=C_BODY)
    model_font = XlFont(name=EA_FONT, size=10, bold=True, color=C_DARK)

    for col, width in enumerate((16, 26, 78), start=1):
        ws.column_dimensions[get_column_letter(col)].width = width
    for cell in ws[1]:
        cell.font = head_font
        cell.fill = head_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = border
    ws.row_dimensions[1].height = 22

    for r in range(2, ws.max_row + 1):
        ws.cell(r, 1).font = model_font
        ws.cell(r, 2).font = body_font
        ws.cell(r, 3).font = body_font
        for c in range(1, 4):
            cell = ws.cell(r, c)
            cell.border = border
            cell.alignment = Alignment(vertical="center", wrap_text=(c == 3))
            if r % 2 == 1:
                cell.fill = band
        ws.row_dimensions[r].height = 20
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = "A1:C%d" % ws.max_row

    ws2 = wb.create_sheet("说明")
    ws2.column_dimensions["A"].width = 18
    ws2.column_dimensions["B"].width = 92
    notes = [
        ("表格口径", "本表按“型号 × 参数项 × 数值”列出，共 %d 行参数（不含表头）。" % len(SPEC_ROWS)),
        ("产品状态", "在售 / 在研 / 停售三种。YS-EC5600 为在研型号，规格待定；YS-Pad10 已停售。"),
        ("典型功耗", "常温、典型负载下的整机实测均值，非峰值；柜内散热按峰值留余量。"),
        ("工作温度", "整机指标，不含外接机柜、辅材与第三方协议转换器。"),
        ("点位与吞吐", "“点位”指一次可寻址的采集测点；单机约 2000 点/秒为采集与协议转换吞吐。"),
        ("能耗计量", "能耗数据采集与分项计量均需外接智能电表，表内不计入电表。"),
        ("价格", "本表不含价格；含税参考价格带见白皮书附录 A.3。"),
        ("文档性质", FICTION_NOTE),
    ]
    ws2.append(["项目", "说明"])
    for k, v in notes:
        ws2.append([k, v])
    for cell in ws2[1]:
        cell.font = head_font
        cell.fill = head_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = border
    for r in range(2, ws2.max_row + 1):
        ws2.cell(r, 1).font = model_font
        ws2.cell(r, 2).font = body_font
        for c in (1, 2):
            ws2.cell(r, c).border = border
            ws2.cell(r, c).alignment = Alignment(vertical="center", wrap_text=(c == 2))
        ws2.row_dimensions[r].height = 22

    wb.properties.title = COMPANY + " 产品规格参数表"
    wb.properties.creator = COMPANY
    wb.properties.lastModifiedBy = COMPANY
    wb.properties.created = FIXED_TS
    wb.properties.modified = FIXED_TS
    wb.properties.description = FICTION_NOTE

    out = OUT_DIR / DOC_SPECS
    wb.save(out)
    normalize_zip(out)
    return out


# ================================================================ pptx 工具
def _ppt_run(run, size: float, bold: bool = False, color: str = C_BODY,
             ea: str = EA_FONT) -> None:
    run.font.size = PptxPt(size)
    run.font.bold = bold
    run.font.name = LAT_FONT
    run.font.color.rgb = PptxRGB.from_string(color)
    rpr = run._r.get_or_add_rPr()
    for tag in ("a:ea", "a:cs"):
        el = rpr.find(qn(tag))
        if el is None:
            el = rpr.makeelement(qn(tag), {})
            rpr.append(el)
        el.set("typeface", ea)


def _rect(slide, x, y, w, h, fill: str):
    shp = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y, w, h)
    shp.fill.solid()
    shp.fill.fore_color.rgb = PptxRGB.from_string(fill)
    shp.line.fill.background()
    shp.shadow.inherit = False
    return shp


def _tbox(slide, x, y, w, h):
    tb = slide.shapes.add_textbox(x, y, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    return tf


def _bullet_line(tf, text: str, first: bool = False, size: float = 17,
                 color: str = C_BODY, bullet: str = "▪  ") -> None:
    p = tf.paragraphs[0] if first else tf.add_paragraph()
    p.space_after = PptxPt(11)
    mark = p.add_run()
    mark.text = bullet
    _ppt_run(mark, size, bold=False, color=C_ACCENT)
    label, sep, rest = text.partition("：")
    if sep and len(label) <= 18:
        r1 = p.add_run()
        r1.text = label + "："
        _ppt_run(r1, size, bold=True, color=C_DARK)
        r2 = p.add_run()
        r2.text = rest
        _ppt_run(r2, size, bold=False, color=color)
    else:
        r = p.add_run()
        r.text = text
        _ppt_run(r, size, bold=False, color=color)


def _slide(prs: Presentation, title: str, kicker: str, bullets: list[str],
           footnote: str | None = None) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _rect(slide, 0, 0, prs.slide_width, Inches(0.14), C_ACCENT)
    tf = _tbox(slide, Inches(0.75), Inches(0.42), Inches(11.9), Inches(0.5))
    p = tf.paragraphs[0]
    r = p.add_run()
    r.text = kicker
    _ppt_run(r, 13, bold=True, color=C_ACCENT)

    tf = _tbox(slide, Inches(0.75), Inches(0.86), Inches(11.9), Inches(0.8))
    p = tf.paragraphs[0]
    r = p.add_run()
    r.text = title
    _ppt_run(r, 27, bold=True, color=C_DARK)

    _rect(slide, Inches(0.78), Inches(1.72), Inches(1.5), Inches(0.05), C_ACCENT)

    tf = _tbox(slide, Inches(0.75), Inches(2.0), Inches(11.9), Inches(4.9))
    n = len(bullets)
    size = 17 if n <= 5 else 15.5
    for i, b in enumerate(bullets):
        _bullet_line(tf, b, first=(i == 0), size=size)

    if footnote:
        tf = _tbox(slide, Inches(0.75), Inches(6.95), Inches(11.9), Inches(0.4))
        p = tf.paragraphs[0]
        r = p.add_run()
        r.text = footnote
        _ppt_run(r, 10, color=C_GREY)

    idx = len(prs.slides)
    tf = _tbox(slide, Inches(12.2), Inches(6.95), Inches(0.9), Inches(0.4))
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.RIGHT
    r = p.add_run()
    r.text = "%02d" % idx
    _ppt_run(r, 11, bold=True, color=C_ACCENT)


def build_deck() -> Path:
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)

    # 1 封面
    s = prs.slides.add_slide(prs.slide_layouts[6])
    _rect(s, 0, 0, prs.slide_width, prs.slide_height, C_DARK)
    _rect(s, Inches(0.9), Inches(2.55), Inches(2.2), Inches(0.07), C_ACCENT)
    tf = _tbox(s, Inches(0.9), Inches(2.9), Inches(11.5), Inches(1.2))
    r = tf.paragraphs[0].add_run()
    r.text = COMPANY
    _ppt_run(r, 46, bold=True, color="FFFFFF")
    r = tf.add_paragraph().add_run()
    r.text = COMPANY_EN
    _ppt_run(r, 20, color=C_ACCENT)
    tf = _tbox(s, Inches(0.9), Inches(4.45), Inches(11.5), Inches(0.9))
    r = tf.paragraphs[0].add_run()
    r.text = "工业边缘智能设备与平台 ｜ 专注离散制造与市政公用"
    _ppt_run(r, 19, color="D5E3EB")
    tf = _tbox(s, Inches(0.9), Inches(5.15), Inches(11.5), Inches(0.9))
    r = tf.paragraphs[0].add_run()
    r.text = "把现场设备数据可靠接出来，让 OEE 与能耗算得清"
    _ppt_run(r, 17, bold=True, color="FFFFFF")
    tf = _tbox(s, Inches(0.9), Inches(6.6), Inches(11.5), Inches(0.5))
    r = tf.paragraphs[0].add_run()
    r.text = "产品与能力简介 ｜ " + FICTION_NOTE
    _ppt_run(r, 11, color="9FB6C4")

    # 2 产品线总览
    _slide(prs, "三条产品线，覆盖从机台到平台", "产品总览", [
        "边缘控制器 YS-EC：EC3200 紧凑型 / EC5200 高性能 / EC5600 高可靠（在研）",
        "工业网关 YS-GW：GW2100 多协议 / GW4300 5G 边缘",
        "边缘智能平台：CloudLink 设备管理 / VisionEdge 视觉质检 / Pad10（停售）",
        "链路：单机台采集 → 多机台汇聚 → 边缘 AI 推理 → 平台管理与数据服务",
        "两个主攻方向：离散制造（OEE、停机归因、过程追溯）、市政公用（无人值守、能耗）",
    ])

    # 3 YS-EC
    _slide(prs, "YS-EC 系列：机台侧的数据出口与轻量控制", "产品线一 ｜ 边缘控制器", [
        "YS-EC3200（2024-06，在售）：4×Cortex-A55 @1.8GHz，1GB / 8GB，2×RS485 + 1×CAN，2×千兆网口，6W",
        "EC3200 定位：替代“小型 PLC + 网关”组合，单机台连接与联锁控制",
        "YS-EC5200（2025-03，在售）：8 核 @2.4GHz，4GB / 32GB，NPU 6 TOPS，4×RS485 + 2×CAN，4×千兆网口 + 2×SFP 光口，15W",
        "EC5200 定位：多机台汇聚 + 边缘 AI，内置软 PLC（IEC 61131-3）",
        "YS-EC5600（在研，计划 2026-09）：双机热备、-40~75℃、SIL2 为设计目标",
    ])

    # 4 YS-GW
    _slide(prs, "YS-GW 系列：存量设备接入，只采集不控制", "产品线二 ｜ 工业网关", [
        "YS-GW2100（2023-11，在售）：2×Cortex-A53 @1.2GHz，512MB / 8GB，1×RS485 + 1×RS232，2×千兆网口，4W",
        "协议支持：Modbus RTU/TCP、OPC UA、IEC 60870-5-104、Profinet、EtherNet/IP",
        "采集吞吐约 2000 点/秒，纯采集不含控制，旁路接入不改原 PLC 程序",
        "YS-GW4300（2025-01，在售）：在 GW2100 基础上增加 5G NR / LTE 模组，5G / 有线双上行",
        "GW4300 本地时序库保留 30 天，规则引擎最多 200 条，典型功耗 9W",
    ])

    # 5 YS 平台
    _slide(prs, "YS 平台系列：设备管得住、数据交得出", "产品线三 ｜ 边缘智能平台", [
        "YS-CloudLink（2023-09，在售）：私有化部署，单实例建议接入 ≤5000 台设备或 ≤500 点位包",
        "设备接入、远程配置、OTA 升级、告警、数据服务；Web HMI 组态，浏览器直接访问",
        "OpenAPI 与 Webhook；与 MES / SCADA 对接提供 OPC UA Server 与 REST 接口",
        "YS-VisionEdge（2025-06，在售）：小样本缺陷检测，每类缺陷 20–50 张样本起步",
        "VisionEdge 需配合 YS-EC5200 的 NPU，单台 EC5200 支持 2 路相机",
        "YS-Pad10（停售）：已被 EC5200 内置 Web HMI 取代，维保至 2026-12",
    ])

    # 6 能力速览
    _slide(prs, "能力速览：可交付清单", "能力清单", [
        "多协议设备接入 + 存量设备旁路改造（不改原 PLC 程序与机械结构）",
        "边缘侧高频数据采集（单机约 2000 点/秒）；边缘规则引擎与本地联锁",
        "软 PLC 控制（IEC 61131-3）",
        "边缘 AI 推理（6 TOPS NPU）；小样本视觉缺陷检测",
        "断网续传与本地缓存（默认 7 天，可扩至 30 天）；GW4300 本地时序库保留 30 天",
        "远程配置与 OTA、统一设备模型、告警与工单对接、数据上云（MQTT / HTTPS）",
    ])

    # 7 场景 A
    _slide(prs, "汽车零部件压铸车间：设备联网与 OEE 提升", "典型场景 A", [
        "客户：华东某汽车零部件一级供应商，压铸车间",
        "现状：28 台压铸机（12 台 2015 年前老机，华铸 HZ-800 / 恒控 HC-300）+ 6 台锐臂 RB-6 机器人 + 4 条检测线",
        "现场 PLC 以德控 DC-300、日控 NC-200 为主；2016 年 MES 只有工单与产量，无设备数据",
        "痛点：OEE 靠手工估算、停机无法归因、过程参数不可追溯、无分项计量、报表每日抄录 2 小时",
        "目标：3 个月 28 台全部联网；OEE 按班次与机台可视；停机原因自动归集四类",
        "约束：周末窗口 ≤8 小时、不改原 PLC 程序、不中断生产、部分区域需无线方案",
    ])

    # 8 场景 B
    _slide(prs, "市政污水处理厂：设备监控与能耗管理", "典型场景 B", [
        "客户：华东某地级市水务集团下属污水处理厂，12 万吨/日，2 座厂区 + 6 座提升泵站",
        "现状：2013 年 SCADA 仅覆盖主要工艺回路；6 座泵站名义无人值守，实际只有电话报警",
        "痛点：泵站故障平均 4 小时才发现；吨水电耗高于集团平均 8%；台账与维修记录分散",
        "目标：6 座泵站无人值守远程监控（液位 / 流量 / 水泵状态 / 电流）",
        "目标：主要设备分项计量与能耗分析、台账与工单打通、与既有 SCADA 并存不替换",
        "约束：等保 2.0 三级、政府采购与财政评审、不能停机改造、质保期 3 年",
    ])

    # 9 不做什么
    _slide(prs, "我们不做的事", "能力边界", [
        "不做 PLC 下位的运动控制与安全回路控制（安全功能由独立安全 PLC 承载）",
        "不提供自研 MES / ERP 业务系统，只做数据对接",
        "不做工业网络三层交换与路由设备，不替代工业交换机",
        "不承接客户 OT 网络的整体设计与施工总包",
        "不提供公有云多租户 SaaS 版本（本期只做本地化 / 私有化部署）",
        "不做机械臂 / AGV 等移动设备的运动控制",
    ], footnote="以上为明确不做的范围，项目执行期不做例外承诺。")

    # 10 联系我们
    _slide(prs, "联系我们", "资料与获取方式", [
        "邮箱：" + MAIL,
        "随产品资料：安装手册、Modbus 点表模板、OPC UA 建模指南、组态示例工程",
        "生态：与 3 家区域集成商签订交付合作；已适配 12 家主流 PLC 品牌的点表",
        "路线图：YS-EC5600（2026 Q3）、CloudLink 2.0 多租户（2027）、IEC 62443-4-2 认证（2026 Q4 计划）",
        "说明：涉及在研产品，规格与时间以正式发布为准；本文不含报价",
    ], footnote=FICTION_NOTE)

    core = prs.core_properties
    core.title = COMPANY + " 产品介绍"
    core.author = COMPANY
    core.last_modified_by = COMPANY
    core.comments = FICTION_NOTE
    core.created = FIXED_TS
    core.modified = FIXED_TS

    out = OUT_DIR / DOC_DECK
    prs.save(out)
    normalize_zip(out)
    return out


# ================================================================ 3. 场景 A
def build_scene_a() -> Path:
    doc = init_doc()
    cover(doc, "场景 A：汽车零部件压铸车间设备联网与 OEE 提升",
          "客户调研纪要 + 现状说明")
    kv_table(doc, [
        ("客户", "华东某汽车零部件一级供应商（虚构）"),
        ("场景名称", "汽车零部件压铸车间设备联网与 OEE 提升"),
        ("行业", "汽车零部件制造（压铸）"),
        ("调研对象", "制造部、IT 部、设备部"),
        ("调研方式", "现场走访 + 车间访谈"),
        ("调研时间", "第 1 次现场走访 + 第 2 次线上补充（客户要求不记录具体日期）"),
        ("记录人", "李工（" + COMPANY + " 解决方案）"),
        ("文档性质", FICTION_NOTE),
    ])
    doc.add_page_break()

    doc.add_heading("一、调研背景与目的", level=1)
    para(doc, "客户为华东某汽车零部件一级供应商，压铸车间是其主力生产单元之一，长期向"
              "整车厂客户供应压铸件。本次调研由客户制造部发起，目的是判断“28 台设备在 "
              "3 个月内全部联网、OEE 实时可视”这一目标在当前设备条件与改造窗口下是否可行，"
              "以及需要哪些前置条件。")
    para(doc, "调研分两次进行：第一次为车间现场走访，覆盖压铸机区域、去毛刺机器人工位与"
              "检测线，并与制造部、设备部做了两场访谈；第二次为线上补充，主要与 IT 部确认"
              "网络与数据出域口径。本文是两次调研的记录整理，未做现场测量与点表逐台核对。")
    para(doc, "按客户要求，本文不记录具体厂址、客户名称与最终客户信息，统一以“华东某市”"
              "“某汽车零部件一级供应商”代称；涉及人员的表述统一以姓氏加岗位的方式记录。")

    doc.add_heading("二、客户基本情况", level=1)
    para(doc, "客户属于汽车零部件一级供应商，压铸车间承担铝合金压铸件的成型、去毛刺与"
              "检测工序，交付节拍与整车厂客户的排产强相关。车间管理由制造部负责，设备维护"
              "由设备部负责，网络与信息系统由 IT 部负责，三个部门分属不同分管领导。")
    para(doc, "车间的自动化程度呈“两头新、中间老”的形态：去毛刺机器人与检测线较新，"
              "压铸机中有一批 2015 年前投产的老机仍在满负荷运行。客户对老机改造的态度比"
              "我们预想的积极，制造部明确表示“只要不停产、不动原程序和机械结构，老机也要"
              "联网”。")

    doc.add_heading("三、车间设备与自动化现状", level=1)
    caption(doc, "表 1 压铸车间主要设备构成（客户口述，未逐台核对）")
    table(doc, ["设备类别", "数量", "品牌 / 型号", "备注"],
          [["压铸机", "28 台", "华铸 HZ-800、恒控 HC-300",
            "其中 12 台为 2015 年前投产的老机"],
           ["去毛刺机器人", "6 台", "锐臂 RB-6", "承担压铸件毛刺清理工序"],
           ["检测线", "4 条", "客户未提供品牌", "含人工目检与量具抽检环节"],
           ["现场 PLC", "以德控 DC-300、日控 NC-200 为主", "—",
            "具体台数未统计，需现场勘察确认"]],
          widths=[3.0, 3.4, 4.6, 5.0], size=9.0)
    para(doc, "老机的数据可得性是本次调研最关键的未知项。设备部李工判断，2015 年前投产的"
              "机型可能不具备以太网接口，需要从控制器串口或加装传感的方式取数；这属于现场"
              "判断，最终以勘察阶段的逐台点表核对结论为准。我们据此把“老机可采集性勘察”"
              "列为方案的前置任务，而不是直接按联网台数估算工程量。")
    para(doc, "机器人与检测线侧的接口情况相对明朗：机器人有状态与报警输出，检测线有结果"
              "计数与合格率输出。二者的数据在本次诉求中属于“加分项”，客户的硬指标集中在 "
              "28 台压铸机。")

    doc.add_heading("四、信息化与网络现状", level=1)
    para(doc, "车间现有一套 2016 年建设的 MES，功能上只有工单与产量两个模块，没有设备数据"
              "入口，也没有采集层。生产报表由班组长在班末手工填写，次日由统计人员汇总，"
              "设备侧的数据从未进入系统。OEE 的计算方式是班组长按当日产量与计划产量估算，"
              "没有停机时长与节拍的实测数据支撑。")
    para(doc, "网络方面，车间主干为百兆工业以太网，覆盖压铸机主通道与办公区域；去毛刺"
              "区域和东侧新增的检测线区域没有布线，机台位置与最近的网络箱距离较远。"
              "IT 部表示车间网络与办公网络物理隔离，任何数据出车间都需要走审批流程，"
              "当前没有既定的审批模板。")

    doc.add_heading("五、访谈要点与痛点记录", level=1)
    doc.add_heading("5.1 OEE 不可测：估算值 65–75%，真实值未知", level=2)
    para(doc, "制造部张工提到，车间每天公布的 OEE 是班组长估算值，波动区间在 65–75% 之间，"
              "“谁值班谁估算，口径不一样”。客户自己也不确定真实值是多少，更无法判断改善"
              "空间在哪里。这是本次项目的直接动因。")
    doc.add_heading("5.2 换模停机与故障停机无法归因", level=2)
    para(doc, "停机记录目前只有设备部的维修工单，覆盖故障类停机；换模、待料等非故障停机"
              "没有记录。张工举例说，一次换模从拆模到首件合格的时间没有实测，模具与设备"
              "的匹配问题只能靠经验判断。客户希望把停机自动归集为换模、故障、待料、其他"
              "四类，并统计时长与频次。")
    doc.add_heading("5.3 整车厂客户审核要求关键过程参数可追溯", level=2)
    para(doc, "客户的整车厂客户在审核中要求供应商对关键过程参数留存并可追溯。目前这些"
              "参数散落在设备控制器与纸质工艺卡上，追溯一次要翻班组记录，耗时且不完整。"
              "设备部认为这是“体系要求，不是可选项”。")
    doc.add_heading("5.4 能耗成本上升，但没有分项计量", level=2)
    para(doc, "车间能耗按总表计量，压铸机、机器人、检测线与辅助设备的用电没有分开。"
              "张工提到电费在成本中的占比这两年明显上升，但缺少分项数据，节能改造不知道"
              "从哪里下手。")
    doc.add_heading("5.5 纸质报表每日人工抄录约 2 小时", level=2)
    para(doc, "班末抄录加次日汇总，统计口径下每天约 2 小时的人工投入。客户希望这部分工作"
              "转为系统自动生成，人员转向异常处理。")

    doc.add_heading("六、客户诉求与验收口径", level=1)
    caption(doc, "表 2 客户诉求与验收口径（客户表述整理，未经书面确认）")
    table(doc, ["序号", "客户诉求", "验收口径提示"],
          [["1", "3 个月内 28 台设备全部联网", "以台数为准，需先完成老机可采集性勘察"],
           ["2", "OEE 实时可视，按班次与机台拆分", "需明确 OEE 计算公式、计划时间与节拍口径"],
           ["3", "停机原因自动归集（换模 / 故障 / 待料 / 其他）", "四类归集规则的判定依据需与制造部确认"],
           ["4", "关键过程参数留存 ≥1 年、可追溯", "参数项与留存位置需与 IT 部确认"],
           ["5", "不改原 PLC 程序和机械结构", "旁路采集；不改动即不改动，含程序与接线"],
           ["6", "不中断生产", "改造仅在周末停线窗口内完成，单次 ≤8 小时"]],
          widths=[1.3, 6.3, 8.4], size=9.0)

    doc.add_heading("七、关键过程参数清单", level=1)
    caption(doc, "表 3 客户点名的关键过程参数（参数名以现场点表为准）")
    table(doc, ["参数", "预期来源", "留存要求", "备注"],
          [["压射速度", "压铸机控制器", "≥1 年", "逐模记录还是抽样记录待确认"],
           ["铸造压力", "压铸机控制器", "≥1 年", "单位与量程需与设备部核对"],
           ["模温", "模温机或压铸机控制器", "≥1 年", "信号形式（模拟量 / 通信）待确认"],
           ["循环时间", "压铸机控制器", "≥1 年", "可由开合模信号计算，需明确起止标志"]],
          widths=[2.6, 4.4, 2.4, 6.6], size=9.0)
    para(doc, "客户强调这四项参数是审核关注点，其余参数属于“有则更好”。我们在方案中把"
              "四项参数列为必采项，其余按点表梳理结果分批接入。")

    doc.add_heading("八、实施约束与前置条件", level=1)
    lead_para(doc, "改造窗口：", "只能在周末停线窗口内完成，单次窗口不超过 8 小时。这决定"
              "了施工必须按机台分批、以“插接 + 配置”为主，避免现场编程与大规模接线。")
    lead_para(doc, "网络条件：", "部分区域无布线，需要无线方案。客户接受在布线确认前先用"
              "无线通道上线，后续再切换为有线，但要求无线通道的数据与有线一致可追溯。")
    lead_para(doc, "组织与合规：", "IT 与 OT 分属两个部门，设备数据出车间需要审批；当前"
              "没有现成的审批模板与数据分类标准，需要在方案阶段与 IT 部共同明确。")
    lead_para(doc, "预算：", "客户口述首期预算区间为 80–120 万元，尚未形成正式预算文件，"
              "也没有明确是否包含网络改造与电表等第三方内容。")
    lead_para(doc, "安全边界：", "设备部明确要求设备改造不得影响原有安全回路。任何涉及"
              "安全回路的信号与逻辑都不在本次改造范围内，安全功能仍由原有安全回路承载。")

    doc.add_heading("九、合规与门槛线索", level=1)
    para(doc, "本次调研共识别出四条门槛线索，均来自客户口述，尚未核验原文：", space_after=3)
    bullets(doc, [
        "IATF 16949 体系要求：设备与过程参数需可追溯，是本次项目的体系依据。",
        "整车厂客户对供应商过程数据留存的要求：客户需在审核中提供关键过程参数记录。",
        "设备数据出车间的信息安全要求：IT 部要求明确数据范围、流向与存放位置后审批。",
        "设备改造不得影响原有安全回路：安全功能由独立安全回路承载，改造不介入。",
    ])

    doc.add_heading("十、决策链与推进节奏", level=1)
    para(doc, "客户内部决策链为：制造部（需求方）→ IT 部（网络与数据合规）→ 设备部"
              "（改造实施）→ 总经理（预算）。制造部是发起方与最终使用方，IT 部与设备部"
              "具备否决权，预算由总经理审批。")
    para(doc, "推进建议（供下一轮沟通使用）：先做老机可采集性勘察与点表盘点，出如实"
              "的联网台数；再选 2–3 台代表性机台做试点，验证 OEE 口径与停机归集规则；"
              "试点通过后按区域分批推广，把每次改造都压在 8 小时窗口之内。这一节奏的前提"
              "是客户先在制造部内部把 OEE 计算公式定下来。")

    doc.add_heading("十一、待确认问题清单", level=1)
    bullets(doc, [
        "12 台 2015 年前投产的老压铸机是否具备可用数据接口，需现场勘察逐台确认。",
        "四项关键过程参数的信号来源、单位、量程与点表归属，需与设备部核对。",
        "OEE 的计算公式、计划时间、节拍基准与班次划分口径，需制造部书面确认。",
        "停机四类归集（换模 / 故障 / 待料 / 其他）的判定依据与责任部门。",
        "无线覆盖区域的方案与责任划分（由客户网络团队还是项目承担）。",
        "设备数据出车间的审批口径、留存位置与留存时长（IT 部）。",
        "首期预算的构成范围与审批流程、付款节点。",
        "停线窗口的最终排期与可用的周末窗口数量。",
    ])

    doc.add_heading("十二、记录说明", level=1)
    para(doc, "本文为客户调研纪要的整理稿。" + FICTION_NOTE + "文中数量、预算区间与百分比"
              "均为客户口述估算值，未做现场核实与书面确认；涉及技术可行性的判断已在文中"
              "标注为“待确认”。本纪要仅用于内部方案讨论，不作为承诺或验收依据。", size=9.5,
         color=C_GREY)

    set_footer(doc, "场景 A 客户调研纪要 ｜ " + COMPANY + " ｜ " + FICTION_NOTE)
    out = OUT_DIR / DOC_SCENE_A
    doc.save(out)
    normalize_zip(out)
    return out


# ================================================================ 4. 场景 B
def build_scene_b() -> Path:
    doc = init_doc()
    cover(doc, "场景 B：市政污水处理厂设备监控与能耗管理",
          "客户调研纪要 + 现状说明")
    kv_table(doc, [
        ("客户", "华东某地级市水务集团下属污水处理厂（虚构）"),
        ("场景名称", "市政污水处理厂设备监控与能耗管理"),
        ("行业", "市政公用（污水处理）"),
        ("处理规模", "12 万吨/日"),
        ("覆盖范围", "2 座厂区 + 6 座提升泵站"),
        ("调研对象", "厂区运营部、集团信息中心、采购部"),
        ("调研方式", "厂区现场走访 + 泵站远程视频访谈"),
        ("记录人", "王工（" + COMPANY + " 解决方案）"),
        ("文档性质", FICTION_NOTE),
    ])
    doc.add_page_break()

    doc.add_heading("一、调研背景与目的", level=1)
    para(doc, "客户为华东某地级市水务集团下属污水处理厂，处理规模 12 万吨/日，下辖 2 座"
              "厂区与 6 座提升泵站。集团在年度考核中要求各厂按月上报能耗与设备可用率，"
              "该厂目前依靠人工汇总，数据口径与时效都难以满足要求。本次调研由厂区运营部"
              "发起，目的是评估“6 座泵站无人值守远程监控 + 主要设备分项计量”的可行性与"
              "实施路径。")
    para(doc, "调研形式为厂区现场走访加泵站远程视频访谈。厂区侧重点看中控室与既有 SCADA "
              "的覆盖范围，泵站侧重点看现场仪表与通信条件。集团信息中心与采购部以座谈形式"
              "参与，主要说明平台合规与招标流程方面的要求。")
    para(doc, "按客户要求，本文不记录具体城市、厂名与人员全名，统一以“华东某地级市”"
              "“某水务集团下属污水处理厂”代称。")

    doc.add_heading("二、客户与项目基本情况", level=1)
    para(doc, "该厂承担城区生活污水与部分工业废水的处理任务，出水标准执行地方要求。"
              "运维团队共 9 人，采用轮班方式覆盖 2 座厂区与 6 座提升泵站的日常巡检、"
              "设备操作与简单维修。泵站分布在城区不同位置，最远的泵站距厂区车程约 40 分钟。")
    para(doc, "集团层面正在推进统一的信息平台建设，各厂的数据需要按统一口径上报。"
              "本项目属于厂区侧的设备与能耗数据基础建设，数据最终归属集团统一平台，"
              "这一归属关系直接决定了数据接口与上报口径的设计。")

    doc.add_heading("三、自控与信息化现状", level=1)
    caption(doc, "表 1 自控与信息化现状（客户口述整理）")
    table(doc, ["对象", "建设时间", "覆盖范围", "现状问题"],
          [["厂区 SCADA", "2013 年", "仅覆盖主要工艺回路（进出水、生化池、鼓风机房部分设备）",
            "点位不全，设备侧数据缺少分项与统计维度"],
           ["6 座提升泵站", "—", "标称无人值守，实际只有电话报警",
            "液位、流量、水泵状态、电流均未远传，故障依赖电话通知"],
           ["能耗计量", "—", "按厂区总表计量", "水泵、鼓风机、脱水机未做分项，无法按设备分析"],
           ["设备台账与维修记录", "—", "电子表格分散维护", "分散在不同人员电脑，无法统计可用率与维修频次"],
           ["运维方式", "—", "9 人轮班巡检", "泵站巡检以现场查看为主，人工记录"]],
          widths=[3.4, 2.2, 5.2, 6.2], size=8.5)
    para(doc, "中控室值班人员反映，既有 SCADA 的报警集中在工艺参数越限，设备本身的"
              "故障（例如水泵过载、脱水机异常停机）多数靠现场发现或电话通知。泵站侧没有"
              "远程监视手段，值班人员只能通过电话确认状态；如果无人接听，就只能派人前往。")

    doc.add_heading("四、访谈要点与痛点记录", level=1)
    doc.add_heading("4.1 泵站故障平均 4 小时才发现", level=2)
    para(doc, "运营部反馈，泵站故障从发生到被发现平均约 4 小时，主要取决于是否有人恰好"
              "在附近或接到电话。这期间可能造成液位升高、溢流风险与水泵空转，是当前运维"
              "压力最大的部分。")
    doc.add_heading("4.2 吨水电耗高于集团平均 8%", level=2)
    para(doc, "该厂吨水电耗比集团平均水平高约 8%。由于没有分项计量，运营部无法判断差异"
              "来自水泵效率下降、鼓风机运行策略，还是进水水质波动，改善措施只能凭经验"
              "调整。这是客户最希望用数据回答的问题。")
    doc.add_heading("4.3 设备台账与维修记录分散，无法统计", level=2)
    para(doc, "设备台账与维修记录以电子表格形式分散在不同人员的电脑中，同一台设备的"
              "维修历史需要人工查找，设备可用率无法按设备统计，只能按厂区整体估算。")
    doc.add_heading("4.4 集团按月上报，目前靠人工汇总", level=2)
    para(doc, "集团要求每月上报能耗与设备可用率。目前的做法是各岗位收集数据后，由运营部"
              "指定人员汇总，通常需要 1–2 天，且不同月份的口径偶有差异。客户希望上报"
              "数据直接由系统生成，口径固定。")

    doc.add_heading("五、客户诉求与验收口径", level=1)
    caption(doc, "表 2 客户诉求与验收口径（客户表述整理，未经书面确认）")
    table(doc, ["序号", "客户诉求", "验收口径提示"],
          [["1", "6 座泵站实现无人值守远程监控", "测点：液位、流量、水泵状态、电流"],
           ["2", "水泵、鼓风机、脱水机等主要设备分项计量与能耗分析", "需外接智能电表，电表不在设备清单内"],
           ["3", "设备台账与工单打通", "工单来源与流向需与运营部确认（谁派单、谁闭环）"],
           ["4", "与既有 SCADA 并存，不替换", "旁路采集，不改动既有 SCADA 与其程序"],
           ["5", "关键数据留存满足等保与审计要求", "留存时长与审计口径需与集团信息中心确认"],
           ["6", "质保期 3 年", "含平台与边缘设备的质保与响应时限，需在招标文件中明确"]],
          widths=[1.3, 6.6, 8.1], size=9.0)

    doc.add_heading("六、设备与测点初步清单", level=1)
    caption(doc, "表 3 初步测点清单（勘察后调整，此处仅列客户点名项）")
    table(doc, ["监控对象", "关键测点", "说明"],
          [["提升泵站（6 座）", "液位、流量、水泵状态、电流",
            "客户明确点名；泵站分布分散，通信条件需逐站勘察"],
           ["厂区水泵", "运行状态、电流、能耗", "能耗需外接智能电表实现分项计量"],
           ["鼓风机", "运行状态、电流、能耗", "能耗占比高，是能耗分析的重点对象"],
           ["脱水机", "运行状态、电流、能耗", "运行时段不固定，需按班次统计"],
           ["既有 SCADA 侧", "主要工艺参数（只读）", "旁路读取，不改动既有 SCADA 程序与配置"]],
          widths=[3.4, 5.0, 8.6], size=9.0)
    para(doc, "需要说明的是：能耗数据采集与分项计量需要外接智能电表，电表采购与安装不在"
              "我们的产品范围内，方案中会单列。泵站侧的通信方式取决于逐站勘察结果，"
              "本次调研未逐站确认。")

    doc.add_heading("七、实施约束与项目条件", level=1)
    lead_para(doc, "资金与流程：", "本项目为财政资金项目，需走政府采购与财政评审流程，"
              "预算、工期与配置清单需要在评审前对齐；任何配置变更都要考虑评审时效。")
    lead_para(doc, "合规要求：", "按等保 2.0 三级（GB/T 22239）要求建设，涉及边界防护、"
              "身份鉴别、访问控制、审计与数据完整性等方面，需要在方案阶段就与集团信息"
              "中心对齐责任界面。")
    lead_para(doc, "停机条件：", "不能停机改造。既有工艺与 SCADA 必须持续运行，所有接入"
              "均采用旁路方式，改造作业需避开进水高峰与设备检修窗口。")
    lead_para(doc, "接口依赖：", "既有 SCADA 由原厂维保，数据接口需要原厂配合。这是项目"
              "排期的主要不确定项，需要在方案阶段把接口配合事项写入实施计划。")
    lead_para(doc, "质保期：", "客户要求质保期 3 年，含平台与边缘设备的故障响应时限，"
              "需在投标配置与报价中一并考虑。")

    doc.add_heading("八、合规与门槛线索", level=1)
    para(doc, "本次调研识别出四条门槛线索，均来自客户口述，尚未核验原文：", space_after=3)
    bullets(doc, [
        "等保 2.0 三级（GB/T 22239）：平台与网络的安全要求，涉及审计、访问控制与数据完整性。",
        "水务行业设备采购与集采资质：需确认集团或行业的供应商准入与集采要求。",
        "财政评审对预算与工期的要求：配置清单与工期需与评审口径一致，变更受约束。",
        "数据归属与上报口径：数据归属集团统一平台，上报口径需按集团规定执行。",
    ])

    doc.add_heading("九、决策链与推进节奏", level=1)
    para(doc, "客户内部决策链为：厂区运营部（需求方）→ 集团信息中心（平台与合规）→ "
              "采购部（招标）→ 财政局评审。运营部是需求发起方与使用方；集团信息中心"
              "对平台选型与合规要求具有决定性影响；采购部负责招标组织；最终预算受财政"
              "评审约束。")
    para(doc, "推进建议（供下一轮沟通使用）：先完成 6 座泵站的通信条件逐站勘察与原厂"
              "接口配合事项确认，这两项直接决定工期；同时与集团信息中心对齐等保三级"
              "的责任界面与数据上报口径；配置清单与工期形成后进入政府采购流程。")

    doc.add_heading("十、待确认问题清单", level=1)
    bullets(doc, [
        "6 座泵站逐站的通信条件（有无运营商信号、可否布放光纤）与原厂设备接口形式。",
        "既有 SCADA 的数据接口开放方式、点表提供方与原厂配合的商务安排。",
        "智能电表的选型、数量、安装位置与采购主体（是否需要单列预算）。",
        "工单体系的来源与流转：工单在平台内闭环，还是对接集团既有工单系统。",
        "等保 2.0 三级的建设内容与责任界面划分（哪些由平台承担、哪些由客户网络承担）。",
        "数据留存时长与审计口径，以及数据归属集团平台后的接口方式。",
        "集团或行业的供应商准入与集采资质要求。",
        "财政评审对预算、工期与配置清单的具体要求与时间节点。",
    ])

    doc.add_heading("十一、记录说明", level=1)
    para(doc, "本文为客户调研纪要的整理稿。" + FICTION_NOTE + "文中处理规模、能耗差异"
              "百分比与故障发现时长均为客户口述数据，未做现场核实；涉及技术可行性的"
              "判断已在文中标注为“待确认”。本纪要仅用于内部方案讨论，不作为承诺或"
              "验收依据。", size=9.5, color=C_GREY)

    set_footer(doc, "场景 B 客户调研纪要 ｜ " + COMPANY + " ｜ " + FICTION_NOTE)
    out = OUT_DIR / DOC_SCENE_B
    doc.save(out)
    normalize_zip(out)
    return out


# ================================================================ 交付前自检
def extract_text(path: Path) -> list[str]:
    """把 Office 文件里的可见文本抽成行列表（含表格），用于脱敏扫描。"""
    lines: list[str] = []
    if path.suffix == ".docx":
        d = Document(str(path))
        for p in d.paragraphs:
            lines.append(p.text)
        for t in d.tables:
            for row in t.rows:
                for c in row.cells:
                    lines.append(c.text)
    elif path.suffix == ".xlsx":
        from openpyxl import load_workbook
        wb = load_workbook(str(path))
        for ws in wb.worksheets:
            for row in ws.iter_rows(values_only=True):
                for v in row:
                    if v is not None:
                        lines.append(str(v))
    elif path.suffix == ".pptx":
        prs = Presentation(str(path))
        for slide in prs.slides:
            for shape in slide.shapes:
                if shape.has_text_frame:
                    for p in shape.text_frame.paragraphs:
                        lines.append("".join(r.text for r in p.runs))
                if getattr(shape, "has_table", False):
                    for row in shape.table.rows:
                        for c in row.cells:
                            lines.append(c.text)
    return lines


def scan_forbidden(lines: list[str]) -> list[str]:
    hits: list[str] = []
    latin_re = re.compile(
        r"(?<![A-Za-z0-9])(" + "|".join(re.escape(w) for w in DENY_LATIN) + r")(?![A-Za-z0-9])",
        re.IGNORECASE)
    ipv4_re = re.compile(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b")
    for line in lines:
        if not line:
            continue
        for w in DENY_CJK:
            if w in line:
                hits.append("CJK黑名单命中 [%s]：%s" % (w, line[:60]))
        m = latin_re.search(line)
        if m:
            hits.append("拉丁黑名单命中 [%s]：%s" % (m.group(0), line[:60]))
        if "sk-" in line:
            hits.append("疑似密钥前缀 sk-：%s" % line[:60])
        if ipv4_re.search(line):
            hits.append("疑似 IP 地址：%s" % line[:60])
        for bad in ("/Users/", "C:\\", "内网", "192.168", "://", "http://", "https://"):
            if bad in line:
                hits.append("疑似路径/地址 [%s]：%s" % (bad, line[:60]))
    return hits


def self_check() -> int:
    print("=" * 78)
    print("交付前自检")
    print("=" * 78)
    ok = True
    all_lines: list[str] = []
    for name in OUTPUT_FILES:
        path = OUT_DIR / name
        if not path.is_file():
            print("[FAIL] 缺失文件：%s" % name)
            ok = False
            continue
        lines = extract_text(path)
        all_lines.extend(lines)
        chars = sum(len(re.sub(r"\s", "", line)) for line in lines)
        digest = hashlib.md5(path.read_bytes()).hexdigest()
        print("[OK] %-58s %8.1f KB  文本行 %5d  非空白字符 %6d  md5 %s"
              % (name, path.stat().st_size / 1024, len(lines), chars, digest[:10]))

    doc_wp = Document(str(OUT_DIR / DOC_WHITEPAPER))
    doc_a = Document(str(OUT_DIR / DOC_SCENE_A))
    doc_b = Document(str(OUT_DIR / DOC_SCENE_B))
    from openpyxl import load_workbook
    wb = load_workbook(str(OUT_DIR / DOC_SPECS))
    ws = wb["产品规格参数表"]
    deck = Presentation(str(OUT_DIR / DOC_DECK))

    print("-" * 78)
    print("白皮书：段落 %d，表格 %d，标题 %d"
          % (len(doc_wp.paragraphs),
             len(doc_wp.tables),
             sum(1 for p in doc_wp.paragraphs if p.style.name.startswith("Heading"))))
    print("场景 A：段落 %d，表格 %d，字数（非空白）%d"
          % (len(doc_a.paragraphs), len(doc_a.tables),
             sum(len(re.sub(r"\s", "", p.text)) for p in doc_a.paragraphs)
             + sum(len(re.sub(r"\s", "", c.text)) for t in doc_a.tables
                   for row in t.rows for c in row.cells)))
    print("场景 B：段落 %d，表格 %d，字数（非空白）%d"
          % (len(doc_b.paragraphs), len(doc_b.tables),
             sum(len(re.sub(r"\s", "", p.text)) for p in doc_b.paragraphs)
             + sum(len(re.sub(r"\s", "", c.text)) for t in doc_b.tables
                   for row in t.rows for c in row.cells)))
    spec_rows = ws.max_row - 1
    print("规格表：数据行 %d（三列：%s），工作表 %s"
          % (spec_rows, [c.value for c in ws[1]], wb.sheetnames))
    def _deck_bullets(slide) -> int:
        n = 0
        for sh in slide.shapes:
            if not sh.has_text_frame:
                continue
            for p in sh.text_frame.paragraphs:
                if p.text.strip().startswith("▪"):
                    n += 1
        return n

    deck_counts = [_deck_bullets(s) for s in deck.slides]
    print("PPT：页数 %d，每页要点数 %s" % (len(deck.slides), deck_counts))

    if not (60 <= spec_rows <= 90):
        print("[FAIL] 规格表数据行数不在 60–90 区间：%d" % spec_rows)
        ok = False
    if len(deck.slides) < 8 or len(deck.slides) > 10:
        print("[FAIL] PPT 页数不在 8–10：%d" % len(deck.slides))
        ok = False
    for label, d in (("白皮书", doc_wp), ("场景A", doc_a), ("场景B", doc_b)):
        tw = sum(len(re.sub(r"\s", "", p.text)) for p in d.paragraphs)
        if tw < 800:
            print("[FAIL] %s 正文疑似过短：%d 字" % (label, tw))
            ok = False
    for i, n in enumerate(deck_counts, 1):
        if n > 6:
            print("[FAIL] PPT 第 %d 页要点数超过 6：%d" % (i, n))
            ok = False

    print("-" * 78)
    hits = scan_forbidden(all_lines)
    if hits:
        ok = False
        print("[FAIL] 脱敏扫描命中 %d 条：" % len(hits))
        for h in hits[:40]:
            print("   " + h)
    else:
        print("[OK] 脱敏扫描：未命中真实厂商名 / 地名 / 人名 / 密钥 / IP / 路径（黑名单 %d 条）"
              % (len(DENY_CJK) + len(DENY_LATIN)))

    spacing_re = re.compile(r"[\u4e00-\u9fff][A-Za-z0-9]|[A-Za-z0-9][\u4e00-\u9fff]")
    spacing: list[str] = []
    for line in all_lines:
        for m in spacing_re.finditer(line):
            spacing.append(line[max(0, m.start() - 10):m.end() + 10])
    if spacing:
        print("[WARN] 中文与拉丁字符直接相邻（建议补空格）%d 处：" % len(spacing))
        for s in spacing[:10]:
            print("   " + s)
    else:
        print("[OK] 中英文间距检查：无中文与拉丁字符直接相邻的片段")

    print("=" * 78)
    print("自检结果：%s" % ("全部通过" if ok else "存在问题，见上方 FAIL"))
    return 0 if ok else 1


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print("输出目录：%s" % OUT_DIR)
    # 白皮书与产品介绍 PPT **不在这里生成**：这两份是「成稿」，要走产品自己的输出格式
    #   · 云枢智控-产品与能力白皮书.docx  ← .tools/extract-whitepaper.py + .tools/build-whitepaper.mjs
    #     （内容源是抽出来的 云枢智控-产品与能力白皮书.md，渲染走 @scene/infra 的 docx-report）
    #   · 云枢智控-产品介绍.pptx          ← .tools/build-deck.mjs
    #     （大纲是 产品介绍-大纲.json，渲染走 @scene/infra 的 ppt-svg + ppt-master，B站蓝色模板）
    # 本脚本只负责「非成稿素材」：规格参数表与两份客户调研资料。
    # 这里保留 build_whitepaper / build_deck 两个函数仅供历史比对，**不要**再加回 builders。
    builders = [
        ("规格参数表", build_specs),
        ("场景 A 客户资料", build_scene_a),
        ("场景 B 客户资料", build_scene_b),
    ]
    for label, fn in builders:
        path = fn()
        print("已生成 %-14s → %s" % (label, path.name))
    return self_check()


if __name__ == "__main__":
    sys.exit(main())
