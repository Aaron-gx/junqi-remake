#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ELF 深度侦察：section 布局 / 符号表完整性 / C++ 名称 / 引擎指纹 / SPAK 数据。
只依赖标准库，不联网。"""
import struct, sys, os, re, json, collections

SHT = {0: "NULL", 1: "PROGBITS", 2: "SYMTAB", 3: "STRTAB", 4: "RELA", 5: "HASH",
       6: "DYNAMIC", 7: "NOTE", 8: "NOBITS", 9: "REL", 10: "SHLIB", 11: "DYNSYM",
       14: "INIT_ARRAY", 15: "FINI_ARRAY", 16: "PREINIT_ARRAY", 17: "GROUP",
       18: "SYMTAB_SHNDX"}


class Elf:
    def __init__(self, path):
        self.raw = open(path, "rb").read()
        d = self.raw
        assert d[:4] == b"\x7fELF", "not ELF"
        self.is64 = d[4] == 2
        self.le = d[5] == 1
        e = "<" if self.le else ">"
        self.e = e
        self.machine = struct.unpack_from(e + "H", d, 18)[0]
        # 32-bit: e_shoff@32(4) e_shentsize@46(2) e_shnum@48(2) e_shstrndx@50(2)
        # 64-bit: e_shoff@40(8) e_shentsize@58(2) e_shnum@60(2) e_shstrndx@62(2)
        if self.is64:
            self.shoff = struct.unpack_from(e + "Q", d, 40)[0]
            self.shentsize = struct.unpack_from(e + "H", d, 58)[0]
            self.shnum = struct.unpack_from(e + "H", d, 60)[0]
            self.shstrndx = struct.unpack_from(e + "H", d, 62)[0]
        else:
            self.shoff = struct.unpack_from(e + "I", d, 32)[0]
            self.shentsize = struct.unpack_from(e + "H", d, 46)[0]
            self.shnum = struct.unpack_from(e + "H", d, 48)[0]
            self.shstrndx = struct.unpack_from(e + "H", d, 50)[0]
        self.sections = []
        for i in range(self.shnum):
            off = self.shoff + i * self.shentsize
            if self.is64:
                name, typ, flags, addr, offset, size, link, info, align, entsize = \
                    struct.unpack_from(e + "IIQQQQIIQQ", d, off)
            else:
                name, typ, flags, addr, offset, size, link, info, align, entsize = \
                    struct.unpack_from(e + "IIIIIIIIII", d, off)
            self.sections.append(dict(idx=i, name_off=name, type=typ, flags=flags,
                                      addr=addr, offset=offset, size=size,
                                      link=link, entsize=entsize))
        # section name string table
        if self.shstrndx < len(self.sections):
            st = self.sections[self.shstrndx]
            self.shstr = d[st["offset"]:st["offset"] + st["size"]]
        else:
            self.shstr = b""
        for s in self.sections:
            s["name"] = self._cstr(self.shstr, s["name_off"])

    def _cstr(self, blob, off):
        end = blob.find(b"\0", off)
        if end < 0 or off >= len(blob):
            return ""
        return blob[off:end].decode("utf-8", "replace")

    def read_strtab(self, sect):
        return self.raw[sect["offset"]:sect["offset"] + sect["size"]]

    def symbols(self, sect):
        """返回 (name, value, size, info, shndx) 列表"""
        if self.is64:
            fmt, entsz = self.e + "IBBHQQ", 24
        else:
            fmt, entsz = self.e + "IIIBBH", 16
        strtab = self.sections[sect["link"]] if sect["link"] < len(self.sections) else None
        blob = self.read_strtab(strtab) if strtab else b""
        out = []
        n = sect["size"] // (sect["entsize"] or entsz)
        for i in range(n):
            off = sect["offset"] + i * (sect["entsize"] or entsz)
            if self.is64:
                name, info, other, shndx, value, size = struct.unpack_from(fmt, self.raw, off)
            else:
                name, value, size, info, other, shndx = struct.unpack_from(fmt, self.raw, off)
            out.append((self._cstr(blob, name), value, size, info, shndx))
        return out


def demangle_batch(names):
    """返回 {mangled: demangled}；失败则原样保留"""
    return {n: n for n in names}


def main():
    so = sys.argv[1]
    outdir = sys.argv[2]
    e = Elf(so)
    L = []
    A = L.append

    A("# libjunqi.so ELF 深度侦察（结构 / 符号 / 可恢复性）\n")
    A(f"- 文件: `{os.path.basename(so)}`  大小: {len(e.raw):,} 字节")
    A(f"- 位数: {'64' if e.is64 else '32'} 位, {'小端' if e.le else '大端'}, "
      f"machine=0x{e.machine:04x} ({'ARM' if e.machine==40 else 'AArch64' if e.machine==183 else '?'})")
    mach = {3: "x86", 40: "ARM", 62: "x86-64", 183: "AArch64"}.get(e.machine, f"0x{e.machine:x}")
    A(f"- 机器类型: {mach}")
    A(f"- section 数: {len(e.sections)}")

    # section 表
    A("\n## Section 布局\n")
    A("| # | 名称 | 类型 | 偏移 | 大小 | 熵 |")
    A("|---|---|---|---|---|---|")
    for s in e.sections:
        NAMESZ = 400
        if s["type"] == 8:
            ent = "-"
        else:
            blob = e.raw[s["offset"]:s["offset"] + min(s["size"], NAMESZ * 1024)]
            ent = f"{shannon(blob):.2f}" if blob else "-"
        A(f"| {s['idx']} | `{s['name'] or '(空)'}` | {SHT.get(s['type'], s['type'])} | "
          f"0x{s['offset']:x} | {s['size']:,} | {ent} |")

    # 符号表完整性
    A("\n## 符号表完整性（决定能否恢复函数名）\n")
    syms = {}
    for s in e.sections:
        if s["type"] in (2, 11):
            kind = "SYMTAB（静态符号表）" if s["type"] == 2 else "DYNSYM（动态符号表）"
            ss = e.symbols(s)
            syms[s["name"]] = ss
            funcs = [x for x in ss if (x[3] & 0xf) == 2]
            objs = [x for x in ss if (x[3] & 0xf) == 1]
            A(f"- **{s['name']}** [{kind}] 条目 {len(ss)}，其中函数 {len(funcs)}，数据对象 {len(objs)}")
        if s["type"] == 3 and s["name"] in (".strtab", ".dynstr"):
            blob = e.read_strtab(s)
            cnt = blob.count(b"\0")
            A(f"- `{s['name']}`: {len(blob):,} 字节 / ~{cnt} 个字符串")

    all_syms = []
    for k, v in syms.items():
        all_syms += v
    cpp = [x for x in all_syms if x[0].startswith("_Z")]
    jni = [x for x in all_syms if x[0].startswith("Java_")]
    A(f"\n- C++ 修饰符号（`_Z*`）在符号表中的数量: **{len(cpp)}**")
    A(f"- JNI 导出（`Java_*`）在符号表中的数量: **{len(jni)}**")

    # 关键：是否有 .symtab
    has_symtab = any(s["type"] == 2 for s in e.sections)
    A(f"\n> **结论：{'带 .symtab 静态符号表 → 函数名可直接恢复（未 strip 符号或仅部分 strip）' if has_symtab else '无 .symtab（已 strip），只能依赖 .dynsym 与字符串交叉引用'}**")

    # 前 60 个 _Z 原始样例
    if cpp:
        A("\n### C++ 符号样例（前 60）\n```")
        for x in cpp[:60]:
            A(f"0x{x[1]:08x}  sz={x[2]:6d}  {x[0]}")
        A("```")

    # 字符串中的引擎/脚本 VM 指纹
    A("\n## 引擎 / 脚本 VM 指纹（仅取可打印串做词边界匹配）\n")
    strings = extract_strings(e.raw, 5)
    joined = "\n".join(strings)
    SIGS = {
        "cocos2d-x": ["cocos2d", "CCDirector", "cocos2d::"],
        "Lua VM": ["lua_State", "luaL_", "LuaJIT", "lua_pcall", ".lua"],
        "QuickJS/JS": ["quickjs", "JS_NewRuntime", "duktape", "V8::", "v8::internal"],
        "Unity/Mono": ["il2cpp", "mono_", "UnityEngine", "libmono"],
        "Unreal": ["UE4", "UnrealEngine", "GEngine"],
        "Flutter/Dart": ["flutter", "dart::", "DartVM"],
        "Skia": ["SkCanvas", "SkBitmap", "skia"],
        "OpenGL ES": ["glTexImage2D", "glDrawArrays"],
        "Protocol/网络": ["Junqi.", "RegretReq", "RegretAgree", "socket", "recv", "send"],
        "Anti-debug": ["ptrace", "TracerPid", "/proc/self/status", "frida", "gum-js"],
        "Packer/加密": ["AES", "ChaCha", "xxtea", "XXTEA", "zlib", "inflate", "uncompress"],
    }
    for label, sigs in SIGS.items():
        hits = []
        for s in sigs:
            # 词边界：非字母数字包围
            n = len(re.findall(r"(?<![A-Za-z0-9_])" + re.escape(s) + r"(?![A-Za-z0-9_])", joined))
            if n:
                hits.append(f"`{s}`×{n}")
        if hits:
            A(f"- **{label}**: " + ", ".join(hits))

    # junqi/棋盘 相关业务串
    biz = sorted({s for s in strings if re.search(r"Junqi\.|junqi_|Board|board_|Chess|piece|Camp|Railway|Regret", s, re.I)})
    A(f"\n## 业务关键字串（{len(biz)} 条，前 60）\n```")
    for s in biz[:60]:
        A(s[:120])
    A("```")

    # 导出函数地址（JNI 入口，供反编译器定位）
    A("\n## JNI 入口地址表（反编译起点）\n")
    A("| 符号 | 地址 | 大小 |")
    A("|---|---|---|")
    for x in sorted(jni, key=lambda y: y[1]):
        A(f"| `{x[0]}` | 0x{x[1]:08x} | {x[2]} |")

    open(os.path.join(outdir, "libjunqi-deep.md"), "w", encoding="utf-8").write("\n".join(L) + "\n")
    print(f"OK wrote libjunqi-deep.md  sections={len(e.sections)} strings={len(strings)} symtab={has_symtab} cpp={len(cpp)} jni={len(jni)}")


def shannon(b):
    if not b:
        return 0.0
    import math
    c = collections.Counter(b)
    n = len(b)
    return -sum((v / n) * math.log2(v / n) for v in c.values())


def extract_strings(data, minlen=5):
    out = []
    for m in re.finditer(rb"[\x20-\x7e]{%d,}" % minlen, data):
        out.append(m.group(0).decode("latin-1"))
    return out


if __name__ == "__main__":
    main()
