/**
 * 原版页面外壳 —— 按实拍标定重建 `com.cnvcs.junqi` 的游戏页骨架。
 *
 * 为什么单独一个模块：`renderer` 只管"棋盘怎么画"，`main` 只管"事件怎么接"；
 * 而"标题栏多高 / 棋盘铺多大 / 图标摆哪儿"是**几何**问题，和棋盘几何同源，
 * 所以和 `boardart.ts` 一样，把实测出来的常量集中在这里，供 `main` 取用。
 *
 * ── 标定（雷电 9 · 900×1600 竖屏实拍，见 SPEC §9.7）──────────────
 *
 * 做法：把 `board.png` 按不同 (scale, x0, y0) 缩放后与实拍截图直接求差，
 * 在网格上搜最小值 —— 结果是**唯一解**，而且是个整数：
 *
 * | 量 | 实拍（设备像素） | 原图单位（÷ 1.25） |
 * |---|---|---|
 * | 棋盘缩放 | **1.2500**（= 900/720） | 1（基准） |
 * | 棋盘原点 | (0, **150**) | (0, 120) |
 * | 标题栏 | y 0 … 149，纯**横向**渐变 `(156,217,246) → (89,200,244)` | 高 **120** |
 * | 「军棋」logo | 字形 264×110，中心 (450, 74) | 字形高 **88.0**，中心 (360, 59.2) |
 * | 局内左图标（☰ 菜单） | 图幅中心 (272.0, 873.5) | (217.6, **699**) |
 * | 局内右图标（↻ 悔棋） | 图幅中心 (628.0, 873.5) | (502.4, **699**) |
 * | 布阵工具栏面板 | x 29…871，y 406…705 | x **23**, y **325**, **675×240** |
 *
 * 与棋盘对齐后的残差中位数 = **1**（0…255 量级）⇒ 棋盘本身是逐像素重合的。
 *
 * 三个关键结论：
 *  1. **设计空间 = 720 × 1280**，原点 = 屏幕左上角（含标题栏）。
 *     900×1600 时 scale 恰好 1.25 = 900/720 = 1600/1280，无取整误差。
 *     标题栏高 = 1280 − 1160 = **120**，且 120 × 1.25 = **150** = 实拍分界行。
 *  2. 界面 XML（`datax/*.xml`）用的就是这个坐标系：
 *     `rect="c-337,c-315,w675,h240"` ⇒ x = 360−337 = 23、y = 640−315 = 325，
 *     与实拍量到的 (23, 325) 完全一致（实拍量的是设备 406…705 ⇒ 325…564）。
 *  3. **`datax` 命名空间里的素材一律按 1:1 画**（设备 1.25×）—— 棋盘、棋子是这样，
 *     局内浮动图标**也是**：右图标的图幅 116×85 设备 px 正好 = 93×68 × 1.25。
 *     所以**没有**额外的图标缩放系数（旧版按 720/900 = 0.8 缩，是错的）。
 *     `datah` 是 480dp 的一套，`datax = datah × 1.5`。
 *
 * 图标用哪个素材：把候选素材按「alpha 合成到 board.png 上」再与实拍求差，
 * 逐像素选出唯一吻合的那个（残差 ≈ 3.5 / 255）：
 *   · 对局中(布局/翻棋) 左槽 = `float_menu.png`（☰，93×68，源自 datax/90f39347…）
 *   · 布阵界面   左槽 = `float_lay.png` （90×68，源自 datax/5c8b7866…）
 *   · 两模式     右槽 = `icon_next.png`（↻，93×68）
 * 注意 `icon_menu.png`(77×77) **不是**局内那个 —— 它的字形更大，残差 26。
 */
import { ART_H, ART_W } from "./boardart.ts";
import type { View } from "./renderer.ts";
import { textBitmap } from "./textbmp.ts";

/** 原版实拍基准屏宽（设备像素）。所有"1:1 绘制"的素材都按这个宽度标定。 */
export const REF_W = 900;

/** 设计空间：宽 = 棋盘位图宽，高 = 标题栏 + 棋盘 = 1280（正好是 720 的 16:9）。 */
export const DESIGN_W = ART_W; // 720
export const TITLE_H = 120; // 标题栏高（原图单位）＝ 1280 − 1160
export const DESIGN_H = TITLE_H + ART_H; // 1280

