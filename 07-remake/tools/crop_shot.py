# -*- coding: utf-8 -*-
"""放大渲染结果的局部，与原版同区域并排对比。"""
import os

from PIL import Image

SHOT = os.path.join(os.path.dirname(__file__), "_shots", "board.png")
ORIG = r"E:\Learn\MeProject\2026.9.10-reverse\work\2026.9.10-base-apk\05-assets\resources\_unresolved\_preview\big_0_720x1071.png"
OUT = os.path.join(os.path.dirname(__file__), "_crops")

shot = Image.open(SHOT).convert("RGB")
print("shot", shot.size)

# 截图里棋盘所在区域（目测）：x 330..1300, y 120..1680（2x DSF）
# 先自动定位棋盘外框：找最外侧的深棕像素
import numpy as np

a = np.asarray(shot).astype(np.int16)


def is_frame(px):
    return px[0] < 100 and px[1] < 90 and px[2] < 70


xs = np.where([is_frame(a[y, x]) for y in range(200, 1600, 7) for x in range(200, 1400, 7)])[0]
cols = [x * 7 + 200 for x in xs]
rows = [x * 7 + 200 for x in xs]
print("frame x range", min(cols), max(cols))

# 直接裁剪棋盘左上 1/3 区域放大
box = (300, 100, 800, 560)
crop = shot.crop(box)
crop = crop.resize((crop.size[0] * 2, crop.size[1] * 2), Image.LANCZOS)
crop.save(os.path.join(OUT, "r_top_left.png"))
print("->", os.path.join(OUT, "r_top_left.png"), crop.size)

box2 = (280, 850, 1080, 1250)
crop2 = shot.crop(box2)
crop2.save(os.path.join(OUT, "r_mid.png"))
print("->", os.path.join(OUT, "r_mid.png"), crop2.size)

box3 = (280, 1250, 1080, 1720)
crop3 = shot.crop(box3)
crop3.save(os.path.join(OUT, "r_bottom.png"))
print("->", os.path.join(OUT, "r_bottom.png"), crop3.size)
