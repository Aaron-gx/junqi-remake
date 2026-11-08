/**
 * 对局控制器 —— 与渲染/框架无关的纯逻辑层。
 *
 * main.ts 只负责把用户的点击转成 `click(cell)`，再从控制器读取状态去画界面。
 * 这样后续加"电脑 AI"或"网络对战"时，只需替换驱动方，规则层完全复用。
 */

import {
  CELLS,
  backRowsOf,
  frontRowOf,
  isBase,
  isCamp,
  kindOf,
  rowOf,
  territoryOf,
} from "../core/board.ts";
import { PieceType, Side, opposite, pieceName, sideName } from "../core/pieces.ts";
import {
  DEFAULT_OPTIONS,
  applyMove,
  flagCaptureHint,
  hasAnyMove,
  legalTargets,
  type MoveTarget,
  type RuleOptions,
} from "../core/rules.ts";
import {
  clonePosition,
  countPieces,
  pieceAt,
  ownerAt,
  setPiece,
  clearCell,
  createEmptyPosition,
  buildFromLayouts,
  revealCell,
  type Position,
} from "../core/state.ts";
import { LAYOUTS, type LayoutRecord } from "../data/layouts.ts";

export interface GameMessage {
  readonly text: string;
  readonly tone: "info" | "good" | "bad";
}

export interface Snapshot {
  readonly type: Uint8Array;
  readonly owner: Uint8Array;
  readonly revealed: Uint8Array;
  readonly turn: Side;
  readonly plies: number;
  readonly pliesSinceCapture: number;
  readonly isDraw: boolean;
  readonly drawReason: string;
}

/**
 * 翻棋的一步快照。
 *
 * 比布局那份多三样 —— `turn` 是**座位号**（0/1）不是 `Side`，还得带上
 * `sides` 与 `revealedColors`：翻棋开局双方颜色未定，**第一手翻出什么颜色
 * 就归先手**，悔掉那一手必须把定色也一起退回去，否则同一颗子会被记成两个阵营。
 *
 * 胜负/和棋三项也一起存：悔掉「扛旗」「困毙」的制胜手，对局要能**继续下**
 * （`LayGame.undo` 只把 `winner` 清成 null，翻棋这边多了 `winnerReason`/`drawReason`，
 * 一起还原才不会留下"已经赢了"的残迹）。
 */
export interface FlipSnapshot {
  readonly type: Uint8Array;
  readonly owner: Uint8Array;
  readonly revealed: Uint8Array;
  readonly turn: 0 | 1;
  readonly sides: [Side, Side];
  readonly revealedColors: boolean;
  readonly winner: 0 | 1 | null;
  readonly winnerReason: string;
  readonly isDraw: boolean;
  readonly drawReason: string;
  readonly plies: number;
  readonly pliesSinceCapture: number;
}

export type GameMode = "lay" | "flip";

// ─────────────────────────────────────────────────────────────
// 和棋常数（原版 `rulelay.txt` / `ruleflip.txt` 明文）
// ─────────────────────────────────────────────────────────────

/** 连续多少步没有吃子即判和 —— 原版内部常数 `0x46` = 70。 */
export const DRAW_NO_CAPTURE_PLIES = 70;
/** 双方累计步数上限，达到即判和。 */
export const DRAW_TOTAL_PLIES = 1000;

/**
 * 同一局面重复出现多少次即判和（`0` = 关闭）。
 *
 * ⚠️ **复刻版自加，原版没有这条判定**（原版只有上面两条）。
 * 加它的唯一动机是**AI 观战**：两台电脑实力相当时最容易「谁都不肯吃亏 →
 * 在那两三个格之间来回走」——子力没变化，"70 步无吃子"要磨很久才收得住，
 * 观战看起来就像卡死了。三次重复局面判和是通行做法（国际象棋同款规则）。
 *
 * 默认 **关闭**（`LayGame.repeatDraw` / `FlipGame.repeatDraw` 初值 0），
 * 只有观战会显式 `setRepeatDraw(DRAW_REPETITION)` —— 人机/双人对局保持原版行为。
 */
export const DRAW_REPETITION = 3;

/**
 * 局面指纹：只取「每个格子上是什么、属于谁、翻没翻开」+「轮到谁」。
 *
 * 刻意**不含** `selected` / `targets` / `lastMove` 这类选择态 —— 它们是操作痕迹、
 * 不是棋局本身；混进来会把同一个局面算成两个，判和就永远触发不了。
 * 也不含 `plies`：同样的盘面在第 12 手和第 40 手出现，对棋手就是同一个局面。
 *
 * `turn` 用 `Side` 的数值（翻棋传座位映射后的 Side），只要两种情形能区分开即可。
 */
export function positionKey(pos: Position, turn: number): string {
  const { type, owner, revealed } = pos;
  const out: number[] = new Array(CELLS * 3 + 1);
  out[0] = turn === Side.Red ? 82 : 66; // 'R' / 'B'
  for (let i = 0; i < CELLS; i++) {
    // 各字段都 <13，加 48 后落在可打印 ASCII，直接当字符串用
    out[1 + i * 3] = 48 + type[i];
    out[2 + i * 3] = 48 + owner[i];
    out[3 + i * 3] = 48 + revealed[i];
  }
  return String.fromCharCode(...out);
}

