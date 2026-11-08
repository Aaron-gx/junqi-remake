/**
 * 军棋 · 网页复刻版（原版素材驱动）
 *
 * 与上一版的根本区别：棋盘与棋子 **不再程序化重绘**，
 * 而是直接使用原版 APK 解包出来的位图 —— 因此画面与原版逐像素一致。
 *   · 棋盘   = 原版 `board.png`（720×1160，720 密度数据包 `datax#156`）
 *   · 棋子   = 原版 `piece.png` 图集切片（12 兵种 × 橙/蓝两方 + 末行 4 个纯色背面）
 *   · 面板   = 原版 9 宫格皮肤（切线取自 `data/720x/ui/*.cfg`）
 *   · 音效   = 原版 `data/junqi/*.wav`
 *   · 规则   = 原版 `rulelay.txt`（UTF-8）
 *   · 提示   = 原版的蓝框(选中) / 红框(最后一步)，见 ui/renderer.ts
 */

import "./style.css";
import { type Assets, loadAssets, play } from "./ui/assets.ts";
import {
  cellCenter,
  drawStartBanner,
  hitTest,
  render,
  tileRowCol,
  type RenderInput,
  type View,
} from "./ui/renderer.ts";
import { ART_H, ART_W, COL_X, PIECE_H, ROW_Y } from "./ui/boardart.ts";
import {
  DLG_FONT,
  DLG_TEXT_SIZE,
  EDIT_BAR,
  FLOAT_ART_H,
  FLOAT_ART_W,
  FLOAT_X_LEFT,
  FLOAT_X_RIGHT,
  FLOAT_Y,
  HOME_BUTTONS,
  HOME_HOUSE,
  HOME_LABEL_DY,
  HOME_SG_LABEL_DY,
  HOME_SG_LINE_HEIGHT,
  HOME_SG_TEXT_SIZE,
  HOME_TEXT_SIZE,
  HOME_TITLE,
  LOGO_BOX_H,
  LOGO_BOX_W,
  LOGO_CX,
  LOGO_CY,
  SKIN_BTN,
  SKIN_DLG,
  SKIN_FILL,
  closeDialog,
  fitDialogHeight,
  floatButton,
  type DialogButton,
  type GridItem,
  iconGrid,
  layoutDialog,
  layoutShell,
  placeFloat,
  setDialogScale,
  setFloatIcon,
  showDialog,
} from "./ui/shell.ts";
import {
  CELLS,
  COLS,
  ROWS,
  colOf,
  idx,
  isBase,
  isCamp,
  rowOf,
  territoryOf,
  validateLayout,
} from "./core/board.ts";
import { DEFAULT_OPTIONS, baseFrozenOf, legalTargets, type RuleOptions } from "./core/rules.ts";
import { allLegalMoves, applyMove } from "./core/rules.ts";
import { pathBetween } from "./core/path.ts";
import {
  animPointAt,
  makeMoveAnim,
  type MoveAnim,
} from "./ui/anim.ts";
import {
  PIECE_TABLE,
  PieceType,
  Side,
  opposite,
  pieceName,
  sideName,
} from "./core/pieces.ts";
import {
  clearCell,
  clonePosition,
  createEmptyPosition,
  setPiece,
  type Position,
} from "./core/state.ts";
import { LAYOUTS } from "./data/layouts.ts";
import {
  FlipGame,
  LayGame,
  LayoutEditor,
  DRAW_REPETITION,
  positionKey,
  type GameMessage,
} from "./game/session.ts";
import {
  AI_LEVELS,
  AI_STATS,
  DEFAULT_AI_LEVEL,
  aiChooseFlip,
  aiChooseMove,
  aiLevel,
  aiRootOrder,
  evalForSide,
  evalPly2,
  makeRng,
  SHUFFLE_WINDOW,
  type AiLevel,
  type AvoidMove,
} from "./game/ai.ts";
import {
  NetClient,
  netToken,
  randomRoom,
  stateSum,
  type NetMsg,
  type NetSetup,
  type NetState,
} from "./game/net.ts";
import {
  DEFAULT_AID_TIMEOUT_MS,
  aiAidDiag,
  aiAidPing,
  looksLikeThinkingModel,
  aiAidSuggest,
  aidEndpoint,
  aidRelayAvailable,
  flipRevealCells,
  type AidConfig,
  type AidScore,
  type AidSuggestion,
} from "./game/aiaid.ts";
import { isTransientNetError } from "./game/neterr.ts";

/**
 * `home` = 原版的启动主菜单（`s03.png`）。原版开机就停在这里，
 * 所以复刻版**默认也是它** —— 而不是直接进明棋。
 * `?mode=lay|flip|edit` 仍可直达对局，方便自检与截图比对。
 */
type Mode = "home" | "lay" | "flip" | "edit" | "rules";

const $ = <T extends HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

let A: Assets;
let view: View = { scale: 1, ox: 0, oy: 0 };
let uiScale = 1;
let mode: Mode = "home";
/**
 * 辅助落点提示（**非原版行为**）。原版选中棋子只给一个蓝框、不画落点，
 * 见 ui/renderer.ts 文件头的实测说明。默认关闭以保持"一模一样"。
 */
let aidHints = false;
/**
 * 棋子纹理插值 —— **默认开**（原版就是线性过滤，见 `renderer.ts` 的 `pieceSmooth`）。
 * `?smooth=0` 可关掉，用来复现 NEAREST 的对照截图。
 */
let pieceSmooth = true;
/** 只用于标定：棋子落点是否吸附到整数设备像素（见 `renderer.ts` 的 `pieceSnap`）。 */
let pieceSnap = false;

/**
 * 人机对战。原版新局对话框把这三项并排：先后手 / 电脑水平 / 玩法 / 明暗棋。
 * 电脑水平的枚举与标签取自 `libjunqi.so` 反编译（见 game/ai.ts 文件头）。
 */
let vsAi = false;
let aiLevelId = DEFAULT_AI_LEVEL;
let aiBusy = false;
/** 自检进行中：同步驱动，屏蔽定时重排，避免和自检循环互相插队。 */
let selfCheck = false;
const aiRng = makeRng();
/** 自检用的确定性随机源（替代 aiRng），让自检可复现。 */
let aiRngOverride: (() => number) | null = null;

// ── 走子动画（原版 PieceAni，默认开） ────────────────────────
/**
 * 是否播放走子动画。对应原版对象 `+0x65` 的 `PieceAni` 开关
 * （**默认 1 = 开**，`FUN_00031626` 读取，见 ui/anim.ts 文件头）。
 * 关掉就回到"点了立刻落位"。
 */
let animEnabled = true;
/** 当前正在播放的走子动画；null = 没有。 */
let anim: MoveAnim | null = null;
let animRaf = 0;
/** 兜底定时器：标签页被切到后台时 `requestAnimationFrame` 会停摆，
 *  靠它把逻辑收尾（否则整局会卡在"走了一半"的状态）。 */
let animGuard = 0;

/**
 * 一手待播动画的"素材"：走子前的盘面 + 起讫格 + 移动棋子的图集行列。
 *
 * 走子前的盘面必须留一份 —— 动画期间照它画，被吃掉的子才会一直站在原处，
 * 直到移动的子**落到**它头上那一刻才消失。原版正是这个顺序：
 * 动画跑完才 `Msg_Move` 真正落位（见 ui/anim.ts 文件头）。
 */
interface MoveSpec {
  readonly pre: Position;
  readonly from: number;
  readonly to: number;
  readonly rc: readonly [number, number];
  readonly prevLast: { from: number; to: number } | null;
}

/**
 * 从"点击前后 `lastMove` 的变化"里认出这一手究竟有没有走子。
 * 翻子（`from === to`）、纯选中、以及压根没变（引用相同）都不算走子。
 */
function takeMoveSpec(
  pre: Position,
  prevLast: { from: number; to: number } | null,
  curLast: { from: number; to: number } | null,
): MoveSpec | null {
  if (!curLast || curLast === prevLast || curLast.from === curLast.to) return null;
  const t = pre.type[curLast.from];
  const s = pre.owner[curLast.from];
  if (t === PieceType.Empty) return null;
  return {
    pre,
    from: curLast.from,
    to: curLast.to,
    rc: tileRowCol(t as PieceType, s as Side),
    prevLast,
  };
}

/** 停掉当前动画（重开局 / 悔棋 / 切模式 / 关开关时用）。 */
function cancelAnim(): void {
  if (animRaf) {
    cancelAnimationFrame(animRaf);
    animRaf = 0;
  }
  if (animGuard) {
    clearTimeout(animGuard);
    animGuard = 0;
  }
  anim = null;
}

/** 收尾：清掉动画状态与所有计时器，画最终帧，再排电脑。 */
function finishAnim(): void {
  if (!anim) return;
  const done = anim.done;
  if (animRaf) {
    cancelAnimationFrame(animRaf);
    animRaf = 0;
  }
  if (animGuard) {
    clearTimeout(animGuard);
    animGuard = 0;
  }
  anim = null;
  done();
}

/** 开始播放一手走子动画；跑完再画最终帧、再排电脑。 */
function beginMoveAnim(spec: MoveSpec): void {
  cancelAnim();
  anim = makeMoveAnim({
    pre: spec.pre,
    from: spec.from,
    to: spec.to,
    path: pathBetween(spec.pre, spec.from, spec.to),
    rc: spec.rc,
    prevLast: spec.prevLast,
    now: performance.now(),
    done: () => {
      draw();
      scheduleAi();
    },
  });
  tickAnim();
  // rAF 停摆（后台标签页）时的兜底 —— 逻辑照样会落位，只是看不到过程。
  animGuard = window.setTimeout(finishAnim, anim.duration + 150);
}

/**
 * 逐帧推进。用 `requestAnimationFrame` 驱动，逐帧调 `draw()` 取当前位置；
 * 到点后收尾 —— 于是电脑的出手总是**等动画放完**才开始思考，和人看到的一致。
 */
function tickAnim(): void {
  if (!anim) return;
  animRaf = 0;
  if (performance.now() - anim.start >= anim.duration) {
    finishAnim();
    return;
  }
  draw();
  animRaf = requestAnimationFrame(tickAnim);
}

// ── 对局状态 ─────────────────────────────────────────────────
/**
 * 布局对战的开局配置。
 * ⚠️ `revealAll` 缺省 **false** —— 原版「新局」对话框里「明暗棋」默认就是**暗棋**，
 * 实拍（s16_start）也确认：己方摊开、对方只显示蓝/橙背面。
 */
const layCfg = { redIdx: 0, blueIdx: 1, revealAll: false, firstMove: Side.Red };
let lay: LayGame;
let flip: FlipGame;
let editor: LayoutEditor;

function newLay(): LayGame {
  const g = new LayGame(
    LAYOUTS[layCfg.redIdx].cells,
    LAYOUTS[layCfg.blueIdx].cells,
    { revealAll: layCfg.revealAll },
  );
  g.turn = layCfg.firstMove;
  return g;
}

// ── 原版 9 宫格皮肤 → CSS ────────────────────────────────────
function skinCss(): string {
  const out: string[] = [];
  for (const [name, s] of Object.entries(A.manifest.skin)) {
    const [t, r, b, l] = s.slice;
    // 按钮那几张的源图中段只有 1px，不加 `fill` 会在按钮正中漏一条透明缝
    // （见 shell.ts 的 SKIN_FILL 注释）。
    const fill = SKIN_FILL.includes(name) ? " fill" : "";
    out.push(
      `.sk-${name}{border-image-source:url(./assets/${s.file});` +
        `border-image-slice:${t} ${r} ${b} ${l}${fill};` +
        `border-image-repeat:stretch;border-style:solid;}`,
    );
  }
  return out.join("\n");
}

function skinOf(el: HTMLElement): string | null {
  for (const c of el.classList) {
    if (c.startsWith("sk-")) {
      const n = c.slice(3);
      if (A.manifest.skin[n]) return n;
    }
  }
  return null;
}

function applySkin(el: HTMLElement, name: string, scale = uiScale): void {
  const s = A.manifest.skin[name];
  if (!s) return;
  el.classList.add("sk", `sk-${name}`);
  const [t, r, b, l] = s.slice;
  // 把切片宽度也暴露成 CSS 变量：`.dlg-inner` 靠它反向抵消九宫格 border 的偏移
  // （绝对定位子元素相对 padding box，而原版 XML 的 rect 相对整框左上角）。
  el.style.setProperty("--bt", `${(t * scale).toFixed(2)}px`);
  el.style.setProperty("--br", `${(r * scale).toFixed(2)}px`);
  el.style.setProperty("--bb", `${(b * scale).toFixed(2)}px`);
  el.style.setProperty("--bl", `${(l * scale).toFixed(2)}px`);
  // 尺寸由 XML 给死的面板（如布阵工具栏）不能被强行定高，只补边框宽度。
  if (el.dataset.fitsize === "1") {
    el.style.boxSizing = "border-box";
    el.style.borderWidth =
      `${(t * scale).toFixed(2)}px ${(r * scale).toFixed(2)}px ` +
      `${(b * scale).toFixed(2)}px ${(l * scale).toFixed(2)}px`;
    return;
  }
  // 元素定高 = (上切片 + 下切片) × scale + 2px。
  // 原版这些皮肤的中段只有 1px，若元素被压到比上下切片还扁，中段会退化成
  // 0 高 —— 面板底色就从中间漏出来。留 2px 让中段稳定存在，皮肤才完整。
  const vsum = t + b;
  if (vsum > 0) {
    el.style.boxSizing = "border-box";
    el.style.height = `${(vsum * scale + 2).toFixed(2)}px`;
  }
  el.style.borderWidth =
    `${(t * scale).toFixed(2)}px ${(r * scale).toFixed(2)}px ` +
    `${(b * scale).toFixed(2)}px ${(l * scale).toFixed(2)}px`;
}

function refreshSkins(): void {
  for (const el of document.querySelectorAll<HTMLElement>(".sk")) {
    // 菜单/工具栏这类「尺寸自定」的面板由各自的重排函数按 view.scale 处理，
    // 不能用 uiScale 覆盖。
    if (el.dataset.fitsize === "1") continue;
    const n = skinOf(el);
    if (n) applySkin(el, n, uiScale);
  }
}

function skinButton(
  label: string,
  opts: { skin?: string; onClick: () => void; wide?: boolean },
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ui-btn" + (opts.wide ? " wide" : "");
  b.textContent = label;
  applySkin(b, opts.skin ?? "btn");
  b.addEventListener("click", () => {
    play(A, "click0");
    opts.onClick();
  });
  return b;
}

// ── HUD ─────────────────────────────────────────────────────
/**
 * 状态提示条（棋盘顶部那条圆角窄条）。
 *
 * ★ 这里曾经有个**系统性 bug**：`style.css` 的 `.toast` 默认 `opacity:0`，
 *   只有 `.toast[data-on="1"]` 才亮 —— 而本函数从前只写 `textContent` 与
 *   `dataset.tone`，**从不设 `data-on`**。后果是每一条文字反馈（"没有可悔的棋"、
 *   "布阵合法，可开战"、菜单各子项的说明……）全部**永久不可见**，
 *   于是所有按钮看起来都"点了没反应"。
 *   修法：写字的同时点灯（`data-on="1"`），到点自动熄灭并清掉残留计时器。
 *
 * 传空串 = 立刻熄灭（进主菜单时用）。
 */
const STATUS_HOLD_MS = 2600;
let statusTimer = 0;

function status(text: string, tone: "info" | "good" | "bad" = "info"): void {
  const el = $("#statusText");
  el.textContent = text;
  el.dataset.tone = tone;
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = 0;
  }
  if (!text) {
    el.dataset.on = "0";
    return;
  }
  el.dataset.on = "1";
  statusTimer = window.setTimeout(() => {
    statusTimer = 0;
    // 期间可能又被别的消息续上了（那时会新开一个计时器），别误熄。
    if (el.textContent === text) el.dataset.on = "0";
  }, STATUS_HOLD_MS);
}

function logRows(msgs: readonly GameMessage[]): HTMLElement {
  const d = document.createElement("div");
  d.className = "log-list";
  for (const m of msgs.slice(-80).reverse()) {
    const row = document.createElement("div");
    row.className = "log-row";
    row.dataset.tone = m.tone;
    row.textContent = m.text;
    d.appendChild(row);
  }
  return d;
}

// ── 画布 ────────────────────────────────────────────────────
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;

// ── 首页（启动主菜单）────────────────────────────────────────
/**
 * 原版开机停在启动菜单（实拍 `tools/_emu/s03.png`），所以复刻版默认也是它。
 * 版面在 `index.html` 里是静态的（背景 / 标题 / 5 个按钮），这里只做两件事：
 * 把素材路径接上、按当前 scale 摆放并绑事件。
 *
 * ★ 按钮位置一律用 `HOME_BUTTONS` 的 art 坐标乘 scale —— 不写媒体查询、
 *   不用 flex 居中，因为原版是按 720×1280 设计空间绝对定位摆的，
 *   任何"自适应"布局都会在不同屏宽下与原版分道扬镳。
 */
function buildHome(): void {
  $<HTMLImageElement>("#homeBg").src = "./assets/bg_main.jpg";
  $<HTMLImageElement>("#homeTitle").src = "./assets/title_main.png";
  $<HTMLImageElement>("#homeHouseImg").src = "./assets/home_house.png";
  document
    .getElementById("homeHouse")
    ?.addEventListener("click", () => {
      play(A, "click0");
      homeHouseTap();
    });

  const wire = (id: string, fn: () => void): void => {
    document.getElementById(id)?.addEventListener("click", () => {
      play(A, "click0");
      fn();
    });
  };
  // 人机对战 = 原版流程：**直接开局**，不弹「新局」对话框。
  //
  // ★ 实证（2026-09-13 雷电 9 实拍）：在主菜单点「人机对战」后 3 秒截屏，
  //   画面与原版翻棋开局图 `s10_flip.png` **逐像素相同（差值 0.000）** ——
  //   即 60 格铺满**绿色背面**、双方均未翻开。原版用的是「新局」对话框里的
  //   **默认值**：先后手=我先手、电脑水平=普通、玩法=**翻棋**、明暗棋=**暗棋**。
  //   （默认值出处：`g04_restart.png` / `s13_newdlg.png` 实拍的对话框。
  //     这里曾错写成 `setMode("lay")`（布局），导致一开局就把双方棋子全摊开，
  //     与用户反馈的「我不是暗棋吗」一致。）
  //
  //   想换玩法/难度，走棋盘菜单 →「重新开始」，那里才会弹「新局」对话框。
  wire("btnOne", () => {
    vsAi = true;
    aiLevelId = DEFAULT_AI_LEVEL; // 普通
    layCfg.firstMove = Side.Red; // 我先手
    layCfg.revealAll = false; // 暗棋
    flip = new FlipGame();
    setMode("flip");
    showStartBanner();
    afterTurn(flip.messages);
  });
  // 两人对战 = 本地双人（同一个棋盘轮流点）。
  wire("btnTwo", () => {
    vsAi = false;
    setMode("lay");
  });
  // 下面三个原版走的是网络/蓝牙，网页复刻版没有对应后端 —— 明说而不是假装能点。
  const offline = (what: string, why: string): void => {
    status(`${what}：${why}`, "info");
  };
  // 联网对战：复刻版自建的两人联机（中继服务器 `tools/netserver.mjs`，
  // 协议 = 只转发开局参数 + 点击格号，两边各自跑确定性规则引擎）。
  wire("btnNet", () => openNetDialog());
  wire("btnPeer", () => offline("联机（蓝牙）", "网页环境没有蓝牙对局通道"));
  wire("btnSg", () =>
    offline("四国军棋", "原版是独立联网游戏（121.43.147.41:8635），不在本次复刻范围"),
  );
  // 「AI 观战」= 复刻版自加：两台电脑自己下，人在旁边看（见 `enterWatch`）。
  // 首页「AI 观战」不再直接开局：先弹「观战开局」让你挑玩法 / 明暗棋 / 两边棋手。
  // （想跳过这一步可以直接开 `?watch=1&wshow=0`，见 URL 参数表。）
  wire("btnWatch", () => openWatchStart());
}

/**
 * 把按钮文字画进一张**设计尺寸**的离屏画布，再以 `<img>` 贴回按钮。
 *
 * 为什么不用 DOM 文字：原版整帧是「先按 720×1280 栅格化 → 双线性放大 1.25×」出的图
 * （见 `.home-stage` 注释），文字边缘因此被摊开 —— 实拍「灰阶像素 : 纯白像素」= 3.04。
 * Chrome 静态渲染时会把 DOM 文字**按最终设备尺寸重新栅格化**，笔画明显更肥
 * （灰/白 = 1.35）；`transform: scale()` 与 `filter: blur()` 都改不动它
 * （实测：亚像素 blur 被 Chrome 量化成 0，≥0.5px 才动但那样已经糊过头）。
 * 而位图 `<img>` 不会被重新栅格化，只会被双线性放大 —— 正好等于原版那条管线。
 */
const LABEL_CACHE = new Map<string, string>();

function labelUrl(
  text: string,
  font: string,
  size: number,
  lineH: number,
  boxW: number,
  boxH: number,
  cx: number,
  cy: number,
): string {
  const key = [text, font, size, lineH, boxW, boxH, cx, cy].join("|");
  const hit = LABEL_CACHE.get(key);
  if (hit) return hit;
  const cv = document.createElement("canvas");
  cv.width = Math.round(boxW);
  cv.height = Math.round(boxH);
  const c = cv.getContext("2d");
  if (!c) return "";
  c.font = `${size}px ${font}`;
  c.fillStyle = "#ffffff";
  c.textAlign = "center";
  c.textBaseline = "alphabetic";
  // 用字体自身的 ascent/descent 把每行摆进它的行盒 —— 与 DOM 的
  // `line-height` + `align-items:center` 同一套排版，只是这里落在画布上。
  const m = c.measureText("国");
  const asc = m.fontBoundingBoxAscent || size * 0.88;
  const desc = m.fontBoundingBoxDescent || size * 0.12;
  const lines = text.split("\n");
  const pitch = size * lineH;
  const top = cy - (lines.length * pitch) / 2;
  lines.forEach((ln, i) => {
    const base = top + i * pitch + (pitch - (asc + desc)) / 2 + asc;
    c.fillText(ln, cx, base);
  });
  const url = cv.toDataURL("image/png");
  LABEL_CACHE.set(key, url);
  return url;
}

/** 给首页按钮挂上「画布文字」图层（设计单位，随 `.home-stage` 一起被放大）。 */
function paintHomeLabel(
  el: HTMLButtonElement,
  text: string,
  font: string,
  size: number,
  lineH: number,
  w: number,
  h: number,
  dy: number,
): void {
  // 文字在按钮里的落点 = 皮肤 9 宫格「内容区」的中心（与 `.home-btn` 的
  // `inline-flex` + `align-items:center` 等价），再叠一个实拍反推的纵向微调。
  const [t, r, b, l] = A?.manifest.skin?.[SKIN_BTN]?.slice ?? [44, 8, 45, 8];
  const url = labelUrl(text, font, size, lineH, w, h, (l + w - r) / 2, (t + h - b) / 2 + dy);
  if (!url) return;
  let img = el.querySelector<HTMLImageElement>(".home-btn-label");
  if (!img) {
    el.textContent = ""; // 可见文字改由图层承担；无障碍名走 aria-label
    el.setAttribute("aria-label", text.replace("\n", ""));
    img = document.createElement("img");
    img.className = "home-btn-label";
    img.alt = "";
    img.draggable = false;
    el.appendChild(img);
  }
  // 画布就是按钮的**边框盒**。绝对定位子元素的包含块是内边距盒，所以要把
  // 边框厚度负向抵消，图层才正好压在按钮整块底板上（不能靠 CSS 的 width:100%）。
  img.style.left = `${-l}px`;
  img.style.top = `${-t}px`;
  img.style.width = `${w}px`;
  img.style.height = `${h}px`;
  if (img.src !== url) img.src = url;
}

/**
 * 摆放首页各元素（几何见 `ui/shell.ts` 的 HOME_* 常量）。
 *
 * ⚠️ 全部用**设计单位**（720×1280）写坐标，缩放交给 `.home-stage` 的
 * `transform: scale()` 一次搞定 —— 不要在这里乘 `s`。
 * 位图素材（背景 / 标题 / 房子）因此走「按设计尺寸摆放 → 放大」的管线，
 * 与原版一致；文字由 `paintHomeLabel` 单独转成位图处理（原因见其注释）。
 */
function layoutHome(): void {
  const s = view.scale;
  const stage = document.getElementById("homeStage");
  if (stage) stage.style.transform = `scale(${s})`;

  const title = $<HTMLImageElement>("#homeTitle");
  title.style.left = `${HOME_TITLE.x}px`;
  title.style.top = `${HOME_TITLE.y}px`;
  title.style.width = `${HOME_TITLE.w}px`;
  title.style.height = `${HOME_TITLE.h}px`;

  const house = document.getElementById("homeHouse");
  if (house) {
    house.style.left = `${HOME_HOUSE.x}px`;
    house.style.top = `${HOME_HOUSE.y}px`;
    house.style.width = `${HOME_HOUSE.w}px`;
    house.style.height = `${HOME_HOUSE.h}px`;
  }

  for (const b of HOME_BUTTONS) {
    const el = document.getElementById(b.id) as HTMLButtonElement | null;
    if (!el) continue;
    el.style.left = `${b.x}px`;
    el.style.top = `${b.y}px`;
    el.style.width = `${b.w}px`;
    el.style.height = `${b.h}px`;
    // 按钮底板 = 原版 `btn.cfg` 九宫格（与对话框里的确定/取消同一套皮肤）。
    // `fitsize=1` 让 `applySkin` 别改高度 —— 尺寸由界面 XML 定死（上例 375×90），
    // 而且它同时让 `refreshSkins()` 跳过这个元素、不会用 uiScale 覆盖 view.scale。
    // scale 传 1：borderWidth 也走设计单位，随 stage 一起被 transform 放大。
    el.dataset.fitsize = "1";
    applySkin(el, "btn", 1);
    // 字面由常量驱动（不入 DOM 文本层）：单行用 label，两行才断行 ——
    // 免得 index.html 里写的字和 HOME_BUTTONS 悄悄不一致。
    paintHomeLabel(
      el,
      b.text ?? b.label,
      b.twoLine ? "MYingHeiGB" : "ZYKai",
      b.twoLine ? HOME_SG_TEXT_SIZE : HOME_TEXT_SIZE,
      b.twoLine ? HOME_SG_LINE_HEIGHT : 1,
      b.w,
      b.h,
      b.twoLine ? HOME_SG_LABEL_DY : HOME_LABEL_DY,
    );
  }
}

/**
 * 原版页面排版：**棋盘铺满整宽，标题栏吃掉剩余高度**（见 `ui/shell.ts` 的标定）。
 * 900×1600 时得到 scale 1.25 / 标题栏 150，与原版实拍的 1.2491 / 148.6 差 1.4px。
 */
