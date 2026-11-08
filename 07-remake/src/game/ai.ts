/**
 * 本地电脑对手（人机对战）—— **原版 `libjunqi.so` 搜索器的逐条还原**。
 *
 * ## 还原依据
 *
 * Ghidra 反编译库（`04-ghidra/decompiled/`）里，原版 AI 是一个完整的
 * negamax + α-β + 置换表 + 迭代加深搜索器，全部实现在 libjunqi.so 内部，
 * 没有独立资源文件。本文件按下表的函数逐条对译（**Ghidra 镜像基址 = 0x10000**，
 * 即 Ghidra 地址 `0x15xxxx` 对应文件内 vaddr `0x14xxxx`）：
 *
 * | 原版函数 | 作用 | 本文件对应 |
 * |---|---|---|
 * | `FUN_00069840` | 局面装载 + 威胁/攻击位势图（`0x153cc0`）| `computeAttackMap()` |
 * | `FUN_000695f0` | 建子力价值表（含「炸弹 = 司令/3」动态规则）| `PIECE_VALUE` / `BOMB_VALUE` |
 * | `FUN_0006949c` | 叶子估值（子力 + 位置 + 位势）| `evalForMe()` |
 * | `FUN_00068818` | 己方机动格的邻格 `+2` 加成 | `computeAttackMap()` 内 |
 * | `FUN_0006919c` / `FUN_000693f0` | 着法生成（跳过地雷/军旗，工兵走铁路网）| 复用 `core/rules.ts` |
 * | `FUN_0006a890` | negamax + α-β（`-search(-beta,-alpha)`）| `negamax()` |
 * | `FUN_0006a308` / `FUN_0006a400` | 置换表（Zobrist 键 / 2 路桶 / 界类型）| `ttProbe()` / `ttStore()` |
 * | `FUN_0006a5a0` | 着法排序（MVV-LVA + 位置）| `orderMoves()` |
 * | `FUN_0006a9ec` / `FUN_0006ac5c` | 根搜索 + 记录主变 | `searchRoot()` |
 * | `FUN_0006ae10` | 驱动：迭代加深 1→20，`[8]`=深度上限、`[9]`=时限 | `aiChooseMove()` |
 *
 * ### 已确证的原版常量（全部从 .so 原始字节读出，非估计）
 *
 * * **子力价值**（`.data` fileoff `0x13f00c`，12 项，类型 1..12）：
 *   `2560 1280 640 320 160 80 40 30 80 0 40 100000`
 *   → 司令 2560 / 军长 1280 / 师长 640 / 旅长 320 / 团长 160 / 营长 80 /
 *     连长 40 / 排长 30 / 工兵 80 / 炸弹 **动态=司令/3** / 地雷 40 / **军旗 100000**。
 *   ★ 「扛旗即胜」在原版里**就是**军旗的估值 100000，不是特判。
 *   ★ 炸弹的值由 `FUN_000695f0` 运行时算成「全场最高子力 ÷ 3」= 853。
 * * **兵种编号**：1 司令 … 8 排长、9 工兵、10 炸弹、11 地雷、12 军旗
 *   （`FUN_0006919c` 用 `1 < (t-11)` 的补码判据剔除 11/12＝地雷/军旗；`t==9` 走铁路网）。
 * * **位置表**（`.rodata`）：`posBase`、`attackBase`、`ownPosExtra`、`enemyPosExtra`、
 *   `ownPosBonus`、`enemyPosBonus`，各 60 项，行主序 `i = row*5 + col`
 *   —— 与原版棋盘编号**逐格一致**（10 个行营 = {11,13,17,21,23,36,38,42,46,48} 完全吻合）。
 * * **和棋规则**（`FUN_00030548`）：`0x46 = 70` 步无吃子判和；累计 1000 步判和。
 * * **终局分**：`-100000`（无着可走＝负）、`±110000`（搜索边界）、
 *   `|score| ≥ 100001` 视为决定性胜负（扛旗）。
 *
 * ### 无法确证、由本文件按语义补齐的部分（**在此声明**）
 *
 * * **难度 → 深度/时限**：原版没有静态表，`param_1[8]`（深度上限）与 `param_1[9]`（时限 ms）
 *   是难度对话框回调 `FUN_00052f60` 在运行时写进搜索对象的。这里按难度名给出
 *   递增的「迭代加深深度上限 + 思考时限」，并在 `AI_LEVELS` 里注明是**推定值**。
 * * **暗棋（翻棋）的未知子推断**：原版是同一套完全信息搜索器（引擎自己知道暗子身份），
 *   并不做概率推断。人机对战里我们看不到，所以本文件叠了一层
 *   「剩余库存 + 规则约束」的后验模型（下详）——策略层同构、数值层是补的。
 * * **威胁图**里对「暗子」的处理：只统计**已翻开**的敌方大子，避免作弊。
 */

import {
  CELLS,
  ROWS,
  SIDE_ROWS,
  isBase,
  isCamp,
  isRailCell,
  rowOf,
  sideOfRow,
} from "../core/board.ts";
import { PieceType, Side, opposite, pieceMeta } from "../core/pieces.ts";
import {
  CombatResult,
  allLegalMoves,
  applyMove,
  canCarryFlag,
  minesRemaining,
  resolveCombat,
  type RuleOptions,
} from "../core/rules.ts";
import { clonePosition, type Position } from "../core/state.ts";

// ─────────────────────────────────────────────────────────────
// 1. 子力价值（原版 .data 0x13f00c，逐项还原）
// ─────────────────────────────────────────────────────────────

/** 全场最高子力（司令），原版用它推导炸弹价值。 */
export const TOP_PIECE_VALUE = 2560;

/** 炸弹的运行时估值 = 司令 ÷ 3（原版 `FUN_000695f0`：`local_34[side] / 3`）。 */
export const BOMB_VALUE = Math.floor(TOP_PIECE_VALUE / 3); // 853

/**
 * 兵种子力分 —— 原版 `.data` 表原值。
 *
 * 注意几个「反直觉但确凿」的点：
 *  · 军旗 = 100000：「扛旗即胜」是煮在估值里的，不需要特判。
 *  · 地雷 = 40：只是中等价值（不可动、只能被工兵挖），不是大子。
 *  · 工兵 = 80 > 连长 40 > 排长 30：工兵因能挖雷、能走铁路网而贵。
 *  · 炸弹 = 853：由「司令 ÷ 3」动态得出。
 */
export const PIECE_VALUE: Readonly<Record<number, number>> = {
  [PieceType.Empty]: 0,
  [PieceType.Commander]: 2560, // 司令
  [PieceType.General]: 1280, // 军长
  [PieceType.MajorGeneral]: 640, // 师长
  [PieceType.Brigadier]: 320, // 旅长
  [PieceType.Colonel]: 160, // 团长
  [PieceType.Major]: 80, // 营长
  [PieceType.Captain]: 40, // 连长
  [PieceType.Lieutenant]: 30, // 排长
  [PieceType.Engineer]: 80, // 工兵
  [PieceType.Bomb]: BOMB_VALUE, // 炸弹（动态）
  [PieceType.Landmine]: 40, // 地雷
  [PieceType.Flag]: 100000, // 军旗
};

function valueOf(t: number): number {
  return PIECE_VALUE[t] ?? 0;
}

// ─────────────────────────────────────────────────────────────
// 2. 难度（原版 difficulty 枚举 1..5）
// ─────────────────────────────────────────────────────────────

