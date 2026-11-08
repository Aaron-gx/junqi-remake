/**
 * 中转（`server/aidrelay.ts`）的**真实 socket** 回归测试。
 *
 * 运行：`node --experimental-transform-types tools/relay/relayretry.ts`
 * （已挂在 `npm test` 后面，跟单测一起跑）
 *
 * ## 为什么不用假 fetch
 *
 * `tests/run.ts` 里那一节验的是**页面侧**的行为（头对不对、文案分不分得开），
 * 用的是假 `fetch`。可这次要修的东西全在**真连接**上：
 *
 *   · 上游把连接掐了（`read ECONNRESET`）→ 换新连接重试；
 *   · Node 19 起默认的 keep-alive 连接池 → 半开 socket 复用；
 *   · 隧道（CONNECT）那条路的 socket 是外部塞进来的 → 别被 `agent: false` 顶掉；
 *   · 页面断开 → 在途的上游请求要被掐掉、且不许重试。
 *
 * 假 fetch 一个也验不到。所以这里起**真的** HTTP 服务：桩上游会真的发 RST
 * （`socket.resetAndDestroy()`，不是"优雅关闭"——优雅关闭测不出 ECONNRESET）。
 *
 * ## 断言里最要紧的两条
 *
 * 1. **首次 RST、第二次成功 ⇒ 返回 200 且 `x-aiaid-attempts: 2`**。
 *    这条直接对应玩家那一句「中转失败：read ECONNRESET」不再发生。
 * 2. **连打两发，上游看到的远端端口不同** —— 连接没被复用。
 *    这是 keep-alive 那个坑的硬证据（复用与否在服务端一眼可见）。
 */