function resize(): void {
  if (!A) return;
  const app = $("#app");
  // ⚠️ 必须量**视口**，不能量 `#app` 自己 —— `resize()` 会写 `#app` 的宽高，
  // 拿它当输入就形成自反馈：首帧 `#app` 还是 auto（logo 113 + canvas 默认 150 = 263），
  // 于是 scale 被算成 263/1280 = 0.2055，写回去之后下一帧读到的又是 148×263，
  // 恰好自洽 —— 结果整个页面缩成 148px 宽，再也弹不回来。
  const root = document.documentElement;
  const cssW = root.clientWidth;
  const cssH = root.clientHeight;
  const L = layoutShell(cssW, cssH);

  app.style.width = `${L.width}px`;
  app.style.height = `${L.height}px`;
  app.style.gridTemplateRows = `${L.titleH}px 1fr`;

  // 原版标题 logo 是**非等比**拉进固定框的（实拍字形宽高比 2.400、素材 2.238），
  // 所以宽高都照着实测的「字形 ↔ 字形」换算写死，位置也用绝对定位而不是居中
  // —— 居中会差 1.4 原图单位（≈1.8px）。见 ui/shell.ts 的 LOGO_* 常量。
  const logo = $<HTMLImageElement>("#titleLogo");
  logo.style.width = `${LOGO_BOX_W * L.scale}px`;
  logo.style.height = `${LOGO_BOX_H * L.scale}px`;
  logo.style.left = `${(LOGO_CX - LOGO_BOX_W / 2) * L.scale}px`;
  logo.style.top = `${(LOGO_CY - LOGO_BOX_H / 2) * L.scale}px`;

  // 棋盘区（标题栏以下整块），画布就铺满它 —— 所以视图里 ox/oy 恒为 0。
  const area = $("#boardArea");
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const areaW = area.clientWidth;
  const areaH = area.clientHeight;
  canvas.width = Math.round(areaW * dpr);
  canvas.height = Math.round(areaH * dpr);
  canvas.style.width = areaW + "px";
  canvas.style.height = areaH + "px";
  view = L.view;
  canvas.title =
    `${ART_W}×${ART_H} 原始棋盘位图 · 铺满整宽 · 缩放 ${(view.scale * 100).toFixed(0)}%`;

  // 控件皮肤随棋盘等比缩放；对话框与棋盘同比例。
  uiScale = Math.max(0.42, Math.min(0.9, view.scale * 0.62));
  setDialogScale(view.scale);
  // 状态提示条：贴在标题栏下沿（主菜单态标题栏虽 hidden 但仍占位，
  // 所以两种模式都用同一个 top，提示条不会跳）。
  const toast = $("#statusText");
  toast.style.top = `${L.titleH + 8}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  refreshSkins();
  placeFloats();
  layoutHome();
  relayoutDialog();
  // 棋盘宽变了 ⇒ 外侧留白也变了，学习面板要重新决定宽度/要不要显示。
  layoutWatchStudy();
  draw();
}

/**
 * 原版局内那两枚浮动图标（见 `ui/shell.ts` 的标定）。
 *
 * 关键：素材是 `datax` 720dp 那一套，**与棋盘同一密度，按 1:1 画**
 * —— 所以这里没有任何图标缩放系数，图幅就是素材尺寸 93×68。
 * 位置以**图幅中心**计，实测左 (217.6, 579)、右 (502.4, 579)（棋盘区坐标）。
 */
let floatMenu: HTMLButtonElement | null = null;
let floatUndo: HTMLButtonElement | null = null;

function buildFloats(): void {
  const phMenu = document.getElementById("floatMenu");
  const phUndo = document.getElementById("floatUndo");
  floatMenu = floatButton(FLOAT_ART_W, FLOAT_ART_H, "float_menu.png", "菜单", () =>
    openMenu(),
  );
  floatUndo = floatButton(FLOAT_ART_W, FLOAT_ART_H, "icon_next.png", "悔棋", () =>
    // 观战时它是「暂停 / 继续」（图标由 `syncFloatIcons` 换）。
    watchOn ? watchTogglePause() : doUndo(),
  );
  // 接班时要**把 id 一起带过来**：`index.html` 里的占位元素叫 floatMenu/floatUndo，
  // 替换掉的旧元素带走了 id，之后 #floatMenu 就选不中了（`tools/_audit/dlg_shot.mjs`
  // 这类脚本、以及自动化自检都靠这个 id 定位）。
  floatMenu.id = "floatMenu";
  floatUndo.id = "floatUndo";
  phMenu?.replaceWith(floatMenu);
  phUndo?.replaceWith(floatUndo);
  // 布局阶段的对局按钮与布阵界面的那个图标不同，这里按实拍切换。
  syncFloatIcons();
}

function syncFloatIcons(): void {
  if (!floatMenu) return;
  if (mode === "edit") setFloatIcon(floatMenu, "float_lay.png", "布阵");
  else setFloatIcon(floatMenu, "float_menu.png", "菜单");
  // 右侧那枚：对局里是「悔棋」，观战里换成「暂停 / 继续」——
  // 观战悔棋等于替 AI 改棋（`doUndo` 里另有保险丝），而"暂停"才是这里真需要的。
  if (floatUndo) {
    if (watchOn) {
      setFloatIcon(
        floatUndo,
        watchPaused ? "icon_next.png" : "icon_finish.png",
        watchPaused ? "继续观战" : "暂停观战",
      );
    } else {
      setFloatIcon(floatUndo, "icon_next.png", "悔棋");
    }
  }
}

// ── 观战控制条（挂在标题栏里）────────────────────────────────
/**
 * 观战的常驻操作面：左边两行解说、右边四枚按键。
 *
 * 为什么放**标题栏**而不是棋盘上：标题栏是这个页面里唯一一整块"不承载棋局像素"
 * 的区域，叠上去不遮任何一格棋子（棋盘像素保真是本项目的底线）。
 * 配色沿用标题栏的蓝色系，不抢戏。
 */
function buildWatchChrome(): void {
  const bar = document.querySelector<HTMLElement>(".titlebar");
  if (!bar) return;

  const info = document.createElement("div");
  info.id = "watchInfo";
  info.hidden = true;
  const head = document.createElement("div");
  head.id = "watchHead";
  const body = document.createElement("div");
  body.id = "watchBody";
  info.append(head, body);

  const box = document.createElement("div");
  box.id = "watchBar";
  box.hidden = true;
  const mk = (id: string, icon: string, label: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "watch-btn";
    b.id = id;
    b.title = label;
    b.setAttribute("aria-label", label);
    const img = document.createElement("img");
    img.src = `./assets/${icon}`;
    img.alt = "";
    img.draggable = false;
    // 暂停钮的图标要就地切换（暂停 ↔ 继续），给它一个 id 让 `syncWatchChrome` 找得到。
    if (id === "watchPause") img.id = "watchPauseIcon";
    b.appendChild(img);
    b.addEventListener("click", () => {
      play(A, "click0");
      fn();
    });
    return b;
  };
  box.append(
    mk("watchPause", "icon_finish.png", "暂停 / 继续", () => watchTogglePause()),
    mk("watchStep", "icon_redo.png", "走一手（逐手研究）", () => watchStepOnce()),
    mk("watchLog", "icon_stat.png", "观战棋谱", () => openWatchLog()),
    mk("watchExit", "icon_exit.png", "退出观战", () => watchExit()),
  );
  bar.append(info, box);
}

/* ── 右侧学习面板 ────────────────────────────────────────────
 * 观战"学棋"的主界面：把「这一手是谁走的、走之前它考虑了哪些着法、走完局面如何」
 * **常驻**在屏幕右侧。
 *
 * 为什么不能只靠标题栏那条解说条：它只有两行、走一手就翻页 —— 而"看思路"恰恰需要
 * 停一会儿、来回看（用户原话："走棋走得太快，我都来不及看他的思路"）。
 * 所以：面板不会自己消失 + 配合 `WATCH_SPEEDS` 的「逐」档（走一手停一手）。
 *
 * 面板挂在 `body` 上、`position: fixed` 贴右 —— 用的正是棋盘的**外侧留白**，
 * 不压棋盘（`#app` 宽度 = 棋盘宽，见 `resize()`）。留白不够就整块收起，
 * 否则宁可没有面板，也不能糊在棋盘上挡住棋子。
 */

/** 建面板骨架（默认隐藏；显隐/宽度交给 `layoutWatchStudy`）。 */
function buildWatchStudy(): void {
  const box = document.createElement("div");
  box.id = "watchStudy";
  box.hidden = true;
  const title = document.createElement("div");
  title.id = "wsTitle";
  title.textContent = "学习面板 · 看思路";
  const main = document.createElement("div");
  main.id = "wsMain";
  const opts = document.createElement("div");
  opts.id = "wsOpts";
  const hist = document.createElement("div");
  hist.id = "wsHist";
  box.append(title, main, opts, hist);
  document.body.appendChild(box);
}

/** 手表里的"谁" —— 翻棋定色前只认玩家号。 */
function plyWho(p: WatchPly): string {
  return p.side === Side.None ? `玩家${p.seat + 1}` : sideName(p.side);
}

/**
 * 刷新学习面板内容（每次 `watchStatus()` 尾部都会走一遍）。
 *
 * ⚠️ **不看 `hidden`**：屏幕窄时面板虽然不显示，DOM 里仍要有内容 ——
 *    无头自检正是靠读这块 DOM 来验"它到底算出了什么"。
 */
function syncWatchStudy(): void {
  const box = document.getElementById("watchStudy");
  if (!box) return;
  if (!watchOn || (mode !== "lay" && mode !== "flip")) {
    box.hidden = true;
    return;
  }
  const main = document.getElementById("wsMain");
  const optBox = document.getElementById("wsOpts");
  const hist = document.getElementById("wsHist");
  if (!main || !optBox || !hist) return;
  optBox.replaceChildren();

  const last = watchPlies.at(-1);
  if (!last) {
    main.textContent = "两台电脑正在准备…";
    hist.textContent = "";
    return;
  }

  const arrow = last.flip ? "" : `　${cellLabel(last.from)} → ${cellLabel(last.to)}`;
  const dTag =
    last.delta === 0
      ? "±0"
      : last.delta > 0
        ? `▲${Math.round(last.delta)}`
        : `▼${Math.round(-last.delta)}`;
  const stat = last.cloud
    ? `云端决策 ${Math.round(last.ms)}ms`
    : `搜索 ${last.depth} 层 · ${fmtNum(last.nodes)} 节点 · ${Math.round(last.ms)}ms`;
  const why = last.cloud && last.why ? `\n它给的理由：${last.why}` : "";
  // 局面重复了就说破 —— 「看着像卡住了」和「正在磨循环」观感一样，但只有后者该判和。
  const rep = watchRepeatNow();
  const repLine =
    rep > 1 ? `\n⚠ 这个局面已经出现过 ${rep} 次（同一局面满 ${DRAW_REPETITION} 次判和）` : "";
  main.textContent =
    `第 ${last.n} 手　${plyWho(last)} · ${last.level}\n` +
    `${last.flip ? "翻开暗子" : "走子"}${arrow}\n` +
    `${stat}\n` +
    `走后局面分 ${Math.round(last.score)}　（这一手 ${dTag}）` +
    why +
    repLine;

  const b = last.brief;
  if (b) {
    const head = document.createElement("div");
    head.className = "ws-head";
    const nAvoid = b.options.filter((o) => o.avoid).length;
    head.textContent =
      `它从 ${b.total} 种走法里挑出 ${b.considered} 条来掂量` +
      `（下表按「走后局面分」从高到低）` +
      (nAvoid ? `；其中 ${nAvoid} 条会走回旧局面（标 ↺，已降权）` : "");
    optBox.appendChild(head);
    const show = b.options.slice(0, WATCH_OPTION_SHOW);
    // 实际走的那条要是没进前几名，补一行挂上去 —— 这行才是最该看的。
    if (b.rank > show.length) {
      const c = b.options.find((o) => o.chosen);
      if (c) show.push(c);
    }
    for (const o of show) {
      const row = document.createElement("div");
      row.className = "ws-opt";
      row.dataset.chosen = o.chosen ? "1" : "0";
      row.dataset.avoid = o.avoid ? "1" : "0";
      const txt = document.createElement("span");
      txt.className = "ws-opt-txt";
      txt.textContent = o.avoid ? `↺ ${o.text}` : o.text;
      const sc = document.createElement("span");
      sc.className = "ws-opt-score";
      sc.textContent = String(Math.round(o.score));
      row.append(txt, sc);
      optBox.appendChild(row);
    }
    const note = document.createElement("div");
    note.className = "ws-note";
    // 两个顺位都要报 —— 它们是**两把尺子**：搜索前是"吃子优先"的启发式，
    // 排名是走完之后的静态局面分。只报一个数，读者会以为它走错了。
    const chosenOpt = b.options.find((o) => o.chosen);
    const both =
      `✓ 实际落子那条：搜索前第 ${b.rootRank} 顺位 · 走后局面分第 ${b.rank} 名`;
    // 走了往回的一手：这不是错，是"别的路更差" —— 得说出来，否则会被当成引擎抽风。
    const loopTail = chosenOpt?.avoid
      ? "　★它仍然走了往回的那一手 —— 说明别的路更不划算。这一局多半要靠「同一局面重复判和」收尾。"
      : "";
    if (b.rootRank === 1 && b.rank === 1) {
      note.textContent = `${both}。（两把尺子都指向它 —— 没什么可犹豫的一手）${loopTail}`;
    } else if (b.rootRank === 1) {
      note.textContent =
        `${both}。吃子优先，所以搜索前它一上来就排第一；局面分低不代表走错 —— ` +
        `静态账只算「这手值多少」，算不出一手之后的还击。${loopTail}`;
    } else if (b.rank === 1) {
      note.textContent = `${both}。它往下搜了才相中这条（静态账原本没排第一）。${loopTail}`;
    } else {
      note.textContent =
        `${both}。两个顺位都靠后 —— 通常说明这一手是在「都想不出好棋」的局面里挑的，` +
        `或者搜索算到了静态账看不见的东西。${loopTail}`;
    }
    optBox.appendChild(note);
  } else {
    const note = document.createElement("div");
    note.className = "ws-note";
    note.textContent = last.cloud
      ? "云端手没有「搜索过哪些着法」这回事 —— 它的思路就是上面那句理由。"
      : last.flip
        ? "翻棋的一手（翻开 / 走子）没有「走完后的局面分」可比。"
        : "这一手没记下候选 —— 面板是刚打开的？下一手就有了。";
    optBox.appendChild(note);
  }

  const rows = watchPlies.slice(-6).reverse();
  hist.textContent =
    "最近 6 手\n" +
    rows
      .map((p) => {
        const d =
          p.delta === 0
            ? ""
            : p.delta > 0
              ? ` ▲${Math.round(p.delta)}`
              : ` ▼${Math.round(-p.delta)}`;
        return `${String(p.n).padStart(3, " ")}. ${plyWho(p)}·${p.level} ${p.text}${d}`;
      })
      .join("\n");
}

/** 面板的显隐与宽度（窗口尺寸一变就要重算）。 */
function layoutWatchStudy(): void {
  const box = document.getElementById("watchStudy");
  if (!box) return;
  if (!watchOn || !watchStudyOn) {
    box.hidden = true;
    return;
  }
  const app = document.getElementById("app") as HTMLElement | null;
  const appW = app?.clientWidth ?? 0;
  // 棋盘居中 ⇒ 单侧留白 = (视口宽 − 棋盘宽) / 2；再留 24px 呼吸位。
  const avail = (document.documentElement.clientWidth - appW) / 2 - 24;
  if (avail < 168) {
    // 窄屏：没有外侧留白可用。收起面板，靠「逐」档 + 解说条看棋。
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.dataset.fit = avail < 300 ? "tight" : "full";
  box.style.width = `${Math.min(340, avail)}px`;
}

/** 退出观战 → 回主菜单。**必须先 `stopWatch()`**，否则定时器会把下一手排进首页。 */
function watchExit(): void {
  stopWatch();
  setMode("home");
  status("已退出观战", "info");
}

/**
 * 某一座的执子者名号 —— 引擎给等级名（「困难」…），云端给「云端」。
 *
 * ⚠️ 会被拼进 ☰ 菜单的标签，**≤4 字**（原版 IconBtn 标签区就这么宽，超了会溢出格子）。
 */
function agentLabel(seat: 0 | 1): string {
  return watchKind[seat] === "cloud" ? "云端" : aiLevel(watchLv[seat]).name;
}

/**
 * 点一下换执子者：`新手 → 容易 → 普通 → 高级 → 困难 → 云端 → 新手`。
 *
 * 顺序刻意把「云端」放在**最难的引擎之后** —— 用户点到底就会发现还有个云端选项，
 * 而不是夹在中间被顺手跳过。
 */
function cycleWatchAgent(seat: 0 | 1): void {
  if (watchKind[seat] === "cloud") {
    watchKind[seat] = "engine";
    watchLv[seat] = AI_LEVELS[0].id;
    watchSaveKind();
    return;
  }
  const i = AI_LEVELS.findIndex((l) => l.id === watchLv[seat]);
  if (i >= AI_LEVELS.length - 1) {
    watchKind[seat] = "cloud";
    watchSaveKind();
    return;
  }
  watchLv[seat] = AI_LEVELS[i + 1].id;
}

/** 棋谱的纯文本版（贴到别处继续研究用 —— "学习技法"的最后一步）。 */
function watchText(): string {
  const head =
    watchVariant === "flip"
      ? "军棋 AI 观战 · 翻棋"
      : `军棋 AI 观战 · 布局（${watchReveal ? "明棋" : "暗棋"}）`;
  const lv =
    `红方 ${agentLabel(0)}  vs  蓝方 ${agentLabel(1)}` +
    `  ·  ${watchPlies.length} 手`;
  const rows = watchPlies.map((p) => {
    const who = p.side === Side.None ? `玩家${p.seat + 1}` : sideName(p.side);
    const d =
      p.delta === 0 ? "" : p.delta > 0 ? ` ▲${Math.round(p.delta)}` : ` ▼${Math.round(-p.delta)}`;
    // 引擎手报"搜多深"，云端手报"想多久 + 为什么" —— 两类信息不可互换。
    const tail = p.cloud
      ? `   [云端 ${Math.round(p.ms)}ms${p.why ? ` · ${p.why}` : ""}]`
      : `   [${p.depth}层 ${p.nodes}节点 ${Math.round(p.ms)}ms]`;
    return `${String(p.n).padStart(3, " ")}. ${who} ${p.text}${d}${tail}`;
  });
  return [head, lv, "", ...rows].join("\n");
}

/** 观战棋谱 —— 逐手列出，带搜索深度 / 节点数 / 耗时 / 分差。 */
function openWatchLog(): void {
  play(A, "click0");
  const body = document.createElement("div");
  body.className = "dlg-scroll";
  const list = document.createElement("div");
  list.className = "watch-log";
  if (watchPlies.length === 0) {
    const e = document.createElement("div");
    e.className = "watch-empty";
    e.textContent = "还没有走子。点标题栏的暂停钮旁边那个「走一手」，或按「继续」让它自己下。";
    list.appendChild(e);
  }
  // 最新的在最上面（与「行棋记录」一致）——观战看的是"刚刚那手"。
  for (const p of watchPlies.slice().reverse()) {
    const row = document.createElement("div");
    row.className = "watch-row";
    row.dataset.seat = String(p.seat);
    row.dataset.tag = p.delta > 0 ? "good" : p.delta < 0 ? "bad" : "flat";
    const no = document.createElement("span");
    no.className = "watch-no";
    no.textContent = String(p.n);
    const txt = document.createElement("span");
    txt.className = "watch-txt";
    txt.textContent = p.why ? `${p.text} —— ${p.why}` : p.text;
    const meta = document.createElement("span");
    meta.className = "watch-meta";
    const stat = p.cloud
      ? `云端 ${Math.round(p.ms)}ms`
      : `${p.depth}层 ${fmtNum(p.nodes)} ${Math.round(p.ms)}ms`;
    meta.textContent =
      stat +
      (p.delta === 0 ? "" : p.delta > 0 ? ` ▲${Math.round(p.delta)}` : ` ▼${Math.round(-p.delta)}`);
    row.append(no, txt, meta);
    list.appendChild(row);
  }
  body.appendChild(list);
  openDialog(
    {
      icon: "icon_stat.png",
      title: `观战棋谱（${watchPlies.length} 手）`,
      body,
      designW: 675,
      designH: 707,
      okText: "复制棋谱",
      cancelText: "关闭",
      onOk: () => {
        const txt = watchText();
        void copyText(txt).then((ok) =>
          status(ok ? `已复制 ${watchPlies.length} 手棋谱到剪贴板` : "复制失败，可手动选中文本", ok ? "good" : "bad"),
        );
      },
      onCancel: () => status("已关闭观战棋谱"),
    },
    openWatchLog,
  );
}

/** 复制到剪贴板；失败不抛（权限/非安全上下文都可能失败）。 */
async function copyText(t: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    return false;
  }
}

/** 换棋手 —— 红/蓝各自的 AI 等级。两边不同，才看得到"高手怎么赢新手"。 */
function openWatchGraders(): void {
  play(A, "click0");
  const build = (): void => {
    const rows = [
      {
        label: "红方:",
        value: agentLabel(0),
        onCycle: () => {
          cycleWatchAgent(0);
          refreshDialog();
        },
      },
      {
        label: "蓝方:",
        value: agentLabel(1),
        onCycle: () => {
          cycleWatchAgent(1);
          refreshDialog();
        },
      },
    ];
    openDialog(
      {
        icon: "icon_config.png",
        title: "棋手水平",
        rows,
        designW: 675,
        designH: 707,
        onOk: () => {
          closeDialog();
          // 云端棋手要能出网才走得动 —— 现在就提醒，别等它卡在"思考中"才发现。
          const needCfg =
            (watchKind[0] === "cloud" || watchKind[1] === "cloud") && !aidConfigured();
          status(
            `红方 ${agentLabel(0)} 对 蓝方 ${agentLabel(1)}（下一手起生效）` +
              (needCfg ? " —— 云端棋手还没配置：去「功能设置」填接口地址 / API Key / 模型名" : ""),
            needCfg ? "bad" : "good",
          );
        },
        onCancel: () => status("未改动棋手水平"),
      },
      build,
    );
  };
  build();
}

/**
 * 观战开局 —— 选玩法 / 明暗棋 / 两边棋手，然后开一局。
 *
 * 首页「AI 观战」和 ☰「换个玩法」共用这一张表：用途不同（一个开局、一个换局），
 * 要选的却完全一样。写两遍的坏处不只是重复 —— 两处的缺省值迟早会漂移，
 * 于是"从首页进去是暗棋、从菜单换局变成明棋"这种坑就会出现。
 */
function openWatchStart(title = "观战开局"): void {
  play(A, "click0");
  const build = (): void => {
    const rows: DialogButton[] = [
      {
        label: "玩法:",
        // ⚠️ 值位图只有 **300 设计 px** 宽（原版 XML `Button rect="330,…,630,…"`），
        //    超出的部分会**静默裁掉两端**（不是溢出、不是换行）。
        //    所以这里刻意把**两个玩法都写出来**：旧版只写当前值（「布局」），
        //    用户看不到"翻棋"这三个字存在，会直接认为 AI 对战做不了翻棋
        //    （实测反馈："AI 对战增加翻棋"就是这么来的）。
        //    `A → B` 读作"现在是 A，点一下变 B" —— 当前值与可选项同时可见。
        value: watchVariant === "flip" ? "翻棋 → 布局" : "布局 → 翻棋",
        onCycle: () => {
          watchVariant = watchVariant === "flip" ? "lay" : "flip";
          refreshDialog();
        },
      },
    ];
    // 明暗棋 / 视角行 —— **两种玩法都有**（旧版只在布局下给，翻棋那半按了没反应，
    // 于是干脆整行不出现；结果是想看"AI 对战翻棋"的人连入口都看不见）。
    //   · 布局：既管 AI 的知情权（`layCfg.revealAll`），也管观者视角；
    //   · 翻棋：规则层恒为暗（盖着的子连 AI 都不知道，只能靠推理），
    //           所以这一行只决定**观者**看到什么 —— 全知 / 跟对局一样。
    // 读的变量因此不同：布局读 `watchReveal`、翻棋读 `watchGod`（`enterWatch` 里
    // 布局会把 `watchGod` 同步成 `watchReveal`，所以这里切换时也顺手同步一下，
    // 免得框里切完再切玩法、两行显示的视角对不上）。
    //
    // ⚠️ 文案长度有硬上限：`dialogRow` 的值位图固定 **300 设计 px 宽**
    //    （原版 XML `Button rect="330,…,630,…"`），超出部分会**静默裁掉两端**，
    //    看起来像文字溢出按钮 —— 实测「暗棋（AI 靠推理）」= 366px 就是被裁的。
    //    `DLG_TEXT_SIZE`（45px）下最多约 6 个全角字，这里刻意留余量。
    //    改动后请跑 `npm run probe`：有哨兵实测每行文案宽度。
    rows.push({
      label: "明暗棋:",
      value:
        watchVariant === "flip"
          ? watchGod
            ? "明棋：全知"
            : "暗棋：对局"
          : watchReveal
            ? "明棋：全知"
            : "暗棋：靠推理",
      onCycle: () => {
        if (watchVariant === "flip") {
          watchGod = !watchGod;
        } else {
          watchReveal = !watchReveal;
          watchGod = watchReveal;
        }
        refreshDialog();
      },
    });
    rows.push(
      {
        label: "红方:",
        value: agentLabel(0),
        onCycle: () => {
          cycleWatchAgent(0);
          refreshDialog();
        },
      },
      {
        label: "蓝方:",
        value: agentLabel(1),
        onCycle: () => {
          cycleWatchAgent(1);
          refreshDialog();
        },
      },
    );
    openDialog(
      {
        icon: "icon_newgame.png",
        title,
        rows,
        designW: 675,
        designH: 707,
        onOk: () => {
          closeDialog();
          enterWatch(watchVariant, true);
          const needCfg =
            (watchKind[0] === "cloud" || watchKind[1] === "cloud") && !aidConfigured();
          status(
            watchVariant === "flip"
              ? `翻棋观战开局（${watchGod ? "全知" : "对局"}视角） · 红${agentLabel(0)} / 蓝${agentLabel(1)}` +
                  (needCfg ? " —— 云端棋手还没配置：去「功能设置」填接口地址 / API Key / 模型名" : "")
              : `${watchReveal ? "明棋" : "暗棋"}观战开局 · 红${agentLabel(0)} / 蓝${agentLabel(1)}` +
                  (needCfg ? " —— 云端棋手还没配置：去「功能设置」填接口地址 / API Key / 模型名" : ""),
            needCfg ? "bad" : "good",
          );
        },
        onCancel: () => status("未开局"),
      },
      build,
    );
  };
  build();
}

/** ☰ 里的「换个玩法」—— 同一条开局流程，只是标题不同。 */
function openWatchNew(): void {
  openWatchStart("观战新局");
}

/**
 * 观战专用 ☰ —— 与对局菜单分开。
 *
 * 对局里的「悔棋 / 电脑变着 / AI 援助」在观战下要么无意义、要么会**破坏观战本身**
 * （悔一手就等于替 AI 改了棋）。所以这里换成一整套"看盘"的操作：
 * 暂停 / 单步 / 棋谱 / 上帝视角 / 速度 / 棋手 / 换玩法 / 退出。
 */
function openWatchMenu(): void {
  play(A, "click0");
  const close = (run: () => void) => () => {
    closeDialog();
    run();
  };
  const items: GridItem[] = [
    {
      icon: watchPaused ? "icon_next.png" : "icon_finish.png",
      label: watchPaused ? "继续观战" : "暂停观战",
      onClick: close(() => watchTogglePause()),
    },
    { icon: "icon_redo.png", label: "走一手", onClick: close(() => watchStepOnce()) },
    { icon: "icon_stat.png", label: "观战棋谱", onClick: close(() => openWatchLog()) },
    {
      icon: "icon_info.png",
      // ⚠️ 4 个字以内 —— 原版 IconBtn 的标签区就这么宽（见 `WATCH_SPEEDS.name` 的注释）。
      label: watchGod ? "视角·开" : "视角·关",
      onClick: close(() => {
        watchGod = !watchGod;
        draw();
        status(watchGod ? "上帝视角：暗子按真实身份画出来" : "回到对局视角：没翻开的子看不到", "info");
      }),
    },
    {
      icon: "icon_set.png",
      label: `速度·${WATCH_SPEEDS[watchSpeed].name}`,
      onClick: close(() => {
        watchSpeed = (watchSpeed + 1) % WATCH_SPEEDS.length;
        status(`观战速度：${WATCH_SPEEDS[watchSpeed].name}`, "info");
      }),
    },
    {
      icon: "icon_rule.png",
      label: watchStudyOn ? "面板·开" : "面板·关",
      onClick: close(() => {
        watchStudyOn = !watchStudyOn;
        layoutWatchStudy();
        syncWatchStudy();
        status(
          watchStudyOn
            ? "学习面板：开 —— 右侧逐手列出它考虑过的着法"
            : "学习面板：关（屏幕窄时它会自动收起，这里也能手动关）",
          "info",
        );
      }),
    },
    { icon: "icon_config.png", label: "指派棋手", onClick: close(() => openWatchGraders()) },
    { icon: "icon_new.png", label: "换个玩法", onClick: close(() => openWatchNew()) },
    { icon: "icon_exit.png", label: "退出观战", onClick: close(() => watchExit()) },
  ];
  const grid = iconGrid(items);
  // 一句话说清"现在是什么设置" —— 菜单标签只有 4 个字（原版 IconBtn 就这个宽度），
  // 完整语义得有个地方讲。
  status(
    `观战设置：${watchGod ? "上帝视角" : "对局视角"} · 速度${WATCH_SPEEDS[watchSpeed].name}` +
      `${isWatchStepMode() ? "（逐手：走一手停一手）" : ""}` +
      ` · 红${agentLabel(0)}/蓝${agentLabel(1)}`,
    "info",
  );
  openDialog(
    {
      icon: "icon_menu.png",
      title: "观战",
      header: false,
      body: grid,
      foot: false,
      designW: 675,
      designH: 428,
    },
    openWatchMenu,
  );
}

/** 把两枚浮动图标摆到原版位置（图幅中心 × 中缝中线）。 */
function placeFloats(): void {
  const s = view.scale;
  if (floatMenu) placeFloat(floatMenu, s, FLOAT_X_LEFT, FLOAT_Y, FLOAT_ART_W, FLOAT_ART_H);
  if (floatUndo) placeFloat(floatUndo, s, FLOAT_X_RIGHT, FLOAT_Y, FLOAT_ART_W, FLOAT_ART_H);
  // 布阵工具栏面板：原版 XML `rect="c-337,c-315,w675,h240"` ⇒ (23, 205) 675×240。
  const bar = document.getElementById("editBar");
  if (bar) {
    bar.style.left = `${EDIT_BAR.x * s}px`;
    bar.style.top = `${EDIT_BAR.y * s}px`;
    bar.style.width = `${EDIT_BAR.w * s}px`;
    bar.style.height = `${EDIT_BAR.h * s}px`;
    bar.style.setProperty("--ds", String(s));
    applySkin(bar, "popup", s);
  }
}

let openDlg: { dw: number; dh: number } | null = null;
function relayoutDialog(): void {
  if (!openDlg || !document.getElementById("modalHost")?.dataset.open) return;
  const box = document.querySelector<HTMLElement>("#modalHost .dlg");
  if (!box) return;
  // 先按设计稿摆好，再让内容自己把高度撑开 —— 顺序不能反，
  // `fitDialogHeight` 要读 `--ds` 才算得出子元素高度。
  layoutDialog(box, openDlg.dw, openDlg.dh);
  const h = fitDialogHeight(box, openDlg.dw, openDlg.dh);
  box.dataset.dh = String(h);
}

// ── 开局「战斗开始」横幅 ─────────────────────────────────────
//
// 原版开局会在棋盘正中盖一张「战斗开始」的文字图（素材 `start_banner.png`，
// 620×120，实测按 1.25 倍居中画在**棋盘中心**）。这是 native 临时绘制的，
// 静态资源里没有字面量 —— 完整实测过程见 `ui/renderer.ts: drawStartBanner`。
//
// 时长实测（雷电 9 · `tools/_audit/start_timing2.py`）：点击后棋盘出现（≈1.0s）
// 就开始显示，到 ≈3.3s 消失 ⇒ 保持约 2.1s，末尾约 0.35s 淡出，合计 ≈2.45s。
// 期间**不接受点击**、两枚浮动图标也不出现（实拍：横幅在时中央只有横幅）。
const BANNER_HOLD_MS = 2100;
const BANNER_FADE_MS = 350;
const BANNER_TOTAL_MS = BANNER_HOLD_MS + BANNER_FADE_MS;
/** 横幅起始时刻（`performance.now()`）；-1 = 没有横幅 */
let bannerT0 = -1;
let bannerRaf = 0;

/** 当前横幅不透明度：0 = 不显示。过期时顺手收尾（恢复浮动图标）。 */
function bannerAlpha(): number {
  if (bannerT0 < 0) return 0;
  const dt = performance.now() - bannerT0;
  if (dt >= BANNER_TOTAL_MS) return 0;
  if (dt <= BANNER_HOLD_MS) return 1;
  return 1 - (dt - BANNER_HOLD_MS) / BANNER_FADE_MS;
}

function setFloatsHidden(v: boolean): void {
  if (floatMenu) floatMenu.hidden = v;
  if (floatUndo) floatUndo.hidden = v;
}

/** 开一局新的「战斗」时调一次（翻棋/布局都要，布阵阶段不要）。 */
function showStartBanner(): void {
  // 自检（`?probe`/`?ai`/`?flipai`）里必须跳过：它们按同步循环跑，
  // 横幅会既挡点击又拖一帧 rAF，把断言搅乱。
  if (selfCheck) return;
  // 布阵（编辑）不是「战斗」，原版此时也不出横幅。
  if (mode === "edit") return;
  // 开战音效跟着横幅走（原版 `start.wav`）—— 集中在这里，八个开战入口就都一致。
  play(A, "start");
  bannerT0 = performance.now();
  setFloatsHidden(true);
  const tick = (): void => {
    if (bannerAlpha() <= 0) {
      bannerT0 = -1;
      bannerRaf = 0;
      setFloatsHidden(false);
      draw();
      return;
    }
    draw();
    bannerRaf = requestAnimationFrame(tick);
  };
  if (!bannerRaf) bannerRaf = requestAnimationFrame(tick);
}

/** 棋盘 + 可选的开局横幅 —— `draw()` 里所有分支都走这里，避免每处都补一遍。 */
function paint(inp: RenderInput): void {
  render(ctx, A, view, inp);
  drawStartBanner(ctx, A, view, bannerAlpha());
}

function draw(): void {
  if (!A || !ctx) return;
  // 首页整屏被背景图盖住，棋盘不可见 —— 别白跑一遍渲染（也避免用未初始化的对局态）。
  if (mode === "home") return;
  if (mode === "edit") {
    paint({
      pos: editorPosition(),
      // 己方格子 `revealed=1` 会亮字；对方 `revealed=0` 回落成蓝色背面。
      // 这里**不给 `onlySide`**：原版对面半盘的蓝背面是满亮的，变暗会破坏像素对齐。
      revealAll: false,
      viewer: null,
      backMode: "side",
      pieceSmooth,
      pieceSnap,
      selected: painterCell >= 0 ? painterCell : null,
      targets: [],
      lastMove: null,
      aidPair: aidMove,
    });
    return;
  }
  // 走子动画进行中：照"走子前"的盘面画，遮住原地那枚子，把飞行的子画在半路。
  if (anim) {
    const p = animPointAt(
      anim.path,
      anim.cum,
      anim.total,
      anim.duration,
      performance.now() - anim.start,
    );
    const overlay = { x: p.x, y: p.y, row: anim.rc[0], col: anim.rc[1] };
    if (mode === "flip") {
      paint({
        pos: anim.pre,
        // 观战 + 上帝视角：飞在半路的子也照真实身份画（见 `watchGod`）。
        revealAll: watchOn && watchGod,
        viewer: null,
        backMode: "neutral",
        pieceSmooth,
        pieceSnap,
        selected: null,
        targets: [],
        lastMove: anim.prevLast,
        hideCell: anim.from,
        overlay,
      });
    } else {
      // 暗棋下 viewer 必须是**走子方**：此刻 `lay.turn` 已经换成对手，
      // 照它画会把对手的暗子掀开 —— 所以从"走子前的盘面"里读归属。
      paint({
        pos: anim.pre,
        revealAll: (watchOn && watchGod) || lay.revealAll,
        viewer:
          watchOn && watchGod
            ? null
            : lay.revealAll
              ? null
              : (anim.pre.owner[anim.from] as Side),
        backMode: "side",
        pieceSmooth,
        pieceSnap,
        selected: null,
        targets: [],
        lastMove: anim.prevLast,
        hideCell: anim.from,
        overlay,
      });
    }
    return;
  }
  if (mode === "flip") {
    paint({
      pos: flip.pos,
      // ★ 观战的**上帝视角**：翻棋里未翻开的子照样按真实身份画出来。
      //   注意这只是**显示**——`flip.opts` / AI 的 `buildBelief` 一行没改，
      //   AI 自己仍然不知道暗子是什么（否则学到的是"开了天眼的 AI"的棋）。
      revealAll: watchOn && watchGod,
      // 翻棋定色前谁都不知道归属，所以不给任何人「己方全亮」的视角，
      // 未翻开的子一律中性背面（= 图集 r6c0 绿色，实拍确认）。
      viewer: null,
      backMode: "neutral",
      pieceSmooth,
      pieceSnap,
      selected: flip.selected >= 0 ? flip.selected : null,
      targets: flip.targets,
      lastMove: flip.lastMove,
      showTargets: aidHints,
      // ★ 翻棋也要画 AI 援助的蓝框。翻子时 `from === to`（见 `aidMove` 注释），
      //   两端框重合 = 「点这一张」，正好够用。漏了这一行会让提示条有字、
      //   棋盘上却什么都没有 —— 玩家照着点之前根本不知道点哪。
      aidPair: aidMove,
    });
    return;
  }
  paint({
    pos: lay.pos,
    // 观战 + 上帝视角 = 强制全亮（即使这局是暗棋）。布局观战里 `watchReveal`
    // 决定的是**规则层**给不给 AI 全知（明棋 AI 全知 / 暗棋 AI 靠推理），
    // 与观者看到的无关 —— 两者刻意分开。
    revealAll: (watchOn && watchGod) || lay.revealAll,
    // 暗棋的视角：联机时**固定成我自己的阵营**（对面那半盘永远是背面），
    // 本地双人时跟随当前行动方（两人共用一台机器，谁走谁看得见自己）。
    viewer:
      watchOn && watchGod
        ? null
        : lay.revealAll
          ? null
          : netActive
            ? netMySide()
            : lay.turn,
    backMode: "side",
    pieceSmooth,
    pieceSnap,
    selected: lay.selected >= 0 ? lay.selected : null,
    targets: lay.targets,
    lastMove: lay.lastMove,
    showTargets: aidHints,
    aidPair: aidMove,
  });
}

// ── 布阵 ────────────────────────────────────────────────────
let painterCell = -1;

/**
 * 布阵模式下**对面半盘**的展示布局。
 *
 * 原版实拍（`tools/_emu/s15_lay.png`）逐行实测：
 *   · 上半盘 = 对方 25 枚**蓝色背面**，中心像素恒为 `(40,104,160)` =
 *     图集末行 `r6c2`，且**没有变暗**（所以不能给 `onlySide`，否则会套 alpha 0.2）；
 *   · 下半盘 = 己方 25 枚**带字橙子**，进「布阵」时**已经是一套完整默认布阵**，
 *     逐格核对 = `LAYOUTS[0]`（00.lay）：师长连长营长团长排长 / 炸弹·工兵·司令 /
 *     军长炸弹·工兵团长 / 旅长·营长·连长 / 排长师长旅长工兵地雷 / 地雷军旗地雷排长连长。
 *     （5 个行营留空，正好 25 枚。）
 *   · 工具栏 `edit-bar` 是**盖在棋盘上**的浮层，压住对方第 7~9 行（设备 y 406~706），
 *     所以对方 6 行里能看见的只有第 11、10 行和一个被削掉上沿的第 6 行。
 *
 * 对方那半盘到底用哪套 `.lay` 看不出来（全盖着），固定取 `LAYOUTS[1]` 让截图可复现。
 */
const EDIT_OPP_IDX = 1;
let editOppCells: PieceType[] = [];

function buildEditOpponent(): void {
  const rec = LAYOUTS[EDIT_OPP_IDX % LAYOUTS.length];
  editOppCells = new Array(CELLS).fill(PieceType.Empty);
  const opp = editor.side === Side.Red ? Side.Blue : Side.Red;
  void opp;
  for (let li = 0; li < 30; li++) {
    const lr = (li / 5) | 0; // 0 = 最前线
    const lc = li % 5;
    // 蓝方阵地：行 6（最前线）… 行 11（大本营）——与 LayoutEditor 的 Red 映射镜像
    const br = 6 + lr;
    editOppCells[br * 5 + lc] = rec.cells[li] as PieceType;
  }
}

function editorPosition(): Position {
  const p = createEmptyPosition();
  for (let i = 0; i < CELLS; i++) {
    const t = editor.cells[i];
    if (t !== PieceType.Empty) {
      p.type[i] = t;
      p.owner[i] = editor.side;
      p.revealed[i] = 1;
    }
  }
  // 对面半盘：`revealed=0` + `owner=另一侧` ⇒ 渲染成该方背面（BACK_TILE[Blue] 蓝）
  const opp = editor.side === Side.Red ? Side.Blue : Side.Red;
  for (let i = 0; i < CELLS; i++) {
    const t = editOppCells[i];
    if (t !== PieceType.Empty) {
      p.type[i] = t;
      p.owner[i] = opp;
      p.revealed[i] = 0;
    }
  }
  return p;
}

function tileCanvas(t: PieceType, side: Side): HTMLCanvasElement {
  const at = A.manifest.pieceAtlas;
  const cw = at.tileW;
  const ch = at.tileH;
  const k = (t as number) - 1;
  const row = (side === Side.Red ? 0 : 3) + Math.floor(k / 4);
  const col = k % 4;
  const cv = document.createElement("canvas");
  cv.width = cw;
  cv.height = ch;
  cv.getContext("2d")!.drawImage(
    A.img[at.file], col * cw, row * ch, cw, ch, 0, 0, cw, ch,
  );
  return cv;
}

// ── 电脑对手 ────────────────────────────────────────────────
/** 电脑固定执蓝（远侧）；人执红（近侧、先手），与原版「我先手」默认一致。 */
const AI_SIDE = Side.Blue;

/** 该电脑思考并落子。 */
function aiTurn(): void {
  if (!vsAi) return;
  const lv = aiLevel(aiLevelId);

  if (mode === "lay") {
    if (lay.over || lay.turn !== AI_SIDE) return;
    const mv = aiChooseMove(lay.pos, AI_SIDE, lay.opts, lv, aiRngOverride ?? aiRng);
    if (!mv) {
      status("电脑无子可动", "bad");
      return;
    }
    const n0 = lay.messages.length;
    const before = lay.turn;
    const prevLast = lay.lastMove;
    const pre = clonePosition(lay.pos);
    lay.click(mv.from);
    lay.click(mv.to);
    const m = lay.messages.at(-1);
    play(A, lay.messages.length > n0 && m ? (m.tone === "good" ? "eat" : m.tone === "bad" ? "dead" : "move") : "move");
    if (!aiMoveLanded(lay.over, before, lay.turn)) return;
    afterTurn(lay.messages, takeMoveSpec(pre, prevLast, lay.lastMove));
    return;
  }

  if (mode === "flip") {
    if (flip.over) return;
    if (flip.turn !== 1) return; // 玩家 0 = 人，先翻
    const me = flip.sides[1];
    const act = aiChooseFlip(flip.pos, flip.opts, me, lv, aiRng);
    if (!act) {
      status("电脑无子可动", "bad");
      return;
    }
    const n0 = flip.messages.length;
    const before = flip.turn;
    const prevLast = flip.lastMove;
    const pre = clonePosition(flip.pos);
    if (act.kind === "flip") {
      flip.click(act.cell);
      play(A, "flip");
    } else {
      flip.click(act.from);
      flip.click(act.to);
      const m = flip.messages.at(-1);
      play(A, flip.messages.length > n0 && m ? (m.tone === "good" ? "eat" : m.tone === "bad" ? "dead" : "move") : "move");
    }
    if (!aiMoveLanded(flip.over, before, flip.turn)) return;
    afterTurn(flip.messages, takeMoveSpec(pre, prevLast, flip.lastMove));
    return;
  }
}

/**
 * 兜底：电脑的着法真的落到盘上了吗？
 *
 * 只要回合没换手、也没分出胜负，就说明这次着法被规则/会话层拒了。
 * 此时**必须停止重排**——`afterTurn()` 会再调 `scheduleAi()`，
 * 而 `scheduleAi()` 看到仍轮到自己就会再排一次，形成每 420ms 一次的空转，
 * 用户看到的就是"电脑一直在思考、永远不走"（翻棋进空行营曾踩过这个坑）。
 */
function aiMoveLanded(finished: boolean, before: 0 | 1 | Side, after: 0 | 1 | Side): boolean {
  if (finished || after !== before) return true;
  status("电脑着法未被接受，已停手（请重新开局）", "bad");
  draw();
  return false;
}

/** 轮到电脑时延迟一小会儿再走，模拟原版的"思考"停顿。 */
function scheduleAi(delay?: number): void {
  if (selfCheck) return; // 自检自己同步驱动，别插队
  // 观战：两边都是 AI，走的是另一套循环（`scheduleWatch`）——
  // 这里必须**先分流**，否则 `flip.turn !== 1` / `lay.turn !== AI_SIDE`
  // 会把红方那一半回合全挡掉，变成"只有蓝方在下"。
  if (watchOn) {
    scheduleWatch(delay);
    return;
  }
  if (!vsAi || aiBusy) return;
  if (mode !== "lay" && mode !== "flip") return;
  const myTurn =
    mode === "lay" ? !lay.over && lay.turn === AI_SIDE : !flip.over && flip.turn === 1;
  if (!myTurn) return;
  aiBusy = true;
  status("电脑思考中…", "info");
  window.setTimeout(
    () => {
      aiBusy = false;
      aiTurn();
    },
    delay ?? (mode === "flip" ? 200 : 420),
  );
}

// ── AI 观战（复刻版自加）──────────────────────────────────────
/**
 * 「两台电脑自己下、人在旁边看」。
 *
 * 用户的诉求是**学习**（原话：「可以观摩整个棋盘，学习他们的下棋技法」），
 * 所以这个模式不止是"自动播放"，还压了三件事：
 *   1. **上帝视角**（`watchGod`）：暗棋 / 翻棋里没翻开的子，照样按真实身份画出来。
 *      观者看到的**比 AI 多** —— 这正是"看清全局"的前提。
 *   2. **不给 AI 开挂**：AI 该猜的还是猜（`buildBelief`），规则层一行不改。
 *      否则学到的不是原版 AI 的棋，而是"开了天眼的 AI"的棋。
 *   3. **逐手点评**：每一手都留下搜索深度 / 节点数 / 墙钟耗时 / 走后的局面分，
 *      解说条与棋谱面板里都能看（`watchPlies`）。
 *   4. **执子者可分别指派**（`watchKind`）：一侧可以是**本地规则引擎**，
 *      另一侧可以是**云端模型**。于是 "AI 对战规则 ai" 的三种读法一套代码全覆盖：
 *      引擎打引擎 / 云端打引擎 / 云端打云端。
 *      云端那条路**复用「AI 援助」的管线**（`aiAidSuggest`）—— 合法性由本地规则层
 *      算好、交给模型在候选里挑一条并给理由，所以云端 AI **不可能**走出非法着法。
 *
 * ★ 实现上**不新增 `Mode`** —— 仍复用 `lay` / `flip` 两套会话对象，
 *   只多一个 `watchOn` 开关。理由：`draw()` / `session` / `renderer` / 规则层
 *   一行都不用改，也不会让"布局 / 翻棋"两条已经验收过的路径产生第三条分叉
 *   （这是本项目最容易引入回归的地方）。
 */

/**
 * 观战里一侧的执子者。
 *
 * - `"engine"`：本地 native 规则引擎（negamax + α-β），等级取 `watchLv[seat]`。
 * - `"cloud"`：云端模型（DeepSeek 这类），走「AI 援助」同一条管线，耗时是网络往返。
 */
type WatchAgentKind = "engine" | "cloud";

/**
 * 学习面板里「它考虑过的着法」的一条（只在**布局的引擎手**上算，见 `watchBrief`）。
 *
 * `score` 是**走完这手后、走子方视角**的局面分 —— 与 `WatchPly.score` 同一把尺子
 * （都是 `evalForSide`），所以列里各行、以及跟上一手的 `delta` 都直接可比。
 */
interface WatchOption {
  from: number;
  to: number;
  /** 人话（如「团长 行7列2→行5列2」/「连长 吃 排长」） */
  text: string;
  score: number;
  /** 是不是引擎真正落下的那一手 */
  chosen: boolean;
  /**
   * 走完会回到**已经出现过的局面**（引擎已按 `AVOID_PENALTY` 给它降权）。
   *
   * 有它面板才能解释一个看着奇怪的现象：「它这一手分数不低，为什么没走？」
   * —— 因为走了就会把刚才的循环重演一遍。
   */
  avoid?: boolean;
}

/** 一手的"思路摘要"（引擎手才有 —— 云端手没有搜索过程，它的理由在 `why` 里）。 */
interface WatchBrief {
  /** 引擎这一步的根候选条数（已按 `level.width` 截断） */
  considered: number;
  /** 全部合法着法数（截断之前）—— "它从多少种走法里挑" */
  total: number;
  /** 算过分、按局面分从高到低排好的候选（**已保证含实际选择**） */
  options: WatchOption[];
  /** 实际选择在 `options` 里的名次（1 起）；0 = 实际选择根本没进这份候选池 */
  rank: number;
  /**
   * 实际选择在**引擎搜索前排序**里的顺位（1 起）。
   *
   * 与 `rank` 是**两把尺子**，必须都给出来：搜索前的排序是"吃子一律优先"的启发式
   * （吃子直接 `+100000`），而 `rank` 是走完之后的静态局面分。引擎经常"启发式排第 1、
   * 静态分排第 5"——只报一个数会让人以为它走错了。
   */
  rootRank: number;
}

interface WatchPly {
  /** 第几手（1 起） */
  n: number;
  /** 座位号：0 = 红（近侧），1 = 蓝（远侧）。翻棋定色前靠它认人。 */
  seat: 0 | 1;
  /** 该手走子的阵营（翻棋定色前是 `Side.None`） */
  side: Side;
  /** 该手执子者的名号 —— 引擎是等级名（「困难」…），云端是「云端」 */
  level: string;
  /** 是不是"翻开一张暗子"（翻棋专有） */
  flip: boolean;
  from: number;
  to: number;
  /** 走完之后会话里那条日志的原文（含吃子 / 阵亡 / 同归于尽的结果） */
  text: string;
  /** 这一手的实测墙钟耗时（ms） */
  ms: number;
  /** 迭代加深实际搜完的层数 */
  depth: number;
  /** 搜索过的节点数 */
  nodes: number;
  /** 走完后、**走子方视角**的局面分（引擎自己的估值函数） */
  score: number;
  /** 与上一手（换算到同一视角）的分差：>0 = 这一手赚了 */
  delta: number;
  /** 这一手是不是**云端模型**下的（真时 `depth` / `nodes` 无意义，看 `why` 与 `ms`） */
  cloud: boolean;
  /** 云端模型给的一句话理由（本地引擎手恒为空串） */
  why: string;
  /** 引擎手的"考虑过哪些着法"（翻棋手 / 云端手为 `undefined`） */
  brief?: WatchBrief;
}

/**
 * 每手之间的停顿档位。
 *
 * · `gap` = 上一手落位后到下一手开始的间隔（"逐"档不用它 —— 那一档压根不排定时器）。
 * · `step: true` = **逐手模式**：走完一手就自动停住，等你按「走一手」/「继续」再走。
 *   这是"看思路"最舒服的节奏 —— 固定间隔再长，也会在你低头看面板时偷偷走掉两手。
 *
 * ⚠️ `name` **必须是单字**：它会被拼进 ☰ 菜单的标签（`速度·快`），
 *    而原版 IconBtn 的标签区只放得下 4 个字 —— "速度·极快" 会溢出格子、
 *    压到相邻项上（截图实测）。
 */
const WATCH_SPEEDS = [
  { name: "逐", gap: 0, step: true },
  { name: "慢", gap: 2600, step: false },
  { name: "中", gap: 1300, step: false },
  { name: "快", gap: 550, step: false },
  { name: "极", gap: 130, step: false },
] as const;

/** 当前档位是不是"逐手模式"（走一手停一手）。 */
function isWatchStepMode(): boolean {
  return WATCH_SPEEDS[watchSpeed].step === true;
}

/** 观战开关。为 true 时 `mode` 仍是 lay/flip，只是两台都由 AI 驱动。 */
let watchOn = false;
let watchPaused = false;
/** 上帝视角：暗子也按真实身份画（观者比 AI 看得多）。 */
let watchGod = true;
/**
 * 停顿档位下标（见 `WATCH_SPEEDS`）。
 *
 * ★ 缺省是 **1 = 「慢」**（2.6s/手），不是"中"。观战的用途是**学棋**，
 *   上一版的 0.9s 被用户吐槽"走得太快，来不及看思路"—— 学习场景宁可慢。
 */
let watchSpeed = 1;
/**
 * 右侧**学习面板**是否展开。
 *
 * 和"上帝视角 / 速度"不同，这个开关**不写 localStorage**：它是布局选择
 * （屏幕窄的时候会自动隐藏），不是"我想怎么观战"的意图。
 */
let watchStudyOn = true;
/** 红 / 蓝两侧的**本地引擎**等级 id（仅当该座位由引擎执子时生效） */
let watchLv: [number, number] = [5, 5];
/**
 * 红 / 蓝两侧**分别由谁执子** —— "AI 对战规则 AI"的那个开关。
 *
 * `"engine"` = 本地规则引擎（等级见 `watchLv`）；`"cloud"` = 云端模型。
 * 两边独立，任意组合 ⇒ 引擎打引擎 / 云端打引擎 / 云端打云端。
 */
let watchKind: [WatchAgentKind, WatchAgentKind] = ["engine", "engine"];
/** 在途的云端请求；退出观战 / 换局时要 abort，否则迟到的结果会落到新局面上 */
let watchAbort: AbortController | null = null;
/**
 * 解说条要**常驻**显示的一句话（云端失败 / 未配置之类）；空串 = 照常显示上一手。
 *
 * 为什么不能只靠 `status()` 的 toast：它 2.6 秒就消失，而"云端为什么不动了"
 * 正是用户会盯着看的那句话。
 */
let watchNote = "";

/**
 * 观战里**跨刷新值得记住**的只有一件事：两侧执子者。
 *
 * 其余（速度 / 视角 / 玩法）是一次性的观看偏好，忘了也无所谓；但"我把红方设成了云端"
 * 是跟已配置的 API 绑在一起的意图 —— 刷新一次就退回引擎会让人以为没生效。
 */
const WATCH_LS = {
  kind: "junqi.watch.kind",
  variant: "junqi.watch.variant",
  reveal: "junqi.watch.reveal",
} as const;

/** 把两侧执子者写成 `cloud,engine` 这样的串。 */
function watchSaveKind(): void {
  lsSet(WATCH_LS.kind, watchKind.join(","));
}

/** 启动时读回。只认 `cloud`，其余一律当本地引擎 —— 旧值 / 手改值都不能让状态变非法。 */
function watchLoadKind(): void {
  const raw = lsGet(WATCH_LS.kind).split(",");
  if (raw.length !== 2) return;
  watchKind = [raw[0] === "cloud" ? "cloud" : "engine", raw[1] === "cloud" ? "cloud" : "engine"];
}

/**
 * 记住"上一局怎么开的"（玩法 + 明暗棋）。
 *
 * 观战是**反复开局**的场景（换一局、换玩法、换棋手），每次都要重挑一遍明暗棋很烦。
 * 速度 / 上帝视角这类"看的时候才调"的偏好**不记** —— 每次开局回到缺省更省事。
 */
function watchSaveSetup(): void {
  lsSet(WATCH_LS.variant, watchVariant);
  lsSet(WATCH_LS.reveal, watchReveal ? "1" : "0");
}

function watchLoadSetup(): void {
  const v = lsGet(WATCH_LS.variant);
  if (v === "flip" || v === "lay") watchVariant = v;
  const r = lsGet(WATCH_LS.reveal);
  if (r === "1" || r === "0") watchReveal = r === "1";
}
/** 观战用布局还是翻棋 */
let watchVariant: "lay" | "flip" = "lay";
/**
 * 布局观战是否明棋（true = AI 全知；false = **暗棋**，AI 靠推理）。
 *
 * 缺省是**暗棋**：观战的价值就在"看 AI 在信息不全时怎么权衡"，
 * 明棋那种双方全亮的局面，AI 和观者看到的一样多，可学的东西少得多。
 * 上一次的选择会被记住（`watchLoadSetup`）。
 */
let watchReveal = false;

/**
 * 观战里的**局面指纹历史** —— 防两台 AI 来回磨的核心数据。
 *
 * 每手落定后把新局面的指纹记进来；下一手就把它交给引擎当"规避列表"
 * （`AvoidMove`），让"会走回旧局面"的着法降权。两台实力相当的 AI
 * 最容易在两三个格之间来回走，光靠"70 步无吃子"要磨很久才收得住。
 *
 * ⚠️ 与 `session` 里的 `repeatDraw` 是**两层**，缺一不可：
 * - 这里是**事前**引导（让它别走回去）；
 * - `session` 那边是**事后**兜底（真走了三次重复就判和）。
 *   只会引导不会判和 ⇒ 万一它宁愿被降权也要走回去，观战就永远卡着；
 *   只会判和不会引导 ⇒ 干等 70 步，观战看起来像死机。
 */
const watchSeen = new Map<string, number>();

/**
 * 观战里的**「同一枚子最近挪了几手」滑动窗口** —— 抗磨的**主力判据**。
 *
 * ## 为什么不能用局面指纹当主力（2026-09-17 实测更正）
 *
 * 玩家实报「云端在两格之间来回走」，查下来是**同一枚子在自己两个相邻格之间
 * 往返**（截图那枚蓝团长在 `44 ↔ 39`）。而**别处的子同时在慢慢漂** ⇒
 * 整盘指纹**每手都是新的**：实测 87 手「不同局面 88 个、重复 0 次」。
 * **根本没有重复局面**，`watchSeen` 那套（不管惩罚多大）全都打空。
 *
 * ## 所以按「子」记
 *
 * 每手记下「哪个格子上的子被挪走了」；查询"这枚子最近挪了几次"时，
 * 数窗口内该**格子**被挪走的次数。同一枚子来回往返 ⇒ 它的起点格在窗口里
 * 反复出现 ⇒ 计数迅速升高 ⇒ `shufflePenalty` 加码把它按住。
 *
 * 用**格子**而不是子身份：引擎的着法只给 `from/to`，没有棋子 id；而且同一格
 * 上换过子也无妨 —— 那个格子反复进出本身就是"这一带在磨"的信号。
 *
 * ⚠️ 两者**都要**（`watchSeen` 留着）：指纹判据抓"双方都走回同一盘面"，
 * 子计数抓"一枚子来回挪"。实测指纹那条对实战磨法无效，但对**棋盘静止**的
 * 构造局面（单子对走）仍是对的，删了会退化。
 */
const watchMoveHist: number[] = [];
/** 只看最近这些手（与 `SHUFFLE_WINDOW` 同步）。 */
const WATCH_HIST_MAX = SHUFFLE_WINDOW;

/** 记一手"从 `from` 格挪走"。 */
function watchNoteMove(from: number): void {
  watchMoveHist.push(from);
  if (watchMoveHist.length > WATCH_HIST_MAX) watchMoveHist.shift();
}

/** 从 `from` 格出发的这一步，是这枚子最近第几次被挪（含本次 ⇒ 最小 1）。 */
function watchMovedCount(from: number): number {
  let n = 1;
  for (const f of watchMoveHist) if (f === from) n++;
  return n;
}

/** 观战重开时两套历史都要清（否则上一局的磨会被算进新局）。 */
function watchResetHistory(): void {
  watchSeen.clear();
  watchMoveHist.length = 0;
}

/** 观战里"当前局面"的指纹（布局用 `lay.turn`；翻棋用轮到那个座位的颜色）。 */
function watchKeyNow(): string {
  return mode === "flip"
    ? positionKey(flip.pos, flip.sides[flip.turn])
    : positionKey(lay.pos, lay.turn);
}

/** 记一手（开局也要记一次，否则第一次走回开局不会被认出来）。 */
function watchNotePos(): void {
  const k = watchKeyNow();
  watchSeen.set(k, (watchSeen.get(k) ?? 0) + 1);
}

/** 当前局面已经出现过几次（1 = 第一次）。 */
function watchRepeatNow(): number {
  return watchSeen.get(watchKeyNow()) ?? 1;
}

/**
 * 算出该劝退的着法，交给引擎降权。两条判据**同时**用（见 `watchMoveHist`）：
 *
 *   ① `times`   —— 走完会落回**已经出现过的整盘局面**（真·重复局面，平方加码）；
 *   ② `shuffle` —— 发起这步的**那枚子最近挪得太勤**（按子计数，线性加码）。
 *
 * 逐条着法试着走一步、取指纹、查历史即可 —— 成本是「合法着法数 × 一次克隆」，
 * 每手只算一次，相对一次搜索可以忽略。
 *
 * ★ 两条都要：实战里最常见的磨法是「一枚子来回走 + 别处慢慢漂」，
 *   **整盘指纹每手都是新的**（实测 87 手 0 重复）—— 只有 ② 抓得住；
 *   而"双方都走回同一盘面"只有 ① 抓得住。见 `watchMoveHist` 的注释。
 *
 * 吃子直接跳过：吃子必然改变子力 ⇒ 指纹不可能与历史重合，也不该被"劝别重复"拦。
 */
function watchAvoid(): AvoidMove[] {
  const isLay = mode === "lay";
  const pos = isLay ? lay.pos : flip.pos;
  const opts = isLay ? lay.opts : flip.opts;
  const me = isLay ? lay.turn : flip.sides[flip.turn];
  // 翻棋**定色前**只有"翻子"可走，没有走回去这回事（翻一张就变了局面）。
  if (!isLay && !flip.revealedColors) return [];
  // 走完轮到谁：布局是对家颜色，翻棋是另一个座位。
  const nextTurn = isLay ? opposite(me) : flip.sides[flip.turn === 0 ? 1 : 0];
  const out: AvoidMove[] = [];
  for (const m of allLegalMoves(pos, me, opts)) {
    if (m.capture) continue;
    const child = clonePosition(pos);
    applyMove(child, m.from, m.to, opts);
    // `times` = 该局面累计出现几次（0 = 新局面，不计入）；`shuffle` = 这枚子最近第几次挪。
    const times = watchSeen.get(positionKey(child, nextTurn)) ?? 0;
    const shuffle = watchMovedCount(m.from);
    // 一条都不命中就别塞进去 —— 让 `buildAvoidSet` 保持"只在真有问题时才生效"。
    if (times || shuffle > 1) out.push({ from: m.from, to: m.to, times, shuffle });
  }
  return out;
}
/** 逐手记录（棋谱） */
const watchPlies: WatchPly[] = [];
let watchTimer = 0;
let watchBusy = false;

/**
 * 云端手失败前最多要几轮（1 = 不重试），以及每轮之间等多久。
 *
 * 为什么这里还要一层重试（`postChat` 里已经有一次）：那一层救的是"一发之内的抖动"，
 * 而观战两轮之间隔着 2.6 秒以上 —— 代理重启、机场换节点这类事正好发生在这个空档里，
 * 等 1.5 秒再要一次就过去了。只有等完还不行才停手并说清原因。
 */
const CLOUD_TRY_ROUNDS = 2;
const CLOUD_RETRY_MS = 1500;
/**
 * 固定的随机源 —— 观战要**可复现**：同一局看两遍必须一模一样。
 * `aiChooseMove` 内部会拿它破对称（原版 `FUN_000aadf4(0,1)`），
 * 所以不能给 `Math.random`。
 */
let watchRng: () => number = makeRng(20260915);

/** 观战每手结束时刷新解说条 / 暂停钮的图标。 */
function syncWatchChrome(): void {
  if (!watchOn || (mode !== "lay" && mode !== "flip")) return;
  const info = document.getElementById("watchInfo");
  if (!info) return;
  const over =
    mode === "lay" ? lay.isDraw || lay.winner !== null : flip.isDraw || flip.winner !== null;
  info.dataset.state = over ? "over" : watchPaused ? "paused" : "run";
  const btn = document.getElementById("watchPauseIcon") as HTMLImageElement | null;
  if (btn) {
    const f = watchPaused ? "icon_next.png" : "icon_finish.png";
    if (!btn.getAttribute("src")?.endsWith(f)) btn.src = `./assets/${f}`;
  }
  // 浮动图标也要跟着变（右侧那枚在观战里就是"暂停/继续"）。
  syncFloatIcons();
}

/** 写解说条（标题栏左侧那块）。两行：状态行 + 上一手点评行。 */
function watchStatus(): void {
  if (!watchOn || (mode !== "lay" && mode !== "flip")) return;
  const info = document.getElementById("watchInfo");
  if (!info) return;
  const over =
    mode === "lay" ? lay.isDraw || lay.winner !== null : flip.isDraw || flip.winner !== null;

  const head = document.getElementById("watchHead");
  const body = document.getElementById("watchBody");
  if (!head || !body) return;

  if (over) {
    head.textContent = "观战 · 对局结束";
  } else if (watchPaused) {
    head.textContent = `观战 · 已暂停（第 ${watchPlies.length} 手）`;
  } else {
    head.textContent = `观战 · 第 ${watchPlies.length + 1} 手`;
  }

  const last = watchPlies.at(-1);
  // 常驻说明优先：暂停原因（云端失败 / 没配置）比"上一手走了什么"更该被看见。
  if (watchNote) {
    body.textContent = watchNote;
    syncWatchStudy();
    return;
  }
  if (!last) {
    body.textContent = "两台电脑正在准备…";
    syncWatchStudy();
    return;
  }
  const who = last.side === Side.None ? `玩家${last.seat + 1}` : sideName(last.side);
  const tag = last.flip ? "翻开" : "走子";
  const arrow = last.flip ? "" : ` (${cellLabel(last.from)}→${cellLabel(last.to)})`;
  const d = last.delta;
  const dTag = d === 0 ? "" : d > 0 ? ` ▲${Math.round(d)}` : ` ▼${Math.round(-d)}`;
  // 云端手没有"搜索深度/节点数"可言 —— 换成耗时可看的信息，并把模型给的理由带上。
  const detail = last.cloud
    ? `云端决策 ${Math.round(last.ms)}ms${last.why ? ` · ${last.why}` : ""}`
    : `深度${last.depth} 节点${fmtNum(last.nodes)} ${Math.round(last.ms)}ms`;
  body.textContent = `${who}·${last.level} ${tag}${arrow}${dTag}\n${detail}`;
  // 面板是"看思路"的主界面，解说条只是提要 —— 两者必须同一次刷新，别各走各的。
  syncWatchStudy();
}

function fmtNum(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 格子号 → 人话（"行4列2"）。日志里用的就是这个，方便对着棋盘找。 */
function cellLabel(cell: number): string {
  return `${rowOf(cell) + 1}行${colOf(cell) + 1}列`;
}

/**
 * 观战走一手 —— 先看**这一手轮到谁**，再决定是本地引擎还是云端模型。
 *
 * 谁走、由谁执子，都由局面自己决定 —— 这正是它和 `aiTurn()`（固定电脑执蓝）的区别。
 * 走完统一交给 `afterTurn(..., silent)`：它会放走子动画，动画收尾时再
 * `scheduleAi()` → `scheduleWatch()` 排下一手。于是"思考 → 走子 → 动画 → 再思考"
 * 的节奏与原版人机对战完全一致（云端只是把"思考"换成了网络往返）。
 *
 * ⚠️ 每手都要**重新查一次** `watchKind`：两边可以分别指派，绝不能开局定一次就完事。
 */
function watchStep(): void {
  if (!watchOn || watchBusy) return;
  if (mode !== "lay" && mode !== "flip") return;
  // 正在重新尝试 ⇒ 上一次的暂停原因已经过期，先撤掉（失败会再写一遍）。
  watchNote = "";
  const seat: 0 | 1 = mode === "lay" ? (lay.turn === Side.Red ? 0 : 1) : flip.turn;
  if (watchKind[seat] === "cloud") {
    void watchCloudStep(seat);
    return;
  }
  watchEngineStep();
}

/** 本地规则引擎走一手（同步 —— 原 `watchStep` 的主体，一行没动）。 */
function watchEngineStep(): void {
  // ── 布局（明棋 / 暗棋）──────────────────────────────────
  if (mode === "lay") {
    if (lay.over) {
      watchHold();
      return;
    }
    const side = lay.turn;
    const seat: 0 | 1 = side === Side.Red ? 0 : 1;
    const lv = aiLevel(watchLv[seat]);
    const pre = clonePosition(lay.pos);
    const prevLast = lay.lastMove;

    // 「会走回旧局面」的着法 —— 决策与学习面板用**同一份**，否则面板报的顺位
    // 与引擎眼里的不一致（那正是 Panel 最容易被冤枉的地方）。
    const avoidNow = watchAvoid();

    watchBusy = true;
    const t0 = performance.now();
    const mv = aiChooseMove(lay.pos, side, lay.opts, lv, watchRng, avoidNow);
    const ms = performance.now() - t0;
    watchBusy = false;

    if (!mv) {
      watchHold(`${sideName(side)} 无子可动`);
      return;
    }
    // 学习面板要的"它考虑过哪些着法"——**必须在落子前**算：走完盘面就变了，
    // 再回头算只会得到"另一半的棋"。（只对布局做，翻棋没有走完后的局面分可谈。）
    const brief = watchBrief(lay.pos, side, lay.opts, lv, mv.from, mv.to, avoidNow);
    const nMsg = lay.messages.length;
    const beforeTurn = lay.turn;
    lay.click(mv.from);
    lay.click(mv.to);
    if (lay.turn === beforeTurn && !lay.over) {
      // 与 `aiMoveLanded()` 同一道闸门：着法没被接受就**必须停手**，
      // 否则每 380ms 重排一次 = 观战界面空转（用户看到的就是"一直在思考"）。
      status("AI 着法未被规则接受，观战已停手", "bad");
      watchPaused = true;
      syncWatchChrome();
      return;
    }
    play(A, lay.messages.length > nMsg && lastToneIsGood(lay.messages) ? "eat" : "move");
    // 局面已经落定 ⇒ 立刻记账：下一手的"规避列表"就靠它。
    watchNotePos();
    watchNoteMove(mv.from);
    recordWatchPly(seat, side, lv.name, false, mv.from, mv.to, ms, { brief });
    const spec = takeMoveSpec(pre, prevLast, lay.lastMove);
    afterTurn(lay.messages, spec, true);
    watchStatus();
    syncWatchChrome();
    return;
  }

  // ── 翻棋 ────────────────────────────────────────────────
  if (flip.over) {
    watchHold();
    return;
  }
  const seat = flip.turn;
  const side = flip.revealedColors ? flip.sides[seat] : Side.None;
  const lv = aiLevel(watchLv[seat]);
  const pre = clonePosition(flip.pos);
  const prevLast = flip.lastMove;

  watchBusy = true;
  const t0 = performance.now();
  const act = aiChooseFlip(flip.pos, flip.opts, flip.sides[seat], lv, watchRng, watchAvoid());
  const ms = performance.now() - t0;
  watchBusy = false;

  if (!act) {
    watchHold(`${side === Side.None ? `玩家${seat + 1}` : sideName(side)} 无着可走`);
    return;
  }
  const nMsg = flip.messages.length;
  const beforeTurn = flip.turn;
  const beforeReveal = flip.revealedColors;
  let from = -1;
  let to = -1;
  let isFlip = false;
  if (act.kind === "flip") {
    from = act.cell;
    to = act.cell;
    isFlip = true;
    flip.click(act.cell);
    play(A, "flip");
  } else {
    from = act.from;
    to = act.to;
    flip.click(act.from);
    flip.click(act.to);
    play(A, flip.messages.length > nMsg && lastToneIsGood(flip.messages) ? "eat" : "move");
  }
  if (flip.turn === beforeTurn && !flip.over && flip.revealedColors === beforeReveal) {
    status("AI 着法未被规则接受，观战已停手", "bad");
    watchPaused = true;
    syncWatchChrome();
    return;
  }
  watchNotePos();
  // 翻子不是"挪子"（`from === to`），不进走动历史 —— 翻开的子身份已变，
  // 拿它当"这枚子在磨"是误伤。
  if (!isFlip) watchNoteMove(from);
  recordWatchPly(seat, side, lv.name, isFlip, from, to, ms);
  const spec = takeMoveSpec(pre, prevLast, flip.lastMove);
  afterTurn(flip.messages, spec, true);
  watchStatus();
  syncWatchChrome();
}

/** 座位 → 人话。翻棋定色前只认"玩家1/2"，定色后才是红/蓝。 */
function seatWho(seat: 0 | 1): string {
  if (mode === "flip" && !flip.revealedColors) return `玩家${seat + 1}`;
  const side = mode === "lay" ? (seat === 0 ? Side.Red : Side.Blue) : flip.sides[seat];
  return sideName(side);
}

/**
 * 云端模型走一手。
 *
 * **复用「AI 援助」那条管线**（`aiAidSuggest`）：合法候选由本地规则层算好，
 * 模型只负责"在候选里挑一条 + 说个理由"。所以云端棋手**不可能走出非法着法** ——
 * 幻觉顶多让它挑得不好，不会把棋下飞。
 *
 * 与引擎手的三处不同：
 *   1. **异步**：一次网络往返。期间 `watchBusy` 为真 ⇒ `watchStep` 直接返回、
 *      单步按钮也不会叠请求。
 *   2. **耗时是网络耗时**：棋谱里照记 `ms`，解说条上顶着"云思考中…"。
 *   3. **失败要停手**：网络 / 配额 / 未配置都会失败。此时**暂停并说清原因**，
 *      而不是偷偷改用引擎替它下 —— 那样看到的就不是云端 AI 的棋了（"学技法"的前提是真）。
 *      暂停是**可恢复**的：按「继续」或「走一手」＝重试。
 */
async function watchCloudStep(seat: 0 | 1): Promise<void> {
  if (!watchOn || watchBusy) return;
  if (mode !== "lay" && mode !== "flip") return;

  // 没配置就别发请求了 —— 把话说明白，并把这一侧退回引擎，免得卡在"思考中"。
  if (!aidConfigured()) {
    watchKind[seat] = "engine";
    watchPauseFor(
      `${seatWho(seat)}被指派成云端，但还没配置 API（「功能设置」里填接口地址 / API Key / 模型名），已退回本地引擎`,
    );
    return;
  }

  const isLay = mode === "lay";
  const pos = isLay ? lay.pos : flip.pos;
  const opts = isLay ? lay.opts : flip.opts;
  const reveals = isLay ? undefined : flipRevealCells(pos);
  // ★ 云端的**知情权**与本地引擎一致：暗棋里没翻开的子它也不该看见。
  //   观者的上帝视角是渲染层的事（`draw()` 里的 `revealAll`），不能顺手送给 AI ——
  //   否则它下的就不是同一盘棋了，"学技法"也就无从谈起。
  const revealAll = isLay ? lay.revealAll : false;
  const mover = isLay ? lay.turn : flip.revealedColors ? flip.sides[seat] : Side.None;

  // ★ 方案 B：让云端挑候选时参考"引擎深度 2 的 minimax 分"，而不是纯凭感觉。
  //   `evalPly2` 比方案 A 的单步 `evalForSide` 强一档：它往下展开对手最凶的一步应手，
  //   取"对手走完、轮到我这边的局面分"里的最坏值 —— 分数已隐含"这步会不会被反吃/送大子"。
  //   `makeRng(1)`：分必须**确定**，同一局面两遍不能是两个数。
  //   ★ 必须把 `watchAvoid()` 一起传进去：否则"走回旧局面"那条会带着虚高的分
  //     排到第一（两格同为行营时分差恒定 +10、往返净变化 0），模型照着分数挑就
  //     会来回磨 —— 实据见 2026-09-17「云端一直在两格之间来回走」。
  //   只对布局有意义；翻棋(含定色)跳过 —— 大量暗子未知，浅搜索意义不大，
  //   而且观战学习面板本来也只对布局展示局面分（见 `watchBrief` 注释）。
  const scores: AidScore[] | undefined =
    isLay && mover !== Side.None
      ? (() => {
          const byKey = evalPly2(pos, mover, opts, CLOUD_PLY2_WIDTH, makeRng(1), watchAvoid());
          const out: AidScore[] = [];
          byKey.forEach((score, key) =>
            out.push({ from: Math.floor(key / CELLS), to: key % CELLS, score }),
          );
          return out;
        })()
      : undefined;

  const ab = new AbortController();
  watchAbort = ab;
  watchBusy = true;
  const t0 = performance.now();
  status(`观战：${seatWho(seat)}（云端）思考中…`, "info");

  // 网络抖一下就再来一次，别一抖动就停盘（2026-09-15 玩家实报「read ECONNRESET」停在第 1 手）。
  // 与 `postChat` 里那次重试互补：那边救"一发之内的抖动"，这边救"隔一手的抖动"
  // （比如代理正好在重启、网关换节点）。只对瞬态失败生效，配置错照旧立刻停手。
  let s: AidSuggestion | null = null;
  let lastErr: unknown = null;
  let rounds = 0;
  try {
    for (let attempt = 1; attempt <= CLOUD_TRY_ROUNDS; attempt++) {
      rounds = attempt;
      try {
        s = await aiAidSuggest(
          aidCfg(),
          pos,
          mover,
          opts,
          revealAll,
          ab.signal,
          reveals,
          watchAvoid(),
          scores,
        );
        break;
      } catch (e) {
        lastErr = e;
        // 期间退出了观战 / 换了局 → 这条结果作废，别再要了。
        if (!watchOn || ab.signal.aborted) break;
        if (attempt >= CLOUD_TRY_ROUNDS || !isTransientNetError(e)) break;
        status(
          `观战：${seatWho(seat)}（云端）连接被打断，${CLOUD_RETRY_MS / 1000} 秒后再要一次…`,
          "info",
        );
        await new Promise<void>((r) => window.setTimeout(r, CLOUD_RETRY_MS));
      }
    }
  } finally {
    // 必须在这里放开：`applyCloudMove` 会顺着 afterTurn → scheduleWatch 排下一手，
    // 那时如果 `watchBusy` 还是真，下一手会被 `watchStep` 直接丢掉（观战原地卡住）。
    watchBusy = false;
    if (watchAbort === ab) watchAbort = null;
  }

  if (!watchOn || ab.signal.aborted) return;
  if (s) {
    applyCloudMove(seat, s, performance.now() - t0);
    return;
  }
  const why = lastErr instanceof Error ? lastErr.message : String(lastErr);
  watchPauseFor(
    `${seatWho(seat)}（云端）这一手失败：${why}` +
      (rounds > 1 ? `（已重试 ${rounds - 1} 次）` : "") +
      "。按「继续」再要一次，或用 ☰「换个玩法」把这一侧改成引擎",
  );
}

/**
 * 把云端挑出来的那一步真正落到盘上。
 *
 * `s.from` / `s.to` 来自本地算的候选表，所以这里和玩家点击走的是**同一条**
 * `session.click()` 通道 —— 规则判定不会出现两套。
 */
function applyCloudMove(seat: 0 | 1, s: AidSuggestion, ms: number): void {
  const isLay = mode === "lay";
  const side = isLay ? lay.turn : flip.revealedColors ? flip.sides[seat] : Side.None;
  const pre = clonePosition(isLay ? lay.pos : flip.pos);
  const prevLast = isLay ? lay.lastMove : flip.lastMove;
  const nMsg = isLay ? lay.messages.length : flip.messages.length;
  const beforeTurn = isLay ? lay.turn : flip.turn;
  const beforeReveal = isLay ? false : flip.revealedColors;
  const toneOf = (msgs: readonly GameMessage[]): "eat" | "dead" | "move" => {
    const m = msgs.at(-1);
    return msgs.length > nMsg && m ? (m.tone === "good" ? "eat" : m.tone === "bad" ? "dead" : "move") : "move";
  };

  if (isLay) {
    lay.click(s.from);
    lay.click(s.to);
    play(A, toneOf(lay.messages));
    if (lay.turn === beforeTurn && !lay.over) {
      applyCloudMoveRejected();
      return;
    }
    watchNotePos();
    watchNoteMove(s.from);
    recordWatchPly(seat, side, "云端", false, s.from, s.to, ms, { cloud: true, why: s.why });
    afterTurn(lay.messages, takeMoveSpec(pre, prevLast, lay.lastMove), true);
  } else {
    if (s.reveal) {
      // 翻子只要点一下（`from === to`，见 `AidSuggestion.reveal` 的注释）。
      flip.click(s.to);
      play(A, "flip");
    } else {
      flip.click(s.from);
      flip.click(s.to);
      play(A, toneOf(flip.messages));
    }
    if (flip.turn === beforeTurn && !flip.over && flip.revealedColors === beforeReveal) {
      applyCloudMoveRejected();
      return;
    }
    watchNotePos();
    if (!s.reveal) watchNoteMove(s.from);
    recordWatchPly(seat, side, "云端", s.reveal, s.from, s.to, ms, { cloud: true, why: s.why });
    afterTurn(flip.messages, takeMoveSpec(pre, prevLast, flip.lastMove), true);
  }
  watchStatus();
  syncWatchChrome();
}

/** 云端给的着法没被会话层接受 —— 与引擎那条同款保险丝：停手，别空转。 */
function applyCloudMoveRejected(): void {
  status("云端着法未被规则接受，观战已停手", "bad");
  watchPaused = true;
  syncWatchChrome();
  draw();
}

/**
 * 暂停观战并**把原因常驻在解说条上** —— 与 `watchHold()`（对局真结束了）区分开。
 *
 * 原因不能只靠 `status()` 的 toast：它 2.6 秒就没了，而"云端为什么不动了"
 * 恰恰是用户会盯着看的那句话。所以同时写进 `watchNote`，由 `watchStatus()` 常驻显示。
 */
function watchPauseFor(reason: string): void {
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = 0;
  }
  watchPaused = true;
  watchNote = reason;
  status(`观战已暂停：${reason}（按「继续」重试）`, "bad");
  watchStatus();
  syncWatchChrome();
  draw();
}

function lastToneIsGood(msgs: readonly GameMessage[]): boolean {
  return msgs.at(-1)?.tone === "good";
}

/** 学习面板里最多列几条候选（含实际选择那条）。 */
const WATCH_OPTION_SHOW = 5;
/**
 * 先拿多少条候选去算"走完后的局面分"。
 *
 * `evalForSide` 每次都要重建 belief 与攻守图（毫秒级），全盘六十来条着法全算会
 * 拖慢"极"档的节奏；而引擎自己看得上的本来就只有前几条 —— 取前 8 条足够。
 */
const WATCH_OPTION_POOL = 8;
/**
 * 云端浅搜索（`evalPly2`）里对手应手最多看几条。
 *
 * 对手会挑对自己最有利的（=对我最不利），取这些应手后的最坏分就是 minimax 语义。
 * 8 条足够抓住"最凶反击"：每次 `evalForSide` 亚毫秒级，候选几十条 × 应手 8 条 =
 * 观战每手几十毫秒，相对网络往返无感。宽度开大收益递减（对手走法再多，最凶的
 * 那几条基本都在前 8 里），还白耗本地算力。
 */
const CLOUD_PLY2_WIDTH = 8;
/** 候选着法的人话。只讲"谁走到哪 / 吃了谁"，不重复会话层那套结果文案。 */
function optionText(pos: Position, from: number, to: number): string {
  const name = pieceName(pos.type[from] as PieceType);
  const def = pos.type[to] as PieceType;
  return def === PieceType.Empty
    ? `${name} ${cellLabel(from)}→${cellLabel(to)}`
    : `${name} 吃 ${pieceName(def)}`;
}

/**
 * 算一手的"思路摘要" —— 它从多少种走法里挑、每条走完是什么局面分、实际挑了第几名。
 *
 * ★ 候选池的顺序是**引擎自己的眼光**（`aiRootOrder` 用的就是 `aiChooseMove` 那套根打分），
 *   但**展示时按局面分重排**：根打分里吃子一律 `+100000`，量级不可读；局面分则是
 *   观者能直接跟 `delta` 对照的数。
 *   两个排序**不一致**恰恰是最值一看的地方 —— 引擎敢放着静态分更高的着法不走，
 *   通常是它搜下去发现那手会被反吃（面板底部有这行提示，别让人误会它走错了）。
 *
 * ⚠️ 只对**布局**有意义：翻棋的候选里有"翻开某张暗子"，那没有"走完后的局面分"可谈。
 */
function watchBrief(
  pos: Position,
  side: Side,
  opts: RuleOptions,
  lv: AiLevel,
  from: number,
  to: number,
  avoid?: readonly AvoidMove[],
): WatchBrief {
  const all = allLegalMoves(pos, side, opts);
  const pool = aiRootOrder(pos, side, opts, { ...lv, width: WATCH_OPTION_POOL }, makeRng(1), avoid);
  // 搜索前的顺位要在**补进去之前**记 —— 补进去的那条必然落在末位，那就没意义了。
  const rootRank = pool.findIndex((m) => m.from === from && m.to === to) + 1;
  // ★ 实际落下的那一手**必须在池子里** —— 低难度档的 `width` 很窄、启发式也可能看走眼。
  //   学习面板最该讲的就是"它挑了哪条"，少了它就等于没讲。
  if (!pool.some((m) => m.from === from && m.to === to)) pool.push({ from, to, score: 0 });
  const options: WatchOption[] = pool.map((m) => {
    const after = clonePosition(pos);
    applyMove(after, m.from, m.to, opts);
    return {
      from: m.from,
      to: m.to,
      text: optionText(pos, m.from, m.to),
      // `makeRng(1)`：面板上的分必须**确定** —— 同一手看两遍不能是两个数。
      score: evalForSide(after, side, opts, makeRng(1)),
      chosen: m.from === from && m.to === to,
      // 这一条走完会不会被劝退 —— 与引擎的 `avoid` 同一套判据（指纹 + 子走动史）。
      avoid: watchSeen.has(positionKey(after, opposite(side))) || watchMovedCount(m.from) > 1,
    };
  });
  options.sort((a, b) => b.score - a.score);
  return {
    considered: pool.length,
    total: all.length,
    options,
    rank: options.findIndex((o) => o.chosen) + 1,
    rootRank: rootRank > 0 ? rootRank : 0,
  };
}

/**
 * 把这一手写进棋谱（含引擎的搜索统计与走后的局面分）。
 *
 * `extra.cloud` = 这一手是**云端模型**下的：此时 `AI_STATS` 里的深度/节点数是**上一次
 * 引擎搜索**的残留值，报出来就是假数据 —— 所以整块置 0，改用模型的理由 `why` 来说明。
 */
function recordWatchPly(
  seat: 0 | 1,
  side: Side,
  level: string,
  isFlip: boolean,
  from: number,
  to: number,
  ms: number,
  extra?: { cloud?: boolean; why?: string; brief?: WatchBrief },
): void {
  const pos = mode === "lay" ? lay.pos : flip.pos;
  const opts = mode === "lay" ? lay.opts : flip.opts;
  const msgs: readonly GameMessage[] = mode === "lay" ? lay.messages : flip.messages;
  // 走子方视角的局面分。`makeRng(1)` 每次给同一串随机数 —— 点评必须**确定**，
  // 否则同一局看两遍分数会不一样（`evalForSide` 内部要用 rng 破对称）。
  const scoreSide = side === Side.None ? (mode === "lay" ? lay.turn : flip.sides[seat]) : side;
  const score = evalForSide(pos, scoreSide, opts, makeRng(1));
  const prev = watchPlies.at(-1);
  const prevSame = prev ? (prev.seat === seat ? prev.score : -prev.score) : 0;
  const delta = prev ? score - prevSame : 0;
  // 这一手的"人话"就是会话层刚生成的那条日志 —— 别自己拼，免得两边不一致。
  const text = msgs.at(-1)?.text ?? "";
  watchPlies.push({
    n: watchPlies.length + 1,
    seat,
    side,
    level,
    flip: isFlip,
    from,
    to,
    text: isFlip ? text : `${text}（${cellLabel(from)}→${cellLabel(to)}）`,
    ms,
    depth: extra?.cloud ? 0 : AI_STATS.lastDepth,
    nodes: extra?.cloud ? 0 : AI_STATS.lastNodes,
    score,
    delta,
    cloud: !!extra?.cloud,
    why: extra?.why ?? "",
    brief: extra?.brief,
  });
}

/** 对局结束：停下循环、把结果写进解说条。 */
function watchHold(reason = ""): void {
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = 0;
  }
  watchPaused = true;
  watchNote = "";
  let msg = "观战结束";
  if (mode === "lay") {
    if (lay.isDraw) msg = `观战结束：和棋（${lay.drawReason}）`;
    else if (lay.winner !== null) msg = `观战结束：${sideName(lay.winner)}胜（${lay.winnerReason}）`;
  } else {
    if (flip.isDraw) msg = `观战结束：和棋（${flip.drawReason}）`;
    else if (flip.winner !== null) {
      msg = `观战结束：${sideName(flip.sides[flip.winner])}胜（${flip.winnerReason}）`;
    }
  }
  if (reason) msg += ` —— ${reason}`;
  // 终局原因**常驻**在解说条上（`watchNote`），不能只发一条 `status()` 飘过去 ——
  // 观战里"为什么停了"是最该看的东西，尤其是循环判和这种一眼看不出输赢的收尾。
  if (mode === "lay" ? lay.over : flip.over) watchNote = msg;
  status(msg, "good");
  watchStatus();
  syncWatchChrome();
  draw();
}