export interface AiLevel {
  /** 原版 difficulty 枚举值 */
  readonly id: number;
  /** 原版标签 */
  readonly name: string;
  /** 旧版同槽位命名（原版另一张标签表） */
  readonly legacy: string;
  /**
   * 迭代加深的**深度上限**（原版搜索对象 `param_1[8]`）。
   * 原版没有静态表，这里是按难度名推定的值。
   */
  readonly depth: number;
  /** 思考时限 ms（原版搜索对象 `param_1[9]`，到点即用上一层结果收手）。推定值。 */
  readonly timeMs: number;
  /** 根节点候选着法上限（原版不截断；这是 JS 单线程的性能保护） */
  readonly width: number;
  /** 估值随机扰动——原创无此项，恒 0 */
  readonly noise: number;
  /** 失误率——原创无此项，恒 0 */
  readonly blunder: number;
}

/**
 * 原版 5 档难度：1 新手 / 2 容易 / 3 普通 / 4 高级 / 5 困难。
 *
 * ⚠ 原版的难度只改**搜索深度与时限**（`FUN_0006ae10` 的 `[8]`/`[9]`），
 * 估值函数本身与难度无关、也没有随机扰动。因此这里 `noise`/`blunder` 全为 0，
 * 「菜」完全来自搜得浅。
 */
export const AI_LEVELS: readonly AiLevel[] = [
  { id: 1, name: "新手", legacy: "初级", depth: 1, timeMs: 15, width: 12, noise: 0, blunder: 0 },
  { id: 2, name: "容易", legacy: "初级", depth: 3, timeMs: 30, width: 16, noise: 0, blunder: 0 },
  { id: 3, name: "普通", legacy: "中级", depth: 6, timeMs: 60, width: 20, noise: 0, blunder: 0 },
  { id: 4, name: "高级", legacy: "高级", depth: 12, timeMs: 120, width: 32, noise: 0, blunder: 0 },
  { id: 5, name: "困难", legacy: "高级", depth: 19, timeMs: 240, width: 256, noise: 0, blunder: 0 },
];

export const DEFAULT_AI_LEVEL = 3; // 原版新局对话框默认 = 普通

export function aiLevel(id: number): AiLevel {
  return AI_LEVELS.find((l) => l.id === id) ?? AI_LEVELS[2];
}

/** 可复现的伪随机数发生器（LCG）。 */
export function makeRng(seed = Date.now()): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────
// 3. 原版位置表（.rodata，60 项，行主序 i = row*5 + col）
// ─────────────────────────────────────────────────────────────

/** `DAT_00132724`：格点基础位置分（铁路端点 2、前沿 3）。 */
const POS_BASE: readonly number[] = [
  0, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 3, 0, 0, 0, 3, 3, 0, 0, 0, 3, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 0,
];

/** `DAT_001329f4`：攻守位势基线（自己半场 1、前沿 2、中腹 3、两个要冲 5）。 */
const ATTACK_BASE: readonly number[] = [
  1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 0, 4, 0, 2, 2, 4, 0, 4, 2,
  2, 0, 5, 0, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 0, 5, 0, 2,
  2, 4, 0, 4, 2, 2, 0, 4, 0, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1,
];

/** `DAT_00132814`：己方专用格位附加分（大本营 20、行营 40、中央行营 30）。 */
const OWN_POS_EXTRA: readonly number[] = [
  0, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 40, 0, 40, 0, 0, 0, 30, 0, 0,
  0, 40, 0, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 40, 0, 40, 0,
  0, 0, 30, 0, 0, 0, 40, 0, 40, 0, 0, 0, 0, 0, 0, 0, 20, 0, 20, 0,
];

/** `DAT_00132904`：敌方视角的格位附加分（只有行营，无大本营）。 */
const ENEMY_POS_EXTRA: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 40, 0, 40, 0, 0, 0, 30, 0, 0,
  0, 40, 0, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 40, 0, 40, 0,
  0, 0, 30, 0, 0, 0, 40, 0, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

/** `DAT_00133da4`：己方附加分的生效闸门（行营 10 + 大本营 4 = 14 格）。 */
const OWN_POS_BONUS: readonly number[] = [
  0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0,
  0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0,
  0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0,
];

/** `DAT_00133e94`：暗棋模式用的闸门（只有行营 10 格）。 */
const ENEMY_POS_BONUS: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0,
  0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0,
  0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

/**
 * 原版步进邻接图（`.rodata` fileoff `0x122ae0`，Ghidra `0x132ae0`）。
 * 记录格式：步长 `0x24`，邻居表从 `+4` 起，`-1` 结尾。
 *
 * ★ 它与 8 邻域**不等价** —— 斜走只在「行营」的进出上成立，正是军棋的公路规则。
 *   交叉验证：邻居度为 8 的格子恰好是那 10 个行营
 *   `{11,13,17,21,23,36,38,42,46,48}`；列 2 在两条前沿行上多出跨方连边
 *   （与 `board.ts` 的 `FRONTIER_RAIL_COLS` 吻合）。
 *   例：格 0=(0,0) 的邻居只有 {1,5}，**没有**斜格 6=(1,1)。
 */
const ADJACENCY_RAW =
  "1,5;0,2,6;1,3,7;2,4,8;3,9;0,6,10,11;1,5,7,11;2,6,8,11,12,13;3,7,9,13;4,8,13,14;5,11,15;5,6,7,10,12,15,16,17;7,11,13,17;7,8,9,12,14,17,18,19;9,13,19;10,11,16,20,21;" +
  "11,15,17,21;11,12,13,16,18,21,22,23;13,17,19,23;13,14,18,23,24;15,21,25;15,16,17,20,22,25,26,27;17,21,23,27;17,18,19,22,24,27,28,29;19,23,29;20,21,26,30;21,25,27;" +
  "21,22,23,26,28,32;23,27,29;23,24,28,34;25,31,35,36;30,32,36;27,31,33,36,37,38;32,34,38;29,33,38,39;30,36,40;30,31,32,35,37,40,41,42;32,36,38,42;32,33,34,37,39,42,43,44;" +
  "34,38,44;35,36,41,45,46;36,40,42,46;36,37,38,41,43,46,47,48;38,42,44,48;38,39,43,48,49;40,46,50;40,41,42,45,47,50,51,52;42,46,48,52;42,43,44,47,49,52,53,54;44,48,54;" +
  "45,46,51,55;46,50,52,56;46,47,48,51,53,57;48,52,54,58;48,49,53,59;50,56;51,55,57;52,56,58;53,57,59;54,58";

const NEIGHBORS: readonly (readonly number[])[] = ADJACENCY_RAW.split(";").map((s) =>
  s.length > 0 ? s.split(",").map(Number) : [],
);

// ─────────────────────────────────────────────────────────────
// 4. 威胁 / 攻击位势图（`FUN_00069840` + `FUN_00068818`）
// ─────────────────────────────────────────────────────────────

/**
 * 计算本回合的「攻守位势图」（原版 `DAT_00153cc0`）。
 *
 * 三件事，顺序与原版一致：
 *  1. `attackBase` 拷贝；再给随机的半张棋盘各 `+1`（原版 `FUN_000aadf4(0,1)`
 *     摇一次，用来打破左右对称、让每局不一样）。
 *  2. 己方机动子的邻格 `+2`（`FUN_00068818`，鼓励贴子连动）。
 *  3. 威胁裁决（`FUN_00069840`）：只看**1..4 号大子**（司令/军长/师长/旅长）。
 *     · 敌方大子压着、我方没有更大的 → 该格归零（去了送死）
 *     · 我方压着对方（`own <= foe`，号小者强）或我方单方面控制 → `+8`
 *     · 都没大子、但我方有子占着铁路能辐射到 → `+4`
 */
