# -*- coding: utf-8 -*-
"""放大对比"中列行营"区域（该格恰好压在纵向铁路上）。"""
import os

import numpy as np
from PIL import Image

HERE = os.path.dirname(__file__)
SHOT = os.path.join(HERE, "_shots", "board2.png")
ORIG = r"E:\Learn\MeProject\2026.9.10-reverse\work\2026.9.10-base-apk\05-assets\resources\_unresolved\_preview\big_0_720x1071.png"
OUT = os.path.join(HERE, "_crops")

orig = Image.open(ORIG).convert("RGB")
# 原版：中列 x 359.5，行 8 的 y ≈ 219 + 3*70.74 ≈ 431?  取行 7~9 覆盖
o = orig.crop((300, 180, 420, 320)).resize((360, 420), Image.NEAREST)
o.save(os.path.join(OUT, "cmp_camp_orig.png"))
print("orig crop ->", o.size)

shot = Image.open(SHOT).convert("RGB")
a = np.asarray(shot).astype(np.int16)
fr = (
    (np.abs(a[:, :, 0] - 72) < 22)
    & (np.abs(a[:, :, 1] - 56) < 22)
    & (np.abs(a[:, :, 2] - 31) < 22)
)
fr[:110, :] = False
fr[:, 1770:] = False
ys, xs = np.where(fr)
x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
bw, bh = x1 - x0 + 1, y1 - y0 + 1
print("shot board", x0, y0, bw, bh)

# 复刻版中列行营：相对坐标
# PAD=1.1u, 内容宽 = 8u, 列2中心相对内容左缘 = 4u
unit = bw / 10.2
cx = x0 + (1.1 + 4) * unit
# 行 8 的屏幕位置：top = 行11 → 距离顶部 3 行距 = 3u
cy = y0 + (1.1 + 3) * unit
s = shot.crop((int(cx - 1.2 * unit), int(cy - 1.8 * unit), int(cx + 1.2 * unit), int(cy + 1.2 * unit)))
s = s.resize((360, int(360 * s.size[1] / s.size[0])), Image.NEAREST)
s.save(os.path.join(OUT, "cmp_camp_remake.png"))
print("remake crop ->", s.size)
