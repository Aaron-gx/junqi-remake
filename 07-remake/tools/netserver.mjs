#!/usr/bin/env node
/**
 * 军棋复刻版 · 两人联机中继服务器（**零依赖**，只用 Node 内置模块）。
 *
 * 为什么不装 `ws`：这个仓库的第三方依赖只有 vite / typescript，而且约定
 * 「第三方工具不装 C 盘、能不加依赖就不加」。RFC6455 的服务端只需
 * 握手 + 拆帧 + 装帧三件事，一百多行就够，自己写反而便于部署到任意 VPS。
 *
 * ## 职责（刻意的"哑中继"）
 *
 *   1. 按房间号维护 **两个座位**；`hello` 入座，`token` 相同可夺回原座位（重连）；
 *   2. 把任何非 `hello`/`ping`/`pong` 的消息**原样转给同房间的另一位**（不回显给自己）；
 *   3. 有人掉线时给对面发 `peer{online:false}`，并**保留座位 10 分钟**等重连。
 *
 * 它**完全不懂棋**：不解析 `click`/`setup`，不做校验，不存盘面。
 * 规则同步靠两端各自的确定性重放，见 `src/game/net.ts` 的说明。
 *
 * ## 用法
 *
 *   node tools/netserver.mjs                 # 0.0.0.0:8787
 *   node tools/netserver.mjs 9000            # 换端口
 *   PORT=9000 node tools/netserver.mjs       # 同上
 *
 * 局域网/公网部署后，在游戏首页「联网」里把服务器地址填成
 * `ws://<你的IP>:8787`（有 HTTPS 反代就填 `wss://域名/ws`）。
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";
/** 掉线后座位保留时长 —— 够一次刷新/切网重连。 */
const SEAT_TTL_MS = 10 * 60 * 1000;
const PROTO = 1;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ─────────────────────────────────────────────────────────────
// RFC6455：握手 + 拆帧 + 装帧
// ─────────────────────────────────────────────────────────────

/**
 * 每个连接一个实例：只管字节流 ⇄ 消息，不认识业务。
 * Node 的 socket 是 TCP 流 —— 一次 `data` 可能给半帧，也可能给一帧半，
 * 所以内部必须缓存（`buf`）并循环解析。
 */
class WsConn {
  constructor(socket, id) {
    this.socket = socket;
    this.id = id;
    this.buf = Buffer.alloc(0);
    this.open = true;
    /** 分片消息的累积（FIN=0 的续帧）。 */
    this.fragOp = 0;
    this.frag = [];
    this.onMessage = () => {};
    this.onClose = () => {};
    socket.on("data", (d) => this.onData(d));
    socket.on("close", () => this.die());
    socket.on("error", () => this.die());
  }

  die() {
    if (!this.open) return;
    this.open = false;
    this.onClose(this);
  }

