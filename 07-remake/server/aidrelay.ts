/**
 * AI 援助中转（`/__aiaid/*`）—— 开发服务器侧的 Node 出网代理。
 *
 * ## 为什么需要它
 *
 * 「AI 援助」原本由**浏览器直接**请求模型接口。这条路有两个死穴：
 *
 *   ① **跨域**：页面在 127.0.0.1:5180，接口在别家域名上。带 `authorization`
 *      的 POST 必先发 OPTIONS 预检，接口方不回预检头就只能干等。
 *   ② **走不了代理**（★ 真正的元凶）：无头/普通 Chrome 默认只认 **Windows 系统代理**。
 *      实测本机：`api.openai.com` 直连**挂死 >9s**，而走 `127.0.0.1:7897` 只要 **1.1s**。
 *      于是玩家点了「AI 援助」→ 一直"正在问模型…"→ 30 秒超时。
 *      （2026-09-14 玩家实报「AI援助超时」，根因就是这个。）
 *
 * 改成**同源**打到这里、由 Node 侧出网，两个问题一起消失：同源没有跨域；
 * Node 侧可以显式走 `x-aiaid-proxy` 指定的上游代理（CONNECT 隧道）。
 *
 * ## 协议
 *
 *   POST /__aiaid/relay
 *     x-aiaid-url    目标 URL（完整 /chat/completions 地址）  ← 必填
 *     x-aiaid-key    上游 API Key（转成 `Authorization: Bearer …`）
 *     x-aiaid-proxy  可选上游代理，如 `http://127.0.0.1:7897`
 *     x-aiaid-timeout 上游超时毫秒（默认 60000）
 *     body           **原样**是 OpenAI 的请求体
 *   → 上游的 status / content-type / body 原样回给页面（页面据此报 4xx 详情）
 *     + `x-aiaid-attempts`：这一发实际打了几次（诊断用，1 = 一次过）
 *
 *   GET  /__aiaid/ping → `{"ok":true}`：页面用它探测"有没有中转可用"
 *     （`npm run build` 后挂在静态服务器上时没有，页面会自动退回直连）
 *
 * ## ★ 为什么禁掉 keep-alive（2026-09-15 玩家实报「read ECONNRESET」）
 *
 * 玩家在观战里看到：
 *
 * ```
 * 观战 · 已暂停（第 1 手）
 * 蓝方（云端）这一手失败：中转失败：read ECONNRESET
 * ```
 *
 * `read ECONNRESET` 不是我们发错了，是**上游把连接掐了**。而它为什么会被掐：
 *
 * Node 19 起 `http.globalAgent` 默认 **`keepAlive: true`** —— 我们每发一次请求，
 * socket 就被收回池子等下次复用。可模型网关（以及中间的反向代理 / 机场节点）
 * 都会**主动回收空闲连接**，且不保证用 FIN 优雅关闭（常见的是直接 RST）。
 * 于是"上次留下的 socket"在下一发被复用时早已是**半开连接**：
 *
 * ```
 * 实测（本机假上游，1.2s 后 destroy 掉空闲连接）：
 *   默认 agent   → reused=true   ← 复用了池里的旧 socket
 *   agent: false → reused=false  ← 每次新建
 * ```
 *
 * 观战恰好把这个坑放大到必现：一手云端棋走完，界面要**停 2.6 秒甚至几十秒**
 * 才发下一手 —— 正好是连接被上游回收的窗口。第 1 手就中招也是这个原因：
 * 玩家多半先点过「测试连接」探路，那发请求留下的 socket 进了池子，
 * 等正式开局时早已失效。
 *
 * 所以这里两件事一起做：
 *   · **不复用连接**（`agent: false` + `connection: close`）—— 中转是低频调用
 *     （几秒一发），省下的握手时间远不如"一发必中"值钱；
 *   · **瞬态失败自动重试**（{@link RELAY_MAX_ATTEMPTS}）—— 就算真赶上抖动，
 *     换一条新连接重来即可，而不是把整场观战停掉。
 *
 * ⚠️ 重试的边界由 `src/game/neterr.ts` 的 {@link isTransientNetError} 决定：
 * **只重试链路抖动**；超时、Key 错、模型答得不对这些"重试也没用"的一律不重试。
 *
 * ## 安全
 *
 * 开发服务器只绑 `127.0.0.1`；且**要求自定义头 `x-aiaid-url`** —— 别家网页想拿它当
 * 跳板的话，带自定义头的请求会先被浏览器拦在预检那一步（我们不回 CORS 头），
 * 拿不到响应也发不出去。所以它对本机开发是安全的，但**不要**把它暴露到公网。
 */

