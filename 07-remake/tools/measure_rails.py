# -*- coding: utf-8 -*-
"""
精确测量三条纵向铁路的实际行范围。

方法：在每条纵向铁路的 x 上，逐 y 统计「近黑像素」数量；
有铁路带的行会连续出现 ~10px 宽的黑，据此得出铁路的行区间。
"""
import os

import numpy as np
from PIL import Image

IMG = r"E:\Learn\MeProject\2026.9.10-reverse\work\2026.9.10-base-apk\05-assets\resources\_unresolved\_preview\big_0_720x1071.png"

a = np.asarray(Image.open(IMG).convert("RGB")).astype(np.int16)
H, W, _ = a.shape

# 行中心（detect_cells 实测）
ROW_Y = [77.0, 148.0, 219.0, 289.5, 360.5, 430.7, 638.3, 708.5, 779.5, 850.0, 921.0, 992.0]
row_index = {11: 77.0, 10: 148.0, 9: 219.0, 8: 289.5, 7: 360.5, 6: 430.7,
             5: 638.3, 4: 708.5, 3: 779.5, 2: 850.0, 1: 921.0, 0: 992.0}

COLS = {0: 78.0, 1: 219.5, 2: 359.5, 3: 499.8, 4: 641.0}


def rail_rows_at(xc):
    """在 x∈[xc-4, xc+4] 内统计黑色像素，返回每 y 的黑像素数。"""
    x0, x1 = int(xc - 5), int(xc + 6)
    seg = a[:, x0:x1]
    dark = ((seg[:, :, 0] < 60) & (seg[:, :, 1] < 60) & (seg[:, :, 2] < 60)).sum(axis=1)
    return dark


print("每条纵向铁路上的黑色像素分布（只列 dark>=6 的 y 区间）\n")
for c, xc in COLS.items():
    dark = rail_rows_at(xc)
    bands = []
    y = 0
    while y < H:
        if dark[y] >= 6:
            s = y
            while y < H and dark[y] >= 6:
                y += 1
            bands.append((s, y - 1))
        y += 1
    # 合并间隔 <12px 的碎段
    merged = []
    for b in bands:
        if merged and b[0] - merged[-1][1] <= 12:
            merged[-1] = (merged[-1][0], b[1])
        else:
            merged.append(list(b))
    print(f"列 {c} (x={xc}):")
    for s, e in merged:
        if e - s < 3:
            continue
        # 该带最接近哪一行
        mid = (s + e) / 2
        near = min(row_index.items(), key=lambda kv: abs(kv[1] - mid))
        print(f"    y={s:>4}-{e:>4} (厚{e-s+1:>3}px, 中心{mid:6.1f}) ≈ 行{near[0]}")
    print()

print("\n各列在「行中心 ±20px」内的黑像素均值（判断该行是否有铁路带）：")
print("行\\列 " + "".join(f"{c:>8}" for c in COLS))
for r in range(11, -1, -1):
    yc = row_index[r]
    rowtxt = f"行{r:>2} "
    for c, xc in COLS.items():
        x0, x1 = int(xc - 5), int(xc + 6)
        seg = a[int(yc - 14):int(yc + 15), x0:x1]
        dark = ((seg[:, :, 0] < 60) & (seg[:, :, 1] < 60) & (seg[:, :, 2] < 60)).mean()
        rowtxt += f"{dark:8.2f}"
    print(rowtxt)
