#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""度量 SPAK 载荷中重复块的最大连续长度与周期结构。

若两处相同内容能连续匹配到"间距"以上，说明载荷本身存在**真周期**；
若只匹配几十字节，说明是"同一文件被存了两份"这类局部重复。
这决定了变换是 逐字节位置无关映射（可解）还是 带状态流密码（不可解）。
"""
import struct
import glob
import os
import sys
import collections

ASSETS = sys.argv[1] if len(sys.argv) > 1 else "02-apktool/assets"
OUT = sys.argv[2] if len(sys.argv) > 2 else "00-triage"


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


def extend_match(data, i, j, cap=300000):
    """从 i,j 起向后比较，返回匹配长度"""
    n = len(data)
    k = 0
    while k < cap and i + k < n and j + k < n:
        if data[i + k] != data[j + k]:
            break
        k += 1
    return k


def find_all_pairs(data, blk=32, max_pairs=12):
    """找出所有 32 字节完全相同的位置对"""
    seen = {}
    pairs = []
    i = 0
    n = len(data)
    while i < n - blk:
        k = data[i:i + blk]
        if k in seen:
            pairs.append((seen[k], i))
            if len(pairs) >= max_pairs:
                break
        else:
            seen[k] = i
        i += 1
    return pairs


def longest_run(data):
    """最长同值字节串"""
    best = (0, 0, 0)
    cur = 1
    start = 0
    for i in range(1, len(data)):
        if data[i] == data[i - 1]:
            cur += 1
        else:
            if cur > best[0]:
                best = (cur, start, data[start])
            cur = 1
            start = i
    if cur > best[0]:
        best = (cur, start, data[start])
    return best


def main():
    L = []
    A = L.append
    A("# SPAK 载荷重复块长度与周期结构度量\n")
    A("目的：判定变换是「逐字节位置无关映射」（可解）还是「带状态流密码」（不可解）。\n")

    groups = load_groups()
    summary = []
    for g, info in groups.items():
        payload, index = info["payload"], info["index"]
        A("## 组 `{}`\n".format(g))
        A("- 载荷 {} 字节 / 索引 {} 字节".format(len(payload), len(index)))
        A("")

        # 1. 最长同值字节串
        rl, ro, rv = longest_run(payload)
        A("### 1. 最长同值字节串")
        A("- 载荷中最长同值串：{} 字节（偏移 0x{:x}，值 0x{:02x}）".format(rl, ro, rv))
        A("- 判定：{}".format(
            "存在长同值串 → 存在未变换的填充区，**字节层变换成立**" if rl >= 32 else
            "无长同值串 → 整体已被充分打散"))
        A("")

        # 2. 32 字节重复对 + 匹配延伸长度
        pairs = find_all_pairs(payload, 32, 12)
        A("### 2. 32 字节重复对及其最大连续匹配长度")
        A("")
        A("| 位置1 | 位置2 | 间距 | 连续匹配长度 | 与间距关系 |")
        A("|---|---|---|---|---|")
        ext_info = []
        for p1, p2 in pairs:
            d = p2 - p1
            e = extend_match(payload, p1, p2)
            rel = "≥ 间距" if e >= d else "仅 {} 字节".format(e)
            A("| `0x{:x}` | `0x{:x}` | {} | {} | {} |".format(p1, p2, d, e, rel))
            ext_info.append((p1, p2, d, e))
        A("")
        if ext_info:
            mx = max(x[3] for x in ext_info)
            A("- 最大连续匹配长度：**{} 字节**".format(mx))
            if mx >= max(x[2] for x in ext_info):
                A("- 匹配长度 ≥ 间距 → 载荷在 **{} 字节周期**上自重复 →".format(
                    min(x[2] for x in ext_info if x[3] >= x[2]) if any(x[3] >= x[2] for x in ext_info) else 0))
                A("  **载荷本身是周期性的**，说明变换保位置且逐字节独立（可解）。")
            else:
                A("- 匹配长度 < 间距 → 只是**局部重复**（同一份文件被存了两遍），")
                A("  不能推出周期性。")
        A("")

        # 3. 索引区同样度量
        pairs_i = find_all_pairs(index, 16, 8)
        A("### 3. 索引区 16 字节重复对")
        if pairs_i:
            A("")
            A("| 位置1 | 位置2 | 间距 | 连续匹配长度 |")
            A("|---|---|---|---|")
            for p1, p2 in pairs_i:
                e = extend_match(index, p1, p2)
                A("| `0x{:x}` | `0x{:x}` | {} | {} |".format(p1, p2, p2 - p1, e))
            A("")
        else:
            A("- 无 16 字节重复对（索引区无局部重复结构）\n")

        # 4. 字节直方图极值
        cnt = collections.Counter(payload[:262144])
        top = cnt.most_common(5)
        bot = cnt.most_common()[-5:]
        A("### 4. 字节分布（载荷前 256KB）")
        A("- 最多：{}".format(", ".join("0x{:02x}×{}".format(b, c) for b, c in top)))
        A("- 最少：{}".format(", ".join("0x{:02x}×{}".format(b, c) for b, c in bot)))
        A("- 均匀期望：{} 次/字节".format(len(payload[:262144]) // 256))
        A("")

        summary.append((g, rl, max([x[3] for x in ext_info]) if ext_info else 0,
                        max([x[2] for x in ext_info]) if ext_info else 0))

    A("## 总判定\n")
    A("| 组 | 最长同值串 | 重复块最大匹配长度 | 最大间距 |")
    A("|---|---|---|---|")
    for g, rl, mx, md in summary:
        A("| `{}` | {} | {} | {} |".format(g, rl, mx, md))
    A("")

    open(os.path.join(OUT, "spak-repeat-extend.md"), "w", encoding="utf-8").write("\n".join(L) + "\n")
    print("OK -> spak-repeat-extend.md")
    for g, rl, mx, md in summary:
        print("  {}: longest_run={} max_match_extend={} max_gap={}".format(g, rl, mx, md))


if __name__ == "__main__":
    main()