/**
 * 「军棋」标题 logo —— 素材 `title_2p_s.png`（图幅 236×113）。
 *
 * ★ 结论：原版**就是把这 236×113 的素材按 art 1:1 画出来**（设备 1.25× ⇒ 295×141.25），
 *   既没有额外缩放、也不是 `fitXY` 非等比拉伸。曾误算成「字形对字形分别换算」而缩到
 *   220.5×98.5，实拍量出来偏小 6%/13%，是这一轮唯一的标题栏残差来源。
 *
 * 推导（唯一锚点 = 实拍字形包围盒，阈值 130）：
 *   素材自身 alpha>130 包围盒 = (12,12)-(223,100) ⇒ 212×89，中心 (117.5, 56.0)
 *   实拍字形 = 设备 (318,20)-(581,129) = 264×110 ⇒ 原图单位 211.2×88.0，中心 (359.6, 59.6)
 *     · 横向 264/212 = 1.2453、纵向 110/89 = 1.2360 —— **两者都等于 1.25**（差 <1%，是阈值噪声），
 *       故等比、且缩放恰为原图单位密度 ⇒ 素材原始图幅即绘制框。
 *   框中心 = 实拍字形中心 + (框中心 − 素材字形中心) = (359.6 + 0.5, 59.6 + 0.5) = (360.1, 60.1)，
 *   再按首次渲染实测残差 (Δεx, Δεy) = (−0.4, −0.8) 修正 ⇒ **(359.7, 59.3)**。
 *
 * ⚠️ 该 logo 必须 `position: absolute` 才会用上 `LOGO_CX/CY`（见 style.css 的 `.title-logo`）；
 *    若是 `static`，`left/top` 会被忽略、退回 grid 居中 ⇒ 横向再偏 ~1.8px。
 */
export const LOGO_BOX_W = 236; // 素材原始图幅（art）
export const LOGO_BOX_H = 113;
export const LOGO_CX = 359.7; // 框中心（art，相对标题栏左上角）
export const LOGO_CY = 59.3;

/**
 * 局内两枚浮动图标：**素材按 1:1 画**（与棋盘同一套 datax 密度），
 * 位置以**图幅中心**计，单位是原图单位、坐标系以棋盘区左上角为原点
 * （= 屏幕左上角下移 TITLE_H ⇒ 屏坐标 699）。
 *
 * 实测值（相对列中心 219 / 500 有 ≤1.8 的偏差，以实拍为准）：
 *   · 左槽图幅中心 (217.6, 699)，素材 93×68
 *   · 右槽图幅中心 (502.4, 699)，素材 93×68
 */
export const FLOAT_Y = 579; // 中缝中线（棋盘行 5 的 703 与行 6 的 455 的中点）= 屏坐标 699
export const FLOAT_X_LEFT = 217.6;
export const FLOAT_X_RIGHT = 502.4;
/** 两枚浮动图标的素材图幅（原图单位）—— 93×68 是 datax 里那套工具栏图标的画布尺寸。 */
export const FLOAT_ART_W = 93;
export const FLOAT_ART_H = 68;

/**
 * 布阵工具栏面板 —— 原版 `data/image/…` 的 XML：
 * `rect="c-337,c-315,w675,h240"` ⇒ x = 360−337 = **23**、y = 640−315 = **325**（屏坐标）。
 * 落到棋盘区坐标就是 y = 325 − 120 = **205**。
 */
export const EDIT_BAR = { x: 23, y: 205, w: 675, h: 240 };

// ─────────────────────────────────────────────────────────────
// 首页（启动主菜单）
// ─────────────────────────────────────────────────────────────
/**
 * 首页 = 原版实拍 `tools/_emu/s03.png`：全屏背景图 + 「军棋」大标题 + 4 个按钮。
 *
 * 坐标系仍是设计空间 720×1280 —— 原版的启动菜单界面 XML 用的就是它，
 * 所以按钮几何**直接抄 XML**（`datax/03c98d1bf853ed6dd22fb89add21cbaa.xml`），
 * 不用目测：那个文件写 `BackDlg rect="172,865,w375,h320"`，四个子按钮
 * `(30,0)-(345,90)`、`(30,115)-(345,205)`、`(0,230)-(172,320)`、`(203,230)-(375,320)`。
 * 加上父框原点即得下面的绝对坐标；×1.25 落到 900×1600 后与实拍量到的
 * 252/1081、252/1225、215/1371、469/1371 差 ≤1.5px（阈值噪声）。
 *
 * ★ 别用 `title_2p_s.png`（标题栏里那枚 236×113）当这里的标题：
 *   它的字距被压过，宽高比 2.19 与首页的 2.18 对不上，按 alpha 合成匹配的
 *   残差是 68.7 对 4.24。首页标题是图幅 **507×266** 的那一张，按 art 1:1 画。
 *
 * ★ y 是 104.8 不是 105.6：alpha 合成匹配给的是 105.6（±0.5），但那个位置落在
 *   缩放前的半个像素格上，1.25× 上采样后会整体偏 1px。取 104.8 让残差从 7.75
 *   掉到 1.01（>40 的像素归零）。这类"匹配残差最优 ≠ 显示最优"的坑，一律以
 *   最终实拍差分为准。
 */
