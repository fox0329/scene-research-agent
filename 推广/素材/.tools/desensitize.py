#!/usr/bin/env python3
"""演示库脱敏：把模型在「行业通例 / 竞争格局」列里带出的真实厂商名，整体替换为虚构厂商。

背景：上传材料本身是虚构的（无真实厂商名），但模型在需要行业常识的列里
（上游供给格局、竞争对手对照、门槛否决方等）会调用自身知识，写出真实厂商名。
对外发布截图与文稿前必须替换掉，否则违反隐私与合规红线。

用法：
    python3 desensitize.py <scene.db> [--dry-run]
"""
from __future__ import annotations

import re
import sqlite3
import sys

# 顺序敏感：长串、带括号的写法必须排在短串前面
REPLACEMENTS: list[tuple[str, str]] = [
    # —— 压铸机整机厂（与演示世界既有品牌保持一致）——
    ("力劲科技（LK）", "华铸精机"),
    ("力劲科技", "华铸精机"),
    ("力劲", "华铸精机"),
    ("伊之密", "恒控精机"),
    ("海天金属", "海铸金属"),
    ("海天", "海铸"),
    ("布勒（Bühler）", "布兰机械"),
    ("布勒", "布兰机械"),
    ("东芝机械", "东和精机"),
    ("东芝", "东和精机"),
    ("宇部（UBE）", "宇和重工"),
    ("宇部", "宇和重工"),
    ("UBE", "UHE"),
    # —— 国际工控 / 工业软件 ——
    ("西门子（SIMATIC IOT/Edge）", "德控自动化（DCEdge）"),
    ("西门子（SIMATIC IOT）", "德控自动化（DCEdge）"),
    ("西门子（Opcenter）", "德控自动化（DCOps）"),
    ("西门子（MindSphere）", "德控自动化（DCloud）"),
    ("西门子（WinCC）", "德控自动化（DCView）"),
    ("西门子", "德控自动化"),
    ("SIMATIC", "DCS"),
    ("Opcenter", "DCOps"),
    ("MindSphere", "DCloud"),
    ("WinCC", "DCView"),
    ("罗克韦尔自动化（Rockwell）", "罗控自动化"),
    ("罗克韦尔（FactoryTalk）", "罗控自动化（RockView）"),
    ("罗克韦尔", "罗控自动化"),
    ("Rockwell", "RockCon"),
    ("FactoryTalk", "RockView"),
    ("施耐德（AVEVA）", "施德电气（AVX）"),
    ("施耐德", "施德电气"),
    ("AVEVA", "AVX"),
    ("三菱电机", "三和电机"),
    ("三菱", "三和电机"),
    ("欧姆龙", "欧控"),
    ("贝加莱", "贝加"),
    ("ABB", "安贝"),
    ("发那科（FANUC）", "发科机器人（FANC）"),
    ("发那科", "发科机器人"),
    ("FANUC", "FANC"),
    ("库卡（KUKA）", "库克机器人（KUKO）"),
    ("库卡", "库克机器人"),
    ("KUKA", "KUKO"),
    ("研华（Advantech）", "研凌（Advanlink）"),
    ("研华", "研凌"),
    ("Advantech", "Advanlink"),
    ("基恩士（Keyence）", "基恩（Kenence）"),
    ("基恩士", "基恩"),
    ("Keyence", "Kenence"),
    ("埃斯顿", "埃德"),
    ("拓斯达", "拓斯"),
    ("摩莎（Moxa）", "摩萨（MoxaLink）"),
    ("摩莎", "摩萨"),
    ("Moxa", "MoxaLink"),
    ("新华三（H3C）", "新云网（H3N）"),
    ("新华三", "新云网"),
    ("H3C", "H3N"),
    ("思科", "赛科"),
    # —— 水务行业厂商（场景 B 带出）——
    ("哈希（Hach）", "水析（HachX）"),
    # 裸串「哈希」**故意不收**：中文里「哈希」也是 hash 的通用译法，
    # 收进来会把「文件哈希」「哈希校验」这类正常文字改成「水析」，属于误伤。
    # 本语料里 Hach 一律写作「哈希（Hach）」，上面那条长串已经覆盖；
    # 万一将来出现裸写的厂商名，由 .tools/privacy-scan.py 在发布前扫出来。
    ("Hach", "HachX"),
    ("恩德斯豪斯", "恩德仪表"),
    ("E+H", "EH"),
    ("格兰富", "格蓝泵业"),
    ("赛莱默", "赛莱水"),
    ("凯泉", "凯源泵业"),
    ("南方泵业", "南联泵业"),
    ("KSB", "凯仕泵业"),
    ("横河电机", "横川电机"),
    ("横河", "横川"),
    # —— 国产工控 / 工业软件 ——
    ("汇川技术", "汇创技术"),
    ("汇川", "汇创技术"),
    ("和利时", "和利"),
    ("中控技术", "中衡技术"),
    ("宝信软件", "宝联软件"),
    ("宝信", "宝联软件"),
    ("鼎捷", "鼎联"),
    ("用友", "友联"),
    ("金蝶", "金联"),
    ("达索（Apriso）", "达科软件（AprisoX）"),
    ("达索", "达科软件"),
    ("Apriso", "AprisoX"),
    ("PTC（ThingWorx）", "普泰软件（ThingX）"),
    ("PTC（Kepware）", "普泰软件（KepX）"),
    ("PTC", "普泰软件"),
    ("ThingWorx", "ThingX"),
    ("Kepware", "KepX"),
    ("亚控科技", "亚信科技"),
    ("亚控", "亚信科技"),
    ("力控科技", "力信科技"),
    ("力控", "力信科技"),
    ("组态王", "组态宝"),
    ("川仪股份", "川联仪表"),
    ("川仪", "川联仪表"),
    ("汉得信息", "汉联信息"),
    ("汉得", "汉联信息"),
    ("浪潮", "浪峰"),
    # —— 工业互联网平台 / 云 ——
    ("海尔卡奥斯", "海创云"),
    ("卡奥斯", "海创云"),
    ("徐工汉云", "鼎汉云"),
    ("树根互联", "根联工业互联网"),
    ("蘑菇物联", "蕈联物联"),
    ("黑湖智造", "玄湖智造"),
    ("摩尔元数", "摩元数"),
    ("阿里云 supET", "云集云 SupEdge"),
    ("阿里云", "云集云"),
    ("supET", "SupEdge"),
    ("华为云工业", "华云工业"),
    ("华为云", "华云"),
    ("华为", "华云"),
    # —— 数据库 ——
    ("Oracle", "奥瑞数据库"),
    ("微软", "微联"),
    ("SAP", "萨普"),
    ("达梦", "达盟"),
    ("人大金仓", "金仓数科"),
]

