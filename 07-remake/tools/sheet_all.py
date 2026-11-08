# -*- coding: utf-8 -*-
"""把全部解包图片做成带标签的联络表，便于人工识别素材真名。"""
import os, sys, glob, json, hashlib, struct
from PIL import Image, ImageDraw, ImageFont

ROOT = r"E:\Learn\MeProject\2026.9.10-reverse\work\2026.9.10-base-apk"
RES = os.path.join(ROOT, "05-assets", "resources")
OUT = os.path.join(ROOT, "07-remake", "tools", "_crops")
os.makedirs(OUT, exist_ok=True)

FONT = None
for cand in [
    r"C:\Windows\Fonts\consola.ttf",
    r"C:\Windows\Fonts\segoeui.ttf",
    r"C:\Windows\Fonts\simhei.ttf",
]:
    if os.path.exists(cand):
        try:
            FONT = ImageFont.truetype(cand, 13)
            break
        except Exception:
            pass
if FONT is None:
    FONT = ImageFont.load_default()


def png_info(p):
    b = open(p, "rb").read(33)
    if b[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    w, h = struct.unpack(">II", b[16:24])
    return w, h


def collect():
    out = []
    for sub in ("data", "datah", "datax"):
        d = os.path.join(RES, "_unresolved", sub)
        for p in sorted(glob.glob(os.path.join(d, "*"))):
            if not os.path.isfile(p):
                continue
            b = open(p, "rb").read()
            if b[:8] == b"\x89PNG\r\n\x1a\n":
                out.append(("png", p, b))
            elif b[:3] == b"\xff\xd8\xff":
                out.append(("jpg", p, b))
    for p in sorted(glob.glob(os.path.join(RES, "data", "**", "*"), recursive=True)):
        if os.path.isfile(p):
            b = open(p, "rb").read()
            if b[:8] == b"\x89PNG\r\n\x1a\n":
                out.append(("png", p, b))
            elif b[:3] == b"\xff\xd8\xff":
                out.append(("jpg", p, b))
    return out


def main():
    items = collect()
    # 去重：内容相同只留一个（保留 data 组优先）
    seen = {}
    uniq = []
    for kind, p, b in items:
        h = hashlib.md5(b).hexdigest()
        if h in seen:
            seen[h].append(p)
            continue
        seen[h] = [p]
        uniq.append((kind, p, b, h))
    print(f"图片总数 {len(items)}  去重后 {len(uniq)}")

    COLS = 6
    TW, TH = 200, 190
    per_sheet = COLS * 5
    sheets = (len(uniq) + per_sheet - 1) // per_sheet
    idx = 0
    for s in range(sheets):
        rows = min(5, (len(uniq) - idx + COLS - 1) // COLS)
        sheet = Image.new("RGB", (COLS * TW + 8, rows * TH + 8), (32, 32, 36))
        dr = ImageDraw.Draw(sheet)
        for r in range(rows):
            for c in range(COLS):
                if idx >= len(uniq):
                    break
                kind, p, b, h = uniq[idx]
                tag = os.path.basename(os.path.dirname(p)) + "/" + h[:8]
                box_x = 4 + c * TW
                box_y = 4 + r * TH
                try:
                    im = Image.open(p).convert("RGB")
                    w, h2 = im.size
                    sc = min((TW - 12) / max(1, w), (TH - 52) / max(1, h2), 1.0)
                    if sc < 1.0:
                        im = im.resize((max(1, int(w * sc)), max(1, int(h2 * sc))), Image.NEAREST)
                    sheet.paste(im, (box_x + 6, box_y + 34))
                    dr.text((box_x + 6, box_y + 6), f"#{idx} {tag}", fill=(255, 230, 120), font=FONT)
                    dr.text((box_x + 6, box_y + 19), f"{w}x{h2} {len(b)}B", fill=(160, 200, 255), font=FONT)
                except Exception as e:
                    dr.text((box_x + 6, box_y + 34), f"ERR {e}", fill=(255, 120, 120), font=FONT)
                idx += 1
        fp = os.path.join(OUT, f"all_{s}.png")
        sheet.save(fp)
        print("saved", fp, sheet.size)


if __name__ == "__main__":
    main()
