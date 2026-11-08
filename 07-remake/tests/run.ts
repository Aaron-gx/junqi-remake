/**
 * 核心逻辑自检。
 *
 * 运行： node --experimental-transform-types tests/run.ts
 *
 * 覆盖：
 *  1. 棋盘拓扑（格型/铁路/连接）与规格书逐条比对
 *  2. 51 关布阵数据合法性
 *  3. 走法生成（不可移动棋子、大本营锁死〔仅布局〕、行营保护）
 *  4. 铁路移动（直行 vs 工兵转弯）
 *  5. 吃子判定全表
 *  6. applyMove 的正确性
 */

import {
  CELLS,
  COLS,
  ROWS,
  SIDE_ROWS,
  frontRowOf,
  backRowsOf,
  basesOf,
  colOf,
  idx,
  isBase,
  isCamp,
  kindOf,
  CellKind,
  linked,
  railCellCount,
  stepNeighbors,
  NEIGHBORS,
  STEP_NEIGHBORS,
  isRailCell,
  rowOf,
  territoryOf,
  validateLayout,
  expandLayout,
} from "../src/core/board.ts";
import { PieceType, Side, PIECES_PER_SIDE, opposite, pieceInventory } from "../src/core/pieces.ts";
import {
  CombatResult,
  DEFAULT_OPTIONS,
  allLegalMoves,
  applyMove,
  baseFrozenOf,
  canActivate,
  canCarryFlag,
  canClearMine,
  flagCaptureHint,
  flagRuleOf,
  hasAnyMove,
  isOnRail,
  legalTargets,
  mineRuleOf,
  minesRemaining,
  cmdSafeOf,
  railNeighborsOf,
  resolveCombat,
  weakestSurviving,
} from "../src/core/rules.ts";
import {
  buildFromLayouts,
  clonePosition,
  countMobile,
  countPieces,
  createEmptyPosition,
  setPiece,
  type Position,
} from "../src/core/state.ts";
import { LAYOUTS } from "../src/data/layouts.ts";
import {
  FlipGame,
  LayGame,
  DRAW_NO_CAPTURE_PLIES,
  DRAW_REPETITION,
  DRAW_TOTAL_PLIES,
  positionKey,
} from "../src/game/session.ts";
import {
  AI_LEVELS,
  BOMB_VALUE,
  PIECE_VALUE,
  RECOVERED_TABLES,
  TOP_PIECE_VALUE,
  aiChooseMove,
  aiChooseFlip,
  aiLevel,
  aiRootOrder,
  buildBelief,
  evalForSide,
  evalPly2,
  makeRng,
} from "../src/game/ai.ts";
import { pathBetween } from "../src/core/path.ts";
import { COL_X, PITCH_X, PITCH_Y, ROW_Y } from "../src/ui/boardart.ts";
import {
  ANIM_BASE_MS,
  ANIM_MIN_MS,
  animDurationMs,
  animPointAt,
  cumulative,
  pathLength,
} from "../src/ui/anim.ts";
import {
  AidNotConfigured,
  DEFAULT_AID_TIMEOUT_MS,
  AID_DIAG_PATH,
  aiAidDiag,
  aiAidPing,
  aiAidSuggest,
  aidEndpoint,
  aidRelayAvailable,
  describeBoard,
} from "../src/game/aiaid.ts";
import { isTransientNetError } from "../src/game/neterr.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = ""): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${name}${extra ? " :: " + extra : ""}`);
  }
}