// ─────────────────────────────────────────────────────────────
// 布局对战（明棋 / 暗棋）
// ─────────────────────────────────────────────────────────────

export class LayGame {
  readonly pos: Position;
  readonly opts: RuleOptions;
  turn: Side;
  winner: Side | null = null;
  winnerReason = "";
  /** 和棋（`winner` 保持 null，用本标志区分"没结束"与"和棋"）。 */
  isDraw = false;
  drawReason = "";
  lastMove: { from: number; to: number } | null = null;
  selected = -1;
  targets: readonly MoveTarget[] = [];
  readonly messages: GameMessage[] = [];
  private readonly history: Snapshot[] = [];
  /** 双方累计步数（和棋判定用） */
  private plies = 0;
  /** 距上次吃子已过的步数 */
  private pliesSinceCapture = 0;
  /** 明棋 = true（双方全亮）；暗棋 = false */
  revealAll: boolean;
  /**
   * 同一局面重复多少次判和（`0` = 关闭，默认）。
   * 观战会把它打开（`setRepeatDraw`），人机/双人对局保持原版行为。
   */
  repeatDraw = 0;
  /** 局面指纹 → 出现次数。`repeatDraw === 0` 时一次都不记（零开销）。 */
  private readonly seenPos = new Map<string, number>();

  constructor(
    redLayout: readonly number[],
    blueLayout: readonly number[],
    options: Partial<RuleOptions> & { revealAll?: boolean; firstTurn?: Side } = {},
  ) {
    this.pos = buildFromLayouts(redLayout, blueLayout);
    const { revealAll, firstTurn, ...rest } = options;
    this.revealAll = revealAll ?? true;
    this.opts = { ...DEFAULT_OPTIONS, ...rest, hidden: !this.revealAll };
    if (!this.revealAll) {
      // 暗棋：己方可见，对方不可见 —— 由 revealed 位图表达"全局是否亮明"，
      // 渲染层再叠加"视角"判断。这里先把所有子标记为未翻开。
      for (let i = 0; i < CELLS; i++) this.pos.revealed[i] = 0;
    }
    this.turn = firstTurn ?? Side.Red;
    this.push(`新对局开始，${sideName(this.turn)}先行`, "info");
  }

  /**
   * 对方认输（联机用）：直接把胜者写给另一方。
   * 不走 `click()` —— 认输不是一步棋，不该进悔棋历史，也不该触发规则判定。
   */
  winByResign(side: Side, reason = "对方认输"): void {
    if (this.over) return;
    this.winner = side;
    this.winnerReason = reason;
    this.selected = -1;
    this.targets = [];
    this.push(`${sideName(side)}胜 —— ${reason}`, "good");
  }

  /** 双方同意和棋（联机用）。 */
  drawByAgree(reason = "双方同意和棋"): void {
    if (this.over) return;
    this.isDraw = true;
    this.drawReason = reason;
    this.selected = -1;
    this.targets = [];
    this.push(reason, "info");
  }

  get optsView(): RuleOptions {
    return this.opts;
  }

  /**
   * 打开/关闭「同一局面重复判和」（`0` = 关闭）。
   *
   * 开启时把**当前**局面也登记一次 —— 否则"再走回开局那一手"会少算一次，
   * 判和整体晚一手才触发。
   */
  setRepeatDraw(n: number): void {
    this.repeatDraw = Math.max(0, n | 0);
    this.seenPos.clear();
    if (this.repeatDraw > 0) this.notePosition();
  }

  /** 登记当前局面（每次走完一手、换手之后调）。 */
  private notePosition(): void {
    if (this.repeatDraw <= 0) return;
    const k = positionKey(this.pos, this.turn);
    this.seenPos.set(k, (this.seenPos.get(k) ?? 0) + 1);
  }

  /**
   * 当前局面（含轮次）到目前为止出现过几次，**含本次**。
   * 解说条用它提前提示"双方在打转"（`>= 2` 就该提醒，等判和就太晚了）。
   */
  get positionRepeats(): number {
    if (this.repeatDraw <= 0) return 1;
    return this.seenPos.get(positionKey(this.pos, this.turn)) ?? 1;
  }

  /** 对局是否已结束（胜/负/和都算）。UI 与 AI 循环统一看这个。 */
  get over(): boolean {
    return this.winner !== null || this.isDraw;
  }

  private push(text: string, tone: GameMessage["tone"]): void {
    this.messages.push({ text, tone });
    if (this.messages.length > 200) this.messages.shift();
  }

  private snapshot(): Snapshot {
    return {
      type: this.pos.type.slice(),
      owner: this.pos.owner.slice(),
      revealed: this.pos.revealed.slice(),
      turn: this.turn,
      plies: this.plies,
      pliesSinceCapture: this.pliesSinceCapture,
      isDraw: this.isDraw,
      drawReason: this.drawReason,
    };
  }

  canUndo(): boolean {
    return this.history.length > 0;
  }

  undo(): boolean {
    const s = this.history.pop();
    if (!s) return false;
    this.pos.type.set(s.type);
    this.pos.owner.set(s.owner);
    this.pos.revealed.set(s.revealed);
    this.turn = s.turn;
    this.winner = null;
    this.winnerReason = "";
    this.isDraw = s.isDraw;
    this.drawReason = s.drawReason;
    this.plies = s.plies;
    this.pliesSinceCapture = s.pliesSinceCapture;
    this.lastMove = null;
    this.selected = -1;
    this.targets = [];
    // 局面倒回去了，重复表必须重建 —— 否则"撤回来再走一遍同一步"会被算成
    // 重复局面（其实这一手只走了一次），凭空判和。
    this.seenPos.clear();
    this.notePosition();
    this.push("已悔棋一步", "info");
    return true;
  }