export const HOME_TITLE = { x: 109.6, y: 104.8, w: 507, h: 266 };

/** 首页按钮字号（art px）。由实拍扫参定：45 时楷体墨迹包围盒 215×48 设备px，与原版一致。 */
export const HOME_TEXT_SIZE = 45;
/** 「四国军棋」是两个字的窄按钮，字号与行距单独一档（27.8 时墨迹 67×75 设备px）。 */
export const HOME_SG_TEXT_SIZE = 27.8;
export const HOME_SG_LINE_HEIGHT = 1.25;
/**
 * 字面在按钮内容区里的纵向微调（art px，负数上移）。
 *
 * 字体的 ascent/descent 与行盒高度不整除，`cy` 居中后字面还会差零点几像素；
 * 这几个数是拿原版实拍的墨迹中心反推的（扫参：dy=-1 时行1 残差 11.0 → 8.8，
 * -0.5 又回到 11.0，说明确实落在一个像素格上，不是噪声）。
 */
export const HOME_LABEL_DY = -1;
export const HOME_SG_LABEL_DY = 0;

export interface HomeButton {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 「四国军棋」那种两行排布的按钮。 */
  twoLine?: boolean;
  /**
   * 两行按钮的**实际字面**（含 `\n`）。
   * 缺省用 `label` —— 之所以要这个覆盖项：「四国军棋」断成"四国/军棋"是刻意的排版，
   * 而 `label` 还必须保持无换行的原文（无障碍名 / 自检断言都读它），两者不能混。
   */
  text?: string;
}

/**
 * 首页四个按钮 + 右下角「四国军棋」入口（原版是进另一个联网游戏，这里同样只做入口）。
 *
 * ⚠️ 子节点 `rect="30,0,345,90"` 是 **(left, top, right, bottom)**，不是 w/h ——
 *    所以「人机对战」宽 = 345−30 = **315**，不是 345 也不是父框的 375。
 *    判据：四个子框的 right 都 ≤ 父框宽 375、bottom 都 = 320 = 父框高，
 *    且左右内边距对称（30 / 375−345=30）、中间缝也对称（172 / 375−203=172）。
 *    按 w/h 读的话「联机」会溢出父框 203+375 > 375，明显不成立。
 *    ×1.25 落到实拍：按钮盒 252..645（= art 201.6..516，宽 314.4）、
 *    行 3 的 215..429 / 469..683（= art 172..343.2 / 375.2..546.4）—— 全部 ≤1.5px。
 */
export const HOME_BUTTONS: HomeButton[] = [
  { id: "btnOne", label: "人机对战", x: 202, y: 865, w: 315, h: 90 },
  { id: "btnTwo", label: "两人对战", x: 202, y: 980, w: 315, h: 90 },
  { id: "btnNet", label: "联网", x: 172, y: 1095, w: 172, h: 90 },
  { id: "btnPeer", label: "联机", x: 375, y: 1095, w: 172, h: 90 },
  // 「四国军棋」不在那份 XML 里 —— 它是页面上钉在右下角的独立按钮，
  // 实测包围盒 设备 (727..858, 1375..1491) ⇒ art (581.6, 1100) 105.6×93.6。
  { id: "btnSg", label: "四国军棋", x: 581.6, y: 1100, w: 105.6, h: 93.6, twoLine: true, text: "四国\n军棋" },
  // ── 「AI 观战」（复刻版自加，2026-09-15）──────────────────────────
  //    原版首页没有这一格。它**钉在「四国军棋」正上方**：同一列、同一宽高
  //    （105.6×93.6 art），与 btnSg 只差 y 一个行距 —— 于是原版那 5 枚按钮的
  //    位置一个都不动（首页其余部分仍与实拍逐像素一致）。
  //    那一块底图是纯草地/树（pixel 采样确认），压一个按钮不破坏构图。
  { id: "btnWatch", label: "AI 观战", x: 581.6, y: 1000, w: 105.6, h: 93.6, twoLine: true, text: "AI\n观战" },
];

