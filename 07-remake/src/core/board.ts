/**
 * 棋盘拓扑模型 —— 二人军棋（陆战棋）。
 *
 * 全部参数来自逆向规格（见 ../SPEC.md §3），非推测：
 *  - 12 行 × 5 列 = 60 格
 *  - 行营 10 个、大本营 4 个、兵站 46 个
 *  - 横向铁路 4 条（行 1/5/6/10）、纵向铁路 3 条（列 0/2/4，贯穿行 1–10）
 *  - 连接为 8 邻接，两处例外：行 0↔1 仅垂直；跨方 行 5↔6 仅列 0/2/4
 *
 * 行号语义：
 *   行 0  = 红方底线（大本营行）    行 5  = 红方前线
 *   行 6  = 蓝方前线                行 11 = 蓝方底线（大本营行）
 *
 * 屏幕映射：row 11 在屏幕最上方，row 0 在屏幕最下方（见 ui/boardart.ts）。
 */

import { Side, PieceType } from "./pieces.ts";

export const ROWS = 12;
export const COLS = 5;
export const CELLS = ROWS * COLS; // 60

/** 每方阵地行数（6 行 × 5 列 = 30 格） */
export const SIDE_ROWS = 6;

export enum CellKind {
  /** 兵站 —— 普通格 */
  Post = 0,
  /** 行营 —— 安全岛，敌方不可吃其中棋子 */
  Camp = 1,
  /** 大本营 —— 军旗所在地，进入后不可再移动 */
  Base = 2,
}

/**
 * 横向铁路所在行（贯穿列 0–4）。
 *
 * 实测数据（tools/measure_rails.py，判据 = 两格之间中点的"黑色带"占比）：
 *   行 1/5/6/10 = 0.49~0.58（黑带 + 白枕木）→ 铁路
 *   其余行      = 0.18~0.21（仅有细棕绳）  → 公路
 */
export const RAIL_ROWS: readonly number[] = [1, 5, 6, 10];

/**
 * 纵向铁路所在列（贯穿行 1–10）。
 *
 * ⚠️ 这里只列 **列 0 与列 4**。列 2 在两地内部并不是铁路，
 * 只在"两方交界"处有一条纵向跨越段（见 FRONTIER_RAIL_COLS）。
 * 实测：列 2 的段 10-9 / 9-8 / 8-7 / 7-6 黑带占比均 ≤0.07（细公路），
 * 而列 0 / 列 4 同段为 0.55~0.60（铁路）。
 */
export const RAIL_COLS: readonly number[] = [0, 4];

/**
 * 两方交界处允许纵向跨越的列。
 *
 * 行 5（红方前线）↔ 行 6（蓝方前线）之间只有 3 条通路：列 0/2/4，
 * 且原版把这 3 条跨越段都画成铁路带（列 2 的那条实测 0.59）。
 */
export const FRONTIER_RAIL_COLS: readonly number[] = [0, 2, 4];

/** 纵向铁路的行范围（闭区间） */
export const RAIL_COL_ROW_FROM = 1;
export const RAIL_COL_ROW_TO = 10;

export function idx(row: number, col: number): number {
  return row * COLS + col;
}
export function rowOf(i: number): number {
  return (i / COLS) | 0;
}
export function colOf(i: number): number {
  return i % COLS;
}
export function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < ROWS && col >= 0 && col < COLS;
}

// ─────────────────────────────────────────────────────────────
// 格型表
// ─────────────────────────────────────────────────────────────

const KIND: CellKind[] = new Array(CELLS).fill(CellKind.Post);

function markCamp(row: number, col: number): void {
  KIND[idx(row, col)] = CellKind.Camp;
}
function markBase(row: number, col: number): void {
  KIND[idx(row, col)] = CellKind.Base;
}

// 红方行营（行 2/3/4 呈梅花形）；蓝方为其镜像（行 = 11 - 红方行）
for (const [r, c] of [
  [2, 1],
  [2, 3],
  [3, 2],
  [4, 1],
  [4, 3],
] as const) {
  markCamp(r, c);
  markCamp(ROWS - 1 - r, c);
}