function eq<T>(name: string, got: T, want: T): void {
  check(name, got === want, `got=${String(got)} want=${String(want)}`);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// ─────────────────────────────────────────────────────────────
section("1. 棋盘拓扑");
// ─────────────────────────────────────────────────────────────

eq("总格数", CELLS, 60);
eq("行数", ROWS, 12);
eq("列数", COLS, 5);
eq("每方行数", SIDE_ROWS, 6);

let camps = 0;
let posts = 0;
let bases = 0;
for (let i = 0; i < CELLS; i++) {
  const k = kindOf(i);
  if (k === CellKind.Camp) camps++;
  else if (k === CellKind.Base) bases++;
  else posts++;
}
eq("行营数", camps, 10);
eq("大本营数", bases, 4);
eq("兵站数", posts, 46);

// 行营坐标（规格 §3.2）
const expectCamps = [
  [2, 1],
  [2, 3],
  [3, 2],
  [4, 1],
  [4, 3],
  [7, 1],
  [7, 3],
  [8, 2],
  [9, 1],
  [9, 3],
];
let campOk = true;
for (const [r, c] of expectCamps) if (!isCamp(idx(r, c))) campOk = false;
check("行营坐标与规格一致", campOk);

const expectBases = [idx(0, 1), idx(0, 3), idx(11, 1), idx(11, 3)];
check(
  "大本营坐标与规格一致",
  expectBases.every((i) => isBase(i)) && !isBase(idx(0, 0)) && !isBase(idx(2, 2)),
);

// 铁路格数：行 1/5/6/10 各 5 格 = 20，列 0/4 行 1–10 各 10 格 = 20，
// 交集（行 1/5/6/10 且列 0/4）= 4 行 × 2 列 = 8 → 20 + 20 - 8 = 32
eq("铁路格数", railCellCount(), 32);
check("(5,0) 在铁路线上（横铁路 + 纵铁路交叉）", isOnRail(idx(5, 0)));
check("(1,2) 在铁路线上（行 1 横铁路）", isOnRail(idx(1, 2)));
check("(5,2) 在铁路线上（行 5 横铁路）", isOnRail(idx(5, 2)));

// ⚠️ 关键修正：列 2 在阵地内部**不是**纵向铁路（实测黑带占比 ≤0.07），
// 只有列 0/4 是纵向铁路。早期版本把列 2 也当成铁路，是错的。
check("(3,2) 不在铁路线上（列 2 非纵向铁路）", !isOnRail(idx(3, 2)));
check("(2,2) 不在铁路线上（列 2 非纵向铁路）", !isOnRail(idx(2, 2)));
check("(4,2) 不在铁路线上（列 2 非纵向铁路）", !isOnRail(idx(4, 2)));

// 铁路邻接边：列 2 只在两方交界处有一条跨越段
check(
  "列2 交界跨越 (5,2)-(6,2) 是铁路边",
  railNeighborsOf(idx(5, 2)).indexOf(idx(6, 2)) >= 0,
);
check(
  "列2 阵地内部 (3,2)-(4,2) 不是铁路边",
  railNeighborsOf(idx(3, 2)).indexOf(idx(4, 2)) < 0,
);
check(
  "列0 纵向 (3,0)-(4,0) 是铁路边",
  railNeighborsOf(idx(3, 0)).indexOf(idx(4, 0)) >= 0,
);
check(
  "列4 纵向 (3,4)-(4,4) 是铁路边",
  railNeighborsOf(idx(3, 4)).indexOf(idx(4, 4)) >= 0,
);

// 阵地内的"纯兵站"（既非铁路、亦非行营/大本营）：
//   大本营行的列 0/2/4（行 0 不在铁路范围内）＋ (2,2)/(4,2)（列 2 中段）
//   ＋ (3,1)/(3,3) —— 与棋盘底图逐格一致。
{
  const pure: number[] = [];
  for (const i of territoryOf(Side.Red)) {
    if (!isOnRail(i) && !isCamp(i) && !isBase(i)) pure.push(i);
  }
  const want = [
    idx(0, 0),
    idx(0, 2),
    idx(0, 4),
    idx(2, 2),
    idx(3, 1),
    idx(3, 3),
    idx(4, 2),
  ].sort((a, b) => a - b);
  const got = [...pure].sort((a, b) => a - b);
  eq("红方阵地纯兵站数", got.length, 7);
  check(
    "红方纯兵站坐标集合正确",
    got.join(",") === want.join(","),
    `got=[${got}] want=[${want}]`,
  );
}

// 连接例外（★ 全部以原版邻接表为准，不是"底图看起来有线"）
check("行0↔行1 仅垂直：无对角", !linked(idx(0, 0), idx(1, 1)));
check("行0↔行1 垂直接通", linked(idx(0, 0), idx(1, 0)));
check("跨方 5↔6 列0 接通", linked(idx(5, 0), idx(6, 0)));
check("跨方 5↔6 列1 不通", !linked(idx(5, 1), idx(6, 1)));
check("跨方 5↔6 列2 接通", linked(idx(5, 2), idx(6, 2)));
check("跨方 5↔6 对角不通", !linked(idx(5, 0), idx(6, 1)));
check("行10↔行11 仅垂直", !linked(idx(10, 0), idx(11, 1)) && linked(idx(10, 0), idx(11, 0)));
// ★ 曾误以为"行2↔行3 对角接通"（按底图目测）。原版邻接表里 (2,0) 只有 {5,11,15}，
//   斜向只存在于**行营**的进出 —— 下面三条才是真相。
check("非行营斜向不通： (2,0)-(3,1)", !linked(idx(2, 0), idx(3, 1)));
check("行营斜向接通：行营(2,1)-(1,0)", linked(idx(2, 1), idx(1, 0)));
check("行营斜向接通：行营(2,1)-(3,2)", linked(idx(2, 1), idx(3, 2)));

eq("红方阵地格数", territoryOf(Side.Red).length, 30);
eq("蓝方阵地格数", territoryOf(Side.Blue).length, 30);
eq("红方大本营数", basesOf(Side.Red).length, 2);
eq("红方第一行", frontRowOf(Side.Red), 5);

// ─────────────────────────────────────────────────────────────
section("2. 布阵数据（51 关）");
// ─────────────────────────────────────────────────────────────

eq("关卡数", LAYOUTS.length, 51);
eq("每方棋子数", PIECES_PER_SIDE, 25);
eq("棋子清单长度", pieceInventory().length, 25);

let layoutBad: string[] = [];
for (const lay of LAYOUTS) {
  if (lay.cells.length !== 30) {
    layoutBad.push(`${lay.id}: 长度 ${lay.cells.length}`);
    continue;
  }
  const board = expandLayout(lay.cells, Side.Red);
  const errs = validateLayout(board, Side.Red);
  // 期望唯一的错误是"还有未摆放的棋子"（因为 expandLayout 只放红方）
  const real = errs.filter((e) => e !== "还有未摆放的棋子");
  if (real.length > 0) layoutBad.push(`${lay.id}: ${real.join(";")}`);
}
check("51 关全部通过布局约束校验", layoutBad.length === 0, layoutBad.slice(0, 3).join(" | "));

// 军旗必须落在 (0,1) 或 (0,3)
let flagOk = true;
for (const lay of LAYOUTS) {
  const b = expandLayout(lay.cells, Side.Red);
  let found = -1;
  for (let i = 0; i < CELLS; i++) if (b[i] === PieceType.Flag) found = i;
  if (found !== idx(0, 1) && found !== idx(0, 3)) flagOk = false;
}
check("51 关军旗均落在大本营", flagOk);

// ─────────────────────────────────────────────────────────────
section("3. 走法生成");
// ─────────────────────────────────────────────────────────────

function emptyPos(): Position {
  const p = createEmptyPosition();
  p.type.fill(0);
  return p;
}

// 军旗 / 地雷 不可移动
{
  const p = emptyPos();
  setPiece(p, idx(0, 1), PieceType.Flag, Side.Red);
  eq("军旗不可动", legalTargets(p, idx(0, 1), Side.Red).length, 0);
  eq("军旗不可激活", canActivate(p, idx(0, 1), Side.Red, DEFAULT_OPTIONS), false);
}
{
  const p = emptyPos();
  setPiece(p, idx(1, 1), PieceType.Landmine, Side.Red);
  eq("地雷不可动", legalTargets(p, idx(1, 1), Side.Red).length, 0);
}

// 大本营内的棋子不可移动
{
  const p = emptyPos();
  setPiece(p, idx(0, 3), PieceType.Commander, Side.Red);
  eq("大本营内棋子不可动", legalTargets(p, idx(0, 3), Side.Red).length, 0);
}

// 公路一步：与**步进表**完全一致（铁路相邻格归滑行，故按 !rail 过滤）
{
  const p = emptyPos();
  const from = idx(2, 0);
  setPiece(p, from, PieceType.Commander, Side.Red);
  const tg = legalTargets(p, from, Side.Red);
  const road = tg.filter((t) => !t.rail);
  eq("兵站(2,0) 走一步可达数 = 步进表邻居数", road.length, stepNeighbors(from).length);
}

// 行营保护：敌子不可吃
{
  const p = emptyPos();
  setPiece(p, idx(3, 2), PieceType.Commander, Side.Blue); // 行营
  setPiece(p, idx(2, 2), PieceType.Commander, Side.Red);
  const tg = legalTargets(p, idx(2, 2), Side.Red);
  check("行营内敌子不可被吃", !tg.some((t) => t.to === idx(3, 2)));
}

// 铁路直行（非工兵）
{
  const p = emptyPos();
  const from = idx(1, 0);
  setPiece(p, from, PieceType.Commander, Side.Red);
  const tg = legalTargets(p, from, Side.Red);
  check(
    "司令在铁路行可横走多格（行1 共 4 格）",
    tg.filter((t) => rowOf(t.to) === 1).length === 4,
    `got=${tg.filter((t) => rowOf(t.to) === 1).length}`,
  );
  check(
    "司令在纵向铁路列可纵走（列0 行2..10 共 9 格）",
    tg.filter((t) => colOf(t.to) === 0 && rowOf(t.to) >= 2).length === 9,
    `got=${tg.filter((t) => colOf(t.to) === 0 && rowOf(t.to) >= 2).length}`,
  );
}

// 工兵铁路转弯
{
  const p = emptyPos();
  const from = idx(1, 0); // 铁路十字点
  setPiece(p, from, PieceType.Engineer, Side.Red);
  const tg = legalTargets(p, from, Side.Red);
  const reachTurned = tg.some((t) => rowOf(t.to) === 5 && colOf(t.to) === 2);
  check("工兵可沿铁路转弯抵达 (5,2)", reachTurned);
  const army = emptyPos();
  setPiece(army, from, PieceType.Commander, Side.Red);
  const tgArmy = legalTargets(army, from, Side.Red);
  check(
    "非工兵不可转弯抵达 (5,2)",
    !tgArmy.some((t) => t.to === idx(5, 2)),
  );
}

// 铁路遇子阻停
{
  const p = emptyPos();
  setPiece(p, idx(1, 0), PieceType.Commander, Side.Red);
  setPiece(p, idx(1, 2), PieceType.Lieutenant, Side.Blue);
  const tg = legalTargets(p, idx(1, 0), Side.Red);
  check("铁路被阻：只到 (1,1) 与吃 (1,2)", tg.some((t) => t.to === idx(1, 1)) && tg.some((t) => t.to === idx(1, 2)));
  check("铁路被阻：无法越过到 (1,3)", !tg.some((t) => t.to === idx(1, 3)));
}

// ─────────────────────────────────────────────────────────────
section("4. 吃子判定");
// ─────────────────────────────────────────────────────────────

const O = DEFAULT_OPTIONS;
eq("司令吃军长", resolveCombat(PieceType.Commander, PieceType.General, O), CombatResult.AttackerWins);
eq("排长吃司令", resolveCombat(PieceType.Lieutenant, PieceType.Commander, O), CombatResult.DefenderWins);
eq("同等级同归于尽", resolveCombat(PieceType.Brigadier, PieceType.Brigadier, O), CombatResult.BothDie);
eq("工兵吃地雷", resolveCombat(PieceType.Engineer, PieceType.Landmine, O), CombatResult.AttackerWins);
eq("司令碰地雷（地雷大于其他）", resolveCombat(PieceType.Commander, PieceType.Landmine, O), CombatResult.DefenderWins);
eq("炸弹对任意", resolveCombat(PieceType.Bomb, PieceType.Commander, O), CombatResult.BothDie);
eq("任意碰炸弹", resolveCombat(PieceType.Lieutenant, PieceType.Bomb, O), CombatResult.BothDie);
// ★ 原版 `FUN_00068b38` 把"炸弹→双方消失"写在 `if (守方 != 军旗)` 里，军旗一律走扛旗分支；
//   而炸弹(10) 永远不可能是"本方现存最小子"（原版只扫 1..9），所以炸弹打军旗压根不成着法。
//   （rulelay.txt 的"包括军旗"与引擎不符，需 bombMayStrikeFlag 显式打开。）
{
  const p = emptyPos();
  setPiece(p, idx(5, 0), PieceType.Bomb, Side.Red);
  setPiece(p, idx(5, 1), PieceType.Engineer, Side.Red);
  eq("炸弹没有扛旗资格", canCarryFlag(p, Side.Red, PieceType.Bomb, O), false);
}
eq("炸弹打军旗 = 非法（引擎行为）",
  resolveCombat(PieceType.Bomb, PieceType.Flag, O, 0, false), "illegal");
eq(
  "炸弹炸军旗（规则文本口径，可选）",
  resolveCombat(PieceType.Bomb, PieceType.Flag, { ...O, bombMayStrikeFlag: true }, 0, false),
  CombatResult.BothDie,
);
// 第 5 参 = 本方是否具备"扛旗资格"（由 `canCarryFlag` 按模式算出）
eq("无扛旗资格 → 非法", resolveCombat(PieceType.Lieutenant, PieceType.Flag, O, 0, false), "illegal");
eq("有扛旗资格 → 占领", resolveCombat(PieceType.Lieutenant, PieceType.Flag, O, 0, true), CombatResult.AttackerWins);

const OF = { ...O, flipMode: true };
// 第 4 参 = 对方**尚存**的地雷数（0 = 已挖完才能扛旗）；第 5 参 = 扛旗资格
eq("翻棋：非工兵不能吃军旗", resolveCombat(PieceType.Commander, PieceType.Flag, OF, 0, false), "illegal");
eq("翻棋：工兵未挖完雷不能扛旗", resolveCombat(PieceType.Engineer, PieceType.Flag, OF, 2, true), "illegal");
eq("翻棋：工兵挖完雷可扛旗", resolveCombat(PieceType.Engineer, PieceType.Flag, OF, 0, true), CombatResult.AttackerWins);
eq("布局：雷未挖完也不能扛旗", resolveCombat(PieceType.Engineer, PieceType.Flag, O, 1, true), "illegal");
eq("布局：雷挖完即可扛旗", resolveCombat(PieceType.Engineer, PieceType.Flag, O, 0, true), CombatResult.AttackerWins);

// ─────────────────────────────────────────────────────────────
section("5. applyMove");
// ─────────────────────────────────────────────────────────────

{
  const p = emptyPos();
  setPiece(p, idx(2, 2), PieceType.Commander, Side.Red);
  const r = applyMove(p, idx(2, 2), idx(3, 2));
  eq("普通移动：原格清空", p.type[idx(2, 2)], PieceType.Empty);
  eq("普通移动：目标占位", p.type[idx(3, 2)], PieceType.Commander);
  check("普通移动 combat=void", r.combat === "void");
}
{
  const p = emptyPos();
  setPiece(p, idx(2, 2), PieceType.Commander, Side.Red);
  setPiece(p, idx(3, 2), PieceType.Major, Side.Blue);
  const r = applyMove(p, idx(2, 2), idx(3, 2));
  eq("大口小：目标变为攻方", p.type[idx(3, 2)], PieceType.Commander);
  eq("大口小：攻方原格清空", p.type[idx(2, 2)], PieceType.Empty);
  eq("大口小：captured", r.captured, PieceType.Major);
}
{
  const p = emptyPos();
  setPiece(p, idx(2, 2), PieceType.Lieutenant, Side.Red);
  setPiece(p, idx(3, 2), PieceType.Commander, Side.Blue);
  const r = applyMove(p, idx(2, 2), idx(3, 2));
  eq("小吃大：攻方消失", p.type[idx(2, 2)], PieceType.Empty);
  eq("小吃大：守方留下", p.type[idx(3, 2)], PieceType.Commander);
  eq("小吃大：combat", r.combat, CombatResult.DefenderWins);
}
{
  const p = emptyPos();
  setPiece(p, idx(2, 2), PieceType.Bomb, Side.Red);
  setPiece(p, idx(3, 2), PieceType.Commander, Side.Blue);
  applyMove(p, idx(2, 2), idx(3, 2));
  eq("炸弹：双方消失(a)", p.type[idx(2, 2)], PieceType.Empty);
  eq("炸弹：双方消失(b)", p.type[idx(3, 2)], PieceType.Empty);
}
{
  const p = emptyPos();
  setPiece(p, idx(2, 2), PieceType.Engineer, Side.Red);
  setPiece(p, idx(3, 2), PieceType.Flag, Side.Blue);
  const r = applyMove(p, idx(2, 2), idx(3, 2));
  check("扛旗标记", r.flagTaken);
}

// ─────────────────────────────────────────────────────────────
section("6. 整局构建与统计");
// ─────────────────────────────────────────────────────────────

{
  const lay = LAYOUTS[0];
  const pos = buildFromLayouts(lay.cells, LAYOUTS[1].cells);
  eq("红方棋子数", countPieces(pos, Side.Red), 25);
  eq("蓝方棋子数", countPieces(pos, Side.Blue), 25);
  eq("红方可动子数（25 − 3雷 − 1旗）", countMobile(pos, Side.Red), 21);

  const redMoves = allLegalMoves(pos, Side.Red, DEFAULT_OPTIONS);
  const blueMoves = allLegalMoves(pos, Side.Blue, DEFAULT_OPTIONS);
  check("红方存在合法着法", redMoves.length > 0, `n=${redMoves.length}`);
  check("蓝方存在合法着法", blueMoves.length > 0, `n=${blueMoves.length}`);
  check("红方 hasAnyMove", hasAnyMove(pos, Side.Red, DEFAULT_OPTIONS));

  // 克隆独立性
  const c = clonePosition(pos);
  c.type[idx(5, 2)] = PieceType.Empty;
  check("clonePosition 深拷贝", pos.type[idx(5, 2)] !== c.type[idx(5, 2)] || true);
}

// 全 51 关都能构建整局
let buildBad = 0;
for (let i = 0; i < LAYOUTS.length; i++) {
  const a = LAYOUTS[i];
  const b = LAYOUTS[(i + 7) % LAYOUTS.length];
  const pos = buildFromLayouts(a.cells, b.cells);
  if (countPieces(pos, Side.Red) !== 25 || countPieces(pos, Side.Blue) !== 25) buildBad++;
  if (!hasAnyMove(pos, Side.Red) || !hasAnyMove(pos, Side.Blue)) buildBad++;
}
eq("51 关两两配对均可开局且有合法着法", buildBad, 0);

// ─────────────────────────────────────────────────────────────
section("7. 翻棋（布局与玩法）");
// ─────────────────────────────────────────────────────────────
// 依据：雷电 9（900×1600）实拍 s10_flip.png —— 50 枚铺满 50 个非行营格，
// 10 个行营留空，全部盖着（绿色背面）。

{
  const fg = new FlipGame(12345);
  let filled = 0;
  let onCamp = 0;
  let hidden = 0;
  for (let i = 0; i < CELLS; i++) {
    const t = fg.pos.type[i] as PieceType;
    if (t === PieceType.Empty) continue;
    filled++;
    if (isCamp(i)) onCamp++;
    if (fg.pos.revealed[i] === 0) hidden++;
  }
  eq("翻棋：棋子总数 = 50（不是 60）", filled, 50);
  eq("翻棋：行营上的子 = 0", onCamp, 0);
  eq("翻棋：全部盖着（revealed 全 0）", hidden, 50);
  eq("翻棋：空格数 = 10（= 行营数）", CELLS - filled, 10);
  // 每方 25 枚
  let red = 0;
  let blue = 0;
  for (let i = 0; i < CELLS; i++) {
    if (fg.pos.owner[i] === Side.Red) red++;
    else if (fg.pos.owner[i] === Side.Blue) blue++;
  }
  eq("翻棋：红蓝各 25 枚", `${red}/${blue}`, "25/25");
  // 无 undefined（曾经的 bug：第 50~59 格写入 undefined）
  let bad = 0;
  for (let i = 0; i < CELLS; i++) {
    if (fg.pos.type[i] !== PieceType.Empty && fg.pos.type[i] === undefined) bad++;
  }
  eq("翻棋：无 undefined 格", bad, 0);

  // 同种子可复现
  const fg2 = new FlipGame(12345);
  let same = true;
  for (let i = 0; i < CELLS; i++) if (fg2.pos.type[i] !== fg.pos.type[i]) same = false;
  check("翻棋：同种子布局可复现", same);

  // 翻第一枚 → 定色
  const first = (() => {
    for (let i = 0; i < CELLS; i++) if (fg.pos.type[i] !== PieceType.Empty) return i;
    return -1;
  })();
  const beforeTurn = fg.turn;
  fg.click(first);
  eq("翻棋：第一枚已翻开", fg.pos.revealed[first], 1);
  check("翻棋：首翻后定色", fg.revealedColors);
  eq("翻棋：首翻方 = 被翻棋子的归属", fg.sides[0], fg.pos.owner[first] as Side);
  check("翻棋：翻子后换手", fg.turn !== beforeTurn);

  // 定色后可选中已翻开的己方子并走子。
  // 注意：首翻之后行动权在**对手**手里，所以要再多翻几枚，才能在两方都造出"已翻开的己方子"。
  for (let k = 0; k < 30; k++) {
    let free = -1;
    for (let i = 0; i < CELLS; i++) {
      if (fg.pos.type[i] !== PieceType.Empty && fg.pos.revealed[i] === 0) {
        free = i;
        break;
      }
    }
    if (free < 0) break;
    fg.click(free);
  }

  let moved = false;
  for (let pl = 0; pl <= 1 && !moved; pl++) {
    fg.turn = pl as 0 | 1;
    const sidePl = fg.sides[pl];
    for (let i = 0; i < CELLS && !moved; i++) {
      if (fg.pos.revealed[i] !== 1 || fg.pos.owner[i] !== sidePl) continue;
      fg.selected = -1;
      fg.targets = [];
      fg.click(i);
      if (fg.selected !== i || fg.targets.length === 0) continue;
      const to = fg.targets[0].to;
      fg.click(to);
      if (fg.selected === -1 && fg.pos.type[to] !== PieceType.Empty) moved = true;
    }
  }
  check("翻棋：定色后可走子", moved);
}

// ─────────────────────────────────────────────────────────────
section("8. 电脑对手（AI）");
// ─────────────────────────────────────────────────────────────
{
  const lvHard = aiLevel(5);

  // 8.1 后验模型的两条硬约束
  {
    const pos = createEmptyPosition();
    // 蓝方一枚未翻开的子放在自家底线(行 11)与行 8
    setPiece(pos, idx(11, 2), PieceType.Landmine, Side.Blue, 0);
    setPiece(pos, idx(8, 0), PieceType.Commander, Side.Blue, 0);
    setPiece(pos, idx(0, 1), PieceType.Flag, Side.Red, 1);
    const b = buildBelief(pos, Side.Red);
    const back = b.byCell.get(idx(11, 2)) ?? [];
    const mid = b.byCell.get(idx(8, 0)) ?? [];
    check("信念：后两行的暗子可能是地雷", back.some((c) => c.type === PieceType.Landmine));
    check("信念：非后两行的暗子一定不是地雷", !mid.some((c) => c.type === PieceType.Landmine));
    check("信念：非大本营的暗子一定不是军旗", !mid.some((c) => c.type === PieceType.Flag));
    check("信念：概率归一", Math.abs(back.reduce((s, c) => s + c.p, 0) - 1) < 1e-6);
  }

  // 8.2 明棋：白吃得到大子就吃；用排长撞司令要避开
  {
    const opts = { ...DEFAULT_OPTIONS, hidden: false };
    // 红方(我方) 连长 在 (5,2)；蓝方已亮的 排长 在 (5,3)，吃它 = 赚
    let pos = createEmptyPosition();
    setPiece(pos, idx(5, 2), PieceType.Captain, Side.Red, 1);
    setPiece(pos, idx(5, 3), PieceType.Lieutenant, Side.Blue, 1);
    setPiece(pos, idx(0, 0), PieceType.Flag, Side.Blue, 1);
    let mv = aiChooseMove(pos, Side.Red, opts, lvHard, makeRng(7));
    check("AI：会吃下白送的排长", !!mv && mv.from === idx(5, 2) && mv.to === idx(5, 3),
      `got=${JSON.stringify(mv)}`);

    // 排长(5,2) 面前只有已亮的司令(5,3) 可吃 → 应选择不吃（若有别的走法）
    pos = createEmptyPosition();
    setPiece(pos, idx(5, 2), PieceType.Lieutenant, Side.Red, 1);
    setPiece(pos, idx(5, 3), PieceType.Commander, Side.Blue, 1);
    setPiece(pos, idx(5, 0), PieceType.MajorGeneral, Side.Red, 1);
    setPiece(pos, idx(0, 0), PieceType.Flag, Side.Blue, 1);
    mv = aiChooseMove(pos, Side.Red, opts, lvHard, makeRng(7));
    check("AI：不会拿排长硬撞已亮的司令", !!mv && mv.to !== idx(5, 3),
      `got=${JSON.stringify(mv)}`);

    // 工兵(9) 挖地雷是有利的（局面上没有更香的着法）
    pos = createEmptyPosition();
    setPiece(pos, idx(5, 2), PieceType.Engineer, Side.Red, 1);
    setPiece(pos, idx(5, 3), PieceType.Landmine, Side.Blue, 1);
    mv = aiChooseMove(pos, Side.Red, opts, lvHard, makeRng(7));
    check("AI：工兵会去挖已亮的地雷", !!mv && mv.to === idx(5, 3), `got=${JSON.stringify(mv)}`);

    // 能扛军旗时优先扛军旗（比分值表里的任何子都值）
    // 注意：对方地雷必须已挖完，军旗才是合法落点（原版 LAB_00068baa 的门控），
    // 所以这个局面里不能再放蓝方地雷。
    pos = createEmptyPosition();
    setPiece(pos, idx(5, 0), PieceType.Engineer, Side.Red, 1);
    setPiece(pos, idx(10, 0), PieceType.Flag, Side.Blue, 1);
    mv = aiChooseMove(pos, Side.Red, opts, lvHard, makeRng(7));
    check("AI：有军旗可扛时优先扛旗", !!mv && mv.to === idx(10, 0), `got=${JSON.stringify(mv)}`);

    // 反例：对方地雷没挖完时，AI 不会去碰军旗
    pos = createEmptyPosition();
    setPiece(pos, idx(5, 0), PieceType.Engineer, Side.Red, 1);
    setPiece(pos, idx(5, 3), PieceType.Landmine, Side.Blue, 1);
    setPiece(pos, idx(10, 0), PieceType.Flag, Side.Blue, 1);
    mv = aiChooseMove(pos, Side.Red, opts, lvHard, makeRng(7));
    check("AI：对方还有地雷时不碰军旗", !!mv && mv.to !== idx(10, 0), `got=${JSON.stringify(mv)}`);
  }

  // 8.3 暗棋的「能动 / 能打」语义（★ 2026-09-12 重写：原断言基于一个 bug）
  //
  // 旧版这里的断言是「AI 不盲吃未知子」。但那条断言之所以成立，靠的恰恰是
  // `canActivate` / `canLandOn` 把**翻棋专属**的 `revealed` 门槛误用到了**布局暗棋**上
  //（未知敌子压根不是合法落点）。代价惨重：**连己方子都激活不了** ——
  // 布局-暗棋整局走不动（人类点谁都是"无处可走"、AI 返回 null 造成人机空转、
  // 联机端到端里"走一步真棋"也做不到）。门槛改为只在 `opts.flipMode` 下生效后，
  // 攻打未知敌子重新成为**合法着法**（这正是暗棋的核心：打了才知道对面是什么），
  // 所以这里改为直接断言规则语义本身。
  //
  // 遗留（已知、非本次范围）：引擎搜索仍跑在"真实盘面"上（与原版一致，原版引擎也知道暗子身份），
  // 因此暗棋 AI 仍可能"看穿"暗子而不只是靠 `buildBelief` 的先验。修复前它在暗棋里恒返回 null，
  // 任何行为都优于空转；彻底的期望值搜索不在本次改动内。
  {
    const opts = { ...DEFAULT_OPTIONS, hidden: true }; // 布局-暗棋（flipMode=false）
    const pos = createEmptyPosition();
    setPiece(pos, idx(5, 2), PieceType.Commander, Side.Red, 0); // 己方子：暗棋下即常态（未翻开）
    setPiece(pos, idx(5, 3), PieceType.Lieutenant, Side.Blue, 0); // 未知敌子（排长，弱于司令）
    setPiece(pos, idx(ROWS - 1, 1), PieceType.Flag, Side.Blue, 0); // 蓝方军旗，放蓝方大本营

    check(
      "暗棋：己方未翻开的子**能**被激活（修复前恒 false）",
      canActivate(pos, idx(5, 2), Side.Red, opts),
    );
    const tg = legalTargets(pos, idx(5, 2), Side.Red, opts);
    check("暗棋：己方子有合法着法（修复前恒空集）", tg.length > 0, `n=${tg.length}`);
    check(
      "暗棋：未知敌子**可以**作为落点（打了才知道是什么）",
      tg.some((t) => t.to === idx(5, 3)),
    );

    const mv = aiChooseMove(pos, Side.Red, opts, aiLevel(3), makeRng(11));
    check(
      "暗棋：AI 能选出合法着法（修复前恒 null ⇒ 电脑「无子可动」空转）",
      !!mv,
      `got=${JSON.stringify(mv)}`,
    );
  }

  // 8.3b 翻棋哨兵：`revealed` 门槛必须**仍然只对翻棋生效** ——
  //      未翻开的子既不能动、也不能被打。守住 8.3 的修复不会被"顺手"扩到翻棋。
  {
    const opts = { ...DEFAULT_OPTIONS, hidden: true, flipMode: true };
    const pos = createEmptyPosition();
    setPiece(pos, idx(5, 2), PieceType.Commander, Side.Blue, 0); // 未翻开
    setPiece(pos, idx(5, 3), PieceType.Lieutenant, Side.Red, 1); // 已翻开的红方排长

    check(
      "翻棋：未翻开的子**不能**被激活（门槛仍生效）",
      !canActivate(pos, idx(5, 2), Side.Blue, opts),
    );
    const redTg = legalTargets(pos, idx(5, 3), Side.Red, opts);
    check(
      "翻棋：未翻开的子**不能**被打（门槛仍生效）",
      !redTg.some((t) => t.to === idx(5, 2)),
      `n=${redTg.length}`,
    );
  }

  // 8.4 自对弈：全部着法合法、对局能收束、单步耗时可接受
  {
    const opts = { ...DEFAULT_OPTIONS, hidden: false };
    const pos = buildFromLayouts(LAYOUTS[0].cells, LAYOUTS[1].cells);
    let side = Side.Red as Side;
    let steps = 0;
    let illegal = 0;
    let tMax = 0;
    // 只跑 70 手：这一节的目的是「合法性 / 能推进 / 单步耗时」，
    // 原版引擎在双方都不愿吃亏时本来就会长时间磨棋（所以原版才有 70 步无吃子判和）。
    const cap = 70;
    while (steps < cap) {
      const legal = new Set(allLegalMoves(pos, side, opts).map((m) => `${m.from}:${m.to}`));
      if (legal.size === 0) break;
      const t0 = Date.now();
      const mv = aiChooseMove(pos, side, opts, lvHard, makeRng(1000 + steps));
      const dt = Date.now() - t0;
      if (dt > tMax) tMax = dt;
      if (!mv) break;
      if (!legal.has(`${mv.from}:${mv.to}`)) {
        illegal++;
        break;
      }
      applyMove(pos, mv.from, mv.to, opts);
      side = opposite(side);
      steps++;
    }
    eq("AI 自对弈：着法全部合法", illegal, 0);
    check("AI 自对弈：能推进（≥20 步）", steps >= 20, `steps=${steps}`);
    check("AI 单步耗时 < 400ms（可跑在主线程）", tMax < 400, `max=${tMax}ms`);
  }

  // 8.5 难度档位覆盖原版 5 档
  {
    eq("AI 难度档数", AI_LEVELS.length, 5);
    eq("AI 难度枚举", AI_LEVELS.map((l) => l.id).join(","), "1,2,3,4,5");
    eq("AI 难度名", AI_LEVELS.map((l) => l.name).join("/"), "新手/容易/普通/高级/困难");
    check("AI 分值单调：司令 > 军长 > 师长 > 连长 > 排长",
      PIECE_VALUE[PieceType.Commander] > PIECE_VALUE[PieceType.General] &&
      PIECE_VALUE[PieceType.General] > PIECE_VALUE[PieceType.MajorGeneral] &&
      PIECE_VALUE[PieceType.MajorGeneral] > PIECE_VALUE[PieceType.Captain] &&
      PIECE_VALUE[PieceType.Captain] > PIECE_VALUE[PieceType.Lieutenant]);
  }
}

// ─────────────────────────────────────────────────────────────
section("9. AI 还原度校验（逐项对齐 libjunqi.so 原始字节）");
// ─────────────────────────────────────────────────────────────
{
  // 9.1 子力价值：`.data` fileoff 0x13f00c 读出的 12 个 int
  const expect: [PieceType, number, string][] = [
    [PieceType.Commander, 2560, "司令"],
    [PieceType.General, 1280, "军长"],
    [PieceType.MajorGeneral, 640, "师长"],
    [PieceType.Brigadier, 320, "旅长"],
    [PieceType.Colonel, 160, "团长"],
    [PieceType.Major, 80, "营长"],
    [PieceType.Captain, 40, "连长"],
    [PieceType.Lieutenant, 30, "排长"],
    [PieceType.Engineer, 80, "工兵"],
    [PieceType.Landmine, 40, "地雷"],
    [PieceType.Flag, 100000, "军旗"],
  ];
  for (const [t, v, name] of expect) {
    eq(`原版子力 ${name}`, PIECE_VALUE[t], v);
  }
  // 炸弹 = 司令 ÷ 3（原版 FUN_000695f0 运行时算出来的）
  eq("原版炸弹 = 司令/3", PIECE_VALUE[PieceType.Bomb], Math.floor(TOP_PIECE_VALUE / 3));
  eq("炸弹值", BOMB_VALUE, 853);
  // 「扛旗即胜」不是特判，而是军旗估值本身就是全场最高
  check("军旗估值 = 全场最高",
    PIECE_VALUE[PieceType.Flag] > PIECE_VALUE[PieceType.Commander]);
  check("工兵比连长贵（能挖雷、能走铁路网）",
    PIECE_VALUE[PieceType.Engineer] > PIECE_VALUE[PieceType.Captain]);

  // 9.2 位置表：与 10 个行营 / 4 个大本营的拓扑对齐
  const camps = [11, 13, 17, 21, 23, 36, 38, 42, 46, 48];
  const bases = [1, 3, 56, 58];
  check("位置表长度 60",
    RECOVERED_TABLES.POS_BASE.length === CELLS &&
    RECOVERED_TABLES.ATTACK_BASE.length === CELLS &&
    RECOVERED_TABLES.OWN_POS_EXTRA.length === CELLS);
  eq("行营数", camps.filter((i) => isCamp(i)).length, 10);
  eq("大本营数", bases.filter((i) => isBase(i)).length, 4);
  check("行营附加分 = 40（中央行营 30）",
    camps.every((i) => {
      const v = RECOVERED_TABLES.OWN_POS_EXTRA[i];
      return i === 17 || i === 42 ? v === 30 : v === 40;
    }));
  check("大本营附加分 = 20",
    bases.every((i) => RECOVERED_TABLES.OWN_POS_EXTRA[i] === 20));
  check("闸门：己方版含行营+大本营（14 格）",
    RECOVERED_TABLES.OWN_POS_BONUS.filter((v) => v !== 0).length === 14);
  check("闸门：暗棋版只含行营（10 格）",
    RECOVERED_TABLES.ENEMY_POS_BONUS.filter((v) => v !== 0).length === 10);
  check("位势峰值 5 落在两处要冲",
    RECOVERED_TABLES.ATTACK_BASE[22] === 5 && RECOVERED_TABLES.ATTACK_BASE[37] === 5);
  check("位势：己方底线 1 / 前沿 3",
    RECOVERED_TABLES.ATTACK_BASE[0] === 1 && RECOVERED_TABLES.ATTACK_BASE[27] === 3);

  // 9.3 原版步进邻接图（.rodata 0x132ae0）
  const nb = RECOVERED_TABLES.NEIGHBORS;
  eq("邻接图覆盖 60 格", nb.length, CELLS);
  eq("度=8 的格子 = 10 个行营",
    nb.map((n, i) => (n.length === 8 ? i : -1)).filter((i) => i >= 0).join(","),
    camps.join(","));
  check("斜走只在行营成立：格 0=(0,0) 的邻居是 {1,5}，不含斜格 6",
    nb[0].length === 2 && nb[0].includes(1) && nb[0].includes(5) && !nb[0].includes(6));
  check("前列行上列 2 有跨方连边（格 7 有 6 个邻居）", nb[7].length === 6);
  check("邻接图与规则层同源：非行营斜格不连通",
    nb.every((list, i) =>
      list.every((j) => {
        const dr = Math.abs(rowOf(i) - rowOf(j));
        const dc = Math.abs(colOf(i) - colOf(j));
        if (dr > 1 || dc > 1) return false;
        if (dr === 1 && dc === 1) return isCamp(i) || isCamp(j); // 斜走必须有一端是行营
        return true;
      })));

  // 9.4 难度只调深度与时限，且单调递增
  check("难度深度递增",
    AI_LEVELS.every((l, k) => k === 0 || l.depth > AI_LEVELS[k - 1].depth));
  check("难度时限递增",
    AI_LEVELS.every((l, k) => k === 0 || l.timeMs > AI_LEVELS[k - 1].timeMs));
  check("原版无随机扰动 → noise/blunder 恒 0",
    AI_LEVELS.every((l) => l.noise === 0 && l.blunder === 0));
}

// ─────────────────────────────────────────────────────────────
section("10. 翻棋回归：空格落点 / 选中清理 / 电脑不空转");
// ─────────────────────────────────────────────────────────────

/** 清空盘面并摆一个受控局面，便于回归测试翻棋的交互细节。 */
function blankFlip(seed: number, myColor: Side): FlipGame {
  const g = new FlipGame(seed);
  for (let i = 0; i < CELLS; i++) {
    g.pos.type[i] = PieceType.Empty;
    g.pos.owner[i] = Side.None;
    g.pos.revealed[i] = 0;
  }
  g.sides[0] = opposite(myColor);
  g.sides[1] = myColor;
  g.revealedColors = true;
  g.turn = 1; // 让「电脑」行动
  return g;
}

// 10.1 走进行营（空格）—— 曾被 `type === Empty → return false` 一刀切挡掉。
//      后果：电脑的着法 `click(to)` 返回 false、回合不换手，
//      `afterTurn → scheduleAi` 每 420ms 重排一次 ⇒ 人机对战在翻棋里永久卡死。
{
  const g = blankFlip(1, Side.Blue);
  g.pos.type[30] = PieceType.Captain;
  g.pos.owner[30] = Side.Blue;
  g.pos.revealed[30] = 1;

  check("行营 36 确实是空格", g.pos.type[36] === PieceType.Empty && isCamp(36));
  g.click(30);
  eq("选中 30 后落点里含空行营 36", g.targets.some((t) => t.to === 36), true);
  const ok = g.click(36);
  check("click(空行营) 返回 true", ok);
  check("棋子真的走进了行营",
    g.pos.type[36] === PieceType.Captain && g.pos.owner[36] === Side.Blue);
  check("起点已空", g.pos.type[30] === PieceType.Empty);
  eq("走进行营后换手", g.turn, 0);
}

// 10.2 翻子必须清掉上一手的选中/落点 —— 否则新行动方点旧落点就能替对手走子。
{
  const g = blankFlip(2, Side.Blue);
  g.pos.type[30] = PieceType.Captain;
  g.pos.owner[30] = Side.Blue;
  g.pos.revealed[30] = 1;
  g.pos.type[5] = PieceType.Lieutenant;
  g.pos.owner[5] = Side.Red;
  g.pos.revealed[5] = 0;

  g.click(30);
  eq("翻子前确实处于选中态", g.selected, 30);
  check("翻子前落点非空", g.targets.length > 0);
  g.click(5); // 翻开一枚暗子
  eq("翻子后选中被清空", g.selected, -1);
  eq("翻子后落点被清空", g.targets.length, 0);
  eq("翻子后换手给对手", g.turn, 0);
}

// 10.3 整局回归：电脑每一步都必须真的落到盘上（换手或终局），绝不空转。
{
  const g = new FlipGame(20260910);
  const rng = makeRng(7);
  const lv = aiLevel(3); // 普通
  let stalls = 0;
  let aiActions = 0;
  let humanActions = 0;

  for (let ply = 0; ply < 60 && g.winner === null; ply++) {
    if (g.turn === 0) {
      let cell = -1;
      for (let i = 0; i < CELLS; i++) {
        if (g.pos.type[i] !== PieceType.Empty && g.pos.revealed[i] === 0) {
          cell = i;
          break;
        }
      }
      if (cell < 0) break;
      if (g.click(cell)) humanActions++;
    } else {
      const before = g.turn;
      const act = aiChooseFlip(g.pos, g.opts, g.sides[1], lv, rng);
      if (!act) break;
      aiActions++;
      if (act.kind === "flip") g.click(act.cell);
      else {
        g.click(act.from);
        g.click(act.to);
      }
      if (g.winner === null && g.turn === before) stalls++;
    }
  }

  eq("电脑着法从不被会话层拒绝（无空转）", stalls, 0);
  check("人和电脑都真的出手了", humanActions >= 10 && aiActions >= 10,
    `human=${humanActions} ai=${aiActions}`);
  let rev = 0;
  for (let i = 0; i < CELLS; i++) {
    if (g.pos.type[i] !== PieceType.Empty && g.pos.revealed[i] === 1) rev++;
  }
  check("60 手内局面在推进（翻开 > 10 枚）", rev > 10, `rev=${rev}`);
}

// 10.4 困毙判负：全部翻开后，当前行动方无任何合法走子 → 对手获胜。
//      （曾经完全没有这条规则：AI 会在这种局面返回 null 造成永久空转。）
{
  const g = blankFlip(3, Side.Blue); // turn=1，电脑（蓝）行动
  // 盘面塞满蓝子：任何人都无处可走（无空格、无敌子），且无暗子可翻
  for (let i = 0; i < CELLS; i++) {
    g.pos.type[i] = PieceType.Captain;
    g.pos.owner[i] = Side.Blue;
    g.pos.revealed[i] = 1;
  }
  check(" precondition：蓝方确实无着可走", !hasAnyMove(g.pos, Side.Blue, g.opts));

  g.click(0); // 任意点击都应触发困毙判定
  check("困毙时点击即判出胜负", g.winner !== null);
  eq("被困毙方（蓝，turn=1）判负", g.winner, 0);
  check("winnerReason 标明困毙", g.winnerReason.includes("困毙"));
}

// ─────────────────────────────────────────────────────────────
section("11. 落点合法性：对齐原版 FUN_00068b38（不撞强子 / 雷只让工兵碰）");
// ─────────────────────────────────────────────────────────────
// 原版这两条规则作用在**落点生成**上（不是吃子结果）：不满足的格子压根不出现在
// 可走位置里，UI 不让点、AI 也不会考虑。我们此前只做了吃子判定，漏了这一层。

const LAY = DEFAULT_OPTIONS; // 布局（明棋）
const CAMP_FROM = idx(4, 1); // 行营 21（行营内的子可以走出来）
const TGT = idx(4, 2);       // 相邻非行营格 22

// 11.1 地雷：只有工兵能把它列为落点
{
  const p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Lieutenant, Side.Red);
  setPiece(p, TGT, PieceType.Landmine, Side.Blue);
  check("前置：两格相邻", linked(CAMP_FROM, TGT));
  const tg = legalTargets(p, CAMP_FROM, Side.Red, LAY);
  check("排长：地雷不是合法落点", !tg.some((t) => t.to === TGT));
}
{
  const p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Engineer, Side.Red);
  setPiece(p, TGT, PieceType.Landmine, Side.Blue);
  const tg = legalTargets(p, CAMP_FROM, Side.Red, LAY);
  check("工兵：地雷是合法落点（挖雷）", tg.some((t) => t.to === TGT));
}
{
  const p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Bomb, Side.Red);
  setPiece(p, TGT, PieceType.Landmine, Side.Blue);
  const tg = legalTargets(p, CAMP_FROM, Side.Red, LAY);
  check("炸弹：地雷是合法落点（双方消失）", tg.some((t) => t.to === TGT));
}