function computeAttackMap(
  pos: Position,
  side: Side,
  opts: RuleOptions,
  rng: () => number,
): Int32Array {
  const adj = Int32Array.from(ATTACK_BASE);

  // 1) 随机半场 +1（原版 `FUN_000aadf4(0,1)` 的对称性破除）
  const half = rng() < 0.5 ? 0 : 30;
  for (let k = 0; k < 30; k++) adj[half + k] += 1;

  const NONE = 255;
  const ownRank = new Uint8Array(CELLS).fill(NONE); // 邻格里我方最强攻子的「号」（越小越强）
  const foeRank = new Uint8Array(CELLS).fill(NONE);
  const ownMobility = new Uint8Array(CELLS); // 邻格是否贴着我方机动子
  const railReach = new Uint8Array(CELLS); // 是否在我方铁路子的辐射范围内

  const isBig = (t: number): boolean => t >= PieceType.Commander && t <= PieceType.Brigadier;

  for (let j = 0; j < CELLS; j++) {
    const t = pos.type[j];
    if (t === PieceType.Empty) continue;
    const owner = pos.owner[j] as Side;
    const movable = pieceMeta(t as PieceType).movable;
    const mine = owner === side;

    // 暗棋里没翻开的敌子，不当作已知大子（不给引擎开挂）
    const known = mine || !opts.hidden || pos.revealed[j] === 1;

    for (const n of NEIGHBORS[j]) {
      if (mine) {
        if (movable) ownMobility[n] = 1;
        if (known && isBig(t) && t < ownRank[n]) ownRank[n] = t;
      } else if (known && isBig(t) && t < foeRank[n]) {
        foeRank[n] = t;
      }
    }
    if (mine && movable && isRailCell(j)) {
      for (const n of NEIGHBORS[j]) railReach[n] = 1;
    }
  }

  // 2) 己方机动子的邻格 +2（`FUN_00068818`）
  for (let i = 0; i < CELLS; i++) if (ownMobility[i]) adj[i] += 2;

  // 3) 威胁裁决
  for (let i = 0; i < CELLS; i++) {
    const o = ownRank[i];
    const f = foeRank[i];
    if (f === NONE) {
      if (o !== NONE) adj[i] += 8;
      else if (railReach[i]) adj[i] += 4;
    } else if (o !== NONE && o <= f) {
      adj[i] += 8;
    } else {
      adj[i] = 0;
    }
  }
  return adj;
}

// ─────────────────────────────────────────────────────────────
// 5. 不完全信息模型（补的，原版没有）
// ─────────────────────────────────────────────────────────────

interface Cand {
  type: PieceType;
  /** 条件概率 */
  p: number;
}

export interface Belief {
  /** 每格（仅未翻开的敌方格子有意义）的候选分布 */
  readonly byCell: Map<number, Cand[]>;
}

/**
 * 该方阵地里"后两行"的行号（地雷只可能在这里 —— 地雷不可移动）。
 * 红方底线在行 0，蓝方底线在行 11。
 */
function backRows(side: Side): [number, number] {
  return side === Side.Red ? [0, 1] : [ROWS - 2, ROWS - 1];
}

/**
 * 构建"未知敌子"的后验模型。
 *
 * 库存推算：`剩余库存 = 全套 − 已翻开的活敌子`，阵亡的暗子按比例中性扣除。
 * 两条**确定性推理**（不可动的子只能出现在特定位置）：
 *   1. 地雷不可移动 → 只可能在该方的后两行；之外的暗子一定不是地雷。
 *   2. 军旗不可移动 → 只可能在大本营；非大本营的暗子一定不是军旗。
 * 再叠加"炸弹不在最前线"的布阵约束。
 */
export function buildBelief(pos: Position, me: Side): Belief {
  const foe = opposite(me);
  const total = new Map<PieceType, number>();
  for (const m of [
    PieceType.Commander, PieceType.General, PieceType.MajorGeneral,
    PieceType.Brigadier, PieceType.Colonel, PieceType.Major,
    PieceType.Captain, PieceType.Lieutenant, PieceType.Engineer,
    PieceType.Bomb, PieceType.Landmine, PieceType.Flag,
  ] as const) {
    total.set(m, pieceMeta(m).count);
  }

  const unknownCells: number[] = [];
  for (let i = 0; i < CELLS; i++) {
    if (pos.owner[i] !== foe || pos.type[i] === PieceType.Empty) continue;
    if (pos.revealed[i] === 1) {
      const t = pos.type[i] as PieceType;
      total.set(t, (total.get(t) ?? 0) - 1);
    } else {
      unknownCells.push(i);
    }
  }

  let stock = 0;
  for (const n of total.values()) stock += Math.max(0, n);
  const unknownDead = Math.max(0, stock - unknownCells.length);
  if (unknownDead > 0 && stock > 0) {
    for (const [t, n] of total) {
      total.set(t, Math.max(0, n) * (1 - unknownDead / stock));
    }
  }

  const byCell = new Map<number, Cand[]>();
  for (const cell of unknownCells) {
    const r = rowOf(cell);
    const [b0, b1] = backRows(foe);
    const inBack = r >= b0 && r <= b1;
    const base = isBase(cell);

    const list: Cand[] = [];
    let sum = 0;
    for (const [t, n] of total) {
      let w = Math.max(0, n);
      if (w <= 0) continue;
      // 硬约束 1：地雷只能在后两行
      if (t === PieceType.Landmine && !inBack) continue;
      // 硬约束 2：军旗只能在大本营
      if (t === PieceType.Flag && !base) continue;
      // 布阵约束：炸弹不放在最前线那一行
      if (t === PieceType.Bomb) {
        const foeFront = foe === Side.Red ? SIDE_ROWS - 1 : SIDE_ROWS;
        if (r === foeFront) w *= 0.15;
      }
      list.push({ type: t, p: w });
      sum += w;
    }
    if (sum <= 0) {
      list.length = 0;
      list.push({ type: PieceType.Lieutenant, p: 1 });
      sum = 1;
    }
    for (const c of list) c.p /= sum;
    byCell.set(cell, list);
  }
  return { byCell };
}

/** 打在该格上的期望收益（我方视角，单位＝子力分）。完全信息时退化为确定收益。 */
function expectedAttack(
  pos: Position,
  cell: number,
  attacker: PieceType,
  belief: Belief,
  opts: RuleOptions,
  /** 进攻方阵营（判定"扛旗资格"要知道是谁的最小子） */
  mover: Side,
): number {
  const va = valueOf(attacker);
  // 扛军旗的门槛依赖"对方剩余地雷数"与"本方扛旗资格"，都得从棋盘现算。
  const gate = (def: PieceType): number =>
    def === PieceType.Flag ? minesRemaining(pos, pos.owner[cell] as Side) : 0;
  const canCarry = canCarryFlag(pos, mover, attacker, opts);
  if (pos.revealed[cell] === 1 || !opts.hidden) {
    const d = pos.type[cell] as PieceType;
    const r = resolveCombat(attacker, d, opts, gate(d), canCarry);
    return combatScore(r, va, valueOf(d));
  }
  const cand = belief.byCell.get(cell);
  if (!cand) return 0;
  let ev = 0;
  for (const c of cand) {
    const r = resolveCombat(attacker, c.type, opts, gate(c.type), canCarry);
    if (r === "illegal") continue;
    ev += c.p * combatScore(r, va, valueOf(c.type));
  }
  return ev;
}

