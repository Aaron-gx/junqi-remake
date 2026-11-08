/**
 * 棋子定义。
 *
 * 数值与原版 `assets/data/lay/NN.lay` 的字节编码**一一对应**，因此原版 51 关
 * 布阵数据可以零转换直接载入。
 *
 * 映射依据（双重验证）：
 *  1. native 字符串表 fileoff 0x11da78 的顺序：司令 军长 师长 旅长 团长 营长 连长 排长 炸弹 地雷 军旗
 *  2. 全 51 关字节计数：{1:1, 2:1, 3:2, 4:2, 5:2, 6:2, 7:3, 8:3, 9:3, 10:2, 11:3, 12:1}
 *     → 只有 9=工兵(3枚)、10=炸弹(2枚)、11=地雷(3枚)、12=军旗(1枚) 能满足量数约束
 */

/** 棋子类型。值即原版 .lay 字节值。 */
export enum PieceType {
  /** 空位（仅出现在行营） */
  Empty = 0,
  Commander = 1, // 司令
  General = 2, // 军长
  MajorGeneral = 3, // 师长
  Brigadier = 4, // 旅长
  Colonel = 5, // 团长
  Major = 6, // 营长
  Captain = 7, // 连长
  Lieutenant = 8, // 排长
  Engineer = 9, // 工兵
  Bomb = 10, // 炸弹
  Landmine = 11, // 地雷
  Flag = 12, // 军旗
}

/** 阵营。原版文本资源使用「红方 / 蓝方」。 */
export enum Side {
  None = 0,
  Red = 1,
  Blue = 2,
}

export interface PieceMeta {
  readonly type: PieceType;
  readonly name: string;
  /**
   * 战斗力等级，用于大吃小判定。
   * 司令=9 … 工兵=1；炸弹/地雷/军旗为 0（走特殊规则）。
   */
  readonly rank: number;
  /** 每方数量 */
  readonly count: number;
  /** 是否可移动 */
  readonly movable: boolean;
}

export const PIECE_TABLE: readonly PieceMeta[] = [
  { type: PieceType.Empty, name: "空位", rank: 0, count: 0, movable: false },
  { type: PieceType.Commander, name: "司令", rank: 9, count: 1, movable: true },
  { type: PieceType.General, name: "军长", rank: 8, count: 1, movable: true },
  { type: PieceType.MajorGeneral, name: "师长", rank: 7, count: 2, movable: true },
  { type: PieceType.Brigadier, name: "旅长", rank: 6, count: 2, movable: true },
  { type: PieceType.Colonel, name: "团长", rank: 5, count: 2, movable: true },
  { type: PieceType.Major, name: "营长", rank: 4, count: 2, movable: true },
  { type: PieceType.Captain, name: "连长", rank: 3, count: 3, movable: true },
  { type: PieceType.Lieutenant, name: "排长", rank: 2, count: 3, movable: true },
  { type: PieceType.Engineer, name: "工兵", rank: 1, count: 3, movable: true },
  { type: PieceType.Bomb, name: "炸弹", rank: 0, count: 2, movable: true },
  { type: PieceType.Landmine, name: "地雷", rank: 0, count: 3, movable: false },
  { type: PieceType.Flag, name: "军旗", rank: 0, count: 1, movable: false },
];

/** 下标即 PieceType，便于 O(1) 查询。 */
const BY_TYPE: readonly PieceMeta[] = PIECE_TABLE;

export function pieceMeta(type: PieceType): PieceMeta {
  return BY_TYPE[type] ?? BY_TYPE[0];
}

export function pieceName(type: PieceType): string {
  return pieceMeta(type).name;
}

export function isMovablePiece(type: PieceType): boolean {
  return pieceMeta(type).movable;
}

/** 每方 25 枚棋子的类型清单（用于布阵时的余量统计）。 */
export function pieceInventory(): PieceType[] {
  const out: PieceType[] = [];
  for (const m of PIECE_TABLE) {
    if (m.type === PieceType.Empty) continue;
    for (let i = 0; i < m.count; i++) out.push(m.type);
  }
  return out;
}

export const PIECES_PER_SIDE = pieceInventory().length; // 25

/** 等级比较用的可视符号（调试/日志）。 */
export function rankLabel(type: PieceType): string {
  const m = pieceMeta(type);
  return m.rank > 0 ? String(m.rank) : "-";
}

export function sideName(side: Side): string {
  switch (side) {
    case Side.Red:
      return "红方";
    case Side.Blue:
      return "蓝方";
    default:
      return "无";
  }
}

export function opposite(side: Side): Side {
  if (side === Side.Red) return Side.Blue;
  if (side === Side.Blue) return Side.Red;
  return Side.None;
}
