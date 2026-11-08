/**
 * 走子动画 —— 原版 `libjunqi.so` 的时长与插值，一比一还原。
 *
 * ## 原版在做什么（`FUN_0003b3d0` / `FUN_0003c468`，均已反汇编核对）
 *
 * `FUN_0003b3d0`（设置动画）：
 * ```
 * if (PieceAni == 0) { Msg_Move(); return; }        // 开关关掉 → 直接落位
 * for (k = 1; k < count; k++) {
 *   len[k] = |cell[k] - cell[k-1]|;                 // 逐段欧氏距离
 *   total += len[k];                                // 累加总长
 * }
 * speed = powf(Xstride, 0.2) * powf(total, 0.8) / 0.4;   // px / 秒
 * *(float*)(this + 0x608) = speed;
 * ```
 * 反汇编证据（文件偏移，Thumb）：
 * ```
 * 2c6d4: vldr  s15, [r4, #56]        ; +0x38 = 列像素步距（FUN_0003ba90 @0x2baf6 用它乘列号）
 * 2c6d8: ldr   r1, [pc, #0x50]       ; → 0x2c72c = 0x3e4ccccc = 0.2f
 * 2c6e2: blx   powf                  ; powf(stride, 0.2)
 * 2c6e6: ldr   r1, [pc, #0x48]       ; → 0x2c730 = 0x3f4ccccd = 0.8f
 * 2c6f0: blx   powf                  ; powf(total, 0.8)
 * 2c6fe: vmul.f32 s16, s16, s15
 * 2c702: vldr  s15, [pc, #48]        ; → 0x2c734 = 0x3ecccccd = 0.4f
 * 2c706: vdiv.f32 s16, s16, s15
 * 2c70a: vstr  s16, [r3]             ; [r4 + 0x608] = speed
 * ```
 *
 * `FUN_0003c468`（每帧推进）：
 * ```
 * d = (now - start) * speed / 1000.0;               // 实走距离（像素）
 * for (k = 0; k < count; k++) {
 *   if (d < len[k]) { 在 len[k] 这一段内线性插值; return; }
 *   d -= len[k];
 * }
 * Msg_Move();                                       // 走完 → 真正落位
 * ```
 * 注意插值用的是**每一段自己的长度**（`fVar2 / fVar4`），所以路径拐弯时速度是连续的。
 *
 * ## 反推出的时长
 *
 * 令 `total` = 路径总像素长、`stride` = 列步距，则：
 * ```
 * 走完所需时间 = total / (speed / 1000) = 1000·total / speed
 *             = 1000·total / (2.5 · stride^0.2 · total^0.8)
 *             = 400 · (total / stride)^0.2   毫秒
 * ```
 * 即 **单步（一步一格）≈ 400ms**，长距离因为指数只有 0.2 而**涨得很慢**
 * （横穿 5 列 ≈ 552ms），这正是原版"看起来不着急"的手感来源。
 *
 * 复刻说明：这里的 `stride` 直接用棋盘原图的列距 `PITCH_X`（140.5 原图 px）。
 * 原版内部的步距是它自己 17×17 网格空间的整数步距，两者比例一致，
 * 所以"单步 400ms"这个锚点完全对得上。
 *
 * 另外 `PieceAni` 开关（原版对象 `+0x65`，**默认 1 = 开**，`FUN_00031626` 读取）
 * 对应本工程的「走子动画」开关，默认同样是开。
 */

import { COL_X, PITCH_X, ROW_Y } from "./boardart.ts";
import { colOf, rowOf } from "../core/board.ts";
import type { Position } from "../core/state.ts";

/** 时长公式的基准（毫秒）—— 单步一格即此值。 */
export const ANIM_BASE_MS = 400;
/** 时长公式的指数（原版 0.8 = 1 − 0.2 的另一种写法，化简后即 0.2）。 */
export const ANIM_EXP = 0.2;
/** 时长公式里的参考步距 = 列像素步距（原版 `+0x38`）。 */
export const ANIM_STRIDE = PITCH_X;
/** 再短的着法也留一点动画时间，免得快到看不见。 */
export const ANIM_MIN_MS = 90;

