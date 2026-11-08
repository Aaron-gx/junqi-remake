"""导出原版走法/铁路数据表，供 TS 侧做等价性比对。

映射：Ghidra 地址 − 0x10000 = 文件偏移（.rodata 同址）
  · 步进走法表（走法生成器 FUN_00068cbc 用）  0x133350 → fileoff 0x123350
  · 铁路标志位表（FUN_00068d40/FUN_0006907c） 0x133bc4 → fileoff 0x123bc4
  · 全邻接表（AI 攻击图/寻路用，对照用）      0x132ae0 → fileoff 0x122ae0
"""
import json
import struct
from pathlib import Path

BASE = Path("E:/Learn/MeProject/2026.9.10-reverse/work/2026.9.10-base-apk")
buf = (BASE / "03-native/libjunqi.so").read_bytes()


def graph(fileoff: int) -> list[list[int]]:
    """60 行 × 0x24 的邻接表：邻居从 +4 起，-1 结尾。"""
    rows = []
    for i in range(60):
        off = fileoff + i * 0x24
        ns, p = [], off + 4
        while True:
            v = struct.unpack_from("<i", buf, p)[0]
            if v == -1:
                break
            ns.append(v)
            p += 4
        rows.append(ns)
    return rows


step = graph(0x123350)                                   # 走法生成器用的步进表
adj_all = graph(0x122AE0)                                # 全邻接（AI/寻路）
rail_flag = [int.from_bytes(buf[0x123BC4 + 4 * i:0x123BC4 + 4 * i + 4], "little")
             for i in range(60)]

out = {
    "step_graph": step,
    "adj_all": adj_all,
    "rail_flag": rail_flag,
    "special": {"no_up": [31, 33], "no_down": [26, 28]},
    "source": {
        "step_graph": "fileoff 0x123350 (Ghidra 0x133350) — FUN_00068cbc 步进",
        "adj_all": "fileoff 0x122ae0 (Ghidra 0x132ae0) — AI 攻击图/寻路",
        "rail_flag": "fileoff 0x123bc4 (Ghidra 0x133bc4) — 铁路标志位",
    },
}
p = BASE / "03-native/move_tables.json"
p.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
print("写出", p)
print("步进表总边数:", sum(len(x) for x in step))
print("全邻接总边数:", sum(len(x) for x in adj_all))
print("铁路格数:", sum(rail_flag))
print("步进表度数分布:", {d: sum(1 for x in step if len(x) == d) for d in sorted({len(x) for x in step})})
