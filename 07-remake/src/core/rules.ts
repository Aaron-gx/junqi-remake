/**
 * 规则引擎 —— 走法生成 / 吃子判定 / 执行。
 *
 * 规则来源（均为逆向所得原文）：
 *   · assets/data/junqi/rulelay.txt   —— 布局（明/暗）模式
 *   · assets/data/junqi/ruleflip.txt  —— 翻棋模式
 *   · assets/data/sg/help.txt         —— 四国补充
 *
 * 关键规则：
 *   · 公路线：任何棋子只能走一步（8 邻接）
 *   · 铁路线：工兵可任意行走（可转弯）；其他棋子只能直走，不能转弯
 *   · 行营：安全岛，其中的棋子不可被吃
 *   · 大本营：**随模式** —— 布局里"进入后不可再移动"，翻棋里可以走出来（见 `baseFrozenOf`）
 *   · 地雷 / 军旗：永久不可移动
 *   · 吃子：司令 > 军长 > … > 工兵；同级同归于尽
 *   · 炸弹：与任何棋子相遇双方消失（含军旗）
 *   · 地雷：小于工兵、大于其他所有棋子
 */

import {
  CELLS,
  COLS,
  FRONTIER_RAIL_COLS,
  RAIL_COLS,
  RAIL_COL_ROW_FROM,
  RAIL_COL_ROW_TO,
  RAIL_ROWS,
  ROWS,
  STEP_NEIGHBORS,
  colOf,
  idx,
  inBounds,
  isBase,
  isCamp,
  isRailAt,
  rowOf,
} from "./board.ts";
import {
  PieceType,
  Side,
  isMovablePiece,
  opposite,
  pieceMeta,
  pieceName,
} from "./pieces.ts";
import { clonePosition, type Position } from "./state.ts";

export enum CombatResult {
  /** 攻方占位，守方消失 */
  AttackerWins = 0,
  /** 守方留下，攻方消失（攻方原地阵亡） */
  DefenderWins = 1,
  /** 双方同时消失 */
  BothDie = 2,
}

export interface MoveTarget {
  readonly to: number;
  readonly capture: boolean;
  readonly rail: boolean;
}

/** 吃军旗规则（原版 `DAT_00153db6` 的两条分支）。 */
export type FlagRule = "weakest" | "engineer";
/** 吃地雷规则（原版 `DAT_00153db4._1_1_` 的两条分支）。 */
export type MineRule = "engineer" | "weakest";

export interface RuleOptions {
  /** 暗棋模式：未翻开的棋子不可被吃、不可移动 */
  hidden: boolean;
  /**
   * 翻棋模式。影响两件事：
   *   1) 决定 `flagRule` 的缺省值（翻棋=只有工兵，布局=本方现存最小棋子）；
   *   2) 军旗还必须等对方地雷全部挖完 —— 这条**两种模式都成立**
   *      （原版 `FUN_00068b38` 的两个分支里都查了，见 `minesRemaining`）。
   */
  flipMode: boolean;
  /** 吃军旗：`weakest` 本方现存最小棋子；`engineer` 只有工兵。缺省随模式。 */
  flagRule?: FlagRule;
  /** 吃地雷：`engineer` 只有工兵（默认）；`weakest` 本方现存最小棋子。 */
  mineRule?: MineRule;
  /**
   * 炸弹能否炸军旗。
   *
   * 原版引擎**不能**：`FUN_00068b38` 里「炸弹 → 双方消失」的判定写在
   * `if (守方 != 军旗)` 之内，军旗一律走 `LAB_00068baa` 的扛旗分支，
   * 而炸弹(10) 永远不等于所需兵种 → 不成着法。三条生成路径
   * (`FUN_0006919c/692f0/693f0`) 都共用它。
   * 但 `rulelay.txt` 明文写「炸弹与任何棋子相遇时，双方都消失，**包括军旗**」。
   * 默认 `false` = 跟引擎走；置 `true` 则跟规则文本走。
   */
  bombMayStrikeFlag?: boolean;
  /**
   * 大本营是否算"安全岛"——对应规则设置里的 **`CmdSafe`** 开关
   * （UI 里那几个开关是 `Draw` / `Command`(`CmdSafe`) / `BingLei` / `BingQi`）。
   *
   * 机制已定位：`FUN_00068b38` 用的安全格掩码其实是**位势图**的一份拷贝
   * （`FUN_0006949c` 里 `memcpy(&DAT_00153810, ...)`），而
   * ```
   * if (DAT_00153db0._3_1_ == 0) {        // ← 这个字节就是 CmdSafe
   *   DAT_00153814 = 0; DAT_0015381c = 0; DAT_001538f0 = 0; DAT_001538f8 = 0;      // 位势图的大本营项
   *   DAT_00153e1c = 0; DAT_00153e24 = 0; DAT_00153ef8 = 0; DAT_00153f00 = 0;      // 另一套同理
   * }
   * ```
   * 清零的 8 个下标 = 2 套表 × 大本营 4 格（+0x04/+0x0c/+0xe0/+0xe8 ↔ 格 1/3/56/58），
   * 一毫不差。所以 `CmdSafe=0` ⇒ 安全格只剩行营。
   *
   * 两模式默认不同，也正是两份规则文本的分歧点：
   *   · `rulelay.txt`（布局）「**行营**是个安全岛……进入任何大本营的棋子不能再移动」→ 只算行营
   *   · `ruleflip.txt`（翻棋）「**行营、大本营**是个安全岛……大本营的地雷、军旗可以吃」→ 都算
   * 缺省即按此跟随 `flipMode`；显式给出则覆盖。
   */
  cmdSafe?: boolean;
}