import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tcpConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Connect, Plugin } from "vite";
import { isTransientNetError, netErrorText } from "../src/game/neterr.ts";

export const RELAY_PATH = "/__aiaid/relay";
export const PING_PATH = "/__aiaid/ping";
/** 出网诊断（设置面板的「诊断出网」按钮调它）。 */
export const DIAG_PATH = "/__aiaid/diag";
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000;

/** 一发页面请求最多向上游打几次（1 = 不重试）。3 = 首次 + 2 次重试。 */
export const RELAY_MAX_ATTEMPTS = 3;
/** 每次重试前等的毫秒数（按次数递增：220 / 440）。 */
const RETRY_GAP_MS = 220;
/** 剩余预算不足这么多就**不再**重试 —— 重试也得留够上游回话的时间。 */
const MIN_RETRY_BUDGET_MS = 3_000;

/**
 * 连接阶段（DNS + TCP + TLS 握手）最多等多久。
 *
 * ★ 2026-09-15 玩家第二次实报「一直提示连接不上上游」之后加的。
 * 原来只有一根秒表（`timeoutMs`，默认 60 秒）量到底，于是"这个地址根本连不上"
 * 要**干等满 60 秒**才报错，而且报出来的是「上游 60 秒没有响应」——
 * 看着像"模型在思考/太慢"，把排查方向整个带偏（真因是**连都没连上**）。
 * 连接是毫秒级的事：8 秒连不上就该明说"连不上 ${host}"。
 *
 * ⚠️ 可用 `AID_CONNECT_TIMEOUT_MS` 覆盖（回归测试要压到 300ms，不然每条都得等 8 秒）。
 *    故意**每次调用时读**环境变量，而不是模块加载时读一次 —— 否则测试没法在同一个
 *    进程里改它（静态 `import` 会先于测试代码求值）。
 */
function connectTimeoutMs(): number {
  return Number(process.env.AID_CONNECT_TIMEOUT_MS) || 8_000;
}

/**
 * 直连不通时，自动借用**本机已开着的代理**再打一发（端口按序探测，见 `detectLocalProxy`）。
 *
 * 为什么值得做：本机实测 `api.openai.com` 直连 TCP 超时，而穿 `127.0.0.1:7897` 立刻通。
 * 玩家只知道"要填地址和 Key"，不知道还得填代理 —— 于是永远撞在「连不上上游」上，
 * 而且从报错里看不出"其实只差一个代理"。中转是**本机开发用**的，借用玩家自己开着的
 * 代理不算越界；且**只在直连失败之后**才试 —— DeepSeek/通义/智谱这类直连就通的接口
 * 完全不受影响（一次都不会去探代理）。
 *
 * ⚠️ 可用 `AID_LOCAL_PROXIES`（逗号分隔）覆盖；**设成空串 = 一个都不试**（回归测试与
 *    审计脚本必须显式关掉它，否则"本机恰好开着 Clash"会让它们的结果随环境变）。
 *    也提供了 {@link setLocalProxyCandidates} 供进程内直接改。
 */
function defaultLocalProxies(): string[] {
  const env = process.env.AID_LOCAL_PROXIES;
  if (env !== undefined) {
    return env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [
    "http://127.0.0.1:7897", // Clash / Clash Verge
    "http://127.0.0.1:7890", // Clash 旧版默认
    "http://127.0.0.1:10809", // v2rayN（http）
    "http://127.0.0.1:10808", // v2rayN（socks）
    "http://127.0.0.1:1080", // 通用 socks
    "http://127.0.0.1:8889", // 部分客户端
  ];
}

let localProxyList = defaultLocalProxies();

/** 改探测列表（测试/审计用；传 `[]` 即彻底关掉自动借代理）。 */
export function setLocalProxyCandidates(list: readonly string[]): void {
  localProxyList = [...list];
  proxyCache = { at: 0, url: null };
}

/** 当前探测列表（`/__aiaid/diag` 会把它回给页面，好让玩家看到"本机有哪些代理活着"）。 */
export function getLocalProxyCandidates(): readonly string[] {
  return localProxyList;
}

/** 探测结果缓存 —— 别每发都去敲一遍 6 个端口。 */
let proxyCache: { at: number; url: string | null } = { at: 0, url: null };
const PROXY_CACHE_MS = 30_000;

/** 探一下某 host:port 在不在监听（只做 TCP 握手，不做协议）。 */
function probeTcp(host: string, port: number, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = tcpConnect({ host, port });
    let done = false;
    const fin = (v: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => fin(false), ms);
    sock.on("connect", () => fin(true));
    sock.on("error", () => fin(false));
  });
}

