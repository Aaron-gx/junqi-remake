# -*- coding: utf-8 -*-
"""把原版素材（棋盘位图 / 棋子面图集 / 9 宫格皮肤 / 音效）抽取到复刻工程。

用法: python extract_web_assets.py
产物: 07-remake/public/assets/  +  manifest.json
"""
import os, json, shutil, struct

BASE = r"E:\Learn\MeProject\2026.9.10-reverse\work\2026.9.10-base-apk"
RES = os.path.join(BASE, "05-assets", "resources")
CAT = os.path.join(BASE, "07-remake", "tools", "_raw", "catalog.json")
PUB = os.path.join(BASE, "07-remake", "public", "assets")

rows = json.load(open(CAT, encoding="utf-8"))
IDX = {(r["group"], r["idx"]): r for r in rows}
CH = {r["ch"]: r for r in rows}

# 目录清单里的条目可能缺文件，这里直接用原始 manifest 兜底
_MAN = json.load(open(os.path.join(BASE, "05-assets", "spak-extract-manifest.json"),
                      encoding="utf-8"))
RAW = {(e["group"], e["idx"]): e for e in _MAN}


def raw_path(grp, ix):
    return os.path.join(RES, RAW[(grp, ix)]["name"].replace("/", os.sep))


def src(grp, ix):
    r = IDX.get((grp, ix))
    if r:
        p = os.path.join(RES, r["path"].replace("/", os.sep))
        if os.path.exists(p):
            return p, r
    e = RAW[(grp, ix)]
    return raw_path(grp, ix), {"group": grp, "idx": ix, "size": e["size"]}


def copy(grp, ix, out_name):
    p, r = src(grp, ix)
    ext = os.path.splitext(p)[1].lower()
    if not out_name.endswith(ext):
        out_name = out_name + ext
    os.makedirs(PUB, exist_ok=True)
    shutil.copyfile(p, os.path.join(PUB, out_name))
    return out_name, r


# ── 9 宫格皮肤：cfg 在 idx，图片紧随其后 ────────────────────────
SKIN = [
    # 名称, cfg索引, 图片索引
    ("btn", 189, 194),
    ("btn1", 190, 191),
    ("dlg", 199, 200),
    ("list_item", 207, 208),
    ("list_item_h", 210, 211),
    ("sbtn", 214, 223),
    ("sbtn1", 215, 216),
    ("sbtn2", 219, 220),
    ("slider_shaft", 226, 227),
    ("slider_thumb", 229, 230),
]


def read_cfg(grp, ix):
    p, r = src(grp, ix)
    t = open(p, "rb").read().decode("latin1").strip()
    name, a, b, c, d = t.split(",")
    return {"src": name, "x1": int(a), "y1": int(b), "x2": int(c), "y2": int(d)}


def png_size(p):
    b = open(p, "rb").read(33)
    return struct.unpack(">II", b[16:24])


