/**
 * 走子路径重建 —— 供「走子动画」使用。
 *
 * 为什么需要它：原版的棋子**不是瞬移**，而是沿着**自己实际走的那条线**逐帧推进
 * （`libjunqi.so` `FUN_0003b3d0` 会先按路径逐段算欧氏距离、累加成一张进度表，
 *  再交给 `FUN_0003c468` 按时间在表上插值 —— 见 `src/ui/anim.ts` 文件头）。
 * 所以复刻动画时，"这枚子从哪儿到哪儿、中间经过哪些格"必须和走法生成器
 * 用的是同一张图，否则工兵的铁路机动会走成一条斜穿棋盘的红线。
 *
 * 三种情形（与 `rules.ts:legalTargets` 的三条生成路径一一对应）：
 *   1. 工兵 · 铁路 → 铁路网最短路（可拐弯，只穿过空格）
 *   2. 铁路直行 / 公路一步 → 行或列对齐的直线
 *   3. 行营的斜向进出 → 直接两点
 *
 * ⚠️ 这里只负责"怎么走"，不负责"能不能走"；合法性仍以 `rules.ts` 为准。
 *    调用方只在着法已经被 `applyMove` 接受之后才会调它。
 */

import { colOf, idx, isRailCell, rowOf } from "./board.ts";
import { PieceType } from "./pieces.ts";
import { railNeighborsOf } from "./rules.ts";
import type { Position } from "./state.ts";

/** 沿 `from → to` 的**格子序列**（含首尾）。`from === to` 时返回单元素。 */
export function pathBetween(pos: Position, from: number, to: number): number[] {
  if (from === to) return [from];

  const t = pos.type[from] as PieceType;
  const r0 = rowOf(from);
  const c0 = colOf(from);
  const r1 = rowOf(to);
  const c1 = colOf(to);

  // 1) 工兵在铁路网上机动：可拐弯 → 铁路图最短路
  if (t === PieceType.Engineer && isRailCell(from) && isRailCell(to)) {
    const p = railShortestPath(pos, from, to);
    if (p) return p;
  }

  // 2) 铁路直行 / 公路一步：行或列对齐（相邻格也走这条分支）
  if (r0 === r1 || c0 === c1) return lineCells(from, to);

  // 3) 行营的斜向一步
  return [from, to];
}

/** 同行或同列的直线格序列（含首尾）。 */
function lineCells(from: number, to: number): number[] {
  const r0 = rowOf(from);
  const c0 = colOf(from);
  const r1 = rowOf(to);
  const c1 = colOf(to);
  const dr = Math.sign(r1 - r0);
  const dc = Math.sign(c1 - c0);
  const out: number[] = [from];
  let r = r0;
  let c = c0;
  while (r !== r1 || c !== c1) {
    r += dr;
    c += dc;
    out.push(idx(r, c));
  }
  return out;
}

/**
 * 铁路图上的最短路（BFS）。
 *
 * 与 `rules.ts:engineerRailReach` 的泛洪保持同一套约束：
 *   · 只把**空格**当作可继续延伸的中转；
 *   · 目标格即使是敌子也照样到达（吃子），但**不穿过**它继续找别的路。
 * 找不到返回 `null`（正常不会发生 —— 调用前该着法已被判合法）。
 */
function railShortestPath(pos: Position, from: number, to: number): number[] | null {
  const prev = new Map<number, number>();
  const seen = new Set<number>([from]);
  const queue: number[] = [from];

  while (queue.length > 0) {
    const cur = queue.shift() as number;
    for (const nx of railNeighborsOf(cur)) {
      if (seen.has(nx)) continue;
      seen.add(nx);
      prev.set(nx, cur);
      if (nx === to) {
        const out: number[] = [to];
        let k = to;
        while (k !== from) {
          k = prev.get(k) as number;
          out.push(k);
        }
        out.reverse();
        return out;
      }
      if (pos.type[nx] === PieceType.Empty) queue.push(nx);
    }
  }
  return null;
}