/** 找本机第一个活着的代理；都没有就 `null`。 */
export async function detectLocalProxy(force = false): Promise<string | null> {
  if (!force && Date.now() - proxyCache.at < PROXY_CACHE_MS) return proxyCache.url;
  let found: string | null = null;
  for (const url of localProxyList) {
    const u = new URL(url);
    // 串行探测：通常第一个就命中；全都不在时才依次等 300ms。
    if (await probeTcp(u.hostname, Number(u.port) || 80, 300)) {
      found = url;
      break;
    }
  }
  proxyCache = { at: Date.now(), url: found };
  return found;
}

/**
 * 「这一发根本没送达上游」这类**链路层**失败 —— 决定要不要换个代理再试。
 *
 * 不含：上游回了 4xx/5xx（那是"到了但不满意"，换代理没用）、上游超时（在等回话，
 * 说明连接是通的）。
 */
function isConnectFailure(e: unknown): boolean {
  if (isRawSocketError(e)) return true;
  return /连接超时|连不上上游代理|上游代理地址不合法/.test(netErrorText(e));
}

/**
 * 本机地址（`127.0.0.1` / `localhost` / `::1`）—— 这类目标**不借代理**。
 *
 * 理由不是"测试方便"，而是**语义**：本机地址连不上只可能是"那个服务没在跑"，
 * 借代理也绕不到本机的端口上（代理只换个出口 IP，不解决"对面根本没监听"）。
 * 而且真去借，会把一个干净的 `ECONNREFUSED` 变成代理那边一句含糊的 502，
 * 反而把"服务没起"这个最明确的诊断信息弄丢。
 *
 * 顺带的好处：端到端审计脚本的桩上游都在 127.0.0.1 上，
 * **开发机恰好开着 Clash 也不会把它们的结果带偏**。
 */
function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\./.test(h);
}

interface Upstream {
  status: number;
  type: string;
  body: Buffer;
}

export interface ForwardResult extends Upstream {
  /** 实际尝试次数（>1 表示重试过）。 */
  attempts: number;
  /** 这一发最终走的代理（`null` = 直连）。页面据此告知"已自动借用了本机代理"。 */
  proxyUsed: string | null;
}

/**
 * 上游连续失败后抛这个 —— 关键是**带上"打了几次"**。
 *
 * 为什么要单独一个类型：失败响应也得把 `x-aiaid-attempts` 带给页面，
 * 否则页面不知道中转已经重试过，会在几百毫秒后再叠一层。
 * 2026-09-15 实测踩到过：只在**成功**路径回了这个头，失败路径漏了 ——
 * 于是 `postChat` 的重试照样叠加，`CLOUD_TRY_ROUNDS` 关掉都测不出差别。
 */
export class RelayUpstreamError extends Error {
  readonly attempts: number;
  constructor(message: string, attempts: number) {
    super(message);
    this.name = "RelayUpstreamError";
    this.attempts = attempts;
  }
}

/**
 * 页面是不是已经走了（退出观战 / 关标签 / 前端自己超时取消）。
 *
 * 走了就别再重试、也别让上游请求继续挂着 —— 它回来也没人要，白占配额。
 */
