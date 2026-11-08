# SPAK 逐字节替换（S-box）攻击

## 假设

已证实：密文中存在逐字节完全相同的 32 字节块（随机概率 2^-256）。
且三组重复间距 69 / 2264 / 38688 的最大公约数为 1，
故「周期密钥异或」要求周期=1，与实测熵 8.0 矛盾。
→ 变换为**位置无关的逐字节替换** C[i] = S[P[i]]。

## 组 `data`

- 载荷 1235978 字节 / 索引 2720 字节（f8=1235978 f12=2736）

### A. 单字节 XOR / 加减 / 仿射 全空间扫描

**索引区**

| 变换 | 密钥 | 命中魔数 | 位置 |
|---|---|---|---|
| ADD | `158` | ZLIB(默认) | 0x5f9 |

- **存在候选密钥**

**载荷前 256KB**

| 变换 | 密钥 | 命中魔数 | 位置 |
|---|---|---|---|
| XOR | `0x04` | ZLIB(最大) | 0x14fe3 |
| XOR | `0x31` | GZIP | 0xe0d0 |
| XOR | `0x36` | GZIP | 0x22225 |
| XOR | `0x43` | JPEG | 0x3324 |
| XOR | `0x44` | ZLIB(默认) | 0x2c0b |
| XOR | `0x6e` | GZIP | 0x1e2d5 |
| XOR | `0x75` | JPEG | 0x6be9 |
| XOR | `0x76` | ZLIB(最大) | 0x15c9d |
| XOR | `0x83` | ZLIB(最大) | 0x300e7 |
| XOR | `0x84` | ZLIB(默认) | 0x3ac86 |
| ADD | `2` | ZLIB(默认) | 0x1226f |
| ADD | `2` | JPEG | 0x19f35 |
| ADD | `16` | GZIP | 0x1e7b4 |
| ADD | `40` | JPEG | 0x3507b |
| ADD | `121` | ZLIB(默认) | 0x345b8 |
| ADD | `121` | ZLIB(最大) | 0x3c4d9 |
| ADD | `122` | JPEG | 0xb87 |
| ADD | `139` | GZIP | 0x1719f |
| ADD | `150` | GZIP | 0x199c3 |
| ADD | `154` | ZLIB(最大) | 0x4cb2 |

- **存在候选密钥**

### B. 已知明文 crib 求解替换表 S

**索引区**（无矛盾对齐点 Top 15）

| 偏移 | 覆盖密文字节数 | 命中 crib 数 | 最佳 crib |
|---|---|---|---|
| `0x29` | 306 | 20 | `data/config/string.xml` |
| `0x2a` | 306 | 20 | `data/config/string.xml` |
| `0x2b` | 306 | 20 | `data/config/string.xml` |
| `0x2c` | 306 | 20 | `data/config/string.xml` |
| `0x2d` | 306 | 20 | `data/config/string.xml` |
| `0x2e` | 306 | 20 | `data/config/string.xml` |
| `0x2f` | 306 | 20 | `data/config/string.xml` |
| `0x30` | 306 | 20 | `data/config/string.xml` |
| `0x31` | 306 | 20 | `data/config/string.xml` |
| `0x32` | 306 | 20 | `data/config/string.xml` |
| `0x33` | 306 | 20 | `data/config/string.xml` |
| `0x34` | 306 | 20 | `data/config/string.xml` |
| `0x35` | 306 | 20 | `data/config/string.xml` |
| `0x36` | 306 | 20 | `data/config/string.xml` |
| `0x37` | 306 | 20 | `data/config/string.xml` |

> **强候选**：偏移 `0x29` 处覆盖 306 个不同密文字节且无矛盾，
> 与明文路径 `data/config/string.xml` 一致。可据此扩展还原完整替换表。

**载荷前 64KB**（无矛盾对齐点 Top 15）

| 偏移 | 覆盖密文字节数 | 命中 crib 数 | 最佳 crib |
|---|---|---|---|
| `0x7` | 306 | 20 | `data/config/string.xml` |
| `0x8` | 306 | 20 | `data/config/string.xml` |
| `0x9` | 306 | 20 | `data/config/string.xml` |
| `0xa` | 306 | 20 | `data/config/string.xml` |
| `0x2a` | 306 | 20 | `data/config/string.xml` |
| `0x2b` | 306 | 20 | `data/config/string.xml` |
| `0x2c` | 306 | 20 | `data/config/string.xml` |
| `0x30` | 306 | 20 | `data/config/string.xml` |
| `0x37` | 306 | 20 | `data/config/string.xml` |
| `0x38` | 306 | 20 | `data/config/string.xml` |
| `0x39` | 306 | 20 | `data/config/string.xml` |
| `0x3a` | 306 | 20 | `data/config/string.xml` |
| `0x3b` | 306 | 20 | `data/config/string.xml` |
| `0x3c` | 306 | 20 | `data/config/string.xml` |
| `0x3d` | 306 | 20 | `data/config/string.xml` |

