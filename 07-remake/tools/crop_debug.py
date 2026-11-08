# -*- coding: utf-8 -*-
"""裁剪关键区域并放大，用于精确确认配色与几何。"""
import os
from collections import Counter

import numpy as np
from PIL import Image

ROOT = r"E:\Learn\MeProject\2026.9.10-reverse\work\2026.9.10-base-apk\05-assets\resources\_unresolved\_preview"
IMG = os.path.join(ROOT, "big_0_720x1071.png")
OUT = os.path.join(os.path.dirname(__file__), "_crops")
os.makedirs(OUT, exist_ok=True)


def hexs(rgb):
    return "#%02X%02X%02X" % tuple(int(v) for v in rgb)


def dom(im, k=8):
    a = np.asarray(im.convert("RGB")).reshape(-1, 3)
    q = (a // 8) * 8
    c = Counter(map(tuple, q))
    return [(hexs(rgb), n, 100.0 * n / len(a)) for rgb, n in c.most_common(k)]


def crop(name, box, scale=6):
    im = Image.open(IMG).convert("RGB").crop(box)
    print(f"\n=== {name}  box={box}  {im.size[0]}x{im.size[1]} ===")
    for h, n, p in dom(im, 8):
        print(f"   {h}  {p:5.1f}%")
    big = im.resize((im.size[0] * scale, im.size[1] * scale), Image.NEAREST)
    p = os.path.join(OUT, name + ".png")
    big.save(p)
    print(f"   -> {p}")


crop("01_post_single", (36, 48, 118, 100), 8)
crop("02_base_row_top", (10, 40, 710, 110), 2)
crop("03_base_row_bottom", (10, 960, 710, 1045), 2)
crop("04_camp_ring", (178, 180, 262, 252), 8)
crop("05_rail_seg", (100, 124, 270, 156), 6)
crop("06_diag_roads", (60, 200, 400, 380), 3)
crop("07_mid_gap", (60, 420, 660, 640), 1)
crop("08_frame_corner", (0, 0, 90, 90), 6)
