#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 libjunqi.so 的 .rodata 提取内建资源路径清单，按类别归档。
注意：该 .so 首个 LOAD 段 off=0/vaddr=0，且 .rodata 位于该段内，故文件偏移 == 虚拟地址。
"""
import re
import sys
import collections

SO = "03-native/libjunqi.so"
RO_OFF = 0x11AD10
RO_SIZE = 115996
OUT = "03-native/asset-manifest.md"

EXT = re.compile(r"\.(png|jpg|jpeg|xml|cfg|txt|dat|pak|data|json|fnt|ttf|wav|mp3|ogg|db|avb)$", re.I)


def classify(s):
    sl = s.lower()
    if ".pak" in sl:
        return "1-container-pak"
    if sl.startswith("data/config/"):
        return "2-config-tables"
    if sl.startswith("data/sg/"):
        return "3-board-junqi"
    if sl.startswith("data/junqi/"):
        return "4-common-ui"
    if sl.startswith("data/ui/"):
        return "5-sound"
    if sl.startswith("/data/image/"):
        return "6-absolute-image"
    if sl.endswith(".xml"):
        return "7-dialog-xml"
    if sl.endswith(".cfg"):
        return "8-layout-cfg"
    if sl.endswith(".txt"):
        return "9-text-data"
    return "0-other"


TITLES = {
    "1-container-pak": "① 容器分片（SPAK 索引内的顶层条目）",
    "2-config-tables": "② 配置表 data/config/*",
    "3-board-junqi": "③ 四国军棋棋盘资源 data/sg/*",
    "4-common-ui": "④ 通用/主界面资源 data/junqi/*",
    "5-sound": "⑤ 音效 data/ui/*",
    "6-absolute-image": "⑥ 绝对路径图像",
    "7-dialog-xml": "⑦ 界面布局 XML（各对话框）",
    "8-layout-cfg": "⑧ 布局/场景配置 .cfg",
    "9-text-data": "⑨ 文本数据 .txt",
    "0-other": "⑩ 其他",
}


def main():
    d = open(SO, "rb").read()
    ro = d[RO_OFF:RO_OFF + RO_SIZE]
    rows = [(RO_OFF + m.start(), m.group(0).decode("latin-1"))
            for m in re.finditer(rb"[\x20-\x7e]{4,}", ro)]

    seen = {}
    for off, s in rows:
        if EXT.search(s) and s not in seen:
            seen[s] = off

    cat = collections.defaultdict(list)
    for s, off in seen.items():
        cat[classify(s)].append((off, s))

    L = []
    L.append("# libjunqi.so 内建资源清单（从 `.rodata` 提取）\n")
    L.append("- 来源：`libjunqi.so` `.rodata` @ `0x0011ad10`（该段文件偏移 == 虚拟地址）")
    L.append("- 含义：这些是**代码内部使用的资源路径模板**，即 SPAK 容器索引中应当存在的条目。")
    L.append("- 用途：解密 SPAK 后可逐条比对，验证解包完整性。\n")
    L.append("| 类别 | 条目数 |")
    L.append("|---|---|")
    for k in sorted(cat):
        L.append("| {} | {} |".format(TITLES.get(k, k), len(cat[k])))
    L.append("")
    for k in sorted(cat):
        L.append("## {}\n".format(TITLES.get(k, k)))
        L.append("| vaddr | 路径 |")
        L.append("|---|---|")
        for off, s in sorted(cat[k]):
            L.append("| `{:08x}` | `{}` |".format(off, s))
        L.append("")

    open(OUT, "w", encoding="utf-8").write("\n".join(L) + "\n")
    print("OK -> {}  条目 {}".format(OUT, len(seen)))
    for k in sorted(cat):
        print("  {:<22} {}".format(k, len(cat[k])))


if __name__ == "__main__":
    main()