> **强候选**：偏移 `0x7` 处覆盖 306 个不同密文字节且无矛盾，
> 与明文路径 `data/config/string.xml` 一致。可据此扩展还原完整替换表。

### C. 重复块统计（验证「替换」假设）

- 统计范围：载荷前 262144 字节
- 8 字节窗口重复次数：**2644**
- 随机数据期望重复数 ≈ 1.86e-09 次（3e+10 个窗口对的碰撞概率 2^-64）

| 重复内容 | 位置1 | 位置2 | 间距 |
|---|---|---|---|
| `abafc5c7ee7c6ae4` | `0x1ea` | `0x22f` | 69 |
| `abafc5c7ee7c6ae4` | `0x1ea` | `0x257` | 109 |
| `abafc5c7ee7c6ae4` | `0x1ea` | `0x281` | 151 |
| `abafc5c7ee7c6ae4` | `0x1ea` | `0x2d5` | 235 |
| `abafc5c7ee7c6ae4` | `0x1ea` | `0x304` | 282 |
| `abafc5c7ee7c6ae4` | `0x1ea` | `0x31c` | 306 |
| `ba572eab9fdc49e7` | `0x1a1` | `0x344` | 419 |
| `9abf06d00bd256c4` | `0x1c8` | `0x36b` | 419 |

## 组 `datah`

- 载荷 1294907 字节 / 索引 6128 字节（f8=1294907 f12=6144）

### A. 单字节 XOR / 加减 / 仿射 全空间扫描

**索引区**

| 变换 | 密钥 | 命中魔数 | 位置 |
|---|---|---|---|
| XOR | `0xb3` | GZIP | 0x117b |

- **存在候选密钥**

**载荷前 256KB**

| 变换 | 密钥 | 命中魔数 | 位置 |
|---|---|---|---|
| XOR | `0x0c` | ZLIB(默认) | 0x312e7 |
| XOR | `0x1a` | GZIP | 0xa4ee |
| XOR | `0x39` | GZIP | 0x26ca1 |
| XOR | `0x3c` | ZLIB(最大) | 0x23738 |
| XOR | `0x56` | ZLIB(最大) | 0x13444 |
| XOR | `0x5f` | GZIP | 0x167c3 |
| XOR | `0x61` | JPEG | 0xc9bc |
| XOR | `0x6b` | JPEG | 0x11737 |
| XOR | `0x92` | ZLIB(最大) | 0x25222 |
| XOR | `0xa5` | GZIP | 0xc8b4 |
| ADD | `10` | ZLIB(默认) | 0x35435 |
| ADD | `49` | ZLIB(最大) | 0x28f27 |
| ADD | `104` | ZLIB(最大) | 0x28b57 |
| ADD | `111` | ZLIB(最大) | 0x253b0 |
| ADD | `112` | JPEG | 0xc93e |
| ADD | `159` | JPEG | 0x7a11 |
| ADD | `162` | ZLIB(最大) | 0x122bc |
| ADD | `184` | GZIP | 0x199da |
| ADD | `190` | ZLIB(最大) | 0x2469e |

- **存在候选密钥**

### B. 已知明文 crib 求解替换表 S

**索引区**（无矛盾对齐点 Top 15）

| 偏移 | 覆盖密文字节数 | 命中 crib 数 | 最佳 crib |
|---|---|---|---|
| `0x0` | 306 | 20 | `data/config/string.xml` |
| `0x1` | 306 | 20 | `data/config/string.xml` |
| `0x2` | 306 | 20 | `data/config/string.xml` |
| `0x3` | 306 | 20 | `data/config/string.xml` |
| `0x4` | 306 | 20 | `data/config/string.xml` |
| `0x5` | 306 | 20 | `data/config/string.xml` |
| `0x6` | 306 | 20 | `data/config/string.xml` |
| `0x7` | 306 | 20 | `data/config/string.xml` |
| `0x8` | 306 | 20 | `data/config/string.xml` |
| `0x9` | 306 | 20 | `data/config/string.xml` |
| `0xa` | 306 | 20 | `data/config/string.xml` |
| `0xb` | 306 | 20 | `data/config/string.xml` |
| `0xc` | 306 | 20 | `data/config/string.xml` |
| `0xe` | 306 | 20 | `data/config/string.xml` |
| `0xf` | 306 | 20 | `data/config/string.xml` |