/**
 * 首页左下角那枚「小房子」（回主页）图标 —— 原版是 `datax` 里的 **90×90**，
 * 按 art 1:1 画（设备 112.5）。alpha 合成匹配残差 2.20，得框原点 **(44.8, 1104.8)**。
 * 它是独立图层：`bg_main.jpg` 那一块是空的草地（逐像素验证过）。
 */
export const HOME_HOUSE = { x: 44.8, y: 1104.8, w: 90, h: 90 };

export interface ShellLayout {
  /** 设计空间在屏幕上的整体缩放。 */
  scale: number;
  /** 设计空间（= 应用容器）的 CSS 尺寸。 */
  width: number;
  height: number;
  /** 标题栏高（CSS px）。 */
  titleH: number;
  /** 交给 `renderer` 的棋盘视图（ox/oy 是相对画布，画布 = 棋盘区）。 */
  view: View;
}

/**
 * 按原版规则排版：**设计空间 720×1280 整体等比缩放，水平居中**。
 * 900×1600 时 scale = 1.25（两个方向同时满足），标题栏 150 设备 px —— 与实拍完全一致；
 * 其它比例下取较小者，宁可留黑边也不拉伸棋盘。
 */
export function layoutShell(cssW: number, cssH: number): ShellLayout {
  const scale = Math.min(cssW / ART_W, cssH / DESIGN_H);
  const width = ART_W * scale;
  const height = DESIGN_H * scale;
  const titleH = TITLE_H * scale;
  return {
    scale,
    width,
    height,
    titleH,
    // 画布 = 标题栏以下整块，棋盘左上角就贴着 (0, 0)。
    view: { scale, ox: 0, oy: 0 },
  };
}

/** 把原图单位换算成 CSS px（用于给 DOM 元素定位）。 */
export function art(scale: number, v: number): number {
  return v * scale;
}

// ─────────────────────────────────────────────────────────────
// DOM 构件
// ─────────────────────────────────────────────────────────────

/** 原版「蓝色按钮」皮肤（`btn.cfg` → btn.png 九宫格）。 */
export const SKIN_BTN = "btn";
/** 原版「对话框底板」皮肤（`dlg.cfg` → dlg.png 九宫格）。 */
export const SKIN_DLG = "dlg";

/**
 * 必须写成 `border-image-slice: … fill` 的皮肤。
 *
 * 这五张是**竖直渐变**的按钮底板，它们的「中段」在源图里只有 1px 高：
 * btn.png 24×90，上切片 44 + 下切片 45 已经吃掉 89px，中间只剩 1 行。
 * CSS 的 `border-image-slice` **默认不绘制中间那一格**，于是按钮正中会漏出
 * 一条 1~2px 的透明缝 —— 首页实拍 y=1136 / 1280 / 1424 露出底下的草地色
 * （(193,215,80)），而原版是连续渐变。原版引擎本来就把中段一并填上，
 * 所以这几张必须补 `fill`。
 *
 * 别顺手把 popup/dlg 也加进来：它们的中段是半透明黑底，页面另有 CSS
 * 底色，重复填充会二次压暗。
 */
export const SKIN_FILL: readonly string[] = [
  "btn",
  "btn1",
  "sbtn",
  "sbtn1",
  "sbtn2",
  "dlg",
];

/**
 * 局内浮动图标按钮。`wArt/hArt` 是**素材图幅**（原图单位，datax 素材 1:1）。
 * 原版这两枚图标**没有底板**，直接浮在棋盘上。
 */
export function floatButton(
  wArt: number,
  hArt: number,
  file: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "float-btn";
  b.title = label;
  b.setAttribute("aria-label", label);
  const img = document.createElement("img");
  img.src = `./assets/${file}`;
  img.alt = label;
  img.draggable = false;
  b.appendChild(img);
  b.dataset.w = String(wArt);
  b.dataset.h = String(hArt);
  b.addEventListener("click", onClick);
  b.dataset.file = file;
  return b;
}

/** 换掉浮动按钮的图标（原版这两个槽位的内容随界面状态变）。 */
export function setFloatIcon(el: HTMLElement, file: string, label: string): void {
  el.dataset.file = file;
  el.title = label;
  el.setAttribute("aria-label", label);
  const img = el.querySelector("img");
  if (img) {
    if (!img.getAttribute("src")?.endsWith(file)) img.setAttribute("src", `./assets/${file}`);
    img.alt = label;
  }
}