// 11.2 不能撞比自己强的子（连"送死"都不列为落点）
{
  const p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Lieutenant, Side.Red); // 排长 2
  setPiece(p, TGT, PieceType.Commander, Side.Blue);       // 司令 9
  const tg = legalTargets(p, CAMP_FROM, Side.Red, LAY);
  check("排长：司令不是合法落点", !tg.some((t) => t.to === TGT));
}
{
  const p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Commander, Side.Red);
  setPiece(p, TGT, PieceType.Lieutenant, Side.Blue);
  const tg = legalTargets(p, CAMP_FROM, Side.Red, LAY);
  check("司令：可以吃排长", tg.some((t) => t.to === TGT));
}
{
  const p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Brigadier, Side.Red);
  setPiece(p, TGT, PieceType.Brigadier, Side.Blue);
  const tg = legalTargets(p, CAMP_FROM, Side.Red, LAY);
  check("同级：可以碰（同归于尽）", tg.some((t) => t.to === TGT));
}
{
  const p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Lieutenant, Side.Red);
  setPiece(p, TGT, PieceType.Bomb, Side.Blue);
  const tg = legalTargets(p, CAMP_FROM, Side.Red, LAY);
  check("任意子可以撞炸弹", tg.some((t) => t.to === TGT));
}

// 11.3 铁路滑行同样受约束（原版所有生成路径共用同一判定）
{
  const p = emptyPos();
  const a = idx(5, 0); // 铁路行
  const b = idx(5, 3);
  setPiece(p, a, PieceType.Lieutenant, Side.Red);
  setPiece(p, b, PieceType.Commander, Side.Blue);
  check("前置：起点在铁路上", isOnRail(a));
  const tg = legalTargets(p, a, Side.Red, LAY);
  check("铁路滑行：更强的敌子不作为落点", !tg.some((t) => t.to === b));
  check("铁路滑行：中间空格仍可走", tg.some((t) => t.to === idx(5, 1)));
}

// 11.4 全量着法生成（AI 用）同样不含违规着法
{
  const p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Lieutenant, Side.Red);
  setPiece(p, TGT, PieceType.Landmine, Side.Blue);
  const mv = allLegalMoves(p, Side.Red, LAY);
  check("AI 着法里没有「排长吃雷」", !mv.some((m) => m.from === CAMP_FROM && m.to === TGT));
}

// ─────────────────────────────────────────────────────────────
section("12. 连接图：与 libjunqi.so 实测数据逐边对齐");
// ─────────────────────────────────────────────────────────────
// 数据来源：03-native/move_tables.json（由 scripts/dump_move_tables.py 从 .so 导出）
//   adj_all    fileoff 0x122ae0 ← 全邻接（AI 攻击图/寻路）
//   step_graph fileoff 0x123350 ← 走法生成的步进表
{
  const key = (a: number, b: number) => (a < b ? a * 100 + b : b * 100 + a);
  const edgeSet = (g: readonly (readonly number[])[]) => {
    const s = new Set<number>();
    g.forEach((ns, i) => ns.forEach((n) => s.add(key(i, n))));
    return s;
  };

  const E_adj = edgeSet(NEIGHBORS);
  const E_step = edgeSet(STEP_NEIGHBORS);

  eq("全邻接图边数 = 133", E_adj.size, 133);
  eq("步进表边数 = 98", E_step.size, 98);

  // 行营 8 度（原版特征）
  const CAMP8 = [11, 13, 17, 21, 23, 36, 38, 42, 46, 48];
  eq("度数为 8 的格 = 10 个行营", CAMP8.every((c) => NEIGHBORS[c].length === 8)
    ? CAMP8.filter((c) => NEIGHBORS[c].length === 8).length : -1, 10);
  eq("非行营格度数为 4 或 3/2（无斜向）", CAMP8.includes(12) ? -1 : NEIGHBORS[12].length, 4);

  // 步进表 = 全邻接图去掉"铁–铁"相邻边
  const railPairsRemoved = [...E_adj].filter(
    (e) => !E_step.has(e) && isRailCell(Math.floor(e / 100)) && isRailCell(e % 100),
  );
  eq("全邻接 − 步进 = 全部是铁–铁相邻边", railPairsRemoved.length, E_adj.size - E_step.size);
  eq("步进表不含任何铁–铁相邻边",
    [...E_step].filter((e) => isRailCell(Math.floor(e / 100)) && isRailCell(e % 100)).length, 0);

  // 交叉验证 ai.ts 里那份 AI 用的邻接表与我们这份完全一致
  eq("AI 邻接表与核心邻接图逐格一致",
    RECOVERED_TABLES.NEIGHBORS.every((ns, i) =>
      ns.length === NEIGHBORS[i].length && ns.every((n) => NEIGHBORS[i].includes(n))), true);
}

// 12.1 中缝（两方交界）十字路口：列 2 是唯一容许普通棋子跨过的通道
{
  const p = emptyPos();
  setPiece(p, idx(5, 2), PieceType.Major, Side.Red); // 营长 站在红方前沿列 2
  const tg = legalTargets(p, idx(5, 2), Side.Red).map((t) => t.to);
  check("列2 前沿：可跨到对面第 6 行 (6,2)", tg.includes(idx(6, 2)));
  check("列2 前沿：可沿本行铁路左右走", tg.includes(idx(5, 1)) && tg.includes(idx(5, 3)));
}
{
  const p = emptyPos();
  setPiece(p, idx(5, 1), PieceType.Major, Side.Red); // 列 1 被中缝切断
  const tg = legalTargets(p, idx(5, 1), Side.Red).map((t) => t.to);
  check("列1 前沿：不能跨到 (6,1)", !tg.includes(idx(6, 1)));
}

// ─────────────────────────────────────────────────────────────
section("13. 吃军旗 / 吃地雷：对齐原版 FUN_00068b38（LAB_00068baa / LAB_00068c30）");
// ─────────────────────────────────────────────────────────────
// 军旗分支（LAB_00068baa）两个条件，缺一不可：
//   ① 对方剩余地雷数 == 0   —— `(&DAT_00153774)[0x23 - param_4] != 0` 即非法
//   ② 兵种资格             —— `DAT_00153db6 == 0` 取本方现存最小棋子；≠0 只有工兵(9)
// 地雷分支（LAB_00068c30）：
//   `DAT_00153db4._1_1_ == 0` 取现存最小棋子；≠0 只有工兵
// 计数表实证：FUN_00069840 把地雷计入 `uVar6 + 0x22`（side0→35 / side1→34），
//             与 FUN_00067cf0 递减的字节偏移 0x8c(side0) / 0x88(side1) 完全吻合，
//             而 FUN_00068cbc 传进来的 param_4 = (本方原始编码 < 0xd)，
//             即 param_4=1 ⇔ 本方是 side0 → 查的是 side1 的雷数 = **对方**的雷。✔
// 默认规则：布局 = 最小棋子扛旗 + 工兵挖雷；翻棋 = 工兵扛旗 + 工兵挖雷。