> **强候选**：偏移 `0x0` 处覆盖 306 个不同密文字节且无矛盾，
> 与明文路径 `data/config/string.xml` 一致。可据此扩展还原完整替换表。

**载荷前 64KB**（无矛盾对齐点 Top 15）

| 偏移 | 覆盖密文字节数 | 命中 crib 数 | 最佳 crib |
|---|---|---|---|
| `0xe` | 306 | 20 | `data/config/string.xml` |
| `0xf` | 306 | 20 | `data/config/string.xml` |
| `0x10` | 306 | 20 | `data/config/string.xml` |
| `0x11` | 306 | 20 | `data/config/string.xml` |
| `0x12` | 306 | 20 | `data/config/string.xml` |
| `0x13` | 306 | 20 | `data/config/string.xml` |
| `0x14` | 306 | 20 | `data/config/string.xml` |
| `0x2a` | 306 | 20 | `data/config/string.xml` |
| `0x2b` | 306 | 20 | `data/config/string.xml` |
| `0x2c` | 306 | 20 | `data/config/string.xml` |
| `0x2d` | 306 | 20 | `data/config/string.xml` |
| `0x2e` | 306 | 20 | `data/config/string.xml` |
| `0x2f` | 306 | 20 | `data/config/string.xml` |
| `0x30` | 306 | 20 | `data/config/string.xml` |
| `0x31` | 306 | 20 | `data/config/string.xml` |

> **强候选**：偏移 `0xe` 处覆盖 306 个不同密文字节且无矛盾，
> 与明文路径 `data/config/string.xml` 一致。可据此扩展还原完整替换表。

### C. 重复块统计（验证「替换」假设）

- 统计范围：载荷前 262144 字节
- 8 字节窗口重复次数：**9835**
- 随机数据期望重复数 ≈ 1.86e-09 次（3e+10 个窗口对的碰撞概率 2^-64）

| 重复内容 | 位置1 | 位置2 | 间距 |
|---|---|---|---|
| `ba57986a0556c9f4` | `0x1110` | `0x19e8` | 2264 |
| `57986a0556c9f401` | `0x1111` | `0x19e9` | 2264 |
| `986a0556c9f4018f` | `0x1112` | `0x19ea` | 2264 |
| `6a0556c9f4018f9b` | `0x1113` | `0x19eb` | 2264 |
| `0556c9f4018f9b1b` | `0x1114` | `0x19ec` | 2264 |
| `56c9f4018f9b1bf9` | `0x1115` | `0x19ed` | 2264 |
| `c9f4018f9b1bf9e4` | `0x1116` | `0x19ee` | 2264 |
| `f4018f9b1bf9e410` | `0x1117` | `0x19ef` | 2264 |

## 组 `datax`

- 载荷 3691991 字节 / 索引 7533 字节（f8=3691991 f12=7549）

### A. 单字节 XOR / 加减 / 仿射 全空间扫描

**索引区**

| 变换 | 密钥 | 命中魔数 | 位置 |
|---|---|---|---|
| — | — | 无命中 | — |

- XOR/ADD 全空间无魔数命中

**载荷前 256KB**

| 变换 | 密钥 | 命中魔数 | 位置 |
|---|---|---|---|
| XOR | `0x0b` | ZLIB(最大) | 0x17d11 |
| XOR | `0x19` | ZLIB(最大) | 0x262c6 |
| XOR | `0x1b` | GZIP | 0x9adf |
| XOR | `0x40` | ZLIB(默认) | 0x27af6 |
| XOR | `0x5c` | JPEG | 0x2e2d8 |
| XOR | `0x63` | JPEG | 0xe5d9 |
| XOR | `0x7c` | ZLIB(默认) | 0x282ec |
| XOR | `0x7d` | GZIP | 0x3624d |
| XOR | `0x81` | ZLIB(最大) | 0x1ffd6 |
| XOR | `0x88` | GZIP | 0x2699d |
| ADD | `21` | ZLIB(默认) | 0x2efed |
| ADD | `31` | JPEG | 0xf932 |
| ADD | `43` | ZLIB(默认) | 0x3ba0d |
| ADD | `90` | JPEG | 0x1c051 |
| ADD | `136` | GZIP | 0x2699d |
| ADD | `150` | GZIP | 0xb31d |
| ADD | `162` | ZLIB(默认) | 0xf432 |
| ADD | `172` | ZLIB(默认) | 0x3c64f |
| ADD | `180` | 对话框 XML | 0x30665 |
| ADD | `190` | JPEG | 0x36ae8 |

- **存在候选密钥**

