#!/usr/bin/env python3
"""
把 `libjunqi.so` 里的 AI 常量表全部抽出来（可复跑）。

    python scripts/ai_tables_extract.py

输出：
  · 03-native/ai_tables_from_so.json   —— 机器可读（供复刻工程 / 回归比对）
  · stdout                              —— TypeScript 字面量（可直接贴进 ai.ts）

## 关键坑：Ghidra 镜像基址 = 0x10000

反编译里出现的地址（`DAT_00153db8` 之类）**不是**文件里的 vaddr。
Ghidra 把整个镜像抬高了 0x10000，所以：

    文件 vaddr = Ghidra 地址 − 0x10000

再按节区做第二次平移才是 file offset。第一轮分析就是栽在这里 ——
按 1:1 读文件只会读到垃圾，于是得出"AI 没有可读常量表"的错误结论。
"""

import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SO = ROOT / "03-native" / "libjunqi.so"
OUT = ROOT / "03-native" / "ai_tables_from_so.json"

GHIDRA_BASE = 0x10000

# (vaddr, file_offset, size) —— 由 readelf -S 读出
SECTIONS = [
    (0x11AD10, 0x11AD10, 0x1C51C),  # .rodata
    (0x1382F0, 0x1372F0, 0x0FA0),   # .data.rel.ro.local
    (0x1392A0, 0x1382A0, 0x5BCC),   # .data.rel.ro
    (0x140000, 0x13F000, 0x02C4),   # .data
]


def load() -> bytes:
    return SO.read_bytes()


def offset_of(data: bytes, ghidra_addr: int) -> int:
    vaddr = ghidra_addr - GHIDRA_BASE
    for va, off, size in SECTIONS:
        if va <= vaddr < va + size:
            return off + (vaddr - va)
    raise ValueError(f"地址 0x{ghidra_addr:x} 不落在任何有文件内容的节区里")


def i32s(data: bytes, ghidra_addr: int, n: int) -> list[int]:
    off = offset_of(data, ghidra_addr)
    return [struct.unpack_from("<i", data, off + 4 * k)[0] for k in range(n)]


# ── 表地址（全部来自反编译引用点） ──────────────────────────────
ADDR = {
    "pieceValue": 0x15000C,      # .data   —— 类型 1..12，FUN_000695f0 逐项搬进 .bss
    "posBase": 0x132724,         # .rodata —— FUN_00068818 拷贝源
    "attackBase": 0x1329F4,      # .rodata —— FUN_00069840 拷贝源
    "ownPosExtra": 0x132814,     # .rodata
    "enemyPosExtra": 0x132904,   # .rodata
    "ownPosBonus": 0x133DA4,     # .rodata
    "enemyPosBonus": 0x133E94,   # .rodata
    "railMask": 0x133BC4,        # .rodata —— 60 项 0/1
    "baseMask": 0x133CB4,        # .rodata —— 60 项 0/1
    "adjacency": 0x132AE0,       # .rodata —— 步长 0x24，邻居表从 +4 起，-1 结尾
}

ORDER = [
    "司令", "军长", "师长", "旅长", "团长", "营长",
    "连长", "排长", "工兵", "炸弹", "地雷", "军旗",
]


def main() -> None:
    data = load()
    out: dict[str, object] = {}

    pv = i32s(data, ADDR["pieceValue"], 12)
    out["pieceValue"] = pv
    out["pieceValueNamed"] = {name: v for name, v in zip(ORDER, pv)}
    out["bombValueDynamic"] = pv[0] // 3  # 原版：炸弹 = 全场最高值 ÷ 3

    for key in ("posBase", "attackBase", "ownPosExtra", "enemyPosExtra",
                "ownPosBonus", "enemyPosBonus", "railMask", "baseMask"):
        out[key] = i32s(data, ADDR[key], 60)

    out["railCells"] = [i for i, v in enumerate(out["railMask"]) if v]
    out["baseCells"] = [i for i, v in enumerate(out["baseMask"]) if v]

    # 邻接表：步长 0x24，邻居从 +4 开始，-1 结束
    adj: list[list[int]] = []
    for i in range(60):
        off = offset_of(data, ADDR["adjacency"] + i * 0x24)
        nb, k = [], 0
        while True:
            v = struct.unpack_from("<i", data, off + 4 + 4 * k)[0]
            k += 1
            if v == -1:
                break
            nb.append(v)
            if k > 40:
                break
        adj.append(nb)
    out["adjacency"] = adj
    out["campCells"] = sorted(i for i, nb in enumerate(adj) if len(nb) == 8)

    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"✓ {OUT.relative_to(ROOT)}")
    print(f"  铁路格 {len(out['railCells'])} 个  大本营 {out['baseCells']}")
    print(f"  邻接表长度：{[len(a) for a in adj]}")
    print(f"  子力表：{dict(zip(ORDER, pv))}")
    print(f"  炸弹（动态）= {out['bombValueDynamic']}")
    print()
    print("// ── TS 字面量 ──")
    for key in ("posBase", "attackBase", "ownPosExtra", "enemyPosExtra",
                "ownPosBonus", "enemyPosBonus"):
        vals = out[key]
        rows = ["  " + " ".join(str(x) for x in vals[r * 20:(r + 1) * 20]) for r in range(3)]
        print(f"// {key}\n" + ",\n".join(rows))


if __name__ == "__main__":
    main()