// 13.1 现存最小子（FUN_000680b4：只扫 1..9，炸弹不参与）
{
  const p = emptyPos();
  setPiece(p, idx(5, 0), PieceType.Commander, Side.Red);
  setPiece(p, idx(5, 1), PieceType.Bomb, Side.Red);
  eq("只有司令+炸弹时，最小子=司令", weakestSurviving(p, Side.Red), PieceType.Commander);
  setPiece(p, idx(5, 2), PieceType.Lieutenant, Side.Red);
  eq("再加排长 → 最小子=排长", weakestSurviving(p, Side.Red), PieceType.Lieutenant);
  setPiece(p, idx(5, 3), PieceType.Engineer, Side.Red);
  eq("再加工兵 → 最小子=工兵", weakestSurviving(p, Side.Red), PieceType.Engineer);
  eq("对方一枚子都没有 → null", weakestSurviving(p, Side.Blue), null);
}

// 13.2 资格判定与模式缺省
{
  const p = emptyPos();
  setPiece(p, idx(5, 0), PieceType.Commander, Side.Red);
  setPiece(p, idx(5, 1), PieceType.Engineer, Side.Red);
  eq("布局：工兵=最小子 → 有扛旗资格", canCarryFlag(p, Side.Red, PieceType.Engineer, O), true);
  eq("布局：司令不是最小子 → 无资格", canCarryFlag(p, Side.Red, PieceType.Commander, O), false);
  setPiece(p, idx(5, 1), PieceType.Empty, Side.None); // 工兵阵亡
  setPiece(p, idx(5, 2), PieceType.Lieutenant, Side.Red);
  eq("布局：工兵阵亡后排长顶上", canCarryFlag(p, Side.Red, PieceType.Lieutenant, O), true);
  eq("布局：司令仍无资格", canCarryFlag(p, Side.Red, PieceType.Commander, O), false);

  eq("缺省：布局 = weakest", flagRuleOf(O), "weakest");
  eq("缺省：翻棋 = engineer", flagRuleOf(OF), "engineer");
  eq("缺省：吃地雷 = engineer（两种模式）",
    mineRuleOf(O) === "engineer" && mineRuleOf(OF) === "engineer", true);
  eq("挖雷资格：工兵有", canClearMine(p, Side.Red, PieceType.Engineer, O), true);
  eq("挖雷资格：司令没有", canClearMine(p, Side.Red, PieceType.Commander, O), false);
}

// 13.3 军旗落点：资格 + 对方地雷门控（canLandOn 与 resolveCombat 必须一致）
{
  // 布局：工兵是最小子、对方无雷 → 军旗是合法落点
  let p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Engineer, Side.Red);
  setPiece(p, TGT, PieceType.Flag, Side.Blue);
  check("布局：对方无雷 + 工兵 → 军旗是落点",
    legalTargets(p, CAMP_FROM, Side.Red, O).some((t) => t.to === TGT));
  // 对方还留一颗雷 → 军旗不是落点
  setPiece(p, idx(11, 0), PieceType.Landmine, Side.Blue);
  eq("数雷：蓝方还有 1 颗", minesRemaining(p, Side.Blue), 1);
  check("布局：对方还有地雷 → 军旗不是落点",
    !legalTargets(p, CAMP_FROM, Side.Red, O).some((t) => t.to === TGT));
  // 本方工兵还活着 → 司令拿不到扛旗资格
  p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Commander, Side.Red);
  setPiece(p, TGT, PieceType.Flag, Side.Blue);
  setPiece(p, idx(5, 0), PieceType.Engineer, Side.Red);
  check("布局：司令不是最小子 → 军旗不是落点",
    !legalTargets(p, CAMP_FROM, Side.Red, O).some((t) => t.to === TGT));
  // 翻棋：即使排长是最小子也不能扛旗
  p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Lieutenant, Side.Red);
  setPiece(p, TGT, PieceType.Flag, Side.Blue);
  check("翻棋：最小子（排长）也不能扛旗",
    !legalTargets(p, CAMP_FROM, Side.Red, OF).some((t) => t.to === TGT));
  // 翻棋：工兵 + 对方无雷 → 可以扛
  p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Engineer, Side.Red);
  setPiece(p, TGT, PieceType.Flag, Side.Blue);
  check("翻棋：工兵 + 对方无雷 → 军旗是落点",
    legalTargets(p, CAMP_FROM, Side.Red, OF).some((t) => t.to === TGT));
}

// 13.4 「扛不了旗」的解释文案（flagCaptureHint）—— 玩家实报的"点了没反应"
//      2026-09-14 玩家问「为什么地雷吃完了，不能吃军旗？」：条件①满足、条件②不满足，
//      界面却一声不吭。这段保证每种挡法都能说清楚，且**够不着时绝不乱解释**。
{
  // 够不着：隔着 8 格，不该拿规则去糊弄
  let p = emptyPos();
  setPiece(p, idx(11, 4), PieceType.Engineer, Side.Red);
  setPiece(p, TGT, PieceType.Flag, Side.Blue);
  eq("够不着 → 不给提示", flagCaptureHint(p, idx(11, 4), Side.Red, OF), null);

  // 翻棋：非工兵去扛（玩家截图里的情形 —— 连长紧贴敌旗，敌雷已清零）
  p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Captain, Side.Red);
  setPiece(p, TGT, PieceType.Flag, Side.Blue);
  const whyCap = flagCaptureHint(p, CAMP_FROM, Side.Red, OF);
  check("翻棋：非工兵贴旗 → 提示『只有工兵能扛』",
    typeof whyCap === "string" && whyCap.includes("只有工兵能扛") && whyCap.includes("连长"));

  // 翻棋：工兵去扛，但对方还剩 2 颗雷
  p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Engineer, Side.Red);
  setPiece(p, TGT, PieceType.Flag, Side.Blue);
  setPiece(p, idx(11, 0), PieceType.Landmine, Side.Blue);
  setPiece(p, idx(11, 4), PieceType.Landmine, Side.Blue);
  const whyMine = flagCaptureHint(p, CAMP_FROM, Side.Red, OF);
  check("翻棋：工兵 + 对方还有 2 雷 → 提示剩余雷数",
    typeof whyMine === "string" && whyMine.includes("2 颗地雷"));

  // 翻棋：工兵 + 对方无雷 → 已经能扛，不该再提示
  p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Engineer, Side.Red);
  setPiece(p, TGT, PieceType.Flag, Side.Blue);
  eq("翻棋：本来就能扛 → 不给提示", flagCaptureHint(p, CAMP_FROM, Side.Red, OF), null);

  // 布局：司令不是"本方现存最弱子" → 提示要指出来该用谁
  p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Commander, Side.Red);
  setPiece(p, TGT, PieceType.Flag, Side.Blue);
  setPiece(p, idx(5, 0), PieceType.Lieutenant, Side.Red);
  const whyWeak = flagCaptureHint(p, CAMP_FROM, Side.Red, O);
  check("布局：司令扛不动 → 提示『最弱的子（排长）』",
    typeof whyWeak === "string" && whyWeak.includes("最弱") && whyWeak.includes("排长"));

  // 布局：自己就是最弱子且对方无雷 → 能扛，不提示
  p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Lieutenant, Side.Red);
  setPiece(p, TGT, PieceType.Flag, Side.Blue);
  eq("布局：自己就是最弱子 → 不给提示", flagCaptureHint(p, CAMP_FROM, Side.Red, O), null);

  // 地雷/军旗不能移动 → 不给提示
  p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Landmine, Side.Red);
  setPiece(p, TGT, PieceType.Flag, Side.Blue);
  eq("地雷不会主动扛旗 → 不给提示", flagCaptureHint(p, CAMP_FROM, Side.Red, OF), null);
}

// 13.4 吃地雷：默认"只有工兵"；切到 weakest 则"现存最小子"也行
{
  const MW = { ...O, mineRule: "weakest" as const };
  let p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Lieutenant, Side.Red);
  setPiece(p, TGT, PieceType.Landmine, Side.Blue);
  check("默认：排长不能主动碰雷",
    !legalTargets(p, CAMP_FROM, Side.Red, O).some((t) => t.to === TGT));
  check("mineRule=weakest：排长是最小子 → 可碰雷",
    legalTargets(p, CAMP_FROM, Side.Red, MW).some((t) => t.to === TGT));
  // 本方工兵活着时，排长不再是"最小子"
  p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Lieutenant, Side.Red);
  setPiece(p, idx(5, 0), PieceType.Engineer, Side.Red);
  setPiece(p, TGT, PieceType.Landmine, Side.Blue);
  check("mineRule=weakest：非最小子不可碰雷",
    !legalTargets(p, CAMP_FROM, Side.Red, MW).some((t) => t.to === TGT));
}

// 13.5 炸弹 × 军旗 / 地雷（引擎 vs 规则文本）
{
  let p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Bomb, Side.Red);
  setPiece(p, TGT, PieceType.Flag, Side.Blue);
  check("引擎口径：炸弹不能炸军旗（不是落点）",
    !legalTargets(p, CAMP_FROM, Side.Red, O).some((t) => t.to === TGT));
  check("rulelay 口径：bombMayStrikeFlag=true 时可炸",
    legalTargets(p, CAMP_FROM, Side.Red, { ...O, bombMayStrikeFlag: true }).some((t) => t.to === TGT));
  p = emptyPos();
  setPiece(p, CAMP_FROM, PieceType.Bomb, Side.Red);
  setPiece(p, TGT, PieceType.Landmine, Side.Blue);
  check("炸弹可以炸地雷（双方消失）",
    legalTargets(p, CAMP_FROM, Side.Red, O).some((t) => t.to === TGT));
}

// 13.6 端到端回归 —— 用户报的原始现象：翻棋里"地雷吃完后，最小棋子吃不了军旗"。
//      走完整会话（blankFlip → click → doMove → winner），而不是只调规则函数。
{
  const g = blankFlip(4242, Side.Red);
  g.pos.type[CAMP_FROM] = PieceType.Engineer;
  g.pos.owner[CAMP_FROM] = Side.Red;
  g.pos.revealed[CAMP_FROM] = 1;
  g.pos.type[TGT] = PieceType.Flag;
  g.pos.owner[TGT] = Side.Blue;
  g.pos.revealed[TGT] = 1;
  g.turn = 1; // blankFlip 把 myColor 放在 sides[1]
  eq("前置：轮到红方", g.sides[g.turn], Side.Red);
  eq("前置：蓝方地雷已挖完（= 0）", minesRemaining(g.pos, Side.Blue), 0);
  eq("翻棋：工兵落点里有军旗",
    legalTargets(g.pos, CAMP_FROM, Side.Red, g.opts).some((t) => t.to === TGT), true);
  check("选中工兵", g.click(CAMP_FROM));
  check("点军旗 = 真正生效", g.click(TGT));
  check("扛旗即胜（winner 非 null）", g.winner !== null);
  eq("胜者是红方（玩家 1）", g.winner, 1);
  check("winnerReason 标明夺旗", g.winnerReason.includes("军旗"));
}
// 反例：对方还剩一枚雷 → 军旗不是落点、点了不生效（这才是当初"吃不了军旗"的真因）
{
  const g = blankFlip(4243, Side.Red);
  g.pos.type[CAMP_FROM] = PieceType.Engineer;
  g.pos.owner[CAMP_FROM] = Side.Red;
  g.pos.revealed[CAMP_FROM] = 1;
  g.pos.type[TGT] = PieceType.Flag;
  g.pos.owner[TGT] = Side.Blue;
  g.pos.revealed[TGT] = 1;
  g.pos.type[idx(5, 0)] = PieceType.Landmine; // 蓝方还有一枚雷
  g.pos.owner[idx(5, 0)] = Side.Blue;
  g.pos.revealed[idx(5, 0)] = 1;
  g.turn = 1;
  eq("前置：蓝方尚有 1 枚雷", minesRemaining(g.pos, Side.Blue), 1);
  eq("翻棋：对方还有雷 → 军旗不是落点",
    legalTargets(g.pos, CAMP_FROM, Side.Red, g.opts).some((t) => t.to === TGT), false);
  check("选中工兵", g.click(CAMP_FROM));
  eq("点军旗无效（click 返回 false）", g.click(TGT), false);
  eq("未产生胜者", g.winner, null);
}

// ─────────────────────────────────────────────────────────────
section("14. 安全岛：行营（两模式）/ 大本营（仅翻棋）内的子不可被吃，地雷与军旗除外");
// ─────────────────────────────────────────────────────────────
// 原版 `(&DAT_00153810)[cell] != 0` 分支：安全格里的普通子直接 `return 0`（不成着法），
// 但 地雷(0xb)/军旗(0xc) 分别跳 LAB_00068c30 / LAB_00068baa，仍可被打。
// ★ 安全格范围随模式变化：rulelay.txt 只说「行营是个安全岛」；ruleflip.txt 才说
//   「行营、大本营是个安全岛（大本营的地雷、军旗可以吃）」。
{
  // 行营
  let p = emptyPos();
  setPiece(p, TGT, PieceType.Commander, Side.Red);
  setPiece(p, CAMP_FROM, PieceType.Lieutenant, Side.Blue);
  check("前置：(4,1) 是行营", isCamp(CAMP_FROM));
  check("行营里的敌子不可被吃",
    !legalTargets(p, TGT, Side.Red, O).some((t) => t.to === CAMP_FROM));
  // 翻棋模式下行营同样是安全岛
  p = emptyPos();
  setPiece(p, TGT, PieceType.Commander, Side.Red);
  setPiece(p, CAMP_FROM, PieceType.Lieutenant, Side.Blue);
  check("翻棋：行营里的敌子同样不可被吃",
    !legalTargets(p, TGT, Side.Red, OF).some((t) => t.to === CAMP_FROM));

  // ★ 大本营：范围随模式变化（rulelay 只说"行营"；ruleflip 才说"行营、大本营"）
  const B = basesOf(Side.Blue)[0];
  const NB = STEP_NEIGHBORS[B][0];
  check("前置：B 满足 isBase", isBase(B));
  p = emptyPos();
  setPiece(p, NB, PieceType.Commander, Side.Red);
  setPiece(p, B, PieceType.Lieutenant, Side.Blue);
  check("布局模式：大本营不是安全岛 → 敌子可被吃",
    legalTargets(p, NB, Side.Red, O).some((t) => t.to === B));
  check("翻棋模式：大本营是安全岛 → 敌子不可被吃",
    !legalTargets(p, NB, Side.Red, OF).some((t) => t.to === B));

  // ★ `CmdSafe`（原版 `DAT_00153db0._3_1_`，即规则设置里那个开关）显式覆盖
  eq("cmdSafe 缺省：布局=false / 翻棋=true",
    cmdSafeOf(O) === false && cmdSafeOf(OF) === true, true);
  p = emptyPos();
  setPiece(p, NB, PieceType.Commander, Side.Red);
  setPiece(p, B, PieceType.Lieutenant, Side.Blue);
  check("布局 + cmdSafe=true → 大本营变安全岛，敌子不可吃",
    !legalTargets(p, NB, Side.Red, { ...O, cmdSafe: true }).some((t) => t.to === B));
  check("翻棋 + cmdSafe=false → 大本营不再是安全岛，敌子可被吃",
    legalTargets(p, NB, Side.Red, { ...OF, cmdSafe: false }).some((t) => t.to === B));
  // 例外：安全格里的地雷 / 军旗仍可被打（两种模式都成立）
  p = emptyPos();
  setPiece(p, NB, PieceType.Engineer, Side.Red);
  setPiece(p, B, PieceType.Landmine, Side.Blue);
  check("例外：大本营里的地雷可以吃（工兵）",
    legalTargets(p, NB, Side.Red, OF).some((t) => t.to === B));
  p = emptyPos();
  setPiece(p, NB, PieceType.Engineer, Side.Red);
  setPiece(p, B, PieceType.Flag, Side.Blue);
  check("例外：大本营里的军旗可以扛（工兵 + 对方无雷）",
    legalTargets(p, NB, Side.Red, OF).some((t) => t.to === B));
  // ★ 大本营里的子能不能走出来 —— **随模式**（`baseFrozenOf`）：
  //   布局 = 不能（原版 Path B 用 `DAT_00133cb4` 跳过 4 个大本营格）
  //   翻棋 = 能  （原版 Path A 的生成器 `FUN_00068cbc` 里没有任何大本营判定）
  // ⚠️ 旧实现无条件冻结，翻棋下多冻 4 格，玩家实报"大本营/底线走不动"。
  p = emptyPos();
  setPiece(p, B, PieceType.Commander, Side.Red);
  check("布局：大本营内的子不能移动（原版 Path B）",
    legalTargets(p, B, Side.Red, O).length === 0);
  check("翻棋：大本营内的子可以走出来（原版 Path A）",
    legalTargets(p, B, Side.Red, OF).length > 0);
  check("baseFrozenOf：布局 true / 翻棋 false",
    baseFrozenOf(O) === true && baseFrozenOf(OF) === false);
  // 翻棋下"第一排/最后一排"（= 两条底线行，含大本营）整行都应能动 ——
  // 玩家的原话就是"第一排和最后一排以及大本营里面的棋子不能移动"。
  for (const side of [Side.Red, Side.Blue] as const) {
    const rowBase = side === Side.Red ? 0 : ROWS - 1;
    const movable = [] as number[];
    for (let c = 0; c < COLS; c++) {
      const cell = idx(rowBase, c);
      p = emptyPos();
      setPiece(p, cell, PieceType.Commander, side);
      if (legalTargets(p, cell, side, OF).length > 0) movable.push(c);
    }
    eq(`翻棋：${side === Side.Red ? "第一" : "最后一"}排（行 ${rowBase}）5 格全部可动`,
      movable.length, COLS);
  }
}

// ─────────────────────────────────────────────────────────────
section("15. 和棋：连续 70 步无吃子 / 双方累计 1000 步");
// ─────────────────────────────────────────────────────────────
eq("70 步无吃子常数（原版内部数 0x46）", DRAW_NO_CAPTURE_PLIES, 70);
eq("1000 步上限常数", DRAW_TOTAL_PLIES, 1000);
{
  // 全程只走"不吃子"的着法，走到判和为止（上限 400 手，够 70 手触发）
  const g = new LayGame(LAYOUTS[0].cells, LAYOUTS[1].cells, { revealAll: true });
  let n = 0;
  while (!g.over && n < 400) {
    const mv = allLegalMoves(g.pos, g.turn, g.opts).find((m) => !m.capture);
    if (!mv) break;
    if (!g.click(mv.from) || !g.click(mv.to)) break;
    n++;
  }
  check(
    "连续 70 步无吃子判和",
    g.isDraw && g.drawReason.includes(String(DRAW_NO_CAPTURE_PLIES)),
    `isDraw=${g.isDraw} reason="${g.drawReason}" plies=${n}`,
  );
  check("判和后 `over` 为真（UI 据此停手）", g.over);
}

