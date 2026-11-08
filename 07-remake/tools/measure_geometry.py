# -*- coding: utf-8 -*-
"""
精确测量棋盘元素几何（像素），用于校准 ui/geometry.ts 的单位常量。

方法：用「近黑描边」把每个格子/圆环的包围盒找出来，再除以行距换算成单位。
"""
import os

import numpy as np
from PIL import Image

IMG = r"E:\Learn\MeProject\2026.9.10-reverse\work\2026.9.10-base-apk\05-assets\resources\_unresolved\_preview\big_0_720x1071.png"

a = np.asarray(Image.open(IMG).convert("RGB")).astype(np.int16)
H, W, _ = a.shape
print(f"board {W}x{H}")


def is_dark(px):
    return px[0] < 70 and px[1] < 70 and px[2] < 70


def is_green(px):
    return px[1] > 90 and px[1] > px[0] + 25 and px[1] > px[2] + 40


def bbox(x0, y0, x1, y1, pred, minrun=3):
    """在窗口内找 pred 像素的包围盒。"""
    xs, ys = [], []
    for y in range(y0, y1):
        for x in range(x0, x1):
            if pred(a[y, x]):
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def report(name, bb, ref_pitch=None):
    if bb is None:
        print(f"  {name}: 未找到")
        return
    x0, y0, x1, y1 = bb
    w, h = x1 - x0 + 1, y1 - y0 + 1
    line = f"  {name}: x[{x0},{x1}] y[{y0},{y1}]  {w}x{h}px"
    if ref_pitch:
        line += f"  → {w/ref_pitch:.3f} x {h/ref_pitch:.3f} 单位"
    print(line)
    return w, h


# ── 1. 用「铁路黑带」定位行距 ──────────────────────────────
# 铁路行（行 1/5/6/10）上存在成片的纯黑像素，按 y 统计找出这几条黑带中心。
black_rows = [(a[y, :, 0] < 25).sum() for y in range(H)]
bands = []
y = 0
while y < H:
    if black_rows[y] > 200:
        s = y
        while y < H and black_rows[y] > 200:
            y += 1
        bands.append((s, y - 1, (s + y - 1) / 2))
    y += 1
print("\n── 铁路黑带（y 区间, 中心）──")
for s, e, c in bands:
    print(f"   y={s}-{e}  中心={c:.1f}  厚={e-s+1}px")

# 由黑带推出行距：行 10 与行 6 的中心差 = 4 行距；行 6 与行 5 = 跨方留白
if len(bands) >= 4:
    cs = [c for _, _, c in bands]
    pitch_try = (cs[1] - cs[0]) / 4.0
    print(f"\n  行10→行6 中心差 = {cs[1]-cs[0]:.1f}px  → 行距 ≈ {pitch_try:.2f}px")

# ── 2. 列中心：用纵向铁路黑带 ──────────────────────────────
black_cols = [(a[420:640, x, 0] < 25).sum() for x in range(W)]
vbands = []
x = 0
while x < W:
    if black_cols[x] > 100:
        s = x
        while x < W and black_cols[x] > 100:
            x += 1
        vbands.append(((s + x - 1) / 2, x - s))
    x += 1
print(f"\n── 纵向铁路中心（x, 厚）: {[(round(c,1),t) for c,t in vbands]}")

# ── 3. 单个兵站（左上角那枚，cols0/row11）───────────────
print("\n── 元素测量（以行距为基准）──")
pitch = pitch_try if len(bands) >= 4 else 70.7
# 兵站：在左上区域找黑框
report("兵站整体(含黑边)", bbox(30, 40, 130, 110, is_dark), pitch)
report("兵站绿环", bbox(30, 40, 130, 110, is_green), pitch)

# ── 4. 行营圆环（row9 col1 附近）────────────────────────
report("行营圆环(绿)", bbox(175, 180, 265, 255, is_green), pitch)

# ── 5. 大本营牌匾（橙色）────────────────────────────────
def is_orange(px):
    return px[0] > 190 and 120 < px[1] < 190 and px[2] < 110

report("大本营牌匾(橙)", bbox(150, 40, 290, 110, is_orange), pitch)

# ── 6. 铁路厚度 & 公路厚度 ──────────────────────────────
print("\n── 线宽 ──")
if bands:
    s, e, _ = bands[-1]
    print(f"  铁路黑带厚 ≈ {e-s+1}px → {((e-s+1)/pitch):.3f} 单位")


def is_road(px):
    # 公路：深棕，R>G>B 且亮度中等
    return px[0] > 60 and px[0] < 150 and px[0] > px[1] > px[2] and px[0] - px[2] > 30


row_y = int(cs[2]) if len(bands) >= 4 else 490
# 在两条铁路之间找一条竖公路的宽度
best = 0
for yy in range(int(cs[2]) + 20, int(cs[2]) + 60):
    run = 0
    for xx in range(60, 700):
        if is_road(a[yy, xx]):
            run += 1
        else:
            if run > best:
                best = run
            run = 0
print(f"  公路线宽 ≈ {best}px → {best/pitch:.3f} 单位")