/** 一次交战对我方的净收益。 */
function combatScore(r: CombatResult | "illegal", va: number, vd: number): number {
  if (r === "illegal") return 0;
  if (r === CombatResult.AttackerWins) return vd; // 吃子占位，我方攻方仍在
  if (r === CombatResult.DefenderWins) return -va; // 攻方阵亡
  return vd - va; // 同归于尽
}

// ─────────────────────────────────────────────────────────────
// 6. 叶子估值（`FUN_0006949c`）
// ─────────────────────────────────────────────────────────────

/**
 * `FUN_0006949c` 的对译，统一成「对我方 `me` 的分数」。
 *
 * 每格贡献 = 子力分 + 格位附加分 + 基础位置分 + 攻守位势分；
 * 己方格子加、敌方格子减（原版用「格子状态 1/2」做同一件事）。
 *
 * 暗棋里未翻开的敌子不知道身份，用后验分布求期望（原版引擎自己知道暗子，无此步）。
 */
function evalForMe(
  pos: Position,
  me: Side,
  belief: Belief,
  opts: RuleOptions,
  attack: Int32Array,
  mine: boolean,
): number {
  const gate = mine ? OWN_POS_BONUS : ENEMY_POS_BONUS;
  const extra = mine ? OWN_POS_EXTRA : ENEMY_POS_EXTRA;

  let s = 0;
  for (let i = 0; i < CELLS; i++) {
    const t = pos.type[i];
    if (t === PieceType.Empty) continue;
    const owner = pos.owner[i] as Side;
    if (owner === Side.None) continue;

    const bonus = gate[i] !== 0 ? extra[i] : 0;
    const posScore = POS_BASE[i] + attack[i];

    if (owner === me) {
      s += valueOf(t) + bonus + posScore;
      continue;
    }
    if (pos.revealed[i] === 1 || !opts.hidden) {
      s -= valueOf(t) + bonus + posScore;
    } else {
      const cand = belief.byCell.get(i);
      if (!cand) {
        s -= BOMB_VALUE + posScore; // 未知时按「炸弹级」保守估计
        continue;
      }
      let ev = 0;
      for (const c of cand) ev += c.p * valueOf(c.type);
      s -= ev + posScore;
    }
  }
  return s;
}

// ─────────────────────────────────────────────────────────────
// 7. Zobrist 键 + 置换表（`FUN_0006a308` / `FUN_0006a400`）
// ─────────────────────────────────────────────────────────────

const TT_BITS = 17; // 131072 桶（原版 2^18 桶的两路表，这里收一半省内存）
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;

const TT_EXACT = 1;
const TT_LOWER = 2; // 下界（发生 β 截断）
const TT_UPPER = 3; // 上界

const Z_LO = new Int32Array(13 * 3 * CELLS);
const Z_HI = new Int32Array(13 * 3 * CELLS);
const Z_REV = new Int32Array(CELLS);
const Z_SIDE = new Int32Array(1);

(function initZobrist() {
  const rng = makeRng(0x9e3779b9);
  const next = () => (rng() * 4294967296) | 0;
  for (let k = 0; k < Z_LO.length; k++) {
    Z_LO[k] = next();
    Z_HI[k] = next();
  }
  for (let k = 0; k < CELLS; k++) {
    Z_REV[k] = next();
  }
  Z_SIDE[0] = next();
})();

interface TT {
  lo: Int32Array;
  hi: Int32Array;
  depth: Int8Array;
  flag: Int8Array;
  score: Int32Array;
  move: Int32Array;
}
function newTT(): TT {
  return {
    lo: new Int32Array(TT_SIZE),
    hi: new Int32Array(TT_SIZE),
    depth: new Int8Array(TT_SIZE),
    flag: new Int8Array(TT_SIZE),
    score: new Int32Array(TT_SIZE),
    move: new Int32Array(TT_SIZE),
  };
}

function hashOf(pos: Position, side: Side, out: Int32Array): void {
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < CELLS; i++) {
    const t = pos.type[i];
    if (t === PieceType.Empty) continue;
    const owner = pos.owner[i] as Side;
    const k = (t * 3 + owner) * CELLS + i;
    lo ^= Z_LO[k];
    hi ^= Z_HI[k];
    if (pos.revealed[i] === 1) {
      lo ^= Z_REV[i];
      hi ^= Z_REV[i] * 0x85ebca6b;
    }
  }
  if (side === Side.Blue) {
    lo ^= Z_SIDE[0];
    hi ^= Z_SIDE[0] * 0xc2b2ae35;
  }
  out[0] = lo;
  out[1] = hi;
}

// ─────────────────────────────────────────────────────────────
// 8. 搜索（`FUN_0006a890` negamax + `FUN_0006a9ec` 根）
// ─────────────────────────────────────────────────────────────

const SCORE_MATE = 100000; // 无着可走（原版 0xfffe7960）
const SCORE_INF = 110000; // 搜索边界（原版 0xfffe5250）

/**
 * 「走完会回到已经出现过的局面」的**基础降权分** —— 见 `AvoidMove`。
 *
 * 取值两头都要顾：
 * - 要**压过静着之间的位势差**（行营/中央 ≈ 30~40），否则换了等于没换；
 * - 又要**远小于一手真收益**（最小子力 30，且吃子还有 ×16 的期望收益项），
 *   否则 AI 会为了避重复而放弃便宜。
 *
 * 另外它**永远不会作用在吃子上**：吃子必然改变子力 ⇒ 局面指纹不可能与历史重合，
 * 所以规避列表里天然不含吃子。
 *
 * ★ 实际扣分 = `AVOID_PENALTY × times`，并在 `times` 增大时**再乘一道加码**
 *   （见 `avoidPenalty()`）。理由见下。
 */
const AVOID_PENALTY = 45;
const DRAW_PLIES = 70; // 70 步无吃子判和（原版 0x46）

/**
 * 规避着法的实际扣分。
 *
 * ## 为什么不是常数 45
 *
 * 2026-09-17 实测（`tests/run.ts` 19d 的构造局面）：
 * 军棋同一方的 5 个行营是一张**以中央行营为枢纽的星形图** ——
 * 蓝方 `36/38/46/48` 各自**只**与 `42` 相邻，红方 `11/13/21/23` 各自只与 `17` 相邻。
 * 一枚子在星形图上穿梭时，轨迹是 `42→36→42→38→42→46→…`：
 * **循环周期是 4 手（每方 2 手）**，而不是 2 手。
 * 于是「走完是否回到已出现过的局面」这个判据只在**每 4 手**命中一次，
 * 且此刻 `avoid` 里**永远只有一条**（那条刚好闭合 4 手环的着法）——
 * 剩下的 3 个营都还"没被走过"，随便挑一个就绕开了降权。
 * 实测：把惩罚从 45 提到 45×2=90 完全无效（着法序列逐手一致）。
 *
 * ## 所以加一道随次数**加速**的加码
 *
 * 光靠线性 ×times 涨得太慢（`times` 也只缓慢爬到 2、3）。
 * 改成 `45 × times²`：重复 1 次扣 45（与旧行为一致）、2 次扣 180、3 次扣 405 ——
 * 一旦同一个局面开始反复出现，惩罚迅速盖过任何静着位势差（行营才 +40），
 * 逼它换方向；而**首次**回到某局面时只扣 45，仍小于"一手真收益"，
 * 不会为避重复而放弃便宜（吃子本来就天然不在列表里）。
 *
 * `times <= 0`（没回到旧盘面）⇒ 不罚。
 */
function avoidPenalty(times: number): number {
  if (times <= 0) return 0;
  return AVOID_PENALTY * times * times;
}