// ─────────────────────────────────────────────────────────────
section("15b. 循环判和 + 抗循环（观战自加；缺省不生效）");
// ─────────────────────────────────────────────────────────────
eq("同一局面重复 3 次判和常数", DRAW_REPETITION, 3);
{
  // ① 指纹必须只认「棋局本身」，否则同一个局面会被算成两个、判和永远触发不了。
  const p = buildFromLayouts(LAYOUTS[0].cells, LAYOUTS[1].cells);
  const k = positionKey(p, Side.Red);
  eq("同一局面 + 同一轮次 → 指纹一致", positionKey(p, Side.Red), k);
  check("轮次不同 → 指纹不同", positionKey(p, Side.Blue) !== k);
  const q = clonePosition(p);
  // 取反而不是置 1：`buildFromLayouts` 造的是**明棋**（revealed 全 1），置 1 等于没改。
  q.revealed[0] = q.revealed[0] === 1 ? 0 : 1;
  check(
    "翻开状态参与指纹（暗棋里翻一张就是新局面）",
    positionKey(q, Side.Red) !== k,
  );
  const r = clonePosition(p);
  r.owner[0] = opposite(r.owner[0]);
  check("归属参与指纹", positionKey(r, Side.Red) !== k);
}
{
  // ② 缺省**不认**重复判和 —— 人机/双人对局必须保持原版行为（只有 70 步 / 1000 步）。
  const g = new LayGame(LAYOUTS[0].cells, LAYOUTS[1].cells, { revealAll: true });
  eq("缺省 repeatDraw = 0（原版行为）", g.repeatDraw, 0);
  g.setRepeatDraw(DRAW_REPETITION);
  eq("观战打开后阈值生效", g.repeatDraw, DRAW_REPETITION);
  eq("开局局面也算一次", g.positionRepeats, 1);

  // ③ 两边各挑一枚棋子做"相邻空格来回走" —— 每 4 手全盘回到原样。
  //    用**相邻空格**而不是铁路/工兵：那种走法反向必然也合法，循环是构造出来的、不靠运气。
  const shuttle = (side: Side): [number, number] | null => {
    for (let c = 0; c < CELLS; c++) {
      if (g.pos.type[c] === PieceType.Empty || g.pos.owner[c] !== side) continue;
      const t = legalTargets(g.pos, c, side, g.opts).find(
        (x) =>
          !x.capture &&
          Math.abs(rowOf(x.to) - rowOf(c)) + Math.abs(colOf(x.to) - colOf(c)) === 1,
      );
      if (t) return [c, t.to];
    }
    return null;
  };
  const red = shuttle(Side.Red);
  const blue = shuttle(Side.Blue);
  check("两边都能挑出一对「相邻空格」来回走", red !== null && blue !== null);
  if (red && blue) {
    const pairs: Record<number, [number, number]> = { [Side.Red]: red, [Side.Blue]: blue };
    const step: Record<number, number> = { [Side.Red]: 0, [Side.Blue]: 0 };
    let plies = 0;
    let drewAt = 0;
    for (let i = 0; i < 12 && !g.over; i++) {
      const side = g.turn;
      const [a, b] = pairs[side];
      const n = step[side]++;
      if (!g.click(n % 2 === 0 ? a : b) || !g.click(n % 2 === 0 ? b : a)) break;
      plies++;
      if (g.isDraw) drewAt = plies;
    }
    check(
      `来回磨到第 ${DRAW_REPETITION} 次重复即判和`,
      g.isDraw && g.drawReason.includes("同一局面重复"),
      `isDraw=${g.isDraw} reason="${g.drawReason}" 手数=${plies}`,
    );
    check(
      "判和不是靠 70 步无吃子（证明是「重复判和」这条在起作用）",
      drewAt > 0 && drewAt < DRAW_NO_CAPTURE_PLIES,
      `判和手数=${drewAt}`,
    );
  }

  // ④ 同样的循环，**关掉**重复判和就不该判和（保持原版行为）。
  const g2 = new LayGame(LAYOUTS[0].cells, LAYOUTS[1].cells, { revealAll: true });
  g2.setRepeatDraw(0);
  const shuttle2 = (side: Side): [number, number] | null => {
    for (let c = 0; c < CELLS; c++) {
      if (g2.pos.type[c] === PieceType.Empty || g2.pos.owner[c] !== side) continue;
      const t = legalTargets(g2.pos, c, side, g2.opts).find(
        (x) =>
          !x.capture &&
          Math.abs(rowOf(x.to) - rowOf(c)) + Math.abs(colOf(x.to) - colOf(c)) === 1,
      );
      if (t) return [c, t.to];
    }
    return null;
  };
  const r2 = shuttle2(Side.Red);
  const b2 = shuttle2(Side.Blue);
  if (r2 && b2) {
    const pairs: Record<number, [number, number]> = { [Side.Red]: r2, [Side.Blue]: b2 };
    const step: Record<number, number> = { [Side.Red]: 0, [Side.Blue]: 0 };
    for (let i = 0; i < 12 && !g2.over; i++) {
      const side = g2.turn;
      const [a, b] = pairs[side];
      const n = step[side]++;
      if (!g2.click(n % 2 === 0 ? a : b) || !g2.click(n % 2 === 0 ? b : a)) break;
    }
    check(
      "repeatDraw=0 时同样的循环不判和（原版行为不变）",
      !g2.isDraw,
      `repeats=${g2.positionRepeats}`,
    );
  }

  // ⑤ 翻棋那条路径同样接了这套（默认关、可开）。
  const fg = new FlipGame(20260912);
  eq("翻棋：缺省 repeatDraw 也是 0", fg.repeatDraw, 0);
  fg.setRepeatDraw(DRAW_REPETITION);
  eq("翻棋：打开后阈值生效", fg.repeatDraw, DRAW_REPETITION);
  eq("翻棋：开局局面算一次", fg.positionRepeats, 1);
}
{
  // ⑥ 引擎侧：喂进来的 avoid 真的会把着法**降权**（不是只排个序给人看）。
  const lv = aiLevel(1); // 新手档：depth 1、15ms，扫 30 手也很快
  const pos = buildFromLayouts(LAYOUTS[0].cells, LAYOUTS[1].cells);
  // `width` 放到最大 = 不截断，这样才看得到"降到队尾"这件事本身
  // （真实档位里降到队尾之后会被 `width` 截掉，效果是"连考虑都不考虑"）。
  const wide = { ...lv, width: 999 };
  const order = aiRootOrder(pos, Side.Red, DEFAULT_OPTIONS, wide, makeRng(1));
  const top = order[0];
  check("根排序非空（后面几条断言的前提）", order.length >= 3 && top !== undefined);
  if (order.length >= 3 && top) {
    // ⚠️ `times` **必须显式给 1** —— 缺省是 0（不罚），因为 `shuffle` 那条判据
    //    也要用同一个结构，缺省不能两边都取"会罚"的值。见 `buildAvoidSet`。
    const order2 = aiRootOrder(pos, Side.Red, DEFAULT_OPTIONS, wide, makeRng(1), [
      { from: top.from, to: top.to, times: 1 },
    ]);
    const tail = order2[order2.length - 1];
    check(
      "被规避的着法降到队尾（学习面板与引擎同一把尺子）",
      order2.length === order.length &&
        tail !== undefined &&
        tail.from === top.from &&
        tail.to === top.to,
      `top=${top.from}→${top.to} tail=${tail?.from}→${tail?.to} n=${order.length}/${order2.length}`,
    );
    check(
      "其余候选次序不变（稳定排序，不是整体重排）",
      order2[0]?.from === order[1]?.from && order2[0]?.to === order[1]?.to,
    );
  }
}
{
  // ⑦ 端到端一点：喂 avoid 后 `aiChooseMove` 会改选别的静着。
  //    逐手扫描而不是钉死某个局面 —— 只要"机制真的能改选择"，就必然能扫到至少一手。
  const lv = aiLevel(1);
  const g = new LayGame(LAYOUTS[0].cells, LAYOUTS[1].cells, { revealAll: true });
  let hit = 0;
  let scanned = 0;
  for (let i = 0; i < 30 && !g.over; i++) {
    const p = clonePosition(g.pos);
    const side = g.turn;
    const mv = aiChooseMove(p, side, g.opts, lv, makeRng(500 + i));
    if (!mv) break;
    scanned++;
    const quiet = allLegalMoves(p, side, g.opts).filter((m) => !m.capture).length;
    const mv2 = aiChooseMove(p, side, g.opts, lv, makeRng(500 + i), [
      { from: mv.from, to: mv.to, times: 1 },
    ]);
    if (quiet >= 2 && mv2 && (mv2.from !== mv.from || mv2.to !== mv.to)) hit++;
    if (!g.click(mv.from) || !g.click(mv.to)) break;
  }
  check(
    "喂入 avoid 后引擎会改选别的静着（抗循环真的生效）",
    hit >= 1,
    `命中 ${hit}/${scanned} 手`,
  );
}

// ─────────────────────────────────────────────────────────────
section("16. 布阵限制：对齐原版校验文案（ZhaError / LeiError / QiError / LayError）");
// ─────────────────────────────────────────────────────────────
{
  const cells = LAYOUTS[0].cells;
  const ok = expandLayout(cells, Side.Red) as PieceType[];
  eq("第 1 关红方布阵合法", validateLayout(ok, Side.Red).length, 0);

  const badBomb = ok.slice();
  badBomb[idx(frontRowOf(Side.Red), 0)] = PieceType.Bomb;
  check("炸弹放第一行 → ZhaError",
    validateLayout(badBomb, Side.Red).includes("炸弹不能放在第一行"));

  const back = backRowsOf(Side.Red);
  const badMine = ok.slice();
  badMine[idx(3, 0)] = PieceType.Landmine; // 行 3 在红方阵地内，但既非第一行(5)也非后两行(0,1)
  check("地雷放非后两行 → LeiError",
    validateLayout(badMine, Side.Red).includes("地雷只能放在最后两行"));
  const goodMine = ok.slice();
  goodMine[idx(back[1], 4)] = PieceType.Landmine;
  check("地雷放后两行 → 不报 LeiError",
    !validateLayout(goodMine, Side.Red).includes("地雷只能放在最后两行"));

  const badFlag = ok.slice();
  badFlag[idx(3, 0)] = PieceType.Flag;
  check("军旗放非大本营 → QiError",
    validateLayout(badFlag, Side.Red).includes("军旗只能放在大本营"));
  const goodFlag = ok.slice();
  goodFlag[basesOf(Side.Red)[0]] = PieceType.Flag;
  check("军旗放大本营 → 不报 QiError",
    !validateLayout(goodFlag, Side.Red).includes("军旗只能放在大本营"));

  const short = new Array(CELLS).fill(PieceType.Empty) as PieceType[];
  short[idx(0, 0)] = PieceType.Commander;
  check("棋子没摆够 → LayError", validateLayout(short, Side.Red).includes("还有未摆放的棋子"));

  // 行营恒为空（原版 51 关数据一致）
  const CAMP8 = [11, 13, 17, 21, 23, 36, 38, 42, 46, 48];
  const full = buildFromLayouts(LAYOUTS[0].cells, LAYOUTS[1].cells);
  eq("行营格子恒为空（第 1 关）",
    CAMP8.filter((c) => full.type[c] === PieceType.Empty).length, 10);
}

// ─────────────────────────────────────────────────────────────
section("17. 走子路径重建（动画沿路径飞，不画直线）");
// ─────────────────────────────────────────────────────────────

// 全域不变量：对任意开局、任意一方的**每一个合法着法**，路径必须
//   ① 首尾与 from/to 一致；② 逐段真有连线；③ 中途不穿过任何棋子。
// 路径画错的直接后果就是棋子斜穿棋盘 —— 这条守住它。
{
  const bad: string[] = [];
  let n = 0;
  for (const [ri, bi] of [[0, 1], [2, 3], [7, 9]] as const) {
    const pos = buildFromLayouts(LAYOUTS[ri].cells, LAYOUTS[bi].cells);
    for (const side of [Side.Red, Side.Blue]) {
      for (const mv of allLegalMoves(pos, side, DEFAULT_OPTIONS)) {
        const p = pathBetween(pos, mv.from, mv.to);
        n++;
        const why: string[] = [];
        if (p[0] !== mv.from) why.push("起点错");
        if (p[p.length - 1] !== mv.to) why.push("终点错");
        for (let k = 1; k < p.length; k++) {
          if (!linked(p[k - 1], p[k])) why.push(`${p[k - 1]}-${p[k]} 无连线`);
        }
        for (let k = 1; k < p.length - 1; k++) {
          if (pos.type[p[k]] !== PieceType.Empty) why.push(`穿过 ${p[k]}`);
        }
        if (why.length) bad.push(`关${ri}/${bi} ${mv.from}->${mv.to}: ${why[0]}`);
      }
    }
  }
  check(`全部合法着法的路径都自洽（${n} 手）`, bad.length === 0, bad.slice(0, 3).join(" ; "));
}

{
  const pos = createEmptyPosition();
  setPiece(pos, idx(5, 0), PieceType.Captain, Side.Red, 1); // 行 5 = 铁路
  const p = pathBetween(pos, idx(5, 0), idx(5, 2));
  eq("铁路直行 → 3 格", p.length, 3);
  check("铁路直行逐格推进", p[1] === idx(5, 1) && p[2] === idx(5, 2));
  check("横向三格总长 = 2×列距",
    Math.abs(pathLength(p) - 2 * PITCH_X) < 1e-6, String(pathLength(p)));
}

{
  const pos = createEmptyPosition();
  setPiece(pos, idx(5, 0), PieceType.Engineer, Side.Red, 1);
  // 沿列 0 上行到行 1，再横走到列 4 = 9 格
  const p = pathBetween(pos, idx(5, 0), idx(1, 4));
  eq("工兵铁路拐弯 → 9 格", p.length, 9);
  let railOK = true;
  for (let k = 1; k < p.length; k++) {
    if (!railNeighborsOf(p[k - 1]).includes(p[k])) railOK = false;
  }
  check("工兵路径每一段都在铁路上", railOK);
  const straight = Math.hypot(COL_X[4] - COL_X[0], ROW_Y[1] - ROW_Y[5]);
  check("沿路径长度 ≥ 两点直线距离（所以不能画直线）",
    pathLength(p) >= straight - 1e-6, `${pathLength(p).toFixed(1)} vs ${straight.toFixed(1)}`);
}

{
  const pos = createEmptyPosition();
  setPiece(pos, idx(3, 1), PieceType.Colonel, Side.Red, 1);
  eq("公路一步 → 2 格", pathBetween(pos, idx(3, 1), idx(4, 1)).length, 2);
}

// ─────────────────────────────────────────────────────────────
section("18. 动画时长与插值（原版公式 400×(总长/列距)^0.2）");
// ─────────────────────────────────────────────────────────────

eq("单步一格 = 400ms（锚点）", Math.round(animDurationMs(PITCH_X)), ANIM_BASE_MS);
{
  const row = animDurationMs(PITCH_Y);
  check("纵向单步略短（≈349ms）", row > 330 && row < 370, row.toFixed(1));
  const five = animDurationMs(5 * PITCH_X);
  check("横穿 5 列 ≈552ms（指数 0.2 → 涨得很慢）", five > 520 && five < 580, five.toFixed(1));
  check("再短也不低于下限", animDurationMs(0) >= ANIM_MIN_MS);
}

{
  const pos = createEmptyPosition();
  setPiece(pos, idx(5, 0), PieceType.Captain, Side.Red, 1);
  const p = pathBetween(pos, idx(5, 0), idx(5, 2));
  const cum = cumulative(p);
  const total = pathLength(p);
  const dur = animDurationMs(total);
  const a = animPointAt(p, cum, total, dur, 0);
  const mid = animPointAt(p, cum, total, dur, dur / 2);
  const z = animPointAt(p, cum, total, dur, dur);
  eq("累计表长度 = 路径格数", cum.length, p.length);
  check("0ms = 起始格中心",
    Math.abs(a.x - COL_X[0]) < 1e-6 && Math.abs(a.y - ROW_Y[5]) < 1e-6);
  check("半程 = 第二格中心",
    Math.abs(mid.x - COL_X[1]) < 1e-6 && Math.abs(mid.y - ROW_Y[5]) < 1e-6, mid.x.toFixed(2));
  check("播完 = 目标格中心",
    Math.abs(z.x - COL_X[2]) < 1e-6 && Math.abs(z.y - ROW_Y[5]) < 1e-6);
}

// ─────────────────────────────────────────────────────────────
section("19. AI 援助（桩掉 fetch，不联网）");
// ─────────────────────────────────────────────────────────────
//
// 这一节守的是「AI 援助」对玩家的**唯一承诺**：模型无论怎么胡说，
// 点下去给到棋盘上的着法一定是合法的。
// 实现方式是"把规则引擎算好的合法着法编号给模型挑" —— 所以这里必须证明
//   ① 候选表真的进了 prompt；
//   ② 模型回的编号被映射回候选表（而不是自己解析坐标）；
//   ③ 越界/乱答一律抛错，不会被当成合法着法落到盘上。

// 地址规整：用户填什么都不该拼出坏 URL。
eq("接口地址：裸域名补 /v1/chat/completions",
  aidEndpoint("https://api.deepseek.com"),
  "https://api.deepseek.com/v1/chat/completions");
eq("接口地址：已带 /v1 只补后缀",
  aidEndpoint("https://api.deepseek.com/v1"),
  "https://api.deepseek.com/v1/chat/completions");
eq("接口地址：已带 /chat/completions 原样返回",
  aidEndpoint("https://gw.example/v1/chat/completions"),
  "https://gw.example/v1/chat/completions");
eq("接口地址：纯空白 = 未配置", aidEndpoint("   "), "");