/** 排下一手。`watchPaused` 时不排（单步按钮直接调 `watchStep()`，绕过这里）。 */
function scheduleWatch(delay?: number): void {
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = 0;
  }
  if (!watchOn || watchPaused) return;
  if (mode !== "lay" && mode !== "flip") return;
  if (mode === "lay" ? lay.over : flip.over) return;
  // 逐手档：**不排定时器**，直接把观战停在这儿 —— 这就是"走一手停一手"。
  // 想继续就按「走一手」/「继续」（见 `watchTogglePause` 里的同款分支）。
  if (isWatchStepMode()) {
    watchPaused = true;
    watchStatus();
    syncWatchChrome();
    return;
  }
  const gap = delay ?? WATCH_SPEEDS[watchSpeed].gap;
  watchTimer = window.setTimeout(() => {
    watchTimer = 0;
    // 上一手还在路上（云端正思考）：**晚点再试，不能直接丢** ——
    // 一丢这条链就断了：之后再没人排下一手，观战会永远停在原地。
    if (watchBusy) {
      scheduleWatch(200);
      return;
    }
    watchStep();
  }, gap);
}

/** 暂停 / 继续。 */
function watchTogglePause(force?: boolean): void {
  watchPaused = force ?? !watchPaused;
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = 0;
  }
  if (!watchPaused) {
    // 逐手档里"继续"就是"再走一手然后停" —— 交给单步那条路。
    // （别走 `scheduleWatch`：它一看到逐手档会当场把 `watchPaused` 打回 true，
    //   看着就像"点了没反应"。）
    if (isWatchStepMode()) {
      // 先把状态记成"停"：万一 `watchStepOnce` 因为云端在途而早退，
      // 暂停钮也不该显示成"正在跑"。
      watchPaused = true;
      watchStepOnce();
      return;
    }
    status("继续观战", "info");
    scheduleWatch(WATCH_SPEEDS[watchSpeed].gap);
  } else {
    status(
      isWatchStepMode()
        ? "逐手模式：已经停住 —— 点「走一手」或「继续」再走下一手"
        : "观战已暂停 —— ☰ 里可以「走一手」逐手看",
      "info",
    );
  }
  watchStatus();
  syncWatchChrome();
  draw();
}

