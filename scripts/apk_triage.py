#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""APK 静态侦察：ZIP 清单 / DEX 头解析 / native 库 / 加固特征 / 哈希。

用法:
    python apk_triage.py <base.apk> <out_dir>
产出:
    <out_dir>/apk-inventory.json  机器可读清单
    <out_dir>/apk-triage.md       人读摘要
"""
import hashlib
import json
import os
import re
import struct
import sys
import zipfile
from collections import defaultdict

# 已知加固 / 壳特征（文件名片段，小写匹配）
PACKER_SIGNS = {
    "libjiagu": "360 加固",
    "libjiagu_art": "360 加固(art)",
    "libjiagu_x86": "360 加固(x86)",
    "libprotectclass": "腾讯乐固/legu",
    "libshell": "腾讯乐固(shell)",
    "libtup.so": "腾讯乐固(tup)",
    "libtosprotection": "腾讯 TOS 保护",
    "libmobisec": "阿里聚安全",
    "libsgmain": "阿里 SecurityGuard",
    "libsgsecuritybody": "阿里 SecurityGuard body",
    "libfakejni": "阿里 SecurityGuard(fakejni)",
    "libDexHelper": "梆梆加固",
    "libDexHelper-x86": "梆梆加固(x86)",
    "libSecShell": "梆梆 SecShell",
    "libsecexe": "梆梆(secexe)",
    "libsecmain": "梆梆(secmain)",
    "libnesec": "网易易盾",
    "libnqshield": "网秦",
    "libkwscmm": "Kiwi 加固",
    "libmsaoaidsec": "MSA OAID SDK",
    "libexec.so": "梆梆/Bangcle(exec)",
    "libexecmain": "梆梆/Bangcle(execmain)",
    "libbaiduprotect": "百度加固",
    "libapkprotect": "APKProtect",
    "libnativehelper": "加固常见 nativehelper",
    "librealmain": "顶象/梆梆 realmain",
}

# 常见第三方 SDK 指纹（DEX/资源路径片段）
SDK_HINTS = {
    "com/tencent/mm": "微信 SDK",
    "com/tencent/open": "QQ 互联",
    "com/alipay": "支付宝 SDK",
    "com/tencent/mm/opensdk": "微信 OpenSDK",
    "com/bytedance": "字节穿山甲/SDK",
    "com/umeng": "友盟统计",
    "com/ta/utdid": "阿里 UTDID",
    "com/facebook": "Facebook SDK",
    "com/unity3d": "Unity",
    "com/google/android/gms": "Google Play Services",
    "com/google/firebase": "Firebase",
    "okhttp3": "OkHttp3",
    "retrofit2": "Retrofit2",
    "com/squareup": "Square 库",
    "com/scwang/smartrefresh": "SmartRefreshLayout",
    "com/bumptech/glide": "Glide",
    "com/blankj/utilcode": "AndroidUtilCode",
    "com/jakewharton": "Butter Knife 等",
    "io/reactivex": "RxJava",
    "org/apache": "Apache Commons",
    "com/airbnb/lottie": "Lottie 动画",
    "com/tencent/bugly": "Bugly",
    "cn/jpush": "极光推送",
    "com/igexin": "个推",
    "com/xiaomi/push": "小米推送",
    "com/huawei/hms": "华为 HMS",
    "com/qq/e": "广点通广告",
    "com/tencent/tauth": "腾讯 TAuth",
}


def sha256_file(path, chunk=1 << 20):
    h = hashlib.sha256()
    size = 0
    with open(path, "rb") as fh:
        while True:
            b = fh.read(chunk)
            if not b:
                break
            h.update(b)
            size += len(b)
    return h.hexdigest(), size


def parse_dex_header(data):
    """解析 DEX 头：版本、各表大小。"""
    if len(data) < 0x70 or data[:4] not in (b"dex\n", b"dex\r"):
        return None
    magic = data[:8]
    ver = data[4:7].decode("ascii", "replace")
    (file_size,) = struct.unpack_from("<I", data, 0x20)
    fields = struct.unpack_from("<II", data, 0x38)  # string_ids_size, off
    type_ids_size = struct.unpack_from("<I", data, 0x40)[0]
    proto_ids_size = struct.unpack_from("<I", data, 0x48)[0]
    field_ids_size = struct.unpack_from("<I", data, 0x50)[0]
    method_ids_size = struct.unpack_from("<I", data, 0x58)[0]
    class_defs_size = struct.unpack_from("<I", data, 0x60)[0]
    return {
        "magic": magic.decode("ascii", "replace").strip("\n\r\x00"),
        "version": ver,
        "file_size": file_size,
        "string_ids": fields[0],
        "type_ids": type_ids_size,
        "proto_ids": proto_ids_size,
        "field_ids": field_ids_size,
        "method_ids": method_ids_size,
        "class_defs": class_defs_size,
    }


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    apk, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)

    apk_hash, apk_size = sha256_file(apk)

    zf = zipfile.ZipFile(apk)
    infos = zf.infolist()

    dex_entries, so_entries, arsc_entries = [], [], []
    assets, res_files, other = [], [], []
    total_uncompressed = 0
    name_blob = []

    for i in infos:
        name = i.filename
        total_uncompressed += i.file_size
        name_blob.append(name.lower())
        low = name.lower()
        rec = {
            "name": name,
            "size": i.file_size,
            "compressed": i.compress_size,
            "method": "STORED" if i.compress_type == 0 else "DEFLATED",
        }
        if re.match(r"^classes\d*\.dex$", name):
            dex_entries.append(rec)
        elif low.endswith(".so"):
            so_entries.append(rec)
        elif name == "resources.arsc":
            arsc_entries.append(rec)
        elif name.startswith("assets/"):
            assets.append(rec)
        elif name.startswith("res/"):
            res_files.append(rec)
        else:
            other.append(rec)

    # DEX 头解析
    dex_meta = []
    total_classes = 0
    total_methods = 0
    for d in dex_entries:
        raw = zf.read(d["name"])
        hdr = parse_dex_header(raw)
        if hdr:
            hdr["name"] = d["name"]
            hdr["zip_size"] = d["size"]
            hdr["sha256"] = hashlib.sha256(raw).hexdigest()
            dex_meta.append(hdr)
            total_classes += hdr["class_defs"]
            total_methods += hdr["method_ids"]
        del raw

    # 加固特征
    packers = {}
    joined = "\n".join(name_blob)
    for sig, label in PACKER_SIGNS.items():
        if sig.lower() in joined:
            packers.setdefault(label, []).append(sig)

    # strings 抽样（从 DEX 中抓 SDK 指纹 / URL）
    sdk_hits = {}
    urls = set()
    domains = set()
    for d in dex_entries:
        raw = zf.read(d["name"])
        try:
            txt = raw.decode("latin-1")
        except Exception:
            continue
        for key, label in SDK_HINTS.items():
            if key in txt:
                sdk_hits.setdefault(label, 0)
                sdk_hits[label] += txt.count(key)
        for m in re.finditer(rb"https?://[\x20-\x7e]{4,120}", raw):
            u = m.group(0).decode("latin-1")
            urls.add(u)
        for m in re.finditer(rb"[a-z0-9][a-z0-9\-\.]{2,60}\.(com|cn|net|org|io|top|xyz|life|vip|cc|me|info)\b", raw):
            domains.add(m.group(0).decode("latin-1"))
        del raw

    inv = {
        "apk": {
            "path": os.path.abspath(apk),
            "size_bytes": apk_size,
            "sha256": apk_hash,
            "entries": len(infos),
            "uncompressed_bytes": total_uncompressed,
        },
        "dex": dex_meta,
        "dex_totals": {"classes": total_classes, "methods": total_methods},
        "native_libs": so_entries,
        "resources_arsc": arsc_entries,
        "assets_count": len(assets),
        "res_count": len(res_files),
        "packer_signs": packers,
        "sdk_hits": sdk_hits,
        "urls_sample": sorted(urls)[:400],
        "domains_sample": sorted(domains)[:400],
    }
    with open(os.path.join(out_dir, "apk-inventory.json"), "w", encoding="utf-8") as fh:
        json.dump(inv, fh, ensure_ascii=False, indent=2)

    # 人读摘要
    L = []
    L.append("# APK 静态侦察摘要\n")
    L.append(f"- 样本: `{os.path.abspath(apk)}`")
    L.append(f"- 大小: {apk_size:,} 字节 ({apk_size/1048576:.2f} MiB)")
    L.append(f"- SHA-256: `{apk_hash}`")
    L.append(f"- ZIP 条目: {len(infos)}，解压后总计: {total_uncompressed:,} 字节\n")

    L.append("## DEX\n")
    L.append("| DEX | 版本 | 类数 | 方法数 | 字符串数 | SHA-256(前16) |")
    L.append("|---|---|---|---|---|---|")
    for d in dex_meta:
        L.append(
            f"| {d['name']} | {d['version']} | {d['class_defs']:,} | {d['method_ids']:,} "
            f"| {d['string_ids']:,} | `{d['sha256'][:16]}` |"
        )
    L.append(f"\n合计类数 **{total_classes:,}**，方法数 **{total_methods:,}**\n")

    L.append("## Native 库\n")
    if so_entries:
        L.append("| 文件 | 解压大小 |")
        L.append("|---|---|")
        for s in sorted(so_entries, key=lambda x: -x["size"]):
            L.append(f"| {s['name']} | {s['size']:,} |")
    else:
        L.append("- 无 `.so`（纯 Java/Kotlin 应用）")
    L.append("")

    L.append("## 加固 / 壳特征\n")
    if packers:
        for label, sigs in packers.items():
            L.append(f"- **{label}** → 命中: {', '.join(sorted(set(sigs)))}")
    else:
        L.append("- 未命中常见加固特征（疑似未加壳）")
    L.append("")

    L.append("## 三方 SDK 指纹\n")
    if sdk_hits:
        L.append("| 组件 | 命中次数 |")
        L.append("|---|---|")
        for k, v in sorted(sdk_hits.items(), key=lambda x: -x[1]):
            L.append(f"| {k} | {v} |")
    else:
        L.append("- 未识别")
    L.append("")

    L.append("## 其他\n")
    L.append(f"- assets 文件数: {len(assets)}")
    L.append(f"- res 文件数: {len(res_files)}")
    L.append(f"- 抽样 URL 数: {len(urls)}，抽样域名数: {len(domains)}")
    with open(os.path.join(out_dir, "apk-triage.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(L) + "\n")

    print(f"apk_sha256={apk_hash}")
    print(f"size={apk_size}")
    print(f"dex_files={len(dex_entries)}")
    print(f"classes={total_classes}")
    print(f"methods={total_methods}")
    print(f"so_files={len(so_entries)}")
    print(f"packers={list(packers.keys())}")
    print(f"out={out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