export interface RelayCancel {
  isAborted(): boolean;
  /** 登记"掐掉当前这一发"的回调；`null` = 这一发已经结束，不用掐了。 */
  register(kill: (() => void) | null): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 毫秒说成人话（回归测试会把上限压到 300ms，别报出「0 秒」）。 */
function secs(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${ms} 毫秒`;
}

/**
 * 这是"原始 socket 报错"吗（`read ECONNRESET` / `socket hang up` / `connect ETIMEDOUT`）？
 *
 * 判据：带了 `err.code` **且** message 全是 ASCII。我们手写的中文错误
 * （`上游 60 秒没有响应`、`连不上上游代理`）都不满足，所以不会被加前缀、
 * 也不会被误当成"裸报错"重新包装 —— 那些文案是给玩家看的，直接透传。
 */
function isRawSocketError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && /^[\x20-\x7e]+$/.test(netErrorText(e));
}

/**
 * 把最后一次失败讲成人话：**说清"连不上谁"**，并如实报出重试了几次。
 *
 * ⚠️ 一定要带 `target.host`（2026-09-15 玩家实报后加的）：原来只说「连不上上游」，
 * 而玩家的配置里可能填着**两个**地址（接口地址 + 上游代理），报错不点名等于没说。
 * 现在文案形如：
 *   `连不上上游 api.openai.com（经代理 http://127.0.0.1:7897）：connect ETIMEDOUT（已重试 3 次）`
 */
function describeFailure(
  e: unknown,
  attempts: number,
  target: URL,
  proxyUsed: string | null,
): string {
  const msg = netErrorText(e);
  const via = proxyUsed ? `（经代理 ${proxyUsed}）` : "";
  const head = isRawSocketError(e)
    ? `连不上上游 ${target.host}${via}：${msg}`
    : msg;
  return attempts > 1 ? `${head}（已重试 ${attempts} 次）` : head;
}

/** 把**一次** POST 发到 `target`，可选经 `proxy`（HTTP CONNECT 隧道）。 */
function forwardOnce(
  target: URL,
  body: Buffer,
  key: string,
  proxy: string | null,
  timeoutMs: number,
  cancel?: RelayCancel,
): Promise<Upstream> {
  return new Promise<Upstream>((resolve, reject) => {
    let settled = false;
    /** 连接阶段的秒表（见 {@link CONNECT_TIMEOUT_MS}）；连上就该停掉。 */
    let connTimer: ReturnType<typeof setTimeout> | null = null;
    const stopConnTimer = (): void => {
      if (connTimer) clearTimeout(connTimer);
      connTimer = null;
    };
    const ok = (v: Upstream): void => {
      if (settled) return;
      settled = true;
      stopConnTimer();
      cancel?.register(null);
      resolve(v);
    };
    const bad = (e: unknown): void => {
      if (settled) return;
      settled = true;
      stopConnTimer();
      cancel?.register(null);
      reject(e);
    };

    const isTls = target.protocol === "https:";
    const port = Number(target.port || (isTls ? 443 : 80));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "content-length": String(body.length),
      host: target.host,
      // ★ 配合下面的 `agent: false`，双保险：让对端也别留这条连接。
      connection: "close",
    };
    if (key) headers.authorization = `Bearer ${key}`;

    const onResponse = (res: IncomingMessage): void => {
      stopConnTimer();
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        ok({
          status: res.statusCode ?? 502,
          type: String(res.headers["content-type"] ?? "application/json"),
          body: Buffer.concat(chunks),
        }),
      );
      res.on("error", bad);
    };

    /** `createConnection` 给了就走隧道里的 TLS socket。 */
    const send = (createConnection?: () => Socket): void => {
      const opts: Record<string, unknown> = {
        method: "POST",
        host: target.hostname,
        port,
        path: target.pathname + target.search,
        headers,
        timeout: timeoutMs,
      };
      // ★ 只有"自己建连"的那条路能关 agent。
      //   隧道那条（下面 createConnection）的连接是**外部塞进来的 socket**
      //   （TLS 握手已经做完），再设 `agent` 属于两种接管方式打架 ——
      //   谁赢取决于 Node 内部实现细节。不赌：那条路保持原写法（不设 agent），
      //   靠上面的 `connection: close` 达到"用完就关、不进池子"的同样效果。
      if (createConnection) opts.createConnection = createConnection;
      else opts.agent = false;
      const req = isTls ? httpsRequest(opts, onResponse) : httpRequest(opts, onResponse);
      cancel?.register(() => req.destroy(new Error("已取消")));
      // ★ 连接阶段单独一根秒表（见 CONNECT_TIMEOUT_MS）。
      //   连不上要**立刻**说"连不上"，而不是拿"等模型思考"的 60 秒预算去等一个
      //   根本不会来的连接 —— 那种报错会伪装成"上游很慢"，把排查方向带偏。
      //   隧道那条不用：外面塞进来的 socket 早已握手完成，这里只是在已知连接上发请求，
      //   再挂一根连接秒表会把"上游想得久"误判成"连接超时"。
      if (!createConnection) {
        const budget = Math.min(timeoutMs, connectTimeoutMs());
        connTimer = setTimeout(
          () => req.destroy(new Error(`连不上 ${target.host}（连接超时 ${secs(budget)}）`)),
          budget,
        );
        // 连上就停表 —— 之后的时间归"等上游回话"管。
        // ⚠️ 判据要分 https / http：`TLSSocket` 在 **TCP 刚连上**时也会发 `connect`
        //   （TLS 还没握完），照它停表就等于没管 TLS —— 实测会把"握手卡死"漏成
        //   「上游 8 秒没有响应」（2026-09-15 回归测试当场抓到）。所以 https 只认
        //   `secureConnect`，http 认 `connect`。`encrypted` 是 TLSSocket 的公开属性。
        req.once("socket", (s: Socket) => {
          if ((s as Socket & { encrypted?: boolean }).encrypted) {
            s.once("secureConnect", stopConnTimer);
          } else {
            s.once("connect", stopConnTimer);
          }
        });
      }
      req.on("timeout", () =>
        req.destroy(new Error(`上游 ${Math.round(timeoutMs / 1000)} 秒没有响应`)),
      );
      req.on("error", bad);
      req.end(body);
    };

    if (!proxy) {
      send();
      return;
    }

    let p: URL;
    try {
      p = new URL(proxy);
    } catch {
      bad(new Error(`上游代理地址不合法：${proxy}`));
      return;
    }
    const pPort = Number(p.port || (p.protocol === "https:" ? 443 : 80));

    // 明文目标的代理请求：直接用"绝对 URI"形式，不用 CONNECT。
    if (!isTls) {
      const req = httpRequest(
        {
          host: p.hostname,
          port: pPort,
          method: "POST",
          path: target.href,
          headers,
          timeout: timeoutMs,
          agent: false,
        },
        onResponse,
      );
      cancel?.register(() => req.destroy(new Error("已取消")));
      req.on("timeout", () =>
        req.destroy(new Error(`上游 ${Math.round(timeoutMs / 1000)} 秒没有响应`)),
      );
      req.on("error", bad);
      req.end(body);
      return;
    }

    // HTTPS 目标：先 CONNECT 一条隧道，再在隧道上做 TLS。
    const sock = tcpConnect({ host: p.hostname, port: pPort });
    cancel?.register(() => sock.destroy(new Error("已取消")));
    sock.setTimeout(timeoutMs, () => sock.destroy(new Error("连不上上游代理")));
    sock.on("error", bad);
    sock.on("connect", () => {
      sock.write(
        `CONNECT ${target.host}:${port} HTTP/1.1\r\nHost: ${target.host}:${port}\r\n\r\n`,
      );
    });
    const onHandshake = (chunk: Buffer): void => {
      const line = chunk.toString("latin1").split("\r\n")[0] ?? "";
      if (!/\s2\d\d\s?/.test(line)) {
        sock.destroy();
        bad(new Error(`上游代理拒绝转发：${line}`));
        return;
      }
      sock.removeListener("data", onHandshake);
      sock.setTimeout(0);
      const tls = tlsConnect({ socket: sock, servername: target.hostname });
      cancel?.register(() => tls.destroy(new Error("已取消")));
      tls.once("error", bad);
      tls.once("secureConnect", () => send(() => tls));
    };
    sock.on("data", onHandshake);
  });
}

