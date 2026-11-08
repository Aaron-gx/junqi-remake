/**
 * 「这次失败值得再撞一次吗」—— **全工程唯一判定处**。
 *
 * ## 为什么需要它（2026-09-15 玩家实报）
 *
 * 观战到第 1 手就停住了，提示：
 *
 * ```
 * 观战 · 已暂停（第 1 手）
 * 蓝方（云端）这一手失败：中转失败：read ECONNRESET
 * ```
 *
 * `read ECONNRESET` 是 Node 的原生 socket 报错：**上游把连接掐了**。
 * 它和"Key 错了""模型名错了"有本质区别 —— 后者重试一百次也没用（是配置问题），
 * 而前者是链路上的偶发抖动（网关回收空闲连接、代理重启、路由抖动），
 * **同一发请求再打一次大概率就过了**。
 *
 * 可惜当时所有失败都被一视同仁地当成"停手"理由，于是一次抖动毁掉整场观战。
 *
 * ## 判定的两条硬边界
 *
 * 1. **绝不重试"人错了"的**：Key / 地址 / 模型名 / 接口不兼容 / 模型答得不对 ——
 *    重试只是把同一个错误再演一遍，还多等一轮。
 * 2. **绝不重试"已经等够了"的**：超时与用户取消。再等一轮只会让 60 秒变 120 秒，
 *    而玩家早就盯着"正在问模型…"了。
 *
 * 所以这里的顺序是**先排除、再确认**：{@link FINAL_TEXT} 命中即否决，
 * 然后才看错误码与网络特征。
 *
 * ## 为什么浏览器与 Node 侧共用
 *
 * 同一类失败在两边的**证据形态不同**：Node 侧能拿到 `err.code`（`ECONNRESET`…），
 * 浏览器侧只剩被翻译成人话的 message（`Failed to fetch`）。
 * 两边各写一份判定，迟早会有一边漏掉某种错 —— 于是把两套证据都收在这一个函数里，
 * 中转（`server/aidrelay.ts`）与客户端（`postChat`）与观战（`watchCloudStep`）
 * 三层用的是**同一把尺子**。
 */

/** Node socket / 网络层错误码（`err.code`）。这些都不是"我们发错了"，而是链路抖了一下。 */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
]);

/**
 * 文案层面的瞬态特征。浏览器把底层错误包装过，只剩这些话可认：
 * Chrome `Failed to fetch`、Firefox `NetworkError…`、Safari `Load failed`，
 * 以及我们自己造的中转文案（`连不上上游…`）。
 */
const TRANSIENT_TEXT =
  /(econnreset|econnrefused|econnaborted|epipe|etimedout|eai_again|enetunreach|enetdown|ehostunreach|socket hang up|connection reset|connection closed|premature close|other side closed|failed to fetch|networkerror|network error|load failed|连不上|连接被重置)/i;

/**
 * 明确**不该**重试的。说清原因比盲目再撞一次有用得多 ——
 * 每一条都对应一次"重试也没用"的实测经历。
 *
 * ⚠️ 这里**故意不写「已重试 N 次」**（2026-09-15 踩过）：中转重试完会带上这句话，
 * 一度被我当成"终态"而否决了上层重试 —— 结果中转那 ~0.7 秒窗口一过，
 * **观战那层 1.5 秒后的重试也被一起挡住**，两层互相抵消，整局停在第 1 手。
 * "别再叠加"是个**时间尺度**问题（马上再打一次 vs 隔一秒半再打一次），不是错误性质问题，
 * 所以它由调用方按结构化信号决定：页面读中转回的 `x-aiaid-attempts` 头（见 `postChat`），
 * 而观战那层照旧按性质重试。
 */
const FINAL_TEXT =
  /(已取消|超时|timed out|没有回应|没有响应|还没配置|未配置|不是 json|openai 兼容|越界|可解析|只有思考|没有合法着法|返回 4\d\d)/i;

/** 网关侧的 5xx（502/503/504…）是典型瞬态：上游自己也在重启/过载。 */
const GATEWAY_5XX = /\b5\d\d\b/;

function codeOf(e: unknown): string {
  const c = (e as { code?: unknown } | null | undefined)?.code;
  return typeof c === "string" ? c.toUpperCase() : "";
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : "";
}

/**
 * 这次失败值得重试吗？
 *
 * @param e 任意抛出来的东西（`Error` / Node errno / 字符串）
 * @returns `true` = 同一发请求再打一次是**有意义**的
 */
export function isTransientNetError(e: unknown): boolean {
  const code = codeOf(e);
  const text = `${code} ${messageOf(e)}`.trim();
  if (!text) return false;

  // ① 先否决：配置错 / 模型答得不对 / 已取消 / 已超时 / 已经重试过了
  if (FINAL_TEXT.test(text)) return false;
  // ② 网关 5xx
  if (GATEWAY_5XX.test(text)) return true;
  // ③ Node 错误码
  if (code && TRANSIENT_CODES.has(code)) return true;
  // ④ 文案特征
  return TRANSIENT_TEXT.test(text);
}

/** 把错误码 / 错误对象压成一行，日志与提示条都用它。 */
export function netErrorText(e: unknown): string {
  const code = codeOf(e);
  const msg = messageOf(e);
  if (!msg) return code || "未知错误";
  return code && !msg.includes(code) ? `${msg}（${code}）` : msg;
}