// 大本营：底线行的列 1 与列 3
markBase(0, 1);
markBase(0, 3);
markBase(ROWS - 1, 1);
markBase(ROWS - 1, 3);

export function kindOf(i: number): CellKind {
  return KIND[i];
}
export function kindAt(row: number, col: number): CellKind {
  return inBounds(row, col) ? KIND[idx(row, col)] : CellKind.Post;
}
export function isCamp(i: number): boolean {
  return KIND[i] === CellKind.Camp;
}
export function isBase(i: number): boolean {
  return KIND[i] === CellKind.Base;
}

// ─────────────────────────────────────────────────────────────
// 铁路
// ─────────────────────────────────────────────────────────────

const RAIL = new Uint8Array(CELLS);
const RAIL_ROW_SET = new Set<number>(RAIL_ROWS as readonly number[]);
const RAIL_COL_SET = new Set<number>(RAIL_COLS as readonly number[]);

for (const r of RAIL_ROWS) {
  for (let c = 0; c < COLS; c++) RAIL[idx(r, c)] = 1;
}
for (const c of RAIL_COLS) {
  for (let r = RAIL_COL_ROW_FROM; r <= RAIL_COL_ROW_TO; r++) RAIL[idx(r, c)] = 1;
}

/** 该格是否落在铁路线上。 */
export function isRailCell(i: number): boolean {
  return RAIL[i] === 1;
}

/** 该格是否在铁路线上（按行列判断，语义版）。 */
export function isRailAt(row: number, col: number): boolean {
  if (!inBounds(row, col)) return false;
  if (RAIL_ROW_SET.has(row)) return true;
  return RAIL_COL_SET.has(col) && row >= RAIL_COL_ROW_FROM && row <= RAIL_COL_ROW_TO;
}

/** 两方交界处的纵向跨越段（列 0/2/4，行 5↔6）。 */
export function isFrontierRailEdge(a: number, b: number): boolean {
  const ra = rowOf(a);
  const rb = rowOf(b);
  const ca = colOf(a);
  const cb = colOf(b);
  if (ca !== cb) return false;
  if (!(FRONTIER_RAIL_COLS as readonly number[]).includes(ca)) return false;
  return (ra === 5 && rb === 6) || (ra === 6 && rb === 5);
}

export function railCellCount(): number {
  let n = 0;
  for (let i = 0; i < CELLS; i++) n += RAIL[i];
  return n;
}

// ─────────────────────────────────────────────────────────────
// 连接图 —— 全部来自 `libjunqi.so` 实测数据，不再"按底图目测"
// ─────────────────────────────────────────────────────────────

/**
 * 全邻接图（`.rodata` fileoff `0x122ae0`，Ghidra `0x132ae0`）。
 *
 * ★ 它**不是 8 邻域**：正交相邻恒通，而**只有行营**额外连满 8 个邻格。
 *   交叉验证：度数为 8 的格子恰好是那 10 个行营 `{11,13,17,21,23,36,38,42,46,48}`；
 *   例：格 0=(0,0) 只有 `{1,5}`，**没有**斜格 6=(1,1)。
 *   用途：AI 攻击位势图（`FUN_00069840`）与寻路（`FUN_00034f10`）。
 *
 * ⚠️ 曾经的实现是按棋盘底图"看起来有线"写成 8 邻域 + 例外，结果**多出 32 条斜走**
 *    （例如 (1,1)→(2,0)/(2,2)），原版根本没有这些走法。
 */
const ADJACENCY_RAW =
  "1,5;0,2,6;1,3,7;2,4,8;3,9;0,6,10,11;1,5,7,11;2,6,8,11,12,13;3,7,9,13;4,8,13,14;5,11,15;5,6,7,10,12,15,16,17;7,11,13,17;7,8,9,12,14,17,18,19;9,13,19;10,11,16,20,21;11,15,17,21;11,12,13,16,18,21,22,23;13,17,19,23;13,14,18,23,24;15,21,25;15,16,17,20,22,25,26,27;17,21,23,27;17,18,19,22,24,27,28,29;19,23,29;20,21,26,30;21,25,27;21,22,23,26,28,32;23,27,29;23,24,28,34;25,31,35,36;30,32,36;27,31,33,36,37,38;32,34,38;29,33,38,39;30,36,40;30,31,32,35,37,40,41,42;32,36,38,42;32,33,34,37,39,42,43,44;34,38,44;35,36,41,45,46;36,40,42,46;36,37,38,41,43,46,47,48;38,42,44,48;38,39,43,48,49;40,46,50;40,41,42,45,47,50,51,52;42,46,48,52;42,43,44,47,49,52,53,54;44,48,54;45,46,51,55;46,50,52,56;46,47,48,51,53,57;48,52,54,58;48,49,53,59;50,56;51,55,57;52,56,58;53,57,59;54,58";

