#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SPAK 载荷是否为纯 zlib/deflate 容器？——全量扫描。

动机：
  * 密文中存在逐字节完全相同的 8/16/32 字节块，间距 69 / 2264 / 38688 的 gcd 为 1
    → 「周期密钥异或」被排除；
  * 熵恒为 8.0、卡方略偏高、无任何标准加密常量；
  * `.so` 字符串里存在 `inflate`。
  → 最简假设：**容器就是一堆 zlib 压缩块，没有加密**。
    相同文件压缩后逐字节相同，正好解释"任意间距的完全相同长块"。

做法：在载荷/索引的每一个偏移上校验 zlib 头（CM=8 且 (CMF<<8|FLG)%31==0），
      命中即尝试 inflate，输出 ≥4KB 视为有效流。同时扫描 gzip 与本机 deflate。
"""
import struct
import glob
import os
import sys
import zlib
import collections

ASSETS = sys.argv[1] if len(sys.argv) > 1 else "02-apktool/assets"
OUT = sys.argv[2] if len(sys.argv) > 2 else "00-triage"


def valid_zlib_headers():
    hs = set()
    for cmf in range(0x08, 0x80, 0x10):        # CM=8, CINFO=0..7
        for flg in range(256):
            if ((cmf << 8) | flg) % 31 == 0:
                hs.add(bytes([cmf, flg]))
    return hs


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


def scan_zlib(data, headers, min_out=4096, limit=200):
    hits = []
    n = len(data)
    i = 0
    while i < n - 2:
        if data[i:i + 2] in headers:
            try:
                d = zlib.decompressobj(15)
                out = d.decompress(data[i:i + 2_000_000], 65536)
                if len(out) >= min_out:
                    hits.append((i, len(out), out[:16]))
                    if len(hits) >= limit:
                        break
                    i += 1
                    continue
            except Exception:
                pass
        i += 1
    return hits


def scan_gzip(data, min_out=4096, limit=50):
    hits = []
    n = len(data)
    i = 0
    while i < n - 3:
        if data[i:i + 3] == b"\x1f\x8b\x08":
            try:
                d = zlib.decompressobj(31)
                out = d.decompress(data[i:i + 4_000_000], 262144)
                if len(out) >= min_out:
                    hits.append((i, len(out)))
                    if len(hits) >= limit:
                        break
            except Exception:
                pass
        i += 1
    return hits


def scan_raw_deflate(data, offsets, min_out=4096):
    hits = []
    for off in offsets:
        try:
            d = zlib.decompressobj(-15)
            out = d.decompress(data[off:off + 4_000_000], 65536)
            if len(out) >= min_out:
                hits.append((off, len(out), out[:16]))
                if len(hits) >= 30:
                    break
        except Exception:
            pass
    return hits


def main():
    L = []
    A = L.append
    A("# SPAK 载荷 zlib/deflate 全量扫描\n")
    A("假设：容器是纯压缩档案（**未加密**），相同文件压缩后逐字节相同，")
    A("正好解释「任意间距的完全相同长块」与「无周期、熵 8.0」。\n")

    headers = valid_zlib_headers()
    A("- 合法 zlib 头组合数：{}\n".format(len(headers)))

    groups = load_groups()
    summary = []
    for g, info in groups.items():
        payload, index = info["payload"], info["index"]
        A("## 组 `{}`\n".format(g))
        for label, data in (("载荷", payload), ("索引区", index)):
            A("**{}**（{} 字节）\n".format(label, len(data)))
            hz = scan_zlib(data, headers)
            A("- zlib 流命中：**{}** 个".format(len(hz)))
            if hz:
                A("")
                A("| 偏移 | 解出字节 | 头部内容 |")
                A("|---|---|---|")
                for off, ln, head in hz[:20]:
                    vis = "".join(chr(c) if 32 <= c < 127 else "." for c in head)
                    A("| `0x{:x}` | {} | `{}` |".format(off, ln, vis))
                A("")
            hg = scan_gzip(data)
            A("- gzip 流命中：**{}** 个".format(len(hg)))
            if hg:
                for off, ln in hg[:10]:
                    A("  - `0x{:x}` 解出 {} 字节".format(off, ln))
            A("")
            summary.append((g, label, len(hz), len(hg)))

    A("## 总判定\n")
    A("| 组 | 区域 | zlib 流数 | gzip 流数 |")
    A("|---|---|---|---|")
    for g, label, a1, b1 in summary:
        A("| `{}` | {} | {} | {} |".format(g, label, a1, b1))
    A("")
    total = sum(s[2] + s[3] for s in summary)
    if total > 0:
        A("**结论：载荷中存在可解压的 zlib/gzip 流 → 容器为纯压缩档案，未加密。**")
        A("下一步：解析 SPAK 索引结构，按 (偏移, 压缩长度) 逐条 inflate，导出全部资源。")
    else:
        A("**结论：未发现任何合法 zlib/gzip 流 → 载荷确实经过额外变换，需反编译 .so 或动态 dump。**")

    open(os.path.join(OUT, "spak-deflate-scan.md"), "w", encoding="utf-8").write("\n".join(L) + "\n")
    print("OK -> spak-deflate-scan.md")
    for g, label, a1, b1 in summary:
        print("  {} / {}: zlib={} gzip={}".format(g, label, a1, b1))


if __name__ == "__main__":
    main()