/**
 * 单步：只走一手，走完**保持暂停** —— 方便对着棋盘研究这一步。
 * （不想暂停就一直点它，或者按「继续」交回自动循环。）
 */
function watchStepOnce(): void {
  if (mode !== "lay" && mode !== "flip") return;
  // 云端上一手还在路上：再点也只会被 `watchBusy` 拦掉，不如直说。
  if (watchBusy) {
    status("云端正在思考，稍等一下…", "info");
    return;
  }
  if (mode === "lay" ? lay.over : flip.over) {
    watchHold();
    return;
  }
  watchPaused = false;
  watchStep();
  watchPaused = true;
  watchStatus();
  syncWatchChrome();
  draw();
}

/** 把观战关掉（回主菜单 / 换模式时必调 —— 否则定时器会把下一步排进新界面）。 */
function stopWatch(): void {
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = 0;
  }
  // 在途的云端请求也要断掉：它的回调一旦落地，会往**新界面**的盘面上落子。
  watchAbort?.abort();
  watchAbort = null;
  watchOn = false;
  watchPaused = false;
  watchBusy = false;
  watchNote = "";
  setWatchChromeVisible(false);
  syncFloatIcons();
}

/** 进入观战。`variant` 决定开局形态，`fresh` = 是否重开一局。 */
function enterWatch(variant: "lay" | "flip" = "lay", fresh = true): void {
  cancelAiAid();
  cancelAnim();
  // 换局前先把在途的云端请求断掉 —— 它的结果属于上一盘，落到新盘上就是脏数据。
  watchAbort?.abort();
  watchAbort = null;
  watchOn = true;
  watchPaused = false;
  watchBusy = false;
  watchNote = "";
  watchVariant = variant;
  vsAi = true; // 观战也是"有电脑"——让 ☰ / 状态判断与对局态一致
  setWatchChromeVisible(true);
  if (fresh) {
    watchPlies.length = 0;
    watchRng = makeRng((Date.now() ^ 0x5eed) >>> 0);
  }
  if (variant === "flip") {
    flip = new FlipGame((Date.now() ^ 0x1234) >>> 0);
    setMode("flip");
  } else {
    layCfg.revealAll = watchReveal;
    // ★ 观者的上帝视角**跟随明暗棋**（`watchGod = watchReveal`）。
    //
    //   为什么必须跟随：上帝视角一开就把暗棋抹平了 —— 盘面**和明棋一模一样**，
    //   用户根本分辨不出自己选的是哪种（实测反馈就是"我选的是暗棋，看起来还是明棋"）。
    //   所以：选了明棋 → 本来全亮，上帝视角开着无所谓；
    //        选了暗棋 → 回到对局视角（未翻开的子看不到），要偷看全貌自己在 ☰ 里开。
    //
    //   代价：每次新开一局都会按明暗棋重置一次上帝视角（"换个玩法"也是）。
    //   这是刻意的 —— 每局都该从"你这局选的明暗棋"的默认视角开始。
    watchGod = watchReveal;
    lay = newLay();
    setMode("lay");
  }
  // 观战专用：把"同一局面重复三次判和"打开（人机/双人对局仍是原版行为，不认这条）。
  (variant === "flip" ? flip : lay).setRepeatDraw(DRAW_REPETITION);
  // 指纹历史从**开局局面**开始记 —— 不然第一次走回开局不会被认出来。
  // 走动历史（抗磨第二判据）同样清零：上一局的磨不许算进新局。
  watchResetHistory();
  watchNotePos();
  // 记住这次怎么开的（下次进观战直接沿用）。
  watchSaveSetup();
  showStartBanner();
  afterTurn(variant === "flip" ? flip.messages : lay.messages, null, true);
  status(
    variant === "flip"
      ? `AI 观战（翻棋·${watchGod ? "全知" : "对局"}视角）：两台电脑轮流翻，你负责看（☰ 可暂停 / 走一手 / 切视角 / 换棋手）`
      : watchReveal
        ? "AI 观战（明棋）：两台电脑全知对决，你负责看（☰ 可暂停 / 走一手 / 换棋手）"
        : "AI 观战（暗棋）：AI 看不到对方的子、靠推理下（☰ 的「上帝视角」可偷看全貌）",
    "good",
  );
  watchStatus();
  syncWatchChrome();
}

function setWatchChromeVisible(v: boolean): void {
  const bar = document.getElementById("watchBar");
  const info = document.getElementById("watchInfo");
  if (bar) bar.hidden = !v;
  if (info) info.hidden = !v;
  const app = document.getElementById("app");
  if (app) app.dataset.watch = v ? "1" : "0";
  // 学习面板跟着观战一起显隐（宽度要看棋盘外侧还剩多少，所以由 `layoutWatchStudy` 定）。
  layoutWatchStudy();
}

// ── 交互 ────────────────────────────────────────────────────
function clickAt(px: number, py: number): void {
  if (mode === "rules") return;
  // 动画播放期间不接受点击 —— 走子还没落位，点哪儿都不算数（与原版一致）。
  if (anim) return;
  // 观战：两台 AI 自己在下，人的点击一律不收（否则会替某一方走子，
  // 观战就变成了"开天眼作弊"，学不到东西）。要给反馈 —— 一声不吭最伤人。
  if (watchOn) {
    status("观战中：两台 AI 自己在下（☰ 可暂停 / 走一手 / 看棋谱）", "info");
    return;
  }
  // 人机对战时，电脑思考期间不接受人的落子
  if (vsAi && mode === "lay" && (lay.turn === AI_SIDE || lay.over)) {
    status("等电脑落子", "info");
    return;
  }
  if (vsAi && mode === "flip" && (flip.turn === 1 || flip.over)) {
    status("等电脑翻子", "info");
    return;
  }
  // 联机：不是我的回合就不接受落子 —— 否则两边各走各的，局面立刻跑飞。
  if (netActive && !netMyTurn()) {
    status(`等 ${netPeerName()} 落子`, "info");
    return;
  }
  const cell = hitTest(view, px, py);
  if (cell === null) return;

  if (mode === "edit") {
    if (!territoryOf(editor.side).includes(cell)) {
      status("只能在本方阵地内布阵", "bad");
      return;
    }
    if (editor.painter !== null) {
      const nLog = editor.logs.length;
      editor.place(cell, editor.painter);
      if (editor.logs.length > nLog) {
        // 布阵位置不合法（原版 ZhaError / LeiError / QiError）
        status(editor.logs[editor.logs.length - 1], "bad");
        play(A, "dead");
      } else {
        play(A, "select");
      }
    } else if (editor.cells[cell] !== PieceType.Empty) {
      painterCell = painterCell === cell ? -1 : cell;
      status(`${pieceName(editor.cells[cell])} 已选中，点手牌可替换或点空格移动`);
      draw();
      return;
    } else {
      status("先从右侧手牌选一枚棋子", "bad");
      return;
    }
    rebuildEditPanel();
    return;
  }

  if (mode === "flip") {
    const prevLast = flip.lastMove;
    const pre = clonePosition(flip.pos);
    const before = flip.pos.revealed.slice();
    const nMsg = flip.messages.length;
    const accepted = flip.click(cell);
    if (flip.pos.revealed.some((v, i) => v !== before[i])) play(A, "flip");
    else if (flip.messages.length > nMsg) {
      const m = flip.messages.at(-1)!;
      play(A, m.tone === "good" ? "eat" : m.tone === "bad" ? "dead" : "move");
    }
    afterTurn(
      flip.messages,
      takeMoveSpec(pre, prevLast, flip.lastMove),
      // 只"点了颗自己的子"（没翻牌、没新日志）→ 别清 AI 提示、别倒退 toast。
      !flip.pos.revealed.some((v, i) => v !== before[i]) && flip.messages.length === nMsg,
    );
    netMirrorClick(cell, accepted);
    return;
  }

  const prevLast = lay.lastMove;
  const pre = clonePosition(lay.pos);
  const nMsg = lay.messages.length;
  const accepted = lay.click(cell);
  if (accepted) {
    const m = lay.messages.at(-1);
    if (lay.messages.length > nMsg && m) {
      play(A, m.tone === "good" ? "eat" : m.tone === "bad" ? "dead" : "select");
    } else {
      play(A, "select");
    }
  }
  const spec = takeMoveSpec(pre, prevLast, lay.lastMove);
  afterTurn(lay.messages, spec, !spec && lay.messages.length === nMsg);
  netMirrorClick(cell, accepted);
}

function onClick(e: MouseEvent): void {
  const r = canvas.getBoundingClientRect();
  clickAt(e.clientX - r.left, e.clientY - r.top);
}

/**
 * 一次棋盘点击之后的统一收尾（也用于重开局 / 悔棋 / 改设置这类"界面要刷新"的时刻）。
 *
 * `silent` = **局面没变、也没有新日志** —— 典型是"只是点了颗棋子选中/取消选中"
 * （`LayGame.click()` 对选中也返回 `true`，光看返回值分不出来）。
 *
 * ⚠️ 这种情况**必须**跳过 `clearAid()` 和 `status(...)`：
 *   · 清掉 AI 援助 → 玩家点了「AI 援助」、再点它建议的那颗子，蓝框当场消失，
 *     等于刚给的提示自己撤回了（`tools/_audit/_flow18.json` 抓到的就是这个）；
 *   · 重发 `status(最后一条日志)` → toast 会**倒退**回上一局的旧消息
 *     （实测点一下棋子，"AI 建议：…" 就变回"新对局开始，红方先行"）。
 * 局面真的变了（走子 / 重开 / 悔棋）时仍按老规矩清提示、刷 toast。
 */
function afterTurn(
  msgs: readonly GameMessage[],
  spec?: MoveSpec | null,
  silent = false,
): void {
  if (!silent) {
    // 局面一变，"上一次 AI 建议"就过期了 —— 继续挂着会误导（尤其走完还亮着）。
    clearAid();
    const last = msgs.at(-1);
    status(last?.text ?? "就绪", last?.tone ?? "info");
  }
  const box = $("#sidebar");
  const old = box.querySelector(".log-list");
  if (old) old.replaceWith(logRows(msgs));
  updateTurnLabel();
  // 真的走了一步、且开着动画 → 先放动画，落位后再排电脑（原版正是这个次序）。
  // ⚠️ 自检（probe / ai / flipai）里必须绕过，否则自检的同步循环会被 rAF 切成异步。
  if (spec && animEnabled && !selfCheck) {
    beginMoveAnim(spec);
    return;
  }
  // 走到这里的都是"非走子"的界面刷新（重开局 / 悔棋 / 改设置）——
  // 顺手清掉可能还挂着的动画，免得它继续往一个已经不存在的局面上飞。
  cancelAnim();
  draw();
  scheduleAi();
}

function updateTurnLabel(): void {
  const el = $("#turnBanner");
  if (mode === "rules") {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (mode === "edit") {
    el.textContent = `布阵 · ${sideName(editor.side)}`;
    el.dataset.side = String(editor.side);
    return;
  }
  if (mode === "flip") {
    if (flip.isDraw) {
      el.textContent = "和棋";
      el.dataset.side = "0";
      return;
    }
    if (flip.winner !== null) {
      const w = flip.sides[flip.winner];
      el.textContent = `${sideName(w)}胜`;
      el.dataset.side = String(w);
      return;
    }
    if (!flip.revealedColors) {
      el.textContent = "翻棋定色中";
      el.dataset.side = "0";
      return;
    }
    const side = flip.sides[flip.turn];
    if (watchOn) {
      const seatNow = flip.turn;
      el.textContent = watchPaused
        ? `观战暂停 · 轮到${sideName(side)}`
        : `${sideName(side)} AI（${agentLabel(seatNow)}）行动`;
      el.dataset.side = String(side);
      return;
    }
    const who = netActive
      ? flip.turn === netSeat
        ? "你 "
        : `${netPeerName()} `
      : vsAi
        ? flip.turn === 1
          ? "电脑 "
          : "你 "
        : "";
    el.textContent = `${who}${sideName(side)}行动`;
    el.dataset.side = String(side);
    return;
  }
  if (lay.isDraw) {
    el.textContent = "和棋";
    el.dataset.side = "0";
  } else if (lay.winner !== null) {
    el.textContent = `${sideName(lay.winner)}胜`;
    el.dataset.side = String(lay.winner);
  } else {
    if (watchOn) {
      const seatNow: 0 | 1 = lay.turn === Side.Red ? 0 : 1;
      el.textContent = watchPaused
        ? `观战暂停 · 轮到${sideName(lay.turn)}`
        : `${sideName(lay.turn)} AI（${agentLabel(seatNow)}）行动`;
      el.dataset.side = String(lay.turn);
      return;
    }
    const who = netActive
      ? netMyTurn()
        ? "你 "
        : `${netPeerName()} `
      : vsAi
        ? lay.turn === AI_SIDE
          ? "电脑 "
          : "你 "
        : "";
    el.textContent = `${who}${sideName(lay.turn)}行动`;
    el.dataset.side = String(lay.turn);
  }
}

// ── 侧栏 ────────────────────────────────────────────────────
function panel(title: string, body: HTMLElement): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "panel";
  const h = document.createElement("div");
  h.className = "panel-title";
  h.textContent = title;
  wrap.appendChild(h);
  wrap.appendChild(body);
  return wrap;
}

/**
 * 侧栏内容集散地。**离屏节点** —— 真正显示它的地方是对话框主体，
 * 由 `panelsInto()` 把子节点搬过去。这样原来的面板构件一行都不用改。
 */
function buildSidebar(): void {
  const box = $("#sidebar");
  box.innerHTML = "";
  if (mode === "rules") {
    box.appendChild(rulesPanel());
    return;
  }
  if (mode === "edit") {
    box.appendChild(editPanel());
    syncEditChrome();
    return;
  }
  box.appendChild(panel("行棋记录", logRows(mode === "flip" ? flip.messages : lay.messages)));
  box.appendChild(aiPanel());
  box.appendChild(settingsPanel());
}

// ── 原版页面外壳：浮动图标 + 对话框 ─────────────────────────

/**
 * 重新打开当前对话框 —— 开关类操作就地生效，不用关掉再点开。
 * `openDialog` 把「重建函数」记在 `reopen` 里，这里直接调回去。
 */
let reopen: (() => void) | null = null;
function refreshDialog(): void {
  reopen?.();
}

function openDialog(
  o: Parameters<typeof showDialog>[0] & { designW?: number; designH?: number },
  again: () => void,
): void {
  reopen = again;
  openDlg = { dw: o.designW ?? 675, dh: o.designH ?? 707 };
  showDialog(o);
  applyDialogSkins();
}

/** 对话框里的按钮也要吃原版皮肤（`applySkin` 会按切片算高度）。 */
function applyDialogSkins(): void {
  for (const el of document.querySelectorAll<HTMLElement>("#modalHost .ui-btn")) {
    // 行内按钮与确定/取消的**高宽由原版 XML 给死**（`Button rect` ⇒ 300×90 设计 px）。
    // 不让 `applySkin` 用 `btn.png` 的上下切片（44+45）重算高度，否则 90 → 112px
    // 的固定值会把 XML 布局顶歪；`fitsize=1` 只补边框宽度。
    if (el.closest(".dlg-row, .dlg-foot")) el.dataset.fitsize = "1";
    applySkin(el, SKIN_BTN);
  }
  // 纯图标弹窗（☰ 菜单）用原版 `popup.cfg`：那是纯色 + 圆角，
  // style.css 里的 `.dlg--plain` 已经等价画好，**不要**再套 `dlg.png` 的 9 宫格。
  const dlg = document.querySelector<HTMLElement>("#modalHost .dlg");
  if (dlg && !dlg.classList.contains("dlg--plain")) {
    // ⚠️ 尺寸由 `layoutDialog` 按设计稿（默认 675×707）给死，必须让 `applySkin`
    // 别按切片重算高度 —— `dlg.cfg` 的切片是 [83,8,8,8]，`applySkin` 会把高度
    // 压成 (83+8)×scale ≈ 116px，整张对话框只剩一条白带、内容全被
    // `.dlg` 的 `overflow:hidden` 裁掉（实测对话框 884px 设计高被压到 128px）。
    // `fitsize=1` = 只补边框宽度、不动高度，顺带让 `refreshSkins()` 跳过它。
    dlg.dataset.fitsize = "1";
    applySkin(dlg, SKIN_DLG, view.scale);
  }
}

function doUndo(): void {
  // 观战：悔棋 = 替某一方撤回一步，等于**改了 AI 下的棋**（学到的东西就不真了）。
  // 按钮会被换成"暂停/继续"（`syncFloatIcons`），但保险丝还是要留——
  // 顶栏、☰、浮动图标三条路径都可能摸到它。
  if (watchOn) {
    status("观战不能悔棋（那等于替 AI 改棋）—— 想要的话用「暂停 / 走一手」", "info");
    return;
  }
  // 联机：悔棋走网络广播（对双方同时生效，没法只悔自己那一步）。
  if (netActive) {
    if (!net) {
      status("联机已断开", "bad");
      return;
    }
    netSend({ t: "undo" });
    netApplyUndo(false);
    return;
  }
  if (mode === "lay") {
    if (lay.undo()) {
      play(A, "click1");
      afterTurn(lay.messages);
    } else status("没有可悔的棋", "bad");
  } else if (mode === "flip") {
    // ★ 原版翻棋**支持悔棋**（实机验证，见 `session.ts` 的 `FlipGame.history` 注释）。
    //   旧版这里写死 `status("翻棋不支持悔棋")` 是没核对原版的臆断，已删。
    if (flip.undo()) {
      play(A, "click1");
      afterTurn(flip.messages);
    } else status("没有可悔的棋", "bad");
  } else if (mode === "edit") {
    status("布阵：直接点棋盘上的子可移除", "bad");
  }
}

/**
 * ☰ 对局菜单 —— 逐条照原版 `be78647b…xml`：Dialog 675×428，4 列 × 2 行的 IconBtn。
 *
 * 原版八项（名称 / 素材）：
 *   重新开始 new.png ｜ 悔棋 regret.png ｜ 提和 draw.png  ｜ 认输 resign.png
 *   聊天   chat.png  ｜ 系统设置 config.png ｜ 战况统计 stat.png ｜ 规则说明 rule.png
 *
 * ⚠️ 素材名的对应关系**只能确认 `regret` = `icon_regret.png`**（datax/6368ad93… 与它逐像素相同）。
 * 其余几个（new/draw/resign/stat/rule）在 582 个仅哈希命名的资源里，
 * 无法从界面 XML 反查到哈希，故暂用视觉相近的已命名素材顶上 —— 这是本页唯一
 * 「结构 1:1、素材靠推断」的地方，见 SPEC §9.7。
 */
/**
 * ☰ 菜单的 8 项 —— **逐条对齐实拍 `s08.png` + XML `cd7d9e3a…xml`**（不是猜的）：
 *
 *   行1 重新开始(金星) 悔棋(绿弯箭头) 电脑变着(蓝箭头) 规则说明(文档纸)
 *   行2 功能设置(扳手) 战况统计(饼图)  软件信息(蓝 i)   退出程序(红叉)
 *
 * 原版有两份菜单 XML：`cd7d9e3a`（单机，就是 s08 这张实拍）与 `be78647b`
 * （联网，把「电脑变着/软件信息/退出程序」换成「提和/认输/聊天」）。
 * 本复刻对齐**单机**，所以用 `cd7d9e3a` 的顺序 —— 这一点靠 s08 的图标逐枚核对过。
 */
const MENU_ICONS: readonly string[] = [
  "icon_new.png", // 重新开始（金星）
  "icon_undo.png", // 悔棋（绿色弯箭头）
  "icon_redo.png", // 电脑变着（蓝色箭头）
  "icon_rule.png", // 规则说明（文档纸）
  "icon_set.png", // 功能设置（扳手）
  "icon_stat.png", // 战况统计（饼图）
  "icon_about.png", // 软件信息（蓝 i）
  "icon_exit.png", // 退出程序（红叉）
];

/** 「电脑变着」—— 原版让电脑把这一步重走；复刻里就是让 AI 就当前局面走一手。 */
function runAiOnce(): void {
  if (mode === "flip") return status("翻棋模式不支持电脑变着", "info");
  if (mode !== "lay") return status("请先完成布阵", "info");
  if (lay.over) return status("对局已结束", "info");
  if (!vsAi) return status("本地双人：由蓝方自己走子", "info");
  if (lay.turn !== AI_SIDE) return status("现在轮到你走，电脑不用变着", "info");
  aiTurn();
}

/** 「软件信息」—— 复刻版自己的一页说明（原版这里是 about）。 */
function openAboutDialog(): void {
  const box = document.createElement("div");
  box.className = "rules";
  box.textContent =
    "军棋 · 网页复刻版\n\n" +
    "规则、AI 与素材全部来自 com.cnvcs.junqi v1.58 的逆向结果：" +
    "棋盘/棋子/面板/音效为原版位图直接 blit，规则与估值逐条对齐 native，" +
    "布局与翻棋两种玩法的默认开关也按原版数据表设定。\n\n" +
    "本页仅用于逆向研究成果的验证与展示。";
  openDialog(
    {
      icon: "icon_about.png",
      title: "软件信息",
      body: box,
      designW: 675,
      designH: 707,
      okText: "知道了",
      cancelText: "关闭",
      onOk: closeDialog,
      onCancel: closeDialog,
    },
    openAboutDialog,
  );
}

/**
 * 「返回主窗口」—— 回到原版那个启动主菜单（`s03.png`）。
 *
 * 原版菜单第 8 项是「退出程序」（红叉）。网页里没有进程可退，
 * 而**用户真正要的是"回到主窗口"**（原话：「返回主窗口也没反应」）——
 * 所以这一项改成实干：收起对话框、停掉 AI、`setMode("home")`。
 */
function backToHome(): void {
  setMode("home");
  status("已返回主窗口", "good");
}

/**
 * 主菜单右下角那间小房子（`home_house.png`，原版 = 退出）。
 * 网页上没有进程可退 —— 在主菜单上点它给一句可见的回应，
 * 不再是"只有一声咔哒"（那正是"点了没反应"的观感）。
 */
function homeHouseTap(): void {
  if (mode === "home") status("已经在主窗口了", "info");
  else backToHome();
}

function openMenu(): void {
  // 观战有自己的一整套 ☰（对局里的「悔棋 / 电脑变着」在这里会破坏观战本身）。
  if (watchOn) {
    openWatchMenu();
    return;
  }
  play(A, "click0");
  const close = (run: () => void) => () => {
    closeDialog();
    run();
  };
  // 顺序 = 原版单机菜单 `cd7d9e3a`，与实拍 s08.png 的 8 格一一对应。
  //
  // ★「重新开始」在原版是**弹「新局」对话框**（先后手/电脑水平/玩法/明暗棋），
  //   不是无提示重开 —— 实拍 `g04_restart.png` 在绿色翻棋棋盘上叠着这个对话框。
  //   这也解释了为什么「人机对战」直接开局：改玩法的入口就在这儿。
  const items: GridItem[] = [
    { icon: MENU_ICONS[0], label: "重新开始", onClick: close(openNewGame) },
    { icon: MENU_ICONS[1], label: "悔棋", onClick: close(doUndo) },
    { icon: MENU_ICONS[2], label: "电脑变着", onClick: close(runAiOnce) },
    { icon: MENU_ICONS[3], label: "规则说明", onClick: close(openRulesDialog) },
    { icon: MENU_ICONS[4], label: "功能设置", onClick: close(openSettings) },
    { icon: MENU_ICONS[5], label: "战况统计", onClick: close(openLogDialog) },
    { icon: MENU_ICONS[6], label: "软件信息", onClick: close(openAboutDialog) },
    // 第 8 格：原版是「退出程序」（红叉 = `icon_exit.png`）。网页没有进程可退，
    // 这里让它**真的返回主窗口** —— 用户报的"返回主窗口没反应"就是这一项。
    { icon: MENU_ICONS[7], label: "返回主窗口", onClick: close(backToHome) },
  ];
  // ── 「AI 援助」（复刻版自加）────────────────────────────────
  //    布局对战与人机翻棋都补第九格（布阵模式除外 —— 那里第九格已经是「随机布阵」）。
  //
  //    ★ 为什么必须挂在这里：它原先只存在于侧栏 `aiPanel()`，而 `#sidebar`
  //      是 `.offscreen`（`left:-10000px; pointer-events:none`）—— 真人**根本
  //      点不到**，正是用户抱怨的那一类"按钮点了没反应"。挂到 ☰ 上才算真可用。
  //
  //    ★ 为什么翻棋也要有（2026-09-14 补）：主菜单的「人机对战」进的**就是翻棋
  //      ·暗棋**（原版行为，见 `btnOne`）。原先这里只放 `mode==="lay"`，于是用户
  //      点了「人机对战」再翻遍菜单都找不到 AI 援助 —— 功能明明做了却够不着。
  //      翻棋的"一步"包含"翻开一张暗子"，已在 `aiaid.ts` 里作为候选接上。
  //
  //    闸门让另外两种场景保持原版模样：单机双人（vsAi=false，包括两人对战里
  //    临时开的人机……不，那个也算 vsAi）与联机（netActive）时 ☰ 仍是 8 格
  //    ⇒ `?probe=1` 的「8 格同序」保真哨兵照旧成立。
  if (mode !== "edit" && vsAi && !netActive) {
    items.push({
      icon: "icon_info.png",
      // ★ 正在问模型时改写成「取消 AI 援助」（2026-09-14 玩家实报后补）。
      //   原先不管在不在等，它都写「AI 援助」—— 于是玩家等待中再点一次，
      //   得到的反馈是"已取消上一次 AI 援助"，一头雾水："我明明是想让它问啊"。
      //   让标签如实反映"这一下点下去会发生什么"，是这一格唯一的职责。
      label: aidBusy ? "取消 AI 援助" : "AI 援助",
      onClick: close(() => void runAiAid()),
    });
  }
  // 联机对局：菜单换成原版**联网版** XML `be78647b` 的三项
  // （它把「电脑变着 / 软件信息 / 退出程序」换成了「提和 / 认输 / 聊天」）。
  if (netActive) {
    items[2] = { icon: "icon_draw.png", label: "提和", onClick: close(netOfferDraw) };
    items[6] = { icon: "icon_resign.png", label: "认输", onClick: close(netResign) };
    items.push({ icon: "icon_chat.png", label: "聊天", onClick: close(netChat) });
  }
  // 布阵模式补一格「随机布阵」：它是复刻版自加的能力，在原版工具栏里没有对应
  // 图标（工具栏 4 格 = 清空/载入/保存/完成）；从前它只存在于离屏的
  // `.edit-panel` 里，真人**点不到**。挂到菜单上才算真的可用。
  if (mode === "edit") {
    items.push({
      icon: "icon_clear.png",
      label: "随机布阵",
      onClick: close(() => {
        editor.randomize();
        rebuildEditPanel();
        status("已随机布阵", "good");
      }),
    });
  }
  const grid = iconGrid(items);
  openDialog(
    {
      // 原版菜单**没有标题行**：675×428 的面板里直接铺 8 个 IconBtn。
      icon: "icon_menu.png",
      title: "菜单",
      header: false,
      body: grid,
      foot: false,
      designW: 675,
      designH: 428,
    },
    openMenu,
  );
}

/**
 * 新局对话框 —— 直接照原版 `38dbe67d…xml` 的字段与顺序：
 * 先后手 / 电脑水平 / 玩法 / 明暗棋，675×707。
 */
function openNewGame(): void {
  play(A, "click0");
  const build = (): void => {
    const rows = [
      {
        label: "先后手:",
        value: vsAi ? (layCfg.firstMove === Side.Red ? "我先手" : "电脑先手") : layCfg.firstMove === Side.Red ? "红先手" : "蓝先手",
        onCycle: () => {
          layCfg.firstMove = layCfg.firstMove === Side.Red ? Side.Blue : Side.Red;
          refreshDialog();
        },
      },
      {
        label: "电脑水平:",
        value: aiLevel(aiLevelId).name,
        onCycle: () => {
          const i = AI_LEVELS.findIndex((l) => l.id === aiLevelId);
          aiLevelId = AI_LEVELS[(i + 1) % AI_LEVELS.length].id;
          refreshDialog();
        },
      },
      {
        label: "玩法:",
        value: mode === "flip" ? "翻棋" : "布局",
        onCycle: () => {
          setMode(mode === "flip" ? "lay" : "flip");
          refreshDialog();
        },
      },
      {
        label: "明暗棋:",
        value: layCfg.revealAll ? "明棋" : "暗棋",
        onCycle: () => {
          layCfg.revealAll = !layCfg.revealAll;
          refreshDialog();
        },
      },
    ];
    openDialog(
      {
        icon: "icon_newgame.png",
        title: "新局",
        rows,
        designW: 675,
        designH: 707,
        onOk: () => {
          vsAi ||= false;
          lay = newLay();
          flip = new FlipGame();
          if (mode === "edit") {
            // 布阵里按「重新开始」也要回到默认开局布阵，而不是留着上一盘的残局。
            editor.clear();
            painterCell = -1;
            rebuildEditPanel();
            afterTurn(lay.messages);
          } else {
            showStartBanner();
            afterTurn(mode === "flip" ? flip.messages : lay.messages);
          }
        },
      },
      build,
    );
  };
  build();
}

// ═════════════════════════════════════════════════════════════
// 通用：localStorage 小工具
// ═════════════════════════════════════════════════════════════

function lsGet(k: string, d = ""): string {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d; // 无痕模式禁 localStorage，退化成"不记住"
  }
}
function lsSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* 同上 */
  }
}

// ═════════════════════════════════════════════════════════════
// AI 援助 —— 不会走的时候，让大模型在**合法着法**里挑一步
// ═════════════════════════════════════════════════════════════

const AID_LS = {
  base: "junqi.aid.base",
  key: "junqi.aid.key",
  model: "junqi.aid.model",
  timeout: "junqi.aid.timeout",
  proxy: "junqi.aid.proxy",
  relay: "junqi.aid.relay",
} as const;

/**
 * 同源中转在不在（页面启动时探一次）。
 *
 * 在 → 默认走中转：浏览器直连的两个死穴（跨域预检、**走不了本机代理**）一起消失。
 * 不在 → 直连（`npm run build` 后挂在纯静态服务器上的情形）。
 * 玩家仍可在设置里手动覆盖，见 `AID_LS.relay`。
 */
let aidRelayOn = false;

/** 当前生效的超时（毫秒）—— 设置里没填就用默认。 */
function aidTimeoutMs(): number {
  const v = Number(lsGet(AID_LS.timeout, "").trim());
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_AID_TIMEOUT_MS;
}

function aidCfg(): AidConfig {
  const relayLs = lsGet(AID_LS.relay, "").trim();
  return {
    baseUrl: lsGet(AID_LS.base),
    apiKey: lsGet(AID_LS.key),
    model: lsGet(AID_LS.model),
    timeoutMs: aidTimeoutMs(),
    proxy: lsGet(AID_LS.proxy).trim(),
    // `auto`（默认）= 按探测结果；`on` / `off` = 玩家手动钉死。
    relay: relayLs === "on" ? true : relayLs === "off" ? false : aidRelayOn,
  };
}
function aidConfigured(): boolean {
  const c = aidCfg();
  return !!aidEndpoint(c.baseUrl) && !!c.apiKey.trim() && !!c.model.trim();
}