export const DEFAULT_OPTIONS: RuleOptions = {
  hidden: false,
  flipMode: false,
};

/**
 * 取生效的"大本营安全岛"开关（原版 `DAT_00153db0._3_1_`，即规则设置的 `CmdSafe`）。
 * 缺省跟随模式：翻棋 = 算，布局 = 不算（见 `RuleOptions.cmdSafe`）。
 */
export function cmdSafeOf(opts: RuleOptions): boolean {
  return opts.cmdSafe ?? opts.flipMode;
}

/**
 * 取生效的吃军旗规则。
 *
 * `FUN_00068b38` 的 `LAB_00068baa`：
 * ```
 * if (DAT_00153db6 == 0) {               // 最小棋子扛旗
 *   if (param_3 != FUN_000680b4(...)) return 0;   // 不是本方现存最小 → 非法
 * } else {                                // 只有工兵
 *   if (param_3 != 9) return 0;
 * }
 * if (dAT_00153774[0x23 - param_4] != 0) return 0;  // 对方地雷没挖完 → 非法
 * ```
 * 两份规则文本正是分道扬镳的：`rulelay.txt`「任何棋子都能扛军旗」、
 * `ruleflip.txt`「地雷和军旗只有工兵能吃」→ 布局走 0 分支、翻棋走非 0 分支。
 */
export function flagRuleOf(opts: RuleOptions): FlagRule {
  return opts.flagRule ?? (opts.flipMode ? "engineer" : "weakest");
}

/** 取生效的吃地雷规则（原版 `LAB_00068c30`）。两种模式默认都是"只有工兵"。 */
export function mineRuleOf(opts: RuleOptions): MineRule {
  return opts.mineRule ?? "engineer";
}