  /** 装帧：服务端 → 客户端**不加掩码**（RFC 规定）。 */
  send(text) {
    if (!this.open) return;
    const payload = Buffer.from(text, "utf8");
    const len = payload.length;
    let head;
    if (len < 126) {
      head = Buffer.alloc(2);
      head[1] = len;
    } else if (len < 65536) {
      head = Buffer.alloc(4);
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    head[0] = 0x81; // FIN + opcode=text
    try {
      this.socket.write(Buffer.concat([head, payload]));
    } catch {
      this.die();
    }
  }

  sendJSON(obj) {
    this.send(JSON.stringify(obj));
  }

  close() {
    if (!this.open) return;
    try {
      this.socket.write(Buffer.from([0x88, 0x00])); // FIN + opcode=close, 空负载
    } catch {
      /* 忽略 */
    }
    this.socket.end();
    this.die();
  }

  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    // 循环解析：直到剩余字节凑不满一帧
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < off + 2) return;
        len = b.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (b.length < off + 8) return;
        const big = b.readBigUInt64BE(off);
        if (big > 1_000_000n) return this.kill("帧过大");
        len = Number(big);
        off += 8;
      }
      const need = off + (masked ? 4 : 0) + len;
      if (b.length < need) return;
      let payload = b.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = b.subarray(off, off + 4);
        payload = Buffer.from(payload); // 别改到原始 buffer
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buf = b.subarray(need);

      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) {
        // ping → pong（原样回负载）
        const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
        try {
          this.socket.write(pong);
        } catch {
          /* 忽略 */
        }
        continue;
      }
      if (opcode === 0xa) continue; // pong，忽略
      if (opcode === 0x0) {
        // 续帧
        this.frag.push(payload);
        if (fin) {
          const all = Buffer.concat(this.frag);
          this.frag = [];
          if (this.fragOp === 0x1) this.onMessage(all.toString("utf8"));
        }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) {
          this.fragOp = opcode;
          this.frag = [payload];
          continue;
        }
        if (opcode === 0x1) this.onMessage(payload.toString("utf8"));
        continue;
      }
      // 其它 opcode 一律无视（保持连接）
    }
  }

  kill(reason) {
    this.sendJSON({ t: "err", msg: reason });
    this.close();
  }
}

const sha1 = (s) => createHash("sha1").update(s).digest("base64");

// ─────────────────────────────────────────────────────────────
// 房间与座位
// ─────────────────────────────────────────────────────────────

/**
 * `rooms: Map<roomId, Room>`，`Room = { seats: [Seat|null, Seat|null], createdAt }`
 * `Seat = { name, token, conn: WsConn|null, lastSeen }`
 */
const rooms = new Map();
const MAX_ROOMS = 500;

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    if (rooms.size >= MAX_ROOMS) return null;
    r = { seats: [null, null], createdAt: Date.now() };
    rooms.set(id, r);
  }
  return r;
}

function onlineCount(r) {
  return r.seats.filter((s) => s && s.conn && s.conn.open).length;
}

function peerSeatOf(r, seat) {
  return r.seats[seat === 0 ? 1 : 0];
}

/** 把一条消息转给同房间的另一位（不回显）。 */
function relayTo(roomId, fromSeat, obj) {
  const r = rooms.get(roomId);
  if (!r) return;
  const p = peerSeatOf(r, fromSeat);
  if (p && p.conn && p.conn.open) p.conn.sendJSON(obj);
}

/** 通知对方"这一座的人上线/掉线了"。 */
function announcePeer(roomId, seat) {
  const r = rooms.get(roomId);
  if (!r) return;
  const me = r.seats[seat];
  relayTo(roomId, seat, {
    t: "peer",
    seat,
    name: me ? me.name : "",
    online: !!(me && me.conn && me.conn.open),
  });
}

function seatClient(conn, { room, name, token }) {
  // 没给房间号 = 开新房
  let id = String(room || "").toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 8);
  let created = false;
  if (!id) {
    do {
      id = Array.from({ length: 4 }, () =>
        "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 32)],
      ).join("");
    } while (rooms.has(id));
    created = true;
  }
  const r = getRoom(id);
  if (!r) return conn.kill("服务器房间已满，请稍后再试");

  // 1) 同 token 的老座位 → 重连认领
  let seat = r.seats.findIndex((s) => s && s.token && s.token === token);
  if (seat < 0) {
    // 2) 空座；优先"掉线很久"的座（超过 TTL 直接顶掉）
    seat = r.seats.findIndex((s) => !s);
    if (seat < 0) {
      seat = r.seats.findIndex(
        (s) => s && !s.conn && Date.now() - s.lastSeen > SEAT_TTL_MS,
      );
    }
    if (seat < 0) {
      seat = r.seats.findIndex((s) => s && !s.conn);
      if (seat < 0) return conn.kill("房间已满（两人）");
    }
  }

  const prev = r.seats[seat];
  if (prev && prev.conn && prev.conn.open && prev.conn !== conn) prev.conn.close();
  const s = {
    name: String(name || "玩家").slice(0, 12) || "玩家",
    token: String(token || "").slice(0, 40),
    conn,
    lastSeen: Date.now(),
  };
  r.seats[seat] = s;

  conn.roomId = id;
  conn.seat = seat;
  conn.sendJSON({
    t: "joined",
    seat,
    room: id,
    names: [r.seats[0] ? r.seats[0].name : "", r.seats[1] ? r.seats[1].name : ""],
  });
  announcePeer(id, seat);
  // 对方也补发一次"我在线"，让新来的一眼看到对手昵称
  const other = seat === 0 ? 1 : 0;
  if (r.seats[other]) {
    conn.sendJSON({
      t: "peer",
      seat: other,
      name: r.seats[other].name,
      online: !!(r.seats[other].conn && r.seats[other].conn.open),
    });
  }
  log(
    `入座 房间=${id} 座位=${seat} 昵称=${s.name} ${created ? "(新建)" : ""} 在线=${onlineCount(r)}/2`,
  );
}

