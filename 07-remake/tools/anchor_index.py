# -*- coding: utf-8 -*-
"""用已知资源路径（name-recovery.md + UI XML 引用）对 data 组索引做锚点对齐，
   并推断未知条目的路径。"""
import json, hashlib, os, re

BASE = r"E:\Learn\MeProject\2026.9.10-reverse\work\2026.9.10-base-apk"
MAN = os.path.join(BASE, "05-assets", "spak-extract-manifest.json")
REC = os.path.join(BASE, "05-assets", "name-recovery.md")


def known_paths():
    txt = open(REC, encoding="utf-8").read()
    out = [l.strip()[3:-1] for l in txt.splitlines() if l.strip().startswith("- `")]
    # 手工补充：.so 字符串 + UI XML 引用
    extra = """data/junqi/piece.png data/junqi/board.png data/junqi/label.png
    data/junqi/border.png data/junqi/mark.png data/junqi/title.png
    data/junqi/icon2.png data/junqi/main0.png data/junqi/main.jpg
    data/junqi/main.cfg data/junqi/scene.cfg data/junqi/icon.png
    data/junqi/start.png data/sg/board.png data/sg/boardx.png data/sg/piece.png
    data/sg/piecex.png data/sg/word.png data/sg/wordx.png data/sg/border.png
    data/sg/borderx.png data/sg/mark.png data/sg/markx.png data/sg/track.png
    data/sg/trackx.png data/sg/scene.cfg data/sg/back.jpg data/sg/sidedisc.png
    data/sg/sidedlg.png data/sg/sideturn.png data/image/stattiny.png
    data/image/stattinyh.png data/config/ui.xml data/config/font.xml
    data/ui/dlg.png data/ui/dlg.cfg data/ui/btn.png data/ui/btn.cfg
    data/ui/btn1.png data/ui/btn1.cfg data/ui/sbtn.png data/ui/sbtn.cfg
    data/ui/sbtn1.png data/ui/sbtn1.cfg data/ui/sbtn2.png data/ui/sbtn2.cfg
    data/ui/slider.cfg data/ui/slider_shaft.png data/ui/slider_thumb.png
    data/ui/tick.png data/ui/pen.png data/ui/checkbox.png data/ui/icon_alert.png
    data/ui/icon_config.png data/ui/icon_file.png data/ui/icon_info.png
    data/ui/icon_menu.png data/ui/vert.cfg data/ui/vert2.cfg
    data/ui/vert_thumb.png data/ui/vert2_thumb.png data/lay/00.lay""".split()
    for e in extra:
        if e not in out:
            out.append(e)
    return out


def main():
    m = json.load(open(MAN, encoding="utf-8"))
    by_md5 = {e["md5"]: e for e in m}
    groups = {}
    for e in m:
        groups.setdefault(e["group"], []).append(e)
    for g in groups:
        groups[g].sort(key=lambda e: e["idx"])

    kn = known_paths()
    idxmap = {}
    for p in kn:
        h = hashlib.md5(p.encode()).hexdigest()
        e = by_md5.get(h)
        if e:
            idxmap[(e["group"], e["idx"])] = p
    print("已知路径命中 %d / %d" % (len(idxmap), len(kn)))

    for g in ("data", "datah", "datax"):
        print("\n########## 组 %s（%d 条）##########" % (g, len(groups[g])))
        prev = None
        for e in groups[g]:
            nm = idxmap.get((g, e["idx"]))
            if nm:
                mark = "  "
            else:
                mark = "??"
            # 找最近的已知锚点
            print("%s idx=%3d %8d  %s" % (mark, e["idx"], e["size"], nm or e["name"].split("/")[-1]))


if __name__ == "__main__":
    main()