/**
 * **大本营里的棋子能不能走出来。**
 *
 * 原版把「走法生成」做成了**两套子系统**，由规则结构体偏移 +1 的字节
 * `DAT_00153db0._1_1_` 二选一（见 `FUN_0006919c`）：
 *
 * ```
 * if (DAT_00153db0._1_1_ == 0) { …内联遍历 60 格… }   // Path A
 * else                         { return FUN_0006a098(); }  // Path B
 * ```
 *
 *   · **Path A**（`_1_1_ == 0`）：`FUN_00068cbc` / `FUN_00068d40` / `FUN_0006907c`，
 *     门闸只有 `*(cell+8)==0`，**没有任何大本营判定** → 大本营里的子照走。
 *     它还会给"盖着的子"多生成一条 `from == to` 的**翻开**着法 ⇒ 这是**翻棋**。
 *   · **Path B**（`_1_1_ != 0`）：`FUN_0006a098` 的门闸是静态表
 *     `(&DAT_00133cb4)[i] == 0`，而该表在 `{1,3,56,58}`（= 4 个大本营格）上**恒为 1**
 *     ⇒ **大本营格被整个跳过**，里面的子一步都出不来。
 *
 * 谁翻棋、谁布局 —— 由新局入口钉死（实测反编译，不是推测）：
 *   · `Msg_Start_2`（`0x30a64`）：`*(char*)(game+0x4d) = 0`，紧接着
 *     `FUN_00068538(game+0x54)` —— 那是**翻棋洗牌**：把红 1..12 / 蓝 13..24 共 50 枚
 *     混合铺满 50 个非行营格（`DAT_00133e94` 那 10 个行营格跳过不铺）。
 *   · `Msg_Start_5`（`0x30b54`）：`*(char*)(game+0x4d) = 1`，紧接着
 *     `FUN_00069a74(mode, …, game+0x54)` —— 那是**读 `.lay` 布阵**（`Res_n02d_lay`，
 *     两半各 30 格）。
 *   · `FUN_0002f684` 把这个字节原样搬进规则结构体：`rule[1] = game+0x4d`；
 *     `Msg_Start_3`（`0x38ce8`）更直接：`if (*(char*)(game+0x52) == '\0') { FUN_00068538(...) }`
 *     —— **规则字节 1 == 0 就是翻棋**。
 *
 * ⇒ **布局（`flipMode=false`）= 大本营冻结；翻棋（`flipMode=true`）= 不冻结。**
 * 这与两份规则文本完全吻合：`rulelay.txt`「进入任何大本营的棋子不能再移动」只写在
 * 布局那份里，`ruleflip.txt` 通篇没有这一条。
 *
 * ⚠️ 2026-09-14 玩家实报"翻棋里第一排/最后一排和大本营的棋子走不动"—— 旧实现把这条
 * 冻结**无条件**写死在 `canActivate` 里，翻棋下多冻了 4 个大本营，与原版不符。
 */
export function baseFrozenOf(opts: RuleOptions): boolean {
  return !opts.flipMode;
}

// ─────────────────────────────────────────────────────────────
// 铁路邻接（工兵网络行走用）
// ─────────────────────────────────────────────────────────────

/**
 * 铁路邻接图（工兵网络行走用）。
 *
 * 结构（实测，详见 board.ts 注释）：
 *   · 横向铁路：行 1/5/6/10，左右相邻
 *   · 纵向铁路：列 0/4，行 1–10，上下相邻
 *   · 交界跨越：列 0/2/4，行 5↔6 —— 列 2 仅此一段是铁路
 *
 * 注意：铁路**不能转弯**（普通棋子），所以铁路邻接图只表达
 * "铁路上的两格直接连着"，转弯由 slideRail 的方向约束负责；
 * 工兵则直接在这张图上 BFS，从而实现任意转弯。
 */
const RAIL_NEIGHBORS: readonly (readonly number[])[] = (() => {
  const out: number[][] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = idx(r, c);
      const list: number[] = [];
      if (RAIL_ROWS.indexOf(r) >= 0) {
        if (c > 0) list.push(idx(r, c - 1));
        if (c < COLS - 1) list.push(idx(r, c + 1));
      }
      if (
        RAIL_COLS.indexOf(c) >= 0 &&
        r >= RAIL_COL_ROW_FROM &&
        r <= RAIL_COL_ROW_TO
      ) {
        if (r > RAIL_COL_ROW_FROM) list.push(idx(r - 1, c));
        if (r < RAIL_COL_ROW_TO) list.push(idx(r + 1, c));
      }
      // 两方交界的纵向跨越段（列 0/2/4）
      if ((r === 5 || r === 6) && FRONTIER_RAIL_COLS.indexOf(c) >= 0) {
        const j = idx(r === 5 ? 6 : 5, c);
        if (list.indexOf(j) < 0) list.push(j);
      }
      out[i] = list;
    }
  }
  return out;
})();

export function railNeighborsOf(i: number): readonly number[] {
  return RAIL_NEIGHBORS[i];
}

/** 该格是否落在铁路线上。 */
export function isOnRail(i: number): boolean {
  return isRailAt(rowOf(i), colOf(i));
}

// ─────────────────────────────────────────────────────────────
// 吃子判定
// ─────────────────────────────────────────────────────────────

export type CombatOutcome = CombatResult | "illegal";