/**
 * 发一发请求，**瞬态失败自动换新连接重试**（见文件头）。
 *
 * 预算分配：重试**不给新预算** —— 每次开打前都按"页面给的总超时还剩下多少"来定，
 * 剩不到 {@link MIN_RETRY_BUDGET_MS} 就干脆不重试（否则会出现"重试发出去，
 * 页面那边早就超时返回了，两边对不上的幽灵请求"）。
 */
export async function forward(
  target: URL,
  body: Buffer,
  key: string,
  proxy: string | null,
  timeoutMs: number,
  cancel?: RelayCancel,
): Promise<ForwardResult> {
  const t0 = Date.now();
  let last: unknown = new Error("没有发出请求");
  let activeProxy = proxy;
  let autoProxyTried = false;

  for (let attempt = 1; attempt <= RELAY_MAX_ATTEMPTS; attempt++) {
    if (cancel?.isAborted()) throw new Error("已取消");
    const left = timeoutMs - (Date.now() - t0);
    try {
      const up = await forwardOnce(
        target,
        body,
        key,
        activeProxy,
        Math.max(MIN_RETRY_BUDGET_MS, Math.min(timeoutMs, left)),
        cancel,
      );
      return { ...up, attempts: attempt, proxyUsed: activeProxy };
    } catch (e) {
      last = e;

      // ★ 直连没走通 → 借本机已开着的代理再打一发。
      //   玩家通常只知道"要填地址和 Key"，不知道地址本身还得穿代理；
      //   从「连不上上游」里也看不出"其实只差一个代理"。所以这里替他试一次。
      //   一个请求最多换一次，避免在两个代理之间来回横跳。
      //   ⚠️ 本机地址除外：那不是"被墙"，是"服务没起"，借代理只会把
      //      `ECONNREFUSED` 糊成代理的一句 502（见 `isLoopbackHost`）。
      if (
        !activeProxy &&
        !autoProxyTried &&
        !isLoopbackHost(target.hostname) &&
        isConnectFailure(e) &&
        !cancel?.isAborted()
      ) {
        autoProxyTried = true;
        const found = await detectLocalProxy();
        if (found) {
          activeProxy = found;
          continue;
        }
      }

      const rest = timeoutMs - (Date.now() - t0);
      const worth =
        attempt < RELAY_MAX_ATTEMPTS &&
        isTransientNetError(e) &&
        !cancel?.isAborted() &&
        rest > MIN_RETRY_BUDGET_MS;
      if (!worth) {
        throw new RelayUpstreamError(describeFailure(e, attempt, target, activeProxy), attempt);
      }
      await sleep(RETRY_GAP_MS * attempt);
    }
  }

  throw new RelayUpstreamError(
    describeFailure(last, RELAY_MAX_ATTEMPTS, target, activeProxy),
    RELAY_MAX_ATTEMPTS,
  );
}

