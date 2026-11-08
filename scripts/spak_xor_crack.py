#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SPAK 载荷密码分析：重复密钥异或判定与还原。

依据（前一步实证）：密文中存在逐字节完全相同的 32 字节块，且重复间距
2264 与 38688 的最大公约数为 8 → 变换保位置、密钥周期很可能整除 8。

方法（标准古典密码分析流程）：
  A. 重合指数(IoC)周期检测：对候选周期 p，把密文切成 p 列并求各列 IoC 均值。
     随机数据 IoC≈0.0039；ASCII 文本 IoC≈0.06~0.09。峰值即真周期。
  B. 周期确定后，逐列做单字节还原（按文本可读性打分），拼出完整密钥。
  C. 用密钥解密，检索内建资源路径，验证是否命中已知明文。
"""
import struct
import glob
import os
import collections
import sys

ASSETS = sys.argv[1] if len(sys.argv) > 1 else "02-apktool/assets"
OUT = sys.argv[2] if len(sys.argv) > 2 else "00-triage"

KNOWN = [
    "data/config/ui.xml", "data/config/font.xml", "data/config/string.xml",
    "data/config/path.xml", "data/config/sound.xml", "data/base.cfg",
    "data/sg/board.png", "data/sg/piece.png", "data/sg/word.png",
    "data/sg/back.jpg", "data/sg/scene.cfg", "data/junqi/main.cfg",
    "maindlg.xml", "gamedlg.xml", "inputdlg.xml", "aboutdlg.xml",
    "layname.txt", "env.cfg", "envx.cfg", "data.pak", "datax.pak", "datah.pak",
    ".png", ".xml", ".cfg", "data/",
]
RANDOM_IOC = 1.0 / 256


def ioc(b):
    n = len(b)
    if n < 2:
        return 0.0
    c = collections.Counter(b)
    return sum(v * (v - 1) for v in c.values()) / (n * (n - 1))


def column_ioc(data, p):
    """周期 p 下各列 IoC 的均值"""
    vals = []
    for r in range(p):
        col = data[r::p]
        if len(col) >= 8:
            vals.append(ioc(col))
    return sum(vals) / len(vals) if vals else 0.0


def detect_period(data, pmax=64):
    rows = []
    for p in range(1, pmax + 1):
        rows.append((p, column_ioc(data, p)))
    return rows


PRINTABLE = set(range(0x20, 0x7f))


def text_score(b):
    if not b:
        return -99.0
    good = 0
    for c in b:
        if c in PRINTABLE:
            good += 1
        elif c in (0x09, 0x0a, 0x0d):
            good += 0.3
        else:
            good -= 3.0
    return good / len(b)


def recover_key(data, p, sample=60000):
    """逐列选出让该列最像文本的单字节密钥"""
    key = bytearray()
    for r in range(p):
        col = data[r::p][:max(1, sample // p)]
        best = (-99.0, 0)
        for k in range(256):
            sc = text_score(bytes(c ^ k for c in col[:3000]))
            if sc > best[0]:
                best = (sc, k)
        key.append(best[1])
    return bytes(key)


def xor(data, key):
    kl = len(key)
    return bytes(data[i] ^ key[i % kl] for i in range(len(data)))


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
        out[g] = dict(blob=blob, payload=blob[16:16 + f8], index=blob[16 + f8:16 + f12])
    return out


def main():
    L = []
    A = L.append
    A("# SPAK 重复密钥异或：周期检测与密钥还原\n")
    A("方法：重合指数(IoC)周期检测 → 逐列单字节还原 → 已知明文验证。")
    A("判据：随机数据 IoC ≈ {:.4f}；ASCII 文本 IoC ≈ 0.06~0.09。\n".format(RANDOM_IOC))

    groups = load_groups()
    results = []
    for g, info in groups.items():
        index = info["index"]
        payload = info["payload"]
        A("## 组 `{}`\n".format(g))

        # ---------- A. 周期检测 ----------
        A("### A. 重合指数周期检测\n")
        for label, data, pmax in (("索引区", index, 64), ("载荷头部 64KB", payload[:65536], 64)):
            rows = detect_period(data, pmax)
            A("**{}**（{} 字节）\n".format(label, len(data)))
            A("| 周期 | 列 IoC 均值 | 相对随机倍数 |")
            A("|---|---|---|")
            top = sorted(rows, key=lambda r: -r[1])[:8]
            for p, v in sorted(top):
                A("| {} | {:.5f} | {:.1f}× |".format(p, v, v / RANDOM_IOC))
            A("")
            best_p, best_v = top[0]
            A("- 最高：周期 **{}**，IoC {:.5f}（{:.1f}× 随机）".format(best_p, best_v, best_v / RANDOM_IOC))
            A("- {}".format(
                "**显著偏离随机 → 周期成立**" if best_v > RANDOM_IOC * 3 else
                "与随机无异 → 该区不是重复密钥异或"))
            A("")
            if label == "索引区":
                idx_best = (best_p, best_v)

        # ---------- B. 尝试还原 ----------
        A("### B. 按检测周期尝试还原并验证\n")
        A("| 假设周期 | 还原密钥(hex) | 命中已知明文条数 | 解密样本 |")
        A("|---|---|---|---|")
        hit_any = False
        cand_periods = sorted(set([1, 2, 4, 8, 16, idx_best[0]]))
        for p in cand_periods:
            if len(index) < p * 8:
                continue
            key = recover_key(index, p)
            dec = xor(index, key)
            hits = [k for k in KNOWN if k.encode("latin-1") in dec]
            sample = dec[:48]
            vis = "".join(chr(c) if 32 <= c < 127 else "." for c in sample)
            A("| {} | `{}` | {} | `{}` |".format(p, key.hex(), len(hits), vis))
            if hits:
                hit_any = True
                A("")
                A("> **命中明文**：{}".format(", ".join(hits[:10])))
                A("")

        # ---------- C. 单字节兜底 ----------
        A("### C. 单字节异或全量爆破（兜底）\n")
        A("| 区 | 最佳密钥 | 评分 | 样本 |")
        A("|---|---|---|---|")
        for label, data in (("索引区", index), ("载荷头", payload[:4096])):
            best = (-99.0, 0)
            for k in range(256):
                sc = text_score(bytes(c ^ k for c in data[:2048]))
                if sc > best[0]:
                    best = (sc, k)
            dec = bytes(c ^ best[1] for c in data[:48])
            vis = "".join(chr(c) if 32 <= c < 127 else "." for c in dec)
            A("| {} | `0x{:02x}` | {:.3f} | `{}` |".format(label, best[1], best[0], vis))
        A("")

        results.append((g, idx_best, hit_any))

    A("## 总判定\n")
    A("| 组 | 索引区最佳周期 | IoC | 是否还原出明文 |")
    A("|---|---|---|---|")
    for g, (bp, bv), h in results:
        A("| `{}` | {} | {:.5f} | {} |".format(g, bp, bv, "是" if h else "否"))
    A("")
    if any(h for _, _, h in results):
        A("**结论：SPAK 载荷是可解的重复密钥异或，资源可直接解出。**")
    else:
        A("**结论：IoC 未显著偏离随机、单字节爆破无果 → 载荷不是重复密钥异或。**")
        A("")
        A("结合此前的确凿证据（存在逐字节完全相同的 32 字节块），可以收敛为：")
        A("")
        A("> 变换**保位置且逐字节独立**（排除了 CBC/CTR 等链式或带状态模式），")
        A("> 但密钥**随位置变化**（不是重复密钥），即")
        A("> **按偏移取密钥的逐字节替换**——密钥序列由代码生成（可能来自一个 PRNG 或")
        A("> 一张与文件等长的密钥表）。重复块之所以出现，是因为明文自身在那些位置重复")
        A("> （例如索引表的固定字段），而密钥在间距 8 的倍数处恰好同相。")
        A("")
        A("**下一步（必经之路）**：在 Ghidra 中定位 SPAK 解析函数，取出密钥生成逻辑；")
        A("或用 Frida 在 `Java_com_cnvcs_App_OnCreate` 处 hook 资源挂载，直接 dump 明文。")

    open(os.path.join(OUT, "spak-xor-crack.md"), "w", encoding="utf-8").write("\n".join(L) + "\n")
    print("OK -> spak-xor-crack.md")
    for g, (bp, bv), h in results:
        print("  {}: best_period={} ioc={:.5f} plaintext_recovered={}".format(g, bp, bv, h))


if __name__ == "__main__":
    main()