/**
 * 当前的建议着法（两端各画一个蓝框 + 终点白点）。任何一步棋之后自动清掉。
 *
 * `reveal=true` 时 `from === to` —— 翻棋里"翻开一张暗子"，两端框重合，
 * 正好表示"点这张"，不需要额外画法。
 */
let aidMove: { from: number; to: number; reveal: boolean } | null = null;
let aidBusy = false;
/** 上一次请求的取消句柄（再点一次 = 取消）。 */
let aidAbort: AbortController | null = null;
/**
 * 请求代次：每次发起 / 取消都 +1，回调只在"自己还是最新一代"时才动界面。
 *
 * 为什么要它：取消时我们**立刻**复位 `aidBusy`（不能让"对面不响应"把界面永久锁死），
 * 但被取消的那个 promise 可能过一会儿才 reject —— 那时它若还去 `status(...)`，
 * 就会把玩家刚看到的新提示覆盖掉（典型："已取消"被打回"连不上模型接口"）。
 */
let aidSeq = 0;
/** 设置里「测试连接」的代次：连点两次时只有最后一次的结论能落到提示上。 */
let aidTestSeq = 0;
/** "正在问模型…（已等 Ns）"的刷新计时器；0 = 没在跑。 */
let aidTick = 0;
let aidT0 = 0;

function clearAid(): void {
  aidMove = null;
}

/** 停掉等待中的进度刷新。 */
function aidStopTick(): void {
  if (aidTick) {
    window.clearInterval(aidTick);
    aidTick = 0;
  }
}

/**
 * 无条件放下在途的 AI 援助（作废回调 + 尽力断开连接 + 复位状态）。
 *
 * 用在"离开当前对局"的地方（`setMode`）。不这么做的话，那个每 500ms 刷新的
 * "正在问模型…"会**跟着玩家飘到下一个界面**（回主窗口、开新局都还在飘）——
 * 玩家会以为新界面在问模型。`runAiAid` 的"再点一次 = 取消"也走这里，
 * 只是额外补一句提示。
 */
function cancelAiAid(): void {
  if (!aidBusy && !aidTick) return;
  aidSeq++;
  aidAbort?.abort();
  aidAbort = null;
  aidBusy = false;
  aidStopTick();
}

/**
 * 「AI 援助」：把当前局面 + **规则引擎算好的合法着法**交给模型挑一步。
 *
 * 关键设计（见 `game/aiaid.ts` 文件头）：合法性由本地规则层兜底，
 * 模型只做"在候选里挑一个并说理由"，所以它**不可能**给出非法着法。
 */
async function runAiAid(): Promise<void> {
  if (aidBusy) {
    // 取消 = **立刻**回到可用状态。
    // ⚠️ 不能"发了 abort 就完事"：万一底层 promise 因为对面的问题永不 settle
    //    （真发生过 —— `aiaid.ts` 里超时/取消曾覆盖不到"读 body"阶段），
    //    `aidBusy` 会永远为真，玩家之后每次点都只看到"已取消上一次"、
    //    再也发不出新请求。所以这里主动作废在途回调并复位，abort 只是尽力释放连接。
    cancelAiAid();
    status("已取消 AI 援助（可以再点一次重新问）", "info");
    return;
  }
  if (mode !== "lay" && mode !== "edit" && mode !== "flip") {
    status("AI 援助：请先进入对局或布阵", "bad");
    return;
  }
  if (mode === "lay" && lay.over) {
    status("对局已结束", "bad");
    return;
  }
  if (mode === "flip" && flip.over) {
    status("对局已结束", "bad");
    return;
  }
  if (!aidConfigured()) {
    status("AI 援助未配置：在「功能设置」里填接口地址 / API Key / 模型名", "bad");
    openSettings();
    return;
  }

  // 谁来问：布阵里固定问红方；布局对局问当前行动方；翻棋问当前玩家（定色前是 None，
  // 那时只能翻子 —— `describeBoard` 会如实说"轮到先手"，不会瞎认颜色）。
  const side =
    mode === "edit" ? editor.side : mode === "flip" ? flip.sides[flip.turn] : lay.turn;
  const pos = mode === "edit" ? editorPosition() : mode === "flip" ? flip.pos : lay.pos;
  const revealAll = mode === "edit" || mode === "flip" ? false : lay.revealAll;
  // 翻棋：盖上的一律可作为"翻开"候选。定色前 `sides` 还是默认的 [红,蓝]，
  // 但那时 `flip.turn` 恒为 0 且唯一动作就是翻子，所以 None 与红等价。
  const reveals = mode === "flip" ? flipRevealCells(pos) : undefined;
  const mover = mode === "flip" && !flip.revealedColors ? Side.None : side;
  // 翻棋有自己那份 opts（`hidden:true, flipMode:true`），不能借用 lay 的 ——
  // 用错会让"地雷/军旗能不能吃"这类判定的依据整个偏掉。
  const opts = mode === "flip" ? flip.opts : lay.opts;

  aidBusy = true;
  const myAbort = new AbortController();
  aidAbort = myAbort;
  const mySeq = ++aidSeq;
  aidT0 = performance.now();
  aidStopTick();
  // 进度提示：`status()` 的 toast 有 2.6s 自动隐藏，一次性的"正在问模型…"很快就没了，
  // 玩家根本不知道它还在跑（"我怎么知道它有没有在问"就是这么来的）。
  // 每 500ms 重发同一条即可保持常驻，顺带把"已等多久 / 最多等多久"变成可见信息。
  const paintWait = (): void => {
    const sec = Math.floor((performance.now() - aidT0) / 1000);
    status(
      `AI 援助：正在问模型…（已等 ${sec}s，最多 ${Math.round(aidTimeoutMs() / 1000)}s，再点一次可取消）`,
      "info",
    );
  };
  paintWait();
  aidTick = window.setInterval(() => {
    if (mySeq === aidSeq) paintWait();
  }, 500);
  try {
    const s = await aiAidSuggest(
      aidCfg(),
      pos,
      mover,
      opts,
      revealAll,
      myAbort.signal,
      reveals,
    );
    // 已被取消 / 被新请求顶掉：这条结果作废，别去动界面。
    if (mySeq !== aidSeq) return;
    aidMove = { from: s.from, to: s.to, reveal: s.reveal };
    // 翻子的 from/to 同格，写成"格16 → 格16"会让人以为点错了。翻子**只要点一下**，
    // 走子要点两下（先选子再点落点）—— 这句提示是玩家照做时唯一的口令。
    const what = s.reveal
      ? `翻开 格${s.to} 这张暗子（点一下即可）`
      : `${pieceName(pos.type[s.from] as PieceType)} 格${s.from} → 格${s.to}`;
    // 中转在"直连不通"时替我们借了本机代理 ⇒ **必须明说**。
    // 悄悄换路线会让玩家以为是自己填的「上游代理」在生效，下次自己排障就被带偏。
    const via =
      s.viaProxy && s.viaProxy !== (aidCfg().proxy ?? "").trim()
        ? `（直连不通，已自动走本机代理 ${s.viaProxy}）`
        : "";
    status(`AI 建议：${what}${s.why ? `（${s.why}）` : ""}${via}`, "good");
    draw();
  } catch (e) {
    if (mySeq !== aidSeq) return;
    status(`AI 援助失败：${e instanceof Error ? e.message : String(e)}`, "bad");
  } finally {
    // 只有"还是最新一代"才收尾 —— 被取消的那条不许去清当前请求的状态。
    if (mySeq === aidSeq) {
      aidBusy = false;
      aidAbort = null;
      aidStopTick();
    }
  }
}

/**
 * 「AI 援助」的接口配置 —— **复刻版自加**（原版没有这东西）。
 *
 * 只认 OpenAI 兼容的 `/chat/completions`：base 填 `https://api.openai.com/v1`
 * 或 `https://api.deepseek.com` 之类都行，`aidEndpoint()` 负责把后缀补齐。
 * Key 只落在本机 `localStorage`，不发往任何第三方。
 *
 * ⚠️ 这里要多写两格（超时 / 上游代理），是因为踩过一次**玩家实报**：
 *    「点了 AI 援助一直转，然后超时」。根因不是代码 bug，而是
 *    **浏览器只认 Windows 系统代理** —— 玩家填的接口地址（如 `api.openai.com`）
 *    本身要靠本机代理才通，浏览器却直连，于是干等到超时。
 *    对应用户可见的三件事：① 默认走同源中转（Node 侧出网，能带 `proxy`）；
 *    ② 超时可调、默认 60s（推理型模型 30s 不够）；③ 有「测试连接」1 秒内给结论。
 */
function openAidSettings(): void {
  const build = (): void => {
    const c = aidCfg();
    const body = document.createElement("div");
    body.className = "net-form";
    const base = dlgField("接口地址", c.baseUrl, "https://api.deepseek.com");
    const key = dlgField("API Key", c.apiKey, "sk-…（只存本机）");
    const model = dlgField("模型名", c.model, "deepseek-chat");
    const timeout = dlgField(
      "超时（秒）",
      lsGet(AID_LS.timeout, ""),
      `默认 ${DEFAULT_AID_TIMEOUT_MS / 1000}；推理模型可填 120`,
    );
    const proxy = dlgField(
      "上游代理",
      c.proxy ?? "",
      "可留空；如 http://127.0.0.1:7897（仅中转时生效）",
    );
    body.append(base.row, key.row, model.row, timeout.row, proxy.row);

    const hint = document.createElement("div");
    hint.className = "hint-box";
    const relayLs = lsGet(AID_LS.relay, "").trim();
    const relayNow = c.relay;
    hint.dataset.tone = aidConfigured() ? "good" : "warn";
    // 标签只写"模式"，**当前是否真的在走中转**放在这里 —— 按钮宽度有限（半行 ≈ 5 字），
    // 「中转：自动（开）」这种写法会折行、和下面的键叠在一起。
    hint.textContent =
      (aidConfigured()
        ? `已就绪：${aidEndpoint(c.baseUrl)} · ${c.model}\n` +
          `出网方式：${relayNow ? "本地中转（vite 提供，绕开跨域与代理限制）" : "浏览器直连"}` +
          `（${relayLs === "" ? "自动探测" : "手动指定"}，当前中转=${aidRelayOn ? "开" : "关"}）\n` +
          `超时：${Math.round(aidTimeoutMs() / 1000)} 秒`
        : "任何兼容 OpenAI /chat/completions 的服务都行（OpenAI、DeepSeek、通义、本地 vLLM…）。\n" +
          "填好先点「测试连接」，1 秒内就能知道地址 / Key / 模型名有没有问题，" +
          "不用等对局里转一分钟才发现。\n" +
          "「接口地址」填域名即可（https://api.deepseek.com），后缀会自动补齐。") +
      // 推理型模型首字动辄二三十秒，很容易被误当成"超时/没反应"。这里直接点破，
      // 并给出替代 —— 军棋只是从候选里挑一步，普通对话模型绰绰有余。
      (looksLikeThinkingModel(c.model)
        ? "\n⚠️ 这个模型是「思考型」（deepseek-flash / reasoner 这类），首字实测 50 秒以上，" +
          "很容易被当成超时。军棋只是从候选里挑一步，用 deepseek-chat / qwen-plus 这类就够。\n" +
          "（复刻版已自动对已知思考型模型带上 thinking=disabled；若上游不认该字段，" +
          "设置面板会明确提示换模型。）"
        : "");
    hint.style.whiteSpace = "pre-line";
    body.appendChild(hint);

    // 两行、每行两键。**不要**把 4 个键塞一行：`.btn-row` 是 flex-wrap + min-width，
    // 长标签（「本地中转：自动（现为开）」）会把整行挤成好几行、文字互相叠，
    // 截图里一眼就能看出来（2026-09-14）。
    const rowA = document.createElement("div");
    rowA.className = "btn-row";
    const rowB = document.createElement("div");
    rowB.className = "btn-row";
    const mk = (text: string, fn: () => void, where: HTMLElement = rowA): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ui-btn wide";
      b.textContent = text;
      b.addEventListener("click", () => {
        play(A, "click0");
        fn();
      });
      where.appendChild(b);
      return b;
    };
    /** 只有"保存"会关对话框；测试/切开关都留在原地，方便连续调。 */
    mk("保存", () => {
      lsSet(AID_LS.base, base.input.value.trim());
      lsSet(AID_LS.key, key.input.value.trim());
      lsSet(AID_LS.model, model.input.value.trim());
      lsSet(AID_LS.timeout, timeout.input.value.trim());
      lsSet(AID_LS.proxy, proxy.input.value.trim());
      const ok = aidConfigured();
      status(ok ? "AI 援助已配置" : "已保存，但还差必填项", ok ? "good" : "bad");
      closeDialog();
      openSettings();
    });

    // 「测试连接」：用**当前输入框里的值**打一次最小请求。
    // 不保存也能测 —— 否则每改一个字段都要"保存→重开→再点"，调试体验很差。
    // `id` 是给脚本/截图定位用的（比 `nth-child` 稳，和侧栏的 `#btnAiAid` 一个路数）。
    const testBtn = mk("测试连接", () => {
      const relayNow2 = c.relay;
      const cfgNow: AidConfig = {
        baseUrl: base.input.value.trim(),
        apiKey: key.input.value.trim(),
        model: model.input.value.trim(),
        timeoutMs: Math.max(
          1000,
          (Number(timeout.input.value.trim()) || DEFAULT_AID_TIMEOUT_MS / 1000) * 1000,
        ),
        proxy: proxy.input.value.trim(),
        relay: relayNow2,
      };
      if (!aidEndpoint(cfgNow.baseUrl) || !cfgNow.apiKey || !cfgNow.model) {
        status("测试连接：地址 / API Key / 模型名先填全", "bad");
        return;
      }
      testBtn.disabled = true;
      testBtn.textContent = "测试中…";
      const seq = ++aidTestSeq;
      status("正在测试连接…", "info");
      void aiAidPing(cfgNow)
        .then((r) => {
          if (seq !== aidTestSeq) return;
          if (r.thinking) {
            // 连接是通的，但**这个模型拿来援助会很难用** —— 必须点破，
            // 否则"连接成功"会把玩家引向"网络没问题啊"的错误方向。
            status(
              `连接成功（${r.ms}ms），但 ${r.model} 是思考型模型：出结果很慢` +
                `（实测 50 秒以上），AI 援助容易撞超时。建议把模型名改成 deepseek-chat。`,
              "bad",
            );
            return;
          }
          status(
            `连接成功：${r.ms}ms · ${r.model}${r.note ? ` · 回「${r.note}」` : ""}` +
              // 中转在直连不通时替我们借了本机代理 —— 如实说，别让玩家以为是自己填的代理在生效。
              (r.viaProxy && r.viaProxy !== cfgNow.proxy
                ? ` · 直连不通，已自动走本机代理 ${r.viaProxy}`
                : ""),
            "good",
          );
        })
        .catch((e: unknown) => {
          if (seq !== aidTestSeq) return;
          status(`连接失败：${e instanceof Error ? e.message : String(e)}`, "bad");
        })
        .finally(() => {
          if (seq !== aidTestSeq) return;
          testBtn.disabled = false;
          testBtn.textContent = "测试连接";
        });
    });
    testBtn.id = "btnAidTest";

    // 中转开关：默认"自动"（页面启动时探测）。探测不到的场合（纯静态托管）
    // 玩家可以强制开 —— 那时通常会失败，但至少报错会明说"中转失败"而不是静默退回。
    mk(
      relayLs === "on" ? "中转·强制" : relayLs === "off" ? "中转·关闭" : "中转·自动",
      () => {
        const next = relayLs === "" ? "on" : relayLs === "on" ? "off" : "";
        lsSet(AID_LS.relay, next);
        status(
          `本地中转已设为「${next === "on" ? "强制开" : next === "off" ? "关" : "自动"}」`,
          "info",
        );
        closeDialog();
        openAidSettings();
      },
      rowB,
    ).id = "btnAidRelay";

    mk(
      "清空",
      () => {
        lsSet(AID_LS.base, "");
        lsSet(AID_LS.key, "");
        lsSet(AID_LS.model, "");
        lsSet(AID_LS.timeout, "");
        lsSet(AID_LS.proxy, "");
        lsSet(AID_LS.relay, "");
        status("已清空 AI 援助配置", "info");
        closeDialog();
        openSettings();
      },
      rowB,
    );
    // ── 「诊断出网」────────────────────────────────────────────
    // ★ 2026-09-15 玩家第二次实报「一直提示连接不上上游」之后加的。
    //   「连不上上游」这一句话底下压着**至少五种**病，治法全不一样：
    //     域名写错 / 端口不通 / 这个地址在当前网络下必须走代理 /
    //     **填的「上游代理」本身没开** / 其实通了、只是 Key 或模型名错。
    //   玩家从报错里分不出是哪一种，只能一遍遍瞎试 —— 我就替他试够了。
    //   这个按钮让 Node 侧（中转）逐段量 DNS → TCP → HTTPS → 代理，
    //   然后把**结论**直接写在下面那块说明里（不是只回个"失败"）。
    //   单独占一行：`.btn-row` 是 flex-wrap，三键挤一行会把长标签压叠。
    const rowC = document.createElement("div");
    rowC.className = "btn-row";
    const diagBtn = mk(
      "诊断出网",
      () => {
        const cfgNow: AidConfig = {
          baseUrl: base.input.value.trim(),
          apiKey: key.input.value.trim(),
          model: model.input.value.trim(),
          proxy: proxy.input.value.trim(),
          relay: c.relay,
        };
        if (!aidEndpoint(cfgNow.baseUrl)) {
          status("诊断出网：先填「接口地址」", "bad");
          return;
        }
        diagBtn.disabled = true;
        diagBtn.textContent = "诊断中…";
        const seq = ++aidTestSeq;
        status("正在逐段诊断出网链路（DNS → TCP → HTTPS → 代理）…", "info");
        void aiAidDiag(cfgNow)
          .then((r) => {
            if (seq !== aidTestSeq) return;
            const tick = (s: { ok: boolean }): string => (s.ok ? "✓" : "✗");
            const lives = r.localProxies.filter((p) => p.alive).map((p) => p.url);
            hint.dataset.tone = r.ok ? "good" : "warn";
            hint.textContent =
              `【诊断出网】${r.target}\n` +
              `${tick(r.dns)} 域名解析：${r.dns.detail}（${r.dns.ms}ms）\n` +
              `${tick(r.tcp)} 连接 ${r.host}:${r.port}：${r.tcp.detail}（${r.tcp.ms}ms）\n` +
              `${tick(r.http)} 请求 /：${r.http.detail}（${r.http.ms}ms）\n` +
              `· 设置里的「上游代理」：${r.proxyGiven ?? "（未填）"}` +
              (r.proxyGivenTcp ? ` — ${tick(r.proxyGivenTcp)} ${r.proxyGivenTcp.detail}` : "") +
              `\n· 本机探到的代理：${lives.length ? lives.join("、") : "没有活着的"}\n\n` +
              `→ ${r.verdict}`;
            hint.style.whiteSpace = "pre-line";
            status(
              r.ok ? "诊断完成：出网链路正常" : "诊断完成：结论写在下方说明里",
              r.ok ? "good" : "bad",
            );
          })
          .catch((e: unknown) => {
            if (seq !== aidTestSeq) return;
            hint.dataset.tone = "warn";
            hint.textContent = `【诊断出网】失败：${e instanceof Error ? e.message : String(e)}`;
            status("诊断出网失败（本地中转可能没起）", "bad");
          })
          .finally(() => {
            if (seq !== aidTestSeq) return;
            diagBtn.disabled = false;
            diagBtn.textContent = "诊断出网";
          });
      },
      rowC,
    );
    diagBtn.id = "btnAidDiag";

    body.append(rowA, rowB, rowC);

    openDialog(
      { icon: "icon_info.png", title: "AI 援助设置", body, foot: false, designW: 675, designH: 800 },
      build,
    );
  };
  build();
}

// ═════════════════════════════════════════════════════════════
// 两人网络联机
//
// 协议与"为什么不用同步盘面"见 `game/net.ts` 文件头；服务器在 `tools/netserver.mjs`。
// 这里只做三件事：① 连接/大厅界面 ② 把本地点击广播出去 ③ 把对面的消息落到棋盘上。
// ═════════════════════════════════════════════════════════════

const NET_LS = { url: "junqi.net.url", name: "junqi.net.name" } as const;
const NET_DEFAULT_URL = "ws://127.0.0.1:8787";

let net: NetClient | null = null;
/** 我的座位：0 = 房主（红方），1 = 加入者（蓝方）。 */
let netSeat: 0 | 1 = 0;
let netRoom = "";
let netNames: [string, string] = ["", ""];
let netOnline: [boolean, boolean] = [false, false];
/** 已收到 `setup`、对局进行中。 */
let netActive = false;
let netSetup: NetSetup | null = null;
/** 我这边那 25 格布局（`ready` 发给房主 / 房主自己用）。 */
let netMyLayout: number[] = [];
let netLobbyNote = "";
let netLobbyAgain: (() => void) | null = null;
/** 我已经提议过和棋。 */
let netDrawOffered = false;
let netStatusText = "未连接";
let netAppliedClicks = 0;

/**
 * 发一条联机消息。`net` 是模块级 `let`，跨函数收窄无效 —— 统一走这个口子，
 * 未连接时静默丢弃（界面上的"未连接"状态已经提示过了）。
 */
function netSend(m: NetMsg): boolean {
  const n = net;
  return n ? n.send(m) : false;
}

function netIsHost(): boolean {
  return netSeat === 0;
}function netMySide(): Side {
  return netSeat === 0 ? Side.Red : Side.Blue;
}
function netPeerName(): string {
  return netNames[netSeat === 0 ? 1 : 0].trim() || "对手";
}
function netPeerOnline(): boolean {
  return netOnline[netSeat === 0 ? 1 : 0];
}
/** 布阵/翻棋的"轮到我了么"。 */
function netMyTurn(): boolean {
  if (!netActive) return true;
  if (mode === "lay") return !lay.over && lay.turn === netMySide();
  if (mode === "flip") return !flip.over && flip.turn === netSeat;
  return true;
}

/** 随机一套本方布局（`.lay` 的 25 格；房主也会用它当红方布局）。 */
function netFreshLayout(): number[] {
  const e = new LayoutEditor(netMySide());
  e.randomize();
  return e.toLayout();
}

function netStatusLine(): string {
  if (!net) return "未连接";
  const rtt = net.rtt >= 0 ? ` · ${net.rtt}ms` : "";
  const s =
    net.status === "open" ? "已连接" : net.status === "connecting" ? "连接中…" : netStatusText;
  return `${s}${net.status === "open" ? rtt : ""}`;
}

// ── 连接 / 大厅 ────────────────────────────────────────────

/** 一行「标签 + 文本输入」。这是**复刻版自加**的界面（原版没有服务器/房间、
 *  也没有 AI 接口这些概念），所以这里用 DOM 文字即可，不必走 `paintText` 位图那套。 */
function dlgField(
  label: string,
  value: string,
  ph: string,
): { row: HTMLElement; input: HTMLInputElement } {
  const row = document.createElement("label");
  row.className = "net-field";
  const span = document.createElement("span");
  span.className = "net-field-label";
  span.textContent = label;
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.placeholder = ph;
  input.spellcheck = false;
  input.autocomplete = "off";
  row.append(span, input);
  return { row, input };
}

/** 首页「联网」→ 填服务器/房间/昵称，然后创建或加入。 */
function openNetDialog(): void {
  play(A, "click0");
  if (net && (net.status === "open" || net.status === "connecting")) {
    openNetLobby();
    return;
  }
  const build = (): void => {
    const body = document.createElement("div");
    body.className = "net-form";
    const url = dlgField("服务器", lsGet(NET_LS.url, NET_DEFAULT_URL), "ws://192.168.1.10:8787");
    const room = dlgField("房间号", randomRoom(), "4 位；两人填同一个");
    const name = dlgField("昵称", lsGet(NET_LS.name, "玩家"), "最多 12 字");
    body.append(url.row, room.row, name.row);

    const hint = document.createElement("div");
    hint.className = "hint-box";
    hint.dataset.tone = "warn";
    hint.textContent =
      netLobbyNote ||
      "先在一台机器上跑服务器：node tools/netserver.mjs（默认 8787）。另一人把「服务器」改成 ws://<房主IP>:8787，房间号填成一样，再点加入。";
    body.appendChild(hint);

    const extra = document.createElement("div");
    extra.className = "btn-row";
    const go = (create: boolean): void => {
      const u = url.input.value.trim();
      const n = name.input.value.trim() || "玩家";
      const r = room.input.value.trim().toUpperCase();
      if (!/^wss?:\/\//.test(u)) {
        status("服务器地址要以 ws:// 或 wss:// 开头", "bad");
        return;
      }
      lsSet(NET_LS.url, u);
      lsSet(NET_LS.name, n);
      netMyLayout = netFreshLayout();
      netOpen(u, r, n, create);
    };
    const mk = (text: string, fn: () => void): void => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ui-btn wide";
      b.textContent = text;
      b.addEventListener("click", () => {
        play(A, "click0");
        fn();
      });
      extra.appendChild(b);
    };
    mk("创建房间（执红）", () => go(true));
    mk("加入房间（执蓝）", () => go(false));
    body.appendChild(extra);
    openDialog(
      { icon: "icon_config.png", title: "联网对战", body, foot: false, designW: 675, designH: 707 },
      build,
    );
  };
  build();
}

function netOpen(url: string, room: string, name: string, create: boolean): void {
  net?.close();
  net = new NetClient({
    onMsg: netOnMsg,
    onStatus: (s, detail) => {
      if (s === "open") netStatusText = "已连接";
      else if (s === "connecting") netStatusText = "连接中…";
      else netStatusText = detail ?? "已断开";
      netLobbyAgain?.();
    },
  });
  netStatusText = "连接中…";
  // 创建房间 = 房间号留空让服务器分配（服务器永远把新房给 seat 0）；
  // 加入 = 必须带房间号。这里用一个小技巧：创建时把房间号清空，
  // 但用户填了也想建房时（比如想指定房号）就仍然带过去 —— 服务器会新建。
  net.connect(url, {
    room: create ? "" : room,
    name,
    token: netToken(),
  });
  netNames = [name, ""];
  netOnline = [true, false];
  netLobbyNote = "";
  openNetLobby();
}

function netLeave(reason = "已断开联机"): void {
  net?.close();
  net = null;
  netActive = false;
  netSetup = null;
  netLobbyAgain = null;
  netSeat = 0;
  netRoom = "";
  netNames = ["", ""];
  netOnline = [false, false];
  netDrawOffered = false;
  netStatusText = "未连接";
  netLobbyNote = reason;
}

/** 大厅：连上之后显示双方座位 / 玩法 / 布阵，房主点开始。 */
function openNetLobby(): void {
  if (!net) {
    openNetDialog();
    return;
  }
  const build = (): void => {
    netLobbyAgain = build;
    const body = document.createElement("div");
    body.className = "net-form";

    const st = document.createElement("div");
    st.className = "net-status";
    st.textContent = `${netStatusLine()}　房间 ${
      netRoom || "…"
    }`;
    body.appendChild(st);

    // 座位表：我 / 对手
    const seats = document.createElement("div");
    seats.className = "net-seats";
    const seatLine = (seat: 0 | 1): HTMLElement => {
      const d = document.createElement("div");
      d.className = "net-seat";
      const me = seat === netSeat;
      const side = seat === 0 ? Side.Red : Side.Blue;
      const on = seat === netSeat ? true : netOnline[seat];
      d.dataset.on = String(on);
      d.dataset.me = String(me);
      d.textContent = `${sideName(side)}　${netNames[seat] || "（空位）"}${
        me ? "（我）" : ""
      }　${on ? "在线" : "等待加入…"}`;
      return d;
    };
    seats.append(seatLine(0), seatLine(1));
    body.appendChild(seats);

    // 设置行（房主可改，加入者只读）
    const rows = document.createElement("div");
    rows.className = "net-rows";
    const setting = (label: string, value: string, fn: () => void): HTMLElement => {
      const row = document.createElement("div");
      row.className = "net-row";
      const l = document.createElement("span");
      l.className = "net-row-label";
      l.textContent = label;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ui-btn";
      b.textContent = value;
      b.addEventListener("click", () => {
        play(A, "click0");
        fn();
      });
      row.append(l, b);
      return row;
    };
    const hostOnly = (fn: () => void): void => {
      if (!netIsHost()) status("房间设置由房主决定", "bad");
      else fn();
      netLobbyAgain?.();
    };
    rows.appendChild(
      setting(
        "玩法:",
        netCfg.mode === "flip" ? "翻棋暗棋" : netCfg.revealAll ? "布局 · 明棋" : "布局 · 暗棋",
        () =>
          hostOnly(() => {
            if (netCfg.mode === "flip") {
              netCfg.mode = "lay";
              netCfg.revealAll = true;
            } else if (netCfg.revealAll) {
              netCfg.revealAll = false;
            } else {
              netCfg.mode = "flip";
              netCfg.revealAll = false;
            }
            netSend({ t: "cfg", ...netCfg });
          }),
      ),
    );
    rows.appendChild(
      setting(
        "先后手:",
        netCfg.firstMove === Side.Red ? "红先行" : "蓝先行",
        () =>
          hostOnly(() =>
            netCfg.firstMove = netCfg.firstMove === Side.Red ? Side.Blue : Side.Red,
          ),
      ),
    );
    rows.appendChild(
      setting("我方布局:", `${netMyLayout.length ? "已就绪" : "未生成"}（可重随机）`, () => {
        netMyLayout = netFreshLayout();
        netSend({ t: "ready", layout: netMyLayout });
        status("已重新随机我方布局并同步", "good");
      }),
    );
    body.appendChild(rows);

    const hint = document.createElement("div");
    hint.className = "hint-box";
    hint.dataset.tone = "warn";
    hint.textContent =
      netLobbyNote ||
      (netIsHost()
        ? "两人到齐后点「开始对战」。布局对战的布阵由两边各自随机生成（可点「我方布局」重随机）。"
        : "房主改玩法/先后手；两人到齐后由房主点「开始对战」。");
    body.appendChild(hint);

    const extra = document.createElement("div");
    extra.className = "btn-row";
    const startBtn = document.createElement("button");
    startBtn.type = "button";
    startBtn.className = "ui-btn wide";
    startBtn.textContent = netActive ? "再来一局（房主）" : "开始对战（房主）";
    startBtn.disabled = !netIsHost() || !netPeerOnline();
    startBtn.addEventListener("click", () => {
      play(A, "click0");
      netHostStart();
    });
    const leaveBtn = document.createElement("button");
    leaveBtn.type = "button";
    leaveBtn.className = "ui-btn wide";
    leaveBtn.textContent = "断开连接";
    leaveBtn.addEventListener("click", () => {
      play(A, "click0");
      netLeave();
      closeDialog();
      status("已断开联机", "info");
    });
    extra.append(startBtn, leaveBtn);
    body.appendChild(extra);

    openDialog(
      { icon: "icon_config.png", title: "联机大厅", body, foot: false, designW: 675, designH: 707 },
      build,
    );
  };
  build();
}

/** 房主点「开始对战」：把开局参数发给对面，然后自己也开局。 */
function netHostStart(): void {
  if (!net || !netIsHost()) return;
  if (!netPeerOnline()) {
    status("对手还没进来", "bad");
    return;
  }
  if (!netMyLayout.length) netMyLayout = netFreshLayout();
  const s: NetSetup =
    netCfg.mode === "flip"
      ? { mode: "flip", revealAll: false, firstMove: netCfg.firstMove, seed: Date.now() >>> 0 }
      : {
          mode: "lay",
          revealAll: netCfg.revealAll,
          firstMove: netCfg.firstMove,
          redLayout: netSeat === 0 ? netMyLayout : netPeerLayoutOrNull() ?? LAYOUTS[1].cells,
          blueLayout: netSeat === 0 ? netPeerLayoutOrNull() ?? LAYOUTS[1].cells : netMyLayout,
        };
  netSend({ t: "setup", s });
  closeDialog();
  netApplySetup(s);
}

let netPeerLayout: number[] | null = null;
function netPeerLayoutOrNull(): number[] | null {
  return netPeerLayout;
}

/** 收到开局参数：两边各自本地建局（确定性 ⇒ 逐格相同）。 */
function netApplySetup(s: NetSetup): void {
  netSetup = s;
  netActive = true;
  netAppliedClicks = 0;
  netDrawOffered = false;
  clearAid();
  vsAi = false;
  aiBusy = false;
  cancelAnim();
  layCfg.revealAll = s.revealAll;
  layCfg.firstMove = s.firstMove;

  if (s.mode === "flip") {
    flip = new FlipGame(s.seed ?? Date.now());
    flip.turn = s.firstMove === Side.Red ? 0 : 1;
    setMode("flip");
  } else {
    lay = new LayGame(s.redLayout ?? LAYOUTS[0].cells, s.blueLayout ?? LAYOUTS[1].cells, {
      revealAll: s.revealAll,
      firstTurn: s.firstMove,
    });
    setMode("lay");
  }
  showStartBanner();
  afterTurn(mode === "flip" ? flip.messages : lay.messages);
  status(`联机开局：你执 ${sideName(netMySide())}，${sideName(s.firstMove)}先行`, "good");
}

// ── 收发 ───────────────────────────────────────────────────

function netSum(): number {
  if (mode === "flip") {
    return stateSum(flip.pos.type, flip.pos.owner, flip.pos.revealed, flip.turn);
  }
  return stateSum(lay.pos.type, lay.pos.owner, lay.pos.revealed, lay.turn);
}

/** 序列化当前局面（只给 `replay` 兜底用）。 */
function netSnapshotState(): NetState {
  const p = mode === "flip" ? flip.pos : lay.pos;
  const msgs = (mode === "flip" ? flip.messages : lay.messages).slice(-30);
  return {
    type: Array.from(p.type),
    owner: Array.from(p.owner),
    revealed: Array.from(p.revealed),
    turn: mode === "flip" ? flip.turn : lay.turn,
    lastMove: mode === "flip" ? flip.lastMove : lay.lastMove,
    winner: mode === "flip" ? flip.winner : lay.winner,
    isDraw: mode === "flip" ? flip.isDraw : lay.isDraw,
    revealAll: mode === "flip" ? false : lay.revealAll,
    msgs: msgs.map((m) => ({ text: m.text, tone: m.tone })),
  };
}

function netApplyReplay(s: NetSetup, st: NetState): void {
  netApplySetup(s);
  const g = mode === "flip" ? flip : lay;
  g.pos.type.set(st.type);
  g.pos.owner.set(st.owner);
  g.pos.revealed.set(st.revealed);
  if (mode === "flip") {
    flip.turn = st.turn as 0 | 1;
    flip.winner = st.winner as 0 | 1 | null;
  } else {
    lay.turn = st.turn as Side;
    lay.winner = st.winner as Side | null;
  }
  g.isDraw = st.isDraw;
  g.lastMove = st.lastMove;
  if (st.msgs) {
    g.messages.length = 0;
    for (const m of st.msgs) g.messages.push({ text: m.text, tone: m.tone as GameMessage["tone"] });
  }
  afterTurn(g.messages);
  status("已与房主对齐局面", "good");
}

function netOnMsg(m: NetMsg): void {
  switch (m.t) {
    case "joined":
      netSeat = m.seat;
      netRoom = m.room;
      netNames = m.names;
      netOnline[netSeat] = true;
      netLobbyNote = "";
      netLobbyAgain?.();
      status(`已进入房间 ${m.room}（你执${sideName(netMySide())}）`, "good");
      // 断线重连回来的：直接请房主对齐局面
      if (netActive) netSend({ t: "sync" });
      else if (!netIsHost() && netMyLayout.length) netSend({ t: "ready", layout: netMyLayout });
      break;
    case "peer":
      netNames[m.seat] = m.name || netNames[m.seat];
      netOnline[m.seat] = m.online;
      if (m.seat !== netSeat) {
        status(`${m.name || "对手"}${m.online ? "已连接" : "已掉线"}`, m.online ? "good" : "bad");
      }
      netLobbyAgain?.();
      break;
    case "err":
      netLobbyNote = m.msg;
      status(m.msg, "bad");
      netLobbyAgain?.();
      break;
    case "cfg":
      netCfg.mode = m.mode;
      netCfg.revealAll = m.revealAll;
      netCfg.firstMove = m.firstMove;
      netLobbyAgain?.();
      break;
    case "ready":
      netPeerLayout = m.layout ? [...m.layout] : null;
      netLobbyAgain?.();
      break;
    case "setup":
      closeDialog();
      netApplySetup(m.s);
      break;
    case "click":
      netRemoteClick(m.cell);
      break;
    case "undo":
      netApplyUndo(true);
      break;
    case "draw":
      if (netDrawOffered) {
        netApplyDraw("双方同意和棋");
      } else {
        status("对方提议和棋 —— 点 ☰ →「提和」即同意", "info");
      }
      break;
    case "resign":
      netApplyResign(m.seat);
      break;
    case "chat":
      status(`【${netPeerName()}】${m.text}`, "info");
      break;
    case "sum":
      if (m.h !== netSum()) {
        if (netIsHost()) netSend({ t: "replay", s: netSetup!, state: netSnapshotState() });
        else netSend({ t: "sync" });
      }
      break;
    case "sync":
      if (netIsHost() && netSetup) {
        netSend({ t: "replay", s: netSetup, state: netSnapshotState() });
      }
      break;
    case "replay":
      netApplyReplay(m.s, m.state);
      break;
    default:
      break;
  }
}

