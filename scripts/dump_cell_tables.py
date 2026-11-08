#!/usr/bin/env python3
"""dump_cell_tables.py —— 把 libjunqi.so `.rodata` 里那几张**按格**的表全抓出来，排成 12×5。

动机（2026-09-14，玩家实报「第一排/最后一排/大本营的棋子不能移动，原版可以」）：
`FUN_0006919c`/`FUN_000692f0`/`FUN_000693f0`（走法生成）里**没有任何大本营判定**，
它们只查三样：`cell[0] != 0`（有子）、`cell+8 == 0`、`cell+4 != 0`（已翻开）、兵种∉{11,12}。
而**另一条**生成路径 `FUN_0006a098` 用的是**静态表** `DAT_00133cb4[i] == 0` 来代替 `cell+8 == 0`。
这张表是不是「该格棋子不可动」的静态标记？（若 大本营 4 格 = 非 0，就说明原版
**确实**冻结大本营；若全 0，就说明原版根本不冻。）

地址换算：Ghidra 镜像基址 0x10000 → 文件偏移 = 地址 − 0x10000。

用法:
  python dump_cell_tables.py [--so ../03-native/libjunqi.so]
"""

from __future__ import annotations

import argparse
import struct
from pathlib import Path

ROWS, COLS = 12, 5
CELLS = ROWS * COLS

# (名称, Ghidra 地址, 每项字节数, 说明)
TABLES = [
    ("步进表", 0x133350, 36, "走法生成用邻接；每格 9 个 int，-1 结尾"),
    ("铁路标志", 0x133bc4, 4, "非 0 = 该格在铁路上"),
    ("★表B", 0x133cb4, 4, "FUN_0006a098 用它当 offset8==0 的门闸"),
    ("安全格(14)", 0x133da4, 4, "40 行营 + 4 大本营"),
    ("安全格(10)", 0x133e94, 4, "仅 10 个行营"),
]

CAMP_CELLS = {11, 13, 17, 21, 23, 36, 38, 42, 46, 48}
BASE_CELLS = {1, 3, 56, 58}
# 铁路格：行 1/5/6/10 全宽 + 列 0/4 的 1~10 行
RAIL_CELLS = set()
for r in (1, 5, 6, 10):
    for c in range(5):
        RAIL_CELLS.add(r * 5 + c)
for c in (0, 4):
    for r in range(1, 11):
        RAIL_CELLS.add(r * 5 + c)


def grid(vals: list[int]) -> str:
    out = []
    for r in range(ROWS):
        row = []
        for c in range(COLS):
            i = r * COLS + c
            v = vals[i]
            mark = ""
            if i in BASE_CELLS:
                mark = "本"      # 大本营
            elif i in CAMP_CELLS:
                mark = "营"      # 行营
            row.append(f"{v:>3}{mark or '  '}")
        out.append(f"  行{r:>2} | " + " | ".join(row) + " |")
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--so", default=str(Path(__file__).resolve().parent.parent / "03-native" / "libjunqi.so"))
    args = ap.parse_args()

    data = Path(args.so).read_bytes()
    print(f"so = {args.so}  size={len(data)} (0x{len(data):x})\n")

    for name, addr, item, note in TABLES:
        off = addr - 0x10000
        n = CELLS * item
        if off + n > len(data):
            print(f"### {name} @0x{addr:x} fileoff=0x{off:x} —— 越界，跳过")
            continue
        if item == 36:
            # 步进表：每格 9 个 int，逐格解成邻接列表
            print(f"### {name} @0x{addr:x} fileoff=0x{off:x}  —— {note}")
            for r in range(ROWS):
                cells = []
                for c in range(COLS):
                    i = r * COLS + c
                    vals = struct.unpack_from("<9i", data, off + i * item)
                    nei = [v for v in vals if v != -1]
                    cells.append(f"{i:>2}:{','.join(map(str, nei)) or '-'}")
                print(f"  行{r:>2} | " + " | ".join(cells))
            print()
            continue

        vals = list(struct.unpack_from(f"<{CELLS}i", data, off))
        nz = [i for i, v in enumerate(vals) if v != 0]
        print(f"### {name} @0x{addr:x} fileoff=0x{off:x}  —— {note}")
        print(f"  非 0 格数 = {len(nz)}")
        print(grid(vals))
        if name.startswith("★表B") or name.startswith("安全格"):
            print(f"  非 0 格号: {sorted(nz)}")
        # 交叉校验
        if name == "铁路标志":
            print(f"  与『行 1/5/6/10 + 列 0/4 行1~10』一致: {set(nz) == RAIL_CELLS}")
        if name.startswith("安全格(14)"):
            print(f"  与『行营 ∪ 大本营』一致: {set(nz) == (CAMP_CELLS | BASE_CELLS)}")
        if name.startswith("安全格(10)"):
            print(f"  与『仅行营』一致: {set(nz) == CAMP_CELLS}")
        if name.startswith("★表B"):
            print(f"  大本营 4 格取值: {[(i, vals[i]) for i in sorted(BASE_CELLS)]}")
            print(f"  行营 10 格取值: {[(i, vals[i]) for i in sorted(CAMP_CELLS)]}")
        print()


if __name__ == "__main__":
    main()