/** 把浮动按钮按原图单位摆到棋盘上（`x/y` 是**中心**）。 */
export function placeFloat(
  el: HTMLElement,
  scale: number,
  cx: number,
  cy: number,
  wArt: number,
  hArt: number,
): void {
  const w = wArt * scale;
  const h = hArt * scale;
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  el.style.left = `${cx * scale - w / 2}px`;
  el.style.top = `${cy * scale - h / 2}px`;
}

export interface DialogButton {
  label: string;
  value: string;
  onCycle: () => void;
}

/* ── 对话框文字标定（全部来自实拍反推，见 tools/_audit/dlg_font_iou.py）────────
 * 做法：把候选字体按 design 尺寸渲染 → ×1.25 放大 → 与原版实拍同框求二值 IoU。
 * 结论（IoU 越高越像）：
 *   「确定」ZYKai 45 字距0 → 0.710   「取消」ZYKai 44 字距1 → 0.702
 *   「我上手」ZYKai 45 字距0 → 0.512  「普通」ZYKai 45 字距2 → 0.445
 *   「新局」 ZYKai 46 字距2 → 0.428   （此项各号都以 ZYKai 领先，取 46）
 * ⇒ **整套对话框正文是楷体（`ZYKai`），不是 `--font` 的中易黑体**。
 *   早先按「界面默认字体」用 MYingHei 是错的 —— 那支在按钮上 IoU 上不了 0.3。
 * ⚠️ 行标签（「先后手:」等）的 IoU 只有 0.28~0.38，是**掩码被污染**所致：
 *   面板是半透明的，底下棋盘的白色铁路虚线与行营圆环会透上来，混进白色文字掩码。
 *   故标签同按 ZYKai 处理（与按钮值同族）。 */
export const DLG_FONT = "ZYKai";
export const DLG_TEXT_SIZE = 45;
export const DLG_TITLE_SIZE = 46;
/** 纵向微调（设计 px）。实拍量出来我们所有文字都比原版低 **1 设备 px**
 *  （标题 / 四行标签 / 四行值 / 确定 / 取消 共 10 处一致）⇒ −1/1.25 = −0.8 设计 px。 */
export const DLG_TEXT_DY = -0.8;

/** 横向微调（设计 px）。实测最优 = 0 —— 面板本身落在 28.125（`--ds` 精确，无取整误差），
 *  逐控件量（`tools/_audit/dlg_ink.py`）标签墨迹 x 与原版只差 ≤2px、y 完全一致。
 *  ⚠️ 反面教训：`tools/_audit/dlg_shift.py` 一开始对**整行**（含左右两个面板边框列）
 *  求最优平移，得到 dx = −1 且"降差 3~16%"，看着很像"文字偏右"。
 *  但把该值真设成 −0.8 重拍，全图反而 **6.08 → 7.x**、差异像素上升。
 *  原因有二：① 块的左右边缘是高对比度**面板边框**，权重盖过文字，最优解被它们带偏；
 *  ② 更本质的是**光栅化相位差** —— 我们的字在设计尺寸光栅化、原版在 App 侧光栅化，
 *  笔画亚像素落点不同，用平移去拟合必然得到单向的虚假最优解。
 *  判据：**把最优解应用一次后重跑估计器，若最优解跟着漂（−1 → −2）就不是位置问题。**
 *  详见 SPEC §9.8.6。 */
export const DLG_TEXT_DX = 0;

/** 把文字画成**设计尺寸位图**贴进元素 —— 显示宽度按 `calc(<w>px * var(--ds))`，
 *  仍由浏览器双线性放大，和原版「设计稿光栅化 → 整帧 ×1.25」一致（见 textbmp.ts）。 */
function paintText(
  el: HTMLElement,
  o: {
    text: string;
    size: number;
    color: string;
    w: number;
    h: number;
    align?: "left" | "center" | "right";
    padX?: number;
    dy?: number;
    shadow?: boolean;
    cls?: string;
  },
): void {
  const b = textBitmap({
    text: o.text,
    font: DLG_FONT,
    size: o.size,
    color: o.color,
    w: o.w,
    h: o.h,
    align: o.align,
    padX: o.padX,
    dy: o.dy,
    shadow: o.shadow,
  });
  if (!b.url) return;
  const cls = o.cls ?? "txt-bmp";
  let img = el.querySelector<HTMLImageElement>(`.${cls}`);
  if (!img) {
    el.textContent = "";
    img = document.createElement("img");
    img.className = cls;
    img.alt = o.text;
    img.draggable = false;
    el.appendChild(img);
  }
  img.style.width = `calc(${b.w}px * var(--ds))`;
  img.style.height = `calc(${b.h}px * var(--ds))`;
  // 用 `transform` 而非改 `left/top` —— 位图已经被 `--ds` 放大，
  // 平移交给合成层做，不会再走一次光栅化（保持原版的柔和边缘）。
  img.style.transform = DLG_TEXT_DX
    ? `translateX(calc(${DLG_TEXT_DX}px * var(--ds)))`
    : "";
  if (img.dataset.src !== b.url) {
    img.src = b.url;
    img.dataset.src = b.url;
  }
}

