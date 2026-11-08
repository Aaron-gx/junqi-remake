# -*- coding: utf-8 -*-
"""
用「绿色连通块」自动检测全部 60 个格子的中心，再用最小二乘反推
originY / 行距 / 中缝留白 三个几何参数。
"""
import numpy as np
from PIL import Image

IMG = r"E:\Learn\MeProject\2026.9.10-reverse\work\2026.9.10-base-apk\05-assets\resources\_unresolved\_preview\big_0_720x1071.png"

a = np.asarray(Image.open(IMG).convert("RGB")).astype(np.int16)
H, W, _ = a.shape

# 绿色掩码（棋子格绿环 / 行营绿环 都命中）
g = (a[:, :, 1] > 95) & (a[:, :, 1] > a[:, :, 0] + 25) & (a[:, :, 1] > a[:, :, 2] + 45)

# 简单连通域（4 邻接，BFS）
lab = np.zeros((H, W), np.int32)
blobs = []
cur = 0
from collections import deque

for sy in range(H):
    for sx in range(W):
        if g[sy, sx] and lab[sy, sx] == 0:
            cur += 1
            q = deque([(sy, sx)])
            lab[sy, sx] = cur
            xs0 = xs1 = sx
            ys0 = ys1 = sy
            n = 0
            while q:
                y, x = q.popleft()
                n += 1
                if x < xs0: xs0 = x
                if x > xs1: xs1 = x
                if y < ys0: ys0 = y
                if y > ys1: ys1 = y
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < H and 0 <= nx < W and g[ny, nx] and lab[ny, nx] == 0:
                        lab[ny, nx] = cur
                        q.append((ny, nx))
            if n > 100:
                blobs.append((xs0, ys0, xs1, ys1, n, (xs0 + xs1) / 2, (ys0 + ys1) / 2))

print(f"绿色连通块 {len(blobs)} 个（预期 40 个兵站环 + 20 个行营环 = 60）")

# 行营环外接框接近正方形，兵站环是扁矩形
posts, camps = [], []
for b in blobs:
    w, h = b[2] - b[0] + 1, b[3] - b[1] + 1
    (camps if abs(w - h) <= 6 else posts).append(b)
print(f"  → 兵站(扁) {len(posts)}  行营(圆) {len(camps)}")


def cluster(vals, tol=12):
    vals = sorted(vals)
    out, group = [], [vals[0]]
    for v in vals[1:]:
        if v - group[-1] <= tol:
            group.append(v)
        else:
            out.append(sum(group) / len(group))
            group = [v]
    out.append(sum(group) / len(group))
    return out


ys = cluster([b[6] for b in posts])
xs = cluster([b[5] for b in posts])
print(f"\n行中心({len(ys)}): {[round(v,1) for v in ys]}")
print(f"列中心({len(xs)}): {[round(v,1) for v in xs]}")

# 行中心从上到下；屏幕 y 越小越靠上 = 行号越大
if len(ys) == 12:
    # 屏幕顺序 ys[0..11] 对应 row 11..0
    print("\n── 拟合 ──")
    # 建模：rowY(r) = O + (CONTENT_H - rowOffset(r)) * unit
    # 反过来：对上半区(r=6..11) 与下半区(r=0..5) 分别是线性
    lo = ys[6:12][::-1]  # row 5..0  (屏幕 y 从大到小)  -> ys[11] 最大 y = row5? 需确认
    hi = ys[0:6][::-1]   # row 11..6
    print("  下方 6 行 y(由上到下):", [round(v, 1) for v in ys[6:12]])
    print("  上方 6 行 y(由上到下):", [round(v, 1) for v in ys[0:6]])
    # 上 6 行内部间距
    up = ys[0:6]
    pit_up = np.mean(np.diff(up))
    dn = ys[6:12]
    pit_dn = np.mean(np.diff(dn))
    print(f"  行距(上) = {pit_up:.2f}px  行距(下) = {pit_dn:.2f}px")
    gap = ys[6] - ys[5]
    print(f"  中缝(行6中心 - 行5中心) = {gap:.1f}px = {gap/pit_dn:.3f} 倍行距")

# 线宽 / 元素尺寸
if posts:
    ws = [b[2] - b[0] + 1 for b in posts]
    hs = [b[3] - b[1] + 1 for b in posts]
    print(f"\n兵站绿环 宽={np.median(ws):.0f}px 高={np.median(hs):.0f}px")
if camps:
    ws = [b[2] - b[0] + 1 for b in camps]
    hs = [b[3] - b[1] + 1 for b in camps]
    print(f"行营圆 直径={np.median((np.array(ws)+np.array(hs))/2):.0f}px")
