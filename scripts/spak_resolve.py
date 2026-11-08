#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SPAK 解包 + 资源名恢复（迭代收敛，最终版）

要点
----
容器索引只存 16 字节目录键（data 组 = MD5(路径)），不存明文名。恢复流程：
  候选名 = .rodata 字符串 + 清单路径 + 运行期模板展开(%d/%02d/%s)
           + 容器内文本/布局文件中挖出的引用
  -> MD5 匹配 -> 解出文件 -> 再挖引用 -> 再匹配（迭代至收敛）

输出
----
    OUTDIR/<真实路径>                      已恢复名字
    OUTDIR/_unresolved/<组>/<md5>.<ext>    键非路径MD5（datah/datax），用哈希命名
    ROOT/spak-manifest.json                全量清单（含类型/尺寸/状态）
    ROOT/name-recovery.md                  恢复率报告
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
ENTRY = 28

ROOTS = ["", "/", "data/", "data/config/", "data/ui/", "data/junqi/", "data/sg/",
         "data/ad/", "data/font/", "config/", "ui/", "junqi/", "sg/", "ad/", "font/"]
EXTS = ["", ".png", ".jpg", ".xml", ".cfg", ".txt", ".wav", ".ttf", ".dat", ".bin"]


def load_key(so_path):
    d = open(so_path, "rb").read()
    return d[DAT_KEY_VADDR - IMAGE_BASE: DAT_KEY_VADDR - IMAGE_BASE + 32]


def xor_key(data, key, phase=0):
    kl = len(key)
    return bytes(c ^ key[(phase + i) % kl] for i, c in enumerate(data))


def try_inflate(src, usize):
    for wb in (15, -15, 31):
        try:
            d = zlib.decompressobj(wb)
            out = d.decompress(src) + d.flush()
            if d.eof and d.unused_data == b"" and len(out) == usize:
                return out
        except Exception:
            pass
    return None


def decode_entry(blob, key, offset, csize, usize):
    src = blob[offset:offset + csize]
    if len(src) != csize:
        return None
    plain = xor_key(src, key, 0)
    if csize != usize:
        return try_inflate(plain, usize)
    return try_inflate(plain, usize) or plain


def sniff(data):
    for s, e in [(b"\x89PNG\r\n\x1a\n", "png"), (b"\xff\xd8", "jpg"), (b"GIF8", "gif"),
                 (b"BM", "bmp"), (b"OggS", "ogg"), (b"RIFF", "wav"), (b"ID3", "mp3"),
                 (b"\x00\x01\x00\x00", "ttf"), (b"OTTO", "otf")]:
        if data.startswith(s):
            return e
    if data[:1] in (b"<",) or data[:5] == b"<?xml":
        return "xml"
    if data[:4] == b"\x78\x9c\xda\xed" or data[:2] in (b"\x78\x9c", b"\x78\x01", b"\x78\xda"):
        return "z"
    return "bin"


def png_size(d):
    if d[:8] == b"\x89PNG\r\n\x1a\n" and len(d) >= 24:
        w, h = struct.unpack(">II", d[16:24])
        return w, h
    return None


def load_index(blob, key):
    _, _, idx_off, idx_cs, _, idx_raw = struct.unpack_from("<6I", blob, 0)
    for ph in range(32):
        out = try_inflate(xor_key(blob[idx_off:idx_off + idx_cs], key, ph), idx_raw)
        if out is not None:
            return out
    return None


def mine(buf):
    out = set()
    try:
        txt = buf.decode("gbk")
    except Exception:
        try:
            txt = buf.decode("utf-8")
        except Exception:
            return out
    for m in re.finditer(r'[A-Za-z0-9_./\\\-]{2,60}', txt):
        out.add(m.group())
    for m in re.finditer(r'(?:image|file|back|bg|icon)\s*=\s*"([^"]+)"', txt, re.I):
        out.add(m.group(1))
    return out


def expand_templates(s):
    """展开 %d / %02d / %04d 模板（限制范围，避免组合爆炸）"""
    res = set()
    if "%" not in s or len(s) > 80:
        return res
    if r"%02d" in s:
        for n in range(0, 60):
            res.add(s.replace(r"%02d", "%02d" % n))
    if r"%04d" in s:
        for n in range(0, 400):
            res.add(s.replace(r"%04d", "%04d" % n))
    if r"%d" in s:
        for n in range(0, 400):
            res.add(s.replace(r"%d", str(n)))
    return res


def variant_names(name):
    base = name.replace("\\", "/").lstrip("/")
    out = set()
    for r in ROOTS:
        out.add(r + base)
        if "." in os.path.basename(base):
            out.add(r + base.rsplit(".", 1)[0])
        else:
            for e in (".png", ".jpg", ".xml", ".cfg", ".txt", ".wav", ".ttf"):
                out.add(r + base + e)
    out.add(base)
    return out


