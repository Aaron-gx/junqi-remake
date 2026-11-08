# 走子动画 1:1 核对报告

**问题**：原版 `com.cnvcs.junqi` v1.58 的「棋子移动过程 / 速度 / 效果」是否与复刻工程一致？
**结论**：**时长 / 速度 / 插值 三者与原版是同一公式，数值差异仅到 float32 的舍入级（相对偏差 1.567e-07）**；
路径跟随、开关缺省值、音效触发点由反汇编 + 复刻测试套件确认。
唯一**未经活体逐帧实测**的是亚秒级视觉时序细节（被吃子消失那一帧、翻子视觉、音效落点），
原因是雷电模拟器的合成器不给逐帧画面（见 §4）。

---

## 1. 原版在做什么（反汇编结论）

两个函数，全部逐条核对过：

| 函数 | 职责 | 关键行为 |
|---|---|---|
| `FUN_0003b3d0` | 设置动画 | `PieceAni==0` → 直接 `Msg_Move()` 落位；否则逐段算欧氏长，求 `speed` |
| `FUN_0003c468` | 每帧推进 | `dist=(now−start)·speed/1000`，沿折线逐段累减后**段内线性插值**；走完才 `Msg_Move()` |

```
speed(px/s) = powf(stride, 0.2) · powf(total, 0.8) / 0.4
duration_ms = 1000 · total / speed
            = 400 · (total / stride)^0.2          ← 化简后
```

- `stride` = 对象 `+0x38` = 列像素步距（复刻侧取 `PITCH_X = 140.5` 原图 px）
- 汇编证据（Thumb，文件偏移）：`0x2c6d4–0x2c70e`；常量 `0.2f@0x2c72c`、`0.8f@0x2c730`、`0.4f@0x2c734`
- `PieceAni` 开关在对象 `+0x65`，**默认 1 = 开**（`FUN_00031626` 读取）；native 二进制里**没有**「动画」字符串，即无 App 内开关
- **无缓动**（no easing）：分段线性，速度恒定

## 2. 逐值对照（本报告的核心证据）

不复述公式，而是**让复刻工程自己跑一遍**，再用 float32 复算原版公式去比：

- `tools/_bench/anim_equiv.ts` —— Node 真跑 `src/ui/anim.ts` 的 `animDurationMs` / `animPointAt` / `cumulative`，
  扫 0..1600px（0.5px 步进）的时长曲线 + 4 条真实路径逐帧位置 → `_equiv.json`
- `tools/_bench/compare_anim.py` —— numpy **float32** 逐寄存器复算原版 `powf/vmul.f32/vdiv.f32` 语义后比对

```bash
node --experimental-transform-types tools/_bench/anim_equiv.ts > _equiv.json
E:/Software/Tools/pyenv/Scripts/python.exe tools/_bench/compare_anim.py      # ← 需带 numpy 的环境
```

**结果**

| 项 | 结果 |
|---|---|
| 时长公式（3200 个距离） | 最大相对偏差 **1.567e-07**（total=747.5px：复刻 558.787865ms vs 原版 558.787777ms） |
| 逐帧位置进度 | 最大偏差 **≤ 5.4e-05 px** |
| 线性度 | 各段速度**恒定**（如 poly 折线 1196.27 px/s）⇒ 两边都无缓动 |

**关键锚点（毫秒）**

| 着法 | 路径 px | 复刻 | 原版 | 差 |
|---|---|---|---|---|
| 纵向 1 格 | 70.6 | 348.57 | 348.57 | -2.5e-05 |
| 横向 1 格（基准） | 140.5 | 400.00 | 400.00 | 0 |
| 行营斜步 | 157.2 | 409.11 | 409.11 | 1.1e-05 |
| 铁路 3 格 | 421.5 | 498.29 | 498.29 | 3.3e-05 |
| 铁路 5 格 | 702.5 | 551.89 | 551.89 | 1.2e-06 |
| 铁路 10 格 | 1405.0 | 633.96 | 633.96 | 3.5e-05 |
| 9 格折线 | 845.0 | 572.66 | 572.66 | -1.7e-05 |

