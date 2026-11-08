/**
 * 两人网络联机 —— **传输层 + 协议**（不含任何 UI）。
 *
 * ## 设计：确定性重放，而不是"同步盘面"
 *
 * 军棋的规则引擎（`core/rules.ts`）是**纯确定性的**：给定同一份初始局面，
 * 同一串点击序列必然得到同一串局面 —— 没有随机数、没有时间依赖。
 * 所以联机**不需要**来回同步 60 格的盘面快照，只需要两件事：
 *
 *   1. 房主把**开局种子**发过去（布局对战 = 双方 25 格布局 + 明暗棋 + 先后手；
 *      翻棋 = 一个发牌种子 `seed`），两边各自本地建局 ⇒ 初始局面逐格相同；
 *   2. 之后每一下**点击**原样转发（一次只发一个格号），两边各自本地 `click()`
 *      ⇒ 局面自然保持同步。
 *
 * 这样做的好处：协议里没有"权威盘面"，也就没有"谁的盘面是对的"这种争执；
 * 悔棋 / 认输 / 重连都退化成同一条广播路径。`sum`（FNV 校验和）只用来**发现**
 * 不同步，真发现不一致时由房主发 `replay`（开局 + 全部点击）把对方拉回来。
 *
 * ## 房间与座位
 *
 * 服务器是**哑中继**：只按房间号维护两个座位、把一条消息原样转给对面，
 * 不解析任何棋类语义。座位 0 = 房主（创建者），1 = 加入者。
 * `token`（每台浏览器随机生成后存 sessionStorage）用于**断线重连认领原座位**。
 */

import type { Side } from "../core/pieces.ts";

/** 协议版本，两端不一致时服务器会拒绝入座 —— 免得旧页面接上新服务器后行为诡异。 */
export const NET_PROTO = 1;

/** 联机开局参数 —— 足够两边各自建出**逐格相同**的初始局面。 */
export interface NetSetup {
  readonly mode: "lay" | "flip";
  /** 布局对战专用：明棋 `true` / 暗棋 `false`。 */
  readonly revealAll: boolean;
  /** 布局对战专用：先手方（决定 seats→side 的映射）。 */
  readonly firstMove: Side;
  /** 布局对战：红方 25 格布局（格号→PieceType）。 */
  readonly redLayout?: readonly number[];
  /** 布局对战：蓝方 25 格布局。 */
  readonly blueLayout?: readonly number[];
  /** 翻棋：发牌种子（同一 seed ⇒ 同一副牌）。 */
  readonly seed?: number;
}

/** 线上的消息。全部是 JSON，字段名刻意短，便于抓包调试。 */
export type NetMsg =
  /** 入座：`room` 为空则自动开新房；`token` 相同可夺回原座位（重连）。 */
  | { t: "hello"; room: string; name: string; token: string; proto: number }
  /** 服务器回执：我在几号座、房里都有谁。 */
  | { t: "joined"; seat: 0 | 1; room: string; names: [string, string] }
  /** 有人的掉线/上线状态变了（含自己以外的座位）。 */
  | { t: "peer"; seat: 0 | 1; name: string; online: boolean }
  /** 服务器或对端的错误提示。 */
  | { t: "err"; msg: string }
  /** 房主改大厅设置（玩法 / 明暗棋 / 先后手）后广播。 */
  | { t: "cfg"; mode: "lay" | "flip"; revealAll: boolean; firstMove: Side }
  /** 加入者报到：附上自己那半盘 25 格布局（翻棋不需要）。 */
  | { t: "ready"; layout?: readonly number[] }
  /** 房主下发开局参数。 */
  | { t: "setup"; s: NetSetup }
  /** 提议和棋（两边都发过 ⇒ 判和）。 */
  | { t: "draw" }
  /** 请求房主重发 `replay`（发现校验和不一致时用）。 */
  | { t: "sync" }
  /** 一次点击（格号）。落子 = 两次点击；翻子 = 一次。 */
  | { t: "click"; cell: number }
  /** 悔棋一步（两边各自 `undo()`，历史相同 ⇒ 结果相同）。 */
  | { t: "undo" }
  /** 认输：`seat` 认输，对方胜。 */
  | { t: "resign"; seat: 0 | 1 }
  /** 快捷消息。 */
  | { t: "chat"; text: string }
  /** 局面校验和（只用于发现不同步）。 */
  | { t: "sum"; h: number }
  /**
   * 房主强制对齐：开局参数 + **完整局面**。
   * 正常情况永远用不到（两端是确定性重放）；只在 `sum` 校验和打架时兜底 ——
   * 因为悔棋后"点击序列"已无法准确重建，直接灌一份权威局面最省事也最可靠。
   */
  | { t: "replay"; s: NetSetup; state: NetState }
  /** 心跳。 */
  | { t: "ping" }
  | { t: "pong" };

/** 一份"完整局面"—— 只在 `replay` 兜底里用到，不是常规同步手段。 */
export interface NetState {
  readonly type: number[];
  readonly owner: number[];
  readonly revealed: number[];
  /** lay：`Side`；flip：座位号 0/1。 */
  readonly turn: number;
  readonly lastMove: { from: number; to: number } | null;
  /** lay：`Side`；flip：座位号。 */
  readonly winner: number | null;
  readonly isDraw: boolean;
  readonly revealAll: boolean;
  readonly msgs?: readonly { text: string; tone: string }[];
}