/**
 * **走法生成**用的步进表（`.rodata` fileoff `0x123350`，Ghidra `0x133350`）。
 *
 * = 上面那张图去掉 35 条"铁–铁"相邻边 —— 铁路上的相邻格属于**滑行**语义
 *   （非工兵直行 / 工兵任意转弯），不按"走一步"生成。
 *   所见即所得：`FUN_00068cbc`（步进）之后才调 `FUN_00068d40` / `FUN_0006907c`（铁路）。
 */
const STEP_RAW =
  "1,5;0,2,6;1,3,7;2,4,8;3,9;0,11;1,11;2,11,12,13;3,13;4,13;11;5,6,7,10,12,15,16,17;7,11,13,17;7,8,9,12,14,17,18,19;13;11,16,21;11,15,17,21;11,12,13,16,18,21,22,23;13,17,19,23;13,18,23;21;15,16,17,20,22,25,26,27;17,21,23,27;17,18,19,22,24,27,28,29;23;21;21;21,22,23;23;23;36;36;36,37,38;38;38;36;30,31,32,35,37,40,41,42;32,36,38,42;32,33,34,37,39,42,43,44;38;36,41,46;36,40,42,46;36,37,38,41,43,46,47,48;38,42,44,48;38,43,48;46;40,41,42,45,47,50,51,52;42,46,48,52;42,43,44,47,49,52,53,54;48;46,55;46,56;46,47,48,57;48,58;48,59;50,56;51,55,57;52,56,58;53,57,59;54,58";

const parseGraph = (raw: string): readonly (readonly number[])[] =>
  raw.split(";").map((s) => (s.length > 0 ? s.split(",").map(Number) : []));

export const NEIGHBORS: readonly (readonly number[])[] = parseGraph(ADJACENCY_RAW);

/** 走法生成用的步进邻居（铁路滑行由 rules.ts 另行处理）。 */
export const STEP_NEIGHBORS: readonly (readonly number[])[] = parseGraph(STEP_RAW);

/** 两格之间是否存在公路/铁路连线（全邻接图，含行营的斜向进出）。 */
export function linked(a: number, b: number): boolean {
  return NEIGHBORS[a].includes(b);
}

export function neighbors(i: number): readonly number[] {
  return NEIGHBORS[i];
}

/** 该格的"走一步"可达格（不含铁路滑行）。 */
export function stepNeighbors(i: number): readonly number[] {
  return STEP_NEIGHBORS[i];
}

// ─────────────────────────────────────────────────────────────
// 阵营与阵地
// ─────────────────────────────────────────────────────────────

/** 该行属于哪一方：0–5 红方，6–11 蓝方 */
export function sideOfRow(row: number): Side {
  return row < SIDE_ROWS ? Side.Red : Side.Blue;
}

export function sideOfCell(i: number): Side {
  return sideOfRow(rowOf(i));
}

/** 某方阵地内的所有格 */
export function territoryOf(side: Side): number[] {
  const out: number[] = [];
  const from = side === Side.Red ? 0 : SIDE_ROWS;
  for (let r = from; r < from + SIDE_ROWS; r++) {
    for (let c = 0; c < COLS; c++) out.push(idx(r, c));
  }
  return out;
}

/**
 * 该方的「第一行」（最前线）。布阵约束：炸弹不能放这里。
 * 红方 = 行 5；蓝方 = 行 6。
 */
export function frontRowOf(side: Side): number {
  return side === Side.Red ? SIDE_ROWS - 1 : SIDE_ROWS;
}

