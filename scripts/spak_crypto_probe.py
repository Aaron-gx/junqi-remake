#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SPAK 载荷密码学指纹探测。
目的：在反编译 .so 之前，先用统计手段判断加密类型：
      - 简单异或流密码（固定/周期密钥）→ 可当场破解
      - 分组密码 / 带状态流密码 → 必须回到 .so 还原算法
判据：
  A. 重复块检测：若明文含长零填充，周期密钥会产出"重复的密文块"，可反推密钥周期与密钥本身
  B. 自相关：若存在周期 L，则 C[i]^C[i+L] 的匹配率显著高于随机基线(1/256≈0.39%)
  C. 字节频率均匀性（卡方）确认无残留结构
"""
import struct
import glob
import os
import math
import collections
import sys

ASSETS = sys.argv[1] if len(sys.argv) > 1 else "02-apktool/assets"
OUT = sys.argv[2] if len(sys.argv) > 2 else "00-triage"


def shannon(b):
    if not b:
        return 0.0
    c = collections.Counter(b)
    n = len(b)
    return -sum((v / n) * math.log2(v / n) for v in c.values())


def load_groups():
    groups = collections.defaultdict(list)
    for p in sorted(glob.glob(os.path.join(ASSETS, "*.pak"))):
        b = os.path.basename(p)
        g = b.split("0.pak")[0] if "0.pak" in b else b.split("1.pak")[0]
        groups[g].append(p)
    out = {}
    for g, fs in groups.items():
        fs = sorted(fs)
        blob = b"".join(open(x, "rb").read() for x in fs)
        if blob[:4] != b"SPAK":
            continue
        f8, f12 = struct.unpack_from("<II", blob, 8)
        out[g] = dict(files=fs, blob=blob, payload_size=f8, index_size=f12)
    return out


def repeated_blocks(data, blk=16, max_report=5):
    """找出重复出现的定长块（周期性密钥的强指纹）"""
    seen = {}
    hits = []
    for i in range(0, len(data) - blk, 1):
        k = data[i:i + blk]
        if k in seen:
            d = i - seen[k]
            hits.append((k, seen[k], i, d))
            if len(hits) >= max_report:
                break
        else:
            seen[k] = i
    return hits


def match_rate(data, lag, sample=400000):
    """计算 C[i] == C[i+lag] 的比例（随机基线 1/256）"""
    n = min(len(data) - lag, sample)
    if n <= 0:
        return 0.0, 0
    step = 1
    if n > sample:
        step = n // sample
    same = 0
    tot = 0
    i = 0
    while i < n:
        if data[i] == data[i + lag]:
            same += 1
        tot += 1
        i += step
    return (same / tot if tot else 0.0), tot


def chi2(data, sample=200000):
    d = data[:sample]
    n = len(d)
    exp = n / 256.0
    cnt = collections.Counter(d)
    s = 0.0
    for v in range(256):
        o = cnt.get(v, 0)
        s += (o - exp) ** 2 / exp
    return s, 255   # 卡方值, 自由度


def main():
    L = []
    A = L.append
    A("# SPAK 载荷密码学指纹探测\n")
    groups = load_groups()
    A("共识别 {} 组容器\n".format(len(groups)))

    verdicts = []
    for g, info in groups.items():
        blob = info["blob"]
        payload = blob[16:16 + info["payload_size"]]
        index = blob[16 + info["payload_size"]:16 + info["payload_size"] + info["index_size"]]

        A("## 组 `{}`".format(g))
        A("")
        A("- 分片: {}".format(", ".join(os.path.basename(x) for x in info["files"])))
        A("- 载荷 {} 字节 / 索引 {} 字节 / 总计 {} 字节".format(
            len(payload), len(index), len(blob)))
        A("- 载荷熵 {:.4f} | 索引熵 {:.4f}".format(shannon(payload), shannon(index)))

        # A. 重复块
        A("")
        A("### A. 重复定长块检测（周期密钥指纹）")
        found_any = False
        for blk in (8, 16, 32):
            h = repeated_blocks(payload, blk, max_report=3)
            if h:
                found_any = True
                for k, p1, p2, dist in h:
                    A("- **命中** 块长 {}: 位置 `0x{:x}` 与 `0x{:x}` 重复（间距 {} = 0x{:x}） 内容 `{}`".format(
                        blk, p1, p2, dist, dist, k.hex()))
            else:
                A("- 块长 {}: 无重复（前 3 处抽样）".format(blk))
        if not found_any:
            A("")
            A("> 未发现重复块 → **不是固定周期异或密钥**，或明文不含长零填充。")

        # B. 自相关
        A("")
        A("### B. 自相关（随机基线 0.391%）")
        A("")
        A("| lag | 匹配率 | 样本数 | 结论 |")
        A("|---|---|---|---|")
        best = (0.0, 0)
        for lag in (1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 4096):
            r, tot = match_rate(payload, lag)
            flag = ""
            if r > 0.05:
                flag = "**显著周期！**"
            elif r > 0.01:
                flag = "偏高"
            A("| {} | {:.4f}% | {} | {} |".format(lag, r * 100, tot, flag))
            if r > best[0]:
                best = (r, lag)

        # C. 卡方
        cs, dof = chi2(payload)
        A("")
        A("### C. 字节频率卡方检验")
        A("")
        A("- 卡方值 {:.1f}（自由度 {}，理想随机期望约 {}）".format(cs, dof, dof))
        A("- 判定: {}".format(
            "分布均匀，符合加密/压缩输出" if abs(cs - dof) < 6 * math.sqrt(2 * dof) else "分布偏离随机，存在可利用结构"))
        A("")

        verdicts.append((g, best[0], best[1], found_any))

    A("## 总判定\n")
    A("| 组 | 最高自相关匹配率 | 对应 lag | 是否发现重复块 |")
    A("|---|---|---|---|")
    for g, r, lag, rep in verdicts:
        A("| `{}` | {:.4f}% | {} | {} |".format(g, r * 100, lag, "是" if rep else "否"))
    A("")
    A("**结论**：")
    any_rep = any(v[3] for v in verdicts)
    max_r = max(v[1] for v in verdicts) if verdicts else 0
    if any_rep or max_r > 0.05:
        A("- 检测到周期性特征 → 存在简单异或类密码的可能，可尝试直接还原密钥。")
    else:
        A("- 无周期性、无重复块、字节分布均匀 → **不是固定周期异或**，判为")
        A("  分组密码或带状态流密码（或与压缩级联）。纯数据侧无法破解，")
        A("  **必须反编译 `libjunqi.so` 还原解密函数**，或走 Frida 动态 dump。")

    open(os.path.join(OUT, "spak-crypto-probe.md"), "w", encoding="utf-8").write("\n".join(L) + "\n")
    print("OK -> spak-crypto-probe.md")
    for g, r, lag, rep in verdicts:
        print("  {}: max_match={:.4f}% lag={} repeated_block={}".format(g, r * 100, lag, rep))


if __name__ == "__main__":
    main()