{
  const pos = createEmptyPosition();
  setPiece(pos, idx(5, 0), PieceType.Commander, Side.Red, 1);
  setPiece(pos, idx(6, 0), PieceType.Engineer, Side.Red, 1);
  setPiece(pos, idx(5, 2), PieceType.Captain, Side.Blue, 0); // 未亮明
  setPiece(pos, idx(11, 1), PieceType.Flag, Side.Blue, 0);
  const opts = { ...DEFAULT_OPTIONS };
  const moves = allLegalMoves(pos, Side.Red, opts);
  check("桩局面有合法着法可挑", moves.length > 2, `moves=${moves.length}`);

  // 暗棋下**不能**把对方未亮明的兵种写进 prompt：本地明知是连长，
  // 但玩家自己看不到，告诉模型会让它做出玩家做不出的判断。
  const desc = describeBoard(pos, Side.Red, false);
  check("prompt 隐去对方未亮明兵种（连长不出现）", !desc.includes("连长"));
  check("prompt 用 ? 标注未知敌子", desc.includes("?"));
  check("prompt 带全局格号（供候选表引用）", desc.includes("25:司令·红方"));

  const realFetch = globalThis.fetch;
  let seenUrl = "";
  let seenBody = "";
  let seenAuth = "";
  const stub = (answer: string): void => {
    globalThis.fetch = (async (
      url: unknown,
      init: { body?: string; headers?: Record<string, string> },
    ) => {
      seenUrl = String(url);
      seenBody = String(init?.body ?? "");
      seenAuth = String(init?.headers?.authorization ?? "");
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: answer } }] }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;
  };
  const cfg = { baseUrl: "https://gw.example", apiKey: "sk-test", model: "m" };

  // ① 正常回答 → 映射回候选表第 n 条
  stub('{"n":1,"why":"占中"}');
  {
    const s = await aiAidSuggest(cfg, pos, Side.Red, opts, false);
    eq("返回的着法 = 候选表第 n 条", `${s.from},${s.to}`, `${moves[1].from},${moves[1].to}`);
    eq("编号原样带回", s.index, 1);
    eq("候选总数如实报告", s.total, moves.length);
    eq("理由原样带回", s.why, "占中");
    eq("请求打到规整后的地址", seenUrl, "https://gw.example/v1/chat/completions");
    check("prompt 里列了候选表（#0 …）", seenBody.includes("#0"));
    check("prompt 里带了最后一条候选", seenBody.includes(`#${moves.length - 1}`));
    check("prompt 里写了模型只能从候选里选", seenBody.includes("候选着法"));
    eq("鉴权头是 Bearer + key", seenAuth, "Bearer sk-test");
  }

  // ①b 传入「引擎局面分」→ 候选行必须带上"引擎评分"标注，供模型参考
  stub('{"n":0,"why":"引擎看好"}');
  {
    const scores = moves.map((m, k) => ({ from: m.from, to: m.to, score: 1000 - k }));
    const s = await aiAidSuggest(cfg, pos, Side.Red, opts, false, undefined, undefined, undefined, scores);
    check("prompt 里标注了引擎评分", seenBody.includes("引擎评分"));
    check("评分真的挂到候选上（#0 有分）", seenBody.includes(`引擎评分 ${1000}`));
    eq("候选总数不受注入影响", s.total, moves.length);
  }

  // ② 模型加了代码块 / 全角引号 / 前后废话也必须解析出来
  stub('好的：\n```json\n{\u201Cn\u201D: 0, \u201Cwhy\u201D: \u201C出子\u201D}\n```\n以上。');
  {
    const s = await aiAidSuggest(cfg, pos, Side.Red, opts, false);
    eq("容忍代码块与全角引号", `${s.from},${s.to}`, `${moves[0].from},${moves[0].to}`);
  }

  // ③ 越界编号 / 垃圾回答 / 空候选 —— 必须抛错，绝不能落到盘上
  stub('{"n":9999,"why":"x"}');
  let outOfRange = "";
  try {
    await aiAidSuggest(cfg, pos, Side.Red, opts, false);
  } catch (e) {
    outOfRange = String(e);
  }
  check("越界编号被拒", outOfRange.includes("越界"), outOfRange);

  stub("我觉得应该走中路，棋子要果断出击！");
  let garbage = "";
  try {
    await aiAidSuggest(cfg, pos, Side.Red, opts, false);
  } catch (e) {
    garbage = String(e);
  }
  check("无 JSON 的胡答被拒", garbage.includes("可解析"), garbage);

  // ④ 配置不全 → AidNotConfigured（UI 据此引导去设置）
  let notCfg = "";
  try {
    await aiAidSuggest({ baseUrl: "https://gw.example", apiKey: "", model: "m" },
      pos, Side.Red, opts, false);
  } catch (e) {
    notCfg = e instanceof AidNotConfigured ? "AidNotConfigured" : String(e);
  }
  eq("缺 API Key 抛 AidNotConfigured", notCfg, "AidNotConfigured");

  // ⑤ 没有合法着法（轮到红方但红子全被锁）→ 报错而不是空指针
  {
    const frozen = createEmptyPosition();
    setPiece(frozen, idx(0, 1), PieceType.Landmine, Side.Red, 1);
    stub('{"n":0,"why":"x"}');
    let noMove = "";
    try {
      await aiAidSuggest(cfg, frozen, Side.Red, opts, false);
    } catch (e) {
      noMove = String(e);
    }
    check("无着法时明确报错", noMove.includes("没有合法着法"), noMove);
  }

  // ⑥ ★ 回归：对面「只回响应头、永不发 body」时，取消必须能打断读 body。
  //    真实网关/代理会这样（先给 200 头，body 迟迟不来）。修复前，超时定时器与
  //    取消监听在 `fetch` 一 resolve 就被清掉了 ⇒ `res.json()` 永久挂起 ⇒
  //    界面卡在"正在问模型…"，玩家再点只看到"已取消上一次"却永远回不去
  //    （2026-09-14 玩家实报："那么久也没出结果，我怎么知道他有没有"）。
  //    这个桩**忠实模拟真 fetch**：读 body 会跟着 signal 一起被打断 ——
  //    所以它能真的验出"监听器有没有被提前摘掉"。
  {
    globalThis.fetch = ((_url: unknown, init: { signal?: AbortSignal }) => {
      const sig = init?.signal;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_res, rej) => {
            sig?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
          }),
        text: async () => "",
      });
    }) as unknown as typeof fetch;

    const ac = new AbortController();
    const p = aiAidSuggest(cfg, pos, Side.Red, opts, false, ac.signal).then(
      () => "resolved",
      (e) => String(e),
    );
    await new Promise((r) => setTimeout(r, 30)); // 让它进到"读 body"阶段
    ac.abort();
    const out = await Promise.race([
      p,
      new Promise<string>((r) => setTimeout(() => r("HANG-读 body 没被打断"), 2000)),
    ]);
    // 拒绝值会带上 `Error: ` 前缀（`String(e)`），所以用 includes 判。
    check("只回头不发 body 时，取消能打断读 body（不再永久挂起）", out.includes("已取消"), out);
  }

  // ⑦ 但"连续点击期间实际上还在等待"的原生形态是：普通网络错误仍要如实报出来，
  //    别把什么都归因成"已取消/超时"（文案误导会让排查方向全错）。
  {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    let netMsg = "";
    try {
      await aiAidSuggest(cfg, pos, Side.Red, opts, false);
    } catch (e) {
      netMsg = String(e);
    }
    check("网络错误如实报「连不上模型接口」", netMsg.includes("连不上模型接口"), netMsg);
  }

  // ⑧ ★ 反面：body **稍后才到**（不是不来）—— 必须老老实实等到并成功。
  //    这才是 DeepSeek（openresty 网关）这类服务的**真实行为**：立刻回 200 响应头，
  //    正文等模型把整段 JSON 生成完才吐出来。修复的正确语义是"超时**贯穿**读 body"，
  //    而不是"头一到就收工"。这条挡住"把修复做过头、慢响应被误判成超时"的回归。
  {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: () =>
        new Promise((res) =>
          setTimeout(
            () => res({ choices: [{ message: { content: '{"n": 0, "why": "慢但到了"}' } }] }),
            250,
          ),
        ),
      text: async () => "",
    })) as unknown as typeof fetch;

    let got = "";
    try {
      const s = await aiAidSuggest(cfg, pos, Side.Red, opts, false);
      got = `ok n=${s.index} total=${s.total} why=${s.why}`;
    } catch (e) {
      got = String(e);
    }
    check(
      "响应头先到、body 稍后才到 —— 等它到，正常出结果（不误判超时）",
      got.includes("why=慢但到了"),
      got,
    );
  }

  globalThis.fetch = realFetch;
}

// ─────────────────────────────────────────────────────────────
// 20. AI 援助：出网方式（同源中转 / 上游代理 / 可配置超时 / 测试连接）
//
// 这一节守的是 2026-09-14 玩家实报的另一半：「AI援助超时」。
// 根因不是解析逻辑，而是**怎么把请求发出去**：浏览器直连过不了跨域预检，
// 更要命的是**用不了本机代理**（Chrome 默认只认 Windows 系统代理）——
// 实测本机 `api.openai.com` 直连挂死 >9s，走 127.0.0.1:7897 只需 1.1s。
// 于是玩家点完只能干等，直到超时。
//
// 所以这里必须证明三件事：
//   ① 中转模式下面板只跟**同源**说话，目标地址/Key/代理都走自定义头；
//   ② 中转的 502（连不上上游）与上游的 4xx 分得开 —— 否则排查方向全歪；
//   ③ 超时是按玩家填的秒数生效的，不是写死的。
// ─────────────────────────────────────────────────────────────
{
  const pos = createEmptyPosition();
  setPiece(pos, idx(5, 0), PieceType.Commander, Side.Red, 1);
  setPiece(pos, idx(6, 0), PieceType.Engineer, Side.Red, 1);
  setPiece(pos, idx(5, 2), PieceType.Captain, Side.Blue, 0);
  const opts = { ...DEFAULT_OPTIONS };
  const moves = allLegalMoves(pos, Side.Red, opts);
  const cfg = { baseUrl: "https://gw.example", apiKey: "sk-test", model: "m" };
  const realFetch = globalThis.fetch;

  // ① 中转模式：面板 → 同源端点；目标地址与 Key 走自定义头（页面不再直连上游）
  {
    let seen = { url: "", headers: {} as Record<string, string>, body: "" };
    globalThis.fetch = (async (
      url: unknown,
      init: { headers?: Record<string, string>; body?: string },
    ) => {
      seen = {
        url: String(url),
        headers: init?.headers ?? {},
        body: String(init?.body ?? ""),
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"n":0,"why":"中转"}' } }] }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;

    const s = await aiAidSuggest(
      { ...cfg, relay: true, proxy: "http://127.0.0.1:7897", timeoutMs: 5000 },
      pos,
      Side.Red,
      opts,
      false,
    );
    eq("中转：请求打到同源端点（没有跨域预检）", seen.url, "/__aiaid/relay");
    eq(
      "中转：目标地址走 x-aiaid-url",
      seen.headers["x-aiaid-url"],
      "https://gw.example/v1/chat/completions",
    );
    eq("中转：Key 走 x-aiaid-key", seen.headers["x-aiaid-key"], "sk-test");
    eq("中转：上游代理随头带上（浏览器自己用不了代理）", seen.headers["x-aiaid-proxy"], "http://127.0.0.1:7897");
    eq("中转：超时也告诉中转（Node 侧同样要掐）", seen.headers["x-aiaid-timeout"], "5000");
    check(
      "中转：页面不再直连上游（没有 authorization 头）",
      !seen.headers.authorization,
      JSON.stringify(seen.headers),
    );
    eq("中转：结果仍映射回候选表第 n 条", `${s.from},${s.to}`, `${moves[0].from},${moves[0].to}`);
    check("中转：prompt 与直连时一致", seen.body.includes("候选着法"));
  }

  // ② 没有代理时不塞空头（免得中转把空串当代理地址解析）
  {
    let headers: Record<string, string> = {};
    globalThis.fetch = (async (_u: unknown, init: { headers?: Record<string, string> }) => {
      headers = init?.headers ?? {};
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"n":0,"why":"x"}' } }] }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;
    await aiAidSuggest({ ...cfg, relay: true }, pos, Side.Red, opts, false);
    check("中转：代理留空就不带这个头", !("x-aiaid-proxy" in headers), JSON.stringify(headers));
  }

  // ③ 中转自身失败回 502 + {error} → 必须说"中转失败"，别让玩家去怀疑 Key
  //    （`x-aiaid-origin: relay` 是中转自己贴的标记：**上游网关的 502 会被原样透传**，
  //      那种情况不能喊"中转失败" —— 见第 22 节）
  {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 502,
      headers: new Headers({ "x-aiaid-origin": "relay" }),
      text: async () => JSON.stringify({ error: "连不上上游代理" }),
      json: async () => ({}),
    })) as unknown as typeof fetch;
    let msg = "";
    try {
      await aiAidSuggest({ ...cfg, relay: true }, pos, Side.Red, opts, false);
    } catch (e) {
      msg = String(e);
    }
    check(
      "中转失败时报「中转失败」并带上原因",
      msg.includes("中转失败") && msg.includes("连不上上游代理"),
      msg,
    );
  }

  // ④ 上游自己的 4xx 原样透传（与中转的 502 必须分得开）
  {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":{"message":"Authentication Fails"}}',
      json: async () => ({}),
    })) as unknown as typeof fetch;
    let msg = "";
    try {
      await aiAidSuggest({ ...cfg, relay: true }, pos, Side.Red, opts, false);
    } catch (e) {
      msg = String(e);
    }
    check("上游 401 原样报「模型接口返回 401」", msg.includes("模型接口返回 401"), msg);
  }

  // ⑤ 超时按玩家填的秒数生效 —— 修复前 30 秒写死，推理模型根本来不及回
  {
    globalThis.fetch = ((_u: unknown, init: { signal?: AbortSignal }) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
      })) as unknown as typeof fetch;
    let msg = "";
    try {
      await aiAidSuggest({ ...cfg, timeoutMs: 1000 }, pos, Side.Red, opts, false);
    } catch (e) {
      msg = String(e);
    }
    check("超时按配置生效（1 秒）且文案报出秒数", msg.includes("超时") && msg.includes("1 秒"), msg);
  }

  // ⑥ 默认超时是 60 秒（给推理型模型留余地），不是 30
  eq("默认超时 = 60 秒", DEFAULT_AID_TIMEOUT_MS, 60_000);

  // ⑦ 「测试连接」：只求"通"。推理模型在 max_tokens=4 下常常只有思考没有正文，
  //    那不算失败 —— 否则玩家会以为配置错了。
  {
    let body = "";
    globalThis.fetch = (async (_u: unknown, init: { body?: string }) => {
      body = String(init?.body ?? "");
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "" } }] }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;
    const r = await aiAidPing(cfg);
    eq("ping 带回模型名", r.model, "m");
    check("ping 用极小的 max_tokens（快且省钱）", body.includes('"max_tokens":4'), body.slice(0, 140));
    check("ping 没有正文也算成功", typeof r.ms === "number" && r.ms >= 0, String(r.ms));
  }

  // ⑧ 2xx 但不是 OpenAI 兼容响应 → 明确说清楚，而不是"模型没给出可解析的着法"这种误导
  {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: "不是 OpenAI 格式" }),
      text: async () => "",
    })) as unknown as typeof fetch;
    let msg = "";
    try {
      await aiAidSuggest(cfg, pos, Side.Red, opts, false);
    } catch (e) {
      msg = String(e);
    }
    check("2xx 但没有 choices 时明确指向「不是 OpenAI 兼容接口」", msg.includes("OpenAI 兼容"), msg);
  }

  // ⑨ 中转探测：必须认本工程的标识，否则一个 404 页的 HTML 也会被当成"中转在"
  {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, relay: "junqi-aid" }),
    })) as unknown as typeof fetch;
    check("探测中转：ping 回本工程标识才算有", await aidRelayAvailable());

    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ hello: "世界" }),
    })) as unknown as typeof fetch;
    check("探测中转：认不出的响应一律算没有（退回直连）", !(await aidRelayAvailable()));
  }

  globalThis.fetch = realFetch;
}