// ═════════════════════════════════════════════════════════════
// 出网诊断（`GET /__aiaid/diag?url=…&proxy=…`）
//
// ★ 为什么要有它（2026-09-15 玩家第二次实报「一直提示连接不上上游」）：
//   「连不上上游」这一句话底下**至少压着五种完全不同的病**，每种治法都不一样 ——
//     ① 域名解析不了    → 地址写错了
//     ② TCP 连不上      → 地址/端口错，或本网络到它不通（要代理）
//     ③ TLS/HTTP 层断   → 被拦，或它根本不是模型接口
//     ④ 「上游代理」那格填的代理本身没开   → 清空 / 改端口（最容易被忽略的一条）
//     ⑤ 其实通了，只是 Key / 模型名错      → 报错文案会指向"上游"，把人带偏
//   光靠报错分不出来，玩家只能反复试。所以给一个"点一下、逐段量、给结论"的入口：
//   设置面板的「诊断出网」按钮就是调它（`main.ts` 的 openAidSettings）。
// ═════════════════════════════════════════════════════════════

/** 一段探测的结果。 */
export interface DiagStage {
  ok: boolean;
  /** 成功时是人话简述（地址列表 / `HTTP 401`），失败时是原始错误码或文案。 */
  detail: string;
  ms: number;
}

export interface DiagReport {
  target: string;
  host: string;
  port: number;
  dns: DiagStage;
  tcp: DiagStage;
  http: DiagStage;
  /** 玩家在设置里填的「上游代理」（可能为空）。 */
  proxyGiven: string | null;
  /** 填的那个代理本身通不通（没填则为 null）。 */
  proxyGivenTcp: DiagStage | null;
  /** 本机探到的候选代理端口，哪些活着。 */
  localProxies: { url: string; alive: boolean }[];
  /** 结论：到底哪一段断了、该改什么。 */
  verdict: string;
  /** 这个地址现在能不能用（能直连 或 经代理能通）。 */
  ok: boolean;
}