/** 连接状态机。 */
export type NetStatus = "idle" | "connecting" | "open" | "closed";

export interface NetHandlers {
  onMsg?: (m: NetMsg) => void;
  onStatus?: (s: NetStatus, detail?: string) => void;
}

/**
 * 极简 WebSocket 客户端：连上、按 `hello` 入座、收发 `NetMsg`。
 *
 * 自动重连：意外断开后按 0.5s→1s→2s→4s（上限 5s）退避重连，
 * 重连成功后**自动重发同一条 `hello`**（带同一 token）⇒ 服务器把原座位还给你，
 * 对局可以接着下（局面靠 `replay`/`sum` 拉平）。
 */
export class NetClient {
  private ws: WebSocket | null = null;
  private url = "";
  private hello: NetMsg | null = null;
  private retry = 0;
  private timer = 0;
  private closedByUs = false;
  private pingTimer = 0;
  private pingSentAt = 0;
  /** 往返时延（ms），-1 = 还没测到。 */
  rtt = -1;
  status: NetStatus = "idle";
  private readonly h: NetHandlers;

  constructor(h: NetHandlers = {}) {
    this.h = h;
  }

  private setStatus(s: NetStatus, detail?: string): void {
    this.status = s;
    this.h.onStatus?.(s, detail);
  }

  /** 连接并立刻入座。`room` 传空串 = 让服务器分配一个新房间号。 */
  connect(url: string, hello: Omit<Extract<NetMsg, { t: "hello" }>, "t" | "proto">): void {
    this.close();
    this.closedByUs = false;
    this.url = url;
    this.hello = { t: "hello", proto: NET_PROTO, ...hello };
    this.retry = 0;
    this.open();
  }

  private open(): void {
    if (!this.url) return;
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.setStatus("closed", `地址无效：${String(e)}`);
      return;
    }
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.retry = 0;
      this.setStatus("open");
      if (this.hello) ws.send(JSON.stringify(this.hello));
      // 心跳：25s 一次。原版是 TCP 长连，网页环境中间常有代理会掐空闲连接。
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.pingSentAt = performance.now();
          this.ws.send(JSON.stringify({ t: "ping" } satisfies NetMsg));
        }
      }, 25000);
    });
    ws.addEventListener("message", (ev) => {
      let m: NetMsg;
      try {
        m = JSON.parse(String(ev.data)) as NetMsg;
      } catch {
        return;
      }
      if (m.t === "pong") {
        if (this.pingSentAt) this.rtt = Math.round(performance.now() - this.pingSentAt);
        return;
      }
      if (m.t === "ping") {
        ws.send(JSON.stringify({ t: "pong" } satisfies NetMsg));
        return;
      }
      this.h.onMsg?.(m);
    });
    ws.addEventListener("close", (ev) => {
      window.clearInterval(this.pingTimer);
      this.ws = null;
      if (this.closedByUs) {
        this.setStatus("closed", "已断开");
        return;
      }
      const code = ev.code === 1006 ? "连接中断" : `连接关闭(${ev.code})`;
      this.setStatus("closed", code);
      this.scheduleRetry();
    });
    ws.addEventListener("error", () => {
      // `error` 之后一定跟一个 `close`，重连逻辑放在 close 里，避免重复排程。
    });
  }

  private scheduleRetry(): void {
    if (this.closedByUs || !this.url) return;
    const delay = Math.min(5000, 500 * 2 ** this.retry++);
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      if (this.status === "closed") this.open();
    }, delay);
  }

  send(m: NetMsg): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(m));
    return true;
  }

  /** 主动断开（不再自动重连）。 */
  close(): void {
    this.closedByUs = true;
    window.clearTimeout(this.timer);
    window.clearInterval(this.pingTimer);
    try {
      this.ws?.close();
    } catch {
      /* 已经关了 */
    }
    this.ws = null;
    this.setStatus("closed", "已断开");
  }
}

/** 每台浏览器的稳定身份，用于断线后夺回原座位（`sessionStorage` 存活期 = 标签页）。 */
export function netToken(): string {
  const KEY = "junqi.net.token";
  let v = "";
  try {
    v = sessionStorage.getItem(KEY) ?? "";
    if (!v) {
      v = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      sessionStorage.setItem(KEY, v);
    }
  } catch {
    v = Math.random().toString(36).slice(2, 10);
  }
  return v;
}

/**
 * 局面校验和（FNV-1a 32 位）。
 *
 * 故意**只吃**"双方都看得见的东西"：格上有没有子、归属、是否亮明、轮到谁。
 * 不吃棋子类型 —— 暗棋里收到的那份可能是**对方的**盘面（类型未必可信），
 * 用类型算和会误报。这里要的是"廉价地发现两边跑飞了"，不是密码学校验。
 */
export function stateSum(
  type: ArrayLike<number>,
  owner: ArrayLike<number>,
  revealed: ArrayLike<number>,
  turn: number,
): number {
  let h = 2166136261;
  const mix = (v: number): void => {
    h ^= v & 0xff;
    h = Math.imul(h, 16777619);
  };
  for (let i = 0; i < type.length; i++) {
    mix(type[i] === 0 ? 0 : 1);
    mix(owner[i]);
    mix(revealed[i]);
  }
  mix(turn);
  return h >>> 0;
}

/** 生成一个 4 位房间号（避开容易念错的 0/O、1/I）。 */
export function randomRoom(): string {
  const A = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}