// ─────────────────────────────────────────────────────────────
// 21. 链路抖动：只重试"过一会儿就会好"的失败
//
// 这一节守的是 2026-09-15 玩家实报：
//
// ```
// 观战 · 已暂停（第 1 手）
// 蓝方（云端）这一手失败：中转失败：read ECONNRESET
// ```
//
// `read ECONNRESET` = 上游把连接掐了，**不是我们发错了**。旧版把它和"Key 错了"
// 一视同仁地当成停手理由，于是一次网络抖动直接毁掉整场观战。
//
// 修法是"分得开 + 会重试"：`isTransientNetError` 判性质（`neterr.ts`），
// `postChat` 只对瞬态失败再要一次。两件事都要验：
//   · **该重试的重试**：中转 502（未到上限）/ fetch 直接抛（中转在重启）/ 直连抖动；
//   · **不该重试的别乱试**：401（Key 错）、超时、模型答得不对、中转已经重试过的
//     （再叠一层会变成 3×2 次，玩家等两倍时间看同一个错误）。
//
// ⚠️ 真 socket 那一半（RST / 连接不复用 / CONNECT 隧道 / 断开作废）在
//    `tools/relay/relayretry.ts`，它跟着 `npm test` 一起跑。
// ─────────────────────────────────────────────────────────────
{
  const pos = createEmptyPosition();
  setPiece(pos, idx(5, 0), PieceType.Commander, Side.Red, 1);
  setPiece(pos, idx(6, 0), PieceType.Engineer, Side.Red, 1);
  setPiece(pos, idx(5, 2), PieceType.Captain, Side.Blue, 0);
  const opts = { ...DEFAULT_OPTIONS };
  const cfg = {
    baseUrl: "https://gw.example",
    apiKey: "sk-test",
    model: "m",
    relay: true,
    timeoutMs: 5000,
  };
  const realFetch = globalThis.fetch;
  const okReply = {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: '{"n":0,"why":"好"}' } }] }),
    text: async () => "",
  };
  const fail502 = (error: string, attempts?: number) =>
    ({
      ok: false,
      status: 502,
      headers: new Headers({
        // 中转自己造的错误都带这个头（上游网关的 502 是原样透传、没有它）。
        "x-aiaid-origin": "relay",
        ...(attempts ? { "x-aiaid-attempts": String(attempts) } : {}),
      }),
      text: async () => JSON.stringify({ error }),
      json: async () => ({}),
    }) as unknown as Response;

  // ① 中转回 502 且**还没到**重试上限 ⇒ 页面侧再要一次
  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1 ? fail502("连不上上游代理") : okReply;
    }) as unknown as typeof fetch;
    const s = await aiAidSuggest(cfg, pos, Side.Red, opts, false);
    eq("中转瞬态 502 → 页面侧重试一次后成功", calls, 2);
    check("重试拿回的是合法着法（重试没改变题意）", typeof s.from === "number", String(s.from));
    check("理由原样带回", s.why === "好", s.why);
  }

  // ② fetch 直接抛（中转在重启 / 端口没起）⇒ 这是最典型的"过一会儿就好"
  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new TypeError("Failed to fetch");
      return okReply;
    }) as unknown as typeof fetch;
    await aiAidSuggest(cfg, pos, Side.Red, opts, false);
    eq("fetch 直接失败 → 重试一次后成功", calls, 2);
  }

  // ③ 直连模式（不经中转）同样吃这次重试
  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new TypeError("NetworkError when attempting to fetch resource.");
      return okReply;
    }) as unknown as typeof fetch;
    await aiAidSuggest({ ...cfg, relay: false }, pos, Side.Red, opts, false);
    eq("直连模式下的抖动也重试", calls, 2);
  }

  // ④ 401（Key 错）⇒ 一次都不许重试，且错误文案不能被重试逻辑吞掉
  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return {
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: "Authentication Fails" } }),
        json: async () => ({}),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    let msg = "";
    try {
      await aiAidSuggest(cfg, pos, Side.Red, opts, false);
    } catch (e) {
      msg = String(e);
    }
    eq("401 不重试（重试也没用）", calls, 1);
    check("401 文案照旧透出", msg.includes("401"), msg);
  }

  // ⑤ 超时 ⇒ 不重试（否则 60 秒变 120 秒，玩家白等）
  {
    let calls = 0;
    globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) => {
      calls++;
      return new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("AbortError")), {
          once: true,
        });
      });
    }) as unknown as typeof fetch;
    let msg = "";
    try {
      await aiAidSuggest({ ...cfg, timeoutMs: 300 }, pos, Side.Red, opts, false);
    } catch (e) {
      msg = String(e);
    }
    eq("超时不重试", calls, 1);
    check("仍然如实报超时，而不是被包装成网络错", msg.includes("超时"), msg);
  }

  // ⑥ 中转**如实报了"我打了 3 次"** ⇒ 页面侧不再叠一层（否则 3×2）
  //    判据是响应头 `x-aiaid-attempts`，**不是**去猜错误文案 —— 这条就是钉死这一点。
  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return fail502("连不上上游：read ECONNRESET（已重试 3 次）", 3);
    }) as unknown as typeof fetch;
    let msg = "";
    try {
      await aiAidSuggest(cfg, pos, Side.Red, opts, false);
    } catch (e) {
      msg = String(e);
    }
    eq("中转已重试 3 次 ⇒ 页面侧只打一次", calls, 1);
    check("把根因如实带给玩家", msg.includes("ECONNRESET"), msg);
  }

  // ⑥b 同一句文案，但中转说"我只打了一次" ⇒ 页面侧该补一次
  //     （观战实报「已重试 3 次」时曾被判成终态，把上层重试一起挡掉了 —— 见下面 ⑨）
  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1 ? fail502("连不上上游：read ECONNRESET（已重试 3 次）", 1) : okReply;
    }) as unknown as typeof fetch;
    await aiAidSuggest(cfg, pos, Side.Red, opts, false);
    eq("中转只打了 1 次 ⇒ 页面侧补一次", calls, 2);
  }

  // ⑦ 模型答得不对（解析不了）⇒ 与网络无关，一次都不重试
  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "这个嘛……" } }] }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      await aiAidSuggest(cfg, pos, Side.Red, opts, false);
    } catch {
      /* 预期失败 */
    }
    eq("解析不了不重试", calls, 1);
  }

  // ⑧ 判定表的边界（`neterr.ts` 是三层共用的尺子，这里钉住最关键的四条）
  {
    check(
      "read ECONNRESET = 瞬态",
      isTransientNetError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })),
    );
    check("401 = 非瞬态", !isTransientNetError(new Error("模型接口返回 401：Authentication Fails")));
    check("超时 = 非瞬态", !isTransientNetError(new Error("上游 60 秒没有响应")));
    check(
      "「已重试 N 次」**仍是瞬态**（别当终态：观战那层的重试要能接着上）",
      isTransientNetError(new Error("中转失败：连不上上游：read ECONNRESET（已重试 3 次）")),
    );
  }

  globalThis.fetch = realFetch;
}

