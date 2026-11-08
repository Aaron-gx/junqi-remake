#!/usr/bin/env python3
"""read_chrome_ls.py —— 直接读 Chromium/Edge 的 `Local Storage/leveldb`，把某个 origin 的
localStorage 键值对**精确**还原出来（自带 snappy 解压 + leveldb block/footer 解析）。

为什么需要这个：调试「AI 援助」时要知道玩家**到底填了什么**接口地址/模型名。
从浏览器 UI 里问是绕圈子的（玩家未必记得、也可能填错），而 leveldb 文件里是
权威记录。难点：
  · `.ldb` 的数据块默认 **snappy 压缩**，`strings` 只能看到**字面量**，
    被 COPY 指令重建的部分全是乱码 —— 直接肉眼读会读错值（本项目真踩过：
    把 `https://api.deepseek.com` 读成 `api2…`）。
  · 键值对是**共享前缀压缩**的，必须按 leveldb block 格式逐条解。

零依赖实现：footer → index block → data blocks → (snappy) → key/value。

用法:
  python read_chrome_ls.py --dir "<profile>/Local Storage/leveldb" [--origin http://127.0.0.1:5180] [--grep junqi]
"""

from __future__ import annotations

import argparse
import glob
import os
import struct
import sys

# ─────────────────────────── snappy ───────────────────────────


def snappy_decompress(src: bytes) -> bytes:
    """纯 Python snappy 解压（只实现 leveldb 用到的那部分）。"""
    pos = 0

    def varint() -> int:
        nonlocal pos
        shift = 0
        val = 0
        while True:
            b = src[pos]
            pos += 1
            val |= (b & 0x7F) << shift
            if not (b & 0x80):
                return val
            shift += 7

    expect = varint()
    out = bytearray()
    while pos < len(src):
        tag = src[pos]
        pos += 1
        kind = tag & 0x03
        if kind == 0:  # 字面量
            ln = (tag >> 2) + 1
            if ln > 60:
                n = ln - 60
                ln = int.from_bytes(src[pos : pos + n], "little") + 1
                pos += n
            out += src[pos : pos + ln]
            pos += ln
            continue
        if kind == 1:
            ln = 4 + ((tag >> 2) & 0x07)
            off = ((tag >> 5) << 8) | src[pos]
            pos += 1
        elif kind == 2:
            ln = 1 + (tag >> 2)
            off = int.from_bytes(src[pos : pos + 2], "little")
            pos += 2
        else:
            ln = 1 + (tag >> 2)
            off = int.from_bytes(src[pos : pos + 4], "little")
            pos += 4
        if off == 0 or off > len(out):
            raise ValueError(f"snappy: 非法 offset {off} (out={len(out)})")
        start = len(out) - off
        for k in range(ln):  # 逐字节复制（允许重叠）
            out.append(out[start + k])
    if len(out) != expect:
        raise ValueError(f"snappy: 长度不符 expect={expect} got={len(out)}")
    return bytes(out)


# ─────────────────────────── leveldb ───────────────────────────


def read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    shift = 0
    val = 0
    while True:
        b = buf[pos]
        pos += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80):
            return val, pos
        shift += 7


def block_entries(block: bytes):
    """把 block 内容解成 (key, value) 列表。"""
    if len(block) < 4:
        return []
    num_restarts = int.from_bytes(block[-4:], "little")
    end = len(block) - 4 - num_restarts * 4
    pos = 0
    key = b""
    out = []
    while pos < end:
        shared, pos = read_varint(block, pos)
        non_shared, pos = read_varint(block, pos)
        vlen, pos = read_varint(block, pos)
        if shared > len(key):
            break
        key = key[:shared] + block[pos : pos + non_shared]
        pos += non_shared
        val = block[pos : pos + vlen]
        pos += vlen
        out.append((key, val))
    return out


def as_block(raw: bytes) -> bytes:
    """把一段块字节变成 block 内容：是 snappy 就解压，否则原样返回。

    ⚠️ 实测（Chromium 的 `Local Storage/leveldb`）：footer/index 里的 handle
    **size 已经是"内容长度"，不含末尾那 5 字节 trailer**（type + crc32）。
    早先按标准 leveldb 的"size 含 trailer"去切，会少读 5 字节并解不出任何条目。
    """
    try:
        return snappy_decompress(raw)
    except Exception:
        return raw


def iter_blocks(path: str):
    """按 .ldb 的 footer → index → data block 顺序产出解压后的 block 内容。"""
    data = open(path, "rb").read()
    if len(data) < 48:
        return
    footer = data[-48:]
    pos = 0
    _, pos = read_varint(footer, pos)  # metaindex handle offset
    _, pos = read_varint(footer, pos)  # metaindex handle size
    idx_off, pos = read_varint(footer, pos)
    idx_size, pos = read_varint(footer, pos)
    if idx_size <= 0 or idx_off + idx_size > len(data):
        return
    content = as_block(data[idx_off : idx_off + idx_size])
    index = block_entries(content)
    # 兜底：万一 index 解不出条目，就线性扫全文件里的数据块（容错）
    if not index:
        yield b"", content
        return
    for key, val in index:
        off, p = read_varint(val, 0)
        size, _ = read_varint(val, p)
        if off + size > len(data):
            continue
        yield key, as_block(data[off : off + size])


def decode_ls_key(k: bytes) -> tuple[str, str]:
    """localStorage 键格式：`_<origin>\\x00\\x01<name>`。"""
    s = k.decode("utf-8", "replace")
    if s.startswith("_"):
        s = s[1:]
    if "\x00" in s:
        origin, name = s.split("\x00", 1)
        return origin, name.lstrip("\x01")
    return "", s


def decode_ls_value(v: bytes) -> str:
    """值前面可能有一个编码字节（0=UTF-16, 1=UTF-8）。"""
    if not v:
        return ""
    if v[0] == 0:
        try:
            return v[1:].decode("utf-16-le", "replace")
        except Exception:
            return repr(v)
    if v[0] == 1:
        return v[1:].decode("utf-8", "replace")
    return v.decode("utf-8", "replace")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="Local Storage/leveldb 目录")
    ap.add_argument("--origin", default="", help="只看这个 origin（子串匹配）")
    ap.add_argument("--grep", default="", help="键名包含该子串才打印")
    ap.add_argument("--all", action="store_true", help="连 .log 文件一起扫")
    args = ap.parse_args()

    pats = ["*.ldb"] + (["*.log"] if args.all else [])
    files = []
    for p in pats:
        files += glob.glob(os.path.join(args.dir, p))
    found = 0
    for f in sorted(files):
        try:
            blobs = list(iter_blocks(f))
        except Exception as e:
            print(f"# 跳过 {os.path.basename(f)}: {e}", file=sys.stderr)
            continue
        for _, blk in blobs:
            for k, v in block_entries(blk):
                origin, name = decode_ls_key(k)
                if args.origin and args.origin not in origin:
                    continue
                if args.grep and args.grep not in name:
                    continue
                print(f"{os.path.basename(f)}  [{origin}]  {name} = {decode_ls_value(v)!r}")
                found += 1
    print(f"\n共 {found} 条")


if __name__ == "__main__":
    main()