  /** 我方在本局视角（本地双人模式：始终跟随当前行动方）。 */
  get viewer(): Side {
    return this.revealAll ? Side.None : this.turn;
  }

  /** 处理一次点击，返回是否产生了状态变化。 */
  click(cell: number): boolean {
    if (this.over) {
      this.push("对局已结束，请重新开始", "bad");
      return false;
    }
    const t = pieceAt(this.pos, cell);
    const owner = ownerAt(this.pos, cell);

    // 1) 点击己方棋子 → 选中
    if (t !== PieceType.Empty && owner === this.turn) {
      if (this.selected === cell) {
        this.selected = -1;
        this.targets = [];
        return true;
      }
      const tg = legalTargets(this.pos, cell, this.turn, this.opts);
      if (tg.length === 0) {
        this.selected = -1;
        this.targets = [];
        this.push(`${pieceName(t)} 无处可走`, "info");
        return true;
      }
      this.selected = cell;
      this.targets = tg;
      return true;
    }

    // 2) 已选中棋子的情况下点击目标 → 落子
    if (this.selected >= 0) {
      const hit = this.targets.find((x) => x.to === cell);
      if (hit) {
        this.doMove(this.selected, cell);
        return true;
      }
      if (t !== PieceType.Empty) this.push("那不是己方棋子", "bad");
    }
    return false;
  }

  private doMove(from: number, to: number): void {
    this.history.push(this.snapshot());
    const mover = this.turn;
    const attacker = pieceName(pieceAt(this.pos, from));
    const defenderType = pieceAt(this.pos, to);
    const r = applyMove(this.pos, from, to, this.opts);
    this.selected = -1;
    this.targets = [];
    this.lastMove = { from, to };

    if (r.combat === "void") {
      if (defenderType === PieceType.Empty) this.push(`${sideName(mover)} ${attacker} 移动`, "info");
    } else if (r.combat === 0) {
      if (r.flagTaken) {
        this.push(`${sideName(mover)} ${attacker} 夺得军旗！`, "good");
      } else {
        this.push(
          `${sideName(mover)} ${attacker} 吃掉 ${sideName(opposite(mover))} ${pieceName(r.captured)}`,
          "good",
        );
      }
    } else if (r.combat === 1) {
      this.push(
        `${sideName(mover)} ${attacker} 撞上 ${pieceName(r.captured)} 阵亡`,
        "bad",
      );
    } else {
      this.push(
        `双方 ${attacker} 与 ${pieceName(r.captured)} 同归于尽`,
        "info",
      );
    }

    // 和棋计数：本步有吃子就把"连续无吃子"清零
    this.plies++;
    if (r.captured !== PieceType.Empty) this.pliesSinceCapture = 0;
    else this.pliesSinceCapture++;

    if (r.flagTaken) {
      this.finish(mover, "夺得军旗");
      return;
    }

    this.turn = opposite(mover);
    this.notePosition();
    this.checkEnd();
    this.checkDraw();
  }

  /**
   * 和棋判定：同一局面重复 3 次（仅观战开启）/ 连续 70 步无吃子 / 双方累计 1000 步。
   * 后两条为原版 `rulelay.txt` 明文；第一条是复刻版自加，见 `DRAW_REPETITION`。
   */
  private checkDraw(): void {
    if (this.over) return;
    const rep = this.repeatDraw;
    if (rep > 0 && this.positionRepeats >= rep) {
      // 放最前：它比"70 步无吃子"更能说明**为什么**没下出结果 ——
      // 双方不是吃不到子，是局面整个转回来了。
      this.finishDraw(`同一局面重复 ${this.positionRepeats} 次（双方都不肯变着）`);
    } else if (this.pliesSinceCapture >= DRAW_NO_CAPTURE_PLIES) {
      this.finishDraw(`连续 ${DRAW_NO_CAPTURE_PLIES} 步无吃子`);
    } else if (this.plies >= DRAW_TOTAL_PLIES) {
      this.finishDraw(`双方累计 ${DRAW_TOTAL_PLIES} 步`);
    }
  }

  private finishDraw(reason: string): void {
    this.isDraw = true;
    this.drawReason = reason;
    this.push(`和棋（${reason}）`, "info");
  }

  private checkEnd(): void {
    if (!hasAnyMove(this.pos, this.turn, this.opts)) {
      this.finish(opposite(this.turn), `${sideName(this.turn)} 无子可动`);
      return;
    }
    // 只剩军旗 + 地雷 → 无法取胜
    const mobile = countPieces(this.pos, this.turn);
    if (mobile === 0) {
      this.finish(opposite(this.turn), `${sideName(this.turn)} 全军覆没`);
    }
  }

  private finish(winner: Side, reason: string): void {
    this.winner = winner;
    this.winnerReason = reason;
    this.push(`${sideName(winner)}胜利！（${reason}）`, "good");
  }

  /** 当前状态下该行动方是否还有任何着法。 */
  sideHasMove(side: Side): boolean {
    return hasAnyMove(this.pos, side, this.opts);
  }