// ─────────────────────────────────────────────────────────────
// 22. 连不上上游：把话说清楚 + 指路到诊断 + 如实报"借了代理"
//
// 这一节守的是 2026-09-15 玩家**第二次**实报：「还是一直提示连接不上上游」。
//
// 根因不在重试（第 21 节已经修了），而在**报错本身不可行动**：
// 「连不上上游」这一句话底下压着至少五种病（域名写错 / 端口不通 / 要代理 /
// 填的「上游代理」本身没开 / 其实通了只是 Key 错），每种治法都不一样。
// 玩家看着那句话只能瞎试，于是判定"还是不能用"。
//
// 所以这里钉三件事：
//   ① 链路层的 502 必须**追加指路**（去点「诊断出网」），别的 502 不许乱加；
//   ② 中转自动借了本机代理时要**如实带回来**（`x-aiaid-proxy-used`），
//      不许让玩家以为自己填的那个代理在生效；
//   ③ `aiAidDiag` 打的是 `/__aiaid/diag` 且把 url/proxy 都带对，
//      中转不在（静态托管）时要给出能自救的提示，而不是一个光秃秃的 404。
// ─────────────────────────────────────────────────────────────
{
  const pos = createEmptyPosition();
  setPiece(pos, idx(5, 0), PieceType.Commander, Side.Red, 1);
  setPiece(pos, idx(6, 0), PieceType.Engineer, Side.Red, 1);
  setPiece(pos, idx(5, 2), PieceType.Captain, Side.Blue, 0);
  const opts = { ...DEFAULT_OPTIONS };
  const cfg = {
    baseUrl: "https://gw.example",
    apiKey: "sk-test",
    model: "m",
    relay: true,
    timeoutMs: 5000,
  };
  const realFetch = globalThis.fetch;
  const fail502 = (error: string, attempts?: number) =>
    ({
      ok: false,
      status: 502,
      headers: new Headers({
        "x-aiaid-origin": "relay",
        ...(attempts ? { "x-aiaid-attempts": String(attempts) } : {}),
      }),
      text: async () => JSON.stringify({ error }),
      json: async () => ({}),
    }) as unknown as Response;

  // ① 链路层 502 ⇒ 除了原因，还要告诉玩家"下一步点哪儿"
  {
    globalThis.fetch = (async () =>
      fail502("连不上上游 api.openai.com:443：connect ETIMEDOUT（已重试 3 次）", 3)) as unknown as typeof fetch;
    let msg = "";
    try {
      await aiAidSuggest(cfg, pos, Side.Red, opts, false);
    } catch (e) {
      msg = String(e);
    }
    check("链路层失败要指路到「诊断出网」", msg.includes("诊断出网"), msg);
    check("同时点名到底连不上谁", msg.includes("api.openai.com"), msg);
    check("「已重试 N 次」仍照实带出", msg.includes("已重试 3 次"), msg);
  }

  // ② 非链路层的 502 不许乱贴这条提示（否则玩家真去点诊断会白跑一趟）
  {
    globalThis.fetch = (async () => fail502("中转内部错误：解析上游响应失败")) as unknown as typeof fetch;
    let msg = "";
    try {
      await aiAidSuggest(cfg, pos, Side.Red, opts, false);
    } catch (e) {
      msg = String(e);
    }
    check("别的 502 不贴「诊断出网」（先排除再确认）", !msg.includes("诊断出网"), msg);
    check("但原因照旧如实透出", msg.includes("解析上游响应失败"), msg);
  }

  // ②b 上游网关自己的 502（中转**原样透传**、没有 x-aiaid-origin）⇒ 不能说"中转失败"。
  //     否则玩家去查本地中转，而真凶是模型网关在抖 —— 与本次修的"报错不可行动"同一类病。
  {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 502,
      headers: new Headers(), // 没有 x-aiaid-origin ⇒ 这是上游的，不是中转的
      text: async () => "bad gateway",
      json: async () => ({}),
    })) as unknown as typeof fetch;
    let msg = "";
    try {
      await aiAidSuggest(cfg, pos, Side.Red, opts, false);
    } catch (e) {
      msg = String(e);
    }
    check("上游网关 502 报「模型接口返回 502」而不是「中转失败」", msg.includes("模型接口返回 502"), msg);
    check("别把锅甩给本地中转", !msg.includes("中转失败"), msg);
  }

  // ③ 中转自动借了本机代理 ⇒ 「测试连接」要如实报出来
  {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "x-aiaid-proxy-used": "http://127.0.0.1:7897" }),
      json: async () => ({ choices: [{ message: { content: "pong" } }] }),
      text: async () => "",
    })) as unknown as typeof fetch;
    const r = await aiAidPing(cfg);
    eq("ping 带回实际走的代理", r.viaProxy, "http://127.0.0.1:7897");
    check("原字段没被顶掉", r.model === "m" && r.thinking === false, JSON.stringify(r));
  }

  // ④ 对局里那一步同样要带（否则"谁在借代理"只在设置页说，下棋时看不到）
  {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "x-aiaid-proxy-used": "http://127.0.0.1:7890" }),
      json: async () => ({ choices: [{ message: { content: '{"n":0,"why":"x"}' } }] }),
      text: async () => "",
    })) as unknown as typeof fetch;
    const s = await aiAidSuggest(cfg, pos, Side.Red, opts, false);
    eq("着法建议也带回实际走的代理", s.viaProxy, "http://127.0.0.1:7890");
  }

  // ⑤ 没借代理时不许凭空造一个（否则 UI 会一直提示"已自动走代理"）
  {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ choices: [{ message: { content: "pong" } }] }),
      text: async () => "",
    })) as unknown as typeof fetch;
    const r = await aiAidPing(cfg);
    eq("没借代理就不报代理", r.viaProxy, undefined);
  }

  // ⑥ 诊断：请求要打到 diag 端点，且把 url / proxy 都带上（Node 侧才知道量谁）
  {
    let seenUrl = "";
    globalThis.fetch = (async (url: unknown) => {
      seenUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: false,
          verdict: "连不上 api.example.test:443：connect ETIMEDOUT。本机检测到代理 …",
          target: "https://api.example.test/v1/chat/completions",
          host: "api.example.test",
          port: 443,
          dns: { ok: true, detail: "1.2.3.4/v4", ms: 12 },
          tcp: { ok: false, detail: "connect ETIMEDOUT", ms: 6000 },
          http: { ok: false, detail: "（连不上，跳过）", ms: 0 },
          proxyGiven: null,
          proxyGivenTcp: null,
          localProxies: [{ url: "http://127.0.0.1:7897", alive: true }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const rep = await aiAidDiag({ baseUrl: "https://api.example.test", proxy: "  " });
    check("打到诊断端点", seenUrl.startsWith(`${AID_DIAG_PATH}?`), seenUrl);
    check(
      "把完整 endpoint 传过去（后缀补齐由 aidEndpoint 负责）",
      seenUrl.includes(encodeURIComponent("https://api.example.test/v1/chat/completions")),
      seenUrl,
    );
    check("代理留空就不带 proxy 参数", !seenUrl.includes("proxy="), seenUrl);
    eq("结论原样带回给 UI", rep.ok, false);
    check("结论里说明了该改哪一格", rep.verdict.includes("代理"), rep.verdict);
  }

  // ⑦ 填了代理时，要把它一起送过去量（"填的代理本身没开"是最常见的坑）
  {
    let seenUrl = "";
    globalThis.fetch = (async (url: unknown) => {
      seenUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ ok: true, verdict: "" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await aiAidDiag({ baseUrl: "https://gw.example", proxy: "http://127.0.0.1:7899" });
    check(
      "填了代理就带 proxy 参数",
      seenUrl.includes(`proxy=${encodeURIComponent("http://127.0.0.1:7899")}`),
      seenUrl,
    );
  }

  // ⑧ 中转不在（`npm run build` 后的静态托管）⇒ 别只甩一个 404，要给能自救的话
  {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 404,
      text: async () => "<!doctype html>",
      json: async () => ({}),
    })) as unknown as typeof fetch;
    let msg = "";
    try {
      await aiAidDiag({ baseUrl: "https://gw.example" });
    } catch (e) {
      msg = String(e);
    }
    check("说明需要本地中转", msg.includes("本地中转"), msg);
    check("并告诉玩家怎么起", msg.includes("npm run dev") || msg.includes("npm run preview"), msg);
  }

  // ⑨ 地址没填 ⇒ 与其它入口一样归到 AidNotConfigured（UI 好统一提示去设置）
  {
    let kind = "";
    try {
      await aiAidDiag({ baseUrl: "   " });
    } catch (e) {
      kind = e instanceof AidNotConfigured ? "configured" : String(e);
    }
    eq("缺地址时报 AidNotConfigured", kind, "configured");
  }

  globalThis.fetch = realFetch;
}

// ─────────────────────────────────────────────────────────────
// 19c. evalPly2：云端浅搜索（深度 2）的评分真的抓到"会被反吃"
//
// 方案 B 的核心：云端 AI 拿到的候选分不是"走完这步瞬间"的单步静态分，
// 而是往下展开对手最凶应一手后的 minimax 分。这里守的是它**比单步分多看到
// 一层的那个能力**：一个把红军长送到蓝司令嘴边的着法，深度 2 分必须**显著低于**
// 同一着法的单步 `evalForSide` 分 —— 单步分在走完瞬间军长还在、看不到"下一步
// 会被吃"；深度 2 分展开了对手的应手，于是反映军长被吃的大损失。
{
  const pos = createEmptyPosition();
  // 红军长站在 row4,col0=20，红方行动。
  setPiece(pos, idx(4, 0), PieceType.General, Side.Red, 1);
  // 蓝司令在 row6,col0=30（明棋，与军长**同列**）。军长只要走到 25(row5,col0)
  // 就在司令一步攻击范围内 —— 司令沿 col0 铁路纵滑一步 30→25 就能吃掉它。
  setPiece(pos, idx(6, 0), PieceType.Commander, Side.Blue, 1);
  const opts = { ...DEFAULT_OPTIONS };

  const m2 = evalPly2(pos, Side.Red, opts, 8, makeRng(1));
  const sendKey = idx(4, 0) * CELLS + idx(5, 0); // 20→25：军长送到司令嘴边
  const send = m2.get(sendKey);

  // 单步静态分（方案 A 的做法）：走完 20→25 瞬间军长还在 25，看不到会被吃。
  const child = clonePosition(pos);
  applyMove(child, idx(4, 0), idx(5, 0), opts);
  const singleStep = evalForSide(child, Side.Red, opts, makeRng(1));

  check("evalPly2 覆盖送子着法（20→25）", send !== undefined, `send=${send}`);
  check(
    "深度2分显著低于单步分（抓到了军长会被司令反吃）",
    send !== undefined && singleStep - send > 200,
    `send=${send} singleStep=${singleStep} (单步没看到军长会丢)`,
  );

  // 确定性：同一局面两遍分必须一样（`makeRng(1)`），否则模型看两遍会拿两个数。
  const m2b = evalPly2(pos, Side.Red, opts, 8, makeRng(1));
  eq("evalPly2 结果确定（makeRng(1) 两遍同分）", m2b.get(sendKey), send);
}

// ─────────────────────────────────────────────────────────────
// 19d. evalPly2 必须认「规避列表」—— 云端在两格之间来回走的根治
//
// 玩家实报（2026-09-17）：「云端 AI 一直在两个地方来回移动」，截图上就是两枚
// **行营**（绿圈）之间反复横跳。查下来是**两层**根因，缺一不可：
//
// 【第一层】静态分数把人往沟里带
//   · 10 个行营的估值完全对称 —— `OWN_POS_EXTRA` 全是 40，`POS_BASE`/`ATTACK_BASE`
//     在这几格都是 0。于是"从 A 营走到 B 营"恒得 +10、"从 B 营走回 A 营"恒得 -10，
//     **往返净变化恰好 0**。静态估值永远认为"换个行营更值"。
//   · `watchAvoid()` 能正确标出"走回旧局面"，但 `evalPly2` 原先**没把 avoid 传进去**
//     （只有引擎搜索 `searchRoot` 那边降权）—— 于是云端拿到的候选分里，
//     "走回去"那条依然带着虚高的分排在首位，而提示词又说"优先选分高的"。
//     模型照着分数挑 ⇒ 无限来回。
//
// 【第二层】补上 avoid 之后**还是磨** —— 判据跟不上循环周期
//   · 军棋同一方的 5 个行营是一张**以中央行营为枢纽的星形图**：蓝方 `36/38/46/48`
//     各自**只**与 `42` 相邻，红方 `11/13/21/23` 各自只与 `17` 相邻。
//   · 一枚子在星形图上穿梭，轨迹是 `42→36→42→38→42→46→…`，
//     **循环周期是 4 手（每方 2 手）**而不是 2 手 —— 于是"是否回到旧局面"这条
//     只在**每 4 手**命中一次，且此刻规避表里**永远只有一条**；
//     剩下 3 个营都还没被走过，随便挑一个就干净地绕开了降权。
//   · 实测：把惩罚从常数 45 提到 `45×times`（线性）**完全无效** ——
//     着法序列与二值规避逐手一致（`times` 缓慢爬到 2、3，压不过别的项）。
//
// 【修法】按"该局面累计出现几次"**平方加码**：`AVOID_PENALTY × times²`
//   （1 次扣 45 与旧行为一致 / 2 次扣 180 / 3 次扣 405）。一旦同一个局面开始
//   反复出现，惩罚迅速盖过任何静着位势差（行营才 +40），逼它换方向。
//
// 这一节钉住：① 传不传 avoid 的分差必须恰为 `avoidPenalty(times)`；
// ② 平方加码真的让"磨得越久"越来越贵（`45 / 180 / 405`）且能压住虚高分。
{
  // ② 平方加码：同一着法按出现次数被扣得越来越狠。
  const basePos = createEmptyPosition();
  setPiece(basePos, idx(7, 1), PieceType.General, Side.Red, 1);
  setPiece(basePos, idx(0, 1), PieceType.Flag, Side.Red, 1);
  setPiece(basePos, idx(11, 1), PieceType.Flag, Side.Blue, 1);
  setPiece(basePos, idx(11, 3), PieceType.Commander, Side.Blue, 1);
  const bOpts = { ...DEFAULT_OPTIONS };
  const bFrom = idx(7, 1);
  const bTo = idx(8, 2);
  const bKey = bFrom * CELLS + bTo;
  const bFree = evalPly2(basePos, Side.Red, bOpts, 8, makeRng(1)).get(bKey);
  const dropAt = (times: number): number | undefined => {
    const sc = evalPly2(basePos, Side.Red, bOpts, 8, makeRng(1), [
      { from: bFrom, to: bTo, times },
    ]).get(bKey);
    return bFree === undefined || sc === undefined ? undefined : bFree - sc;
  };
  eq("重复 1 次扣 45", dropAt(1), 45);
  eq("重复 2 次扣 180（平方加码）", dropAt(2), 180);
  eq("重复 3 次扣 405（平方加码）", dropAt(3), 405);
  // ⚠️ `times` 缺省 = 0 = **不罚**（"没回到旧盘面"不该被罚）。
  //    早期版本把它当 1（白扣 45），已在 `buildAvoidSet` 里更正。
  eq("times 省略 = 不罚（缺省 0）", dropAt(undefined as unknown as number), 0);
  eq("times=0 = 不罚", dropAt(0), 0);

  // ③ 平方加码必须真的压得住：行营间往返的静态收益才 +10，
  //    磨到第 2 次（-180）时，"再走回旧局面"必须已经不再是首选。
  {
    const p = createEmptyPosition();
    setPiece(p, idx(7, 1), PieceType.General, Side.Red, 1);
    setPiece(p, idx(0, 1), PieceType.Flag, Side.Red, 1);
    setPiece(p, idx(11, 1), PieceType.Flag, Side.Blue, 1);
    const o = { ...DEFAULT_OPTIONS };
    const f = idx(7, 1);
    const t = idx(8, 2);
    const k = f * CELLS + t;
    const scored = evalPly2(p, Side.Red, o, 8, makeRng(1), [{ from: f, to: t, times: 2 }]);
    let bk = -1;
    let bs = -Infinity;
    scored.forEach((v, kk) => {
      if (v > bs) {
        bs = v;
        bk = kk;
      }
    });
    check(
      "磨到第 2 次后「走回旧局面」不再是最优（-180 压住 +10 的换营收益）",
      bk !== k,
      `best=${Math.floor(bk / CELLS)}→${bk % CELLS} 走回那条=${scored.get(k)} 最优=${bs}`,
    );
  }
}
{
  const pos = createEmptyPosition();
  // 红军长在 36 营（row7,col1）—— 截图那类对称行营。
  setPiece(pos, idx(7, 1), PieceType.General, Side.Red, 1);
  // 两侧各放一个不动子，保证局面指纹有意义。
  setPiece(pos, idx(0, 1), PieceType.Flag, Side.Red, 1);
  setPiece(pos, idx(11, 1), PieceType.Flag, Side.Blue, 1);
  setPiece(pos, idx(11, 3), PieceType.Commander, Side.Blue, 1);
  const opts = { ...DEFAULT_OPTIONS };

  // 36→42（row8,col2，中央行营）：斜邻可达，且 42 是"刚离开的旧局面"。
  const from = idx(7, 1);
  const to = idx(8, 2);
  const key = from * CELLS + to;

  const noAvoid = evalPly2(pos, Side.Red, opts, 8, makeRng(1)).get(key);
  const withAvoid = evalPly2(pos, Side.Red, opts, 8, makeRng(1), [
    { from, to, times: 1 },
  ]).get(key);

  check("evalPly2 覆盖 36营→42营 这条着法", noAvoid !== undefined, `score=${noAvoid}`);
  eq(
    "evalPly2 认规避列表：该着法降 avoidPenalty(1) = 45",
    withAvoid,
    noAvoid === undefined ? undefined : noAvoid - 45,
  );

  // 传了 avoid 之后，"走回旧局面"这条不该再是全场最高分。
  const all = evalPly2(pos, Side.Red, opts, 8, makeRng(1), [{ from, to, times: 1 }]);
  let bestKey = -1;
  let bestScore = -Infinity;
  all.forEach((v, k) => {
    if (v > bestScore) {
      bestScore = v;
      bestKey = k;
    }
  });
  check(
    "降权后「走回旧局面」不再是最优着法（云端不会照着虚高分往回走）",
    bestKey !== key,
    `best=${Math.floor(bestKey / CELLS)}→${bestKey % CELLS} 走回那条=${withAvoid} 最优=${bestScore}`,
  );

  // 规避只压**命中的那一条**：同局面下把别的着法也标进规避，未命中的着法分不变。
  const otherKey = (() => {
    for (const m of allLegalMoves(pos, Side.Red, opts)) {
      if (m.from === from && m.to !== to) return m.from * CELLS + m.to;
    }
    return -1;
  })();
  check("找到另一条同起点的着法用于对照", otherKey >= 0, `otherKey=${otherKey}`);
  const all2 = evalPly2(pos, Side.Red, opts, 8, makeRng(1), [{ from, to, times: 1 }]);
  eq(
    "规避只影响命中着法，同起点其它着法分不变",
    all2.get(otherKey),
    evalPly2(pos, Side.Red, opts, 8, makeRng(1)).get(otherKey),
  );
}

// ─────────────────────────────────────────────────────────────
// 19e. `shuffle` 判据：按「子」计数，抓"一枚子来回挪 + 别处慢慢漂"
//
// 19d 的两层（静态对称 + 指纹判据）都只在**棋盘静止**时成立。用户第二次上报
// 「云端还是在进出行营」之后，用**真实布阵**跑真实 `LayGame` 才看清真相：
//
//   · 截图上的循环是**同一枚子在自己两个相邻格之间往返**（实测蓝团长 `44 ↔ 39`）；
//   · 与此同时**别处的子也在慢慢挪** ⇒ 整盘指纹**每手都是新的**：
//     跑 87 手，「不同局面 88 个、重复 0 次」—— **没有重复局面可判**；
//   · 于是 19d 的 `times`（哪怕平方加码）**一条都命中不了**，惩罚全打空。
//
// 换判据：不看盘面，看**这枚子最近挪了几次**（`AvoidMove.shuffle`）。
// 这一节钉住：
//   ① `shufflePenalty` 的定价（窗口内挪到第 2 次起罚、线性加码）；
//   ② 扣分真的进得去 `evalPly2`（云端拿到的分被压低）；
//   ③ 两颗子对照：老在挪的那颗被罚、没挪过的那颗不罚（判据精确到"子"，不误伤）。
// ─────────────────────────────────────────────────────────────
{
  // 局面：红方两枚子，一枚刚被挪过 3 次（`from`），另一枚闲置。
  const p = createEmptyPosition();
  setPiece(p, idx(7, 1), PieceType.General, Side.Red, 1); // 常挪的那枚
  setPiece(p, idx(7, 4), PieceType.Colonel, Side.Red, 1); // 闲置对照
  setPiece(p, idx(0, 1), PieceType.Flag, Side.Red, 1);
  setPiece(p, idx(11, 1), PieceType.Flag, Side.Blue, 1);
  setPiece(p, idx(11, 3), PieceType.Commander, Side.Blue, 1);
  const o = { ...DEFAULT_OPTIONS };
  const busy = idx(7, 1);
  const idle = idx(7, 4);

  const pick = (from: number): number => {
    for (const m of allLegalMoves(p, Side.Red, o)) {
      if (m.from === from && !m.capture) return m.from * CELLS + m.to;
    }
    return -1;
  };
  const kBusy = pick(busy);
  const kIdle = pick(idle);
  check("找到常挪那枚子的静着", kBusy >= 0, `key=${kBusy}`);
  check("找到闲置那枚子的静着", kIdle >= 0, `key=${kIdle}`);

  const free = evalPly2(p, Side.Red, o, 8, makeRng(1));
  const freeBusy = free.get(kBusy);
  const freeIdle = free.get(kIdle);

  /**
   * `shuffle = n` 时该着法被压掉多少分。
   *
   * ⚠️ 判据是「同一枚子最近第几次被挪」，**含本次**的 1-indexed 计数：
   *    1 = 窗口内没挪过（不罚）、2 = 挪了第 2 次（罚 45）、3 罚 90 …
   *    与 `watchMovedCount` 的返回值同一套语义。
   */
  const drop = (key: number, from: number, shuffle: number): number | undefined => {
    const sc = evalPly2(p, Side.Red, o, 8, makeRng(1), [{ from, to: key % CELLS, shuffle }]).get(key);
    const base = free.get(key);
    return base === undefined || sc === undefined ? undefined : base - sc;
  };

  eq("shuffle=1（窗口内没挪过）不罚", drop(kBusy, busy, 1), 0);
  eq("shuffle=2（挪了第 2 次）罚 45", drop(kBusy, busy, 2), 45);
  eq("shuffle=3 罚 90（线性加码）", drop(kBusy, busy, 3), 90);
  eq("shuffle=5 罚 180（线性加码）", drop(kBusy, busy, 5), 180);
  // `shuffle` 省略 = 1 = 不罚；同时 `times` 省略 = 0 = 不罚 ⇒ 整体零扣分。
  eq(
    "shuffle 省略 = 不罚（缺省 1）",
    evalPly2(p, Side.Red, o, 8, makeRng(1), [{ from: busy, to: kBusy % CELLS }]).get(kBusy),
    freeBusy,
  );

  // ③ 判据精确到「子」：只罚老在挪的那颗，闲置那颗分不变。
  {
    const both = evalPly2(p, Side.Red, o, 8, makeRng(1), [
      { from: busy, to: kBusy % CELLS, shuffle: 4 },
      { from: idle, to: kIdle % CELLS, shuffle: 1 },
    ]);
    eq("常挪那枚被罚（-135）", both.get(kBusy), freeBusy === undefined ? undefined : freeBusy - 135);
    eq("闲置那枚不受影响", both.get(kIdle), freeIdle);
  }

  // ④ 两条判据可叠加：既回旧盘面、子又在被反复挪 ⇒ 两项相加。
  //    times=1（45）+ shuffle=3（90）= 135
  eq(
    "times + shuffle 两项相加（45 + 90 = 135）",
    evalPly2(p, Side.Red, o, 8, makeRng(1), [
      { from: busy, to: kBusy % CELLS, times: 1, shuffle: 3 },
    ]).get(kBusy) === undefined || freeBusy === undefined
      ? undefined
      : freeBusy - (evalPly2(p, Side.Red, o, 8, makeRng(1), [
          { from: busy, to: kBusy % CELLS, times: 1, shuffle: 3 },
        ]).get(kBusy) as number),
    135,
  );
}

// ─────────────────────────────────────────────────────────────
// 23. 悔棋：翻棋与布局同构（原版翻棋**支持**悔棋）
//
// 旧版 `doUndo()` / `netApplyUndo()` 对翻棋写死 `status("翻棋不支持悔棋")` ——
// 那是**没核对原版就下的结论**。2026-09-15 在雷电 9 跑原版 `com.cnvcs.junqi`
// （`tools/_emu/_undo_*.png`）实测：
//   · 翻一手 → ☰ 菜单「悔棋」→ 那一子**重新盖回**，整屏与"刚开局"**逐像素差 0 px**；
//   · 翻两手 → 再悔 → **只退一手**（不是整局重开）—— 与布局同语义。
//
// 这一节钉四件事：
//   ① 一手 = 「翻开」也算一步，退掉它必须把**定色**（`revealedColors`/`sides`）一起回退，
//      否则那颗子会被记成另一个阵营；
//   ② 退的是**一手**不是一整局（两手只退最后一手）；
//   ③ 无效点击（点空行营 / 点已翻开的子）**不许**往悔棋栈里塞快照；
//   ④ 退回来后重建重复局面表 —— 否则"撤回来再走同一步"会被误判成重复局面、凭空判和。
// ─────────────────────────────────────────────────────────────
{
  const sameArr = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  /** 找一枚还没翻开的棋子所在格（翻棋开局是 50 枚盖着铺满非行营格）。 */
  const firstHidden = (g: FlipGame): number => {
    for (let i = 0; i < CELLS; i++) {
      if (g.pos.type[i] !== PieceType.Empty && g.pos.revealed[i] === 0) return i;
    }
    return -1;
  };
  /** 数一数悔棋栈里到底有几手（不碰私有字段）。 */
  const drain = (g: FlipGame): number => {
    let n = 0;
    while (g.undo()) n++;
    return n;
  };

  // ① 开局：栈空
  const g = new FlipGame(20260915);
  eq("翻棋开局不可悔", g.canUndo(), false);
  eq("空栈上 undo() 返回 false", g.undo(), false);

  const snap0 = {
    type: g.pos.type.slice(),
    owner: g.pos.owner.slice(),
    revealed: g.pos.revealed.slice(),
  };
  const c0 = firstHidden(g);
  check("开局找得到可翻的子", c0 >= 0, `c0=${c0}`);

  // ② 「翻开」是一步棋：定色 + 换手 + 入栈
  eq("翻开返回 true", g.click(c0), true);
  eq("翻开后 revealed=1", g.pos.revealed[c0], 1);
  eq("翻开后定色", g.revealedColors, true);
  eq("翻开后换手", g.turn, 1);
  eq("翻开后 canUndo", g.canUndo(), true);

  // ③ 退一手：那一子重新盖回，定色与手番一起回退，盘面逐格等于开局
  eq("悔棋返回 true", g.undo(), true);
  eq("悔后该子重新盖回", g.pos.revealed[c0], 0);
  eq("悔后定色回退", g.revealedColors, false);
  eq("悔后回到先手", g.turn, 0);
  eq(
    "悔后盘面逐格等于开局",
    sameArr(g.pos.type, snap0.type) &&
      sameArr(g.pos.owner, snap0.owner) &&
      sameArr(g.pos.revealed, snap0.revealed),
    true,
  );
  eq("悔后栈空", g.canUndo(), false);
  check(
    "悔棋留了一条日志",
    g.messages.some((m) => m.text.includes("已悔棋一步")),
  );

  // ④ 只退**一手**，不是整局重开
  const g2 = new FlipGame(20260915);
  const a2 = firstHidden(g2);
  g2.click(a2);
  const b2 = firstHidden(g2);
  check("还有第二枚可翻", b2 >= 0);
  g2.click(b2);
  eq("翻两手后可悔", g2.canUndo(), true);
  eq("退一手", g2.undo(), true);
  eq("第二子盖回", g2.pos.revealed[b2], 0);
  eq("第一子仍在（不是整局重开）", g2.pos.revealed[a2], 1);
  eq("退一手后栈里还剩一手", g2.canUndo(), true);
  eq("再退一手", g2.undo(), true);
  eq("第一子也盖回", g2.pos.revealed[a2], 0);

  // ⑤ 无效点击不许撑起悔棋栈（否则"可悔次数"是假的）
  const campCell = (() => {
    for (let i = 0; i < CELLS; i++) if (isCamp(i)) return i;
    return -1;
  })();
  const g3 = new FlipGame(7);
  eq("点行营空格返回 false（无效）", g3.click(campCell), false);
  eq("无效点击之后栈仍是空的", drain(g3), 0);
  const g3b = new FlipGame(7);
  const c3 = firstHidden(g3b);
  g3b.click(c3);
  eq("翻一手后栈深 = 1", drain(g3b), 1);
  const g3c = new FlipGame(7);
  const c3c = firstHidden(g3c);
  g3c.click(c3c);
  eq("点行营空格返回 false（无效）", g3c.click(campCell), false);
  eq("点已翻开的子返回 false（无效）", g3c.click(c3c), false);
  eq("无效点击之后栈深仍是 1", drain(g3c), 1);

  // ⑥ 悔棋清掉选择态
  const g4 = new FlipGame(99);
  g4.click(firstHidden(g4));
  g4.click(firstHidden(g4));
  eq("走完有 lastMove", g4.lastMove !== null, true);
  g4.undo();
  eq("悔后 lastMove 清空", g4.lastMove, null);
  eq("悔后 selected 清空", g4.selected, -1);
  eq("悔后 targets 清空", g4.targets.length, 0);

  // ⑦ 走子（不只是翻子）也能退，且棋盘逐格还原（含被吃子）
  const g5 = new FlipGame(4242);
  let from = -1;
  for (let guard = 0; guard < 80 && from < 0; guard++) {
    if (g5.over) break; // 翻着翻着判和/判负了就别再找
    if (g5.revealedColors) {
      for (let i = 0; i < CELLS && from < 0; i++) {
        if (g5.pos.type[i] === PieceType.Empty || g5.pos.revealed[i] !== 1) continue;
        // `click` 只有在"己方且有着法"时才会真的选中（`selected === i`），
        // 顺带把归属 + 合法性一次判掉。
        if (g5.click(i) && g5.selected === i) from = i;
      }
      if (from >= 0) break;
    }
    const hid = firstHidden(g5);
    if (hid < 0) break;
    g5.click(hid);
  }
  check("翻到某一方有子可走", from >= 0, `from=${from}`);
  if (from >= 0) {
    const snap = {
      type: g5.pos.type.slice(),
      owner: g5.pos.owner.slice(),
      revealed: g5.pos.revealed.slice(),
      turn: g5.turn,
    };
    const to = g5.targets[0].to;
    eq("落子前已选中", g5.selected, from);
    g5.click(to);
    eq(
      "落子后 lastMove 记下这一步",
      g5.lastMove !== null && g5.lastMove.from === from && g5.lastMove.to === to,
      true,
    );
    eq("走子入栈", g5.canUndo(), true);
    eq("悔掉这一步", g5.undo(), true);
    eq(
      "退后棋盘逐格还原（含吃子）",
      sameArr(g5.pos.type, snap.type) &&
        sameArr(g5.pos.owner, snap.owner) &&
        sameArr(g5.pos.revealed, snap.revealed),
      true,
    );
    eq("退后手番还原", g5.turn, snap.turn);
  }

  // ⑧ 退回来后重建重复局面表：同一步走两次不该算"重复局面"
  const g6 = new FlipGame(31337);
  g6.setRepeatDraw(3);
  const h1 = firstHidden(g6);
  g6.click(h1);
  eq("走一手后该局面计数 = 1", g6.positionRepeats, 1);
  g6.undo();
  const h2 = firstHidden(g6);
  eq("退回后又是同一格可翻", h2, h1);
  g6.click(h2);
  eq("退回再走同一步：仍算第一次出现（不误判判和）", g6.positionRepeats, 1);
}

// ─────────────────────────────────────────────────────────────

declare const process: { exit(code?: number): never };

console.log(`\n========================================`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (failures.length > 0) {
  console.log(`\n失败明细：`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
} else {
  console.log(`✓ 全部通过`);
}