/**
 * 某一方还留在棋盘上的地雷数。
 *
 * 原版 `FUN_00068b38` 的军旗分支会查 `count[35 - 方]`，而那张计数表正是
 * 按"某方剩余地雷数"增减的（见 `FUN_00067cf0` 里 `0xb` 分支对 `0x88/0x8c` 的自减）
 * → **扛旗的前提是对方地雷一颗不剩**，与 `ruleflip.txt`
 * 「工兵挖完地雷后才能扛军旗」完全一致。这里直接从棋盘数，避免维护易漏的计数器。
 */
export function minesRemaining(pos: Position, owner: Side): number {
  let n = 0;
  for (let i = 0; i < CELLS; i++) {
    if (pos.owner[i] === owner && pos.type[i] === PieceType.Landmine) n++;
  }
  return n;
}

/**
 * 本方**现存最弱的可动棋子**的兵种 —— 原版 `FUN_000680b4` 的对译。
 *
 * 原版从工兵(9) 往司令(1) 逐个查"某兵种还有没有存活的"，取第一个命中的，
 * 所以结果就是**兵种编号最大（rank 最小）的那个**。
 * ★ 它只扫 1..9（司令…工兵）：炸弹(10)/地雷(11)/军旗(12) **不参与**，
 *   所以"最弱"是"最弱的那档能走的子"，不含炸弹。
 * 全部被吃光时返回 null。
 */
export function weakestSurviving(pos: Position, side: Side): PieceType | null {
  let best: PieceType | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (let i = 0; i < CELLS; i++) {
    if (pos.owner[i] !== side) continue;
    const t = pos.type[i] as PieceType;
    const m = pieceMeta(t);
    if (!m.movable || m.rank <= 0) continue; // 排除 炸弹(rank 0)/地雷/军旗/空位
    if (m.rank < bestRank) {
      bestRank = m.rank;
      best = t;
    }
  }
  return best;
}

/** 该兵种是否具备"扛旗资格"（对应 `flagRuleOf`）。 */
export function canCarryFlag(
  pos: Position,
  side: Side,
  attacker: PieceType,
  opts: RuleOptions,
): boolean {
  if (flagRuleOf(opts) === "engineer") return attacker === PieceType.Engineer;
  const w = weakestSurviving(pos, side);
  return w !== null && attacker === w;
}

/** 该兵种是否具备"挖雷资格"（对应 `mineRuleOf`）。 */
export function canClearMine(
  pos: Position,
  side: Side,
  attacker: PieceType,
  opts: RuleOptions,
): boolean {
  if (mineRuleOf(opts) === "engineer") return attacker === PieceType.Engineer;
  const w = weakestSurviving(pos, side);
  return w !== null && attacker === w;
}

/**
 * **诊断：这枚子现在为什么扛不了对方的军旗**（只为 UI 提示服务，不参与规则判定）。
 *
 * 返回 `null` = 要么本来就扛得动、要么压根够不着（那就不必解释）；
 * 返回字符串 = 中文原因，可直接丢进战报 / toast。
 *
 * 起因：2026-09-14 玩家问「为什么地雷吃完了，不能吃军旗？」—— 旧版点了敌旗
 * `click()` 直接 `return false`，界面一声不吭，玩家只能干瞪眼。规则本身是对的
 * （见 `canLandOn` 的军旗分支），但**两个条件都不显示在盘面上**，所以必须解释。
 *
 * 判定顺序刻意与 `resolveCombat` / 原版 `LAB_00068baa` 一致 —— **先兵种资格，再地雷数**：
 * ```
 * if (DAT_00153db6 == 0) { if (param_3 != 本方最弱子) return 0; if (敌雷 != 0) return 0; }
 * else                   { if (param_3 != 9 工兵)     return 0; if (敌雷 != 0) return 0; }
 * ```
 *
 * ★「够不够得着」用**替身盘面**判断：把敌旗临时换成一枚工兵（全场最弱，任何棋子都能吃），
 *   再跑一次 `legalTargets`。敌旗那道门消失后还能落到该格 ⇒ 纯属"权限不够"，值得解释；
 *   连替身都落不下去 ⇒ 是距离/路线问题，不该拿规则去误导玩家。
 */
