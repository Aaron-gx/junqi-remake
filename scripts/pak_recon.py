#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SPAK 容器侦察：magic / 分片 / 熵 / 可打印串 / 压缩特征判断。"""
import struct, sys, os, re, glob, math, collections


def shannon(b):
    if not b:
        return 0.0
    c = collections.Counter(b)
    n = len(b)
    return -sum((v / n) * math.log2(v / n) for v in c.values())


def main():
    assets = sys.argv[1]
    outdir = sys.argv[2]
    paks = sorted(glob.glob(os.path.join(assets, "*.pak")),
                  key=lambda p: (len(os.path.basename(p)), p))
    L = []
    A = L.append
    A("# SPAK / assets 数据容器侦察\n")
    A(f"- 目录: `{assets}`")
    A(f"- 文件数: {len(paks)}\n")
    A("| 文件 | 大小 | magic | 版本 | 字段@4 | 字段@8 | 头部熵 | 全局熵 |")
    A("|---|---|---|---|---|---|---|---|")
    detail = {}
    for p in paks:
        d = open(p, "rb").read()
        magic = d[:4]
        ver = struct.unpack_from("<I", d, 4)[0]
        f4 = struct.unpack_from("<I", d, 4)[0]
        f8 = struct.unpack_from("<I", d, 8)[0]
        f12 = struct.unpack_from("<I", d, 12)[0]
        detail[os.path.basename(p)] = dict(size=len(d), magic=magic, ver=ver, f4=f4, f8=f8, f12=f12)
        A(f"| `{os.path.basename(p)}` | {len(d):,} | `{magic!r}` | {ver} | {f4} | {f8} | "
          f"{shannon(d[:4096]):.2f} | {shannon(d):.2f} |")

    # 拼接后按组分析
    A("\n## 分片重组（按 base 前缀聚合）\n")
    groups = collections.defaultdict(list)
    for p in paks:
        b = os.path.basename(p)
        g = re.sub(r"\d+\.pak$", "", b)
        groups[g].append(p)
    for g, fs in groups.items():
        tot = sum(os.path.getsize(x) for x in fs)
        A(f"- **{g}***: {len(fs)} 片 / 共 {tot:,} 字节 → {[os.path.basename(x) for x in fs]}")
        blob = b"".join(open(x, "rb").read() for x in fs)
        # 剥离头部 16 字节再统计
        body = blob[16:]
        A(f"  - 重组后总熵: {shannon(body):.3f}（>7.5 近似压缩/加密，<7 多为可读数据）")
        # magic 一致性
        ms = collections.Counter(blob[i*1024*1024:i*1024*1024+4] for i in range((len(blob)+1048575)//1048576))
        A(f"  - 1MB 边界处 magic 分布: {dict(list(ms.items())[:6])}")

    # 全量可打印串
    A("\n## 数据区可打印字符串（Top 120，按长度 ≥6）\n")
    allstr = []
    for p in paks:
        d = open(p, "rb").read()
        for m in re.finditer(rb"[\x20-\x7e]{6,}", d):
            allstr.append(m.group(0).decode("latin-1"))
    seen, uniq = set(), []
    for s in allstr:
        if s not in seen:
            seen.add(s)
            uniq.append(s)
    A(f"共 {len(allstr)} 条可打印串 / 去重 {len(uniq)} 条\n")
    A("```")
    for s in uniq[:120]:
        A(s[:140])
    A("```")

    # 已知文件类型魔数探测（看是否内含 PNG/JSON/脚本）
    A("\n## 内嵌文件魔数探测\n")
    MAGICS = {b"\x89PNG": "PNG", b"PK\x03\x04": "ZIP/JAR", b"\x1f\x8b": "GZIP",
              b"BZh": "BZIP2", b"\x28\xb5\x2f\xfd": "ZSTD", b"OggS": "OGG",
              b"RIFF": "RIFF/WAV", b"{": "JSON-ish", b"[": "JSON array",
              b"\x7b\x0a": "JSON", b"SQLite": "SQLite", b"DDS": "DDS",
              b"LuaQ": "Lua 5.1 bytecode", b"\x1bLua": "Lua bytecode"}
    for p in paks:
        d = open(p, "rb").read()
        hits = []
        for m, name in MAGICS.items():
            n = d.count(m)
            if n:
                hits.append(f"{name}×{n}")
        if hits:
            A(f"- `{os.path.basename(p)}`: " + ", ".join(hits))
    if not any(True for _ in []):
        pass

    open(os.path.join(outdir, "pak-recon.md"), "w", encoding="utf-8").write("\n".join(L) + "\n")
    print("OK wrote pak-recon.md")


if __name__ == "__main__":
    main()
