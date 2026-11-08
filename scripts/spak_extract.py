#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SPAK 完整解包器（最终版，依据 Ghidra 反编译 + 实测校正）

容器结构
--------
偏移 0x00  24 字节头（小端）：
    +0x00  u32  magic 0x4B415053 ("SPAK")
    +0x04  u32  version = 1
    +0x08  u32  index_offset        索引区在文件中的偏移（绝对）
    +0x0C  u32  index_compressed    索引区压缩长度
    +0x10  u32  checksum            索引区（加密态）校验，crc32(...) ^ 0x2713
    +0x14  u32  index_raw           索引区解压后长度 = 28 * 条目数
0x18 ~ index_offset   载荷数据区
index_offset ~ EOF    索引区

索引条目（28 字节 * N）
    +0x00  16 字节  资源路径的 MD5 摘要（哈希表键）
    +0x10  u32      载荷偏移（**绝对**，从文件头算起，首条 = 0x18）
    +0x14  u32      存储长度 csize
    +0x18  u32      原始长度 usize

加解密 / 解压（FUN_000bcb60 / FUN_000ea534）
    统一流程：对文件字节做 32 字节循环异或（从相位 0 开始）
        data[i] ^= KEY[i % 32]        KEY @ DAT_001356d4（32 字节）
    异或后：
        csize != usize  -> zlib inflate（windowBits = 15，标准 zlib 头）
        csize == usize  -> 原样存储（PNG / 文本 / 二进制）
    关键点：载荷偏移是「绝对文件偏移」，与索引区互不干扰；
            每条资源的异或相位都从 0 重新开始。

用法：
    spak_extract.py [ASSETS] [SO] [OUTDIR] [ROOT]
"""
import struct
import glob
import os
import re
import sys
import zlib
import hashlib
import collections
import json

ASSETS = sys.argv[1] if len(sys.argv) > 1 else "02-apktool/assets"
SO = sys.argv[2] if len(sys.argv) > 2 else "03-native/libjunqi.so"
OUTDIR = sys.argv[3] if len(sys.argv) > 3 else "05-assets/resources"
ROOT = sys.argv[4] if len(sys.argv) > 4 else "05-assets"

IMAGE_BASE = 0x10000
DAT_KEY_VADDR = 0x001356D4
MAGIC = 0x4B415053
ENTRY = 28
HDR = 24


def load_key(so_path):
    d = open(so_path, "rb").read()
    off = DAT_KEY_VADDR - IMAGE_BASE
    return d[off:off + 32]


def xor_key(data, key, phase=0):
    kl = len(key)
    out = bytearray(len(data))
    for i, c in enumerate(data):
        out[i] = c ^ key[(phase + i) % kl]
    return bytes(out)


def try_inflate(src, usize):
    for wb in (15, -15, 31):
        try:
            d = zlib.decompressobj(wb)
            out = d.decompress(src) + d.flush()
            if d.eof and d.unused_data == b"" and len(out) == usize:
                return out, wb
        except Exception:
            pass
    return None, None


def decode_entry(blob, key, offset, csize, usize):
    """异或（相位 0，绝对偏移）后按长度关系选择 inflate / 原样"""
    src = blob[offset:offset + csize]
    if len(src) != csize:
        return None, "越界截断"
    plain = xor_key(src, key, 0)
    if csize != usize:
        out, wb = try_inflate(plain, usize)
        if out is not None:
            return out, "inflate wbits={}".format(wb)
        return None, "解压失败"
    # csize == usize：优先按已压缩尝试，失败则原样
    out, wb = try_inflate(plain, usize)
    if out is not None:
        return out, "inflate wbits={} (c==u)".format(wb)
    return plain, "raw"


def sniff(data):
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:2] == b"\xff\xd8":
        return "jpg"
    if data[:3] == b"GIF":
        return "gif"
    if data[:2] == b"BM":
        return "bmp"
    if data[:4] == b"OggS":
        return "ogg"
    if data[:3] == b"ID3" or data[:2] in (b"\xff\xfb", b"\xff\xf3"):
        return "mp3"
    if data[:4] == b"RIFF":
        return "wav"
    if data[:4] == b"<?xm" or data[:1] == b"<":
        return "xml"
    if data[:1] in (b"{", b"["):
        return "json"
    return "bin"


def main():
    key = load_key(SO)
    groups = collections.defaultdict(list)
    for p in sorted(glob.glob(os.path.join(ASSETS, "*.pak"))):
        b = os.path.basename(p)
        groups[b[:-4].rstrip("0123456789")].append(p)

    # 已知路径 -> MD5
    known = {}
    mani = os.path.join("03-native", "asset-manifest.md")
    if os.path.exists(mani):
        for line in open(mani, encoding="utf-8"):
            m = re.search(r"\| `([^`]+)` \|$", line.strip())
            if m:
                path = m.group(1)
                known[hashlib.md5(path.encode()).digest()] = path

    all_ok = all_fail = 0
    manifest = []
    for g, fs in groups.items():
        blob = b"".join(open(x, "rb").read() for x in sorted(fs))
        if blob[:4] != b"SPAK":
            continue
        magic, ver, idx_off, idx_cs, chk, idx_raw = struct.unpack_from("<6I", blob, 0)
        idx_plain = None
        for ph in range(32):
            cand = xor_key(blob[idx_off:idx_off + idx_cs], key, ph)
            out, wb = try_inflate(cand, idx_raw)
            if out is not None:
                idx_plain = out
                break
        if idx_plain is None:
            print("[{}] 索引解出失败".format(g))
            continue
        n = idx_raw // ENTRY
        print("=== 组 {} : {} 条（载荷区 {} 字节）===".format(g, n, idx_off - HDR))

        ok = fail = 0
        for i in range(n):
            rec = idx_plain[i * ENTRY:(i + 1) * ENTRY]
            md5 = rec[0:16]
            off, cs, us = struct.unpack_from("<3I", rec, 16)
            data, how = decode_entry(blob, key, off, cs, us)
            path = known.get(md5)
            if data is None:
                fail += 1
                manifest.append(dict(group=g, idx=i, md5=md5.hex(), name=path,
                                     offset=off, csize=cs, usize=us, status=how))
                continue
            ok += 1
            if path is None:
                ext = "." + sniff(data)
                path = "_unresolved/{}/{}{}".format(g, md5.hex(), ext)
            out_path = os.path.join(OUTDIR, path.replace("/", os.sep))
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            open(out_path, "wb").write(data)
            manifest.append(dict(group=g, idx=i, md5=md5.hex(), name=path,
                                 offset=off, csize=cs, usize=us,
                                 size=len(data), status="ok " + how))
        print("  解出 {} / 失败 {}".format(ok, fail))
        all_ok += ok
        all_fail += fail

    os.makedirs(ROOT, exist_ok=True)
    json.dump(manifest, open(os.path.join(ROOT, "spak-extract-manifest.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print()
    print("总计：解出 {} 个，失败 {} 个".format(all_ok, all_fail))
    named = sum(1 for m in manifest if m["name"])
    print("其中命中已知路径名的：{}".format(named))


if __name__ == "__main__":
    main()
