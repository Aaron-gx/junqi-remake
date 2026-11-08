/**
 * 棋盘渲染器（原版素材版）
 *
 * 与原版的关系：
 *  - 棋盘底图 **就是原版 `board.png`**（720×1160，720 密度数据包 `datax#156`），整体 blit，不做任何重绘。
 *    底图里已经烤进了 46 个兵站空位（绿框 + 暗橄榄内衬）、10 个行营圆环、铁路/公路线，
 *    所以"空格子长什么样"完全不用我们画。
 *  - 棋子 **就是原版 `piece.png` 图集的切片**（12 兵种 × 2 方 + 末行 4 个纯色背面），不做字体渲染。
 *  - 交互提示照抄原版（见下）。
 *
 * ## 移动提示（实测，见 `tools/cc_markers.py`）
 *
 * 原版**没有落点预览**。选中一枚棋子的唯一反馈是给它套一个 **纯蓝描边框**；
 * 走完一步后，**起点与终点**各套一个 **纯红描边框**。
 * 证据：`s17 → s18`（从选中 A 子改为选中 B 子）的像素差分只落在两个蓝框上，
 * 全盘其余位置零差异 —— 若原版会画出合法落点，差分必然出现在目标格上。
 *
 * 因此本渲染器默认 `showTargets = false`，与原版一致；
 * 想开辅助落点提示（非原版行为）时显式传 `showTargets: true`。
 *
 * ## 走子动画
 *
 * 原版走子不是瞬移，而是沿路径逐帧插值（`libjunqi.so` `FUN_0003b3d0` / `FUN_0003c468`，
 * 见 `anim.ts` 文件头）。本渲染器不自己驱动时间轴，只提供两个"接口"：
 *   · `hideCell` —— 跳过原地那枚子（走子前的盘面上它还站在起点了）；
 *   · `overlay`  —— 把飞行的棋子画在给定的原图坐标处。
 * 时间轴与逐帧推进在 `main.ts` 里（`requestAnimationFrame`）。
 */

import { type Assets, pieceTile } from "./assets.ts";
import {
  ART_H,
  ART_W,
  BACK_COL,
  COL_X,
  MARK,
  PIECE_TILE_H,
  PIECE_TILE_W,
  ROW_Y,
} from "./boardart.ts";
import { CELLS, COLS, colOf, rowOf } from "../core/board.ts";
import { PieceType, Side } from "../core/pieces.ts";
import type { MoveTarget } from "../core/rules.ts";
import type { Position } from "../core/state.ts";

/** 视图变换：棋盘原图坐标 → 画布 CSS 像素 */
export interface View {
  scale: number;
  ox: number;
  oy: number;
}

export function fitView(cssW: number, cssH: number, pad = 6): View {
  const scale = Math.min((cssW - pad * 2) / ART_W, (cssH - pad * 2) / ART_H);
  return {
    scale,
    ox: (cssW - ART_W * scale) / 2,
    oy: (cssH - ART_H * scale) / 2,
  };
}

export function cellCenter(v: View, cell: number): { x: number; y: number } {
  return {
    x: v.ox + COL_X[colOf(cell)] * v.scale,
    y: v.oy + ROW_Y[rowOf(cell)] * v.scale,
  };
}

export function hitTest(v: View, px: number, py: number): number | null {
  const bx = (px - v.ox) / v.scale;
  const by = (py - v.oy) / v.scale;
  let best = -1;
  let bestD = Infinity;
  for (let r = 0; r < 12; r++) {
    const dy = Math.abs(by - ROW_Y[r]);
    if (dy > 40) continue;
    for (let c = 0; c < COLS; c++) {
      const dx = Math.abs(bx - COL_X[c]);
      const d = dx * 0.7 + dy;
      if (dx < 76 && d < bestD) {
        bestD = d;
        best = r * COLS + c;
      }
    }
  }
  return best >= 0 ? best : null;
}

/** 棋子面在图集中的行列 —— 前 3 行橙方、后 3 行蓝方。 */
export function tileRowCol(type: PieceType, side: Side): [number, number] {
  const t = (type as number) - 1; // 0..11
  const col = t % 4;
  const band = side === Side.Red ? 0 : 3;
  const row = band + Math.floor(t / 4);
  return [row, col];
}