/**
 * 该方的「最后两行」（底线侧）。布阵约束：地雷只能放这里。
 * 红方 = 行 0、1；蓝方 = 行 10、11。
 */
export function backRowsOf(side: Side): readonly number[] {
  return side === Side.Red ? [0, 1] : [ROWS - 2, ROWS - 1];
}

/** 该方的大本营格 */
export function basesOf(side: Side): readonly number[] {
  return side === Side.Red
    ? [idx(0, 1), idx(0, 3)]
    : [idx(ROWS - 1, 1), idx(ROWS - 1, 3)];
}

// ─────────────────────────────────────────────────────────────
// .lay 布阵数据 → 棋盘坐标
// ─────────────────────────────────────────────────────────────

/**
 * `.lay` 的行序是「最前线 → 底线」，与棋盘行号相反（红方）或同向偏移（蓝方）。
 *
 *  - 红方：boardRow = 5 - layRow
 *  - 蓝方：boardRow = 6 + layRow
 */
export function layIndexToBoard(layIndex: number, side: Side): number {
  const lr = (layIndex / COLS) | 0;
  const lc = layIndex % COLS;
  const br = side === Side.Red ? SIDE_ROWS - 1 - lr : SIDE_ROWS + lr;
  return idx(br, lc);
}

/** 把 30 字节布阵展开成 board 空间的 PieceType 数组（60 长度，非本方格为 Empty）。 */
export function expandLayout(cells: readonly number[], side: Side): PieceType[] {
  const board: PieceType[] = new Array(CELLS).fill(PieceType.Empty);
  for (let i = 0; i < cells.length; i++) {
    board[layIndexToBoard(i, side)] = cells[i] as PieceType;
  }
  return board;
}

/** 校验：某方阵地内的布阵是否合法，返回错误列表（空数组 = 合法）。 */
export function validateLayout(
  board: readonly PieceType[],
  side: Side,
): string[] {
  const errors: string[] = [];

  const front = frontRowOf(side);
  const back = backRowsOf(side);
  const bases = basesOf(side);
  const territory = territoryOf(side);

  const counts = new Map<PieceType, number>();
  let placed = 0;

  for (const i of territory) {
    const t = board[i];
    if (t === PieceType.Empty) continue;
    placed++;
    counts.set(t, (counts.get(t) ?? 0) + 1);

    const r = rowOf(i);
    if (t === PieceType.Bomb && r === front) errors.push("炸弹不能放在第一行");
    if (t === PieceType.Landmine && !back.includes(r)) errors.push("地雷只能放在最后两行");
    if (t === PieceType.Flag && !bases.includes(i)) errors.push("军旗只能放在大本营");
  }

  if (placed !== 25) errors.push("还有未摆放的棋子");

  // 数量校验
  const expected = new Map<PieceType, number>();
  for (const t of [
    PieceType.Commander,
    PieceType.General,
    PieceType.MajorGeneral,
    PieceType.Brigadier,
    PieceType.Colonel,
    PieceType.Major,
    PieceType.Captain,
    PieceType.Lieutenant,
    PieceType.Engineer,
    PieceType.Bomb,
    PieceType.Landmine,
    PieceType.Flag,
  ] as const) {
    const meta = PIECE_COUNT_LOOKUP[t] ?? 0;
    expected.set(t, meta);
  }
  for (const [t, n] of expected) {
    const got = counts.get(t) ?? 0;
    if (got !== n) {
      errors.push(`棋子数量不符：类型 ${t} 期望 ${n} 实际 ${got}`);
    }
  }

  return errors;
}

/** 各棋子每方数量（避免循环 import，这里冗余一份常量）。 */
export const PIECE_COUNT_LOOKUP: Record<number, number> = {
  [PieceType.Commander]: 1,
  [PieceType.General]: 1,
  [PieceType.MajorGeneral]: 2,
  [PieceType.Brigadier]: 2,
  [PieceType.Colonel]: 2,
  [PieceType.Major]: 2,
  [PieceType.Captain]: 3,
  [PieceType.Lieutenant]: 3,
  [PieceType.Engineer]: 3,
  [PieceType.Bomb]: 2,
  [PieceType.Landmine]: 3,
  [PieceType.Flag]: 1,
};
