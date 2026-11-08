#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ELF 原生库静态侦察（无 IDA / radare2 时的轻量替代）。

用法:
    python elf_triage.py <lib.so> <out_dir>
产出:
    <out_dir>/libjunqi-elf.json
    <out_dir>/libjunqi-elf.md
"""
import hashlib
import json
import os
import re
import struct
import sys
from collections import Counter

ENGINE_SIGNS = {
    "cocos2d": "Cocos2d-x",
    "CCApplication": "Cocos2d-x",
    "libcocos": "Cocos2d-x",
    "cocos2d::": "Cocos2d-x",
    "lua_pcall": "Lua VM",
    "luaL_newstate": "Lua VM",
    "LuaJIT": "LuaJIT",
    "luajit": "LuaJIT",
    "unity": "Unity",
    "il2cpp": "Unity IL2CPP",
    "mono_": "Mono/.NET",
    "Unreal": "Unreal Engine",
    "egret": "Egret",
    "layabox": "LayaBox",
    "libgdx": "libGDX",
    "openal": "OpenAL",
    "OpenSLES": "OpenSL ES",
    "box2d": "Box2D",
    "chipmunk": "Chipmunk",
    "sqlite3_": "SQLite3",
    "curl_easy": "libcurl",
    "mbedtls": "mbedTLS",
    "OpenSSL": "OpenSSL",
    "EVP_Encrypt": "OpenSSL EVP",
    "AES_set": "OpenSSL AES",
    "__android_log_print": "Android log",
}

RISK_SIGNS = {
    "JNI_OnLoad": "标准 JNI 入口",
    "RegisterNatives": "动态注册 native 方法",
    "ptrace": "反调试常见 API",
    "fopen": "文件读写",
    "system(": "命令执行调用",
    "popen": "命令执行调用",
    "execve": "进程执行",
    "dlopen": "动态加载",
    "dlsym": "动态符号解析",
    "getprop": "读取系统属性（常见模拟器/root 检测）",
    "ro.debuggable": "调试属性探测",
    "ro.secure": "root 探测相关属性",
    "su": "root 探测",
    "frida": "反 Frida 探测",
    "xposed": "反 Xposed 探测",
    "/proc/self/maps": "内存映射自检（反调试/反注入）",
    "/proc/self/status": "进程状态自检",
    "TracerPid": "反调试（TracerPid 检测）",
    "IsDebuggerConnected": "调试检测",
    "getDeviceId": "设备标识采集",
    "sqlite": "本地数据库",
}


def sha256_file(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            b = fh.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def parse_elf(data):
    if data[:4] != b"\x7fELF":
        return None
    ei_class = data[4]  # 1=32bit 2=64bit
    ei_data = data[5]  # 1=LE 2=BE
    e_machine = struct.unpack_from("<H", data, 18)[0]
    machines = {3: "x86", 8: "MIPS", 40: "ARM", 62: "x86-64", 183: "AArch64"}
    return {
        "bits": 32 if ei_class == 1 else 64,
        "endian": "little" if ei_data == 1 else "big",
        "machine": machines.get(e_machine, f"unknown({e_machine})"),
        "type": {1: "REL", 2: "EXEC", 3: "DYN(shared lib)"}.get(
            struct.unpack_from("<H", data, 16)[0], "?"
        ),
    }


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    so, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    base = os.path.splitext(os.path.basename(so))[0]

    raw = open(so, "rb").read()
    elf = parse_elf(raw)

    # 可打印字符串抽取（>=4 字符）
    strings = re.findall(rb"[\x20-\x7e]{4,}", raw)
    strings = [s.decode("latin-1") for s in strings]

    # .dynsym 导出函数名近似提取：从字符串表中筛 JNI / C++ 符号样式
    jni_exports = sorted({s for s in strings if s.startswith("Java_")})
    cpp_syms = sorted({s for s in strings if s.startswith("_ZN") and len(s) < 200})
    exports = sorted({s for s in strings if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{5,60}", s)})

    engines = {}
    # 必须做词边界匹配：否则 "Regret"(军棋悔棋) 会被误判成 "egret"(Egret 引擎)
    haystack = raw.decode("latin-1")
    for sig, label in ENGINE_SIGNS.items():
        pat = r"(?<![A-Za-z0-9_])" + re.escape(sig) + r"(?![A-Za-z0-9_])"
        if re.search(pat, haystack):
            engines.setdefault(label, []).append(sig)

    risks = {}
    joined = "\n".join(strings)
    for sig, label in RISK_SIGNS.items():
        # 标识符类签名做词边界匹配，避免 "su" 命中 "success"/"result" 之类的子串误报
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", sig):
            pat = r"(?<![A-Za-z0-9_])" + re.escape(sig) + r"(?![A-Za-z0-9_])"
            cnt = len(re.findall(pat, joined))
        else:
            cnt = joined.count(sig)
        if cnt:
            risks.setdefault(label, {"sigs": [], "count": 0})
            risks[label]["sigs"].append(sig)
            risks[label]["count"] += cnt

    # URL / IP / 域名
    urls = sorted({s for s in strings if s.startswith(("http://", "https://"))})
    ips = sorted(
        {s for s in strings if re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}(:\d+)?", s)}
    )
    domains = sorted(
        {
            s
            for s in strings
            if re.fullmatch(r"[a-z0-9][a-z0-9\-\.]{3,60}\.(com|cn|net|org|io|top|xyz|vip|cc|me)", s)
        }
    )

    result = {
        "file": os.path.abspath(so),
        "size": len(raw),
        "sha256": sha256_file(so),
        "elf": elf,
        "string_count": len(strings),
        "jni_exports": jni_exports,
        "jni_export_count": len(jni_exports),
        "cpp_mangled_sample": cpp_syms[:120],
        "cpp_mangled_count": len(cpp_syms),
        "engines": engines,
        "risk_signs": risks,
        "urls": urls[:100],
        "ips": ips[:50],
        "domains": domains[:100],
    }
    with open(os.path.join(out_dir, f"{base}-elf.json"), "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)

    L = [f"# Native 库侦察：`{base}.so`\n"]
    L.append(f"- 路径: `{result['file']}`")
    L.append(f"- 大小: {len(raw):,} 字节")
    L.append(f"- SHA-256: `{result['sha256']}`")
    if elf:
        L.append(
            f"- ELF: {elf['bits']} 位 / {elf['endian']}-endian / `{elf['machine']}` / {elf['type']}"
        )
    L.append(f"- 可打印字符串总数: {len(strings):,}\n")

    L.append("## 引擎 / 框架指纹\n")
    if engines:
        for k, v in engines.items():
            L.append(f"- **{k}** → {', '.join(sorted(set(v))[:6])}")
    else:
        L.append("- 未识别到常见游戏引擎指纹（可能是自研引擎）")
    L.append("")

    L.append("## JNI 导出\n")
    if jni_exports:
        L.append(f"共 {len(jni_exports)} 个 `Java_*` 导出：\n")
        for s in jni_exports[:80]:
            L.append(f"- `{s}`")
    else:
        L.append("- 无 `Java_*` 静态导出 → 走 `RegisterNatives` 或纯逻辑库")
    L.append(f"\nC++ 修饰符号（`_ZN*`）数量: {len(cpp_syms):,}\n")

    L.append("## 敏感 / 反分析特征\n")
    if risks:
        L.append("| 类别 | 命中签名 | 出现次数 |")
        L.append("|---|---|---|")
        for k, v in sorted(risks.items(), key=lambda x: -x[1]["count"]):
            L.append(f"| {k} | {', '.join(sorted(set(v['sigs'])))} | {v['count']} |")
    else:
        L.append("- 未命中")
    L.append("")

    L.append("## 网络与外部线索\n")
    L.append(f"- URL: {len(urls)} 条" + (f" → {', '.join(urls[:10])}" if urls else ""))
    L.append(f"- IP: {', '.join(ips[:10]) if ips else '无'}")
    L.append(f"- 域名: {', '.join(domains[:15]) if domains else '无'}")

    with open(os.path.join(out_dir, f"{base}-elf.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(L) + "\n")

    print(f"sha256={result['sha256']}")
    print(f"size={len(raw)}")
    print(f"machine={elf['machine'] if elf else 'n/a'} bits={elf['bits'] if elf else 'n/a'}")
    print(f"strings={len(strings)} jni_exports={len(jni_exports)} cpp_syms={len(cpp_syms)}")
    print(f"engines={list(engines.keys())}")
    print(f"risk_categories={len(risks)}")
    print(f"out={out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