export interface DialogOptions {
  icon: string;
  title: string;
  /**
   * 是否画标题行（`Icon` + `Title`）。
   * 原版的 ☰ 菜单（`be78647b` / `cd7d9e3a`）**没有标题行** ——
   * 面板里直接就是 8 个 IconBtn，传 `header: false` 即可。
   */
  header?: false;
  /** 原版那种「左标签 + 右按钮」的行（值就地轮换）。 */
  rows?: DialogButton[];
  /** 自由内容（图标网格 / 面板）。 */
  body?: HTMLElement;
  /** 行与按钮之间的补充按钮排。 */
  extra?: HTMLElement;
  /** 是否画「确定 / 取消」——原版的 ☰ 菜单只有图标网格，没有这一排。 */
  foot?: boolean;
  /** 设计空间里的面板尺寸；缺省 = 原版「新局」对话框 675×707。 */
  designW?: number;
  designH?: number;
  okText?: string;
  cancelText?: string;
  onOk?: () => void;
  onCancel?: () => void;
}

let host: HTMLElement | null = null;
let escBound = false;

function ensureHost(): HTMLElement {
  if (!host) host = document.getElementById("modalHost")!;
  if (!escBound) {
    escBound = true;
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDialog();
    });
  }
  return host;
}

export function closeDialog(): void {
  const h = ensureHost();
  h.hidden = true;
  h.innerHTML = "";
  // ⚠️ `dataset.open` 必须一起清掉：`relayoutDialog()` 用 `#modalHost[data-open]`
  //    判断"现在有没有对话框"，`.dlg-backdrop` 之类的样式可能也依赖它。
  //    从前这里不删，导致关窗后标记还在（残留脏状态）。
  delete h.dataset.open;
}