/**
 * 「盖着的棋子」用图集第 7 行（index 6）的纯色块 —— 实拍确认（雷电 9，900×1600）：
 *   · 布局对战 · **暗棋**：对手的隐子 = 蓝 `col 2`，中心像素实测 (40,104,160) 与 r6c2 一致；
 *     己方隐子 = 橙 `col 1`。
 *   · **翻棋**：定色前谁都不知道归属，一律用中性 **绿 `col 0`** (112,156,0)。
 *     ⚠️ 这里曾经错用 col 3 的黑色 —— 实拍证明原版翻棋背面就是绿色。
 *   · `col 3`（黑）是图集里的备用色块，原版未使用。
 */
export const BACK_TILE: Readonly<Record<number, [number, number]>> = {
  [Side.Red]: [6, BACK_COL.red], // [6,1] 橙
  [Side.Blue]: [6, BACK_COL.blue], // [6,2] 蓝
};
export const NEUTRAL_BACK: readonly [number, number] = [6, BACK_COL.neutral]; // [6,0] 绿

/** 背面朝向：按阵营配色 / 全部中性（翻棋）。 */
export type BackMode = "side" | "neutral";

export interface RenderInput {
  pos: Position;
  /** 明棋：全部可见 */
  revealAll: boolean;
  /** 该方的棋子始终朝上（暗棋模式下 = 当前行动方） */
  viewer?: Side | null;
  selected: number | null;
  targets: readonly MoveTarget[];
  lastMove: { from: number; to: number } | null;
  /** 布阵模式：只高亮某一方，其余变暗 */
  onlySide?: Side | null;
  /** 布阵模式里可摆子的格（其余变暗） */
  activeCells?: readonly number[] | null;
  /** 暗棋背面样式，默认按阵营配色 */
  backMode?: BackMode;
  /**
   * 是否绘制合法落点提示。**默认 false —— 原版没有这个提示**（见文件头实测说明）。
   * 打开后会在可走的空格画白点、可吃的子画红点，属于复刻版的可选辅助。
   */
  showTargets?: boolean;
  /**
   * AI 援助给出的**建议着法**：起讫两端各画一个原版的蓝框（`MARK.SELECTED`），
   * 终点再补一个白点指出方向。沿用选中框的视觉语言，玩家一眼就懂。
   * 与 `selected`/`lastMove` 互不干扰（三个框可以同时存在）。
   */
  aidPair?: { from: number; to: number } | null;
  /**
   * 走子动画期间：**跳过这一格**的棋子。
   *
   * 动画时传给 `pos` 的是"走子前"的盘面，而正在移动的那枚子原本就站在 `from`；
   * 若不一并跳过，画面上会同时出现"原地一枚 + 飞行一枚"（残影）。
   */
  hideCell?: number | null;
  /**
   * 走子动画期间：**飞行的棋子**，画在**原图坐标** `(x, y)` 处（棋子中心）。
   * 与 `hideCell` 配合使用 —— 一个遮住原地，一个画在半路。
   */
  overlay?: { x: number; y: number; row: number; col: number } | null;
  /**
   * 棋子纹理是否开启插值（默认 **`true`** = 平滑采样，与原版一致）。
   *
   * `piece.png` 单元 86×61 画到设备 107.5×76.25（×1.25，非整数倍），
   * NEAREST 会把笔画边缘画成"每 4 个源像素多插 1 个"的硬阶梯，
   * 与原版逐像素比对时表现为"字形外围一圈 1px 光环"（`tools/_audit/diffrow0.png`）。
   * 实测（`?mode=edit` vs `tools/_emu/s15_lay.png`）：平滑后全图平均差 3.92 → **3.61**，
   * 我方第 0 行 6.46 → 4.29、第 5 行 6.29 → 4.34 ⇒ **原版用的是线性过滤**。
   * 传 `false` 只是留个对照开关，不再是默认行为。
   */
  pieceSmooth?: boolean;
  /**
   * 棋子落点是否对齐到**整数设备像素**（默认 `false`）。
   *
   * ⚠️ 这是**已否决**的假设，留着只当记录：原版若用 `glVertex2i` 一类整数落点，
   * 笔画相位会和浮点不同。A/B 实测（`?mode=edit&snap=1` vs s15_lay）
   * 我方半盘残差 **8.27 → 9.14**（更差），加上 NEAREST 更是 10.74 ⇒
   * **原版是浮点落点 + 线性过滤**，和本渲染器一致，不需要吸附。
   */
  pieceSnap?: boolean;
}

