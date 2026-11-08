# -*- coding: utf-8 -*-
"""按棋盘几何取每个格子的中心色 & 边缘色，判定格子内容（棋子面/蓝背/空位/选中框/末步框）。
用法: python sample_cells.py <img.png>
"""
import sys
from PIL import Image
import numpy as np

COL_X = [78.5, 219.0, 359.5, 500.0, 640.5]
ROW_Y = [1056, 986, 916, 845, 774, 703, 455, 386, 314, 244, 173, 102]
SX, OX = 1.2491, 0.6
SY, OY = 1.2493, 148.6

def sxy(cx, cy):
    return int(round(SX*cx+OX)), int(round(SY*cy+OY))

def cls(rgb):
    r, g, b = rgb
    if b > 170 and r < 80 and g < 80: return "选中/末步-蓝框"
    if r > 180 and g < 80 and b < 80: return "末步-红框"
    if g > 80 and r < g-25 and b < g-40: return "空位绿块/行营"
    if r > 180 and 90 < g < 200 and b < 120: return "橙方棋子"
    if b > 120 and b > r+30 and g < b-10: return "蓝背(对方隐子)"
    if r > 200 and g > 200 and b > 200: return "白/亮"
    return f"其他{tuple(rgb)}"

def main():
    img = np.array(Image.open(sys.argv[1]).convert("RGB")).astype(int)
    print(f"### {sys.argv[1]}  shape={img.shape}")
    for ri, ay in enumerate(ROW_Y):
        line = []
        for ci, ax in enumerate(COL_X):
            x, y = sxy(ax, ay)
            # 取中心 9x9 中位数，避开文字
            patch = img[y-4:y+5, x-4:x+5].reshape(-1, 3)
            med = tuple(int(v) for v in np.median(patch, axis=0))
            # 取框线：向左 60px 处（棋子外沿）
            lx = x - 60
            left = tuple(int(v) for v in np.median(img[y-6:y+7, lx-2:lx+3].reshape(-1,3), axis=0))
            line.append(f"c{ci}:{cls(med)}|L{cls(left)}")
        print(f" r{ri:2d}(sx={sxy(COL_X[0],ay)[1]}): " + "  ".join(line))

if __name__ == "__main__":
    main()
