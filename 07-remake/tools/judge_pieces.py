# -*- coding: utf-8 -*-
"""挑出棋子/贴图候选，拼成判定图。"""
import os, json
from PIL import Image, ImageDraw, ImageFont

BASE = r"E:\Learn\MeProject\2026.9.10-reverse\work\2026.9.10-base-apk"
RES = os.path.join(BASE, "05-assets", "resources")
CAT = os.path.join(BASE, "07-remake", "tools", "_raw", "catalog.json")
OUT = os.path.join(BASE, "07-remake", "tools", "_crops")

FONT = ImageFont.truetype(r"C:\Windows\Fonts\consola.ttf", 14)

rows = json.load(open(CAT, encoding="utf-8"))
idx = {(r["group"], r["idx"]): r for r in rows}


def load(grp, ix):
    r = idx[(grp, ix)]
    return Image.open(os.path.join(RES, r["path"].replace("/", os.sep))).convert("RGB"), r


ITEMS = [
    ("datax 174 46x46", "datax", 174, 5),
    ("datax 175 69x69", "datax", 175, 5),
    ("datax 176 46x46", "datax", 176, 5),
    ("datax 177 69x69", "datax", 177, 5),
    ("data 110 edit 38x41", "data", 110, 6),
    ("datah 167 legend", "datah", 167, 3),
    ("datax 167 legend", "datax", 167, 2),
    ("datax 250 board", "datax", 250, 1),
]

PAD = 8
LBL = 20
# 计算画布
tiles = []
for tag, grp, ix, sc in ITEMS:
    im, r = load(grp, ix)
    w, h = im.size
    im2 = im.resize((w * sc, h * sc), Image.NEAREST)
    tiles.append((tag + "  %dx%d" % (w, h), im2))

cols = 2
cellw = max(t[1].size[0] for t in tiles) + PAD * 2
cellh = max(t[1].size[1] for t in tiles) + PAD * 2 + LBL
nrow = (len(tiles) + cols - 1) // cols
sheet = Image.new("RGB", (cellw * cols, cellh * nrow), (28, 28, 32))
dr = ImageDraw.Draw(sheet)
for i, (tag, im) in enumerate(tiles):
    cx = (i % cols) * cellw
    cy = (i // cols) * cellh
    dr.text((cx + PAD, cy + 2), tag, fill=(255, 220, 100), font=FONT)
    sheet.paste(im, (cx + PAD, cy + LBL))

# 棋盘局部：行 5 列 0 的兵站
board, _ = load("datax", 250)
crop = board.crop((78 - 70, 638 - 50, 78 + 70, 638 + 50)).resize((140 * 4, 100 * 4), Image.LANCZOS)
sheet2 = Image.new("RGB", (sheet.size[0], sheet.size[1] + crop.size[1] + 24), (28, 28, 32))
sheet2.paste(sheet, (0, 0))
dr2 = ImageDraw.Draw(sheet2)
dr2.text((PAD, sheet.size[1] + 2), "datax 250 board cell(5,0) 4x", fill=(120, 255, 160), font=FONT)
sheet2.paste(crop, (PAD, sheet.size[1] + 22))
sheet2.save(os.path.join(OUT, "pieces_judge.png"))
print("saved", sheet2.size)