  hint(): string {
    if (this.isDraw) return "和棋";
    if (this.winner !== null) return `${sideName(this.winner)}已获胜`;
    return `${sideName(this.turn)}行动`;
  }
}

// ─────────────────────────────────────────────────────────────
// 翻棋（暗棋）
// ─────────────────────────────────────────────────────────────

/**
 * 翻棋模式：把双方 50 枚棋子打乱后**全部背面铺满 50 个非行营格**，
 * 10 个行营留空；轮流翻子；先翻出的那枚棋子的颜色即为自己一方。
 *
 * 布局依据（雷电 9，900×1600 实拍 `s10_flip.png`）：
 *   · 全盘 60 格中，只有 10 个行营是空的（露出底图的行营圆环），
 *     其余 50 格全部盖着 **绿色背面**（图集 r6c0 = RGB 112,156,0）。
 *   · 即 50 枚 = 60 格 − 10 行营，不是"60 格任意铺"。
 *
 * ⚠️ 曾经的实现有两个 bug（已修）：
 *   1. `shuffleBag()` 只产出 50 枚，却按 `CELLS`(60) 写入 → 第 50~59 格是 `undefined`。
 *   2. 没有排除行营 → 行营被塞了子，且数量对不上。
 *
 * 逆向未取到原版的洗牌算法，这里用 LCG 播种的 Fisher–Yates，
 * 并保证每方 25 枚的量数守恒（与 `.lay` 一致）。
 */
export class FlipGame {
  readonly pos: Position;
  readonly opts: RuleOptions;
  /** 双方颜色是翻棋后才确定的，这里记录两名玩家的实际阵营 */
  turn: 0 | 1 = 0;
  readonly sides: [Side, Side] = [Side.Red, Side.Blue];
  revealedColors = false;
  winner: 0 | 1 | null = null;
  winnerReason = "";
  /** 和棋（`winner` 保持 null，用本标志区分"没结束"与"和棋"）。 */
  isDraw = false;
  drawReason = "";
  lastMove: { from: number; to: number } | null = null;
  selected = -1;
  targets: readonly MoveTarget[] = [];
  readonly messages: GameMessage[] = [];
  /** 双方累计步数（翻子也算一步）；和棋判定用 */
  private plies = 0;
  /** 距上次吃子已过的步数 */
  private pliesSinceCapture = 0;
  /**
   * 同一局面重复多少次判和（`0` = 关闭，默认）。
   * 翻棋里"来回走同一对格子"比布局更容易出现（翻子总会翻完，走子却能无限磨），
   * 所以观战同样把它打开。
   */
  repeatDraw = 0;
  private readonly seenPos = new Map<string, number>();
  /**
   * 悔棋栈 —— 与布局同构：`reveal()` / `doMove()` 各压一份快照，`undo()` 弹一份。
   *
   * ★ **原版翻棋是支持悔棋的。** 2026-09-15 在雷电 9 里跑原版 `com.cnvcs.junqi`
   *   实机验证（`tools/_emu/_undo_*.png`）：
   *     1) 翻一手（团长）→ ☰ 菜单「悔棋」→ 那一子**重新盖回**，整屏与"刚开局"
   *        逐像素差 **0 px**（`_undo_18` vs `_undo_12`）；
   *     2) 翻两手（团长、炸弹）→ 再悔 → **只退一手**，团长仍在、炸弹盖回
   *        （不是"整局重开"）。即与布局同为"退一手"语义。
   *   旧版这里写死 `status("翻棋不支持悔棋")` 是**没核对原版就下的结论**，已删。
   */
  private readonly history: FlipSnapshot[] = [];

  constructor(seed = Date.now()) {
    this.pos = createEmptyPosition();
    this.opts = { ...DEFAULT_OPTIONS, hidden: true, flipMode: true };
    const bag = shuffleBag(seed); // 恰好 50 枚
    for (let k = 0; k < NON_CAMP.length; k++) {
      const v = bag[k];
      const cell = NON_CAMP[k];
      const type = (v >= 100 ? v - 100 : v) as PieceType;
      const side = v >= 100 ? Side.Blue : Side.Red;
      // 全部盖着（revealed = 0），且行营保持 Empty
      setPiece(this.pos, cell, type, side, 0);
    }
    this.push("翻棋开始：轮流翻开棋子，先翻开者执该色", "info");
  }

  get viewer(): Side {
    return Side.None; // 双方视角一致（都看不到未翻开的子）
  }

  /**
   * 打开/关闭「同一局面重复判和」（`0` = 关闭）。语义同 `LayGame.setRepeatDraw`。
   *
   * 翻棋的 `turn` 是座位号（定色前还不是阵营），指纹里按 `Side.Red/Blue` 把
   * 两席区分开即可 —— 判和只关心"轮到的是不是同一边"。
   */
  setRepeatDraw(n: number): void {
    this.repeatDraw = Math.max(0, n | 0);
    this.seenPos.clear();
    if (this.repeatDraw > 0) this.notePosition();
  }

  private seatSide(): Side {
    return this.turn === 0 ? Side.Red : Side.Blue;
  }

  private notePosition(): void {
    if (this.repeatDraw <= 0) return;
    const k = positionKey(this.pos, this.seatSide());
    this.seenPos.set(k, (this.seenPos.get(k) ?? 0) + 1);
  }