function tcpStage(host: string, port: number, ms: number): Promise<DiagStage> {
  return new Promise((res) => {
    const t0 = Date.now();
    const sock = tcpConnect({ host, port });
    let done = false;
    const fin = (ok: boolean, detail: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      res({ ok, detail, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => fin(false, `连接超时（${secs(ms)}）`), ms);
    sock.on("connect", () => fin(true, "TCP 已连通"));
    sock.on("error", (e) => fin(false, netErrorText(e)));
  });
}

function dnsStage(host: string, ms: number): Promise<DiagStage> {
  return new Promise((res) => {
    const t0 = Date.now();
    let done = false;
    const fin = (ok: boolean, detail: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      res({ ok, detail, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => fin(false, `解析超时（${secs(ms)}）`), ms);
    dnsLookup(host, { all: true }, (e, addrs) => {
      if (e) return fin(false, e.code || e.message);
      fin(true, addrs.map((a) => `${a.address}/v${a.family}`).join(", "));
    });
  });
}

/** 直连发一次 `GET /`，看 TLS 与 HTTP 这两层通不通（不求 2xx，能回状态码就是通）。 */
function httpStage(target: URL, ms: number): Promise<DiagStage> {
  return new Promise((res) => {
    const t0 = Date.now();
    const isTls = target.protocol === "https:";
    let done = false;
    const fin = (ok: boolean, detail: string): void => {
      if (done) return;
      done = true;
      res({ ok, detail, ms: Date.now() - t0 });
    };
    const opts = {
      method: "GET",
      host: target.hostname,
      port: Number(target.port || (isTls ? 443 : 80)),
      path: "/",
      agent: false,
      timeout: ms,
      headers: { connection: "close", "user-agent": "junqi-aid-diag" },
    };
    const cb = (r: IncomingMessage): void => {
      r.resume();
      fin(true, `HTTP ${r.statusCode}`);
    };
    const req = isTls ? httpsRequest(opts, cb) : httpRequest(opts, cb);
    req.on("timeout", () => req.destroy(new Error(`无响应（${secs(ms)}）`)));
    req.on("error", (e) => fin(false, netErrorText(e)));
    req.end();
  });
}

/**
 * 逐段量一遍出网链路，并给出**一句话结论**。
 *
 * 顺序刻意是 DNS → TCP → HTTP → 代理，因为**越靠前的越致命**：
 * 解析不了就没必要去连；连不上就没必要谈 TLS。
 */
export async function diagnose(target: URL, proxyGiven: string | null): Promise<DiagReport> {
  const isTls = target.protocol === "https:";
  const port = Number(target.port || (isTls ? 443 : 80));

  const dns = await dnsStage(target.hostname, 5_000);
  const tcp = dns.ok ? await tcpStage(target.hostname, port, 6_000) : { ok: false, detail: "（域名没解析出来，跳过）", ms: 0 };
  const http = tcp.ok ? await httpStage(target, 8_000) : { ok: false, detail: "（连不上，跳过）", ms: 0 };

  // 探测本机代理：**并发**，不然 6 个端口串行最坏要等 1.8 秒。
  const localProxies = await Promise.all(
    localProxyList.map(async (url) => {
      const u = new URL(url);
      return { url, alive: await probeTcp(u.hostname, Number(u.port) || 80, 300) };
    }),
  );
  const liveLocal = localProxies.find((p) => p.alive)?.url ?? null;

  // 玩家填的那个代理，本身通不通？—— 这是最容易被忽略的一种病：
  // 地址明明没问题，是他填的代理端口没开，于是每发都「连不上上游」。
  let proxyGivenTcp: DiagStage | null = null;
  if (proxyGiven) {
    try {
      const p = new URL(proxyGiven);
      proxyGivenTcp = await tcpStage(p.hostname, Number(p.port) || 80, 2_000);
    } catch {
      proxyGivenTcp = { ok: false, detail: "地址不合法", ms: 0 };
    }
  }

  const hostPort = `${target.hostname}:${port}`;
  let ok = false;
  let verdict: string;

  if (proxyGivenTcp && !proxyGivenTcp.ok) {
    verdict =
      `设置里的「上游代理」${proxyGiven} **本身连不上**（${proxyGivenTcp.detail}）。` +
      `每一发都会因为代理没开而报「连不上上游」——` +
      (liveLocal
        ? `把「上游代理」改成 ${liveLocal}，或者清空它（留空时中转会自动借用本机代理）。`
        : `先把它启动起来，或把这一格清空（清空后中转会自己去找本机代理）。`);
  } else if (!dns.ok) {
    verdict = `域名 ${target.hostname} 解析失败（${dns.detail}）—— 接口地址很可能写错了。`;
  } else if (!tcp.ok) {
    verdict =
      `连不上 ${hostPort}：${tcp.detail}。` +
      (liveLocal
        ? `本机检测到代理 ${liveLocal} 是活着的 —— 这个地址在当前网络下**需要走代理**：` +
          `在「AI 援助设置」把「上游代理」填成 ${liveLocal} 即可（留空也行，中转现在会自动借它）。`
        : `本机也没探到活着的代理（Clash / v2ray 之类没启动？）。` +
          `先开代理，或在「上游代理」里填好它的地址。`);
  } else if (!http.ok) {
    verdict =
      `能连上 ${hostPort}，但 HTTPS 这一层失败：${http.detail}。` +
      `通常是被中间设备打断，或者这个地址压根不是模型接口。`;
  } else {
    ok = true;
    verdict =
      `上游可以从本机直连（${http.detail}，${http.ms}ms）—— 中转这条路是通的。` +
      `若对局里仍然报错，问题不在网络，而在 Key / 模型名 / 接口路径：` +
      `点「测试连接」能看到上游返回的具体原因。`;
  }

  return {
    target: target.href,
    host: target.hostname,
    port,
    dns,
    tcp,
    http,
    proxyGiven,
    proxyGivenTcp,
    localProxies,
    verdict,
    ok,
  };
}

export function createAidRelayMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url ?? "";
    const path = url.split("?")[0];

    // 只接管自己的三个端点；其余（静态资源、HMR…）一律放行。
    if (path !== PING_PATH && path !== DIAG_PATH && path !== RELAY_PATH) {
      next();
      return;
    }

    const guard = (code: number, msg: string, extra: Record<string, string> = {}): void => {
      res.writeHead(code, {
        "content-type": "application/json; charset=utf-8",
        // ★ 标明"这个错是**中转自己**造的"，不是上游透传上来的。
        //   为什么非要有：上游的网关 502（过载/重启）会被原样透传，而页面只看到
        //   "502 + 走的是中转" ⇒ 一律报成「中转失败：bad gateway」，
        //   于是玩家去找"本地中转的毛病"，真凶（模型网关抖了）反而藏起来了。
        //   有了这个头，页面才分得开：中转自己错 vs 上游网关错。
        "x-aiaid-origin": "relay",
        ...extra,
      });
      res.end(JSON.stringify({ error: msg }));
    };

    if (path === PING_PATH) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, relay: "junqi-aid" }));
      return;
    }

    // ── 出网诊断（GET，只在设置面板手动点）────────────────────────
    // ⚠️ 必须放在"中转路径"的判断**之前**：曾经写在它后面，于是 `/__aiaid/diag`
    //    被当成"不是中转"直接 `next()` 掉，前端只拿到 404 空体
    //    （回归测试当场报 `Unexpected end of JSON input`）。
    if (path === DIAG_PATH) {
      const q = new URL(url, "http://relay.local");
      const rawDiag = (q.searchParams.get("url") ?? "").trim();
      const diagProxy = (q.searchParams.get("proxy") ?? "").trim() || null;
      if (!rawDiag) {
        guard(400, "缺少 url 参数");
        return;
      }
      let diagTarget: URL;
      try {
        diagTarget = new URL(rawDiag);
      } catch {
        guard(400, `url 不是合法地址：${rawDiag.slice(0, 80)}`);
        return;
      }
      if (diagTarget.protocol !== "https:" && diagTarget.protocol !== "http:") {
        guard(400, `不支持的协议：${diagTarget.protocol}`);
        return;
      }
      void diagnose(diagTarget, diagProxy).then(
        (report) => {
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(JSON.stringify(report));
        },
        (e: unknown) => guard(500, e instanceof Error ? e.message : String(e)),
      );
      return;
    }

    if (req.method !== "POST") {
      guard(405, "只接受 POST");
      return;
    }
    const rawTarget = String(req.headers["x-aiaid-url"] ?? "").trim();
    if (!rawTarget) {
      guard(400, "缺少 x-aiaid-url");
      return;
    }
    let target: URL;
    try {
      target = new URL(rawTarget);
    } catch {
      guard(400, `x-aiaid-url 不是合法 URL：${rawTarget.slice(0, 80)}`);
      return;
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      guard(400, `不支持的协议：${target.protocol}`);
      return;
    }
    const timeoutMs = Number(req.headers["x-aiaid-timeout"]) || DEFAULT_UPSTREAM_TIMEOUT_MS;
    const proxy = String(req.headers["x-aiaid-proxy"] ?? "").trim() || null;
    const key = String(req.headers["x-aiaid-key"] ?? "");

    // ★ 页面断开（退出观战 / 关标签 / 前端自己超时取消）：
    //   标记作废 + 掐掉正在飞的那一发，并且**别再重试**。
    //   `writableEnded` 用来区分"我们正常回完了"与"对面先走了"。
    let aborted = false;
    let kill: (() => void) | null = null;
    const cancel: RelayCancel = {
      isAborted: () => aborted,
      register: (fn) => {
        kill = fn;
        if (aborted) fn?.();
      },
    };
    res.on("close", () => {
      if (res.writableEnded) return;
      aborted = true;
      kill?.();
    });

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", (e) => guard(400, `读请求体失败：${e.message}`));
    req.on("end", () => {
      void forward(target, Buffer.concat(chunks), key, proxy, timeoutMs, cancel).then(
        (up) => {
          if (res.writableEnded) return; // 页面已经走了，别再写
          res.writeHead(up.status, {
            "content-type": up.type,
            "cache-control": "no-store",
            "x-aiaid-attempts": String(up.attempts),
            // 直连不通、中转自动借了本机代理 ⇒ 告诉页面，好如实提示玩家
            // 「已自动改用本机代理 X」（否则玩家不知道自己的请求走了代理）。
            ...(up.proxyUsed ? { "x-aiaid-proxy-used": up.proxyUsed } : {}),
          });
          res.end(up.body);
        },
        (e: unknown) => {
          // 5xx 只给中转自己的失败（连不上/超时/代理拒），上游的 4xx 会原样透传，
          // 页面才能如实显示"模型接口返回 401：…"。
          if (res.writableEnded) return;
          // ★ 失败也要带上"打了几次"：页面据此决定还要不要再叠一层重试（见 RelayUpstreamError）。
          const attempts = e instanceof RelayUpstreamError ? e.attempts : 1;
          guard(502, e instanceof Error ? e.message : String(e), {
            "x-aiaid-attempts": String(attempts),
          });
        },
      );
    });
  };
}

export function aidRelayPlugin(): Plugin {
  const attach = (middlewares: Connect.Server): void => {
    middlewares.use(createAidRelayMiddleware());
  };
  return {
    name: "junqi-aid-relay",
    configureServer: (server) => attach(server.middlewares),
    configurePreviewServer: (server) => attach(server.middlewares),
  };
}