import { createServer as createHttpServer, request as httpRequest, type ClientRequest } from "node:http";
import { createServer as createNetServer, connect as netConnect, type Socket } from "node:net";
import {
  createAidRelayMiddleware,
  setLocalProxyCandidates,
  RELAY_PATH,
  DIAG_PATH,
  RELAY_MAX_ATTEMPTS,
} from "../../server/aidrelay.ts";
import { isTransientNetError } from "../../src/game/neterr.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(name: string, got: unknown, want: unknown): void {
  check(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── 桩上游 ────────────────────────────────────────────────────────────
type Mode = "ok" | "reset-once" | "reset-always" | "unauthorized" | "badgateway" | "hang";

interface Upstream {
  port: number;
  state: { hits: number; ports: number[]; sockets: Set<Socket>; everClosed: boolean };
  close(): Promise<void>;
}

async function startUpstream(mode: Mode): Promise<Upstream> {
  const state = { hits: 0, ports: [] as number[], sockets: new Set<Socket>(), everClosed: false };
  const srv = createHttpServer((req, res) => {
    state.hits++;
    const sock = req.socket;
    state.ports.push(sock.remotePort ?? -1);
    state.sockets.add(sock);
    sock.once("close", () => state.sockets.delete(sock));
    if (mode === "hang") return; // 不回 —— 留给"页面断开"那条用
    if (mode === "reset-once" && state.hits === 1) {
      sock.resetAndDestroy(); // ★ 真 RST：客户端会读到 read ECONNRESET
      return;
    }
    if (mode === "reset-always") {
      sock.resetAndDestroy();
      return;
    }
    if (mode === "unauthorized") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Authentication Fails" } }));
      return;
    }
    if (mode === "badgateway") {
      res.writeHead(502, { "content-type": "application/json" });
      res.end("bad gateway");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"n":0}' } }] }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  return {
    port,
    state,
    close: () =>
      new Promise<void>((r) => {
        for (const s of state.sockets) s.destroy();
        srv.close(() => r());
      }),
  };
}

// ── 中转宿主（真中间件，挂在裸 http 服务上 —— 不需要 vite） ────────────
interface Relay {
  port: number;
  close(): Promise<void>;
}

async function startRelay(): Promise<Relay> {
  const mw = createAidRelayMiddleware();
  const srv = createHttpServer((req, res) => {
    if (!mw) return;
    (mw as unknown as (a: unknown, b: unknown, c: () => void) => void)(req, res, () => {
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

/** 拿一个"此刻肯定没人监听"的端口（起一个临时服务拿到号，立刻关掉）。 */
async function deadPort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

interface RelayReply {
  status: number;
  body: string;
  attempts: string | null;
  /** 中转实际借用的本机代理（`x-aiaid-proxy-used`），没借就是 null。 */
  proxyUsed: string | null;
  ms: number;
}

function callRelay(
  relayPort: number,
  o: { url: string; key?: string; timeout?: number; proxy?: string; abortAfterMs?: number },
): Promise<RelayReply> & { abort: () => void } {
  const body = JSON.stringify({ model: "m", messages: [] });
  const t0 = Date.now();
  let req: ClientRequest | null = null;
  const p = new Promise<RelayReply>((resolve) => {
    req = httpRequest({
      host: "127.0.0.1",
      port: relayPort,
      path: RELAY_PATH,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        "x-aiaid-url": o.url,
        "x-aiaid-timeout": String(o.timeout ?? 8000),
        ...(o.key !== undefined ? { "x-aiaid-key": o.key } : {}),
        ...(o.proxy ? { "x-aiaid-proxy": o.proxy } : {}),
      },
    });
    req.on("response", (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: s,
          attempts: (res.headers["x-aiaid-attempts"] as string | undefined) ?? null,
          proxyUsed: (res.headers["x-aiaid-proxy-used"] as string | undefined) ?? null,
          ms: Date.now() - t0,
        }),
      );
    });
    req.on("error", () =>
      resolve({ status: -1, body: "client-aborted", attempts: null, proxyUsed: null, ms: Date.now() - t0 }),
    );
    req.end(body);
    if (o.abortAfterMs) {
      const t = setTimeout(() => req?.destroy(), o.abortAfterMs);
      t.unref?.();
    }
  });
  return Object.assign(p, { abort: () => req?.destroy() });
}

/** 裸 POST（用来验参数守卫那几条：缺头 / 非法 URL / 协议不对）。 */
function rawPost(
  relayPort: number,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: relayPort,
        path: RELAY_PATH,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          ...headers,
        },
      },
      (res) => {
        let s = "";
        res.on("data", (c) => (s += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: s }));
      },
    );
    req.on("error", () => resolve({ status: -1, body: "error" }));
    req.end(body);
  });
}