/** 「同一枚子最近被挪了几手」的统计窗口（手）。 */
export const SHUFFLE_WINDOW = 12;
/**
 * 同一枚子在窗口内被挪动的**免罚次数**：挪到第 2 次才开始罚。
 * 给一手真机动（比如真出兵）留余量，别把正常调度也罚了。
 *
 * ⚠️ 计数是**含本次**的 1-indexed 值（`watchMovedCount` 最小返回 1），
 *    所以"免罚 1 次" = 传进来的 `moved` 为 1 时不罚。
 */
const SHUFFLE_FREE = 1;

/**
 * 「同一枚子最近老在挪」的扣分 —— **这才是"两格之间来回走"的正解**。
 *
 * ## 为什么指纹判据不够（2026-09-17 实测更正）
 *
 * 玩家实报「云端 AI 一直在两个地方来回移动」，截图上那枚子是**在同一方的两个
 * 相邻格之间往返**。查下来：
 *   · 该子只有 2 个出路（`44` 是窄格：邻格 `38/39/43/48/49`，其中只有 `39` 可用）；
 *   · `44→39` 与 `39→44` 是它**唯一**两条静着，而全场其它着法分也不比它高；
 *   · 引擎于是把它翻来覆去地挪。
 * 关键在：**别处的子同时在慢慢漂**，所以整盘指纹**每手都是新的** ——
 * 实测 87 手跑下来「不同局面 88 个、重复 0 次」。**没有重复局面可判**，
 * `avoid`（无论常数 / 平方）全都打空。旧结论"4 手周期长循环"只对**棋盘静止**
 * 的构造局面成立，实战里不成立。
 *
 * ## 换成按「子」计数
 *
 * 不看盘面，看**这枚子**：最近 `SHUFFLE_WINDOW` 手里它被挪了几次。
 * 挪到第 `SHUFFLE_FREE + 1` 次开始罚，之后线性加码 ——
 * 一颗子连着挪 5 手就该被按住，转去动别的子。
 *
 * 为什么这次不需要平方：指纹判据要"等局面回旧样子"，命中稀疏所以只能靠加速；
 * 而按子计数**每手都会命中那枚子在挪的事实**，线性加码已经足够（且在
 * `SHUFFLE_WINDOW` 内单调增长、窗口滑出后自动回落 —— 不会把一颗子永久钉死）。
 *
 * `moved <= 1`（含本次只挪了 1 次 ⇒ 窗口内没挪过）⇒ 不罚。
 */
function shufflePenalty(moved: number): number {
  if (moved <= SHUFFLE_FREE) return 0;
  return AVOID_PENALTY * (moved - SHUFFLE_FREE);
}

const ABORT = { abort: true } as const;

interface SearchCtx {
  me: Side;
  opts: RuleOptions;
  belief: Belief;
  attack: Int32Array;
  tt: TT;
  deadline: number;
  /** 硬性节点上限（时钟失效/极端局面时的兜底，见下） */
  maxNodes: number;
  nodes: number;
  aborted: boolean;
  hash: Int32Array;
  /** 「走完会回到旧局面」的着法 → 该扣多少分（打包成 `from*CELLS+to`），见 `AvoidMove` */
  avoid?: ReadonlyMap<number, number>;
}

/**
 * 上一次搜索的统计量（诊断/自检用）。
 *
 * `maxNodes` 存在的理由：原版只靠**墙钟**收手，这在浏览器里有个坑 ——
 * 无头 Chrome 的 `--virtual-time-budget` 会在 JS 同步执行期间冻结时钟，
 * 于是 `Date.now()` 永远到不了 deadline，迭代加深就会一路搜到深度上限。
 * 所以这里再压一道节点数闸门，保证任何情况下工作量都是有界的。
 */
export const AI_STATS = { lastNodes: 0, lastDepth: 0, hitMaxNodes: false };

export interface RootMove {
  from: number;
  to: number;
  /** 上轮迭代的分数，用于下一轮排序；初始为静态排序分 */
  score: number;
}

function packMove(from: number, to: number): number {
  return from * CELLS + to;
}

/**
 * 「这一步走完会回到已经出现过的局面」——由**观战侧**（`main.ts` 的 `watchSeen`）
 * 逐手比对局面指纹算出来，再交回引擎要求规避。
 *
 * 为什么需要它：两台 AI 实力相当时，最容易出现"谁都不肯先吃亏 → 在那两三个格
 * 之间来回走"的僵局。子力一直没变，光靠"70 步无吃子"要磨很久才收得住，
 * 观战看起来就像卡死。让引擎**主动换着法**才是根治。
 *
 * ⚠️ **单靠局面指纹抓不住最常见的磨法**（2026-09-17 实测更正）。用户实报的
 * "云端在两格之间来回走"，真相是：**同一枚子在自己两个相邻格之间往返**，
 * 而与此同时**别处的子也在慢慢挪** ⇒ 整盘指纹**每手都是新的**，
 * 87 手跑下来「不同局面 88 个、重复 0 次」。指纹判据怎么调惩罚都白搭，
 * 因为**根本没有重复局面可判**。真正该看的是**"这枚子最近是不是老在挪"**——
 * 见 `shufflePenalty()` / `AvoidMove.shuffle`。
 */
export interface AvoidMove {
  from: number;
  to: number;
  /**
   * 走完会落到的那格局面**在历史上已经出现过几次**（1 = 只出现过一次）。
   *
   * 省略按 1 算。引擎侧按 `avoidPenalty(times)`（= `45 × times²`）扣分 ——
   * 掐的是**真·重复局面**（双方都走回同一盘面）。这层对"单子往返 + 别处漂移"
   * 那种磨法无效，得靠 `shuffle`。
   */
  times?: number;
  /**
   * 发起这步的那枚子**最近挪过几次**（含本次），由 `shufflePenalty()` 定价。
   *
   * 判据不是盘面而是**这枚子的走动频次**：同一枚子在最近 `SHUFFLE_WINDOW` 手里
   * 被反复调动的次数。指纹判据要求"整盘回到旧样子"，而实战里最常见的磨法是
   * **一枚子来回走、其它子慢慢漂**，盘面永远不回旧样子（实测 87 手 0 重复）。
   * 换成按"子"计数就抓得住了：那枚子每挪一次贵一次，几手之内就被逼停。
   *
   * 省略按 0 算（不扣分）。
   */
  shuffle?: number;
}


/**
 * 把调用方给的规避列表打包成 `着法 → 该扣多少分`。
 *
 * 扣分 = `avoidPenalty(times)` + `shufflePenalty(shuffle)`，两项**取和**：
 *   · `times` —— 走完会落回**已经出现过的盘面**（真·重复局面）；
 *     省略或 `0` ⇒ **不罚**（"没回到旧盘面"和"回到过 1 次"是两回事，不能混）。
 *   · `shuffle` —— 发起这步的**那枚子最近挪得太勤**（实战里最常见的磨法，
 *     盘面每手都是新的、`times` 抓不住，只能按子计数）；
 *     `<= 1` ⇒ 不罚（1 = 窗口内没挪过）。
 * 两项同时命中就叠加（既在重复盘面、子又在被反复挪，确实更该劝退）。
 *
 * ⚠️ **两项的缺省语义不一样**：`times` 缺省 = 0（不罚），`shuffle` 缺省 = 1（不罚）。
 *    都按"不罚"处理，而不是各自取一个会误伤的值 —— 早期版本把 `times ?? 1`
 *    当缺省，结果"只想按 shuffle 罚"的调用方会白挨 45 分。
 *
 * **命中数 ≥ 合法着法数时返回 `undefined`**（整体作废）：那说明这一侧怎么走都
 * 会被罚，硬降权只会让排序失真（且可能把它逼进更差的着法）。
 */