/** 每走几步报一次校验和（只用于发现跑飞，正常永远一致）。 */
function netMaybeSum(): void {
  if (!netActive) return;
  if (++netAppliedClicks % 8 !== 0) return;
  netSend({ t: "sum", h: netSum() });
}

/** 本地点了一下，且本地接受了 ⇒ 转给对面。 */
function netMirrorClick(cell: number, accepted: boolean): void {
  if (!netActive || !accepted) return;
  netSend({ t: "click", cell });
  netMaybeSum();
}

/** 对面的一下点击，落到本地棋盘上。 */
function netRemoteClick(cell: number): void {
  if (!netActive) return;
  if (mode === "flip") {
    const prevLast = flip.lastMove;
    const pre = clonePosition(flip.pos);
    const before = flip.pos.revealed.slice();
    const nMsg = flip.messages.length;
    flip.click(cell);
    if (flip.pos.revealed.some((v, i) => v !== before[i])) play(A, "flip");
    else if (flip.messages.length > nMsg) {
      const m = flip.messages.at(-1)!;
      play(A, m.tone === "good" ? "eat" : m.tone === "bad" ? "dead" : "move");
    }
    afterTurn(flip.messages, takeMoveSpec(pre, prevLast, flip.lastMove));
    netMaybeSum();
    return;
  }
  if (mode !== "lay") return;
  const prevLast = lay.lastMove;
  const pre = clonePosition(lay.pos);
  const nMsg = lay.messages.length;
  if (lay.click(cell)) {
    const m = lay.messages.at(-1);
    if (lay.messages.length > nMsg && m) {
      play(A, m.tone === "good" ? "eat" : m.tone === "bad" ? "dead" : "select");
    } else {
      play(A, "select");
    }
  }
  afterTurn(lay.messages, takeMoveSpec(pre, prevLast, lay.lastMove));
  netMaybeSum();
}

function netApplyUndo(remote: boolean): void {
  // 布局 / 翻棋现在同构（两边都有 `undo()` 与 `messages`），联机悔棋走同一条路。
  const g: LayGame | FlipGame | null =
    mode === "lay" ? lay : mode === "flip" ? flip : null;
  if (!g) {
    if (!remote) status("当前模式不支持悔棋", "bad");
    return;
  }
  if (!g.undo()) {
    if (!remote) status("没有可悔的棋", "bad");
    return;
  }
  afterTurn(g.messages);
  status(remote ? "对方悔棋，已同步" : "已悔棋（双方同步）", "info");
}

function netApplyResign(seat: 0 | 1): void {
  if (!netActive) return;
  if (mode === "flip") flip.winByResign(seat);
  else lay.winByResign(seat === 0 ? Side.Red : Side.Blue);
  afterTurn(mode === "flip" ? flip.messages : lay.messages);
}

function netApplyDraw(reason: string): void {
  if (!netActive) return;
  if (mode === "flip") flip.drawByAgree(reason);
  else lay.drawByAgree(reason);
  afterTurn(mode === "flip" ? flip.messages : lay.messages);
}

function netResign(): void {
  if (!netActive || !net) {
    status("当前不在联机对局中", "bad");
    return;
  }
  netSend({ t: "resign", seat: netSeat });
  netApplyResign(netSeat);
}

function netOfferDraw(): void {
  if (!netActive || !net) {
    status("当前不在联机对局中", "bad");
    return;
  }
  if (netDrawOffered) {
    netApplyDraw("双方同意和棋");
    return;
  }
  netDrawOffered = true;
  netSend({ t: "draw" });
  status("已提议和棋，等对方点「提和」同意", "info");
}

/** 聊天的几个快捷语（原版 `icon_chat.png` 那条通道）。 */
const NET_CHAT_PHRASES = ["你好！", "好棋！", "走快点~", "再来一局？"] as const;

function netChat(): void {
  if (!netActive || !net) {
    status("当前不在联机对局中", "bad");
    return;
  }
  const body = document.createElement("div");
  body.className = "btn-col";
  const hint = document.createElement("div");
  hint.className = "hint-box";
  hint.textContent = "点一句发给对方（手机上打字太慢，故用快捷语）。";
  body.appendChild(hint);
  const row = document.createElement("div");
  row.className = "btn-row";
  for (const p of NET_CHAT_PHRASES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ui-btn";
    b.textContent = p;
    b.addEventListener("click", () => {
      play(A, "click0");
      netSend({ t: "chat", text: p });
      status(`已发送：${p}`, "good");
      closeDialog();
    });
    row.appendChild(b);
  }
  body.appendChild(row);
  openDialog(
    { icon: "icon_chat.png", title: "聊天", body, foot: false, designW: 675, designH: 707 },
    () => netChat(),
  );
}

/** 大厅设置（只有房主的那份会被采用，加入者收到 `cfg` 覆盖）。 */
const netCfg: { mode: "lay" | "flip"; revealAll: boolean; firstMove: Side } = {
  mode: "lay",
  revealAll: false,
  firstMove: Side.Red,
};


/** 设置 —— 把原来的「对局设置 / 电脑对手」两块并成原版那种「标签 + 按钮」行。 */
function openSettings(): void {
  play(A, "click0");
  const build = (): void => {
    const rows = [
      {
        // 原版的玩法来自大厅；本地复刻没有大厅，就在设置里留一个入口
        // （原版开局后**没有**模式切换按钮，这一行是复刻版自己的补充，不算原版界面）。
        label: "玩法:",
        value:
          mode === "lay" ? "布局对战" : mode === "flip" ? "翻棋暗棋" : "布阵编辑",
        onCycle: () => {
          setMode(mode === "lay" ? "flip" : mode === "flip" ? "edit" : "lay");
          refreshDialog();
        },
      },
      {
        label: "人机对战:",
        value: vsAi ? "开 · 电脑执蓝" : "关 · 双人",
        onCycle: () => {
          vsAi = !vsAi;
          aiBusy = false;
          if (vsAi) {
            lay = newLay();
            flip = new FlipGame();
            showStartBanner();
          }
          afterTurn(mode === "flip" ? flip.messages : lay.messages);
          refreshDialog();
        },
      },
      {
        label: "电脑水平:",
        value: aiLevel(aiLevelId).name,
        onCycle: () => {
          const i = AI_LEVELS.findIndex((l) => l.id === aiLevelId);
          aiLevelId = AI_LEVELS[(i + 1) % AI_LEVELS.length].id;
          refreshDialog();
        },
      },
      {
        label: "明暗棋:",
        value: layCfg.revealAll ? "明棋（全亮）" : "暗棋（原版）",
        onCycle: () => {
          layCfg.revealAll = !layCfg.revealAll;
          if (mode === "lay") {
            lay = newLay();
            afterTurn(lay.messages);
          }
          refreshDialog();
        },
      },
      {
        label: "走子动画:",
        value: animEnabled ? "开（原版）" : "关",
        onCycle: () => {
          animEnabled = !animEnabled;
          if (!animEnabled) cancelAnim();
          draw();
          refreshDialog();
        },
      },
      {
        label: "落点提示:",
        value: aidHints ? "开（辅助）" : "关（原版）",
        onCycle: () => {
          aidHints = !aidHints;
          draw();
          refreshDialog();
        },
      },
    ];
    const extra = document.createElement("div");
    extra.className = "btn-row";
    const lv = aiLevel(aiLevelId);
    const info = document.createElement("div");
    info.className = "hint-box";
    info.textContent = vsAi
      ? mode === "flip"
        ? `电脑水平：${lv.name}（枚举 ${lv.id}）· 翻棋走启发式一步评估`
        : `电脑水平：${lv.name}（枚举 ${lv.id}）· 迭代加深至 ${lv.depth} 层 · 思考 ${lv.timeMs}ms`
      : "本地双人：红蓝轮流点屏幕";
    info.dataset.tone = vsAi ? "good" : "warn";
    extra.appendChild(info);
    // AI 援助的接口配置（复刻版自加）—— 不占 rows（那里只放"循环切换"的行）。
    const aidBtn = document.createElement("button");
    aidBtn.type = "button";
    aidBtn.className = "ui-btn wide";
    aidBtn.id = "btnAidSettings";
    aidBtn.textContent = `AI 援助设置…${aidConfigured() ? "（已配置）" : "（未配置）"}`;
    aidBtn.addEventListener("click", () => {
      play(A, "click0");
      openAidSettings();
    });
    extra.appendChild(aidBtn);
    // 原版「新局」在大厅里点；这里并进设置，保持对话框结构不变。
    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "ui-btn wide";
    newBtn.textContent = "新局…";
    newBtn.addEventListener("click", () => {
      play(A, "click0");
      closeDialog();
      openNewGame();
    });
    extra.appendChild(newBtn);
    openDialog(
      {
        icon: "icon_config.png",
        title: "设置",
        rows,
        extra,
        designW: 675,
        // ⚠️ 视觉上仍是原版那套「标签 + 按钮」行，但**行数比原版对话框装得下的多**
        //    （原版 675×707 只够 4 行）。不要去改 707 —— `fitDialogHeight()`
        //    会按内容自动长高，改死高度会把第 5/6 行与「新局…」挤出可视区。
        designH: 707,
        // 这些行都是**就地生效**（onCycle 立刻改状态），所以「确定」的语义
        // 就是"确认并关窗"。从前这里写的是 `onOk: build`（原地重建同一个对话框），
        // 视觉上跟没反应一模一样 —— 用户报的"点了确定也没反应"就是这个。
        onOk: () => status("设置已保存", "good"),
        cancelText: "关闭",
        onCancel: () => status("已关闭设置"),
      },
      build,
    );
  };
  build();
}

function openLogDialog(): void {
  play(A, "click0");
  const body = document.createElement("div");
  body.className = "dlg-scroll";
  body.appendChild(panel("行棋记录", logRows(mode === "flip" ? flip.messages : lay.messages)));
  openDialog(
    {
      icon: "icon_menu.png",
      title: "行棋记录",
      body,
      designW: 675,
      designH: 707,
      okText: "关闭",
      cancelText: "返回",
      onOk: () => status("已关闭行棋记录"),
      onCancel: () => status("已关闭行棋记录"),
    },
    openLogDialog,
  );
}

function openRulesDialog(): void {
  play(A, "click0");
  const body = document.createElement("div");
  body.className = "dlg-scroll";
  body.appendChild(rulesPanel());
  openDialog(
    {
      icon: "icon_info.png",
      title: "规则说明",
      body,
      designW: 675,
      designH: 915,
      okText: "关闭",
      cancelText: "返回",
      onOk: () => status("已关闭规则说明"),
      onCancel: () => status("已关闭规则说明"),
    },
    openRulesDialog,
  );
}

// ── 布阵：原版浮动工具栏 + 手牌条（都**不是**模态，棋盘仍可点） ──

let editBar: HTMLElement | null = null;
let editRack: HTMLElement | null = null;

function buildEditChrome(): void {
  const area = $("#boardArea");
  if (!editBar) {
    editBar = document.createElement("div");
    editBar.id = "editBar";
    // 原版这块面板是 `data/ui/popup.png` 的 9 宫格：外圈 3px 灰边 (105,105,105)
    // + 内部 0.8 黑，圆角 8。实拍在 y=406..408 能直接量到那条灰边 ——
    // 只画 CSS 底色会漏掉它（见 tools/_audit/bar_cmp.png 的残差）。
    editBar.className = "edit-bar sk-popup";
    editBar.dataset.fitsize = "1";
    editBar.appendChild(
      // 原版 `2dd05ee5690b96ad0abab42a95e36115.xml` 的 4 个 IconBtn：
      //   Clear=remove.png(扫帚) Load=load.png(文件夹+绿箭头) Save=save.png(绿软盘) Finish=finish.png(绿勾)
      // 素材从 datax 里按内容比对取出（见 tools/_audit/cand108.png）。
      iconGrid([
        {
          icon: "icon_clear.png",
          label: "清空布局",
          onClick: () => {
            play(A, "click1");
            editor.clear();
            painterCell = -1;
            rebuildEditPanel();
            status("已清空本方阵地", "good");
          },
        },
        {
          icon: "icon_load.png",
          label: "载入布局",
          onClick: () => {
            play(A, "click1");
            // ★ 必须走 loadLayout：它会连带 rebuildHand()。
            //   从前只 splice cells 不刷手牌 → remaining() 仍是 25，按钮"看起来没反应"。
            editor.loadLayout(LAYOUTS[0].cells);
            painterCell = -1;
            rebuildEditPanel();
            status("已载入 00 号布阵", "good");
          },
        },
        {
          icon: "icon_save.png",
          label: "保存布局",
          onClick: () => {
            play(A, "click1");
            const v = validateLayout(editor.cells, editor.side);
            status(v.length ? `不合规：${v[0]}` : "布阵合法，可开战", v.length ? "bad" : "good");
          },
        },
        {
          icon: "icon_finish.png",
          label: "完成布局",
          onClick: () => {
            const v = validateLayout(editor.cells, editor.side);
            if (v.length > 0) return status(`布阵不合规：${v[0]}`, "bad");
            if (editor.remaining() !== 0)
              return status(`还剩 ${editor.remaining()} 枚未摆放`, "bad");
            lay = new LayGame(editor.toLayout(), LAYOUTS[layCfg.blueIdx].cells, {
              revealAll: layCfg.revealAll,
            });
            layCfg.firstMove = Side.Red;
            lay.turn = Side.Red;
            setMode("lay");
            showStartBanner();
            afterTurn(lay.messages);
          },
        },
      ]),
    );
    area.appendChild(editBar);
  }
  if (!editRack) {
    editRack = document.createElement("div");
    editRack.id = "editRack";
    editRack.className = "edit-rack";
    area.appendChild(editRack);
  }
  syncEditChrome();
}

/** 只在布阵模式显示；位置按原版实测（工具栏 675×240 @ (22.5,206)、手牌条贴顶）。 */
function syncEditChrome(): void {
  const s = view.scale;
  const on = mode === "edit";
  if (editBar) {
    editBar.hidden = !on;
    editBar.style.left = `${EDIT_BAR.x * s}px`;
    editBar.style.top = `${EDIT_BAR.y * s}px`;
    editBar.style.width = `${EDIT_BAR.w * s}px`;
    editBar.style.height = `${EDIT_BAR.h * s}px`;
    editBar.style.setProperty("--ds", String(s));
    // 面板吃 `popup.png` 9 宫格（灰边 + 0.8 黑底），按 view.scale 不能按 uiScale。
    applySkin(editBar, "popup", s);
    for (const el of editBar.querySelectorAll<HTMLElement>(".ui-btn")) {
      applySkin(el, SKIN_BTN);
    }
  }
  if (editRack) {
    // 原版布阵默认态（s15_lay）**没有**任何"手牌货架"：整套布阵已经落在盘上。
    // 货架只是复刻版在"还有子没摆完"时的辅助，所以 remaining()==0 就收起来，
    // 否则它会盖住对方第 10/11 行、破坏像素对齐。
    const showRack = on && editor.remaining() > 0;
    editRack.hidden = !showRack;
    if (showRack) {
      editRack.innerHTML = "";
      editRack.style.left = `${EDIT_BAR.x * s}px`;
      editRack.style.top = `${8 * s}px`;
      editRack.style.setProperty("--ds", String(s));
      const src = $("#sidebar").querySelector(".edit-panel");
      if (src) {
        // 手牌 → 货架；按钮排与提示并到右侧。
        const hand = src.querySelector(".hand");
        const hint = src.querySelector(".hint-box");
        if (hand) editRack.appendChild(hand);
        if (hint) editRack.appendChild(hint);
      }
      for (const el of editRack.querySelectorAll<HTMLElement>(".ui-btn")) {
        applySkin(el, SKIN_SMALL);
      }
    }
  }
}

const SKIN_SMALL = "sbtn";


function settingsPanel(): HTMLElement {
  const d = document.createElement("div");
  d.className = "btn-col";
  if (mode === "lay") {
    d.appendChild(
      picker("明棋（全亮）", "暗棋（隐藏）", lay.revealAll, (v) => {
        layCfg.revealAll = v;
        lay = newLay();
        afterTurn(lay.messages);
        buildSidebar();
      }),
    );
    d.appendChild(
      picker("红方先行", "蓝方先行", layCfg.firstMove === Side.Red, (v) => {
        layCfg.firstMove = v ? Side.Red : Side.Blue;
        lay = newLay();
        afterTurn(lay.messages);
        buildSidebar();
      }),
    );
    d.appendChild(
      skinButton("换一套布阵", {
        skin: "sbtn",
        wide: true,
        onClick: () => {
          layCfg.redIdx = Math.floor(Math.random() * LAYOUTS.length);
          layCfg.blueIdx = Math.floor(Math.random() * LAYOUTS.length);
          lay = newLay();
          showStartBanner();
          afterTurn(lay.messages);
        },
      }),
    );
  } else {
    d.appendChild(
      skinButton("重新洗牌", {
        skin: "sbtn",
        wide: true,
        onClick: () => {
          flip = new FlipGame();
          showStartBanner();
          afterTurn(flip.messages);
        },
      }),
    );
  }
  // 原版没有落点预览；这里给一个可选辅助（默认关，保持与原版一致）。
  d.appendChild(
    picker("原版提示（蓝框）", "含落点辅助", !aidHints, (v) => {
      aidHints = !v;
      draw();
      buildSidebar();
    }),
  );
  // 原版走子有动画（`PieceAni`，默认开）；关掉即"点了立刻落位"。
  d.appendChild(
    picker("走子动画（原版）", "走子动画 · 关", animEnabled, (v) => {
      animEnabled = v;
      if (!v) cancelAnim();
      draw();
      buildSidebar();
    }),
  );
  return panel("对局设置", d);
}

function picker(
  onText: string,
  offText: string,
  value: boolean,
  onChange: (v: boolean) => void,
): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ui-btn wide";
  b.textContent = value ? onText : offText;
  b.dataset.on = String(value);
  applySkin(b, "sbtn");
  b.addEventListener("click", () => {
    play(A, "click0");
    onChange(!value);
  });
  return b;
}

/**
 * 电脑对手面板 —— 开关 + 5 档「电脑水平」。
 * 档位名与原版 `libjunqi.so` 的难度标签表一致：新手/容易/普通/高级/困难。
 */
function aiPanel(): HTMLElement {
  const d = document.createElement("div");
  d.className = "btn-col";

  d.appendChild(
    picker("人机对战 · 电脑执蓝", "双人对战（本地）", vsAi, (v) => {
      vsAi = v;
      aiBusy = false;
      if (v) {
        lay = newLay();
        flip = new FlipGame();
        showStartBanner();
      }
      afterTurn(mode === "flip" ? flip.messages : lay.messages);
      buildSidebar();
    }),
  );

  const row = document.createElement("div");
  row.className = "btn-row";
  for (const l of AI_LEVELS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ui-btn";
    b.textContent = l.name;
    b.dataset.active = String(l.id === aiLevelId);
    b.disabled = !vsAi;
    b.title =
      `原版难度枚举 ${l.id}（旧称 ${l.legacy}）· ` +
      (mode === "flip"
        ? "翻棋：启发式一步评估（不做迭代加深）"
        : `迭代加深至 ${l.depth} 层 · 思考 ${l.timeMs}ms`);
    applySkin(b, "sbtn");
    b.addEventListener("click", () => {
      play(A, "click0");
      aiLevelId = l.id;
      buildSidebar();
      draw();
    });
    row.appendChild(b);
  }
  d.appendChild(row);

  const info = document.createElement("div");
  info.className = "hint-box";
  const cur = aiLevel(aiLevelId);
  info.textContent = vsAi
    ? mode === "flip"
      ? `电脑水平：${cur.name}（枚举 ${cur.id}）· 翻棋走启发式一步评估（实测 <1ms/手）`
      : `电脑水平：${cur.name}（枚举 ${cur.id}）· 迭代加深至 ${cur.depth} 层 · 思考 ${cur.timeMs}ms`
    : "本地双人：红蓝轮流点屏幕";
  info.dataset.tone = vsAi ? "good" : "warn";
  d.appendChild(info);

  // ── AI 援助（复刻版自加）──────────────────────────────────
  // 人机对战时"这一步不会走"的求助入口：把**当前全部合法着法**编号发给模型，
  // 模型只回一个序号 ⇒ 合法性由本地规则层兜底（见 `game/aiaid.ts`），
  // 然后把建议的那一步画在棋盘上（蓝框选中 + 落点）。
  // 入口刻意放这里（复刻版自建侧栏）而不是原版 ☰ 菜单 —— 菜单要保持 8 格原样。
  const aidBtn = document.createElement("button");
  aidBtn.type = "button";
  aidBtn.className = "ui-btn wide";
  aidBtn.id = "btnAiAid";
  aidBtn.textContent = aidBusy ? "AI 援助 · 思考中（点此取消）" : "AI 援助 · 提示一步";
  aidBtn.dataset.on = String(aidConfigured());
  aidBtn.disabled = mode === "flip" || (mode === "lay" && lay.over);
  aidBtn.title = aidConfigured()
    ? "调用已配置的模型接口，在全部合法着法里挑一步并高亮"
    : "尚未配置接口 —— 点击会打开「功能设置」，先填接口地址 / API Key / 模型名";
  applySkin(aidBtn, "sbtn");
  aidBtn.addEventListener("click", () => {
    play(A, "click0");
    void runAiAid();
  });
  d.appendChild(aidBtn);

  return panel("电脑对手", d);
}

function editPanel(): HTMLElement {
  const d = document.createElement("div");
  d.className = "edit-panel";

  const hand = document.createElement("div");
  hand.className = "hand";
  const counts = new Map<PieceType, number>();
  for (const t of editor.hand) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const meta of PIECE_TABLE) {
    const t = meta.type;
    if (t === PieceType.Empty) continue;
    const n = counts.get(t) ?? 0;
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "hand-item";
    cell.disabled = n === 0;
    cell.dataset.active = String(editor.painter === t);
    cell.appendChild(tileCanvas(t, editor.side));
    const badge = document.createElement("span");
    badge.className = "hand-count";
    badge.textContent = String(n);
    cell.appendChild(badge);
    cell.title = `${meta.name} ×${n}`;
    cell.addEventListener("click", () => {
      play(A, "click1");
      editor.painter = editor.painter === t ? null : t;
      painterCell = -1;
      status(
        editor.painter
          ? `手持 ${meta.name}，点击棋盘落子`
          : "已取消落子",
      );
      buildSidebar();
      draw();
    });
    hand.appendChild(cell);
  }
  d.appendChild(hand);

  const bar = document.createElement("div");
  bar.className = "btn-row";
  bar.appendChild(
    skinButton("随机布阵", {
      skin: "sbtn",
      onClick: () => {
        editor.randomize();
        rebuildEditPanel();
        status("已随机布阵", "good");
      },
    }),
  );
  bar.appendChild(
    skinButton("清空", {
      skin: "sbtn",
      onClick: () => {
        editor.clear();
        painterCell = -1;
        rebuildEditPanel();
        status("已清空本方阵地", "good");
      },
    }),
  );
  bar.appendChild(
    skinButton("载入 00 阵", {
      skin: "sbtn",
      onClick: () => {
        editor.loadLayout(LAYOUTS[0].cells);
        painterCell = -1;
        rebuildEditPanel();
        status("已载入 00 号布阵", "good");
      },
    }),
  );
  d.appendChild(bar);

  const info = document.createElement("div");
  info.className = "hint-box";
  const check = validateLayout(editor.cells, editor.side);
  const ok = check.length === 0;
  const left = editor.remaining();
  info.textContent = ok
    ? left === 0
      ? "布阵合法 · 25 枚已就位，可以开战"
      : `还剩 ${left} 枚未摆放`
    : `不合规：${check[0]}`;
  info.dataset.tone = ok && left === 0 ? "good" : "warn";
  d.appendChild(info);

  d.appendChild(
    skinButton("以该布阵开战", {
      skin: "btn",
      wide: true,
      onClick: () => {
        const l = editor.toLayout();
        const v = validateLayout(editor.cells, editor.side);
        if (v.length > 0) {
          status("布阵不合规：" + v[0], "bad");
          return;
        }
        if (editor.remaining() !== 0) {
          status(`还剩 ${editor.remaining()} 枚未摆放`, "bad");
          return;
        }
        lay = new LayGame(l, LAYOUTS[layCfg.blueIdx].cells, {
          revealAll: layCfg.revealAll,
        });
        layCfg.firstMove = Side.Red;
        lay.turn = Side.Red;
        setMode("lay");
        showStartBanner();
        afterTurn(lay.messages);
      },
    }),
  );
  return panel("布阵手牌", d);
}

function rebuildEditPanel(): void {
  buildSidebar();
  updateTurnLabel();
  // 手牌数一变，「货架」的显隐也跟着变（remaining()==0 时收起，见 syncEditChrome）。
  if (mode === "edit") syncEditChrome();
  draw();
}

let rulesText = "";

function rulesPanel(): HTMLElement {
  const d = document.createElement("div");
  d.className = "rules";
  for (const line of rulesText.split(/\r?\n/)) {
    const p = document.createElement("p");
    if (!line.trim()) {
      p.className = "sp";
      d.appendChild(p);
      continue;
    }
    p.innerHTML = line
      .replace(/\{yellow\}(.*?)\{\/yellow\}/g, '<b class="hl">$1</b>')
      .replace(/^ +/, (m) => "&nbsp;".repeat(m.length));
    d.appendChild(p);
  }
  return panel("原版规则（rulelay.txt）", d);
}

// ── 模式切换 ────────────────────────────────────────────────
function setMode(m: Mode): void {
  cancelAnim();
  // 换界面 = 当前对局作废 ⇒ 在途的 AI 援助也放下（否则"正在问模型…"会飘到新界面）。
  cancelAiAid();
  // 「规则」在原版是**弹窗**（`066e6f33…xml`，Dialog 675×900），不是一个模式：
  // 所以只是把规则弹出来，当前模式原样保留。
  if (m === "rules") {
    openRulesDialog();
    return;
  }
  mode = m;
  $("#app").dataset.mode = m;
  const home = document.getElementById("home");
  if (home) home.hidden = m !== "home";
  if (m === "home") {
    // 回首页 = 原版"回到启动菜单"：收起对话框、停掉动画与 AI，也不该再显示对局提示。
    // 观战必须一并停下（否则 `watchTimer` 到点后会在首页上走一手）。
    stopWatch();
    closeDialog();
    aiBusy = false;
    status("");
    return;
  }
  if (m === "edit") buildEditChrome();
  buildSidebar();
  syncFloatIcons();
  updateTurnLabel();
  draw();
  status(
    m === "lay"
      ? "布局对战：点己方棋子选中，再点落点"
      : m === "flip"
        ? "翻棋：点任意棋子翻开，先翻者定色"
        : "布阵：从手牌选子，点本方阵地落子",
  );
  scheduleAi(600);
}

/**
 * `?ai=N`（可加 `&lv=1..5`）自检：开人机对战，让红方用规则随机着、蓝方走真电脑，
 * 各走 N 手，把摘要写进 `<pre id="probeResult">`。
 *
 * 它验证的是**接线**而不是算法（算法在 tests/run.ts 里测）：
 * `aiChooseMove()` 的返回值能不能经由 `LayGame.click()` 这条路真正落到盘上、
 * 会不会出现「电脑不动」「电脑走了非法着」「电脑卡死主线程」这三类问题。
 */
async function runAiSelfCheck(plies: number, levelId: number): Promise<void> {
  selfCheck = true; // 自检全程同步跑：屏蔽定时重排，也屏蔽走子动画
  cancelAnim();
  vsAi = true;
  aiLevelId = levelId;
  lay = newLay();
  // ★ 这里**故意保留原版缺省**（`revealAll=false` ⇒ `opts.hidden=true`，即布局-暗棋），
  //   因为自检要覆盖的正是暗棋这条最容易坏的路径。
  //   旧版曾在此处整盘 `hidden=false` 绕过 —— 那是在掩盖一个真 bug：
  //   `canActivate`/`canLandOn` 把**翻棋专属**的 `revealed` 门槛误用到布局暗棋上，
  //   导致暗棋下任何子都选不出、整局走不动（已修，门槛现在只在 `opts.flipMode` 下生效）。
  //   现在暗棋下 `allLegalMoves` / `lay.click` 都能正常工作，不需要任何绕过。
  const lv = aiLevel(aiLevelId);
  const lines: string[] = [];
  let plies0 = 0;
  let tMax = 0;
  let nodesMax = 0;
  let depthMax = 0;

  for (let k = 0; k < plies && !lay.over; k++) {
    const side = lay.turn;
    const legal = allLegalMoves(lay.pos, side, lay.opts);
    if (legal.length === 0) {
      lines.push(`ply ${k}: ${side === AI_SIDE ? "电脑" : "人"} 无子可动`);
      break;
    }
    const n0 = lay.messages.length;
    if (side === AI_SIDE) {
      const t0 = performance.now();
      aiTurn();
      const dt = performance.now() - t0;
      if (dt > tMax) tMax = dt;
      if (AI_STATS.lastNodes > nodesMax) nodesMax = AI_STATS.lastNodes;
      if (AI_STATS.lastDepth > depthMax) depthMax = AI_STATS.lastDepth;
      if (lay.messages.length === n0) {
        lines.push(`ply ${k}: 电脑没有落子`);
        break;
      }
      if (lay.turn === AI_SIDE) {
        lines.push(`ply ${k}: 电脑落子后仍然轮到电脑（着法被规则层拒绝）`);
        break;
      }
    } else {
      const m = legal[(Math.random() * legal.length) | 0];
      lay.click(m.from);
      lay.click(m.to);
      if (lay.messages.length === n0) {
        lines.push(`ply ${k}: 人方着法 ${m.from}->${m.to} 被拒`);
        break;
      }
    }
    plies0++;
  }

  const flagDone = lay.over;
  lines.unshift(
    `ai     档位=${lv.name}(枚举${lv.id}) 迭代加深≤${lv.depth}层 时限=${lv.timeMs}ms`,
    `ai     完成 ${plies0} 手  终局=${flagDone ? "是" : "否"}  单步耗时 max=${tMax.toFixed(0)}ms（无头模式下时钟冻结，该值无意义）`,
    `ai     搜到 maxDepth=${depthMax} 层  最大节点数=${nodesMax}`,
    `ai     盘面：${lay.messages.length} 条消息，turn=${lay.turn}`,
  );
  const pre = document.createElement("pre");
  pre.id = "probeResult";
  pre.textContent = lines.join("\n");
  document.body.appendChild(pre);
  buildSidebar(); // 让「人机对战」开关和档位按钮反映真实状态
  draw();
}

/**
 * `?flipai=N` 自检：**翻棋**人机对战的接线校验。
 *
 * 它守的是一条真出过的 bug —— 翻棋开局有 10 个**空行营**，
 * 而 `FlipGame.click()` 曾用 `type === Empty` 一刀切拒绝，
 * 于是电脑「走进行营」这一着永远落不到盘上、回合不换手，
 * `afterTurn → scheduleAi` 便每 200ms 重试一次 ⇒ 人机对战**永久卡死**
 * （同时 `clickAt` 又以 `turn === 1` 挡住玩家，整局完全动不了）。
 * 所以这里不仅看「有没有走」，还专门统计**空转次数**（必须 0），
 * 并单独确认「空行营可以当落点」。
 */
function runFlipAiSelfCheck(plies: number, levelId: number, rngSeed?: number): void {
  selfCheck = true;
  vsAi = true;
  aiLevelId = levelId;
  flip = new FlipGame(20260910);
  // 固定 AI 随机源 → 整局自检完全可复现（空转才能被稳定调试）。
  if (rngSeed !== undefined) aiRngOverride = makeRng(rngSeed);
  const lv = aiLevel(aiLevelId);
  const lines: string[] = [];
  let done = 0;
  let stalls = 0;
  let tMax = 0;
  let aiActions = 0;
  let campAsTarget = 0;

  for (let k = 0; k < plies * 2 && !flip.over; k++) {
    if (flip.turn === 0) {
      // 人：翻第一枚未翻开的（最保守，保证回合一定推进）
      let cell = -1;
      for (let i = 0; i < CELLS; i++) {
        if (flip.pos.type[i] !== PieceType.Empty && flip.pos.revealed[i] === 0) {
          cell = i;
          break;
        }
      }
      if (cell < 0) {
        lines.push(`ply ${k}: 人无子可翻`);
        break;
      }
      const t = flip.turn;
      flip.click(cell);
      if (!flip.over && flip.turn === t) {
        stalls++;
        lines.push(`ply ${k}: 人方翻子未换手`);
        break;
      }
      done++;
    } else {
      const t = flip.turn;
      const n0 = flip.messages.length;
      const t0 = performance.now();
      aiTurn();
      const dt = performance.now() - t0;
      if (dt > tMax) tMax = dt;
      aiActions++;
      if (!flip.over && flip.turn === t) {
        stalls++;
        lines.push(`ply ${k}: ✗ 电脑着法未落盘（空转），turn 仍是 ${t}`);
        break;
      }
      if (flip.messages.length === n0) {
        lines.push(`ply ${k}: 电脑没有落子`);
        break;
      }
      done++;
    }
  }

  // 单独确认「空行营是合法落点」—— 这是曾经卡死的直接原因
  const own = flip.sides[flip.turn];
  for (let n = 0; n < CELLS; n++) {
    if (flip.pos.type[n] === PieceType.Empty) continue;
    if (flip.pos.owner[n] !== own || flip.pos.revealed[n] !== 1) continue;
    flip.click(n);
    if (flip.targets.some((x) => flip.pos.type[x.to] === PieceType.Empty)) campAsTarget++;
    flip.click(n); // 取消选中
  }

  lines.unshift(
    `flip   档位=${lv.name}(枚举${lv.id})  翻棋走启发式一步评估（不迭代加深）`,
    `flip   完成 ${done} 手  电脑出手 ${aiActions} 次  空转 ${stalls} 次（必须为 0）`,
    `flip   单步耗时 max=${tMax.toFixed(2)}ms  终局=${flip.over ? "是" : "否"}`,
    `flip   空行营可作落点：命中 ${campAsTarget} 处（>0 即通过）`,
    `flip   盘面：${flip.messages.length} 条消息  turn=${flip.turn}`,
  );
  const pre = document.createElement("pre");
  pre.id = "probeResult";
  pre.textContent = lines.join("\n");
  document.body.appendChild(pre);
  buildSidebar();
  draw();
}

/**
 * `?animprobe=1` 自检：**走子动画**的端到端验证（在真实浏览器里跑）。
 *
 * 为什么不能只靠 `tests/run.ts`：那边验证的是"路径重建"和"时长公式"这两块纯逻辑，
 * 而"点了棋子到底有没有在帧之间移动"取决于 rAF、渲染器和 canvas 这三者的接线。
 * 这里就用项目一贯的手法 —— **两次截屏像素差分**：
 *
 *   在动画进行中取两帧 A、B（相隔 ~35% 时长），差分理应**只落在移动的那枚棋子上**：
 *     · 变化像素 > 0      → 它确实在飞（而不是瞬移）
 *     · 包围盒很小        → 全盘其余部分一动不动（没把画面画坏）
 *     · 包围盒中心贴着"起→讫"连线 → 飞的方向对
 *   落位后再取两帧，差分必须为 0（干净收尾，没有残影）。
 */