/**
 * 开局「战斗开始」横幅 —— 原版开局时会盖在棋盘正中显示约 2.4 秒。
 *
 * ## 这块是实测出来的，不是猜的
 *
 * 静态资源里**没有**任何「战斗开始」字面量：`libjunqi.so` 只有音频 key
 * `Junqi.Start`（= `data/junqi/start.wav`），所有 `text="开始"` 都是对话框按钮；
 * `string.xml` 里也只有 `Ready=准备` / `PeerStart=对方准备好了`（**联网**对话框用）。
 * 所以它只可能是 native 临时绘制的一张图。
 *
 * 抓法：`screenrecord` 录下「点人机对战」前后的 9 秒 → ffmpeg 解帧 → 逐帧与稳态求差
 * （工具 `tools/_audit/start_video.py` / `start_analyze.py`）。差出来的连通域就是横幅。
 * ⚠️ 关键前提：原版**会把对局自动存档**，不清存档再进「人机对战」是**续局**，
 * 续局不播横幅 —— 必须先删 `/sdcard/cnvcs`（或 `pm clear`）才能复现。
 *
 * ## 实测数值（雷电 9 · 900×1600 · `tools/_audit/start_timing2.py`）
 *
 * | 量 | 实测 |
 * |---|---|
 * | 素材 | `datax` 里 620×120 RGBA（金色字 + 浅色光带底），已收入 `public/assets/start_banner.png` |
 * | 缩放 | **1.25**（= 本工程全局 scale，模板匹配残差 15.1，相邻档位 1.24/1.26 分别 20.1/19.3） |
 * | 中心 | 屏幕 **(450, 875)** —— 正好是**棋盘中心**：art (360, 580) |
 * | 时长 | 点击后 ≈1.0s（棋盘出现时）显示，≈3.3s 消失 ⇒ **约 2.4s**，末尾 ~0.3s 略淡 |
 *
 * 注意素材自带的"重心"并不在几何中心：内容 bbox 相对 620×120 画布偏 (+11, −1)，
 * 所以按**画布**居中才会落在实测的 (464, 874) 内容中心上 —— 这里照做。
 */
export function drawStartBanner(
  ctx: CanvasRenderingContext2D,
  a: Assets,
  v: View,
  alpha: number,
): void {
  if (alpha <= 0) return;
  const img = a.img[a.manifest.ui.startBanner];
  if (!img) return;
  const w = img.width * v.scale;
  const h = img.height * v.scale;
  const cx = v.ox + (ART_W / 2) * v.scale;
  const cy = v.oy + (ART_H / 2) * v.scale;
  ctx.save();
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  ctx.restore();
}