export function flagCaptureHint(
  pos: Position,
  from: number,
  mover: Side,
  opts: RuleOptions,
): string | null {
  if (!canActivate(pos, from, mover, opts)) return null;
  const attacker = pos.type[from] as PieceType;

  let flagCell = -1;
  for (let i = 0; i < CELLS; i++) {
    if (pos.type[i] === PieceType.Flag && pos.owner[i] !== mover) {
      flagCell = i;
      break;
    }
  }
  if (flagCell < 0) return null;
  // 已经能扛 → 不需要解释
  if (legalTargets(pos, from, mover, opts).some((t) => t.to === flagCell)) return null;

  const probe = clonePosition(pos);
  probe.type[flagCell] = PieceType.Engineer; // 替身：必能被吃
  if (!legalTargets(probe, from, mover, opts).some((t) => t.to === flagCell)) {
    return null;
  }

  const mine = pieceName(attacker);
  if (!canCarryFlag(pos, mover, attacker, opts)) {
    if (flagRuleOf(opts) === "engineer") {
      return `扛不了军旗：只有工兵能扛，你这枚是${mine}`;
    }
    const w = weakestSurviving(pos, mover);
    return `扛不了军旗：只有你方现存最弱的子能扛（${w === null ? "已无子可扛" : pieceName(w)}），你这枚是${mine}`;
  }
  const enemyMines = minesRemaining(pos, pos.owner[flagCell] as Side);
  if (enemyMines > 0) {
    return `扛不了军旗：对方还有 ${enemyMines} 颗地雷没挖完`;
  }
  return null;
}

export function resolveCombat(
  attacker: PieceType,
  defender: PieceType,
  opts: RuleOptions,
  /** 对方**尚存**的地雷数（0 = 已挖完，才能扛旗） */
  enemyMinesLeft = 0,
  /** 攻击方是否具备扛旗资格（默认 true，便于按兵种做单点测试） */
  canCarry = true,
): CombatOutcome {
  // ── 军旗（原版 `LAB_00068baa`）★ 必须排在炸弹判定**之前** ──
  // 原版把"炸弹 → 双方消失"写在 `if (守方 != 军旗)` 里面，军旗一律走扛旗分支，
  // 于是"炸弹炸军旗"在引擎里压根不成为着法（除非显式打开 bombMayStrikeFlag）。
  if (defender === PieceType.Flag) {
    if (attacker === PieceType.Bomb && opts.bombMayStrikeFlag) return CombatResult.BothDie;
    if (enemyMinesLeft > 0) return "illegal"; // 扛旗前置：对方地雷必须已挖完
    if (!canCarry) return "illegal";
    return CombatResult.AttackerWins;
  }

  // 炸弹：与任何棋子相遇双方消失（地雷、军旗见上两条特例）
  if (attacker === PieceType.Bomb || defender === PieceType.Bomb) {
    return CombatResult.BothDie;
  }

  // 地雷：小于工兵，大于其他所有棋子
  if (defender === PieceType.Landmine) {
    return attacker === PieceType.Engineer
      ? CombatResult.AttackerWins
      : CombatResult.DefenderWins;
  }

  const ra = pieceMeta(attacker).rank;
  const rd = pieceMeta(defender).rank;
  if (ra > rd) return CombatResult.AttackerWins;
  if (ra < rd) return CombatResult.DefenderWins;
  return CombatResult.BothDie;
}

// ─────────────────────────────────────────────────────────────
// 走法生成
// ─────────────────────────────────────────────────────────────

/** 该格棋子能否被激活（行动）。 */
export function canActivate(
  pos: Position,
  from: number,
  mover: Side,
  opts: RuleOptions,
): boolean {
  const t = pos.type[from] as PieceType;
  if (t === PieceType.Empty) return false;
  if (pos.owner[from] !== mover) return false;
  if (!isMovablePiece(t)) return false;
  // 「进入大本营后不可再移动」**只在布局模式成立** —— 原版靠 Path B
  // （`FUN_0006a098` 用 `DAT_00133cb4` 跳过 4 个大本营格）实现；翻棋走 Path A，
  // 生成器里根本没有这道门，大本营的子照走。详见 `baseFrozenOf` 的长注释。
  if (isBase(from) && baseFrozenOf(opts)) return false;
  // ★「先翻开才能动」是**翻棋**专属规则（SPEC §6.2：「只能控制自己颜色的**已翻开**棋子」）。
  //   布局-暗棋里玩家摆的就是自己的子、本来就看得见（渲染层 `faceUp` 也按 `viewer` 亮本方），
  //   没有"翻开"这一步。旧版漏了 `flipMode` 判定 → 暗棋下**任何子都过不了这道门**，
  //   人类点谁都是"无处可走"、AI 也返回 null ⇒ 布局暗棋整局走不动。
  if (opts.hidden && opts.flipMode && pos.revealed[from] !== 1) return false;
  return true;
}