### B. 已知明文 crib 求解替换表 S

**索引区**（无矛盾对齐点 Top 15）

| 偏移 | 覆盖密文字节数 | 命中 crib 数 | 最佳 crib |
|---|---|---|---|
| `0x0` | 306 | 20 | `data/config/string.xml` |
| `0x1` | 306 | 20 | `data/config/string.xml` |
| `0x2` | 306 | 20 | `data/config/string.xml` |
| `0x3` | 306 | 20 | `data/config/string.xml` |
| `0x4` | 306 | 20 | `data/config/string.xml` |
| `0x5` | 306 | 20 | `data/config/string.xml` |
| `0x6` | 306 | 20 | `data/config/string.xml` |
| `0x7` | 306 | 20 | `data/config/string.xml` |
| `0x8` | 306 | 20 | `data/config/string.xml` |
| `0x9` | 306 | 20 | `data/config/string.xml` |
| `0xa` | 306 | 20 | `data/config/string.xml` |
| `0xb` | 306 | 20 | `data/config/string.xml` |
| `0xc` | 306 | 20 | `data/config/string.xml` |
| `0xd` | 306 | 20 | `data/config/string.xml` |
| `0xe` | 306 | 20 | `data/config/string.xml` |

> **强候选**：偏移 `0x0` 处覆盖 306 个不同密文字节且无矛盾，
> 与明文路径 `data/config/string.xml` 一致。可据此扩展还原完整替换表。

**载荷前 64KB**（无矛盾对齐点 Top 15）

| 偏移 | 覆盖密文字节数 | 命中 crib 数 | 最佳 crib |
|---|---|---|---|
| `0x7` | 306 | 20 | `data/config/string.xml` |
| `0x8` | 306 | 20 | `data/config/string.xml` |
| `0x9` | 306 | 20 | `data/config/string.xml` |
| `0xa` | 306 | 20 | `data/config/string.xml` |
| `0x2b` | 306 | 20 | `data/config/string.xml` |
| `0x2c` | 306 | 20 | `data/config/string.xml` |
| `0x2d` | 306 | 20 | `data/config/string.xml` |
| `0x2e` | 306 | 20 | `data/config/string.xml` |
| `0x2f` | 306 | 20 | `data/config/string.xml` |
| `0x30` | 306 | 20 | `data/config/string.xml` |
| `0x31` | 306 | 20 | `data/config/string.xml` |
| `0x32` | 306 | 20 | `data/config/string.xml` |
| `0x33` | 306 | 20 | `data/config/string.xml` |
| `0x34` | 306 | 20 | `data/config/string.xml` |
| `0x35` | 306 | 20 | `data/config/string.xml` |

> **强候选**：偏移 `0x7` 处覆盖 306 个不同密文字节且无矛盾，
> 与明文路径 `data/config/string.xml` 一致。可据此扩展还原完整替换表。

### C. 重复块统计（验证「替换」假设）

- 统计范围：载荷前 262144 字节
- 8 字节窗口重复次数：**3574**
- 随机数据期望重复数 ≈ 1.86e-09 次（3e+10 个窗口对的碰撞概率 2^-64）

| 重复内容 | 位置1 | 位置2 | 间距 |
|---|---|---|---|
| `ba57565661948795` | `0x496` | `0x11d3` | 3389 |
| `5756566194879539` | `0x497` | `0x11d4` | 3389 |
| `5656619487953981` | `0x498` | `0x11d5` | 3389 |
| `5661948795398141` | `0x499` | `0x11d6` | 3389 |
| `61948795398141b3` | `0x49a` | `0x11d7` | 3389 |
| `948795398141b3c8` | `0x49b` | `0x11d8` | 3389 |
| `8795398141b3c838` | `0x49c` | `0x11d9` | 3389 |
| `95398141b3c838b9` | `0x49d` | `0x11da` | 3389 |

## 总判定

| 组 | 区域 | 最佳无矛盾对齐 | 覆盖字节 |
|---|---|---|---|
| `data` | 索引区 | `0x29` | 306 |
| `data` | 载荷前 64KB | `0x7` | 306 |
| `datah` | 索引区 | `0x0` | 306 |
| `datah` | 载荷前 64KB | `0xe` | 306 |
| `datax` | 索引区 | `0x0` | 306 |
| `datax` | 载荷前 64KB | `0x7` | 306 |

若覆盖字节数达到 30+，即可把 S 表外推解出全部资源；
否则需回到 `.so` 取 S 表（它极可能就以 256 字节常量表形式存在于 `.rodata` 中——
可直接在 rodata 里搜一段 0..255 的置换表来定位）。
