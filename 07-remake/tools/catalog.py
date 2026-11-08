# -*- coding: utf-8 -*-
"""建立素材编目（内容哈希 / 尺寸 / 分组 / 推断名），供后续选取素材使用。"""
import json, os, hashlib, struct, collections

BASE = r"E:\Learn\MeProject\2026.9.10-reverse\work\2026.9.10-base-apk"
MAN = os.path.join(BASE, "05-assets", "spak-extract-manifest.json")
RES = os.path.join(BASE, "05-assets", "resources")
OUT = os.path.join(BASE, "07-remake", "tools", "_raw", "catalog.json")


def main():
    m = json.load(open(MAN, encoding="utf-8"))
    rows = []
    for e in m:
        p = os.path.join(RES, e["name"].replace("/", os.sep))
        if not os.path.exists(p):
            continue
        b = open(p, "rb").read()
        ch = hashlib.md5(b).hexdigest()
        kind, dim = "bin", None
        if b[:8] == b"\x89PNG\r\n\x1a\n":
            kind = "png"
            dim = list(struct.unpack(">II", b[16:24]))
        elif b[:3] == b"\xff\xd8\xff":
            kind, dim = "jpg", None
        elif b[:4] == b"RIFF":
            kind = "wav"
        elif b[:1] == b"<":
            kind = "xml"
        elif b[:4] == b"SPAK":
            kind = "spak"
        rows.append({
            "group": e["group"], "idx": e["idx"], "key": e["md5"], "ch": ch,
            "size": e["size"], "kind": kind, "dim": dim, "path": e["name"],
        })
    rows.sort(key=lambda r: (r["group"], r["idx"]))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(rows, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("catalog rows", len(rows), "->", OUT)
    # 打印 PNG 摘要
    print("\n=== PNG 清单（按组） ===")
    for g in ("data", "datah", "datax"):
        print("---", g, "---")
        n = 0
        for r in rows:
            if r["group"] != g or r["kind"] != "png":
                continue
            n += 1
            print("  idx=%3d ch=%s %6d  %sx%s" % (r["idx"], r["ch"][:8], r["size"],
                  r["dim"][0], r["dim"][1]))
        print("  共", n)


if __name__ == "__main__":
    main()
