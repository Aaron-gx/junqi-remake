# -*- coding: utf-8 -*-
"""测量棋盘位图的格心网格（列心 / 行心 / 格距），用于锁定几何与棋子尺寸。"""
import os, json
import numpy as np
from PIL import Image

BASE = r"E:\Learn\MeProject\2026.9.10-reverse\work\2026.9.10-base-apk"
CAT = os.path.join(BASE, "07-remake", "tools", "_raw", "catalog.json")
RES = os.path.join(BASE, "05-assets", "resources")

TARGETS = [
    ("board_h156_480x725", "datah", 156),
    ("board_x156_720x1160", "datax", 156),
    ("board_x250_720x1071", "datax", 250),
    ("board_h249_480x779", "datah", 249),
    ("sg_x173_1100x1121", "datax", 173),
]


def find(group, idx):
    rows = json.load(open(CAT, encoding="utf-8"))
    for r in rows:
        if r["group"] == group and r["idx"] == idx:
            return os.path.join(RES, r["path"].replace("/", os.sep)), r
    return None, None


def blobs(a, mask):
    """返回二值掩码里所有连通块的包围盒（4 邻域，迭代实现）。"""
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32)
    boxes = []
    cur = 0
    ys, xs = np.where(mask)
    for y0, x0 in zip(ys, xs):
        if lab[y0, x0]:
            continue
        cur += 1
        stack = [(y0, x0)]
        lab[y0, x0] = cur
        miny = maxy = y0
        minx = maxx = x0
        n = 0
        while stack:
            y, x = stack.pop()
            n += 1
            if y < miny: miny = y
            if y > maxy: maxy = y
            if x < minx: minx = x
            if x > maxx: maxx = x
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not lab[ny, nx]:
                    lab[ny, nx] = cur
                    stack.append((ny, nx))
        boxes.append((minx, miny, maxx, maxy, n))
    return boxes


def analyze(tag, path):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.int16)
    W, H = im.size
    # 亮绿描边（兵站/行营环）：G 明显高、R 低、B 低
    g = (a[:, :, 1] - a[:, :, 0] > 45) & (a[:, :, 1] - a[:, :, 2] > 60) & (a[:, :, 1] > 80)
    boxes = [b for b in blobs(a, g) if b[4] > 40]
    wide = [b for b in boxes if (b[2] - b[0]) > (b[3] - b[1])]
    round_ = [b for b in boxes if abs((b[2] - b[0]) - (b[3] - b[1])) <= 6]
    print("\n=== %s  %s  %dx%d ===" % (tag, os.path.basename(path), W, H))
    print("  亮绿连通块: %d (矩形兵站 %d, 近圆行营 %d)" % (len(boxes), len(wide), len(round_)))
    if wide:
        ws = [b[2] - b[0] + 1 for b in wide]
        hs = [b[3] - b[1] + 1 for b in wide]
        print("  兵站尺寸: %dx%d (中位 %dx%d)" % (min(ws), min(hs), int(np.median(ws)), int(np.median(hs))))
    if round_:
        ds = [b[2] - b[0] + 1 for b in round_]
        print("  行营直径: %d..%d (中位 %d)" % (min(ds), max(ds), int(np.median(ds))))
    # 列心：矩形兵站中心 x 聚类
    cxs = sorted((b[0] + b[2]) / 2 for b in wide)
    groups = []
    for x in cxs:
        if groups and x - groups[-1][-1] < 40:
            groups[-1].append(x)
        else:
            groups.append([x])
    cols = [float(np.mean(gp)) for gp in groups]
    print("  列心 x: " + ", ".join("%.1f" % c for c in cols))
    if len(cols) > 1:
        print("  列距: %.2f" % ((cols[-1] - cols[0]) / (len(cols) - 1)))
    cys = sorted((b[1] + b[3]) / 2 for b in boxes if b[4] > 40)
    groups = []
    for y in cys:
        if groups and y - groups[-1][-1] < 25:
            groups[-1].append(y)
        else:
            groups.append([y])
    rows = [float(np.mean(gp)) for gp in groups]
    print("  行心 y: " + ", ".join("%.1f" % r for r in rows))
    if len(rows) > 2:
        d = [rows[i + 1] - rows[i] for i in range(len(rows) - 1)]
        print("  相邻行距: " + ", ".join("%.1f" % x for x in d))
        print("  最大行距(中缝): %.1f" % max(d))


for tag, grp, ix in TARGETS:
    p, r = find(grp, ix)
    if p:
        analyze(tag, p)
    else:
        print("not found", tag, grp, ix)