# 需要正则（带否定环视）的特例：中控室 = 中央控制室，不是厂商
REGEX_REPLACEMENTS: list[tuple[str, str]] = [
    (r"中控(?!室)", "中衡技术"),
]

# 二次替换产生的拼接痕迹（第一版脚本逐条 replace 的副作用），必须先修掉
REPAIRS: list[tuple[str, str]] = [
    ("HachXX", "HachX"),
    ("AprisoXX", "AprisoX"),
    ("MoxaLinkLink", "MoxaLink"),
    ("Advanlinklink", "Advanlink"),
    ("DCEdgeEdge", "DCEdge"),
]

# 第二轮排查新发现（从 vendor / who_supplies / representative / leader 等
# 厂商列举列里把所有取值抽出来逐个核对，才捞出来的漏网名单）
REPLACEMENTS += [
    ("映翰通", "映联"),
    ("有人物联网", "有联物联网"),
    ("移远通信", "移联通信"),
    ("移远", "移联"),
    ("广和通", "广联通信"),
    ("林洋能源", "林联能源"),
    ("林洋", "林联"),
    ("威胜", "威联"),
    ("中兴", "中联通信"),
    ("安科瑞", "安瑞电气"),
    ("安德里茨", "奥德里茨"),
    ("兴源环境", "兴和环境"),
    ("力合科技", "力禾科技"),
    ("聚光科技", "聚能科技"),
    ("景津装备", "景源装备"),
    ("格创东智", "格联智造"),
    ("明源云", "明云软件"),
    ("必创科技", "必联科技"),
    ("汉吉龙", "汉吉隆"),
    ("沈鼓", "沈联鼓风"),
    ("章鼓", "章联鼓风"),
    ("贝亚雷斯", "贝亚雷"),
    ("阿特拉斯·科普柯", "阿特拉·科普"),
    ("金士顿", "金士通"),
    ("岛津", "岛川"),
    ("统信 UOS", "通联 OS"),
    ("统信", "通联"),
    ("麒麟软件", "麟云软件"),
    ("麒麟", "麟云"),
    ("上海凯源泵业", "上海凯川泵业"),
    ("凯源泵业", "凯川泵业"),
    ("福乐伟", "福莱威"),
    ("科隆", "科朗"),
    ("豪顿", "豪登"),
    ("Atlas", "YS-EdgeBox"),
    ("openGauss", "openGres"),
    ("Xylem", "Xylflow"),
    ("TP-LINK", "联普"),
    ("Flottweg", "Flottwix"),
    ("KROHNE", "Kronix"),
    ("Howden", "Howdex"),
    ("SKF", "SBK"),
]