/**
 * 该格能否作为落点（含吃子）—— 对齐原版 `FUN_00068b38`。
 *
 * ★ 原版有两条**不是"吃子结果"、而是"压根不列为落点"**的规则（每条着法生成路径都走它）：
 *   1) 地雷：只有工兵能主动碰（炸弹另有"双方消失"规则，见下）；
 *   2) 不能撞比自己强的子 —— 目标比攻击方强时直接不是合法落点，连"送死"都不允许。
 *      同级可以（同归于尽），更弱正常吃。
 * 注意兵种编号/等级是"数字越大越强"（司令 9 … 工兵 1）。
 *
 * ★ 安全岛（原版 `DAT_00153810` 那张按格标记的表）：落在安全格里的棋子**不可被吃**，
 *   但**地雷与军旗例外**（"大本营的地雷、军旗可以吃"——`ruleflip.txt` 明文）。
 *   范围由 **`CmdSafe`** 开关决定（原版 `DAT_00153db0._3_1_`，见 `RuleOptions.cmdSafe`）：
 *   关 = 只有行营；开 = 行营 ∪ 大本营。**缺省跟随模式**——
 *   `rulelay.txt`「行营是个安全岛」 vs `ruleflip.txt`「行营、大本营是个安全岛」。
 */
function canLandOn(
  pos: Position,
  to: number,
  mover: Side,
  opts: RuleOptions,
  attacker: PieceType,
): boolean {
  const t = pos.type[to] as PieceType;
  if (t === PieceType.Empty) return true;
  if (pos.owner[to] === mover) return false; // 己方阻挡

  // ★ 安全岛（原版 `DAT_00153810` 那张按格标记的表）：落在安全格里的棋子**不可被吃**。
  //   行营永远算；大本营是否算由 `CmdSafe`（原版 `DAT_00153db0._3_1_`）决定，
  //   缺省跟随模式 —— 两份规则文本正是这么分的：
  //     · 布局（rulelay）：「行营是个安全岛」—— 只算行营；大本营只"进入后不可再移动"。
  //     · 翻棋（ruleflip）：「行营、大本营是个安全岛」—— 两者都算，所以才需要
  //       「大本营的地雷、军旗可以吃」这条例外。
  //   地雷/军旗例外在两种模式下都成立（原版跳 LAB_00068c30 / LAB_00068baa）。
  const safety = isCamp(to) || (cmdSafeOf(opts) && isBase(to));
  if (safety && t !== PieceType.Landmine && t !== PieceType.Flag) {
    return false;
  }

  // 翻棋：未翻开的子不可吃（必须先翻开才能打）—— 同 `canActivate`，**仅限 `flipMode`**。
  // 布局-暗棋下**可以**直接攻打对方暗子，这正是暗棋的核心：打了才知道对面是什么
  //（打不动 / 同归于尽都靠 `resolveCombat` 结算），若一刀切禁掉则暗棋永远无法吃子。
  if (opts.hidden && opts.flipMode && pos.revealed[to] !== 1) return false;

  // ── 军旗（原版 `LAB_00068baa`）★ 必须排在炸弹判定之前 ──
  // ⚠️ 门槛必须与 `resolveCombat` 完全一致，否则军旗会变成"可选但点了没反应"的落点。
  if (t === PieceType.Flag) {
    if (attacker === PieceType.Bomb && opts.bombMayStrikeFlag) return true;
    if (minesRemaining(pos, pos.owner[to] as Side) > 0) return false;
    return canCarryFlag(pos, mover, attacker, opts);
  }

  // 炸弹：与任何子相遇都成立（含地雷）
  if (attacker === PieceType.Bomb || t === PieceType.Bomb) return true;

  // 地雷：只有具备挖雷资格的棋子能主动碰（原版 `LAB_00068c30`）
  if (t === PieceType.Landmine) return canClearMine(pos, mover, attacker, opts);

  // 原版：目标更强 → 不作为落点
  if (pieceMeta(t).rank > pieceMeta(attacker).rank) return false;
  return true;
}