  /** 当前局面（含轮次）出现过几次，含本次。解说条提示"在打转"用。 */
  get positionRepeats(): number {
    if (this.repeatDraw <= 0) return 1;
    return this.seenPos.get(positionKey(this.pos, this.seatSide())) ?? 1;
  }

  /**
   * 某个座位认输（联机用）。
   * 座位号 → 阵营要等定色；定色前认输就直接按座位号记胜者。
   */
  winByResign(loserSeat: 0 | 1, reason = "对方认输"): void {
    if (this.over) return;
    const win = (loserSeat === 0 ? 1 : 0) as 0 | 1;
    this.winner = win;
    this.winnerReason = reason;
    this.selected = -1;
    this.targets = [];
    const side = this.revealedColors ? this.sides[win] : Side.None;
    this.push(`${side === Side.None ? `玩家${win + 1}` : sideName(side)}胜 —— ${reason}`, "good");
  }

  /** 双方同意和棋（联机用）。 */
  drawByAgree(reason = "双方同意和棋"): void {
    if (this.over) return;
    this.isDraw = true;
    this.drawReason = reason;
    this.selected = -1;
    this.targets = [];
    this.push(reason, "info");
  }

  /** 对局是否已结束（胜/负/和都算）。 */
  get over(): boolean {
    return this.winner !== null || this.isDraw;
  }

  /** 当前玩家的阵营（未定色前返回 None）。 */
  get playerSide(): Side {
    return this.revealedColors ? this.sides[this.turn] : Side.None;
  }

  reveal(cell: number): boolean {
    if (this.over) return false;
    if (this.pos.type[cell] === PieceType.Empty) return false;
    if (this.pos.revealed[cell] === 1) return false;
    // 定位在三条守卫**之后**：无效点击不该往悔棋栈里塞空快照，
    // 否则连点空白格会把"可悔次数"撑起来，真去悔时却退的是没发生过的局面。
    this.history.push(this.snapshot());
    // 翻子会换手，必须清掉上一手留下的选中/落点 ——
    // 否则新行动方会看到"敌方棋子被选中"，点旧落点就能替对手走子。
    this.selected = -1;
    this.targets = [];
    revealCell(this.pos, cell);
    const side = ownerAt(this.pos, cell);
    this.lastMove = { from: cell, to: cell };
    this.push(`翻开：${sideName(side)} ${pieceName(pieceAt(this.pos, cell))}`, "info");
    if (!this.revealedColors) {
      this.sides[0] = side;
      this.sides[1] = opposite(side);
      this.revealedColors = true;
      this.push(`先翻出 ${sideName(side)}，玩家1 执${sideName(side)}`, "info");
    }
    this.turn = this.turn === 0 ? 1 : 0;
    // 翻子本身也是一步，且一定没有吃子
    this.plies++;
    this.pliesSinceCapture++;
    this.notePosition();
    this.checkStalemate();
    this.checkDraw();
    return true;
  }

  private doMove(from: number, to: number): void {
    this.history.push(this.snapshot());
    const mover = this.sides[this.turn];
    const attacker = pieceName(pieceAt(this.pos, from));
    const r = applyMove(this.pos, from, to, this.opts);
    this.selected = -1;
    this.targets = [];
    this.lastMove = { from, to };
    // 和棋计数：本步有吃子就把"连续无吃子"清零
    this.plies++;
    if (r.captured !== PieceType.Empty) this.pliesSinceCapture = 0;
    else this.pliesSinceCapture++;
    if (r.flagTaken) {
      this.winner = this.turn;
      this.winnerReason = "夺得军旗";
      this.push(`${sideName(mover)} ${attacker} 夺得军旗！`, "good");
      this.push(`${sideName(mover)}胜利！（夺得军旗）`, "good");
      return;
    }
    if (r.combat === 0) {
      this.push(`${sideName(mover)} ${attacker} 吃掉 ${pieceName(r.captured)}`, "good");
    } else if (r.combat === 1) {
      this.push(`${sideName(mover)} ${attacker} 撞上 ${pieceName(r.captured)} 阵亡`, "bad");
    } else if (r.combat === 2) {
      this.push(`双方 ${attacker} 与 ${pieceName(r.captured)} 同归于尽`, "info");
    } else {
      this.push(`${sideName(mover)} ${attacker} 移动`, "info");
    }
    this.turn = this.turn === 0 ? 1 : 0;
    this.notePosition();
    this.checkStalemate();
    this.checkDraw();
  }

  /**
   * 和棋判定：同一局面重复 3 次（仅观战开启）/ 连续 70 步无吃子 / 双方累计 1000 步。
   * 后两条为原版 `ruleflip.txt` 明文；第一条是复刻版自加，见 `DRAW_REPETITION`。
   */
  private checkDraw(): void {
    if (this.over) return;
    const rep = this.repeatDraw;
    if (rep > 0 && this.positionRepeats >= rep) {
      this.isDraw = true;
      this.drawReason = `同一局面重复 ${this.positionRepeats} 次（双方都不肯变着）`;
      this.push(`和棋（${this.drawReason}）`, "info");
    } else if (this.pliesSinceCapture >= DRAW_NO_CAPTURE_PLIES) {
      this.isDraw = true;
      this.drawReason = `连续 ${DRAW_NO_CAPTURE_PLIES} 步无吃子`;
      this.push(`和棋（${this.drawReason}）`, "info");
    } else if (this.plies >= DRAW_TOTAL_PLIES) {
      this.isDraw = true;
      this.drawReason = `双方累计 ${DRAW_TOTAL_PLIES} 步`;
      this.push(`和棋（${this.drawReason}）`, "info");
    }
  }