def _guard(key: str, value: str) -> str:
    """幂等护栏：产物以原词开头时，排除「后面正好接着自己产物尾巴」的那些位置。

    `Moxa → MoxaLink` 这类映射，产物**包含原词**。单趟扫描只保证「一个位置只替一次」，
    但保证不了「不再跑第二遍」：库里已经是 `MoxaLink` 时再跑，`Moxa` 又匹配上，追加成
    `MoxaLinkLink`，越替越长（`HachX → HachXX`、`AprisoX → AprisoXX` 同理）。
    加一条否定环视即可——真名 `摩莎（Moxa）` 后面不接 `Link`，照替不误。
    """
    if value.startswith(key) and len(value) > len(key):
        return f"{re.escape(key)}(?!{re.escape(value[len(key):])})"
    return re.escape(key)


def _build_matcher() -> tuple[re.Pattern[str], dict[str, str]]:
    """把所有替换规则编译成**一次扫描**的正则。

    第一版是逐条 str.replace，结果是"替换产物又被后面的规则再替一次"：
    `摩莎（Moxa）→ 摩萨（MoxaLink）→ 摩萨（MoxaLinkLink）`。
    改成单趟扫描后，每个位置只被替换一次，产物不再进入后续匹配；
    产物包含原词的那些映射再由 `_guard` 兜住，保证**反复运行结果不变**。
    """
    pairs = REPAIRS + REPLACEMENTS
    mapping = {k: v for k, v in pairs}
    # 正则特例：匹配串是「中控」，但只在后面不是「室」时生效
    mapping["中控"] = "中衡技术"
    # 长词优先：先按原词长度排，再套护栏（护栏会加长正则串，不能拿正则串长度排）
    ordered = sorted(((k, mapping[k]) for k, _ in pairs), key=lambda kv: len(kv[0]), reverse=True)
    alternatives = [_guard(k, v) for k, v in ordered]
    alternatives.extend(pat for pat, _ in REGEX_REPLACEMENTS)
    return re.compile("|".join(alternatives)), mapping


_MATCHER: tuple[re.Pattern[str], dict[str, str]] | None = None


def apply_all(text: str) -> str:
    global _MATCHER
    if _MATCHER is None:
        _MATCHER = _build_matcher()
    pattern, mapping = _MATCHER
    return pattern.sub(lambda m: mapping.get(m.group(0), m.group(0)), text)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    db_path = sys.argv[1]
    dry = "--dry-run" in sys.argv

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    tables = [
        r[0]
        for r in conn.execute(
            "select name from sqlite_master where type='table' and name not like 'sqlite_%'"
        )
    ]
    # FTS5 虚拟表及其影子表没有可用的 rowid 主键，且产品库本身是干净的，整体跳过
    tables = [t for t in tables if not t.startswith("source_fts")]

    total_changed_cells = 0
    total_changed_rows = 0
    per_table: dict[str, int] = {}

    for table in tables:
        cols = [r[1] for r in conn.execute(f"pragma table_info('{table}')")]
        # 有 id 用 id，没有就用隐式 rowid（stage_summary 这类复合主键表）
        key = "id" if "id" in cols else "rowid"
        rows = list(conn.execute(f"select rowid as __rowid, * from {table}"))
        for row in rows:
            updates: dict[str, str] = {}
            for col in cols:
                val = row[col]
                if not isinstance(val, str):
                    continue
                new = apply_all(val)
                if new != val:
                    updates[col] = new
            if not updates:
                continue
            total_changed_rows += 1
            total_changed_cells += len(updates)
            per_table[table] = per_table.get(table, 0) + 1
            if not dry:
                sets = ", ".join(f"{c} = ?" for c in updates)
                keyval = row["id"] if key == "id" else row["__rowid"]
                conn.execute(
                    f"update {table} set {sets} where {key} = ?",
                    [*updates.values(), keyval],
                )

    if not dry:
        conn.commit()

    print(f"{'[dry-run] ' if dry else ''}涉及表与改动行数：")
    for t, n in sorted(per_table.items(), key=lambda x: -x[1]):
        print(f"  {t}: {n} 行")
    print(f"合计：{total_changed_rows} 行 / {total_changed_cells} 个单元格")
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
