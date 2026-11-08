# Evidence（可复现证据链）

所有命令均在 `E:\Learn\MeProject\2026.9.10-reverse` 下执行，工具版本：jadx 1.5.6 / apktool 3.0.2 / JDK 25（Android Studio JBR）。

---

## E-001 样本指纹

- **observable**: APK 大小 8,908,897 字节；SHA-256 `3cb1aae814be03d23ce452b047e630d422c01ee154811d2578973ba1d2202426`；`classes.dex` SHA-256 前缀 `32552145b27ca9d4`
- **repro command**:
  ```bash
  python work/2026.9.10-base-apk/scripts/apk_triage.py base.apk work/2026.9.10-base-apk/00-triage
  ```
- **artifact**: `00-triage/apk-inventory.json`, `00-triage/apk-triage.md`
- **severity**: info

## E-002 包名与版本

- **observable**: `package="com.cnvcs.junqi"`, `versionCode=158`, `versionName=1.58`, `minSdkVersion=14`, `targetSdkVersion=26`
- **repro command**:
  ```bash
  java -jar C:/Users/<user>/Tools/apktool/apktool_3.0.2.jar d base.apk -o work/2026.9.10-base-apk/02-apktool -f
  cat work/2026.9.10-base-apk/02-apktool/apktool.yml
  ```
- **artifact**: `02-apktool/apktool.yml`, `02-apktool/AndroidManifest.xml`
- **severity**: info

## E-003 未加壳（可静态分析）

- **observable**: 未命中 360/腾讯乐固/梆梆/阿里 SecurityGuard/网易易盾 等 18 类加固特征；`classes.dex` 头可正常解析（DEX 035，1224 类 / 12,788 方法）
- **repro command**: 见 E-001
- **artifact**: `00-triage/apk-triage.md`「加固 / 壳特征」章节
- **severity**: info

## E-004 Java 层全量反编译成功（覆盖率 100%）

- **observable**: apktool 解出 1223 个 `.smali`（500 个顶层类 + 723 个内部类）；jadx 产出 501 个 `.java`（500 顶层 + 1），jadx 日志中 `ERROR` 计数为 **0**
- **repro command**:
  ```bash
  C:/Users/<user>/Tools/jadx/bin/jadx.bat -d work/2026.9.10-base-apk/01-java --no-res --show-bad-code -j 4 base.apk
  find work/2026.9.10-base-apk/01-java/sources -name '*.java' | wc -l
  grep -ciE '^ERROR' work/2026.9.10-base-apk/evidence/jadx.log
  ```
- **artifact**: `01-java/sources/`（501 文件 / 81,876 行 / 71 个包）, `evidence/jadx.log`
- **severity**: info

## E-005 业务逻辑位于 native 层（核心发现）

- **observable**: 唯一 Activity `com.cnvcs.App` 声明 **15 个 `native` 方法**，`static { System.loadLibrary("junqi"); }`；`libjunqi.so` 中恰好导出 15 个对应 `Java_com_cnvcs_App_*` 符号
- **repro command**:
  ```bash
  python work/2026.9.10-base-apk/scripts/elf_triage.py work/2026.9.10-base-apk/03-native/libjunqi.so work/2026.9.10-base-apk/03-native
  ```
- **artifact**: `01-java/sources/com/cnvcs/App.java`, `03-native/libjunqi-elf.md`
- **finding**: **F-001**（Java 层只是 JNI/OpenGL 壳）
- **severity**: info（架构性结论，非漏洞）

## E-006 native 库无网络行为、无强反调试

- **observable**: `libjunqi.so`（ARM 32 位 / little-endian / DYN）抽样 21,777 条可打印字符串，**URL 0 条、域名 0 条**；`ptrace` / `TracerPid` / `ro.debuggable` / `frida` / `xposed` 均未命中；仅 `fopen` `dlopen` `dlsym` 各 1 次
- **repro command**: 见 E-005
- **artifact**: `03-native/libjunqi-elf.md`
- **severity**: info

## E-007 资源包为 SPAK 分片容器

- **observable**: `assets/data0.pak` / `datah0.pak` / `datax0.pak` 前 4 字节均为 magic `SPAK`，紧随 `01 00 00 00`（版本 1）；三组流按 **1,000,000 字节**切片，仅第 0 片带容器头：

  | 组 | 分片 | 拼接总长 | 头部字段 @8 | 差值 |
  |---|---|---|---|---|
  | data | data0+data1 | 1,238,714 | 1,235,978 | 2,736 |
  | datah | datah0+datah1 | 1,301,051 | 1,294,907 | 6,144 |
  | datax | datax0..3 | 3,699,540 | 3,691,991 | 7,549 |

- **repro command**:
  ```bash
  head -c 16 work/2026.9.10-base-apk/02-apktool/assets/data0.pak | xxd
  cat work/2026.9.10-base-apk/02-apktool/assets/data0.pak work/2026.9.10-base-apk/02-apktool/assets/data1.pak > /tmp/data.spak
  ```
- **artifact**: `02-apktool/assets/`
- **severity**: info

## E-008 敏感权限与不安全配置

- **observable**: `usesCleartextTraffic=true`、`allowBackup=true`、`targetSdkVersion=26`（低于 Google Play 现行要求）；申请 `READ_PHONE_STATE`、`QUERY_ALL_PACKAGES`、`REQUEST_INSTALL_PACKAGES`、`ACCESS_COARSE_LOCATION`
- **repro command**: 阅读 `02-apktool/AndroidManifest.xml`
- **artifact**: `00-triage/manifest-summary.md`
- **finding**: **F-002 / F-003 / F-004**
- **severity**: low ~ medium

---

## 分析工具链版本

| 工具 | 版本 | 来源校验 |
|---|---|---|
| jadx | 1.5.6 | SHA-256 `545ea2be…e8974` 与 reverse-skill bootstrap manifest 一致 |
| apktool | 3.0.2 | SHA-256 `eee4669a…8b5fd` 与 reverse-skill bootstrap manifest 一致 |
| JDK | OpenJDK 25.0.2（Android Studio JBR） | — |
