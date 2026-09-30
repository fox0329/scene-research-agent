#!/usr/bin/env python3
"""图片型（扫描）PDF / 图片的文字识别 —— macOS Vision（系统「实况文本」引擎）。

用法: scripts/.venv-ocr/bin/python scripts/ocr_pdf.py <文件> [更多文件...]
输出: JSON —— { "<文件路径>": {"text": "...", "pages": N}, ... }
依赖: 由 scripts/setup-ocr.sh 创建的 scripts/.venv-ocr（pyobjc：Quartz + Vision）。
"""

import json
import sys

import Quartz
import Vision


def ocr_cgimage(img):
    """对一张 CGImage 做 Vision 文字识别，按版面顺序（先上后下、先左后右）拼行。"""
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(img, None)
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    try:
        request.setRecognitionLanguages_(["zh-Hans", "en-US"])
    except Exception:
        pass  # 系统版本差异：不支持语言指定则用默认
    handler.performRequests_error_([request], None)
    observations = []
    for obs in request.results() or []:
        candidates = obs.topCandidates_(1)
        if candidates and len(candidates) > 0:
            box = obs.boundingBox()
            observations.append((box.origin.y, box.origin.x, str(candidates[0].string())))
    observations.sort(key=lambda t: (-round(t[0], 1), t[1]))
    return "\n".join(line for _, _, line in observations)


def render_pdf_page(page, scale=2.0):
    """把 PDF 页渲染为位图（2 倍缩放保识别率）。"""
    rect = Quartz.CGPDFPageGetBoxRect(page, Quartz.kCGPDFMediaBox)
    w = max(1, int(rect.size.width * scale))
    h = max(1, int(rect.size.height * scale))
    cs = Quartz.CGColorSpaceCreateDeviceRGB()
    ctx = Quartz.CGBitmapContextCreate(
        None, w, h, 8, 0, cs, Quartz.kCGImageAlphaPremultipliedLast
    )
    Quartz.CGContextSetRGBFillColor(ctx, 1, 1, 1, 1)
    Quartz.CGContextFillRect(ctx, Quartz.CGRectMake(0, 0, w, h))
    Quartz.CGContextScaleCTM(ctx, scale, scale)
    Quartz.CGContextTranslateCTM(ctx, -rect.origin.x, -rect.origin.y)
    Quartz.CGContextDrawPDFPage(ctx, page)
    return Quartz.CGBitmapContextCreateImage(ctx)


def file_url(path):
    data = path.encode("utf-8")
    return Quartz.CFURLCreateFromFileSystemRepresentation(None, data, len(data), False)


def ocr_pdf(path):
    doc = Quartz.CGPDFDocumentCreateWithURL(file_url(path))
    if doc is None:
        raise RuntimeError("无法打开 PDF")
    total = Quartz.CGPDFDocumentGetNumberOfPages(doc)
    parts = []
    # 上限 40 页：扫描件识别耗时按页线性增长，超长文档截断保时延
    for i in range(1, min(total, 40) + 1):
        page = Quartz.CGPDFDocumentGetPage(doc, i)
        text = ocr_cgimage(render_pdf_page(page))
        parts.append(f"【第 {i} 页】\n{text}")
    return {"text": "\n\n".join(parts), "pages": total}


def ocr_image(path):
    src = Quartz.CGImageSourceCreateWithURL(file_url(path), None)
    if src is None:
        raise RuntimeError("无法打开图片")
    img = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)
    return {"text": ocr_cgimage(img), "pages": 1}


def main():
    out = {}
    for path in sys.argv[1:]:
        try:
            out[path] = (
                ocr_pdf(path) if path.lower().endswith(".pdf") else ocr_image(path)
            )
        except Exception as e:  # 单文件失败不中断批处理
            out[path] = {"text": "", "pages": 0, "error": str(e)}
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
