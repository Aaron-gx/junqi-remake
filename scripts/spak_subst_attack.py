#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SPAK 逐字节替换密码（S-box）攻击。

推理链：
  1. 密文中存在**逐字节完全相同**的 8/16/32 字节块（例如 datah 组 0x1110 与 0x19e8 完全相同）。
     随机数据出现 32 字节完全重复的概率约 2^-256，故必为真实重复。
  2. data 组重复间距 69（=3×23）、datah 组间距 2264（=8×283）、datax 组间距 38688（=2^5×3×13×31），
     三者最大公约数为 1 → 「重复密钥异或」要求密钥周期整除 1，即单字节异或，与熵=8.0 及
     卡方检验结果不符。
  3. 结论：变换是**逐字节位置无关的替换** C[i] = S[P[i]]（S 为 256 字节置换表）。
     该假设同时满足：任意间距可重复、熵不变、IoC 不变、无标准加密常量。

攻击方法：
  A. 轮换扫描：单字节 XOR / 加减 / 仿射（S[x]=a*x+b）全空间扫描，检索 PNG/XML/压缩流魔数。
  B. 已知明文 crib 求解 S：把内建资源路径在密文上滑动，收集 S[C[i]] = P[i] 约束；
     正确对齐的映射无矛盾，随机对齐会迅速出现矛盾。据此定位明文并还原 S。