> 手感来源：指数只有 0.2，所以**距离翻 10 倍、时长只涨 1.6 倍**——单步 400ms，横穿 10 格也才 634ms。
> 「原版看起来不着急」就是这个指数造成的。

## 3. 其余效果的落地方式

| 效果 | 实现 | 验证 |
|---|---|---|
| 沿**实际路径**飞（铁路拐弯不抄近道） | `src/core/path.ts` `pathBetween` + `animPointAt` 折线插值 | `tests/run.ts` §17（3 盘面 × 双方 × 全着法不变量）；`?animprobe=1` 9 格折线 845px/573ms、离路径 0.4px |
| 被吃子**留到落位那一刻**才消失 | 动画期间用 `anim.pre`（走子前盘面）作视角绘制 | `main.ts` `MoveSpec.pre`；`?animprobe=1` 落位后残影 **0 像素** |
| **暗棋**下不掀开对方暗子 | 动画期间视角取 `anim.pre.owner[anim.from]` | `?animprobe=1` 暗棋帧 vs 走子前静态帧，变化盒 78×50（不扩散） |
| 落位后才轮到 AI 思考 | `beginMoveAnim(...).done → draw() + scheduleAi()` | `?ai=4&lv=2` / `?flipai=6&lv=2&rng=1` 空转 0 次 |
| 音效：走子 `move` / 吃 `eat` / 阵亡 `dead` / 翻子 `flip` / 战斗开始 `start` | `main.ts` 按 `Msg_Move` 之后的着法结果分派（`964 / 985 / 990 / 1057 / 1080 / 1083 / 1095 / 750`） | 代码级核对；**未**做原版音频落点实测 |
| 「走子动画」开关，缺省开 | `main.ts` `animEnabled = true`，对应 `PieceAni` | 设置面板 + 代码 |

**测试总账**：`tests/run.ts` **269 通过 / 0 失败**；`tsc --noEmit` 0 错误。

## 4. 诚实声明：哪一项没实测到

原本想用**模拟器逐帧抓拍**去量原版的飞行轨迹，**做不到**：

| 抓帧通道 | 实测帧率 |
|---|---|
| `adb exec-out screencap` | ~2.6 fps |
| `adb shell screenrecord` | ~1.2 fps |
| 主机侧 GDI BitBlt（`tools/_bench/win_grab.py`） | 采集端 ~60fps，但**内容更新率 0~1.9 次/秒** |

根因：雷电（LDPlayer9）合成器**只在内容变化时重绘且被节流**；抓 `RenderWindow` 子 hwnd（561×997）也无改善。
⇒ 400ms 的走子动画**只能拿到起点帧和落地帧**，中间轨迹拿不到。
（顺带一个坑：GDI 抓到的 box 是 **561×997**，不是设备 900×1600；换算 `dev_x=grab_x·900/561`、`dev_y=grab_y·1600/997`。）

因此下面三项是**代码 + 测试级**结论，不是活体像素实测：
**被吃子消失的那一帧**、**翻子视觉**、**音效落点时刻**。

**若要做活体时序实证**（可选，一条捷径）：
`Msg_Move` 是**动画跑完才发**的，而落位才播 `move` 音效 ——
所以录**主机音频回环**，量「点击音 → 落位音」的间隔即≈动画时长。
Windows 用 `sounddevice` 的 `WasapiSettings(loopback=True)`（pyenv 当前缺该包，需先 `pip install sounddevice`）。

## 5. 复跑清单

```bash
cd work/2026.9.10-base-apk/07-remake
node --experimental-transform-types tests/run.ts          # 269/269
node --experimental-transform-types tools/_bench/anim_equiv.ts > _equiv.json
E:/Software/Tools/pyenv/Scripts/python.exe tools/_bench/compare_anim.py
node tools/dom.mjs "http://127.0.0.1:5180/?animprobe=1" "#probeResult"   # 8/8
```
