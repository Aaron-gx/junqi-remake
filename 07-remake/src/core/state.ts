/**
 * 对局状态容器。
 *
 * 用 TypedArray 而非对象数组，原因是：
 *  - AI 搜索需要高频克隆/回滚，TypedArray 的 slice() 极快
 *  - 暗棋（翻棋）模式需要独立的"已翻开"位图
 */

import { CELLS, SIDE_ROWS, territoryOf } from "./board.ts";
import { PieceType, Side } from "./pieces.ts";
import { idx, ROWS, COLS } from "./board.ts";

export interface Position {
  /** 每格的棋子类型（PieceType.Empty = 空） */
  readonly type: Uint8Array;
  /** 每格的归属方（Side.None = 空） */
  readonly owner: Uint8Array;
  /** 暗棋模式：该格棋子是否已翻开（1 = 明） */
  readonly revealed: Uint8Array;
}

export function createEmptyPosition(): Position {
  return {
    type: new Uint8Array(CELLS),
    owner: new Uint8Array(CELLS),
    revealed: new Uint8Array(CELLS),
  };
}

export function clonePosition(p: Position): Position {
  return {
    type: p.type.slice(),
    owner: p.owner.slice(),
    revealed: p.revealed.slice(),
  };
}

export function pieceAt(p: Position, i: number): PieceType {
  return p.type[i] as PieceType;
}

export function ownerAt(p: Position, i: number): Side {
  return p.owner[i] as Side;
}

export function isEmpty(p: Position, i: number): boolean {
  return p.type[i] === PieceType.Empty;
}

export function isFaceUp(p: Position, i: number): boolean {
  return p.revealed[i] === 1;
}

export function setPiece(
  p: Position,
  i: number,
  type: PieceType,
  side: Side,
  revealed = 1,
): void {
  p.type[i] = type;
  p.owner[i] = side;
  p.revealed[i] = revealed;
}

export function clearCell(p: Position, i: number): void {
  p.type[i] = PieceType.Empty;
  p.owner[i] = Side.None;
  p.revealed[i] = 0;
}

export function revealCell(p: Position, i: number): void {
  if (p.type[i] !== PieceType.Empty) p.revealed[i] = 1;
}

/** 从布阵数据构建整局的初始 Position（红蓝双方均已摆放）。 */
export function buildFromLayouts(
  redCells: readonly number[],
  blueCells: readonly number[],
): Position {
  const p = createEmptyPosition();
  applySideLayout(p, redCells, Side.Red);
  applySideLayout(p, blueCells, Side.Blue);
  return p;
}

export function applySideLayout(
  p: Position,
  cells: readonly number[],
  side: Side,
): void {
  const rows = territoryOf(side);
  // territoryOf 返回按行优先排列的 30 格，与 .lay 的索引顺序需要按 §7.1 做翻转
  const base = side === Side.Red ? 0 : SIDE_ROWS;
  for (let li = 0; li < cells.length; li++) {
    const lr = (li / COLS) | 0;
    const lc = li % COLS;
    const br = side === Side.Red ? SIDE_ROWS - 1 - lr + base : base + lr;
    const target = idx(br, lc);
    const v = cells[li];
    if (v === PieceType.Empty) {
      clearCell(p, target);
    } else {
      setPiece(p, target, v as PieceType, side, 1);
    }
  }
  void rows;
}

/** 统计某方剩余棋子数。 */
export function countPieces(p: Position, side: Side): number {
  let n = 0;
  for (let i = 0; i < CELLS; i++) if (p.owner[i] === side && p.type[i] !== PieceType.Empty) n++;
  return n;
}

/** 统计某方剩余可移动棋子数（地雷/军旗不算）。 */
export function countMobile(p: Position, side: Side): number {
  let n = 0;
  for (let i = 0; i < CELLS; i++) {
    if (p.owner[i] !== side) continue;
    const t = p.type[i];
    if (t === PieceType.Landmine || t === PieceType.Flag || t === PieceType.Empty) continue;
    n++;
  }
  return n;
}

/** 调试用：把棋盘打印成 12×5 的文本。 */
export function dumpPosition(p: Position): string {
  const lines: string[] = [];
  for (let r = ROWS - 1; r >= 0; r--) {
    const row: string[] = [];
    for (let c = 0; c < COLS; c++) {
      const i = idx(r, c);
      const t = p.type[i];
      if (t === PieceType.Empty) row.push(" ..");
      else row.push((p.owner[i] === Side.Red ? "R" : "B") + String(t).padStart(2, "0"));
    }
    lines.push(`r${String(r).padStart(2, " ")} | ${row.join(" ")}`);
  }
  return lines.join("\n");
}