export function render(
  ctx: CanvasRenderingContext2D,
  a: Assets,
  v: View,
  inp: RenderInput,
): void {
  const { pos } = inp;
  const s = v.scale;

  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // 1) 原版棋盘底图，整体 blit —— 像素级一致
  //    （空位绿框、行营圆环、铁路/公路都在底图里，无需另画）
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    a.img[a.manifest.board.file],
    0, 0, ART_W, ART_H,
    v.ox, v.oy, ART_W * s, ART_H * s,
  );

  // 2) 棋子：原版图集切片
  //    86×61 → 107.5×76.25（×1.25）是**非整数倍**放大 ⇒ 必须开插值，
  //    否则笔画边缘会出现 NEAREST 的硬阶梯，与原版对不上（见 RenderInput.pieceSmooth）。
  ctx.imageSmoothingEnabled = inp.pieceSmooth ?? true;
  ctx.imageSmoothingQuality = "high";
  const tw = PIECE_TILE_W * s;
  const th = PIECE_TILE_H * s;
  const show = inp.onlySide ?? null;
  const viewer = inp.viewer ?? null;
  const backMode = inp.backMode ?? "side";
  const hide = inp.hideCell ?? -1;
  for (let i = 0; i < CELLS; i++) {
    if (i === hide) continue;
    const t = pos.type[i] as PieceType;
    if (t === PieceType.Empty) continue;
    const side = pos.owner[i] as Side;
    const mine = show === null ? true : side === show;
    const faceUp =
      inp.revealAll ||
      pos.revealed[i] === 1 ||
      (viewer !== null && side === viewer);
    if (!mine) ctx.globalAlpha = 0.2;
    const rc = faceUp
      ? tileRowCol(t, side)
      : backMode === "neutral"
        ? (NEUTRAL_BACK as [number, number])
        : (BACK_TILE[side] ?? (NEUTRAL_BACK as [number, number]));
    drawPiece(ctx, a, v, i, rc, tw, th, inp.pieceSnap === true);
    if (!mine) ctx.globalAlpha = 1;
  }

  // 2b) 走子动画：把"飞行的棋子"画在半路上（原图坐标 → CSS 像素）
  if (inp.overlay) {
    const tex = pieceTile(a, inp.overlay.row, inp.overlay.col);
    const x = v.ox + inp.overlay.x * s;
    const y = v.oy + inp.overlay.y * s;
    ctx.drawImage(tex, x - tw / 2, y - th / 2, tw, th);
  }

  // 3) 交互提示 —— 复刻原版的蓝/红描边框（画在棋子之上，永不遮挡棋子本体：
  //    框外沿只比棋子大 (7+5)/2 ≈ 6px，而相邻格中心距 140px，不会串到别格）。
  ctx.imageSmoothingEnabled = true;
  const prevLine = ctx.lineJoin;
  ctx.lineJoin = "miter";
  if (inp.lastMove) {
    mark(ctx, v, inp.lastMove.from, MARK.LAST_MOVE);
    mark(ctx, v, inp.lastMove.to, MARK.LAST_MOVE);
  }
  if (inp.selected !== null && inp.selected >= 0) {
    mark(ctx, v, inp.selected, MARK.SELECTED);
  }
  if (inp.aidPair) {
    mark(ctx, v, inp.aidPair.from, MARK.SELECTED);
    mark(ctx, v, inp.aidPair.to, MARK.SELECTED);
  }
  ctx.lineJoin = prevLine;

  // 4) 可选：合法落点提示（**非原版行为**，默认关闭）
  if (inp.showTargets) {
    for (const tg of inp.targets) {
      const { x, y } = cellCenter(v, tg.to);
      ctx.beginPath();
      ctx.arc(x, y, (tg.capture ? 24 : 14) * s, 0, Math.PI * 2);
      ctx.fillStyle = tg.capture ? "rgba(255,74,48,0.42)" : "rgba(255,255,255,0.55)";
      ctx.fill();
      ctx.lineWidth = 2.5 * s;
      ctx.strokeStyle = tg.capture ? "rgba(255,228,150,0.95)" : "rgba(60,50,20,0.5)";
      ctx.stroke();
    }
  }

  // 4b) AI 援助：终点补一个白点，指明"两头蓝框里哪一个是要去的地方"。
  if (inp.aidPair) {
    const { x, y } = cellCenter(v, inp.aidPair.to);
    ctx.beginPath();
    ctx.arc(x, y, 14 * s, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.62)";
    ctx.fill();
  }
}

/** 原版高亮框：棋子外扩 7px、5px 纯色描边的直角框。 */
function mark(
  ctx: CanvasRenderingContext2D,
  v: View,
  cell: number,
  color: string,
): void {
  const { x, y } = cellCenter(v, cell);
  const s = v.scale;
  const w = MARK.W * s;
  const h = MARK.H * s;
  const r = MARK.RADIUS * s;
  ctx.beginPath();
  roundRect(ctx, x - w / 2, y - h / 2, w, h, r);
  ctx.lineWidth = MARK.LINE * s;
  ctx.strokeStyle = color;
  ctx.stroke();
}

function drawPiece(
  ctx: CanvasRenderingContext2D,
  a: Assets,
  v: View,
  cell: number,
  rc: [number, number],
  tw: number,
  th: number,
  snap = false,
): void {
  const { x, y } = cellCenter(v, cell);
  const tex = pieceTile(a, rc[0], rc[1]);
  const dx = snap ? Math.round(x - tw / 2) : x - tw / 2;
  const dy = snap ? Math.round(y - th / 2) : y - th / 2;
  ctx.drawImage(tex, dx, dy, tw, th);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export { ART_W, ART_H };