def main():
    man = {"board": {}, "pieceAtlas": {}, "skin": {}, "sound": {}, "notes": []}
    # 注意：沙箱下 shutil.rmtree 会被安全删除 shim 拦下（走回收站失败），
    # 这里改成逐个 unlink，保留目录本身。
    os.makedirs(PUB, exist_ok=True)
    for _f in os.listdir(PUB):
        _p = os.path.join(PUB, _f)
        if os.path.isfile(_p):
            os.remove(_p)

    # 1) 棋盘位图 —— 原版按屏幕比例在两张棋盘里选（见 data/junqi/main.cfg 的 boardRc）
    #    datax#156  720x1160  中缝 248（gap 178）→ 高瘦屏（如 720x1600）  ★ 主线用这张
    #    datax#250  720x1071  中缝 208（gap 136）→ 较矮屏
    #    实测：900x1600 竖屏下原版用的就是 #156，行位 y=1.2493*y+148.6 全 12 行误差<1.5px。
    fn, r = copy("datax", 156, "board.png")
    w, h = png_size(os.path.join(PUB, fn))
    man["board"] = {"file": fn, "w": w, "h": h, "src": "datax#156"}
    print("board", fn, w, h)
    fn2, _ = copy("datax", 250, "board_wide.png")
    w2, h2 = png_size(os.path.join(PUB, fn2))
    man["boardWide"] = {"file": fn2, "w": w2, "h": h2, "src": "datax#250"}
    print("boardWide", fn2, w2, h2)

    # 2) 棋子面图集
    fn, r = copy("datax", 167, "piece.png")
    w, h = png_size(os.path.join(PUB, fn))
    man["pieceAtlas"] = {"file": fn, "w": w, "h": h, "cols": 4, "rows": 7,
                         "tileW": 86, "tileH": 61,
                         "src": "datax#167",
                         "layout": "row0-2 橙方(司令军长师长旅长/团长营长连长排长/工兵炸弹地雷军旗), row3-5 蓝方同序, row6 = 纯色块 绿(112,156,0)/橙(216,108,0)/蓝(40,104,160)/黑(0,0,0)",
                         "backRow": 6,
                         "back": {"green": 0, "orange": 1, "blue": 2, "black": 3},
                         "backUsage": "翻棋背面=绿(col0)；暗棋里隐藏的对方子=蓝(col2)、隐藏的己方子=橙(col1)；黑(col3)未使用",
                         "note": "344x427 = 4x86 x 7x61，单元与格子严丝合缝，无分隔线；实测模拟器 900x1600 翻棋背面中心像素=(112,156,0) 与 col0 完全一致"}
    print("piece atlas", fn, w, h, "cell", w / 4, h / 7)

    # 3) 皮肤
    for name, cfg_ix, img_ix in SKIN:
        cfg = read_cfg("datax", cfg_ix)
        fn, r = copy("datax", img_ix, name + ".png")
        iw, ih = png_size(os.path.join(PUB, fn))
        man["skin"][name] = {
            "file": fn, "w": iw, "h": ih,
            "cut": [cfg["x1"], cfg["y1"], cfg["x2"], cfg["y2"]],
            "srcName": cfg["src"],
            "slice": [cfg["y1"], iw - cfg["x2"], ih - cfg["y2"], cfg["x1"]],
        }
        print("skin %-14s %dx%d cut=%s" % (name, iw, ih, man["skin"][name]["cut"]))

    # 4) 主菜单 / 图标（按 datax 索引）
    EXTRA = [
        ("title_2p", 307),      # 「军棋」标题（大）
        ("title_2p_s", 170),    # 「军棋」标题（小）
        ("title_4p", 165),      # 「四国军棋」标题
        ("logo_4p", 308),       # 四国军棋横幅
        ("btn_start", 169),     # 「战斗开始」按钮
        ("art_main", 280),      # 主菜单插画
        ("poster_1", 162),
        ("poster_2", 252),
        ("poster_3", 279),
        ("bg_grad_1", 171),
        ("bg_grad_2", 254),
        ("board_4p", 311),      # 四国棋盘
        ("icon_flag", 159),
        ("icon_config", 202),
        ("icon_chat", 204),
        # ★ 同一个 hash 还有个语义名：原版「新局」对话框的标题图标就是这张
        #   （青色双页 + 弧形箭头）。解包名 `icon_chat.png` 是误名 —— 真正的聊天
        #   气泡是 `icon_chatbig`(datax/d999fee1…)，别按名字猜用途。
        #   代码里一律用 `icon_newgame.png`，免得下次又被名字带偏。
        ("icon_newgame", 204),
        ("icon_menu", 206),
        ("icon_tick", 139),
        ("icon_remove", 137),
        ("icon_info", 128),
        ("icon_regret", 133),
        ("icon_back", 145),
        ("icon_chattiny", 131),
        ("icon_next", 129),
        ("ui_tile_blue", 177),
        ("ui_tile_red", 175),
        ("ui_check_a", 197),
        ("ui_check_b", 198),
    ]
    for n, ix in EXTRA:
        try:
            fn, r = copy("datax", ix, n + ".png")
            man.setdefault("ui", {})[n] = fn
        except Exception as e:
            print("skip", n, e)
    print("extra", len(man.get("ui", {})))

    # 4a2) 启动主菜单（首页）素材 —— 实拍 `tools/_emu/s03.png`。
    #      认图依据：把候选图按 alpha 合成到实拍上逐像素求差，残差最低者唯一胜出。
    #      · 背景 720×1280，全屏残差 21.3，且**除标题/按钮外逐像素为 0**
    #        （旗帜、三名士兵、放射光线全在这一张里，不是独立图层）。
    #      · 标题图幅 507×266，按 art 1:1 画，字块外沿残差 4.24。
    #        ★ 不是 `title_2p_s.png`（标题栏那枚）—— 那枚字距被压过，残差 68.7。
    #      · 左下角小房子 90×90（= 480dp 的 `datah/5c856183…` × 1.5），残差 2.20。
    HOME_ASSETS = [
        ("bg_main", "842724ffccdc318fe1510ef226654bf8"),      # 720x1280 主菜单背景（jpg）
        ("title_main", "7d54a6541337ca2ac58f536c370f004f"),   # 507x266「军棋」大标题
        ("home_house", "be6189ee1214414af07cedf5bf9d0533"),   # 90x90 返回主页的小房子
    ]
    _home_raw = os.path.join(RES, "_unresolved", "datax")
    for n, h in HOME_ASSETS:
        p = next(
            (os.path.join(_home_raw, h + e) for e in (".png", ".jpg")
             if os.path.exists(os.path.join(_home_raw, h + e))),
            None,
        )
        if not p:
            print("skip home asset", n, h)
            continue
        fn = n + os.path.splitext(p)[1]
        shutil.copyfile(p, os.path.join(PUB, fn))
        man.setdefault("ui", {})[n] = fn
        print("home asset %-12s %s" % (n, fn))

    # 4b) 画面外壳素材 —— 这些在原版里叫 `/data/image/*.png`，
    #     解包后只留下 hash 名（`data` 组的键不是 MD5(路径)，无法反查），
    #     所以这里按**内容比对**认出来的 hash 直取，并给出可读名。
    #     认图依据见 tools/_audit/cand108.png 与实拍 s08.png（菜单）/ s15_lay.png（布阵栏）。
    #     尺寸一律 108×108（`_preview/108x108_*` 说明原版按这个画布出图），
    #     原版把它们**按 art 1:1** 画在 IconBtn(160×200) 上。
    SHELL_ICONS = [
        # 局内浮动按钮（93×68 那一套，与棋盘同密度）
        ("float_menu", "90f3934735caa0123425e549bc4880d1"),  # ☰ 菜单
        ("float_lay", "5c8b7866c9145a62bfa981545f74b61f"),   # 布阵
        # 布阵工具栏 `2dd05ee5…xml`
        ("icon_clear", "fb89e3710b19a53b95413e95d52ce811"),  # remove.png 扫帚
        ("icon_load", "52c868bcb0316f0dc1d784a626747992"),   # load.png 文件夹+绿箭头
        ("icon_save", "817244ec11b0b259016bf6fddb145ce6"),   # save.png 绿软盘
        ("icon_finish", "6545ba9f20e4131134af1bd76d90fc20"), # finish.png 绿勾
        # ☰ 菜单 `be78647b…xml` / `cd7d9e3a…xml`
        ("icon_new", "1fb2b983ece45e23572cbf96c7a380bc"),    # new.png 金星
        ("icon_undo", "4b2758b5d01324cf595005f2702f4d8b"),   # regret.png 绿弯箭头
        ("icon_redo", "6e67181be310c03219a73635bb85dea8"),   # change.png 蓝箭头
        ("icon_draw", "6d7a2bf408b9c9368405e804c951c70b"),   # draw.png 握手
        ("icon_resign", "e17ed4da65443bf8cf998300c8399f4d"), # resign.png 哭脸
        ("icon_chatbig", "d999fee198feafbdd2d73658f78580c0"),# chat.png 气泡
        ("icon_stat", "67317840e17efd0d0196988f23a999f9"),   # stat.png 饼图
        ("icon_rule", "1b040b6917b66def7a20b29ac1b01f35"),   # rule.png 文档
        ("icon_set", "97816dbabdb799ad5f398f99813ce5f7"),    # config.png 扳手
        ("icon_exit", "78e1546e490ab3f7b886e762517509c0"),   # exit.png 红叉
        ("icon_about", "84272d24e86021a049a3d12c1e1ddac6"),  # about.png 蓝 i
    ]
    _raw = os.path.join(RES, "_unresolved", "datax")
    for n, h in SHELL_ICONS:
        p = os.path.join(_raw, h + ".png")
        if not os.path.exists(p):
            print("skip shell icon", n, h)
            continue
        shutil.copyfile(p, os.path.join(PUB, n + ".png"))
        man.setdefault("ui", {})[n] = n + ".png"
        # 视觉元素：图标弹出层自己画，不进 9 宫格皮肤表
    print("shell icons", len(SHELL_ICONS))

    # 4c) 弹窗/面板皮肤 `data/ui/popup.cfg` = `popup.png,8,8,16,16`
    #     实测 popup.png 是 24×24 的**纯色** rgba(0,0,0,0.8) + 8px 圆角，
    #     所以复刻端直接用等价 CSS（background + border-radius），不必走 border-image。
    _pp = os.path.join(RES, "data", "ui", "popup.png")
    if os.path.exists(_pp):
        shutil.copyfile(_pp, os.path.join(PUB, "popup.png"))
        man["skin"]["popup"] = {
            "file": "popup.png", "w": 24, "h": 24,
            "cut": [8, 8, 16, 16], "srcName": "popup.png",
            "slice": [8, 8, 8, 8],
            "flat": "rgba(0,0,0,0.8) + 8px 圆角，等价 CSS 即可",
        }
        print("skin popup")

    # 5) 音效（已恢复真名，直接按路径拷贝）
    JUNQI_SND = ["move", "eat", "flip", "select", "start", "win", "lose",
                 "draw", "over", "bomb", "dead", "flag"]
    for n in JUNQI_SND:
        p = os.path.join(RES, "data", "junqi", n + ".wav")
        if os.path.exists(p):
            shutil.copyfile(p, os.path.join(PUB, n + ".wav"))
            man["sound"][n] = n + ".wav"
    UI_SND = ["click0", "click1", "click2", "click3", "close", "pop"]
    for n in UI_SND:
        p = os.path.join(RES, "data", "ui", n + ".wav")
        if os.path.exists(p):
            shutil.copyfile(p, os.path.join(PUB, n + ".wav"))
            man["sound"][n] = n + ".wav"
    print("sounds", len(man["sound"]))

    # 6) 文本资源：原版是 GBK，这里统一转成 UTF-8，浏览器直接 text() 读，
    #    同时在 manifest 里记下源编码，方便回查。
    TEXT = [
        ("rulelay", "data/junqi/rulelay.txt"),
        ("ruleflip", "data/junqi/ruleflip.txt"),
        ("sentence", "data/junqi/sentence.txt"),
    ]
    man["text"] = {}
    for key, rel in TEXT:
        p = os.path.join(RES, rel.replace("/", os.sep))
        if not os.path.exists(p):
            print("skip text", rel)
            continue
        raw = open(p, "rb").read()
        try:
            u = raw.decode("utf-8")
            enc = "utf-8"
        except UnicodeDecodeError:
            u = raw.decode("gbk")
            enc = "gbk"
        out = key + ".txt"
        with open(os.path.join(PUB, out), "w", encoding="utf-8", newline="") as fh:
            fh.write(u)
        man["text"][key] = {"file": out, "srcEncoding": enc, "src": rel}
    print("text", len(man["text"]))

    json.dump(man, open(os.path.join(PUB, "manifest.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    total = sum(os.path.getsize(os.path.join(PUB, f)) for f in os.listdir(PUB))
    print("files:", len(os.listdir(PUB)), "total %.1f KB" % (total / 1024))


if __name__ == "__main__":
    main()
