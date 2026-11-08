# SPAK / assets 数据容器侦察

- 目录: `02-apktool/assets`
- 文件数: 8

| 文件 | 大小 | magic | 版本 | 字段@4 | 字段@8 | 头部熵 | 全局熵 |
|---|---|---|---|---|---|---|---|
| `data0.pak` | 1,000,000 | `b'SPAK'` | 1 | 1 | 1235978 | 7.94 | 8.00 |
| `data1.pak` | 238,714 | `b'\x17\xc01\x07'` | 2589233886 | 2589233886 | 1739658698 | 7.95 | 8.00 |
| `datah0.pak` | 1,000,000 | `b'SPAK'` | 1 | 1 | 1294907 | 7.95 | 8.00 |
| `datah1.pak` | 301,051 | `b'\x10\x06\x9f\x90'` | 3867076467 | 3867076467 | 4145268997 | 7.96 | 8.00 |
| `datax0.pak` | 1,000,000 | `b'SPAK'` | 1 | 1 | 3691991 | 7.95 | 8.00 |
| `datax1.pak` | 1,000,000 | `b'u\x8e\xa0\xa9'` | 1376683226 | 1376683226 | 2387843081 | 7.96 | 8.00 |
| `datax2.pak` | 1,000,000 | `b'o\xc41\x06'` | 2319356578 | 2319356578 | 3789032002 | 7.95 | 8.00 |
| `datax3.pak` | 699,540 | `b'\xfb$\xec{'` | 3109113520 | 3109113520 | 3564002268 | 7.96 | 8.00 |

## 分片重组（按 base 前缀聚合）

- **data***: 2 片 / 共 1,238,714 字节 → ['data0.pak', 'data1.pak']
  - 重组后总熵: 8.000（>7.5 近似压缩/加密，<7 多为可读数据）
  - 1MB 边界处 magic 分布: {b'SPAK': 1, b'\x1a-\xf5d': 1}
- **datah***: 2 片 / 共 1,301,051 字节 → ['datah0.pak', 'datah1.pak']
  - 重组后总熵: 8.000（>7.5 近似压缩/加密，<7 多为可读数据）
  - 1MB 边界处 magic 分布: {b'SPAK': 1, b'\xa9Zd\xf4': 1}
- **datax***: 4 片 / 共 3,699,540 字节 → ['datax0.pak', 'datax1.pak', 'datax2.pak', 'datax3.pak']
  - 重组后总熵: 8.000（>7.5 近似压缩/加密，<7 多为可读数据）
  - 1MB 边界处 magic 分布: {b'SPAK': 1, b'E\xd7\x91\xb1': 1, b'P\xfa\x1fk': 1, b'\xdcr)\xc5': 1}

## 数据区可打印字符串（Top 120，按长度 ≥6）

共 10021 条可打印串 / 去重 9405 条

```
W9YkAz
jv6L6}
j/V8m[&
Pd:$IE
PsWVYur
r_1Q)d
[><gFB
'UKA#R!
cTZ|-gO
*c'PgVN
igu13.
p%Rx}}
5dxVk'
5`xvk'
iy9c_V\
N\CW}t
(RVOPa
?iMrQ86
ynm^_3xhER
n_|?CG
0odvh]
N;72[X
.-3jg\
q_xA1&
5]kPq(
Xn1]o)
r++J,,
#B:R:s
r*3>L@
]rY|!O#
-`LnUpn
n6 e(pvttt[
 .cL; 2
#F:r:s
RQDB9!
T]$uSYt
C7}b&@
u^^vr)
Cco+04
N;42CXy]
N Ep)pL
mS|Shi
[B6GP]
F;t2CZy
34&bP}Y\J
Z`\jM-
Ym[%|G4
9@'4P8KL6
<i'c16E
u6,osd
z&')u%
;.5*+g
FYiB2l
249/?Y
'Py4$q
hy7c/V
Ls*=><
a(=wj1r
2^#W|)G
/#B;R2s[
/: !c|z
h/#F;r2sZ
?bhJQ3
u*z:T`
UdyUc?U\
}MI]y)@
5@aa5I
Dr29S>
p5CzNQhF9
o<p3e'
>%e0?Q.^2
=T5qTN
O46)W4
@Vy%!,
w\oVcE
S)n-Kk
5ex^kg
U!I9x$G6;w
}1n^H5
?~JE}C
d7Y,"e
x?%R`a;
\16Q)c
kX(_t(
^&>jd{c
am:n3.
H]SU]Tt
Y6/^c%YQ
zF%v+i?[G|
dYrbH]
/cE;h2
Uhx5k?
wOm{% }
Rb2xh6y^J
(5@;Yt{
TBG|E=D
#C:Z:3
~rR^g>R
K{CzM6
3&m&Aa
dwY, e
Mj&{M)
F"Me}JW
7U1n}5
,tye$z
{X5\8L
dyWc/U
Lr*5>|
$0K@'{9
lD}r#?!]
%_S[Ss
%JV|Q2
,3?=}~
9;:`1b
1vMd4'
9Ht{="
-&jp]W
|B>]vF
5ax~kg
d:}@2}
```

## 内嵌文件魔数探测

- `data0.pak`: GZIP×16, JSON-ish×3883, JSON array×3867, JSON×17
- `data1.pak`: GZIP×1, JSON-ish×908, JSON array×959
- `datah0.pak`: GZIP×17, JSON-ish×3923, JSON array×3915, JSON×15
- `datah1.pak`: GZIP×5, JSON-ish×1184, JSON array×1183, JSON×3
- `datax0.pak`: GZIP×21, JSON-ish×4052, JSON array×3851, JSON×12
- `datax1.pak`: GZIP×11, JSON-ish×3878, JSON array×3930, JSON×17, DDS×1
- `datax2.pak`: GZIP×18, JSON-ish×3938, JSON array×3776, JSON×11, DDS×1
- `datax3.pak`: GZIP×14, JSON-ish×2655, JSON array×2704, JSON×13
