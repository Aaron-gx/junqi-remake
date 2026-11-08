# -*- coding: utf-8 -*-
"""把所有预览图 + data 图拼成一张联络表，便于一次性浏览。"""
import os

import numpy as np
from PIL import Image, ImageDraw

ROOT = r"E:\Learn\MeProject\2026.9.10-reverse\work\2026.9.10-base-apk\05-assets\resources\_unresolved"
OUT = os.path.join(os.path.dirname(__file__), "_crops")
os.makedirs(OUT, exist_ok=True)

CELL = 220
COLS = 6
files = []
for d in ("_preview", "data"):
    p = os.path.join(ROOT, d)
    if not os.path.isdir(p):
        continue
    for f in sorted(os.listdir(p)):
        if f.lower().endswith((".png", ".jpg")) and not f.startswith("_"):
            files.append((d, f))

print(f"共 {len(files)} 张图")
rows = (len(files) + COLS - 1) // COLS
sheet = Image.new("RGB", (COLS * CELL, rows * (CELL + 16)), (255, 255, 255))
dr = ImageDraw.Draw(sheet)

for i, (d, f) in enumerate(files):
    r, c = divmod(i, COLS)
    try:
        im = Image.open(os.path.join(ROOT, d, f)).convert("RGB")
    except Exception as e:
        print("skip", f, e)
        continue
    w, h = im.size
    s = min(CELL / w, CELL / h)
    im = im.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)
    x = c * CELL + (CELL - im.size[0]) // 2
    y = r * (CELL + 16) + (CELL - im.size[1]) // 2
    sheet.paste(im, (x, y))
    dr.text((c * CELL + 3, r * (CELL + 16) + CELL + 2), f"{d[:2]}/{f[:26]}", fill=(0, 0, 0))
    print(f"  [{i:02d}] {d}/{f}  {w}x{h}")

p = os.path.join(OUT, "contact_sheet.png")
sheet.save(p)
print("->", p, sheet.size)
