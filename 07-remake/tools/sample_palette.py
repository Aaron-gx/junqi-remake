# -*- coding: utf-8 -*-
"""
从原版棋盘底图 big_0_720x1071.png 中提取配色。

思路：不靠"猜某个像素点"，而是
  1. 对整图做颜色直方图，取出现频率最高的若干色作为主色调候选；
  2. 在若干"应当是什么颜色"的语义区域取小块均值（去噪），交叉印证；
  3. 输出一张量化后的调色板，供 Canvas 渲染器使用。
"""
import os
from collections import Counter

import numpy as np
from PIL import Image

ROOT = r"E:\Learn\MeProject\2026.9.10-reverse\work\2026.9.10-base-apk\05-assets\resources\_unresolved\_preview"
IMG = os.path.join(ROOT, "big_0_720x1071.png")


def hexs(rgb):
    return "#%02X%02X%02X" % (int(rgb[0]), int(rgb[1]), int(rgb[2]))


def patch_mean(im, cx, cy, half=3):
    a = np.asarray(im).astype(np.float64)
    x0, x1 = max(0, cx - half), min(a.shape[1], cx + half + 1)
    y0, y1 = max(0, cy - half), min(a.shape[0], cy + half + 1)
    blk = a[y0:y1, x0:x1, :3].reshape(-1, 3)
    return blk.mean(axis=0)


def main():
    im = Image.open(IMG).convert("RGB")
    W, H = im.size
    print(f"image: {IMG}\nsize: {W}x{H}\n")

    a = np.asarray(im).astype(np.uint8)[:, :, :3]

    # ── 1. 全局直方图（量化到 8 级，合并相近色）─────────────────
    q = (a // 8) * 8
    flat = q.reshape(-1, 3)
    cnt = Counter(map(tuple, flat))
    print("── 出现频率最高的 20 种颜色（8 级量化）──")
    total = flat.shape[0]
    for rgb, n in cnt.most_common(20):
        print(f"  {hexs(rgb)}  {n:>8}  {100.0*n/total:5.2f}%")

    # ── 2. 语义区域取样 ────────────────────────────────────────
    # 依据 geometry：列间距 140.5，行间距 70.7，行 0 在底部。
    # 底图内容原点约 x=35, y=25（预留 8px 边）。
    print("\n── 语义区域取样 ──")

    regions = {
        "木质背景(棋盘外)": (12, 12),
        "木质背景(两方中间留白)": (360, int(25 + 5 * 70.7 + 35)),
    }
    for name, (x, y) in regions.items():
        m = patch_mean(im, x, y, 4)
        print(f"  {name:<24} ({x:>3},{y:>4}) = {hexs(m)}  {m.round(1)}")

    # 网格线 & 单元格：扫描一行/一列，输出色彩分段
    print("\n── 水平扫描 y=147（第 1 行铁路线所在行）──")
    row = a[147]
    prev = None
    run = 0
    for x in range(W):
        c = tuple((row[x] // 16) * 16)
        if c == prev:
            run += 1
            continue
        if prev is not None and run >= 3:
            print(f"    x={x-run:>3}-{x-1:>3} ({run:>3}px) {hexs(prev)}")
        prev = c
        run = 1
    if run >= 3:
        print(f"    x={W-run:>3}-{W-1:>3} ({run:>3}px) {hexs(prev)}")

    print("\n── 垂直扫描 x=77（第 0 列，穿一个行营与多格兵站）──")
    col = a[:, 77]
    prev = None
    run = 0
    for y in range(H):
        c = tuple((col[y] // 16) * 16)
        if c == prev:
            run += 1
            continue
        if prev is not None and run >= 3:
            print(f"    y={y-run:>4}-{y-1:>4} ({run:>3}px) {hexs(prev)}")
        prev = c
        run = 1
    if run >= 3:
        print(f"    y={H-run:>4}-{H-1:>4} ({run:>3}px) {hexs(prev)}")


if __name__ == "__main__":
    main()