async function runAnimProbe(): Promise<void> {
  const out: string[] = [];
  const mark: string[] = [];
  const ok = (name: string, cond: boolean, extra = "") => {
    out.push(`anim   ${cond ? "✓" : "✗"} ${name}${extra ? " —— " + extra : ""}`);
    if (!cond) mark.push(name);
  };
  const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

  // 注意：这里**不再需要**临时整盘亮明。旧版曾 `lay.opts.hidden=false` 绕过，
  // 是因为 `legalTargets` 误把翻棋的 `revealed` 门槛套到布局暗棋上、扫描一无所获
  //（一度被误判成"动画坏了"）。门槛修好后，暗棋缺省下扫描就能正常出着法，
  // 所以探测直接在**真实缺省（暗棋）**下跑，更贴近实况。

  // 挑**路径最长**的一手 —— 单格着法只能验证"帧间在动"，
  // 多段路径才能顺带验证"沿折线飞、没抄近道"。
  let from = -1;
  let to = -1;
  let bestPath: readonly number[] = [];
  for (let i = 0; i < CELLS; i++) {
    if (lay.pos.type[i] === PieceType.Empty || lay.pos.owner[i] !== lay.turn) continue;
    for (const tg of legalTargets(lay.pos, i, lay.turn, lay.opts)) {
      const p = pathBetween(lay.pos, i, tg.to);
      if (p.length > bestPath.length) {
        bestPath = p;
        from = i;
        to = tg.to;
      }
    }
  }
  if (from < 0) {
    out.push("anim   ✗ 找不到可动的红方棋子");
    emitProbe(out);
    return;
  }

  // 开局是满盘，最长着法也只有一格 —— 单格只能验证"帧间在动"。
  // 再造一个"铁路空线"场景：工兵沿列 0 上行 4 格、再沿行 1 横走 4 格（9 格折线），
  // 专门验证"沿折线飞、不抄近道"。
  let synthetic = false;
  if (bestPath.length < 3) {
    for (let i = 0; i < CELLS; i++) clearCell(lay.pos, i);
    from = idx(5, 0);
    to = idx(1, 4);
    setPiece(lay.pos, from, PieceType.Engineer, Side.Red, 1);
    lay.turn = Side.Red;
    lay.selected = -1;
    lay.targets = [];
    lay.lastMove = null;
    lay.winner = null;
    lay.isDraw = false;
    bestPath = pathBetween(lay.pos, from, to);
    synthetic = true;
  }

  const prevLast = lay.lastMove;
  const pre = clonePosition(lay.pos);
  lay.click(from);
  lay.click(to);
  const spec = takeMoveSpec(pre, prevLast, lay.lastMove);
  if (!spec) {
    out.push("anim   ✗ 着法没有被接受，无法测动画");
    emitProbe(out);
    return;
  }

  animEnabled = true;
  beginMoveAnim(spec);
  if (!anim) {
    out.push("anim   ✗ 动画未启动");
    emitProbe(out);
    return;
  }
  const dur = anim.duration;
  const totalPx = anim.total;
  const animPath = anim.path.slice();
  const cells = animPath.length;
  const start = anim.start;

  const W = canvas.width;
  const H = canvas.height;
  const grab = () => ctx.getImageData(0, 0, W, H).data;

  await sleep(Math.max(15, dur * 0.15));
  const A = grab();
  const tA = performance.now() - start;
  await sleep(Math.max(30, dur * 0.35));
  const B = grab();
  const tB = performance.now() - start;
  await sleep(dur * 0.8); // 确保播完
  const C = grab();
  await sleep(220);
  const D = grab();

  const d1 = diffBBox(A, B, W, H);
  const d2 = diffBBox(C, D, W, H);

  // 起讫格中心（设备像素）
  const dpr = W / (parseFloat(canvas.style.width) || W);
  const dev = (cell: number) => ({
    x: (view.ox + COL_X[colOf(cell)] * view.scale) * dpr,
    y: (view.oy + ROW_Y[rowOf(cell)] * view.scale) * dpr,
  });
  const pts = animPath.map(dev);
  const cx = (d1.x0 + d1.x1) / 2;
  const cy = (d1.y0 + d1.y1) / 2;
  // 到**路径折线**的距离（不是到起讫直线的距离 —— 工兵拐弯时两者不同）
  let offLine = Infinity;
  for (let k = 1; k < pts.length; k++) {
    offLine = Math.min(
      offLine,
      pointSegmentDist(cx, cy, pts[k - 1].x, pts[k - 1].y, pts[k].x, pts[k].y),
    );
  }
  if (!Number.isFinite(offLine)) offLine = 0;

  out.push(
    `anim   路径=${cells} 格 [${animPath.join("→")}]  总长=${totalPx.toFixed(1)}px` +
      `  时长=${dur.toFixed(0)}ms${synthetic ? "（铁路空线场景）" : ""}`,
  );
  out.push(
    `anim   t≈${tA.toFixed(0)}ms vs t≈${tB.toFixed(0)}ms：变化像素=${d1.n}` +
      `  包围盒=${(d1.x1 - d1.x0 + 1) || 0}×${(d1.y1 - d1.y0 + 1) || 0}` +
      `  中心离路径=${offLine.toFixed(1)}px`,
  );
  ok("两帧之间有变化（棋子确实在动，不是瞬移）", d1.n > 200, `像素=${d1.n}`);
  // 变化区应当是一条**细带**（棋子扫过的那段 = 垂直于移动方向只有一枚子高），
  // 而不是一整片。注意**不能**用"包围盒宽度 < 画布 45%"来判 —— 工兵沿铁路连冲
  // 4 格时，两帧位置之间那条带子本来就横跨半张盘（实测 506×76），那是**正确**行为。
  const bw = (d1.x1 - d1.x0 + 1) || 0;
  const bh = (d1.y1 - d1.y0 + 1) || 0;
  const piecePx = PIECE_H * view.scale;
  ok(
    "变化是一条细带（没把全盘画花）",
    d1.n > 0 &&
      Math.min(bw, bh) <= 3 * piecePx &&
      bw * bh <= W * H * 0.3,
    `盒 ${bw}×${bh}（窄边 ${Math.min(bw, bh)} ≤ 3×子高 ${(3 * piecePx).toFixed(0)}）` +
      ` 面积占比 ${((bw * bh * 100) / (W * H)).toFixed(1)}% / 画布 ${W}×${H}`,
  );
  ok("移动方向贴着『路径折线』", offLine < W * 0.12, `${offLine.toFixed(1)}px`);
  ok("落位后画面静止（无残影）", d2.n === 0, `像素=${d2.n}`);
  ok("时长落在原版公式上（单步 ≈400ms 量级）", dur >= 90 && dur <= 900, `${dur.toFixed(0)}ms`);

  // ── 第二段：**暗棋**下的动画 ──
  // 守的是一条很容易踩的坑：走完一步后 `lay.turn` 已经换成对手，
  // 若动画期间拿 `lay.turn` 当"己方视角"，对手的 25 枚暗子会被整片掀开。
  // 判据不需要参照图：动画帧与"走子前静态帧"逐像素比，除了正在飞的那枚子，
  // 其余必须**一模一样**（掀开暗子的话，变化会漫延到整个对方阵地）。
  lay = new LayGame(
    LAYOUTS[layCfg.redIdx].cells,
    LAYOUTS[layCfg.blueIdx].cells,
    { revealAll: false },
  );
  lay.turn = Side.Red;
  lay.selected = -1;
  lay.targets = [];
  lay.lastMove = null;

  // 布局-暗棋下玩家本来就看得见自己的子，没有"先翻开再动"这一步
  //（那是**翻棋**的流程）。所以这里直接对己方子调 `legalTargets` 即可 ——
  // 旧版在这里手动把候选格标成 `revealed=1` 才能扫出着法，是在绕过一个真 bug
  //（`revealed` 门槛被误用到布局暗棋上），现已修好，不需要再"当作已翻开"。
  let dFrom = -1;
  let dTo = -1;
  for (let i = 0; i < CELLS && dFrom < 0; i++) {
    if (lay.pos.type[i] === PieceType.Empty || lay.pos.owner[i] !== Side.Red) continue;
    const tg = legalTargets(lay.pos, i, Side.Red, lay.opts);
    if (tg.length > 0) {
      dFrom = i;
      dTo = tg[0].to;
    }
  }
  draw();
  const S0 = grab();
  if (dFrom >= 0) {
    const dPrev = lay.lastMove;
    const dPre = clonePosition(lay.pos);
    lay.click(dFrom);
    lay.click(dTo);
    const dSpec = takeMoveSpec(dPre, dPrev, lay.lastMove);
    if (dSpec) {
      beginMoveAnim(dSpec);
      const dDur = anim ? anim.duration : 300;
      await sleep(Math.max(20, dDur * 0.3));
      const F = grab();
      cancelAnim();
      draw();
      const d3 = diffBBox(S0, F, W, H);
      out.push(
        `anim   暗棋：动画帧 vs 走子前静态帧  变化像素=${d3.n}` +
          `  包围盒=${(d3.x1 - d3.x0 + 1) || 0}×${(d3.y1 - d3.y0 + 1) || 0}`,
      );
      ok(
        "暗棋：动画没把对手的暗子掀开（变化仍只在一枚子附近）",
        d3.n > 0 && d3.x1 - d3.x0 < W * 0.45 && d3.y1 - d3.y0 < H * 0.3,
        `盒 ${(d3.x1 - d3.x0 + 1) || 0}×${(d3.y1 - d3.y0 + 1) || 0} / ${W}×${H}`,
      );
    } else {
      ok("暗棋：取到了待播的走子动画", false);
    }
  } else {
    ok("暗棋：找得到可动的红方棋子", false);
  }

  if (mark.length === 0) out.push("anim   ✓ 走子动画端到端自检通过");
  else out.push(`anim   ✗ 未通过：${mark.join(" / ")}`);
  emitProbe(out);
}

/** 把自检结果写进 `<pre id="probeResult">`。 */
function emitProbe(lines: string[]): void {
  const pre = document.createElement("pre");
  pre.id = "probeResult";
  pre.textContent = lines.join("\n");
  document.body.appendChild(pre);
}

/** 两帧像素差分的包围盒与计数（忽略 alpha）。 */
function diffBBox(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  w: number,
  h: number,
): { n: number; x0: number; x1: number; y0: number; y1: number } {
  let n = 0;
  let x0 = Infinity;
  let x1 = -1;
  let y0 = Infinity;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const base = y * w * 4;
    for (let x = 0; x < w; x++) {
      const o = base + x * 4;
      if (a[o] !== b[o] || a[o + 1] !== b[o + 1] || a[o + 2] !== b[o + 2]) {
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (n === 0) return { n, x0: 0, x1: 0, y0: 0, y1: 0 };
  return { n, x0, x1, y0, y1 };
}

/** 点到线段的距离。 */
function pointSegmentDist(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  if (len2 <= 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * vx + (py - ay) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

// ── 启动 ────────────────────────────────────────────────────
/**
 * `?probe=1` 自检：无头浏览器里跑一遍几何/交互校验，结果写进 `<pre id="probeResult">`。
 * 之所以需要它 —— 「一模一样」不能靠肉眼，得能被脚本反复验证：
 *   1. hitTest ←→ cellCenter 是否严格互逆（点哪儿就落在哪格）
 *   2. 原版棋盘位图里**自己画出来的**绿色标记（46 兵站 + 10 行营）
 *      与 boardart.ts 的 COL_X / ROW_Y 是否吻合 —— 这是几何常量的回归哨兵
 *   3. 走一步棋，确认规则层到渲染层这条链路真的通
 */
async function runProbe(): Promise<void> {
  const out: string[] = [];
  const p = A.manifest.pieceAtlas;

  out.push(
    `assets  board=${A.manifest.board.file} ${A.manifest.board.w}x${A.manifest.board.h}` +
      `  atlas=${p.file} ${p.w}x${p.h} cell=${p.tileW}x${p.tileH} rows=${p.rows}` +
      `  skin=${Object.keys(A.manifest.skin).length}` +
      `  ui=${Object.keys(A.manifest.ui).length}` +
      `  sound=${Object.keys(A.manifest.sound).length}`,
  );
  out.push(
    `view    scale=${view.scale.toFixed(4)} ox=${view.ox.toFixed(1)} oy=${view.oy.toFixed(1)}` +
      ` canvas=${canvas.style.width}x${canvas.style.height}` +
      ` 视口=${window.innerWidth}×${window.innerHeight} dpr=${window.devicePixelRatio}` +
      ` #app=${$("#app").clientWidth}×${$("#app").clientHeight}`,
  );

  // 1) hitTest 往返
  const miss: string[] = [];
  for (let i = 0; i < CELLS; i++) {
    const c = cellCenter(view, i);
    const got = hitTest(view, c.x, c.y);
    if (got !== i) miss.push(`${i}→${got}`);
  }
  out.push(`hitTest ${CELLS - miss.length}/${CELLS}${miss.length ? " 失配 " + miss.join(",") : " 全部互逆"}`);

  // 2) 位图绿色标记 ←→ 几何常量
  const bm = A.img[A.manifest.board.file];
  const off = document.createElement("canvas");
  off.width = bm.naturalWidth;
  off.height = bm.naturalHeight;
  off.getContext("2d")!.drawImage(bm, 0, 0);
  const px = off.getContext("2d")!.getImageData(0, 0, off.width, off.height).data;
  const W = off.width;
  const H = off.height;
  const isGreen = (x: number, y: number): boolean => {
    const o = (y * W + x) * 4;
    const r = px[o];
    const g = px[o + 1];
    const b = px[o + 2];
    return g > 110 && g - r > 35 && g - b > 60;
  };
  const seen = new Uint8Array(W * H);
  const marks: { x: number; y: number; kind: string }[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (seen[y * W + x] || !isGreen(x, y)) continue;
      const stack = [y * W + x];
      seen[y * W + x] = 1;
      let n = 0;
      let x0 = x;
      let x1 = x;
      let y0 = y;
      let y1 = y;
      while (stack.length) {
        const q = stack.pop()!;
        const cy = (q / W) | 0;
        const cx = q - cy * W;
        n++;
        if (cx < x0) x0 = cx;
        if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy;
        if (cy > y1) y1 = cy;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ny = cy + dy;
            const nx = cx + dx;
            if (ny < 0 || nx < 0 || ny >= H || nx >= W) continue;
            const k = ny * W + nx;
            if (seen[k] || !isGreen(nx, ny)) continue;
            seen[k] = 1;
            stack.push(k);
          }
        }
      }
      if (n < 200) continue;
      const w = x1 - x0 + 1;
      const h = y1 - y0 + 1;
      marks.push({
        x: (x0 + x1) / 2,
        y: (y0 + y1) / 2,
        kind: w > 1.5 * h ? "post" : "camp",
      });
    }
  }
  const posts = marks.filter((m) => m.kind === "post").length;
  const camps = marks.length - posts;
  let worst = 0;
  let sum = 0;
  for (const m of marks) {
    let best = Infinity;
    for (let r = 0; r < 12; r++) {
      for (let c = 0; c < 5; c++) {
        const dx = m.x - COL_X[c];
        const dy = m.y - ROW_Y[r];
        const d = Math.hypot(dx, dy);
        if (d < best) best = d;
      }
    }
    worst = Math.max(worst, best);
    sum += best;
  }
  out.push(
    `bitmap  兵站=${posts} 行营=${camps}（应为 46 + 10）` +
      `  与 COL_X/ROW_Y 偏差 平均 ${(sum / Math.max(1, marks.length)).toFixed(2)}px` +
      ` 最大 ${worst.toFixed(2)}px`,
  );

  // 3) 实走一步
  const g = new LayGame(LAYOUTS[0].cells, LAYOUTS[1].cells, { revealAll: true });
  let moved = "无可动子";
  for (let i = 0; i < CELLS; i++) {
    if (g.pos.type[i] === PieceType.Empty || g.pos.owner[i] !== g.turn) continue;
    const tg = legalTargets(g.pos, i, g.turn, g.opts);
    if (!tg.length) continue;
    g.click(i);
    g.click(tg[0].to);
    moved = `${pieceName(g.pos.type[i] === PieceType.Empty ? g.pos.type[tg[0].to] : g.pos.type[i])}` +
      ` ${i}→${tg[0].to} : ${g.messages.at(-1)?.text ?? ""}`;
    break;
  }
  out.push(`engine  ${moved}`);

  // 4) 翻棋初始摆布：50 枚铺满 50 个非行营格，10 个行营留空
  const fg = new FlipGame(12345);
  let onCamp = 0;
  let filled = 0;
  for (let i = 0; i < CELLS; i++) {
    const has = fg.pos.type[i] !== PieceType.Empty;
    if (has) filled++;
    if (has && isCamp(i)) onCamp++;
  }
  const allHidden = fg.pos.revealed.every((v) => v === 0);
  out.push(
    `flip    棋子=${filled}/50（应为 50）  行营上的子=${onCamp}（应为 0）` +
      `  全部盖着=${allHidden}`,
  );

  // 5) 高亮框：离屏跑一帧，确认原版的「蓝框(选中) + 红框(最后一步)」真的画出来了
  //    预期外沿 = 98×73 原图 px（棋子 86×61 外扩 6px）、线宽 5px、纯色。
  {
    const oc = document.createElement("canvas");
    oc.width = ART_W;
    oc.height = ART_H;
    const octx = oc.getContext("2d")!;
    const pp = createEmptyPosition();
    const selCell = 5 * 5 + 1; // (row5, col1)
    setPiece(pp, selCell, PieceType.Commander, Side.Red, 1);
    render(octx, A, { scale: 1, ox: 0, oy: 0 }, {
      pos: pp,
      revealAll: true,
      selected: selCell,
      targets: [],
      lastMove: { from: 5 * 5 + 0, to: 5 * 5 + 2 },
    });
    const px2 = octx.getImageData(0, 0, ART_W, ART_H).data;
    let blue = 0;
    let red = 0;
    let bx0 = 1e9, bx1 = -1, by0 = 1e9, by1 = -1;
    for (let y = 0; y < ART_H; y++) {
      for (let x = 0; x < ART_W; x++) {
        const o = (y * ART_W + x) * 4;
        const r = px2[o], g = px2[o + 1], b = px2[o + 2];
        if (b > 200 && r < 60 && g < 60) {
          blue++;
          if (x < bx0) bx0 = x;
          if (x > bx1) bx1 = x;
          if (y < by0) by0 = y;
          if (y > by1) by1 = y;
        } else if (r > 200 && g < 60 && b < 60) red++;
      }
    }
    out.push(
      `marks   蓝框 px=${blue} 外沿=${bx1 - bx0 + 1}×${by1 - by0 + 1}` +
        `（应 98×73，中心 ${((bx0 + bx1) / 2).toFixed(0)},${((by0 + by1) / 2).toFixed(0)}` +
        ` 期望 ${COL_X[1]},${ROW_Y[5]}）  红框 px=${red}`,
    );
    // 把这一帧挂到页面上，方便用无头浏览器截图肉眼复核（probe 本身是调试设施）。
    oc.style.cssText =
      "position:fixed;right:6px;top:6px;width:260px;height:auto;" +
      "z-index:99999;border:2px solid #fff;background:#2b1d0e";
    oc.id = "probeMarks";
    document.body.appendChild(oc);
  }

  // 6) ★★ 回归哨兵：主菜单「人机对战」必须**直接开一局翻棋·暗棋**。
  //
  //    原版实证（2026-09-13 雷电 9 实拍）：在主菜单点「人机对战」后截屏与原版
  //    翻棋开局图 `s10_flip.png` **逐像素相同（差值 0.000）** —— 50 枚全盖着绿色
  //    背面、10 个行营留空、双方颜色未定。即原版直接用「新局」对话框的默认值开局：
  //    先后手=我先手 / 电脑水平=普通 / 玩法=**翻棋** / 明暗棋=**暗棋**。
  //
  //    这个入口曾经错接成 `setMode("lay")`（布局）→ 一开局就把双方棋子全摊开，
  //    被用户一眼看穿（"我不是暗棋吗"）。下面这段**模拟真实点击**并逐项断言，
  //    就是为了让它不会再悄悄回退 —— 光靠注释挡不住回归。
  {
    const prevMode = mode;
    const prevVsAi = vsAi;
    let err = "";
    try {
      $("#btnOne").click();
    } catch (e) {
      err = String(e);
    }
    let filledN = 0;
    let campN = 0;
    for (let i = 0; i < CELLS; i++) {
      if (flip.pos.type[i] === PieceType.Empty) continue;
      filledN++;
      if (isCamp(i)) campN++;
    }
    const faceDown = flip.pos.revealed.every((v) => v === 0);
    const good =
      !err &&
      mode === "flip" &&
      flip.opts.hidden === true &&
      faceDown &&
      filledN === 50 &&
      campN === 0 &&
      vsAi === true &&
      aiLevelId === DEFAULT_AI_LEVEL &&
      layCfg.firstMove === Side.Red &&
      layCfg.revealAll === false;
    out.push(
      `vsai    点「人机对战」→ mode=${mode} hidden=${flip.opts.hidden}` +
        ` 全盖着=${faceDown} 子=${filledN}/50 行营上的子=${campN}` +
        ` vsAi=${vsAi} 水平=${aiLevelId} 先手=${sideName(layCfg.firstMove)}` +
        ` 明暗=${layCfg.revealAll ? "明棋" : "暗棋"}` +
        (err ? ` 点击异常=${err}` : "") +
        (good ? "  ✓ 与原版一致" : "  ✗ 与原版不符"),
    );
    // 复原现场：后面的截图/渲染不该被这次模拟点击带跑。
    vsAi = prevVsAi;
    flip = new FlipGame();
    setMode(prevMode);
  }

  // 7) 棋盘菜单 8 项与原版 `s08.png` 同序（原版菜单没有标题行，铺 8 个 IconBtn），
  //    且「重新开始」必须弹「新局」对话框（原版行为），不是无提示重开。
  {
    openMenu();
    const labels = Array.from(
      document.querySelectorAll<HTMLElement>(".icon-grid .icon-cell > span"),
    ).map((e) => e.textContent ?? "");
    const want = [
      "重新开始", "悔棋", "电脑变着", "规则说明",
      "功能设置", "战况统计", "软件信息", "退出程序",
    ];
    // 第 8 格是**唯一有意偏离**原版的地方：原版是「退出程序」（红叉），网页没有进程
    // 可退，改为真的「返回主窗口」（用户原话「返回主窗口也没反应」就是这一项）。
    // 位置与图标索引不变，只换标签 —— 这里显式放行，而不是把 `want` 改掉，
    // 这样"前 7 格必须与原版逐字一致"这条约束仍然受控。
    const ALT_8 = "返回主窗口";
    const sameOrder =
      labels.length === want.length &&
      labels.every((v, i) => (i === 7 ? v === want[7] || v === ALT_8 : v === want[i]));
    out.push(
      `menu    ${labels.length} 项 [${labels.join("/")}]  ` +
        (sameOrder ? "✓ 与原版同序" : `✗ 期望 [${want.join("/")}]`),
    );
    // 点第一项「重新开始」→ 期望弹「新局」对话框（图标 icon_newgame.png，4 行）
    const first = document.querySelector<HTMLElement>(".icon-grid .icon-cell");
    first?.click();
    const host = document.getElementById("modalHost");
    const ngIcon = host?.querySelector<HTMLImageElement>(".dlg-title > img");
    const rowsN = host?.querySelectorAll(".dlg-row").length ?? 0;
    const rowLabels = Array.from(
      host?.querySelectorAll<HTMLImageElement>(".dlg-row .dlg-label img") ?? [],
    ).map((e) => e.alt);
    const rowVals = Array.from(
      host?.querySelectorAll<HTMLImageElement>(".dlg-row .dlg-val img") ?? [],
    ).map((e) => e.alt);
    const ngOk =
      (ngIcon?.src ?? "").includes("icon_newgame.png") &&
      rowsN === 4 &&
      rowLabels.join(",") === "先后手:,电脑水平:,玩法:,明暗棋:" &&
      // 「明暗棋」缺省必须是**暗棋** —— 与「人机对战」直开暗棋同一处缺省值。
      rowVals[3] === "暗棋";
    out.push(
      `newgame 「重新开始」→ ${ngOk ? "新局对话框 ✓" : "✗ 未弹出新局对话框"}` +
        `  行=${rowsN}[${rowVals.join("/")}]`,
    );
    closeDialog();

    // ★ 闸门哨兵：AI 援助**必须出现在人机对战的 ☰ 里**。
    //   它曾经只挂在 `.offscreen` 侧栏上（`left:-10000px; pointer-events:none`）
    //   ⇒ 真人点不到，等于没有。这条断言守的就是"别再把它挪回离屏去"。
    //   做法：临时把 vsAi 打开、重开菜单看第 9 格，然后还原并关掉对话框，
    //   不给后面的渲染自检留下一份多一格的菜单。
    {
      const prevAiMenu = vsAi;
      vsAi = true;
      openMenu();
      const l2 = Array.from(
        document.querySelectorAll<HTMLElement>(".icon-grid .icon-cell > span"),
      ).map((e) => e.textContent ?? "");
      const aidOn = l2.length === want.length + 1 && l2[8] === "AI 援助";
      vsAi = prevAiMenu;
      closeDialog();
      out.push(
        `aidmenu 人机菜单 ${l2.length} 项 [${l2.join("/")}]  ` +
          (aidOn ? "✓ AI 援助在可见菜单" : "✗ AI 援助入口不可见/缺失"),
      );
    }

    // ★ 翻棋哨兵：**翻棋里 ☰ 也要有第 9 格「AI 援助」**。
    //   2026-09-14 用户问"我要怎么调出 ai 援助啊" —— 根因就是这条缺失：
    //   主菜单的「人机对战」进的是翻棋·暗棋（原版行为），而第 9 格曾只放
    //   `mode === "lay"`，于是用户点完「人机对战」翻遍菜单都找不到它。
    //   这条断言把"翻棋也要有"钉死，顺带确认候选生成器认得出开局的 50 张暗子。
    {
      const prevMode2 = mode;
      const prevAi2 = vsAi;
      mode = "flip";
      vsAi = true;
      openMenu();
      const l3 = Array.from(
        document.querySelectorAll<HTMLElement>(".icon-grid .icon-cell > span"),
      ).map((e) => e.textContent ?? "");
      const aidFlipOn = l3.length === want.length + 1 && l3[8] === "AI 援助";
      closeDialog();
      // ★ 再钉一条："翻棋里也要把建议画到盘上"。
      //   翻棋的 draw() 分支曾漏传 `aidPair` —— 结果是提示条有字、棋盘上一个框都没有，
      //   玩家照做之前根本不知道点哪（2026-09-14 截图才发现）。这里真画一次、
      //   数画布上的纯蓝像素，0 就说明又漏了。
      aidMove = { from: 5, to: 5, reveal: true };
      draw();
      let bluePx = 0;
      const cv = $("#board") as HTMLCanvasElement | null;
      const px = cv?.getContext("2d")?.getImageData(0, 0, cv.width, cv.height).data;
      if (px) {
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] === 0 && px[i + 1] === 0 && px[i + 2] === 255 && px[i + 3] === 255) bluePx++;
        }
      }
      aidMove = null;
      mode = prevMode2;
      vsAi = prevAi2;
      draw();
      // 开局的翻棋盘：50 枚全盖着（10 个行营留空）——候选生成器必须如实认出来。
      const fresh = new FlipGame();
      const nReveal = flipRevealCells(fresh.pos).length;
      const flipOk = aidFlipOn && nReveal === 50 && bluePx > 0;
      out.push(
        `aidflip 翻棋菜单 ${l3.length} 项 [${l3.join("/")}]  可翻暗子=${nReveal}（应 50）` +
          `  蓝框px=${bluePx}（应 >0）  ` +
          (flipOk ? "✓ 人机对战(翻棋)也能调出 AI 援助，且建议框画在盘上" : "✗ 翻棋里够不着 AI 援助 / 没画建议框"),
      );
    }

    // ★ 哨兵：等待模型回答时，☰ 第 9 格必须写「**取消** AI 援助」。
    //   玩家实报的困惑："我点 AI 援助，它却说取消了上一次" —— 标签骗人就得改标签：
    //   等待中那一下点下去**就是取消**，写「AI 援助」等于误导。空闲时则必须写回「AI 援助」。
    {
      const prevMode3 = mode;
      const prevAi3 = vsAi;
      const prevBusy3 = aidBusy;
      const readLast = (): string => {
        const l = Array.from(
          document.querySelectorAll<HTMLElement>(".icon-grid .icon-cell > span"),
        ).map((e) => e.textContent ?? "");
        return l[l.length - 1] ?? "";
      };
      mode = "flip";
      vsAi = true;
      aidBusy = true;
      openMenu();
      const busyLabel = readLast();
      closeDialog();
      aidBusy = false;
      openMenu();
      const idleLabel = readLast();
      closeDialog();
      mode = prevMode3;
      vsAi = prevAi3;
      aidBusy = prevBusy3;
      const labelOk = busyLabel === "取消 AI 援助" && idleLabel === "AI 援助";
      out.push(
        `aidlabel 等待中第9格=「${busyLabel}」 空闲=「${idleLabel}」  ` +
          (labelOk ? "✓ 标签如实反映点下去会怎样" : "✗ 等待中仍写「AI 援助」、点下去却变成取消"),
      );
    }

    // ★ 哨兵：AI 援助的**出网方式**必须端到端可用。
    //
    //   玩家实报「AI援助超时」的根因就在这儿：浏览器直连过不了跨域预检，
    //   更要命的是**用不了本机代理**（Chrome 默认只认 Windows 系统代理）——
    //   实测本机 `api.openai.com` 直连挂死 >9s，走 127.0.0.1:7897 只需 1.1s。
    //   修复后页面应当**当场**认出同源中转 `/__aiaid/relay`，由 Node 侧出网。
    //
    //   这里现探一次（而不是读启动时那次的结果）：探针本身就是"中转在不在"的
    //   唯一判据，读缓存值的话，启动竞态会让哨兵假绿。
    {
      const alive = await aidRelayAvailable();
      aidRelayOn = alive;
      const cfgNow = aidCfg();
      const ok = alive && !!cfgNow.relay;
      out.push(
        `aidrelay 同源中转=${alive ? "在" : "不在"}  本次请求走=${cfgNow.relay ? "中转" : "浏览器直连"}` +
          `  超时=${Math.round((cfgNow.timeoutMs ?? 0) / 1000)}s  ` +
          (ok
            ? "✓ 能走中转（跨域与「用不了本机代理」两个死穴都绕开）"
            : "✗ 没认出中转，会退回浏览器直连 —— 需要代理的接口地址只能干等到超时"),
      );
    }

    // ★ 回归哨兵：「**只是选中一颗子**」不算局面变化，不许碰 AI 建议、也不许倒退 toast。
    //   背景：`afterTurn()` 曾经无条件 `clearAid()` + `status(最后一条日志)`，
    //   于是玩家点了「AI 援助」看到蓝框、再点它建议的那颗子时 —— 蓝框当场消失，
    //   toast 还倒退成上一局的旧消息（"新对局开始，红方先行"）。
    //   这里造一条建议，然后**走真人同一条链路** `clickAt()` 点它建议的起点格，
    //   断言选中生效、建议还在、哨兵 toast 没被顶掉。
    if (mode === "lay" && !lay.over) {
      let pick = -1;
      let pickTo = -1;
      for (let i = 0; i < CELLS; i++) {
        if (lay.pos.type[i] === PieceType.Empty || lay.pos.owner[i] !== lay.turn) continue;
        const tg = legalTargets(lay.pos, i, lay.turn, lay.opts);
        if (tg.length) {
          pick = i;
          pickTo = tg[0].to;
          break;
        }
      }
      if (pick < 0) {
        out.push("selkeep ✗ 局面上找不到可选中的己方棋子，无法验证");
      } else {
        aidMove = { from: pick, to: pickTo, reveal: false };
        status("selkeep 哨兵", "info");
        const c = cellCenter(view, pick);
        clickAt(c.x, c.y);
        const selOk = lay.selected === pick;
        const kept = aidMove !== null;
        const toastSame = ($("#statusText").textContent ?? "").trim() === "selkeep 哨兵";
        clickAt(c.x, c.y); // 再点一次 = 取消选中
        aidMove = null;
        draw();
        out.push(
          `selkeep 点己方棋子(格${pick})：已选中=${selOk}  AI 建议仍在=${kept}` +
            `  toast 未被顶掉=${toastSame}  ` +
            (selOk && kept && toastSame ? "✓ 只是选中不动提示" : "✗ 选中把提示/日志冲掉了"),
        );
      }
    }
  }

  // ★ 哨兵（2026-09-14 玩家实报）：「**第一排 / 最后一排 / 大本营**的棋子走不动」。
  //
  //   原版走法生成有**两套子系统**（见 `core/rules.ts` 里 `baseFrozenOf` 的长注释）：
  //     翻棋 → Path A（`FUN_0006919c`）没有"大本营"这道门；
  //     布局 → Path B（`FUN_0006a098`）用 `DAT_00133cb4` 把 4 个大本营格整个跳过。
  //   旧实现把"大本营冻结"**无条件**写进 `canActivate`，翻棋下多冻了 4 格 —— 玩家就是这么发现的。
  //
  //   这条哨兵对两种规则各跑一遍：把一枚司令**单独**放在两条底线行的 10 格上（含 4 个大本营），
  //   算它的合法落点。翻棋必须格不错一处地全都能走；布局的 4 个大本营必须全都走不动。
  //   顺带钉住翻棋的另一半规则：**盖着的子一步都不能走**（要先翻开）。
  {
    const backRows: number[] = [];
    for (let c = 0; c < COLS; c++) backRows.push(idx(0, c), idx(ROWS - 1, c));
    const baseCells = backRows.filter((i) => isBase(i));

    const movesAt = (opts: typeof DEFAULT_OPTIONS, i: number, revealed: boolean): number => {
      const p = createEmptyPosition();
      setPiece(p, i, PieceType.Commander, Side.Red, revealed ? 1 : 0);
      return legalTargets(p, i, Side.Red, opts).length;
    };

    const flipOpts = { ...DEFAULT_OPTIONS, hidden: true, flipMode: true };
    const layOpts = { ...DEFAULT_OPTIONS, hidden: false, flipMode: false };

    const flipDead = backRows.filter((i) => movesAt(flipOpts, i, true) === 0);
    const layAlive = baseCells.filter((i) => movesAt(layOpts, i, true) > 0);
    const flipFaceDownAlive = backRows.filter((i) => movesAt(flipOpts, i, false) > 0);
    const ok =
      flipDead.length === 0 &&
      layAlive.length === 0 &&
      flipFaceDownAlive.length === 0 &&
      baseFrozenOf(flipOpts) === false &&
      baseFrozenOf(layOpts) === true;
    out.push(
      `basemove 底线两行${backRows.length}格(含大本营${baseCells.length})` +
        `｜翻棋·已翻开走不动=${flipDead.length}(应 0)  翻棋·盖着竟能走=${flipFaceDownAlive.length}` +
        `(应 0，盖着必须先翻开)  布局·大本营仍可走=${layAlive.length}(应 0)  ` +
        (ok
          ? "✓ 翻棋能走出来、布局仍冻结 —— 与原版 Path A / Path B 一致"
          : `✗ 与原版不符 [翻棋走不动:${flipDead.join(",")}｜翻棋盖着却能走:${flipFaceDownAlive.join(
              ",",
            )}｜布局没冻:${layAlive.join(",")}]`),
    );
  }

  // ★ 哨兵（同一次玩家实报，**UI 层**）：翻棋里点「大本营」的己方已翻开子，必须**真被选中**。
  //   上面 `basemove` 验的是规则层（谁算得出落点）；"点不动"如果出在命中测试/门闸上，
  //   只有这条抓得住 —— 它走的是**真人同一条链路**：`cellCenter` 求格心 → `clickAt` 真点。
  {
    const savedFlip = flip;
    const prevModeUi = mode;
    const prevVsAiUi = vsAi;
    const baseCells = [1, 3, 56, 58]; // = 4 个大本营格（与 `isBase` 同源，这里写死便于读报告）
    const missed: number[] = [];
    const diag: string[] = [];
    let blueSeen = 0;
    for (const i of baseCells) {
      // 造一局"**净空盘**上只留一枚 红方·司令·已翻开、落在该大本营格上"的翻棋。
      //
      // ⚠️ 必须净空：满盘的翻棋开局 50 格全被占住，而**翻棋里大本营/行营是安全岛**
      //    （`canLandOn`：`cmdSafeOf` 在翻棋下为真）—— 邻居既吃不动（安全岛）又不能叠（己方），
      //    于是"这一格真的没有落点"，那是**正确**的规则结果，不是能用来验 bug 的场景。
      //    净空后司令有 3 个相邻空格可去，才把"点得动/点不动"收敛到 `canActivate` 这一道上。
      const g = new FlipGame();
      g.pos.type.fill(PieceType.Empty);
      g.pos.owner.fill(Side.None);
      g.pos.revealed.fill(0);
      setPiece(g.pos, i, PieceType.Commander, Side.Red, 1);
      g.revealedColors = true;
      g.sides[0] = Side.Red;
      g.sides[1] = Side.Blue;
      g.turn = 0;
      flip = g;
      mode = "flip";
      vsAi = false;
      anim = null; // 之前几步可能留下在途动画，`clickAt` 会因此直接 return
      draw();

      const c = cellCenter(view, i);
      const hit = hitTest(view, c.x, c.y);
      const tgLen = legalTargets(flip.pos, i, Side.Red, flip.opts).length;
      clickAt(c.x, c.y);
      diag.push(`格${i}: hit=${hit} 落点=${tgLen} 选中=${flip.selected}`);

      const cv2 = $("#board") as HTMLCanvasElement | null;
      const px2 = cv2?.getContext("2d")?.getImageData(0, 0, cv2.width, cv2.height).data;
      let bp = 0;
      if (px2) {
        for (let k = 0; k < px2.length; k += 4) {
          if (px2[k] === 0 && px2[k + 1] === 0 && px2[k + 2] === 255 && px2[k + 3] === 255) bp++;
        }
      }
      if (bp > 0) blueSeen++;
      if (flip.selected !== i) missed.push(i);
    }
    flip = savedFlip;
    mode = prevModeUi;
    vsAi = prevVsAiUi;
    anim = null;
    draw();
    const okUi = missed.length === 0 && blueSeen === baseCells.length;
    out.push(
      `basemoveui 翻棋·真点击大本营 4 格[${baseCells.join(",")}]：选中成功=${
        baseCells.length - missed.length
      }/4  画出蓝框=${blueSeen}/4  ` +
        (okUi ? "✓ 大本营的子点得动、蓝框画得上（旧版这 4 格全点不动）" : `✗ 点不动 [未选中:${missed.join(",")}]`),
    );
    out.push(`basemoveui.diag ${diag.join(" ｜ ")}`);
  }

  // ★ 扛旗解释哨兵 —— 2026-09-14 玩家实报「为什么地雷吃完了，不能吃军旗？」：
  //   条件满足一半时 `click()` 旧版直接 return false，界面一声不吭。
  //   这里用真点击复现三种情形，断言**必须说话**、且说的原因对。
  {
    const prevModeUi = mode;
    const prevVsAiUi = vsAi;
    const savedFlip2 = flip;

    const scenario = (
      setup: (g: FlipGame) => void,
      from: number,
      to: number,
    ): string => {
      const g = new FlipGame();
      g.pos.type.fill(PieceType.Empty);
      g.pos.owner.fill(Side.None);
      g.pos.revealed.fill(0);
      setup(g);
      g.revealedColors = true;
      g.sides[0] = Side.Red;
      g.sides[1] = Side.Blue;
      g.turn = 0;
      flip = g;
      mode = "flip";
      vsAi = false;
      anim = null;
      draw();
      const cf = cellCenter(view, from);
      clickAt(cf.x, cf.y); // 选中己方子
      const n = g.messages.length;
      const ct = cellCenter(view, to);
      clickAt(ct.x, ct.y); // 点对方军旗
      return g.messages.length > n ? g.messages[g.messages.length - 1].text : "";
    };

    // 玩家截图里的情形：连长紧贴敌旗、对方地雷已清零 → 挡住的是"只有工兵能扛"
    const mA = scenario(
      (g) => {
        setPiece(g.pos, 21, PieceType.Captain, Side.Red, 1);
        setPiece(g.pos, 22, PieceType.Flag, Side.Blue, 1);
      },
      21,
      22,
    );
    // 工兵贴敌旗、但对方还剩 2 颗雷 → 挡住的是地雷数
    const mB = scenario(
      (g) => {
        setPiece(g.pos, 21, PieceType.Engineer, Side.Red, 1);
        setPiece(g.pos, 22, PieceType.Flag, Side.Blue, 1);
        setPiece(g.pos, 55, PieceType.Landmine, Side.Blue, 1);
        setPiece(g.pos, 59, PieceType.Landmine, Side.Blue, 1);
      },
      21,
      22,
    );
    // 够不着（隔着半个盘）→ 不该拿规则去误导玩家，必须**不提示**
    const mC = scenario(
      (g) => {
        setPiece(g.pos, 55, PieceType.Engineer, Side.Red, 1);
        setPiece(g.pos, 22, PieceType.Flag, Side.Blue, 1);
      },
      55,
      22,
    );

    flip = savedFlip2;
    mode = prevModeUi;
    vsAi = prevVsAiUi;
    anim = null;
    draw();

    const okA = mA.includes("只有工兵能扛");
    const okB = mB.includes("2 颗地雷");
    const okC = mC === "";
    const ok = okA && okB && okC;
    out.push(
      `flagwhy 连长贴敌旗→「${mA}」(${okA ? "✓" : "✗"})｜工兵贴敌旗+2雷→「${mB}」(${
        okB ? "✓" : "✗"
      })｜够不着→${mC === "" ? "不说话 ✓" : `「${mC}」✗`}  ` +
        (ok ? "✓ 扛不动时界面必须说清原因" : "✗ 该解释的没解释 / 不该解释的乱解释"),
    );
  }

  // ★ AI 观战（复刻版自加）—— 两台电脑自己下、全局明牌、逐手留下搜索统计。
  //   要验四件事，缺一不可：
  //     ① **双方都由 AI 驱动**：`aiTurn()` 只认蓝方（`flip.turn !== 1` 直接 return），
  //        观战若沿用它会卡在"某方思考中"永远不动 —— 这条哨兵就是防它回归；
  //     ② **真的在下**：手数在涨，且每一手都带搜索深度 / 节点数（不是空壳记录）；
  //     ③ **上帝视角**：翻棋里没翻开的子也在画布上被摊开（数中性绿背面的像素：
  //        关 → 满盘绿，开 → 一张都不剩）；
  //     ④ **人的点击被拒**：否则观战变成"开天眼替 AI 走子"，学到的全是假的。
  {
    const prevModeW = mode;
    const prevVsW = vsAi;
    const prevGodW = watchGod;
    const prevLvW: [number, number] = [watchLv[0], watchLv[1]];
    const prevKindW: [WatchAgentKind, WatchAgentKind] = [watchKind[0], watchKind[1]];
    const savedLayW = lay;
    const savedFlipW = flip;

    /** 数画布上的**中性背面**（图集 r6c0 纯色 112,156,0）—— "这格还盖着"的指纹。 */
    const countGreenBacks = (): number => {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 0; i < img.length; i += 4) {
        if (Math.abs(img[i] - 112) <= 12 && Math.abs(img[i + 1] - 156) <= 12 && img[i + 2] <= 24) {
          n++;
        }
      }
      return n;
    };

    let wLay = 0;
    let wBothSides = false;
    let wStats = false;
    let wLevels = false;
    let greenOff = 0;
    let greenOn = -1;
    let wClick = false;
    let timerArmed = false;
    let timerCleared = false;
    /** 云端未配置时是否**优雅暂停并退回引擎**（不抛异常、不空转） */
    let wCloudFallback = false;
    /** 「逐」档是否真的"走一手就停"（而不是排了定时器偷偷连走） */
    let wStepPaused = false;
    /** 学习面板是否真算出了候选（行数 / 标出实际走的那条 / 摘要文案） */
    let wPanel = false;
    let wPanelRows = 0;
    let wPanelChosen = 0;
    let wPanelMain = "";
    /** 缺省观战是不是**暗棋**（布局 `revealAll=false` + 规则层 `hidden`）*/
    let wDarkDefault = false;
    /** 选暗棋时观者是不是被按回了"对局视角"（上帝视角会把它抹平成明棋）*/
    let wGodOff = false;
    /** 同一局面来回磨三次后是否真的判和（`session` 的 `repeatDraw`）*/
    let wRepeatDraw = false;
    /** 判和时这个局面已经出现过几次 */
    let wRepSeen = 0;
    /** 局面重复后引擎"会走回旧局面"的着法条数（应 >0，否则规避形同虚设）*/
    let wAvoidN = 0;
    /** 开局对话框每一行的文案都装得进按钮（值位图固定 300 设计 px，超了会被裁）*/
    let wDlgFits = false;
    /** 对话框里量过的行数 / 文案原文（报告里能一眼看出是哪句太长）*/
    let wDlgRows = 0;
    let wDlgVals = "";
    /** 玩法那一行是否**同时**写着「布局」和「翻棋」+ 玩法行原文 */
    let wFlipShown = false;
    let wWayVal = "";
    /** 切到翻棋后开局框还有几行（旧版"明暗棋"整行消失 ⇒ 3）*/
    let wFlipRows = 0;
    let watchLine = "";

    selfCheck = true; // 屏蔽定时重排：下面全部同步驱动
    try {
      watchGod = true;
      watchLv[0] = 4; // 红方 = 高级
      watchLv[1] = 2; // 蓝方 = 容易（两边**故意不同**：等级串了会被下面抓到）
      // 自检全程只认本地引擎 —— 用户在 localStorage 里存过的 `cloud` 指派
      // 会让"12 手同步驱动"变成"12 次真网络请求"，自检就不可复现了。
      watchKind = ["engine", "engine"];

      // ── A) 布局：连走 12 手 ──────────────────────────────
      enterWatch("lay", true);
      const moverSides = new Set<Side>();
      const seatLevels = new Map<number, string>();
      for (let i = 0; i < 12; i++) {
        const who = lay.turn;
        const before = watchPlies.length;
        watchStep();
        const got = watchPlies.at(-1);
        if (watchPlies.length > before && got) {
          moverSides.add(who);
          seatLevels.set(got.seat, got.level);
        }
      }
      wLay = watchPlies.length;
      wBothSides = moverSides.size === 2;
      wStats = watchPlies.every((x) => x.depth >= 1 && x.nodes > 0);
      wLevels = seatLevels.get(0) === "高级" && seatLevels.get(1) === "容易";

      // ── B) 翻棋 + 上帝视角：数中性绿背面 ─────────────────
      enterWatch("flip", true);
      watchGod = false;
      draw();
      greenOff = countGreenBacks();
      watchGod = true;
      draw();
      greenOn = countGreenBacks();

      // ── C) 人的点击必须被拒（观战 ≠ 开天眼）──────────────
      const msgBefore = flip.messages.length;
      const selBefore = flip.selected;
      const cMid = cellCenter(view, 27);
      clickAt(cMid.x, cMid.y);
      wClick = flip.messages.length === msgBefore && flip.selected === selBefore;

      // ── D) 退出观战必须清掉定时器（否则会在首页上走一手）──
      watchTogglePause(false); // 强制"继续" → 内部会 scheduleWatch 设上定时器
      timerArmed = watchTimer !== 0;
      stopWatch();
      timerCleared = watchTimer === 0;

      // ── E) 学习面板 + 「逐」档：这正是"走得太快、来不及看思路"的两个对策 ──
      //    两条都得真成立：逐手档**不排定时器而是当场停住**；面板**真算出候选**（不是空壳）。
      const prevStudyW = watchStudyOn;
      const prevSpeedW = watchSpeed;
      watchStudyOn = true;
      watchSpeed = 0; // 「逐」
      enterWatch("lay", true);
      // ① 逐手档下 `scheduleWatch` 必须当场停住（排了定时器就成了自动连走）。
      watchPaused = false;
      scheduleWatch();
      // ⚠️ 这两行 `: boolean` 是**必需的**：TS 会把上一句 `= false` 的窄化带过函数调用
      //    （它假定 `scheduleWatch` / `watchStepOnce` 不会改外部变量），
      //    于是紧接着写 `watchPaused === true` 会被判成"永假"并报 TS2367。
      const pausedAfterSched: boolean = watchPaused;
      const stopped = pausedAfterSched && watchTimer === 0;
      // ② 点「走一手」真能走一手，走完**仍停着**。
      watchStepOnce();
      const pausedAfterOnce: boolean = watchPaused;
      wStepPaused = stopped && pausedAfterOnce && watchPlies.length === 1;
      wPanelRows = document.querySelectorAll("#wsOpts .ws-opt").length;
      wPanelChosen = document.querySelectorAll("#wsOpts .ws-opt[data-chosen='1']").length;
      wPanelMain = (document.getElementById("wsMain")?.textContent ?? "").replace(/\s+/g, " ");
      wPanel = wPanelRows >= 3 && wPanelChosen === 1 && /第 1 手/.test(wPanelMain);
      watchStudyOn = prevStudyW;
      watchSpeed = prevSpeedW; // 恢复缺省档，别影响后面几段

      // ── F) 指派成云端、但没配 API：必须**优雅暂停 + 退回引擎**（不抛异常、不空转）──
      //    把「AI 援助」的三个必填项临时清空来制造这个分支 —— 无头环境正常也没配置，
      //    但自检不该依赖环境，自己把条件摆出来。
      const savedAid = {
        base: lsGet(AID_LS.base),
        key: lsGet(AID_LS.key),
        model: lsGet(AID_LS.model),
      };
      lsSet(AID_LS.base, "");
      lsSet(AID_LS.key, "");
      lsSet(AID_LS.model, "");
      try {
        enterWatch("lay", true);
        watchKind[0] = "cloud";
        await watchCloudStep(0);
        // 断言回宽类型：赋值后 TS 把 `watchKind[0]` 收窄成字面量 `"cloud"`，
        // 直接比 `=== "engine"` 会被判成"永假"而报错（它看不到 `watchCloudStep` 会改回去）。
        const kindAfter = watchKind[0] as WatchAgentKind;
        wCloudFallback = watchPaused && watchNote.length > 0 && kindAfter === "engine";
      } finally {
        lsSet(AID_LS.base, savedAid.base);
        lsSet(AID_LS.key, savedAid.key);
        lsSet(AID_LS.model, savedAid.model);
      }

      // ── G) 暗棋默认 + 循环判和（两台 AI "谁都不过谁"的收口）──
      //    用户明确要的是「看**暗棋**」+「别让它们在两三个格之间无限磨」。
      //    三条都得真成立：
      //    ① 缺省观战就是暗棋（布局整盘 `revealed` 清零 + 规则层 `hidden`）；
      //    ② 同一局面来回走三次 ⇒ `session` 判和（否则观战看起来像死机）；
      //    ③ 局面重复后 `watchAvoid()` 非空 —— 引擎据此把"走回旧局面"降权
      //       （**事前**引导）；没有它就只能干等 ② 的兜底。
      {
        const prevRevealW = watchReveal;
        watchReveal = false;
        enterWatch("lay", true);
        // ⚠️ 用 `!watchGod` 而不是 `watchGod === false`：前面 A 段写过 `watchGod = true`，
        //    TS 的控制流会把 `watchGod` 收窄成字面量 `true`（它看不到 `enterWatch`
        //    函数体里刚把它按成 `false`），于是 `=== false` 被判"永假"报 TS2367。
        //    `!` 没有这个限制，运行时取值照旧。同一个坑本案踩过两次。
        wGodOff = !watchGod;
        wDarkDefault =
          lay.revealAll === false && lay.opts.hidden === true && wGodOff;

        /** 正交相邻（`|Δrow|+|Δcol| = 1`）⇒ 原路返回仍是合法着法。 */
        const isAdj = (a: number, b: number): boolean =>
          Math.abs(rowOf(a) - rowOf(b)) + Math.abs(colOf(a) - colOf(b)) === 1;
        /**
         * 当前行动方第一个"走到相邻空格"的着法（可原样走回来）。
         *
         * ⚠️ 落点排掉**大本营**（`isBase`）：进了大本营的子按规则不能再动，
         *    那样"原路返回"就不合法，循环局面根本构造不出来。
         */
        const pickShort = (): { from: number; to: number } | null => {
          for (const m of allLegalMoves(lay.pos, lay.turn, lay.opts)) {
            if (!m.capture && isAdj(m.from, m.to) && !isBase(m.to)) {
              return { from: m.from, to: m.to };
            }
          }
          return null;
        };
        /**
         * 走一手（`back` = 沿原路返回），并像观战主循环那样**记一次局面指纹**。
         *
         * ⚠️ `watchNotePos()` 不能省：`watchSeen` 只在 `watchEngineStep` 里更新，
         *    而这里是用 `lay.click` 手工驱动（要精确构造循环局面）。不记的话
         *    `watchAvoid()` 永远查不到"旧局面"，③ 就假阴性了。
         *    走动历史（`watchNoteMove`）同理 —— 抗磨的第二判据也不能缺席。
         */
        const step = (m: { from: number; to: number }, back = false): void => {
          if (lay.over) return;
          const a = back ? m.to : m.from;
          const b = back ? m.from : m.to;
          lay.click(a);
          lay.click(b);
          watchNotePos();
          watchNoteMove(a);
        };

        const redMv = pickShort();
        let blueMv: { from: number; to: number } | null = null;
        if (redMv) {
          step(redMv);
          blueMv = pickShort();
          if (blueMv) step(blueMv);
        }
        if (redMv && blueMv) {
          // 一轮 = 红往返 + 蓝往返 = 4 手。局面轨迹：起 P0 →(红)R1 →(蓝)R2
          //   →(红返)A1 →(蓝返)**P0(第 2 次)** →(红)R1 →(蓝)R2
          const oneRound = (): void => {
            step(redMv, true);
            step(blueMv, true);
            step(redMv);
            step(blueMv);
          };
          oneRound(); // 回到 R2；此刻 P0 已出现 2 次、A1 也进了历史
          // 从 R2 走"红返 b→a"会回到已出现过的 A1 ⇒ 规避列表应非空。
          wAvoidN = watchAvoid().length;
          oneRound(); // 第二轮第 2 手走回 P0（第 3 次）→ 判和
        }
        wRepSeen = lay.positionRepeats;
        wRepeatDraw = lay.isDraw && /同一局面重复/.test(lay.drawReason);
        watchReveal = prevRevealW;
      }

      // ── H) 开局对话框的文案必须装得进按钮 ───────────────────
      //    `dialogRow` 的值位图固定 **300 设计 px 宽**（原版 XML `Button
      //    rect="330,…,630,…"`），文字先画进这个宽度的 canvas —— 超出的部分
      //    会被**静默裁掉两端**（不是溢出、不是换行）。实测踩过：
      //    「暗棋（AI 靠推理）」= 366px，两端各丢 33px，看起来像"文字跑出按钮"。
      //    这里把每行位图的 `alt`（存着**未裁**的原文）取出来，用**同一字体字号**
      //    重新量一遍宽度，超限即报。
      {
        const prevVariantW = watchVariant;
        const wayVal = (): string =>
          document
            .querySelector("#modalHost .dlg-body .dlg-row:nth-child(1) button img")
            ?.getAttribute("alt") ?? "";
        openWatchStart();
        const vals = Array.from(
          document.querySelectorAll("#modalHost .dlg-body .dlg-row button img"),
        ).map((im) => im.getAttribute("alt") ?? "");
        wDlgRows = vals.length;
        wDlgVals = vals.join(" | ");
        const c = document.createElement("canvas").getContext("2d");
        if (c) c.font = `${DLG_TEXT_SIZE}px ${DLG_FONT}`;
        wDlgFits =
          vals.length >= 3 && c != null && vals.every((v) => c.measureText(v).width <= 300);

        // ★「AI 对战里能选翻棋」—— 两件事都要成立：
        //   ① 玩法行**两个玩法都写着**。旧版只显示当前值（「布局」），用户看不见
        //      "翻棋"这三个字存在，会直接判定"AI 对战没有翻棋"（实测反馈就是这句）。
        //   ② 点一下玩法行 ⇒ 真的切到翻棋，且「明暗棋」那一行**仍然在**
        //      （旧版翻棋下这行整行消失，等于翻棋没有视角可选）。
        wWayVal = wayVal();
        wFlipShown = wWayVal.includes("布局") && wWayVal.includes("翻棋");
        document
          .querySelector<HTMLElement>("#modalHost .dlg-body .dlg-row:nth-child(1) button")
          ?.click();
        wFlipRows =
          watchVariant === "flip"
            ? document.querySelectorAll("#modalHost .dlg-body .dlg-row").length
            : 0;
        watchVariant = prevVariantW;
        closeDialog();
      }
    } catch (e) {
      watchLine = `watch ✗ 观战自检抛异常：${e instanceof Error ? e.message : String(e)}`;
    } finally {
      stopWatch();
      watchGod = prevGodW;
      watchLv = prevLvW;
      watchKind = prevKindW;
      lay = savedLayW;
      flip = savedFlipW;
      mode = prevModeW;
      vsAi = prevVsW;
      selfCheck = false;
      anim = null;
      setWatchChromeVisible(false);
      closeDialog();
      draw();
    }

    if (!watchLine) {
      // ⚠️ 判据是**相对**的，不能写 `greenOn === 0`：棋盘底图里有极少量像素
      //    恰好落进"中性绿"的容差窗（实测 ~278px），那是噪声、不是漏摊的暗子
      //    （当前缩放下**一张**暗子就有 3000+ 设备像素）。所以要求"掉到 2% 以下"。
      const wGod = greenOff > 5000 && greenOn < greenOff * 0.02;
      const wAvoid = wAvoidN > 0;
      const okW =
        wLay === 12 &&
        wBothSides &&
        wStats &&
        wLevels &&
        wGod &&
        wClick &&
        timerArmed &&
        timerCleared &&
        wCloudFallback &&
        wStepPaused &&
        wPanel &&
        wDarkDefault &&
        wRepeatDraw &&
        wAvoid &&
        wDlgFits &&
        wFlipShown &&
        wFlipRows === 4;
      watchLine =
        `watch 布局12手：手数=${wLay}(应 12) 红蓝都下过=${wBothSides ? "是" : "否"}` +
        ` 红=高级/蓝=容易=${wLevels ? "是" : "否"} 每手带搜索统计=${wStats ? "是" : "否"}` +
        `｜翻棋上帝视角：关=${greenOff}px 开=${greenOn}px（残余=底图同色像素，应 <2%）` +
        `｜点击被拒=${wClick ? "是" : "否"}｜退出清定时器=${timerArmed && timerCleared ? "是" : "否"}` +
        `｜云端未配置时优雅暂停并退回引擎=${wCloudFallback ? "是" : "否"}` +
        `｜逐档走一手即停=${wStepPaused ? "是" : "否"}` +
        `｜缺省暗棋=${wDarkDefault ? "是" : "否"}(观者视角=${wGodOff ? "对局" : "上帝"})` +
        `｜循环判和=${wRepeatDraw ? "是" : "否"}(第${wRepSeen}次重复)` +
        `｜规避着法=${wAvoidN}(应>0)` +
        `｜开局框文案装得下=${wDlgFits ? "是" : "否"}(${wDlgRows}行:"${wDlgVals}")` +
        `｜选翻棋=${wFlipShown ? "是" : "否"}${wFlipShown ? "" : `(玩法行只写着"${wWayVal}")`}` +
        `${wFlipRows === 4 ? "·翻棋下仍可选视角" : `·翻棋下只剩${wFlipRows}行`}` +
        `｜学习面板：候选行=${wPanelRows} 标出实际走的那条=${wPanelChosen} 摘要="${wPanelMain.slice(0, 46)}"  ` +
        (okW
          ? "✓ 观战两端都由 AI 驱动、可分别指派引擎/云端、缺省暗棋、重复局面判和、不代人走子"
          : "✗ 观战未达预期");
    }
    out.push(watchLine);
  }

  const pre = document.createElement("pre");
  pre.id = "probeResult";
  pre.textContent = out.join("\n");
  document.body.appendChild(pre);
}