  /**
   * 困毙判定：当前行动方既没有暗子可翻、也没有任何合法走子 → 判负。
   * （翻棋里只要还有暗子就永远可以翻，所以只有全部翻开后才可能出现困毙。）
   */
  private checkStalemate(): void {
    if (this.over) return;
    for (let i = 0; i < CELLS; i++) {
      if (this.pos.type[i] !== PieceType.Empty && this.pos.revealed[i] === 0) return;
    }
    const side = this.sides[this.turn];
    if (hasAnyMove(this.pos, side, this.opts)) return;
    const opp = this.turn === 0 ? 1 : 0;
    this.winner = opp;
    this.winnerReason = "对方困毙";
    this.push(`${sideName(side)} 无着可走（困毙）`, "info");
    this.push(`${sideName(this.sides[opp])}胜利！（对方困毙）`, "good");
  }

  /**
   * 一次点击：
   *   定色前 —— 点未翻开的子即翻开（翻出的颜色归玩家1）。
   *   定色后 —— 点未翻开的子 = 翻开；点已翻开的己方子 = 选中；
   *             已选中时点合法落点 = 走子。
   */
  click(cell: number): boolean {
    if (this.over) return false;
    // 被困毙的一方做不出任何动作，永远触发不了"落子后"的判定 ——
    // 所以入口处也查一次（无暗子时才真正扫描，开销可忽略）。
    this.checkStalemate();
    if (this.over) return false;

    const isEmpty = this.pos.type[cell] === PieceType.Empty;

    // 未翻开的子：翻开（定色前/后都一样吃一手）
    if (!isEmpty && this.pos.revealed[cell] === 0) {
      return this.reveal(cell);
    }

    // 空格 = 10 个行营。它**可以是合法落点**，只在「已选中」时才成立。
    //
    // ⚠️ 这里曾经一刀切 `if (type === Empty) return false`，而翻棋开局有 10 个空行营，
    //    于是「走进行营」这一着永远失败：`click(to)` 返回 false、回合不切换，
    //    `afterTurn → scheduleAi` 就会每 420ms 重试一次 —— 表现就是**人机对战卡死**，
    //    而且 `clickAt` 又以 `turn === 1` 挡住玩家，整局彻底动不了。
    if (isEmpty) {
      if (this.selected >= 0 && this.targets.some((x) => x.to === cell)) {
        this.doMove(this.selected, cell);
        return true;
      }
      if (this.selected >= 0) {
        this.selected = -1;
        this.targets = [];
        return true;
      }
      return false;
    }

    if (!this.revealedColors) return false;

    const mySide = this.sides[this.turn];
    const owner = ownerAt(this.pos, cell);

    // 点己方已翻开的子 → 选中 / 取消
    if (owner === mySide) {
      if (this.selected === cell) {
        this.selected = -1;
        this.targets = [];
        return true;
      }
      const tg = legalTargets(this.pos, cell, mySide, this.opts);
      if (tg.length === 0) {
        this.selected = -1;
        this.targets = [];
        this.push(`${pieceName(pieceAt(this.pos, cell))} 无处可走`, "info");
        return true;
      }
      this.selected = cell;
      this.targets = tg;
      return true;
    }

    // 已选中 → 点目标落子
    if (this.selected >= 0) {
      const hit = this.targets.find((x) => x.to === cell);
      if (hit) {
        this.doMove(this.selected, cell);
        return true;
      }
      // 点的是**对方军旗**、却不是合法落点 —— 玩家十有八九就是想扛旗。
      // 旧版这里直接 return false，界面一声不吭（2026-09-14 玩家实报
      // 「为什么地雷吃完了，不能吃军旗？」）。扛旗的两个条件都不在盘面上，
      // 必须由界面说清楚：兵种资格（翻棋只有工兵）+ 对方地雷清零。
      // ⚠️ 暗棋下敌旗可能还没翻开，那就不许提示（否则等于替玩家作弊认旗）。
      if (
        pieceAt(this.pos, cell) === PieceType.Flag &&
        ownerAt(this.pos, cell) !== mySide &&
        (!this.opts.hidden || this.pos.revealed[cell] === 1)
      ) {
        const why = flagCaptureHint(this.pos, this.selected, mySide, this.opts);
        if (why) this.push(why, "info");
      }
    }
    return false;
  }

  /** 悔棋栈里还有没有可退的一手。 */
  canUndo(): boolean {
    return this.history.length > 0;
  }

