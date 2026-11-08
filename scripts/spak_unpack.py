#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SPAK 解包器 —— 依据 libjunqi.so 反编译结果实现。

逆向依据（Ghidra 反编译）：
  FUN_000b8644  索引解析器：
      read(0, 0x18) -> 24 字节头
      断言 magic == 0x4b415053 ("SPAK") 且 (hdr[5] % 0x1c == 0)
      blob = read(hdr[2], hdr[3])          # 索引区：偏移 hdr[2]，长度 hdr[3]
      assert checksum(blob) == hdr[4]
      FUN_000bcb60(blob, hdr[3])           # ← 解密：32 字节循环密钥异或
      FUN_000b4638(blob, hdr[3], out, hdr[5])   # ← 解压：hdr[3] -> hdr[5] 字节
      entryCount = hdr[5] / 0x1c           # 每 28 字节一条记录
      每条记录：FUN_000aa85e(rec, 0x10, buf, 0x40) 读取记录内偏移 0x10 处的名字

  FUN_000bcb60  解密：
      for (i = 0; i < len; i++) data[i] ^= KEY[i % 32];
      KEY 位于 DAT_001356d4

  FUN_000b4638  解压：调用 FUN_000ea534(dst, &dstCap, src, srcLen)
"""
import struct
import glob
import os
import sys
import zlib
import collections
import json

ASSETS = sys.argv[1] if len(sys.argv) > 1 else "02-apktool/assets"
SO = sys.argv[2] if len(sys.argv) > 2 else "03-native/libjunqi.so"
OUTDIR = sys.argv[3] if len(sys.argv) > 3 else "05-assets"
ROOT = sys.argv[4] if len(sys.argv) > 4 else "00-triage"

IMAGE_BASE = 0x10000          # Ghidra 装载基址
DAT_KEY_VADDR = 0x001356D4    # DAT_001356d4 —— 32 字节循环密钥
MAGIC = 0x4B415053            # "SPAK"
ENTRY_SIZE = 0x1C             # 28 字节/条


def get_key(so_path):
    off = DAT_KEY_VADDR - IMAGE_BASE
    d = open(so_path, "rb").read()
    key = d[off:off + 32]
    return key, off


def xor_dec(data, key):
    kl = len(key)
    if kl == 32:
        out = bytearray(data)
        for r in range(kl):
            k = key[r]
            out[r::kl] = bytes(c ^ k for c in out[r::kl])
        return bytes(out)
    return bytes(data[i] ^ key[i % kl] for i in range(len(data)))


def decompress(src, out_size):
    """尝试多种解压方式"""
    attempts = []
    for wb in (-15, 15, 31):
        try:
            d = zlib.decompressobj(wb)
            out = d.decompress(src, out_size)
            if len(out) >= out_size:
                return out[:out_size], "zlib wbits={}".format(wb)
            if len(out) > 0:
                attempts.append((len(out), "zlib wbits={} 仅 {} 字节".format(wb, len(out))))
        except Exception as e:
            attempts.append((0, "zlib wbits={} 失败: {}".format(wb, e)))
    # lz4 块格式尝试
    try:
        import lz4.block
        return lz4.block.decompress(src, uncompressed_size=out_size), "lz4"
    except Exception:
        pass
    return None, "; ".join(a[1] for a in attempts)


def parse_header(blob):
    magic, ver, idx_off, idx_csize, chk, idx_usize = struct.unpack_from("<6I", blob, 0)
    return dict(magic=magic, version=ver, index_offset=idx_off,
                index_csize=idx_csize, checksum=chk, index_usize=idx_usize)


def main():
    key, key_off = get_key(SO)
    print("密钥 (32 字节) @ file 0x{:x} (vaddr 0x{:x}): {}".format(key_off, DAT_KEY_VADDR, key.hex()))
    print()

    groups = collections.defaultdict(list)
    for p in sorted(glob.glob(os.path.join(ASSETS, "*.pak"))):
        b = os.path.basename(p)
        groups[b[:-4].rstrip("0123456789")].append(p)

    report = []
    for g, fs in groups.items():
        blob = b"".join(open(x, "rb").read() for x in sorted(fs))
        if blob[:4] != b"SPAK":
            print("[{}] 非 SPAK，跳过".format(g)); continue
        h = parse_header(blob)
        print("=== 组 {} ===".format(g))
        print("  头: magic={:#x} ver={} idx_off={} idx_csize={} chk={:#x} idx_usize={} (条目 {})".format(
            h["magic"], h["version"], h["index_offset"], h["index_csize"],
            h["checksum"], h["index_usize"], h["index_usize"] // ENTRY_SIZE))
        idx = blob[h["index_offset"]:h["index_offset"] + h["index_csize"]]
        dec = xor_dec(idx, key)
        out, how = decompress(dec, h["index_usize"])
        if out is None:
            print("  解压失败: {}".format(how))
            # 保存供离线分析
            open(os.path.join(ROOT, "spak-index-{}-xor.bin".format(g)), "wb").write(dec)
            report.append((g, False, None))
            continue
        print("  解压成功 [{}] -> {} 字节".format(how, len(out)))
        open(os.path.join(ROOT, "spak-index-{}-plain.bin".format(g)), "wb").write(out)

        # 解析目录项
        n = len(out) // ENTRY_SIZE
        entries = []
        for i in range(n):
            rec = out[i * ENTRY_SIZE:(i + 1) * ENTRY_SIZE]
            f0, f1, f2, f3 = struct.unpack_from("<4I", rec, 0)
            name = rec[0x10:].split(b"\x00")[0].decode("latin-1", "replace")
            entries.append(dict(idx=i, f0=f0, f1=f1, f2=f2, f3=f3, name=name))
        named = [e for e in entries if e["name"]]
        print("  目录项 {} 条，其中有名字的 {} 条".format(n, len(named)))
        for e in named[:15]:
            print("    [{:>3}] off={:<9} cs={:<8} us={:<8} ?={:<6} name={}".format(
                e["idx"], e["f0"], e["f1"], e["f2"], e["f3"], e["name"]))
        if len(named) > 15:
            print("    ... 共 {} 条".format(len(named)))
        json.dump(entries, open(os.path.join(ROOT, "spak-index-{}.json".format(g)), "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
        print()
        report.append((g, True, len(named)))

    print("=== 汇总 ===")
    for g, ok, n in report:
        print("  {}: 索引解出={} 命名条目={}".format(g, ok, n))


if __name__ == "__main__":
    main()
