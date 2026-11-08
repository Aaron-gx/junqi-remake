# -*- coding: utf-8 -*-
"""把高亮标记按连通域分离，输出每个标记的 bbox / 主色 / 边框色。
用法: python cc_markers.py <img.png> [more.png ...]
"""
import sys
from PIL import Image
import numpy as np

def load(p):
    return np.array(Image.open(p).convert("RGB")).astype(int)

# 简易 4-邻域连通域（纯 numpy + 栈），图不大(1600x900)够用
def components(mask):
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32)
    cur = 0
    comps = []
    ys, xs = np.where(mask)
    for sy, sx in zip(ys, xs):
        if lab[sy, sx]:
            continue
        cur += 1
        stack = [(sy, sx)]
        lab[sy, sx] = cur
        pts = []
        while stack:
            y, x = stack.pop()
            pts.append((y, x))
            for dy, dx in ((1,0),(-1,0),(0,1),(0,-1)):
                ny, nx = y+dy, x+dx
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not lab[ny, nx]:
                    lab[ny, nx] = cur
                    stack.append((ny, nx))
        if len(pts) > 150:  # 过滤噪点
            comps.append(pts)
    comps.sort(key=len, reverse=True)
    return comps

def describe(img, pts, name):
    ys = [p[0] for p in pts]; xs = [p[1] for p in pts]
    y0, y1, x0, x1 = min(ys), max(ys), min(xs), max(xs)
    # 主色（取该域内的众数颜色）
    sub = np.array([img[y, x] for y, x in pts])
    uniq, cnt = np.unique(sub, axis=0, return_counts=True)
    top = uniq[cnt.argsort()[::-1][:3]]
    print(f"  [{name}] n={len(pts)} bbox x[{x0},{x1}] y[{y0},{y1}] "
          f"w={x1-x0+1} h={y1-y0+1} 主色={[tuple(int(v) for v in t) for t in top]}")

def masks(img):
    R, G, B = img[:, :, 0], img[:, :, 1], img[:, :, 2]
    pure_blue = (B > 170) & (R < 80) & (G < 80)
    pure_red = (R > 180) & (G < 80) & (B < 80)
    # 暗绿（棋盘树林绿 112,156,0 类）
    darkgreen = (G > 80) & (G < 190) & (R < G - 25) & (B < G - 40)
    return {"纯蓝(选中框)": pure_blue, "纯红(末步框)": pure_red, "暗绿(空位/行营)": darkgreen}

for p in sys.argv[1:]:
    img = load(p)
    print(f"\n########## {p} ##########")
    for name, m in masks(img).items():
        comps = components(m)
        print(f" -- {name}: {len(comps)} 个连通域")
        for i, c in enumerate(comps[:8]):
            describe(img, c, f"{name}#{i}")