function handleText(conn, text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return;
  }
  if (!m || typeof m !== "object" || typeof m.t !== "string") return;
  if (m.t === "hello") {
    if (Number(m.proto) !== PROTO) {
      return conn.kill(`协议版本不一致（服务器 v${PROTO}，你 v${Number(m.proto)}）`);
    }
    return seatClient(conn, m);
  }
  if (!conn.roomId) return conn.kill("还没入座");
  const r = rooms.get(conn.roomId);
  if (r && r.seats[conn.seat]) r.seats[conn.seat].lastSeen = Date.now();
  // 心跳由两端自己处理（服务器只做转发），其余一律原样转给对面
  if (m.t === "ping" || m.t === "pong") return;
  relayTo(conn.roomId, conn.seat, m);
}

function log(...a) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}]`, ...a);
}

// ─────────────────────────────────────────────────────────────
// HTTP + Upgrade
// ─────────────────────────────────────────────────────────────

let seq = 0;
const http = createServer((req, res) => {
  // 给个健康检查页，方便确认"服务器起来没有"、以及排查反代是否把 Upgrade 吃掉了
  if (req.url === "/healthz" || req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      `junqi net server v${PROTO}\r\nrooms=${rooms.size} online=${[...rooms.values()].reduce((n, r) => n + onlineCount(r), 0)}\r\n`,
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

http.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  socket.setNoDelay(true);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${sha1(key + GUID)}\r\n\r\n`,
  );
  const conn = new WsConn(socket, ++seq);
  conn.onMessage = (t) => handleText(conn, t);
  conn.onClose = () => {
    const id = conn.roomId;
    if (id === undefined) return;
    const r = rooms.get(id);
    if (!r) return;
    const s = r.seats[conn.seat];
    if (s && s.conn === conn) {
      s.conn = null;
      s.lastSeen = Date.now();
      announcePeer(id, conn.seat);
      log(`掉线 房间=${id} 座位=${conn.seat} 在线=${onlineCount(r)}/2`);
    }
    // 两人都走光且座位过期 → 回收房间
    if (!r.seats.some((x) => x && x.conn)) {
      const stale = r.seats.every((x) => !x || Date.now() - x.lastSeen > SEAT_TTL_MS);
      if (stale || r.seats.every((x) => !x)) {
        rooms.delete(id);
        log(`回收 房间=${id}`);
      }
    }
  };
});

// 定期回收空房间
setInterval(() => {
  for (const [id, r] of rooms) {
    if (r.seats.every((s) => !s)) rooms.delete(id);
  }
}, 60_000).unref?.();

http.listen(PORT, HOST, () => {
  log(`军棋联机服务器 v${PROTO} 已启动`);
  log(`  监听  ws://${HOST}:${PORT}/`);
  log(`  健康检查 http://127.0.0.1:${PORT}/healthz`);
  log(`  游戏首页「联网」里的服务器地址填 ws://<本机局域网IP>:${PORT}`);
});