  /**
   * 退一手（含"翻开"这一手）—— 语义与 `LayGame.undo` 完全一致：**只退一手**，
   * 不退一整轮。原版行为已实机核对（见 `history` 字段的注释）。
   *
   * 翻棋比布局多要还原三处：
   *   · `sides` / `revealedColors` —— 退掉"定色那一手"时，颜色归属必须一起回退，
   *     否则盘面上那颗子会被算成另一个阵营（`owner` 位图与 `sides` 打架）；
   *   · `winner` / `winnerReason` / `isDraw` / `drawReason` —— 退掉制胜手后
   *     对局要能继续下，不能还挂着"某人已胜"；
   *   · `seenPos` —— 局面倒回去了必须重建，否则"撤回来再走同一步"会被误判成
   *     重复局面（那一手其实只走了一次），凭空触发判和。
   */
  undo(): boolean {
    const s = this.history.pop();
    if (!s) return false;
    this.pos.type.set(s.type);
    this.pos.owner.set(s.owner);
    this.pos.revealed.set(s.revealed);
    this.turn = s.turn;
    this.sides[0] = s.sides[0];
    this.sides[1] = s.sides[1];
    this.revealedColors = s.revealedColors;
    this.winner = s.winner;
    this.winnerReason = s.winnerReason;
    this.isDraw = s.isDraw;
    this.drawReason = s.drawReason;
    this.plies = s.plies;
    this.pliesSinceCapture = s.pliesSinceCapture;
    this.lastMove = null;
    this.selected = -1;
    this.targets = [];
    this.seenPos.clear();
    this.notePosition();
    this.push("已悔棋一步", "info");
    return true;
  }

  private snapshot(): FlipSnapshot {
    return {
      type: this.pos.type.slice(),
      owner: this.pos.owner.slice(),
      revealed: this.pos.revealed.slice(),
      turn: this.turn,
      sides: [this.sides[0], this.sides[1]],
      revealedColors: this.revealedColors,
      winner: this.winner,
      winnerReason: this.winnerReason,
      isDraw: this.isDraw,
      drawReason: this.drawReason,
      plies: this.plies,
      pliesSinceCapture: this.pliesSinceCapture,
    };
  }

  private push(text: string, tone: GameMessage["tone"]): void {
    this.messages.push({ text, tone });
    if (this.messages.length > 200) this.messages.shift();
  }
}

/** 非行营格（60 − 10 = 50 个）—— 翻棋的 50 枚棋子正好铺满。 */
const NON_CAMP: readonly number[] = (() => {
  const out: number[] = [];
  for (let i = 0; i < CELLS; i++) if (!isCamp(i)) out.push(i);
  return out;
})();