def main():
    key = load_key(SO)
    groups = collections.defaultdict(list)
    for p in sorted(glob.glob(os.path.join(ASSETS, "*.pak"))):
        b = os.path.basename(p)
        groups[b[:-4].rstrip("0123456789")].append(p)

    entries = []
    for g, fs in groups.items():
        blob = b"".join(open(x, "rb").read() for x in sorted(fs))
        if blob[:4] != b"SPAK":
            continue
        idx = load_index(blob, key)
        if idx is None:
            continue
        for i in range(len(idx) // ENTRY):
            rec = idx[i * ENTRY:(i + 1) * ENTRY]
            md5 = rec[0:16]
            off, cs, us = struct.unpack_from("<3I", rec, 16)
            entries.append([g, i, md5, off, cs, us, decode_entry(blob, key, off, cs, us)])
    print("索引条目：{}".format(len(entries)))
    p2e = {}
    for e in entries:
        p2e.setdefault(e[2], e)

    # 初始候选
    cands = set()
    for line in open(os.path.join("03-native", "strings.tsv"), encoding="utf-8", errors="ignore"):
        if line.startswith("#") or line.count("\t") < 2:
            continue
        cands.add(line.rstrip("\n").split("\t")[2])
    mani = os.path.join("03-native", "asset-manifest.md")
    if os.path.exists(mani):
        for line in open(mani, encoding="utf-8"):
            m = re.search(r"\| `([^`]+)` \|$", line.strip())
            if m:
                cands.add(m.group(1))
    # 模板展开
    for c in list(cands):
        cands |= expand_templates(c)
    print("初始候选名：{}".format(len(cands)))

    named = {}
    for it in range(8):
        added = 0
        for c in list(cands):
            for v in variant_names(c):
                h = hashlib.md5(v.encode()).digest()
                if h in p2e and h not in named:
                    named[h] = v.lstrip("/")
                    added += 1
        for h, nm in list(named.items()):
            e = p2e[h]
            if e[6]:
                for s in mine(e[6]):
                    if s not in cands:
                        cands.add(s)
                        cands |= expand_templates(s)
        print("  迭代{}：新增 {}，累计 {}/{}".format(it + 1, added, len(named), len(entries)))
        if added == 0:
            break

    import shutil
    un = os.path.join(OUTDIR, "_unresolved")
    if os.path.isdir(un):
        shutil.rmtree(un)

    manifest = []
    ok = 0
    for g, i, md5, off, cs, us, data in entries:
        if data is None:
            manifest.append(dict(group=g, idx=i, md5=md5.hex(), name=None, status="decode-fail"))
            continue
        ok += 1
        nm = named.get(md5)
        ext = sniff(data)
        if nm:
            path = nm
        else:
            path = "_unresolved/{}/{}.{}".format(g, md5.hex(), ext)
        op = os.path.join(OUTDIR, path.replace("/", os.sep))
        os.makedirs(os.path.dirname(op), exist_ok=True)
        open(op, "wb").write(data)
        rec = dict(group=g, idx=i, md5=md5.hex(), name=nm, ext=ext,
                   offset=off, csize=cs, usize=us, size=len(data), status="ok")
        if ext == "png":
            sz = png_size(data)
            if sz:
                rec["wh"] = "{}x{}".format(*sz)
        manifest.append(rec)

    os.makedirs(ROOT, exist_ok=True)
    json.dump(manifest, open(os.path.join(ROOT, "spak-manifest.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    resolved = sum(1 for m in manifest if m["name"])
    print("\n解密解压：{}/{}  恢复文件名：{}/{}".format(ok, len(entries), resolved, len(entries)))

    with open(os.path.join(ROOT, "name-recovery.md"), "w", encoding="utf-8") as f:
        f.write("# SPAK 资源名恢复报告\n\n")
        f.write("| 指标 | 数值 |\n|---|---|\n")
        f.write("| 索引条目总数 | {} |\n".format(len(entries)))
        f.write("| 成功解密解压 | {} |\n".format(ok))
        f.write("| 恢复真实文件名 | {} |\n".format(resolved))
        f.write("| 仅以哈希命名 | {} |\n".format(ok - resolved))
        byg = collections.defaultdict(list)
        for m in manifest:
            if m["name"]:
                byg[m["group"]].append(m["name"])
        for g in sorted(byg):
            f.write("\n## 组 `{}` 已恢复（{}）\n\n".format(g, len(byg[g])))
            for n in sorted(byg[g]):
                f.write("- `{}`\n".format(n))


if __name__ == "__main__":
    main()