/**
 * 非工兵的铁路直行滑行 —— 对齐原版 `FUN_00068d40`。
 *
 * 纵向滑行由原版的「铁路标志位」表决定；在两条前沿行之间只有列 0/2/4 相通，
 * 其中**列 2 那条是"跨方"唯一通道**（原版特例格 26/28/31/33 恰好把列 1/3 切断）。
 */
function slideRail(
  pos: Position,
  from: number,
  dr: number,
  dc: number,
  mover: Side,
  opts: RuleOptions,
): number[] {
  const r0 = rowOf(from);
  const c0 = colOf(from);

  // 纵向：列 0/4 的 1~10 行；外加列 2 在前沿行之间的跨越段
  const frontierCross = c0 === 2 && (r0 === 5 || r0 === 6);
  if (dr === 0) {
    if (RAIL_ROWS.indexOf(r0) < 0) return [];
  } else {
    const inRailCol =
      RAIL_COLS.indexOf(c0) >= 0 && r0 >= RAIL_COL_ROW_FROM && r0 <= RAIL_COL_ROW_TO;
    if (!inRailCol && !frontierCross) return [];
  }

  const out: number[] = [];
  const atk = pos.type[from] as PieceType;
  let r = r0;
  let c = c0;
  for (;;) {
    r += dr;
    c += dc;
    if (!inBounds(r, c)) break;
    if (dr !== 0 && (r < RAIL_COL_ROW_FROM || r > RAIL_COL_ROW_TO)) break;
    // 列 2 的跨越段只在纵向成立，且只能落到对面那条前沿行
    if (dr !== 0 && frontierCross && r !== (r0 === 5 ? 6 : 5)) break;

    const j = idx(r, c);
    if (pos.type[j] === PieceType.Empty) {
      out.push(j);
      if (dr !== 0 && frontierCross) break;
      continue;
    }
    if (canLandOn(pos, j, mover, opts, atk)) out.push(j);
    break; // 遇子即停
  }
  return out;
}

/** 工兵铁路网可达点（可转弯）。 */
function engineerRailReach(
  pos: Position,
  from: number,
  mover: Side,
  opts: RuleOptions,
): number[] {
  const visited = new Set<number>([from]);
  const result = new Set<number>();
  const queue: number[] = [from];
  const atk = pos.type[from] as PieceType;

  while (queue.length > 0) {
    const cur = queue.shift() as number;
    for (const nxt of RAIL_NEIGHBORS[cur]) {
      if (visited.has(nxt)) continue;
      visited.add(nxt);
      if (pos.type[nxt] === PieceType.Empty) {
        result.add(nxt);
        queue.push(nxt);
      } else if (canLandOn(pos, nxt, mover, opts, atk)) {
        result.add(nxt); // 吃子后不再延伸
      }
    }
  }
  return [...result];
}

export function legalTargets(
  pos: Position,
  from: number,
  mover: Side,
  opts: RuleOptions = DEFAULT_OPTIONS,
): MoveTarget[] {
  if (!canActivate(pos, from, mover, opts)) return [];

  const type = pos.type[from] as PieceType;
  const seen = new Map<number, MoveTarget>();

  // 1) 公路：一步。用原版**步进表**（`0x123350`），不是 8 邻域 ——
  //    铁路上的相邻格归"滑行"，斜向只存在于行营进出。
  for (const j of STEP_NEIGHBORS[from]) {
    if (!canLandOn(pos, j, mover, opts, type)) continue;
    seen.set(j, { to: j, capture: pos.type[j] !== PieceType.Empty, rail: false });
  }

  // 2) 铁路
  if (isOnRail(from)) {
    if (type === PieceType.Engineer) {
      for (const to of engineerRailReach(pos, from, mover, opts)) {
        if (!seen.has(to)) {
          seen.set(to, { to, capture: pos.type[to] !== PieceType.Empty, rail: true });
        }
      }
    } else {
      const dirs: readonly (readonly [number, number])[] = [
        [0, -1],
        [0, 1],
        [-1, 0],
        [1, 0],
      ];
      for (const [dr, dc] of dirs) {
        for (const to of slideRail(pos, from, dr, dc, mover, opts)) {
          if (!seen.has(to)) {
            seen.set(to, { to, capture: pos.type[to] !== PieceType.Empty, rail: true });
          }
        }
      }
    }
  }

  return [...seen.values()];
}

