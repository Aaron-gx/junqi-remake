"""在 .rodata 中定位「60×0x24 + 邻居以 -1 结尾 + 值域 0..59」的步进邻接表。

Ghidra 地址 = 文件/虚拟地址 + 0x10000，所以记忆里的 0x132ae0 应对应 0x122ae0 附近。
本脚本不猜地址，直接按结构特征扫描 .rodata。
"""
import struct
from pathlib import Path

SO = Path("E:/Learn/MeProject/2026.9.10-reverse/work/2026.9.10-base-apk/03-native/libjunqi.so")
buf = SO.read_bytes()
RODATA_START, RODATA_SIZE = 0x11AD10, 0x1C51C
STRIDE = 0x24


def read_table(base: int):
    """按 60 行 stride 解析；返回 (rows, ok)"""
    rows = []
    for i in range(60):
        off = base + i * STRIDE
        ns, p = [], off + 4
        while True:
            v = struct.unpack_from("<i", buf, p)[0]
            if v == -1:
                break
            if v < 0 or v > 59 or len(ns) > 8:
                return None, False
            ns.append(v)
            p += 4
        rows.append(ns)
    return rows, True


hits = []
for base in range(RODATA_START, RODATA_START + RODATA_SIZE - 60 * STRIDE, 4):
    rows, ok = read_table(base)
    if ok:
        deg = sorted(len(r) for r in rows)
        # 邻接表特征：每格至少 2 个邻居、度数不超过 8
        if deg[0] >= 2 and deg[-1] <= 8:
            hits.append((base, sum(len(r) for r in rows), deg[5], deg[-1]))

print(f"命中 {len(hits)} 处（base, 边数, 中位度, 最大度）:")
for h in hits[:20]:
    print(f"  fileoff {h[0]:#x}  边={h[1]}  中位度={h[2]}  最大度={h[3]}")

if hits:
    base = hits[0][0]
    rows, _ = read_table(base)
    print(f"\n=== 第一处 {base:#x} 前 12 格 ===")
    for i in range(12):
        print(f"  cell {i:2d} ({i//5},{i%5}): {rows[i]}")
    deg8 = [i for i in range(60) if len(rows[i]) == 8]
    print("度为 8 的格:", deg8)
    print("度数分布:", {d: sum(1 for r in rows if len(r) == d) for d in sorted({len(r) for r in rows})})
    import json
    Path("E:/Learn/MeProject/2026.9.10-reverse/work/2026.9.10-base-apk/03-native/adjacency_scan.json").write_text(
        json.dumps({"base": base, "rows": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    print("已写入 03-native/adjacency_scan.json")
