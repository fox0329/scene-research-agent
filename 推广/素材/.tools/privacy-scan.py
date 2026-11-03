#!/usr/bin/env python3
"""对外发布前的红线复扫：真实厂商名 / 本机路径 / 内网地址 / 密钥 / 仓库链接。

词表直接复用 desensitize.py 的 REPLACEMENTS 左值（那些就是要清掉的真实厂商名），
再叠加通用规则。扫的是「会外发或会被人看到」的全部文本：
文稿、方案、事实卡、演示素材原件（含 docx/pptx/xlsx 内文）、构建脚本、README。
"""
import importlib.util, os, re, sys, zipfile
from docx import Document
from openpyxl import load_workbook
from pptx import Presentation

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

spec = importlib.util.spec_from_file_location("dz", os.path.join(ROOT, "素材", ".tools", "desensitize.py"))
dz = importlib.util.module_from_spec(spec); spec.loader.exec_module(dz)
# 补充词：desensitize.py 里**故意不收**的高危裸串。裸串会撞普通词（「哈希」= hash 的通用译法），
# 替换阶段不敢收，只能靠复扫兜底——所以这里用带上下文的判别式，别把「文件哈希」「哈希校验」当厂商名。
EXTRA_PATTERNS: list[tuple[str, str]] = [
    (r"(?<!文件)(?<!计算)(?<!MD5 )(?<!md5 )哈希(?!值|表|校|算|函|桶|码|冲|分)", "哈希（Hach，裸串）"),
]
REAL = sorted({a for a, _ in dz.REPLACEMENTS if len(a) >= 2}, key=len, reverse=True)
print(f"词表：{len(REAL)} 个真实厂商名")

# 通用规则：本机路径 / 内网 / 密钥 / 仓库链接 / 邮箱（示例域名除外） / 手机号
GENERIC = [
    (r"/Users/[A-Za-z0-9._-]+", "本机路径"),
    (r"C:\\\\Users\\\\", "本机路径"),
    (r"\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+", "内网地址"),
    (r"\bsk-[A-Za-z0-9]{16,}", "疑似密钥"),
    (r"github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+", "仓库链接"),
    (r"\b1[3-9]\d{9}\b", "手机号"),
    (r"[A-Za-z0-9._%-]+@(?!yunshu-controls\.example)[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "非示例邮箱"),
]

def text_of(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext in (".md", ".json", ".mjs", ".js", ".py", ".txt", ".csv", ".html"):
            return open(path, encoding="utf-8", errors="ignore").read()
        if ext == ".docx":
            d = Document(path)
            s = "\n".join(p.text for p in d.paragraphs)
            for t in d.tables:
                for r in t.rows:
                    s += "\n" + " ".join(c.text for c in r.cells)
            return s
        if ext == ".xlsx":
            wb = load_workbook(path, data_only=True)
            return "\n".join(" ".join(str(c) for c in row if c is not None)
                             for ws in wb for row in ws.iter_rows(values_only=True))
        if ext == ".pptx":
            pr = Presentation(path)
            s = []
            for sl in pr.slides:
                for sh in sl.shapes:
                    if sh.has_text_frame: s.append(sh.text_frame.text)
                    if getattr(sh, "has_table", False) and sh.has_table:
                        for r in sh.table.rows: s.append(" ".join(c.text for c in r.cells))
            return "\n".join(s)
    except Exception as e:
        return f"<读不了: {e}>"
    return ""

targets = ["README.md", "00-推广方案.md", "素材/写作事实卡.md"]
for sub in ("B站", "CSDN", "素材/demo资料", "素材/.tools"):
    for dirpath, _dirs, files in os.walk(os.path.join(ROOT, sub)):
        if "/.deck-build" in dirpath or "/_probe" in dirpath: continue
        for f in files:
            if f.startswith("."): continue
            targets.append(os.path.relpath(os.path.join(dirpath, f), ROOT))

hits, scanned = [], 0
for rel in targets:
    p = os.path.join(ROOT, rel)
    if not os.path.isfile(p): continue
    t = text_of(p); scanned += 1
    for w in REAL:
        for m in re.finditer(re.escape(w), t):
            hits.append((rel, w, t[max(0, m.start()-30):m.start()+30].replace("\n", " ")))
    for pat, label in EXTRA_PATTERNS + GENERIC:
        for m in re.finditer(pat, t):
            if "yunshu-controls.example" in m.group(0): continue
            hits.append((rel, label, m.group(0)))

# 内部文档：README 已声明「不要发」，命中属设计使然
# 工具自身：词表与判别式就写在这里，扫自己必然命中（自指），与 desensitize.py 同等对待
INTERNAL = {"00-推广方案.md",
            os.path.join("素材", ".tools", "desensitize.py"),
            os.path.join("素材", ".tools", "privacy-scan.py")}
# 字体名不算厂商宣称（凡是排版都躲不开）
FONT_OK = ("微软雅黑", "Microsoft YaHei")
hits = [h for h in hits if not any(f in h[2] for f in FONT_OK)]
pub = [h for h in hits if h[0] not in INTERNAL]
inner = [h for h in hits if h[0] in INTERNAL]

print(f"扫描 {scanned} 个文件")
print(f"\n── 内部文档（README 已标「不要发」）命中 {len(inner)} 处，属设计使然")
for rel in sorted({h[0] for h in inner}):
    print(f"   {rel}  {sum(1 for h in inner if h[0] == rel)} 处")
if pub:
    print(f"\n❌ 外发文件命中 {len(pub)} 处：")
    for rel, w, ctx in pub[:40]: print(f"   {rel}  [{w}]  …{ctx}…")
    sys.exit(1)
print("\n✅ 外发文件：真实厂商名 0 命中；本机路径 / 内网 / 密钥 / 仓库链接 / 非示例邮箱 0 命中")