function buildAvoidSet(
  avoid: readonly AvoidMove[] | undefined,
  legalCount: number,
): ReadonlyMap<number, number> | undefined {
  if (!avoid || avoid.length === 0) return undefined;
  const map = new Map<number, number>();
  for (const m of avoid) {
    const k = packMove(m.from, m.to);
    const pen = avoidPenalty(m.times ?? 0) + shufflePenalty(m.shuffle ?? 1);
    if (pen <= 0) continue;
    // 同一着法不会重复给，但保守取最大值（更贵的那次说了算）。
    map.set(k, Math.max(map.get(k) ?? 0, pen));
  }
  return map.size === 0 || map.size >= legalCount ? undefined : map;
}

/**
 * 把"会回到旧局面"的着法**降到队尾**。
 *
 * 只降权、不剔除：剔除会让引擎在"每条路都回到旧局面"时误判无子可动；
 * 降权则保证它优先换着法，实在没得换才走回去 —— 那时交给三次重复判和收尾。
 *
 * `Array.prototype.sort` 是稳定排序，所以组内仍保持原来的分数次序。
 */
function applyAvoidBias(root: RootMove[], avoid?: ReadonlyMap<number, number>): void {
  if (!avoid || avoid.size === 0 || root.length < 2) return;
  let hits = 0;
  for (const m of root) if (avoid.has(packMove(m.from, m.to))) hits++;
  if (hits === 0 || hits === root.length) return;
  root.sort(
    (a, b) => (avoid.has(packMove(a.from, a.to)) ? 1 : 0) - (avoid.has(packMove(b.from, b.to)) ? 1 : 0),
  );
}

interface OrderedMove {
  from: number;
  to: number;
  capture: boolean;
  ord: number;
}

/** `FUN_0006a5a0`：MVV-LVA + 位置差的着法排序（好着排前面，α-β 才剪得动）。 */
function orderMoves(
  pos: Position,
  ctx: SearchCtx,
  moves: { from: number; to: number; capture: boolean }[],
  ttMove: number,
): OrderedMove[] {
  const out: OrderedMove[] = [];
  for (const m of moves) {
    const attacker = pos.type[m.from] as PieceType;
    let sc: number;
    if (m.capture) {
      const gain =
        pos.revealed[m.to] === 1 || !ctx.opts.hidden
          ? valueOf(pos.type[m.to])
          : expectedAttack(pos, m.to, attacker, ctx.belief, ctx.opts, pos.owner[m.from] as Side);
      sc = 100000 + gain * 16 - valueOf(attacker);
    } else {
      sc =
        (ATTACK_BASE[m.to] - ATTACK_BASE[m.from]) * 4 +
        (POS_BASE[m.to] - POS_BASE[m.from]) * 4 +
        (ctx.attack[m.to] - ctx.attack[m.from]);
    }
    if (packMove(m.from, m.to) === ttMove) sc += 100000000; // 置换表着法最优先
    out.push({ from: m.from, to: m.to, capture: m.capture, ord: sc });
  }
  out.sort((a, b) => b.ord - a.ord);
  return out;
}

function negamax(
  pos: Position,
  side: Side,
  depth: number,
  alpha: number,
  beta: number,
  since: number,
  ctx: SearchCtx,
): number {
  ctx.nodes++;
  // 前 1024 个节点不查表：保证第 1 层迭代一定能跑完，别让极小的时间预算把根都搜空。
  // 同时压一道节点闸门，防止「时钟不前进」时迭代加深失控。
  if (
    ctx.nodes >= 1024 &&
    (ctx.nodes & 255) === 0 &&
    (Date.now() > ctx.deadline || ctx.nodes > ctx.maxNodes)
  ) {
    ctx.aborted = true;
    throw ABORT;
  }
  if (since >= DRAW_PLIES) return 0; // 无吃子和棋

  const atLeaf = depth <= 0;

  let lo = 0;
  let hi = 0;
  let ttMove = 0;
  if (!atLeaf) {
    const pair = ctx.hash;
    hashOf(pos, side, pair);
    lo = pair[0];
    hi = pair[1];
    const k = (lo >>> 0) & TT_MASK;
    if (ctx.tt.lo[k] === lo && ctx.tt.hi[k] === hi) {
      ttMove = ctx.tt.move[k];
      if (ctx.tt.depth[k] >= depth) {
        const s = ctx.tt.score[k];
        const f = ctx.tt.flag[k];
        if (f === TT_EXACT) return s;
        if (f === TT_LOWER && s >= beta) return s;
        if (f === TT_UPPER && s <= alpha) return s;
      }
    }
  }

  if (atLeaf) {
    const v = evalForMe(pos, ctx.me, ctx.belief, ctx.opts, ctx.attack, true);
    return side === ctx.me ? v : -v;
  }

  // 原版 `FUN_0006a890` 的**静态剪枝**（生成着法之前先看一眼叶子分）：
  //   `pcVar5 = FUN_0006949c(); if (param_4 <= pcVar5) return pcVar5;`
  // 即 beta ≤ 静态分就直接 fail-soft 返回；随后 `if (param_3 < pcVar5) param_3 = pcVar5;`
  // 把 alpha 抬到静态分（原版管这叫 selective deepening 的门槛）。
  // 这个剪枝是原版**速度的主要来源**，一并还原。
  {
    const s = evalForMe(pos, ctx.me, ctx.belief, ctx.opts, ctx.attack, true);
    const stand = side === ctx.me ? s : -s;
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    if (depth > 31) return stand; // 原版 `0x1f < iVar6` → 不再加深
  }

  const raw = allLegalMoves(pos, side, ctx.opts);
  if (raw.length === 0) return -SCORE_MATE + (100 - depth); // 无着可走＝负（原版返回 -100000）
  const moves = orderMoves(pos, ctx, raw, ttMove);

  let best = -SCORE_INF;
  let bestMove = 0;
  let bestFlag = TT_UPPER;
  for (const m of moves) {
    const child = clonePosition(pos);
    const res = applyMove(child, m.from, m.to, ctx.opts);
    let v: number;
    if (res.flagTaken) {
      v = SCORE_MATE - (DRAW_PLIES - Math.min(since, DRAW_PLIES)); // 扛旗即胜，越早越好
    } else {
      const nextSince = res.combat === "void" ? since + 1 : 0;
      v = -negamax(child, opposite(side), depth - 1, -beta, -alpha, nextSince, ctx);
    }
    if (v > best) {
      best = v;
      bestMove = packMove(m.from, m.to);
    }
    if (v > alpha) {
      alpha = v;
      bestFlag = TT_EXACT;
    }
    if (alpha >= beta) {
      bestFlag = TT_LOWER;
      break;
    }
  }

  if (!ctx.aborted) {
    const k = (lo >>> 0) & TT_MASK;
    ctx.tt.lo[k] = lo;
    ctx.tt.hi[k] = hi;
    ctx.tt.depth[k] = Math.min(depth, 127);
    ctx.tt.flag[k] = bestFlag;
    ctx.tt.score[k] = best;
    ctx.tt.move[k] = bestMove;
  }
  return best;
}