function bootErrors(): void {
  const show = (msg: string) => {
    const el = $("#statusText");
    if (el) {
      el.textContent = "运行错误：" + msg;
      el.dataset.tone = "bad";
    }
  };
  window.addEventListener("error", (e) => show(e.message || String(e.error)));
  window.addEventListener("unhandledrejection", (e) =>
    show(String((e as PromiseRejectionEvent).reason)),
  );
}

async function main(): Promise<void> {
  bootErrors();
  canvas = $("#board");
  ctx = canvas.getContext("2d")!;

  status("正在载入原版素材…");
  A = await loadAssets();

  const style = document.createElement("style");
  style.textContent = skinCss();
  document.head.appendChild(style);

  try {
    // 抽取阶段已把原版 GBK 转成 UTF-8，正常情况直接读；
    // 万一读回来的还是乱码（老版本产物），再用 gbk 兜一次。
    const rel = A.manifest.text?.rulelay?.file ?? "rulelay.txt";
    const res = await fetch(`./assets/${rel}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const utf8 = new TextDecoder("utf-8").decode(buf);
    rulesText = utf8.includes("\uFFFD")
      ? new TextDecoder("gbk").decode(buf)
      : utf8;
  } catch {
    rulesText = "（规则文本载入失败）";
  }

  lay = newLay();
  flip = new FlipGame();
  // 布阵默认态 = 原版实拍 s15_lay：开局**已是一套完整默认布阵**（LAYOUTS[0]／00.lay），
  // 不是空盘 —— 所以这里**不做 `clear()`**，手牌自然为 0、货架也就不显示。
  editor = new LayoutEditor(Side.Red, LAYOUTS[0].cells);
  buildEditOpponent();

  // 原版页面外壳：标题 logo + 两枚浮动图标（☰ / ↻）。
  // logo 素材 `title_2p_s.png`；实拍字形高 88 原图单位，见 ui/shell.ts 的 LOGO_H。
  $<HTMLImageElement>("#titleLogo").src = "./assets/title_2p_s.png";
  buildFloats();
  // 观战控制条（标题栏左侧解说 + 右侧四枚按键），默认隐藏，进观战时才显形。
  buildWatchChrome();
  // 右侧学习面板（"看思路"那块），同样默认隐藏。
  buildWatchStudy();
  // 读回上次指派的两侧执子者（`?wk=` 若有会稍后覆盖它 —— URL 优先级更高）。
  watchLoadKind();
  // 也读回"上次怎么开的"（玩法 + 明暗棋）—— 观战是反复开局的场景，别每次都重挑。
  watchLoadSetup();
  // 启动主菜单（原版开机页面）。`?mode=` 可绕过它直达对局，方便自检与截图比对。
  buildHome();
  installDebugHook();

  // 探测同源中转在不在（`vite` / `vite preview` 有）。只决定「AI 援助」的出网方式，
  // 失败也**不打扰玩家** —— 设置页会如实写出"本轮走中转还是直连"。
  // 为什么默认优先中转：浏览器直连过不了跨域预检，更关键的是**用不了本机代理**
  // （Chrome 只认系统代理），玩家填的地址要靠代理才通时就会一直转然后超时。
  void aidRelayAvailable().then((ok) => {
    aidRelayOn = ok;
    console.info(`[junqi] AI 援助出网方式：${ok ? "同源中转 /__aiaid/relay" : "浏览器直连"}`);
  });

  canvas.addEventListener("click", onClick);
  // 视口一变就重排（观察 documentElement，别观察 #app —— 见 resize() 里的自反馈说明）。
  new ResizeObserver(() => resize()).observe(document.documentElement);
  window.addEventListener("resize", () => resize());

  resize();
  // `paintHomeLabel` 依赖自带字体（ZYKai / MYingHeiGB）已经可用，否则画布会拿
  // 系统回退字体排版、贴出来的字形就不对了。字体是异步加载的，等它就绪后重排一次。
  void document.fonts.ready.then(() => {
    LABEL_CACHE.clear();
    layoutHome();
  });
  const url = new URL(location.href);
  pieceSmooth = url.searchParams.get("smooth") !== "0";
  pieceSnap = url.searchParams.get("snap") === "1";
  // 原版开机停在启动菜单 ⇒ 缺省也是它。四个自检入口各自指定自己的模式，别依赖缺省。
  setMode((url.searchParams.get("mode") as Mode) ?? "home");
  const aiPlies = Number(url.searchParams.get("ai") ?? 0);
  const flipAiPlies = Number(url.searchParams.get("flipai") ?? 0);
  if (flipAiPlies > 0) {
    setMode("flip");
    try {
      runFlipAiSelfCheck(flipAiPlies, Number(url.searchParams.get("lv") ?? DEFAULT_AI_LEVEL));
    } catch (err) {
      const pre = document.createElement("pre");
      pre.id = "probeResult";
      pre.textContent = "flipai 自检失败: " + String(err);
      document.body.appendChild(pre);
    }
  } else if (aiPlies > 0) {
    try {
      setMode("lay"); // 缺省是首页，棋盘不渲染；自检必须先把棋盘摆出来
      await runAiSelfCheck(aiPlies, Number(url.searchParams.get("lv") ?? DEFAULT_AI_LEVEL));
    } catch (err) {
      const pre = document.createElement("pre");
      pre.id = "probeResult";
      pre.textContent = "ai 自检失败: " + String(err);
      document.body.appendChild(pre);
    }
  } else if (url.searchParams.get("animprobe") === "1") {
    try {
      if (mode === "home") setMode("lay");
      await runAnimProbe();
    } catch (err) {
      const pre = document.createElement("pre");
      pre.id = "probeResult";
      pre.textContent = "animprobe 失败: " + String(err);
      document.body.appendChild(pre);
    }
  } else if (url.searchParams.get("watch") === "1") {
    // 观战直通，给自动化验收用：
    //   `?watch=1`            默认「布局·明棋」
    //   `&wmode=flip`         翻棋
    //   `&wlv=4,2`            红/蓝各自的 AI 等级 id（仅对"本地引擎"那一侧生效）
    //   `&wk=cloud,engine`    红/蓝各自的执子者：`cloud`=云端模型 / `engine`=本地引擎
    //   `&wsp=慢`             停顿档位（逐/慢/中/快/极；「逐」= 走一手停一手）
    //   `&wpause=1`           进局即暂停（截图/逐手研究用）
    //   `&wstudy=0`           收起右侧学习面板
    const wm = url.searchParams.get("wmode") === "flip" ? "flip" : "lay";
    const wlv = (url.searchParams.get("wlv") ?? "")
      .split(",")
      .map(Number)
      .filter((x) => Number.isFinite(x) && x >= 1 && x <= 5);
    if (wlv.length === 2) watchLv = [wlv[0], wlv[1]];
    // `&wk=cloud,engine` 指派红/蓝执子者；缺省两边都是本地引擎（"规则 AI 打规则 AI"）。
    const wk = (url.searchParams.get("wk") ?? "").split(",");
    if (wk.length === 2) {
      watchKind = [wk[0] === "cloud" ? "cloud" : "engine", wk[1] === "cloud" ? "cloud" : "engine"];
    }
    if (url.searchParams.get("wshow") === "0") watchReveal = false;
    if (url.searchParams.get("wstudy") === "0") watchStudyOn = false;
    const wsp = WATCH_SPEEDS.findIndex((s) => s.name === url.searchParams.get("wsp"));
    if (wsp >= 0) watchSpeed = wsp;
    enterWatch(wm, true);
    if (url.searchParams.get("wpause") === "1") watchTogglePause(true);
  } else if (url.searchParams.get("probe") === "1") {
    try {
      if (mode === "home") setMode("lay");
      await runProbe();
    } catch (err) {
      const pre = document.createElement("pre");
      pre.id = "probeResult";
      pre.textContent = "probe 失败: " + String(err);
      document.body.appendChild(pre);
    }
  } else if (url.searchParams.get("menu") === "1") {
    // 自检用：直接摊开 ☰ 菜单，方便与实拍 s08.png 逐像素比对。
    if (mode === "home") setMode("lay");
    openMenu();
  }
}

/**
 * **只读状态钩子**（给 `tools/_audit/clickflow.mjs` 这类点击流脚本断言用）。
 *
 * 为什么需要它：对话框里的文字**全是位图**（`paintText` 画进 canvas 再贴
 * `<img class="txt-bmp">`），DOM 里读不到"现在这一行显示的是开还是关"。
 * 于是"点了设置里的『走子动画』到底有没有生效"这类问题，光靠 DOM 快照
 * 会误判成"没反应"。这里把开关原样暴露出来，脚本一读就知道。
 *
 * 只暴露快照，**不提供任何写入口** —— 免得自检脚本绕开真实点击去改状态。
 */
function installDebugHook(): void {
  (window as unknown as Record<string, unknown>).__junqi = {
    state: () => ({
      mode,
      vsAi,
      aiLevelId,
      animEnabled,
      aidHints,
      revealAll: layCfg.revealAll,
      firstMove: layCfg.firstMove,
      turn: mode === "flip" ? flip.turn : lay.turn,
      isDraw: mode === "flip" ? flip.isDraw : lay.isDraw,
      winner: mode === "flip" ? flip.winner : lay.winner,
      // 翻棋同样有悔棋栈（原版也支持），别只报布局那一份。
      canUndo:
        mode === "lay" ? lay.canUndo() : mode === "flip" ? flip.canUndo() : false,
      editRemaining: mode === "edit" ? editor.remaining() : null,
      msgCount: mode === "flip" ? flip.messages.length : lay.messages.length,
      /**
       * 盘面统计（**只读**）。
       *
       * ⚠️ 为什么不能只看 `net.sum`：`stateSum` 刻意**不吃棋子类型**（暗棋里对面
       * 那份类型未必可信），只哈希「格上有没有子 + 归属 + 是否亮明」。所以"两端
       * 校验和相等"**不能**证明棋子一样 —— 两边都是空盘也会相等。这里把棋子数
       * 单独暴露出来，让自检脚本能断言"双方各 25 子确实铺上去了"。
       */
      board: (() => {
        const p = mode === "flip" ? flip.pos : mode === "edit" ? editorPosition() : lay.pos;
        let red = 0;
        let blue = 0;
        let revealed = 0;
        for (let i = 0; i < CELLS; i++) {
          if (p.type[i] !== PieceType.Empty) {
            if (p.owner[i] === Side.Red) red++;
            else if (p.owner[i] === Side.Blue) blue++;
          }
          if (p.revealed[i]) revealed++;
        }
        return { red, blue, revealed };
      })(),
      /**
       * AI 援助快照（复刻版自加功能）。
       *
       * `move` 是最关键的字段：它是**模型挑出来、再由本地规则层落定的那一步**。
       * 光看 toast 只能知道"有个建议"，脚本必须能断言"建议确实被记下来并画到盘上"，
       * 所以这里把 `aidMove` 原样暴露（另一个证据是画布上真的出现了蓝框，见
       * `tools/_audit/_flow18.json` 里对 canvas 纯蓝像素的计数）。
       */
      aid: {
        configured: aidConfigured(),
        busy: aidBusy,
        move: aidMove
          ? { from: aidMove.from, to: aidMove.to, reveal: aidMove.reveal }
          : null,
        /**
         * 出网方式快照（复刻版自加功能）。
         *
         * `relay` = 当前这次请求会走同源中转还是浏览器直连。玩家实报"AI援助超时"
         * 的根因就在这里：浏览器直连**走不了本机代理**，`api.openai.com` 之类地址
         * 只能干等到超时。自检脚本据此断言"中转在的时候确实走了中转"。
         */
        relay: aidRelayOn,
        endpoint: aidEndpoint(lsGet(AID_LS.base)),
        timeoutMs: aidTimeoutMs(),
      },
      /**
       * 联机快照（复刻版自加功能，`tools/_audit/netflow.mjs` 靠它做双端断言）。
       * `sum` 就是协议里那个 FNV 校验和 —— 两端一致 = 局面"可见部分"逐格相同。
       */
      net: {
        status: net ? net.status : "idle",
        seat: netSeat,
        room: netRoom,
        names: [...netNames],
        online: [...netOnline],
        active: netActive,
        isHost: netIsHost(),
        myTurn: netActive ? netMyTurn() : null,
        appliedClicks: netAppliedClicks,
        rtt: net ? net.rtt : -1,
        sum: netActive ? netSum() : null,
      },
      /**
       * AI 观战快照（复刻版自加）。
       *
       * `plies` / `last` 是最关键的两个字段：自检与审计脚本据此断言
       * "观战真的走了这么多手、且每一手都留下了搜索统计"。
       * `god` 就是上帝视角开关 —— 与 `board.revealed`（**规则层**翻开了几张）
       * 刻意分开：观者看得见 ≠ AI 知道（后者才是原版 AI 的真实水平）。
       */
      watch: (() => {
        const last = watchPlies.at(-1);
        return {
          on: watchOn,
          paused: watchPaused,
          god: watchGod,
          speed: watchSpeed,
          speedName: WATCH_SPEEDS[watchSpeed].name,
          lv: [watchLv[0], watchLv[1]] as [number, number],
          /** 两侧执子者：`engine` / `cloud`（可分别指派，见 `watchKind`） */
          kind: [watchKind[0], watchKind[1]] as [WatchAgentKind, WatchAgentKind],
          /** 两侧的人话名号（「困难」/「云端」），断言用 */
          who: [agentLabel(0), agentLabel(1)],
          note: watchNote,
          variant: watchVariant,
          reveal: watchReveal,
          plies: watchPlies.length,
          cloudPlies: watchPlies.filter((p) => p.cloud).length,
          /** 逐手的执子者链（`C`=云端 / `E`=引擎），断言"两边交替都真的下了"用 */
          chain: watchPlies.map((p) => (p.cloud ? "C" : "E")).join(""),
          /** 学习面板开着没（屏幕太窄时会被 `layoutWatchStudy` 自动收起） */
          study: watchStudyOn,
          /** 当前档位是不是"逐手模式"（走一手停一手） */
          step: isWatchStepMode(),
          /** 学习面板上那一手的候选摘要（引擎手才有） */
          brief:
            last?.brief != null
              ? {
                  rank: last.brief.rank,
                  rootRank: last.brief.rootRank,
                  shown: last.brief.options.length,
                  considered: last.brief.considered,
                  total: last.brief.total,
                }
              : null,
          /** 面板 DOM 里实际渲染出来的候选行数 / 有没有标出"实际走的那条" */
          briefRows: document.querySelectorAll("#wsOpts .ws-opt").length,
          briefChosen: document.querySelectorAll("#wsOpts .ws-opt[data-chosen='1']").length,
          /** 面板里被标成"会走回旧局面"的候选行数（循环规避真的生效了没） */
          briefAvoid: document.querySelectorAll("#wsOpts .ws-opt[data-avoid='1']").length,
          /** 重复判和：阈值 / 当前局面出现过几次 / 指纹历史里有几个局面 */
          repeatDraw: mode === "lay" ? lay.repeatDraw : flip.repeatDraw,
          repeats: mode === "lay" || mode === "flip" ? watchRepeatNow() : 1,
          seen: watchSeen.size,
          /** 这一手算出来的"会走回旧局面"的着法数（引擎按它降权） */
          avoid: mode === "lay" || mode === "flip" ? watchAvoid().length : 0,
          /** 已经判和了没 + 判和原因（循环判和就是靠这两个字段断言的） */
          isDraw: mode === "lay" ? lay.isDraw : flip.isDraw,
          drawReason: mode === "lay" ? lay.drawReason : flip.drawReason,
          /** 面板本体那段文字（人类可读的"这一手思路"） */
          briefText: document.getElementById("wsMain")?.textContent ?? "",
          last: last
            ? {
                n: last.n,
                seat: last.seat,
                side: last.side,
                level: last.level,
                flip: last.flip,
                text: last.text,
                cloud: last.cloud,
                why: last.why,
                depth: last.depth,
                nodes: last.nodes,
                ms: Math.round(last.ms),
                score: Math.round(last.score),
                delta: Math.round(last.delta),
              }
            : null,
        };
      })(),
    }),
    /**
     * **只读几何查询**：第 i 格的**客户端坐标**（= 棋盘画布的屏幕位置 + 格心）。
     *
     * 为什么需要：`clickflow.mjs` 派发的是**真实鼠标事件**（`Input.dispatchMouseEvent`），
     * 必须知道点哪儿才落在哪一格。棋盘几何只存在于 `boardart.ts` 的常量里，
     * 脚本外面算不出来（缩放/偏移随视口变），所以把 `cellCenter` + 画布矩形
     * 直接暴露出来。**纯计算，不碰任何状态。**
     */
    cellCenter: (i: number) => {
      const c = cellCenter(view, i);
      const r = canvas.getBoundingClientRect();
      return { x: r.left + c.x, y: r.top + c.y };
    },
    /**
     * **只读查询**：当前局面的「第一手合法着」（布局模式）。
     *
     * 用途同上 —— 让脚本能照着真坐标走一步真棋（从而验证「悔棋」这类
     * 依赖历史栈的按钮确实有东西可悔）。不落子、不改状态。
     */
    firstMove: () => {
      if (mode !== "lay") return null;
      for (let i = 0; i < CELLS; i++) {
        if (lay.pos.type[i] === PieceType.Empty || lay.pos.owner[i] !== lay.turn) continue;
        const tg = legalTargets(lay.pos, i, lay.turn, lay.opts);
        if (tg.length) return { from: i, to: tg[0].to };
      }
      return null;
    },
  };
}

void main();
