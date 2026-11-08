# -*- coding: utf-8 -*-
"""分析原版高亮标记：选中(蓝框) / 最后一步(红框) / 空位(绿块) 的精确颜色与几何。
用法: python analyze_markers.py <s18.png> <s19.png>
"""
import sys, os
from PIL import Image
import numpy as np

def load(p):
    return np.array(Image.open(p).convert("RGB")).astype(int)

def profile_row(img, y, x0, x1, label=""):
    row = img[y, x0:x1]
    # 找非背景色（背景=浅棕木纹，R>G>B 且整体偏亮）
    print(f"  y={y} x[{x0},{x1}) {label}: 前 20 列样本")
    for i in range(0, min(20, len(row))):
        r, g, b = row[i]
        print(f"    x={x0+i}: ({r},{g},{b})")

def scan_region(img, y0, y1, x0, x1, name):
    sub = img[y0:y1, x0:x1]
    print(f"\n=== {name}  region y[{y0},{y1}) x[{x0},{x1}) ===")
    # 统计最饱和 / 最典型的颜色
    flat = sub.reshape(-1, 3)
    # 蓝：B 远大于 R,G
    blue = ((flat[:, 2] > 150) & (flat[:, 0] < 90) & (flat[:, 1] < 90)).sum()
    # 红：R 远大于 G,B
    red = ((flat[:, 0] > 180) & (flat[:, 1] < 80) & (flat[:, 2] < 80)).sum()
    # 绿：G 明显最大
    green = ((flat[:, 1] > 90) & (flat[:, 0] < flat[:, 1] - 20) & (flat[:, 2] < flat[:, 1] - 20)).sum()
    print(f"  blue_px={blue} red_px={red} green_px={green}")

def main():
    a = load(sys.argv[1]); b = load(sys.argv[2])
    print("shape", a.shape, b.shape)
    # 已知：下半棋盘行中心（屏幕坐标）。s18 选中 "连长" 在屏幕约 y=658 附近 x=166
    # 先扫描 s18 中蓝色像素的分布
    def blue_mask(img):
        return (img[:, :, 2] > 150) & (img[:, :, 0] < 90) & (img[:, :, 1] < 90)
    def red_mask(img):
        return (img[:, :, 0] > 180) & (img[:, :, 1] < 80) & (img[:, :, 2] < 80)

    bm = blue_mask(a)
    ys, xs = np.where(bm)
    if len(xs):
        print(f"\ns18 蓝色像素: n={len(xs)}  x[{xs.min()},{xs.max()}] y[{ys.min()},{ys.max()}]")
        # 直方图聚类
        import collections
        print("  x 分布:", sorted(collections.Counter((xs//20*20).tolist()).items()))
        print("  y 分布:", sorted(collections.Counter((ys//20*20).tolist()).items()))
    rmm = red_mask(a)
    ys2, xs2 = np.where(rmm)
    print(f"s18 红色像素: n={len(xs2)}")

    bm2 = blue_mask(b); rm2 = red_mask(b)
    ys3, xs3 = np.where(bm2)
    print(f"\ns19 蓝色像素: n={len(xs3)}")
    if len(xs3):
        import collections
        print("  x 分布:", sorted(collections.Counter((xs3//20*20).tolist()).items()))
        print("  y 分布:", sorted(collections.Counter((ys3//20*20).tolist()).items()))
    ys4, xs4 = np.where(rm2)
    print(f"s19 红色像素: n={len(xs4)}")
    if len(xs4):
        import collections
        print("  x 分布:", sorted(collections.Counter((xs4//20*20).tolist()).items()))
        print("  y 分布:", sorted(collections.Counter((ys4//20*20).tolist()).items()))

if __name__ == "__main__":
    main()