// ── 主流程 ────────────────────────────────────────────────────────────
void (async () => {
  // ★ 先关掉"自动借本机代理"（⑫ 会临时打开）。
  //   否则"开发机上恰好开着 Clash"会让①②⑤这些用例的命中次数与路径随环境漂移 ——
  //   测试必须自己完全掌握环境，不能靠"我这儿没开代理"。
  setLocalProxyCandidates([]);
  const relay = await startRelay();

  console.log("\n① 首次连接被上游 RST，第二次成功 —— 观战那一手不该因此停掉");
  {
    const up = await startUpstream("reset-once");
    const r = await callRelay(relay.port, {
      url: `http://127.0.0.1:${up.port}/v1/chat/completions`,
      key: "sk-x",
    });
    eq("重试后拿到 200", r.status, 200);
    eq("如实报出打了几次（x-aiaid-attempts）", r.attempts, "2");
    eq("上游确实被打了两次", up.state.hits, 2);
    await up.close();
  }

  console.log("\n② 一直 RST —— 探到上限就停，并把话说明白");
  {
    const up = await startUpstream("reset-always");
    const r = await callRelay(relay.port, {
      url: `http://127.0.0.1:${up.port}/v1/chat/completions`,
      key: "sk-x",
    });
    eq("回 502（中转自己的失败）", r.status, 502);
    const j = JSON.parse(r.body) as { error?: string };
    check(
      "文案点明是「连不上上游」且带上重试次数",
      Boolean(j.error?.includes("连不上上游") && j.error.includes(`已重试 ${RELAY_MAX_ATTEMPTS} 次`)),
      j.error ?? r.body,
    );
    eq("尝试次数 = 上限", up.state.hits, RELAY_MAX_ATTEMPTS);
    // ★ 失败响应也必须带上次数 —— 否则页面不知道中转已经重试过，会再叠一层。
    //   （2026-09-15 就是漏了这个头，导致 `CLOUD_TRY_ROUNDS=1` 都测不出区别。）
    eq("失败响应也报尝试次数", r.attempts, String(RELAY_MAX_ATTEMPTS));
    await up.close();
  }

  console.log("\n③ 上游 401（Key 错）—— 一次都不许重试，且原样透传");
  {
    const up = await startUpstream("unauthorized");
    const r = await callRelay(relay.port, {
      url: `http://127.0.0.1:${up.port}/v1/chat/completions`,
      key: "sk-bad",
    });
    eq("原样回 401（不是 502）", r.status, 401);
    eq("只打了一次", up.state.hits, 1);
    await up.close();
  }

  console.log("\n④ 上游 502（网关过载）—— 原样透传，重试交给页面侧");
  {
    // 这一条特意**不**在中转里重试：上游能回话 ≠ 连接坏了，中转的职责边界是
    // "连接层"。网关 5xx 由 `postChat`（`isTransientNetError` 认 5xx）再打一次 ——
    // 于是失败链最多 3（中转）× 2（页面）= 6，而不是 9，也不会两边各退一步互相抵消。
    const up = await startUpstream("badgateway");
    const r = await callRelay(relay.port, {
      url: `http://127.0.0.1:${up.port}/v1/chat/completions`,
    });
    eq("如实回 502", r.status, 502);
    eq("中转只打了一次", up.state.hits, 1);
    check(
      "body 是上游原文（透传，没被中转换成 {error}）",
      r.body === "bad gateway",
      JSON.stringify(r.body),
    );
    await up.close();
  }

  console.log("\n⑤ 连接不复用 —— 连着两发在不同的上游端口落地");
  {
    const up = await startUpstream("ok");
    await callRelay(relay.port, { url: `http://127.0.0.1:${up.port}/v1/chat/completions` });
    await sleep(150);
    await callRelay(relay.port, { url: `http://127.0.0.1:${up.port}/v1/chat/completions` });
    eq("上游收到两发", up.state.hits, 2);
    check(
      "两发来自两条不同的连接（没有走 keep-alive 池子）",
      up.state.ports.length === 2 && up.state.ports[0] !== up.state.ports[1],
      JSON.stringify(up.state.ports),
    );
    await up.close();
  }

  console.log("\n⑥ 页面断开 —— 在途的上游请求被掐掉，且不再重试");
  {
    const up = await startUpstream("hang");
    const p = callRelay(relay.port, {
      url: `http://127.0.0.1:${up.port}/v1/chat/completions`,
      abortAfterMs: 400,
    });
    await p; // 客户端自己断了 ⇒ 这里拿到 status -1
    await sleep(1200);
    eq("上游只被打了一次（断开后没有重试）", up.state.hits, 1);
    eq("上游那条连接已经被掐掉", up.state.sockets.size, 0);
    await up.close();
  }

  console.log("\n⑦ 隧道（上游代理）那条路没被改坏");
  {
    // 本地 CONNECT 代理桩：只负责记录"收到了 CONNECT"，然后照实建隧道。
    const connects: string[] = [];
    let refuse = false;
    const proxy = createNetServer((sock) => {
      let buf = "";
      const onData = (c: Buffer): void => {
        buf += c.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        sock.removeListener("data", onData);
        const line = buf.split("\r\n")[0] ?? "";
        connects.push(line);
        if (refuse) {
          sock.end("HTTP/1.1 403 Forbidden\r\n\r\n");
          return;
        }
        const m = /^CONNECT ([^:]+):(\d+)/.exec(line);
        if (!m) {
          sock.end("HTTP/1.1 400 Bad Request\r\n\r\n");
          return;
        }
        sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        // 目标是故意不存在的域名：隧道建到一半就会失败，这没关系 ——
        // 我们要证的只是"请求走了隧道"，不是"隧道能通"。
        const upstream = netConnect(Number(m[2]), String(m[1]));
        upstream.on("connect", () => {
          sock.pipe(upstream);
          upstream.pipe(sock);
        });
        upstream.on("error", () => sock.destroy());
      };
      sock.on("data", onData);
      sock.on("error", () => {
        /* 对端断开很正常 */
      });
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const proxyPort = (proxy.address() as { port: number }).port;

    {
      const r = await callRelay(relay.port, {
        url: "https://api.example.test/v1/chat/completions",
        proxy: `http://127.0.0.1:${proxyPort}`,
        timeout: 4000,
      });
      // 隧道那头连不上 → 502；关键是**代理收到了 CONNECT**，说明没绕过代理直连。
      check("https + 代理 ⇒ 真的走了 CONNECT 隧道", connects.length >= 1, JSON.stringify(connects));
      check(
        "隧道指向目标主机的 443",
        (connects[0] ?? "").startsWith("CONNECT api.example.test:443"),
        connects[0] ?? "（无）",
      );
      check("隧道不通时报 502", r.status === 502, `status=${r.status} body=${r.body.slice(0, 80)}`);
    }

    console.log("\n⑧ 代理明确拒绝转发 —— 这是配置问题，不重试");
    {
      refuse = true;
      connects.length = 0;
      const r = await callRelay(relay.port, {
        url: "https://api.example.test/v1/chat/completions",
        proxy: `http://127.0.0.1:${proxyPort}`,
        timeout: 4000,
      });
      const j = JSON.parse(r.body) as { error?: string };
      check(
        "文案点明「上游代理拒绝转发」",
        Boolean(j.error?.includes("上游代理拒绝转发")),
        j.error ?? r.body,
      );
      eq("只试了一次（拒绝 ≠ 抖动）", connects.length, 1);
      check("不带重试备注", !(j.error ?? "").includes("已重试"), j.error ?? "");
    }

    await new Promise<void>((r) => proxy.close(() => r()));
  }

  console.log("\n⑨ 杂项守卫");
  {
    const up = await startUpstream("ok");
    const bad1 = await rawPost(relay.port, {}, JSON.stringify({}));
    eq("缺 x-aiaid-url → 400", bad1.status, 400);
    const bad2 = await rawPost(relay.port, { "x-aiaid-url": "http://" }, JSON.stringify({}));
    eq("非法 URL → 400", bad2.status, 400);
    const bad3 = await rawPost(
      relay.port,
      { "x-aiaid-url": "ftp://a/b" },
      JSON.stringify({}),
    );
    eq("不支持的协议 → 400", bad3.status, 400);
    const ping = await fetch(`http://127.0.0.1:${relay.port}/__aiaid/ping`).then((r) => r.json());
    eq("ping 认得本工程标识", (ping as { relay?: string }).relay, "junqi-aid");
    await up.close();
  }

  console.log("\n⑪ 连不上要**立刻**说「连不上」，不能伪装成「上游很慢」");
  {
    // 起一个"只 accept、一句话不说"的裸 TCP 服务：TCP 连得上，但 TLS 永远握不完。
    // 这正是最难分辨的一种病 —— 没有连接阶段这根秒表，它会被算进"等上游回话"，
    // 最后报成「上游 60 秒没有响应」，玩家以为是模型太慢（2026-09-15 玩家就是这么被带偏的）。
    // ⚠️ 必须记下 socket 再手动 destroy：在 TLS 握手中间被客户端 destroy 的连接，
    //    服务端这边可能一直挂着，`close()` 的回调就永远不来 —— 整个测试进程会卡死在这里
    //    （第一次跑就是这么卡住的，表现是"⑪ 打完 ✓ 就没下文了"）。
    const muteSockets = new Set<Socket>();
    const mute = createNetServer((sock) => {
      muteSockets.add(sock);
      sock.once("close", () => muteSockets.delete(sock));
      /* 收下连接，什么都不回 */
    });
    await new Promise<void>((r) => mute.listen(0, "127.0.0.1", r));
    const mutePort = (mute.address() as { port: number }).port;

    process.env.AID_CONNECT_TIMEOUT_MS = "300";
    try {
      const t0 = Date.now();
      const r = await callRelay(relay.port, {
        url: `https://127.0.0.1:${mutePort}/v1/chat/completions`,
        timeout: 8000,
      });
      const wall = Date.now() - t0;
      eq("握手卡住 ⇒ 502（不是 200，也没有等到 8 秒上游超时）", r.status, 502);
      const j = JSON.parse(r.body) as { error?: string };
      check(
        "文案点名「连不上谁」且说明是连接超时",
        Boolean(j.error?.includes("连不上 127.0.0.1") && j.error.includes("连接超时")),
        j.error ?? r.body,
      );
      check("连接阶段就定论（远快于上游超时预算）", wall < 3000, `${wall}ms`);
      // 连接超时说明"这条路由不通"，不是"等一等就好" ⇒ 不该在同一层反复撞。
      check("连接超时不算瞬态（重试也只是再等一遍）", !isTransientNetError(j.error ?? ""));
    } finally {
      delete process.env.AID_CONNECT_TIMEOUT_MS;
      for (const s of muteSockets) s.destroy();
      await new Promise<void>((r) => mute.close(() => r()));
    }
  }

  console.log("\n⑫ 直连不通 → 自动借本机代理（玩家通常不知道还得填代理）");
  {
    // 桩"正向 HTTP 代理"：收到**绝对 URI** 的请求就直接作答（不转发）。
    let sawUri = "";
    let proxyHits = 0;
    const stubProxy = createHttpServer((req, res) => {
      proxyHits++;
      sawUri = req.url ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"n":0}' } }] }));
    });
    await new Promise<void>((r) => stubProxy.listen(0, "127.0.0.1", r));
    const proxyPort = (stubProxy.address() as { port: number }).port;
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

    setLocalProxyCandidates([proxyUrl]);
    try {
      // 目标域名解析不了 —— 等价于"这个接口地址在当前网络下直连不通"。
      const r = await callRelay(relay.port, {
        url: "http://blocked.example.invalid/v1/chat/completions",
        key: "sk-x",
      });
      eq("借到代理后拿到 200", r.status, 200);
      eq("如实告诉页面借了哪个代理", r.proxyUsed, proxyUrl);
      check(
        "请求确实是以绝对 URI 发给代理的（没绕过代理）",
        sawUri.startsWith("http://blocked.example.invalid/"),
        sawUri,
      );
      eq("两发（直连失败 + 经代理成功）", r.attempts, "2");

    // 本机地址连不上 ≠ "被墙"，而是"那个服务没在跑" ⇒ **不许借代理**。
    // 借了也绕不到本机端口，还会把明确的 ECONNREFUSED 糊成代理的一句 502 ——
    // 等于把最清晰的诊断信息丢掉。顺带：端到端审计的桩都在 127.0.0.1 上，
    // 有这条，开发机开着 Clash 也不会改变它们的结果。
    {
      const dead = await deadPort();
      const hitsBefore = proxyHits;
      const r2 = await callRelay(relay.port, {
        url: `http://127.0.0.1:${dead}/v1/chat/completions`,
        timeout: 5000,
      });
      eq("本机地址连不上 ⇒ 仍然是 502", r2.status, 502);
      eq("没借代理（x-aiaid-proxy-used 缺省）", r2.proxyUsed, null);
      eq("代理一次都没被碰过", proxyHits, hitsBefore);
      const j2 = JSON.parse(r2.body) as { error?: string };
      check(
        "报错仍是明确的「连不上上游 127.0.0.1:端口」（没被代理糊掉）",
        Boolean(j2.error?.includes("连不上上游 127.0.0.1")),
        j2.error ?? r2.body,
      );
    }
    } finally {
      setLocalProxyCandidates([]);
      await new Promise<void>((r) => stubProxy.close(() => r()));
    }
  }

  console.log("\n⑬ 诊断出网 —— 把「连不上上游」拆开，并指出该改哪一格");
  {
    interface Report {
      ok: boolean;
      verdict: string;
      dns: { ok: boolean; detail: string };
      tcp: { ok: boolean; detail: string };
      http: { ok: boolean; detail: string };
      proxyGivenTcp: { ok: boolean; detail: string } | null;
      localProxies: { url: string; alive: boolean }[];
    }
    const diag = async (url: string, proxy?: string): Promise<Report> => {
      const q = new URLSearchParams({ url, ...(proxy ? { proxy } : {}) });
      const res = await fetch(`http://127.0.0.1:${relay.port}${DIAG_PATH}?${q.toString()}`);
      return (await res.json()) as Report;
    };

    const up = await startUpstream("ok");
    {
      const r = await diag(`http://127.0.0.1:${up.port}/v1/chat/completions`);
      eq("目标可直连 ⇒ ok=true", r.ok, true);
      eq("三段都✓", [r.dns.ok, r.tcp.ok, r.http.ok].join(","), "true,true,true");
      check("结论是「网络没问题，去查 Key/模型名」", r.verdict.includes("直连"), r.verdict);
    }
    {
      // 端口没人监听 + 本机有个活着的代理 ⇒ 该让玩家去填代理。
      const dead = await deadPort();
      setLocalProxyCandidates([`http://127.0.0.1:${up.port}`]);
      const r = await diag(`http://127.0.0.1:${dead}/v1/chat/completions`);
      setLocalProxyCandidates([]);
      eq("连不上 ⇒ ok=false", r.ok, false);
      eq("TCP 那段如实报错", r.tcp.ok, false);
      check(
        "结论点名该填哪个代理地址",
        r.verdict.includes(`http://127.0.0.1:${up.port}`),
        r.verdict,
      );
    }
    {
      // ★ 最容易忽略的一种：地址没问题，是玩家填的「上游代理」本身没开。
      //   这种情况下含糊地说「连不上上游」等于没说。
      const dead = await deadPort();
      const r = await diag("http://api.example.test/v1/chat/completions", `http://127.0.0.1:${dead}`);
      eq("如实报出填的代理不可达", r.proxyGivenTcp?.ok, false);
      check("结论**先**点名「上游代理」本身连不上", r.verdict.includes("上游代理"), r.verdict);
    }
    await up.close();
  }

  console.log("\n⑩ 判定表本身（与客户端共用同一把尺子）");
  {
    check(
      "read ECONNRESET 值得重试",
      isTransientNetError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })),
    );
    check("socket hang up 值得重试", isTransientNetError(new Error("socket hang up")));
    check("浏览器 Failed to fetch 值得重试", isTransientNetError(new TypeError("Failed to fetch")));
    check("网关 502 值得重试", isTransientNetError(new Error("模型接口返回 502：bad gateway")));
    check("401 不值得", !isTransientNetError(new Error("模型接口返回 401：Authentication Fails")));
    check("超时不值得（再等一轮只会更慢）", !isTransientNetError(new Error("上游 60 秒没有响应")));
    check("取消不值得", !isTransientNetError(new Error("已取消")));
    check(
      "「已重试 N 次」**不再算终态** —— 上层（观战）的重试要能接着上",
      isTransientNetError(new Error("中转失败：连不上上游：read ECONNRESET（已重试 3 次）")),
    );
    check(
      "「别再叠加」由页面按响应头决定，不靠猜文案",
      isTransientNetError(new Error("中转失败：连不上上游：read ECONNRESET（已重试 3 次）")) &&
        !isTransientNetError(new Error("模型接口返回 401：Authentication Fails")),
    );
  }

  await relay.close();

  console.log("\n" + "=".repeat(66));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    console.log("\n失败明细：");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(
    "✓ 中转：抖动换新连接重试 · 连接不复用 · 隧道未被破坏 · 断开即作废 · " +
      "连不上就直说（不伪装成慢）· 直连不通自动借本机代理 · 诊断能指到具体哪一格",
  );
  process.exit(0);
})();
