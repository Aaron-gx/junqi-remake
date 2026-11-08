# -*- coding: utf-8 -*-
"""把复刻版渲染结果与原版底图并排对比（等比缩放）。"""
import os

import numpy as np
from PIL import Image

HERE = os.path.dirname(__file__)
SHOT = os.path.join(HERE, "_shots", "board2.png")
ORIG = r"E:\Learn\MeProject\2026.9.10-reverse\work\2026.9.10-base-apk\05-assets\resources\_unresolved\_preview\big_0_720x1071.png"
OUT = os.path.join(HERE, "_crops")
os.makedirs(OUT, exist_ok=True)

shot = Image.open(SHOT).convert("RGB")
a = np.asarray(shot).astype(np.int16)
H, W, _ = a.shape
print("shot", W, "x", H)

# 精确匹配棋盘外框色 #48381F = (72,56,31)，并限定在左侧棋盘区、顶栏之下
fr = (
    (np.abs(a[:, :, 0] - 72) < 22)
    & (np.abs(a[:, :, 1] - 56) < 22)
    & (np.abs(a[:, :, 2] - 31) < 22)
)
fr[:110, :] = False  # 排除顶栏
fr[:, W * 3 // 4 :] = False  # 排除右侧栏
ys, xs = np.where(fr)
if len(xs) < 100:
    raise SystemExit("未找到外框，请检查截图")
x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
print(f"board bbox in shot: x[{x0},{x1}] y[{y0},{y1}]  {x1-x0+1}x{y1-y0+1}  ratio={(x1-x0+1)/(y1-y0+1):.3f}")

rep = shot.crop((x0, y0, x1 + 1, y1 + 1))
orig = Image.open(ORIG).convert("RGB")

TARGET_H = 900
rep2 = rep.resize((int(rep.size[0] * TARGET_H / rep.size[1]), TARGET_H), Image.LANCZOS)
orig2 = orig.resize((int(orig.size[0] * TARGET_H / orig.size[1]), TARGET_H), Image.LANCZOS)

gap = 24
sheet = Image.new("RGB", (rep2.size[0] + orig2.size[0] + gap, TARGET_H + 26), (255, 255, 255))
sheet.paste(orig2, (0, 26))
sheet.paste(rep2, (orig2.size[0] + gap, 26))

from PIL import ImageDraw

dr = ImageDraw.Draw(sheet)
dr.text((6, 7), "ORIGINAL (big_0_720x1071.png)", fill=(0, 0, 0))
dr.text((orig2.size[0] + gap + 6, 7), "REMAKE (canvas)", fill=(0, 0, 0))
p = os.path.join(OUT, "compare.png")
sheet.save(p)
print("->", p, sheet.size)

# 另存复刻版单独一张，便于细看
rep2.save(os.path.join(OUT, "remake_only.png"))
print("-> remake_only.png", rep2.size)