"""
import struct
import glob
import os
import sys
import collections

ASSETS = sys.argv[1] if len(sys.argv) > 1 else "02-apktool/assets"
OUT = sys.argv[2] if len(sys.argv) > 2 else "00-triage"

CRIBS = [
    "data/config/ui.xml", "data/config/font.xml", "data/config/string.xml",
    "data/config/path.xml", "data/config/sound.xml", "data/base.cfg",
    "data/sg/board.png", "data/sg/piece.png", "data/sg/word.png",
    "data/sg/back.jpg", "data/sg/scene.cfg", "data/junqi/main.cfg",
    "maindlg.xml", "gamedlg.xml", "inputdlg.xml", "aboutdlg.xml",
    "layname.txt", "env.cfg", "envx.cfg", "data/config/ui.xml",
]

MAGICS = [
    (b"\x89PNG\r\n\x1a\n", "PNG 文件头"),
    (b"IHDR", "PNG IHDR"),
    (b"IDAT", "PNG IDAT"),
    (b"IEND", "PNG IEND"),
    (b"<?xml", "XML 声明"),
    (b"<lay", "布局 XML"),
    (b"<dlg", "对话框 XML"),
    (b"\x1f\x8b\x08", "GZIP"),
    (b"78\x9c", "ZLIB(默认)"),
    (b"78\xda", "ZLIB(最大)"),
    (b"PK\x03\x04", "ZIP"),
    (b"\xff\xd8\xff", "JPEG"),
    (b"data/config/", "配置路径明文"),
    (b"data/sg/", "棋盘路径明文"),
]


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
        # 布局: [16 字节头][载荷 f8 字节][索引 (f12-16) 字节]，且 f8 + f12 == 文件总长
        payload = blob[16:16 + f8]
        index = blob[16 + f8:f8 + f12]
        out[g] = dict(blob=blob, payload=payload, index=index, f8=f8, f12=f12)
    return out


def scan_xor(data, label):
    """256 个单字节异或密钥，检索魔数"""
    hits = []
    for k in range(256):
        if k == 0:
            dd = data
        else:
            tbl = bytes(b ^ k for b in range(256))
            dd = data.translate(tbl)
        for magic, name in MAGICS:
            if magic in dd:
                hits.append((k, name, dd.find(magic)))
    return hits


def scan_add(data, label):
    """256 个加减常量 C[i] = P[i] + c"""
    hits = []
    for c in range(1, 256):
        tbl = bytes((b + c) & 0xFF for b in range(256))
        dd = data.translate(tbl)
        for magic, name in MAGICS:
            if magic in dd:
                hits.append((c, name, dd.find(magic)))
    return hits


def scan_affine(data, label, step=1):
    """仿射替换 S[x] = (a*x + b) & 0xFF，a 为奇数"""
    hits = []
    for a in range(1, 256, 2):
        tbl = bytes((a * b) & 0xFF for b in range(256))
        inv = data.translate(tbl)          # 相当于乘 a
        for b in range(256):
            dd = inv.translate(bytes((x + b) & 0xFF for x in range(256)))
            for magic, name in MAGICS:
                if magic in dd:
                    hits.append((a, b, name, dd.find(magic)))
    return hits


def crib_sbox(data, region_name, cribs, max_off=None):
    """把 crib 在密文上滑动，收集 S[C[i]]=P[i] 约束，找无矛盾的对齐位置。
    返回 (offset, mapping, coverage) 列表，按覆盖字节数排序。"""
    results = []
    n = len(data) if max_off is None else min(len(data), max_off)
    for crib in cribs:
        cb = crib.encode("latin-1")
        L = len(cb)
        if L > n:
            continue
        for off in range(0, n - L + 1):
            m = {}
            bad = False
            for i in range(L):
                c = data[off + i]
                p = cb[i]
                prev = m.get(c)
                if prev is None:
                    m[c] = p
                elif prev != p:
                    bad = True
                    break
            if not bad and len(m) >= 6:
                results.append((off, len(m), crib))
    # 合并同一 offset 的不同 crib 结果
    merged = {}
    for off, cov, crib in results:
        merged.setdefault(off, []).append((cov, crib))
    out = []
    for off, lst in merged.items():
        lst.sort(reverse=True)
        out.append((off, sum(c for c, _ in lst), len(lst), lst[0][1]))
    out.sort(key=lambda x: (-x[1], -x[2]))
    return out[:15]


def main():
    L = []
    A = L.append
    A("# SPAK 逐字节替换（S-box）攻击\n")
    A("## 假设\n")
    A("已证实：密文中存在逐字节完全相同的 32 字节块（随机概率 2^-256）。")
    A("且三组重复间距 69 / 2264 / 38688 的最大公约数为 1，")
    A("故「周期密钥异或」要求周期=1，与实测熵 8.0 矛盾。")
    A("→ 变换为**位置无关的逐字节替换** C[i] = S[P[i]]。\n")

    groups = load_groups()
    overall = []
    for g, info in groups.items():
        payload, index = info["payload"], info["index"]
        A("## 组 `{}`\n".format(g))
        A("- 载荷 {} 字节 / 索引 {} 字节（f8={} f12={}）".format(
            len(payload), len(index), info["f8"], info["f12"]))
        A("")

        # ---- A. 全空间扫描 ----
        A("### A. 单字节 XOR / 加减 / 仿射 全空间扫描\n")
        for label, data in (("索引区", index), ("载荷前 256KB", payload[:262144])):
            xh = scan_xor(data, label)
            ah = scan_add(data, label)
            A("**{}**\n".format(label))
            A("| 变换 | 密钥 | 命中魔数 | 位置 |")
            A("|---|---|---|---|")
            if xh:
                for k, name, pos in xh[:10]:
                    A("| XOR | `0x{:02x}` | {} | 0x{:x} |".format(k, name, pos))
            if ah:
                for c, name, pos in ah[:10]:
                    A("| ADD | `{}` | {} | 0x{:x} |".format(c, name, pos))
            if not xh and not ah:
                A("| — | — | 无命中 | — |")
            A("")
            A("- {}".format("**存在候选密钥**" if (xh or ah) else "XOR/ADD 全空间无魔数命中"))
            A("")

        # ---- B. crib 求解 S ----
        A("### B. 已知明文 crib 求解替换表 S\n")
        for label, data, cap in (("索引区", index, None), ("载荷前 64KB", payload[:65536], None)):
            res = crib_sbox(data, label, CRIBS, cap)
            A("**{}**（无矛盾对齐点 Top 15）\n".format(label))
            A("| 偏移 | 覆盖密文字节数 | 命中 crib 数 | 最佳 crib |")
            A("|---|---|---|---|")
            for off, cov, cnt, crib in res:
                A("| `0x{:x}` | {} | {} | `{}` |".format(off, cov, cnt, crib))
            A("")
            if res and res[0][1] >= 20:
                A("> **强候选**：偏移 `0x{:x}` 处覆盖 {} 个不同密文字节且无矛盾，".format(res[0][0], res[0][1]))
                A("> 与明文路径 `{}` 一致。可据此扩展还原完整替换表。".format(res[0][3]))
            elif res:
                A("> 覆盖度偏低，尚不足以确认。（随机数据也能出现少量无矛盾短对齐）")
            A("")
            overall.append((g, label, res[0] if res else None))

        # ---- C. 重复块统计 ----
        A("### C. 重复块统计（验证「替换」假设）\n")
        scope = payload[:262144]
        seen = {}
        dup = 0
        first = []
        for i in range(0, len(scope) - 8):
            k = scope[i:i + 8]
            if k in seen:
                dup += 1
                if len(first) < 8:
                    first.append((k, seen[k], i, i - seen[k]))
            else:
                seen[k] = i
        A("- 统计范围：载荷前 {} 字节".format(len(scope)))
        A("- 8 字节窗口重复次数：**{}**".format(dup))
        A("- 随机数据期望重复数 ≈ {:.2e} 次（{:.0e} 个窗口对的碰撞概率 2^-64）".format(
            (len(scope) ** 2) / 2.0 / (2 ** 64), (len(scope) ** 2) / 2.0))
        A("")
        A("| 重复内容 | 位置1 | 位置2 | 间距 |")
        A("|---|---|---|---|")
        for k, p1, p2, d in first:
            A("| `{}` | `0x{:x}` | `0x{:x}` | {} |".format(k.hex(), p1, p2, d))
        A("")

    A("## 总判定\n")
    A("| 组 | 区域 | 最佳无矛盾对齐 | 覆盖字节 |")
    A("|---|---|---|---|")
    for g, label, best in overall:
        if best:
            A("| `{}` | {} | `0x{:x}` | {} |".format(g, label, best[0], best[1]))
        else:
            A("| `{}` | {} | 无 | 0 |".format(g, label))
    A("")
    A("若覆盖字节数达到 30+，即可把 S 表外推解出全部资源；")
    A("否则需回到 `.so` 取 S 表（它极可能就以 256 字节常量表形式存在于 `.rodata` 中——")
    A("可直接在 rodata 里搜一段 0..255 的置换表来定位）。")

    open(os.path.join(OUT, "spak-substitution-attack.md"), "w", encoding="utf-8").write("\n".join(L) + "\n")
    print("OK -> spak-substitution-attack.md")
    for g, label, best in overall:
        print("  {} / {}: best_align={} coverage={}".format(g, label, best[0] if best else None, best[1] if best else 0))


if __name__ == "__main__":
    main()