/** 根搜索（`FUN_0006a9ec` 的简化：不做 PV 存储，只挑最优着）。 */
function searchRoot(
  pos: Position,
  root: RootMove[],
  depth: number,
  ctx: SearchCtx,
): RootMove | null {
  let alpha = -SCORE_INF;
  let best: RootMove | null = null;
  let bestScore = -SCORE_INF;
  for (const rm of root) {
    const child = clonePosition(pos);
    const res = applyMove(child, rm.from, rm.to, ctx.opts);
    let v: number;
    if (res.flagTaken) {
      v = SCORE_MATE;
    } else {
      v = -negamax(child, opposite(ctx.me), depth - 1, -SCORE_INF, -alpha, 0, ctx);
      // 「会回到旧局面」的着法降权，逼它换着法而不是来回磨（见 `AvoidMove`）。
      // ★ 只在**非吃子**分支里加权：吃子是硬收益，不该被"避免重复"盖过去。
      if (ctx.avoid) v -= ctx.avoid.get(packMove(rm.from, rm.to)) ?? 0;
    }
    rm.score = v;
    if (v > bestScore) {
      bestScore = v;
      best = rm;
    }
    if (v > alpha) alpha = v;
  }
  // 供下一轮迭代排序（把好着排前面，α-β 才剪得动）
  root.sort((a, b) => b.score - a.score);
  return best;
}

// ─────────────────────────────────────────────────────────────
// 9. 对外：选着法
// ─────────────────────────────────────────────────────────────

interface Move {
  from: number;
  to: number;
  /** 一步静态打分（排序用） */
  order: number;
}

/**
 * 电脑在「布局对战」里选一步棋。
 *
 * 流程＝原版 `FUN_0006ae10`：迭代加深 1→`level.depth`；
 * 每层跑完就刷新最优着；超过 `level.timeMs` 或搜到 `depth` 上限就收手，
 * 用**最后一次完整搜完的那一层**的结果。无可动子时返回 null。
 */
export function aiChooseMove(
  pos: Position,
  me: Side,
  opts: RuleOptions,
  level: AiLevel,
  rng: () => number = Math.random,
  avoid?: readonly AvoidMove[],
): Move | null {
  const moves = allLegalMoves(pos, me, opts);
  if (moves.length === 0) return null;

  // 「回到旧局面」的着法集合；全中则整体作废（那种局面该判和，不该硬掰）。
  const avoidSet = buildAvoidSet(avoid, moves.length);

  const ctx: SearchCtx = {
    me,
    opts,
    belief: buildBelief(pos, me),
    attack: computeAttackMap(pos, me, opts, rng),
    tt: newTT(),
    deadline: Date.now() + level.timeMs,
    maxNodes: Math.max(30000, level.timeMs * 2600),
    nodes: 0,
    aborted: false,
    hash: new Int32Array(2),
    avoid: avoidSet,
  };

  // 根候选：按静态分排序后截到 width
  const root: RootMove[] = moves.map((m) => {
    const attacker = pos.type[m.from];
    let sc = 0;
    if (m.capture) {
      sc =
        100000 +
        expectedAttack(pos, m.to, attacker as PieceType, ctx.belief, opts, pos.owner[m.from] as Side) *
          16;
    } else {
      sc = (ATTACK_BASE[m.to] - ATTACK_BASE[m.from]) * 4 + (ctx.attack[m.to] - ctx.attack[m.from]);
    }
    return { from: m.from, to: m.to, score: sc };
  });
  root.sort((a, b) => b.score - a.score);
  // 排序（而非剔除）后再生效：`width` 窄的档位里，被降到队尾的那几条会自然落选，
  // 等于"连考虑都不考虑"；`width` 宽时它们仍在池子里，由搜索里的降权分决定是否真弃。
  applyAvoidBias(root, avoidSet);
  if (root.length > level.width) root.length = level.width;

  let best = root[0];
  let reachedDepth = 0;
  for (let d = 1; d <= level.depth; d++) {
    let got: RootMove | null = null;
    try {
      got = searchRoot(pos, root, d, ctx);
    } catch (e) {
      if (e !== ABORT) throw e;
      break; // 超时/超节点：丢弃这一层的半成品
    }
    if (got) {
      best = got;
      reachedDepth = d;
    }
    if (ctx.aborted || Date.now() > ctx.deadline) break;
  }

  AI_STATS.lastNodes = ctx.nodes;
  AI_STATS.lastDepth = reachedDepth;
  AI_STATS.hitMaxNodes = ctx.aborted;

  return { from: best.from, to: best.to, order: best.score };
}

/**
 * 把引擎的**根候选排序**单独暴露出来 —— 只给观战学习面板用（见 `SPEC.md` §10.2）。
 *
 * 与 `aiChooseMove` 用的是**同一套根打分**（吃子 `100000 + 期望收益×16`，
 * 不吃则看两端攻击位势差 `×4`），但**不做任何搜索**：成本就是一次
 * `allLegalMoves` + 一次位势图，毫秒级。
 *
 * 返回的顺序 = **引擎自己的眼光**（已按 `level.width` 截断）。于是观战面板才能
 * 如实说清"它先看了哪几条、最后挑的是第几条"，而不是我们事后另编一套排序。
 *
 * ⚠️ 这是"启发式排序分"，**不是局面估值**：`100000` 那种量级只对**同一手内**的
 * 候选互相可比，跨手比没有意义。要给人看的分数请用 `evalForSide`。
 */
export function aiRootOrder(
  pos: Position,
  me: Side,
  opts: RuleOptions,
  level: AiLevel,
  rng: () => number = Math.random,
  avoid?: readonly AvoidMove[],
): RootMove[] {
  const moves = allLegalMoves(pos, me, opts);
  const belief = buildBelief(pos, me);
  const attack = computeAttackMap(pos, me, opts, rng);
  const root: RootMove[] = moves.map((m) => {
    const attacker = pos.type[m.from];
    const sc = m.capture
      ? 100000 +
        expectedAttack(pos, m.to, attacker as PieceType, belief, opts, pos.owner[m.from] as Side) *
          16
      : (ATTACK_BASE[m.to] - ATTACK_BASE[m.from]) * 4 + (attack[m.to] - attack[m.from]);
    return { from: m.from, to: m.to, score: sc };
  });
  root.sort((a, b) => b.score - a.score);
  // 与 `aiChooseMove` 用**同一把尺子**：学习面板报的"搜索前顺位"必须和引擎眼里一致，
  // 否则观者会拿一个引擎根本没用过的排序去评判它。
  applyAvoidBias(root, buildAvoidSet(avoid, moves.length));
  if (root.length > level.width) root.length = level.width;
  return root;
}

// ─────────────────────────────────────────────────────────────
// 10. 翻棋
// ─────────────────────────────────────────────────────────────

export type FlipAction =
  | { kind: "flip"; cell: number }
  | { kind: "move"; from: number; to: number };

/**
 * 电脑在「翻棋」里做一次决策。
 *
 * 翻棋把不完全信息推到极致（连颜色都要翻出来才知道），
 * 所以策略是"能白吃就白吃、能安全推进就推进，否则翻子换信息"：
 *   1. 已定色后：先找**净收益为正**的吃子（只吃已翻开的敌子，收益确定）。
 *   2. 再看最好的空走（推进/占行营/上铁路）。
 *   3. 都没有就翻一枚棋（优先翻位置价值高的格子）。
 */