/** 一次的走子动画。 */
export interface MoveAnim {
  /** 走子**之前**的盘面 —— 动画期间照它画（被吃子会一直留到落位那一刻）。 */
  readonly pre: Position;
  readonly from: number;
  readonly to: number;
  /** 格子路径（含首尾） */
  readonly path: readonly number[];
  /** cum[k] = 起点到 path[k] 的像素距离 */
  readonly cum: readonly number[];
  readonly total: number;
  readonly duration: number;
  readonly start: number;
  /** 移动棋子的图集行列 */
  readonly rc: readonly [number, number];
  /** 动画期间仍然显示的"上一手"红框（这一手的红框等落位后再出现） */
  readonly prevLast: { from: number; to: number } | null;
  /** 落位后回调（画最终帧 + 排电脑） */
  readonly done: () => void;
}

/** 格子中心在**原图坐标**里的 x。 */
export function artX(cell: number): number {
  return COL_X[colOf(cell)];
}

/** 格子中心在**原图坐标**里的 y。 */
export function artY(cell: number): number {
  return ROW_Y[rowOf(cell)];
}

/** 路径总像素长（逐段欧氏距离之和）。 */
export function pathLength(path: readonly number[]): number {
  let total = 0;
  for (let k = 1; k < path.length; k++) {
    total += Math.hypot(
      artX(path[k]) - artX(path[k - 1]),
      artY(path[k]) - artY(path[k - 1]),
    );
  }
  return total;
}

/** 逐段累计距离表（`cum[0] === 0`）。 */
export function cumulative(path: readonly number[]): number[] {
  const cum: number[] = [0];
  for (let k = 1; k < path.length; k++) {
    cum.push(
      cum[k - 1] +
        Math.hypot(
          artX(path[k]) - artX(path[k - 1]),
          artY(path[k]) - artY(path[k - 1]),
        ),
    );
  }
  return cum;
}

/** 原版时长：`400 × (总像素 / 列步距)^0.2` 毫秒。 */
export function animDurationMs(total: number): number {
  if (!(total > 0)) return ANIM_MIN_MS;
  return ANIM_BASE_MS * Math.pow(total / ANIM_STRIDE, ANIM_EXP);
}

/**
 * 给定已播放的毫秒数，返回棋子在**原图坐标**下的位置。
 * 线性插值（与原版一致，没有缓动）。
 */
export function animPointAt(
  path: readonly number[],
  cum: readonly number[],
  total: number,
  duration: number,
  elapsed: number,
): { x: number; y: number } {
  const end = path[path.length - 1] ?? 0;
  if (path.length < 2 || !(duration > 0) || !(total > 0)) {
    return { x: artX(end), y: artY(end) };
  }
  const t = Math.max(0, Math.min(1, elapsed / duration));
  const d = t * total;
  for (let k = 1; k < path.length; k++) {
    if (d <= cum[k] || k === path.length - 1) {
      const seg = cum[k] - cum[k - 1];
      const f = seg > 0 ? (d - cum[k - 1]) / seg : 1;
      const g = Math.max(0, Math.min(1, f));
      return {
        x: artX(path[k - 1]) + (artX(path[k]) - artX(path[k - 1])) * g,
        y: artY(path[k - 1]) + (artY(path[k]) - artY(path[k - 1])) * g,
      };
    }
  }
  return { x: artX(end), y: artY(end) };
}

/** 组装一次动画（`now` 由调用方给，便于测试/无头环境）。 */
export function makeMoveAnim(opts: {
  pre: Position;
  from: number;
  to: number;
  path: readonly number[];
  rc: readonly [number, number];
  prevLast: { from: number; to: number } | null;
  now: number;
  done: () => void;
}): MoveAnim {
  const cum = cumulative(opts.path);
  const total = cum[cum.length - 1] ?? 0;
  const duration = Math.max(ANIM_MIN_MS, animDurationMs(total));
  return {
    pre: opts.pre,
    from: opts.from,
    to: opts.to,
    path: opts.path,
    cum,
    total,
    duration,
    start: opts.now,
    rc: opts.rc,
    prevLast: opts.prevLast,
    done: opts.done,
  };
}
