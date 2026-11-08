# -*- coding: utf-8 -*-
"""尝试用 UI XML 中出现的素材名反查 SPAK 目录键（MD5 变体爆破）。"""
import json, hashlib, os

BASE = r"E:\Learn\MeProject\2026.9.10-reverse\work\2026.9.10-base-apk"
MAN = os.path.join(BASE, "05-assets", "spak-extract-manifest.json")

UI = """black.png black.cfg btn.png btn.cfg btn1.png btn1.cfg dlg.png dlg.cfg
edit.png edit.cfg icon_alert.png icon_config.png icon_file.png icon_info.png
icon_menu.png list_item.png list_item.cfg list_item_h.png list_item_h.cfg
pen.png popup.png popup.cfg sbtn.png sbtn.cfg sbtn1.png sbtn1.cfg sbtn2.png
sbtn2.cfg slider.cfg slider_shaft.png slider_thumb.png tick.png vert.cfg
vert2.cfg vert2_thumb.png vert_thumb.png""".split()
IMG = [x + ".png" for x in """about back change chat chattiny clear config detail draw
exit finish flip load menu new next prev regret remove resign rule save site
start stat view wall""".split()]
JUN = """icon.png start.png piece.png board.png label.png mark.png border.png
title.png main0.png scene.cfg main.cfg main.jpg main4 main""".split()
SG = """board.png boardx.png piece.png piecex.png word.png wordx.png border.png
borderx.png mark.png markx.png track.png trackx.png scene.cfg back.jpg help.txt
nethelp.txt sentence.txt sidedisc.png sidedlg.png sideturn.png""".split()
CFG = ["ui.xml", "font.xml", "string.xml", "path.xml", "sound.xml", "uitag.xml",
       "inputdlg.xml", "layseldlg.xml"]
ALLN = ([("ui", x) for x in UI] + [("image", x) for x in IMG] +
        [("junqi", x) for x in JUN] + [("sg", x) for x in SG] +
        [("config", x) for x in CFG] + [("font", "936.cp")])


def main():
    m = json.load(open(MAN, encoding="utf-8"))
    BY = {}
    for e in m:
        BY.setdefault(e["md5"], []).append(e)

    packs = ["", "480", "480x", "720", "720x", "720s", "800", "960", "x", "h", "s", "hd"]
    packdirs = ["", "_h", "_x", "-h", "-x"]
    hits = 0
    tried = 0
    seen = set()
    for pack in packs:
        for mod, n in ALLN:
            tails = {mod + "/" + n, n, mod + "_" + n, mod + "/" + mod + "_" + n}
            for t in tails:
                for pre in ("data/", "/data/", ""):
                    for mid in (pack + "/" if pack else ""):
                        cand = pre + mid + t
                        if cand in seen:
                            continue
                        seen.add(cand)
                        tried += 1
                        for enc in ("ascii",):
                            h = hashlib.md5(cand.encode(enc)).hexdigest()
                            if h in BY:
                                p = BY[h][0]["name"]
                                if not p.startswith("data/"):
                                    hits += 1
                                    print("MATCH %-42s -> %s (%d B)" % (cand, p, BY[h][0]["size"]))
    # 也试 pack 作为后缀
    for pack in packdirs:
        for mod, n in ALLN:
            for tail in (n, mod + "/" + n):
                base, ext = os.path.splitext(tail)
                if True:
                    cand = "data/" + base + pack + ext
                    if cand in seen:
                        continue
                    seen.add(cand)
                    tried += 1
                    h = hashlib.md5(cand.encode()).hexdigest()
                    if h in BY and not BY[h][0]["name"].startswith("data/"):
                        hits += 1
                        print("MATCH %-42s -> %s (%d B)" % (cand, BY[h][0]["name"], BY[h][0]["size"]))
    print("tried %d, hits %d" % (tried, hits))


if __name__ == "__main__":
    main()