export function aiChooseFlip(
  pos: Position,
  opts: RuleOptions,
  me: Side,
  level: AiLevel,
  rng: () => number = Math.random,
  avoid?: readonly AvoidMove[],
): FlipAction | null {
  const belief = buildBelief(pos, me);
  const attack = computeAttackMap(pos, me, opts, rng);
  const base = evalForMe(pos, me, belief, opts, attack, true);

  let bestMove: { from: number; to: number } | null = null;
  let bestScore = -Infinity;

  const moves = allLegalMoves(pos, me, opts);
  const avoidSet = buildAvoidSet(avoid, moves.length);
  for (const m of moves) {
    const child = clonePosition(pos);
    applyMove(child, m.from, m.to, opts);
    let sc = evalForMe(child, me, belief, opts, attack, true);
    // 与布局同一条规则：会走回旧局面的**静着**降权（吃子必然改变子力，不在规避列表里）。
    if (!m.capture) sc -= avoidSet?.get(packMove(m.from, m.to)) ?? 0;
    if (sc > bestScore) {
      bestScore = sc;
      bestMove = { from: m.from, to: m.to };
    }
  }

  // 翻子候选：在未翻开的子里挑位置价值最高的
  let bestCell = -1;
  let bestCellScore = -Infinity;
  for (let i = 0; i < CELLS; i++) {
    if (pos.type[i] === PieceType.Empty) continue;
    if (pos.revealed[i] === 1) continue;
    let sc = 0;
    const r = rowOf(i);
    sc += sideOfRow(r) === me ? SIDE_ROWS - Math.abs(r - (me === Side.Red ? 5 : 6)) : 2;
    if (isRailCell(i)) sc += 2;
    if (isCamp(i)) sc += 1;
    if (sc > bestCellScore) {
      bestCellScore = sc;
      bestCell = i;
    }
  }

  // 只有当走子明显更好才走（原版没有翻棋专用分支，这里是补的策略层）。
  // 但场上已无暗子时不能"弃权"—— 翻棋没有 pass，有子可走必须走，
  // 否则 AI 返回 null 会被当成"无着法"空转（真实困毙另由会话层判负）。
  const flipBonus = level.id <= 2 ? 40 : 12;
  if (bestMove && (bestCell < 0 || bestScore - base > flipBonus)) {
    return { kind: "move", from: bestMove.from, to: bestMove.to };
  }
  if (bestCell >= 0) return { kind: "flip", cell: bestCell };
  return null;
}

/**
 * 从 `me` 的视角给当前局面打分 —— **就是引擎决策时用的那个估值函数**
 * （原版 `FUN_0006949c` + 攻守位势图），不另起一套。
 *
 * 为什么必须是同一个：AI 观战里要显示"这一手走了多少分"，如果点评用一把尺子、
 * 决策用另一把，学到的东西就是假的（会出现"AI 觉得亏、点评说赚"）。翻棋也一样
 * ——`aiChooseFlip` 内部正是 `evalForMe(..., mine=true)`，这里保持同参同源。
 *
 * ⚠️ 单次调用会重建 `belief` 与攻守图（毫秒级），**只适合每手调一次**，
 *    别放进搜索的热路径里。
 */
export function evalForSide(
  pos: Position,
  me: Side,
  opts: RuleOptions,
  rng: () => number = Math.random,
): number {
  return evalForMe(
    pos,
    me,
    buildBelief(pos, me),
    opts,
    computeAttackMap(pos, me, opts, rng),
    true,
  );
}

/**
 * 对每个合法着法算一个**深度 2** 的 minimax 分 —— 给观战云端 AI 用（方案 B）。
 *
 * 比 `evalForSide`（方案 A 的单步静态分）强一个档次：不仅看"我走完这一步"，
 * 还往下展开**对手最凶的一步应手**，取对手走完、轮到我这边的局面分里的最坏值。
 * 于是云端模型拿到的分数已经隐含了"这步会不会被反吃 / 会不会送大子"。
 *
 * ## 为什么只有 2 层
 *
 * 它是给**大模型**当参考的启发分，不是给引擎当落子依据。模型有基本战术、不犯
 * 低级错误就够了；要做到跟"普通"档（depth 6）正面抗衡得几十层搜索，那已经不是
 * 提示词能救的，应该直接让引擎下。2 层在"避免送子 / 有简单攻防"上够用且快：
 * 候选几十条 × 对手应手约 8 条 × 每次 `evalForSide` 亚毫秒级 ⇒ 观战每手几十毫秒，
 * 相对网络往返完全无感。
 *
 * ## 返回
 *
 * `Map<number, number>`，键 = `from * CELLS + to`（与 `AidScore` 配对一致），
 * 值 = 该着法的深度 2 分（越大越利于 `me`）。只含**走子**候选，翻子没有。
 *
 * ## 对手应手怎么取
 *
 * 用 `aiRootOrder(child, 对手)` 取**对手自己眼光**里最好的前 `oppWidth` 条 ——
 * 对手会挑对他最有利的，也就是对我最坏的；取这些应手后的最小分，就是
 * minimax 的"对手最凶反击"语义。对手无应手（无着可走）时用我走完后的静态分。
 *
 * ## 规避列表
 *
 * `avoid` 给进来时，**会走回旧局面的静着一并降权**（按 `AvoidMove.times` 计，
 * 与 `searchRoot` 完全同一条规则）。这不是可选项：模型是照分数挑着法的，
 * 若这里不降权，"换个行营"这类对称虚高着法会被当成首选推荐出去。
 */
export function evalPly2(
  pos: Position,
  me: Side,
  opts: RuleOptions,
  oppWidth = 8,
  rng: () => number = Math.random,
  avoid?: readonly AvoidMove[],
): Map<number, number> {
  const out = new Map<number, number>();
  const moves = allLegalMoves(pos, me, opts);
  const opp = opposite(me);
  // ★ 规避列表必须**在这里也生效**：本函数是给云端模型当参考分的，而模型会照着
  //   分数挑。若只有引擎搜索那边降权、这里不降，"换个行营"那类对称着法就会以
  //   虚高的分被推荐给模型 —— 用户看到的就是云端在两格之间无限来回。
  //   （实据 2026-09-17：两格皆行营 extra=40/posBase=0/attack=0，分差恒定 +10、
  //     往返净变化 0；不降权时"走回去"永远是第一名。）
  const avoidSet = buildAvoidSet(avoid, moves.length);
  for (const m of moves) {
    const child = clonePosition(pos);
    applyMove(child, m.from, m.to, opts);
    // 对手应手：只取对手眼光里最好的前 oppWidth 条（对手会挑对我最不利的）。
    const oppMoves = aiRootOrder(child, opp, opts, { ...aiLevel(3), width: oppWidth }, rng);
    let worst = Infinity; // 对手视角要最大化 ⇒ 我视角取这些应手后的最小值
    if (oppMoves.length) {
      for (const om of oppMoves) {
        const g = clonePosition(child);
        applyMove(g, om.from, om.to, opts);
        const sc = evalForSide(g, me, opts, rng);
        if (sc < worst) worst = sc;
      }
    } else {
      // 对手无着可走：直接按我走完后的局面估。
      worst = evalForSide(child, me, opts, rng);
    }
    // 与 `searchRoot` 同一条规则：会走回旧局面的**静着**降权（吃子天然不在规避列表里）。
    if (!m.capture) worst -= avoidSet?.get(packMove(m.from, m.to)) ?? 0;
    out.set(m.from * CELLS + m.to, worst);
  }
  return out;
}

// 供调试 / 单测：把还原出来的位置表与原版邻接图抖出来
export const RECOVERED_TABLES = {
  POS_BASE,
  ATTACK_BASE,
  OWN_POS_EXTRA,
  ENEMY_POS_EXTRA,
  OWN_POS_BONUS,
  ENEMY_POS_BONUS,
  NEIGHBORS,
} as const;
