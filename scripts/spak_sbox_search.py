#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在 libjunqi.so 中搜索 256 字节置换表（S-box）。

依据：SPAK 载荷中存在连续 170 字节完全相同、间距不规则的重复区段，
      唯一自洽的解释是「逐字节位置无关映射」C[i] = S[P[i]]，S 为 256 字节置换表。
      这类表在二进制里就是一段"0..255 各出现一次"的 256 字节常量，
      用滑动窗口 O(n) 即可定位。

如果找到，立即用它解密 SPAK 并检索 PNG/XML 魔数验证。
"""
import re
import sys
import struct
import glob
import os
import collections

SO = sys.argv[1] if len(sys.argv) > 1 else "03-native/libjunqi.so"
ASSETS = sys.argv[2] if len(sys.argv) > 2 else "02-apktool/assets"
OUT = sys.argv[3] if len(sys.argv) > 3 else "00-triage"


def find_permutations(data, need=256):
    """滑动窗口找所有"256 个字节互不相同"的窗口（即置换表候选）"""
    n = len(data)
    cnt = [0] * 256
    distinct = 0
    res = []
    w = need
    if n < w:
        return res
    for i in range(w):
        v = data[i]
        if cnt[v] == 0:
            distinct += 1
        cnt[v] += 1
    if distinct == w:
        res.append(0)
    for i in range(1, n - w + 1):
        out = data[i - 1]
        cnt[out] -= 1
        if cnt[out] == 0:
            distinct -= 1
        inn = data[i + w - 1]
        if cnt[inn] == 0:
            distinct += 1
        cnt[inn] += 1
        if distinct == w:
            res.append(i)
    return res


def find_affine_partial(data):
    """寻找 256 字节的"线性"表：S[x] = (a*x+b)&0xFF 的紧凑判定。
    用窗口内首两字节解出 a,b，再全窗口验证。"""
    hits = []
    n = len(data) - 256
    for off in range(0, n):
        d = data[off:off + 256]
        # 由 d[0]=S[0]=b, d[1]=S[1]=a+b 得 a,b
        b = d[0]
        a = (d[1] - b) & 0xFF
        if a % 2 == 0:
            continue
        ok = True
        for x in (2, 3, 5, 17, 128, 255):
            if d[x] != ((a * x + b) & 0xFF):
                ok = False
                break
        if ok:
            hits.append((off, a, b))
            if len(hits) > 20:
                break
    return hits


def load_groups():
    groups = collections.defaultdict(list)
    for path in sorted(glob.glob(os.path.join(ASSETS, "*.pak"))):
        b = os.path.basename(path)
        groups[b[:-4].rstrip("0123456789")].append(path)
    out = {}
    for g, fs in groups.items():
        blob = b"".join(open(x, "rb").read() for x in sorted(fs))
        if blob[:4] != b"SPAK":
            continue
        f8, f12 = struct.unpack_from("<II", blob, 8)
        out[g] = dict(blob=blob, payload=blob[16:16 + f8], index=blob[16 + f8:f8 + f12])
    return out


MAGICS = [b"\x89PNG\r\n\x1a\n", b"IHDR", b"IDAT", b"IEND", b"<?xml", b"<lay",
          b"\x1f\x8b\x08", b"PK\x03\x04", b"\xff\xd8\xff", b"data/config/",
          b"data/sg/", b"data.pak"]
PRINT_RUN = re.compile(rb"[\x20-\x7e]{24,}")


def main():
    d = open(SO, "rb").read()
    L = []
    A = L.append
    A("# 在 libjunqi.so 中搜索 256 字节置换表（S-box）\n")
    A("- 文件：`{}`  {} 字节".format(os.path.basename(SO), len(d)))
    A("")

    A("## 1. 完整 256 字节置换表扫描（全文件滑动窗口）\n")
    perms = find_permutations(d, 256)
    A("- 命中数：**{}**".format(len(perms)))
    if perms:
        A("")
        A("| 偏移 | 前 16 字节 | 是否恒等表 |")
        A("|---|---|---|")
        for off in perms[:20]:
            seg = d[off:off + 256]
            ident = "是" if seg == bytes(range(256)) else "否"
            A("| `0x{:x}` | `{}` | {} |".format(off, seg[:16].hex(), ident))
    A("")

    A("## 2. 仿射表 S[x]=(a*x+b)&0xFF 扫描\n")
    aff = find_affine_partial(d)
    A("- 命中数：**{}**".format(len(aff)))
    if aff:
        for off, a, b in aff[:20]:
            A("  - `0x{:x}`: a={} b={}".format(off, a, b))
    A("")

    # 3. 若找到置换表，直接试解密
    A("## 3. 用候选表试解密 SPAK\n")
    groups = load_groups()
    if not perms:
        A("- 无 256 字节完整置换表 → S 表可能是运行时生成（或按块构造），")
        A("  需从 `.so` 代码中还原生成逻辑，或改用 Frida 动态 dump。")
    else:
        for off in perms[:10]:
            seg = d[off:off + 256]
            if len(set(seg)) != 256:
                continue
            inv = [0] * 256
            for x, y in enumerate(seg):
                inv[y] = x          # 反向表：C -> P 需按反向查
            dec_table = bytes(inv)
            for g, info in groups.items():
                for label in ("payload", "index"):
                    data = info[label]
                    dd = data.translate(dec_table)
                    hit = [m for m in MAGICS if m in dd]
                    printable = len(PRINT_RUN.findall(dd))
                    if hit or printable > 0:
                        A("- 表 @`0x{:x}` + 组 `{}`/{} → 魔数命中 {}，可打印长串 {} 段".format(
                            off, g, label, [h.decode('latin-1', 'replace') for h in hit], printable))
        A("- （无输出表示候选表均未产出可识别明文）")
    A("")

    open(os.path.join(OUT, "spak-sbox-search.md"), "w", encoding="utf-8").write("\n".join(L) + "\n")
    print("OK -> spak-sbox-search.md  perms={} affine={}".format(len(perms), len(aff)))


if __name__ == "__main__":
    main()