/** 生成打乱后的 50 枚棋子编码；红 = 1..12，蓝 = 101..112（每方 25 枚）。 */
function shuffleBag(seed: number): number[] {
  const per: number[] = [1, 1, 2, 2, 2, 2, 3, 3, 3, 2, 3, 1]; // 类型 1..12 的数量，合计 25
  const bag: number[] = [];
  for (let t = 1; t <= 12; t++) {
    for (let k = 0; k < per[t - 1]; k++) {
      bag.push(t);
      bag.push(100 + t);
    }
  }
  // Fisher–Yates（LCG 播种，便于复现）
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

// ─────────────────────────────────────────────────────────────
// 布阵编辑
// ─────────────────────────────────────────────────────────────

/**
 * 单个棋子的落位是否合法（`rulelay.txt`「棋子布局限制」）。
 * 文案与 `board.validateLayout` 一致，取自原版字符串表 ZhaError / LeiError / QiError。
 * 返回 `null` 表示合法。
 */
function placeError(side: Side, cell: number, type: PieceType): string | null {
  if (type === PieceType.Bomb && rowOf(cell) === frontRowOf(side)) {
    return "炸弹不能放在第一行";
  }
  if (type === PieceType.Landmine && !backRowsOf(side).includes(rowOf(cell))) {
    return "地雷只能放在最后两行";
  }
  if (type === PieceType.Flag && !isBase(cell)) {
    return "军旗只能放在大本营";
  }
  return null;
}

/** 原地洗牌。 */
function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 布阵编辑器：手持棋子队列 + 已放置表。 */
export class LayoutEditor {
  /** 当前编辑的一方 */
  side: Side = Side.Red;
  /** board 空间的 60 格（只会有本方 30 格被填） */
  readonly cells: PieceType[];
  /** 手上剩下的棋子（每次取第一个） */
  hand: PieceType[] = [];
  painter: PieceType | null = null;
  readonly logs: string[] = [];

  constructor(side: Side = Side.Red, from?: readonly number[]) {
    this.cells = new Array(CELLS).fill(PieceType.Empty);
    this.side = side;
    if (from) {
      const t = territoryOf(side);
      // from 是 .lay 顺序（最前线→底线）
      const rows = 6;
      for (let li = 0; li < 30; li++) {
        const lr = (li / 5) | 0;
        const lc = li % 5;
        const br = side === Side.Red ? rows - 1 - lr : 6 + lr;
        this.cells[br * 5 + lc] = from[li] as PieceType;
      }
      void t;
      this.hand = [];
      this.rebuildHand();
    } else {
      this.hand = [];
      this.rebuildHand();
    }
  }

  private rebuildHand(): void {
    const have = new Map<PieceType, number>();
    for (let i = 0; i < CELLS; i++) {
      if (this.cells[i] !== PieceType.Empty) {
        have.set(this.cells[i], (have.get(this.cells[i]) ?? 0) + 1);
      }
    }
    const per: [PieceType, number][] = [];
    for (let t = PieceType.Commander; t <= PieceType.Flag; t++) {
      const cnt = countOfType(t as PieceType);
      per.push([t as PieceType, cnt]);
    }
    this.hand = [];
    for (const [t, n] of per) {
      const used = have.get(t) ?? 0;
      for (let k = 0; k < n - used; k++) this.hand.push(t);
    }
  }

  /** 该方阵地内的格子索引 */
  territory(): number[] {
    return territoryOf(this.side);
  }

  place(cell: number, type: PieceType | null): void {
    if (type === null) {
      this.cells[cell] = PieceType.Empty;
      this.rebuildHand();
      return;
    }
    // 位置合法性 —— 文案取自原版字符串表 ZhaError / LeiError / QiError
    const bad = LayoutEditor.validate(this.side, cell, type);
    if (bad) {
      this.logs.push(bad);
      return;
    }
    const idxHand = this.hand.indexOf(type);
    if (idxHand < 0) {
      this.logs.push(`没有多余的 ${pieceName(type)}`);
      return;
    }
    this.cells[cell] = type;
    this.rebuildHand();
  }

  /**
   * 布阵位置约束（`rulelay.txt`「棋子布局限制」）：
   *   · 炸弹不能放在第一行（最前线）；
   *   · 地雷只能放在最后两行；
   *   · 军旗只能放在大本营。
   * 返回 `null` 表示合法，否则返回原版报错文案。
   */
  static validate(side: Side, cell: number, type: PieceType): string | null {
    return placeError(side, cell, type);
  }

  /** 是否还有没摆完的棋子（原版 `LayError` = 「还有未摆放的棋子」）。 */
  startError(): string | null {
    return this.hand.length > 0 ? "还有未摆放的棋子" : null;
  }

  clear(): void {
    for (const i of territoryOf(this.side)) this.cells[i] = PieceType.Empty;
    this.rebuildHand();
  }

  /**
   * 载入一套 `.lay` 布阵：覆盖本方 30 格，并**重新派生手牌**。
   *
   * ★ 为什么必须有这个方法（而不是在调用处直接 `cells.splice(...)`）：
   *   `hand` 是 `cells` 的**派生量**（`rebuildHand` 按"应有多少 − 已有多少"算）。
   *   外面的调用处从前只 `splice` 了 `cells` 就 `rebuildEditPanel()`，
   *   手牌数组没跟着刷新 —— 于是界面还显示"还剩 25 枚"，`remaining()` 也还是 25，
   *   「载入布局」和「载入 00 阵」看起来完全没反应（实测点完 editRemaining 仍是 25）。
   */
  loadLayout(from: readonly number[]): void {
    const src = new LayoutEditor(this.side, from);
    this.cells.splice(0, CELLS, ...src.cells);
    this.painter = null;
    this.logs.length = 0;
    this.rebuildHand();
  }

  /**
   * 随机布阵 —— 必须满足原版的布阵限制，且**行营必须留空**
   * （原版 51 套 `.lay` 数据在 5 个行营位上一律为 0，已实测核对）。
   */
  randomize(): void {
    this.clear();
    // 25 个可放格 = 本方 30 格 − 5 个行营
    const cells = territoryOf(this.side).filter((c) => !isCamp(c));
    const front = frontRowOf(this.side);

    // 1) 军旗进大本营
    const bases = cells.filter((c) => isBase(c));
    this.cells[bases[(Math.random() * bases.length) | 0]] = PieceType.Flag;

    // 2) 地雷只能在后两行
    const back = backRowsOf(this.side);
    const backSlots = shuffle(
      cells.filter((c) => this.cells[c] === PieceType.Empty && back.includes(rowOf(c))),
    );
    for (const c of backSlots.slice(0, 3)) this.cells[c] = PieceType.Landmine;

    // 3) 炸弹不能在最前线
    const bombSlots = shuffle(
      cells.filter((c) => this.cells[c] === PieceType.Empty && rowOf(c) !== front),
    );
    for (const c of bombSlots.slice(0, 2)) this.cells[c] = PieceType.Bomb;

    // 4) 其余棋子（司令…工兵）随意落位
    const rest: PieceType[] = [];
    for (let t = PieceType.Commander; t <= PieceType.Flag; t++) {
      if (t === PieceType.Flag || t === PieceType.Landmine || t === PieceType.Bomb) continue;
      for (let k = 0; k < countOfType(t as PieceType); k++) rest.push(t as PieceType);
    }
    shuffle(rest);
    const openSlots = shuffle(cells.filter((c) => this.cells[c] === PieceType.Empty));
    for (let k = 0; k < rest.length; k++) this.cells[openSlots[k]] = rest[k];

    this.rebuildHand();
  }

  /** 导出为该方 .lay 顺序的 30 字节 */
  toLayout(): number[] {
    const out: number[] = [];
    for (let lr = 0; lr < 6; lr++) {
      for (let lc = 0; lc < 5; lc++) {
        const br = this.side === Side.Red ? 5 - lr : 6 + lr;
        out.push(this.cells[br * 5 + lc]);
      }
    }
    return out;
  }

  remaining(): number {
    return this.hand.length;
  }
}

function countOfType(t: PieceType): number {
  const per: Record<number, number> = {
    1: 1, 2: 1, 3: 2, 4: 2, 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 2, 11: 3, 12: 1,
  };
  return per[t] ?? 0;
}

/** 从 51 套原版布阵里随机取一套。 */
export function pickLayout(seed = Math.floor(Math.random() * 1e9)): LayoutRecord {
  return LAYOUTS[seed % LAYOUTS.length];
}

export function cloneForAi(p: Position): Position {
  return clonePosition(p);
}

export { kindOf, clearCell };