/** 某方是否存在任何合法着法（「无棋可走判负」用）。 */
export function hasAnyMove(
  pos: Position,
  side: Side,
  opts: RuleOptions = DEFAULT_OPTIONS,
): boolean {
  for (let i = 0; i < CELLS; i++) {
    if (pos.owner[i] !== side) continue;
    if (legalTargets(pos, i, side, opts).length > 0) return true;
  }
  return false;
}

/** 列出某方全部着法。 */
export function allLegalMoves(
  pos: Position,
  mover: Side,
  opts: RuleOptions = DEFAULT_OPTIONS,
): { from: number; to: number; capture: boolean; rail: boolean }[] {
  const out: { from: number; to: number; capture: boolean; rail: boolean }[] = [];
  for (let i = 0; i < CELLS; i++) {
    if (pos.owner[i] !== mover) continue;
    for (const t of legalTargets(pos, i, mover, opts)) {
      out.push({ from: i, to: t.to, capture: t.capture, rail: t.rail });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 执行着法
// ─────────────────────────────────────────────────────────────

export interface ApplyResult {
  readonly combat: CombatResult | "void";
  readonly captured: PieceType;
  readonly attacker: PieceType;
  readonly flagTaken: boolean;
  readonly mineCleared: boolean;
}

export function applyMove(
  pos: Position,
  from: number,
  to: number,
  opts: RuleOptions = DEFAULT_OPTIONS,
): ApplyResult {
  const mover = pos.owner[from] as Side;
  const attacker = pos.type[from] as PieceType;
  const defender = pos.type[to] as PieceType;

  const vacate = (i: number) => {
    pos.type[i] = PieceType.Empty;
    pos.owner[i] = Side.None;
    pos.revealed[i] = 0;
  };
  const occupy = (i: number, t: PieceType, s: Side, rev: number) => {
    pos.type[i] = t;
    pos.owner[i] = s;
    pos.revealed[i] = rev;
  };

  if (defender === PieceType.Empty) {
    const rev = pos.revealed[from];
    vacate(from);
    occupy(to, attacker, mover, rev);
    return {
      combat: "void",
      captured: PieceType.Empty,
      attacker,
      flagTaken: false,
      mineCleared: false,
    };
  }

  // 扛旗门槛：对方地雷是否已挖完 + 本方是否有扛旗资格（原版 `LAB_00068baa` 两个条件）
  const enemyMinesLeft =
    defender === PieceType.Flag ? minesRemaining(pos, opposite(mover)) : 0;
  const canCarry =
    defender === PieceType.Flag ? canCarryFlag(pos, mover, attacker, opts) : true;
  const result = resolveCombat(attacker, defender, opts, enemyMinesLeft, canCarry);

  if (result === "illegal") {
    return {
      combat: "void",
      captured: PieceType.Empty,
      attacker,
      flagTaken: false,
      mineCleared: false,
    };
  }

  const flagTaken = defender === PieceType.Flag && result === CombatResult.AttackerWins;
  const mineCleared =
    defender === PieceType.Landmine && result === CombatResult.AttackerWins;

  // 亮明：暗棋下只要交火，双方身份就公开（相当于军棋"裁判"当众宣布 ——
  // 否则热座对局里打完一架双方又都忘了对方是什么子，暗棋就失去意义；
  // 暗棋 AI 的威胁位势图也只统计"已翻开"的敌方大子，靠的正是这里）。
  // 只有**留场的那枚**需要写 `revealed=1`；阵亡的子已离场，身份由战报文本交代。
  // 翻棋下走到这里的两枚子必然都已 `revealed=1`（`canActivate`/`canLandOn` 的门槛），
  // 所以这两行对翻棋是 no-op，不会改动翻棋行为。
  if (result === CombatResult.AttackerWins) {
    const rev = pos.revealed[from];
    vacate(from);
    occupy(to, attacker, mover, rev);
    if (opts.hidden) pos.revealed[to] = 1;
  } else if (result === CombatResult.DefenderWins) {
    vacate(from);
    if (opts.hidden) pos.revealed[to] = 1;
  } else {
    vacate(from);
    vacate(to);
  }

  return { combat: result, captured: defender, attacker, flagTaken, mineCleared };
}