/** 原版对话框：`Dialog` 底板 + 图标标题 + 若干「标签/按钮」行 + 确定取消。 */
export function showDialog(o: DialogOptions): HTMLElement {
  const h = ensureHost();
  h.innerHTML = "";
  h.hidden = false;

  const dw = o.designW ?? 675;
  const dh = o.designH ?? 707;

  const box = document.createElement("div");
  box.className = "dlg";
  box.dataset.dw = String(dw);
  box.dataset.dh = String(dh);

  // 原版 XML 的 `rect` 以**整框左上角**为原点，但绝对定位子元素默认相对
  // padding box（会被九宫格 border 内缩）—— 所以内容统一挂到 `.dlg-inner`，
  // 由它反向撑满 border box。细节见 style.css 的 `.dlg` 注释。
  const inner = document.createElement("div");
  inner.className = "dlg-inner";
  box.appendChild(inner);

  if (o.header === false) {
    box.classList.add("dlg--plain");
  } else {
    const head = document.createElement("div");
    head.className = "dlg-title";
    const icon = document.createElement("img");
    icon.src = `./assets/${o.icon}`;
    icon.alt = "";
    icon.draggable = false;
    // XML `Icon rect="8,4,0,0"` 的 `0,0` = 按原图自然尺寸，但单位是**设计 px**
    // （要乘 `--ds`）。素材有 77 与 108 两种，尺寸只能等解码后才知道，
    // 所以在这里一次性写死（见 style.css 里 `.dlg-title > img` 的标定说明）。
    const fitIcon = () => {
      icon.style.width = `calc(${icon.naturalWidth}px * var(--ds))`;
      icon.style.height = `calc(${icon.naturalHeight}px * var(--ds))`;
    };
    if (icon.complete && icon.naturalWidth) fitIcon();
    else icon.addEventListener("load", fitIcon, { once: true });
    const t = document.createElement("span");
    // 原版 `Title`：`rect="85,15,660,75"` ⇒ 框 575×60，**左对齐**、黑字。
    t.className = "dlg-title-text";
    paintText(t, {
      text: o.title,
      size: DLG_TITLE_SIZE,
      color: "#201c18",
      w: 575,
      h: 60,
      align: "left",
      dy: DLG_TEXT_DY,
      cls: "txt-bmp",
    });
    head.append(icon, t);
    inner.appendChild(head);
  }

  const main = document.createElement("div");
  main.className = "dlg-body";
  inner.appendChild(main);

  if (o.body) {
    main.appendChild(o.body);
  } else if (o.rows) {
    for (const r of o.rows) {
      main.appendChild(dialogRow(r));
    }
  }
  if (o.extra) main.appendChild(o.extra);

  if (o.foot !== false) {
    const foot = document.createElement("div");
    foot.className = "dlg-foot";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = `ui-btn sk-${SKIN_BTN}`;
    const okText = o.okText ?? "确定";
    ok.addEventListener("click", () => {
      closeDialog();
      o.onOk?.();
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = `ui-btn sk-${SKIN_BTN}`;
    const cancelText = o.cancelText ?? "取消";
    cancel.addEventListener("click", () => {
      closeDialog();
      o.onCancel?.();
    });
    // 原版 `Ok rect="45,580,315,670"` / `Cancel rect="360,580,630,670"` ⇒ 各 270×90。
    // 位图按**整个按钮框**（270×90）画、再反向偏掉九宫格 border 铺满 border box，
    // 这样居中就是按钮的几何中心，不受 1px 高的 padding box 影响。
    paintText(ok, {
      text: okText,
      size: DLG_TEXT_SIZE,
      color: "#ffffff",
      w: 270,
      h: 90,
      dy: DLG_TEXT_DY,
      shadow: true,
      cls: "dlg-btn-txt",
    });
    paintText(cancel, {
      text: cancelText,
      size: DLG_TEXT_SIZE,
      color: "#ffffff",
      w: 270,
      h: 90,
      dy: DLG_TEXT_DY,
      shadow: true,
      cls: "dlg-btn-txt",
    });
    foot.append(ok, cancel);
    inner.appendChild(foot);
  }

  const back = document.createElement("div");
  back.className = "dlg-backdrop";
  back.addEventListener("click", () => closeDialog());

  h.append(back, box);
  h.dataset.open = "1";
  layoutDialog(box, dw, dh);
  // 内容比设计稿高就长高（见 `fitDialogHeight` 的踩坑说明）；
  // 把最终高度记回 dataset，供 `relayoutDialog()` 在窗口尺寸变化时复算。
  box.dataset.dh = String(fitDialogHeight(box, dw, dh));
  return box;
}

/** 对话框正文/标题**字号（设计 px）**。见 `DLG_TEXT_SIZE` 的标定说明；
 *  `.dlg` 上的 `font-size` 只作为 DOM 兜底（自由内容面板里的文字仍走 DOM）。 */
export const DLG_FONT_SIZE = DLG_TEXT_SIZE;

/** 对话框按**棋盘缩放**定尺寸（原版设计空间 720 宽，675 的面板占 93.75%）。 */
export function layoutDialog(box: HTMLElement, dw: number, dh: number): void {
  const s = dialScale();
  box.style.width = `${dw * s}px`;
  box.style.height = `${dh * s}px`;
  box.style.fontSize = `${DLG_FONT_SIZE * s}px`;
  box.style.setProperty("--ds", String(s));
}

/**
 * **按内容自适应对话框高度**（只在长高、绝不缩矮）。
 *
 * ★ 背景（实测踩坑，2026-09-14）：`.dlg-body` 是绝对定位的滚动区
 *   （`top:90·ds`、`bottom:127·ds`、`overflow-y:auto`），而 `.dlg-foot`
 *   固定在底部。原版 XML 给死的 675×707 只够放 **4 行**（行距 115、正文区高 490）。
 *   复刻版把「设置」拼成了 **6 行 + 一个「新局…」按钮排**，于是：
 *     · 第 5 行（走子动画）在正文区下沿被裁得只剩 7px，
 *       而它那条水平位置正好落在 **页脚「关闭」键**上 ⇒ 点"走子动画"会把窗口关掉；
 *     · 第 6 行（落点提示）完全在正文区外 ⇒ 点它命中 `.dlg-backdrop`，**一点就关窗**；
 *     · `extra`（提示框 + 新局…）被挤到 y≈1364，整块在框外，永远看不到也点不到。
 *   用户报的"里面的 6 个按钮都不可用"就是这三条。
 *
 * 算法：正文区需要的设计高 = 90(标题带) + (padding-top + Σ子元素 + 行间距)/scale + 127(页脚带)。
 * 结果再按**视口**钳制；被钳制时正文区自己滚动（已有 `overflow-y:auto`）。
 * `dlg--plain`（☰ 菜单那种纯图标弹窗）走**另一条**公式 —— 它的正文不是绝对定位、
 *   没有标题/页脚，正文从框顶起算：
 *     · 8 格（4×2）网格自然高 = 40+2×185 = 410 设计 px < 428 ⇒ **不溢出，保持 428**，
 *       所以原版逐像素比对的尺寸分毫不动；
 *     · 9 格（4×3）网格高 40+3×185 = 595 > 428 ⇒ 溢出。从前这里直接 `return dh`，
 *       网格被 `.dlg-inner{overflow:hidden}` 裁掉第 3 行（布阵模式新加的「随机布阵」），
 *       点它命中的是 `.dlg-backdrop` ⇒ 一点就把窗关了。现在按正文自然高长高。
 */
export function fitDialogHeight(box: HTMLElement, dw: number, dh: number): number {
  const body = box.querySelector<HTMLElement>(":scope > .dlg-inner > .dlg-body");
  if (!body) return dh;
  const s = dialScale() || 1;
  // 视口钳制：上下各留 10 设备 px，免得贴边。
  const maxH = document.documentElement.clientHeight - 20;
  let need: number;
  if (box.classList.contains("dlg--plain")) {
    // 正文自然高（设备 px）。没溢出就一切照旧 —— 保住原版 675×428 的像素级尺寸。
    if (body.scrollHeight <= body.clientHeight + 1) return dh;
    need = body.scrollHeight / s + 2;
  } else {
    const cs = getComputedStyle(body);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const gap = parseFloat(cs.rowGap || cs.gap) || 0;
    const kids = Array.from(body.children) as HTMLElement[];
    if (!kids.length) return dh;
    let content = padTop;
    kids.forEach((k, i) => {
      content += k.offsetHeight + (i ? gap : 0);
    });
    // 90(标题) + content/s + 127(页脚) —— 页脚带高 = 37(距底) + 90(键高)。
    need = 90 + content / s + 127;
  }
  const h = Math.min(Math.max(dh, Math.ceil(need)), Math.max(dh, Math.floor(maxH / s)));
  if (h !== dh) layoutDialog(box, dw, h);
  return h;
}

/** 原版那种「左标签 + 右按钮」的行。
 *  几何照 XML：`Label rect="45,{135+115i},250,{185+115i}"`（宽 205，右对齐）
 *  + `Button rect="330,…,630,…"`（300×90）。 */
export function dialogRow(r: DialogButton): HTMLElement {
  const row = document.createElement("div");
  row.className = "dlg-row";
  const lab = document.createElement("span");
  lab.className = "dlg-label";
  paintText(lab, {
    text: r.label,
    size: DLG_TEXT_SIZE,
    color: "#ffffff",
    w: 205,
    h: 90,
    align: "right",
    dy: DLG_TEXT_DY,
    shadow: true,
  });
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `ui-btn sk-${SKIN_BTN}`;
  const val = document.createElement("span");
  val.className = "dlg-val";
  btn.appendChild(val);
  paintText(val, {
    text: r.value,
    size: DLG_TEXT_SIZE,
    color: "#ffffff",
    w: 300,
    h: 90,
    dy: DLG_TEXT_DY,
    shadow: true,
    cls: "dlg-btn-txt",
  });
  btn.addEventListener("click", () => r.onCycle());
  row.append(lab, btn);
  return row;
}

/** 当前棋盘缩放 —— 对话框与棋盘同比例，视觉上才是一套。 */
let probeScale = 1;
export function setDialogScale(scale: number): void {
  probeScale = scale;
}
function dialScale(): number {
  return probeScale;
}

/** 原版那种「图标网格」对话框（☰ 菜单 / 布阵工具栏都是这个形态）。 */
export interface GridItem {
  icon: string;
  label: string;
  onClick: () => void;
}
export function iconGrid(items: GridItem[]): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "icon-grid";
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "icon-cell";
    const im = document.createElement("img");
    im.src = `./assets/${it.icon}`;
    im.alt = it.label;
    im.draggable = false;
    const lab = document.createElement("span");
    lab.textContent = it.label;
    b.append(im, lab);
    b.addEventListener("click", () => it.onClick());
    grid.appendChild(b);
  }
  return grid;
}
