/**
 * AI 援助 —— 不会走的时候，把局面交给大模型，让它指一步。
 *
 * ## 为什么是"编号着法"而不是让它自己生成坐标
 *
 * 大模型对军棋（陆战棋）的走法规则、这个复刻版的格号体系都**不可靠**：
 * 直接问"走哪一格到哪一格"，它会一本正经地给出非法着法（比如步兵斜着吃）。
 * 所以这里把**规则引擎已经算好的合法着法**编号列进 prompt，只让模型做
 * 「在给定候选里挑一个」这件事 —— 这是它的强项（局面判断 + 说理由），
 * 而把"什么算合法"牢牢留在本地 `core/rules.ts` 手里。
 * 于是模型无论怎么胡说，回填到棋盘上的着法**一定是合法的**。
 *
 * ## 接口
 *
 * 只走 **OpenAI 兼容**的 `/chat/completions`（`{model, messages}` → `choices[0].message.content`）。
 * 这一条覆盖了绝大多数国内外服务：OpenAI、DeepSeek、月之暗面 Kimi、
 * 阿里通义（兼容模式）、智谱 GLM、讯飞星辰（兼容模式）、以及各种中转网关。
 * 配置项存在 `localStorage`，见 `src/main.ts` 的「AI 援助」设置行。
 *
 * ## 出网方式
 *
 * 默认**经同源中转** `/__aiaid/relay`（由 `vite.config.ts` 里的 `aidRelayPlugin` 提供），
 * 由 Node 侧代发请求；`cfg.relay = false` 时才由浏览器直连。理由见 `postChat` 的注释 ——
 * 一句话：浏览器直连过不了跨域预检，也走不了你本机的代理，症状就是"一直转然后超时"。
 */

import { CELLS, colOf, idx, isBase, isCamp, rowOf } from "../core/board.ts";
import { PieceType, Side, pieceName, sideName } from "../core/pieces.ts";
import { allLegalMoves, type RuleOptions } from "../core/rules.ts";
import { type Position } from "../core/state.ts";
import { isTransientNetError } from "./neterr.ts";

/**
 * 单发援助最多打几次（1 = 不重试）。2 = 首次 + 一次重试。
 *
 * 只对**链路抖动**生效（连接被掐 / 网关 5xx），判定见 `isTransientNetError`。
 * 为什么不给更多次：观战一局要走几十手，一发多等一轮会一路累积；
 * 而真正持续不通（代理没起、断网）时，第三次和第二次的结局一样。
 * 观战那层还有一次更慢的重试（`main.ts` 的 `watchCloudStep`），两层刚好互补。
 */
export const AID_MAX_ATTEMPTS = 2;

/** 重试前等多久（毫秒，按尝试次数递增）。 */
const AID_RETRY_GAP_MS = 350;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 单次援助的默认硬超时。**贯穿"发请求 + 读 body"两段**（见 `aiAidSuggest` 里那段长注释）。
 *
 * 60 秒而不是 30：推理型模型（`deepseek-reasoner`、带思考的 Qwen/GLM）与
 * 慢中转网关首字动辄二三十秒，30 秒会把"其实快好了"判成超时。玩家可在设置里改。
 */
export const DEFAULT_AID_TIMEOUT_MS = 60_000;

/**
 * 思考型模型的"只有思考、没有正文"报错。
 *
 * 2026-09-14 玩家实报"AI 还是用不了"—— 实测其配置 `deepseek-flash` 是**思考型模型**：
 * 同一个盘面 prompt 下它先把 token 全花在 `reasoning_content` 上（实测 `max_tokens: 32`
 * 时 `content` 直接是**空串**、`completion_tokens` 全记成 `reasoning_tokens`），
 * 首字动辄 50 秒以上 ⇒ 撞上 60 秒硬超时，表现就是"一直转然后超时"。
 * 所以一旦发现"空正文 + 有思考"，必须当场翻译成看得懂的话，而不是等超时。
 */
const THINKING_ONLY_MSG =
  "该模型是**思考型模型**（只回了 reasoning_content，没有正文）：" +
  "它会把这一步当推理题想很久（实测 50 秒以上）才会给答案。请在「AI 援助设置」里把" +
  "模型名换成 deepseek-chat（同平台、1 秒出结果），或保持 flash 并确保已自动关闭思考。";

/**
 * 对**已知默认开启思考**的模型名，显式附加"关掉思考"的请求字段。
 *
 * 实测（`docs` 里记了原始请求）：`deepseek-flash` 带上
 * `"thinking": {"type": "disabled"}` 之后 —— `reasoning_content` 为空、
 * `completion_tokens` 5、耗时 **0.90s**，正文正常返回。`reasoning_effort: "none"` 同样有效。
 *
 * ⚠️ 只对**确认接受该字段**的模型名下发（DeepSeek 系 + 其它常见推理型号），
 * 免得把不认识的参数丢给严格校验的上游；万一真的 400，`postChat` 会**去掉该字段重试一次**。
 */
export function thinkingOffExtras(model: string): Record<string, unknown> {
  const m = (model || "").trim().toLowerCase();
  if (!m) return {};
  if (/deepseek-(flash|reasoner)|reasoner|qwq|glm-z1|thinking|(^|[-_])think($|[-_])/.test(m)) {
    return { thinking: { type: "disabled" } };
  }
  return {};
}

/**
 * 「这个模型名是不是思考型」—— 设置面板的告警与 `thinkingOffExtras` 共用同一判定。
 *
 * ⚠️ 曾经 UI 里的正则只写 `reasoner|thinking|r1|o1-|o3-`，**漏了 `deepseek-flash`** ——
 * 而玩家配的恰好就是它，于是设置面板一声不吭、援助却次次超时（2026-09-14 实报）。
 */
export function looksLikeThinkingModel(model: string): boolean {
  return Object.keys(thinkingOffExtras(model)).length > 0;
}

/** 同源中转端点（Vite dev/preview 的 `aidRelayPlugin` 提供，见 `vite.config.ts`）。 */
export const AID_RELAY_PATH = "/__aiaid/relay";
/** 中转存活探测（`npm run build` 后挂静态服务器时没有它 → 自动退回直连）。 */
export const AID_PING_PATH = "/__aiaid/ping";
/** 出网诊断（设置面板的「诊断出网」按钮调它）。 */
export const AID_DIAG_PATH = "/__aiaid/diag";

/** AI 援助的连接配置（存 `localStorage`，字段名与 main.ts 的设置行一一对应）。 */
export interface AidConfig {
  /** 形如 `https://api.deepseek.com/v1` 或 `https://api.openai.com/v1`；也可直接给完整的 `.../chat/completions`。 */
  baseUrl: string;
  apiKey: string;
  /** 模型名，如 `deepseek-chat` / `gpt-4o-mini` / `qwen-plus`。 */
  model: string;
  /** 采样温度，默认 0.3（要的是判断，不是文采）。 */
  temperature?: number;
  /** 超时毫秒，默认 {@link DEFAULT_AID_TIMEOUT_MS}。 */
  timeoutMs?: number;
  /**
   * `true` = 经**同源中转** `/__aiaid/relay` 转发（由 Node 侧出网）。
   *
   * 浏览器直连有两个死穴：跨域预检、以及**走不了上游代理**（Chrome 只认系统代理，
   * 于是 `api.openai.com` 这类地址直连挂死 → 30 秒超时）。中转把这两件事一起解决。
   * 只有在没有中转可用时才该传 `false`（页面会自动探测，见 `aidRelayAvailable`）。
   */
  relay?: boolean;
  /** 上游代理（如 `http://127.0.0.1:7897`），**只在 `relay: true` 时生效**。 */
  proxy?: string;
}

export interface AidSuggestion {
  /** 起点格号（0..59）。翻子时等于 `to`。 */
  from: number;
  /** 终点格号。 */
  to: number;
  /** 该着法在候选列表里的编号（模型回答的就是它）。 */
  index: number;
  /** 模型给的一句话理由（可能为空）。 */
  why: string;
  /** 候选总数，便于提示"模型选的第几条"。 */
  total: number;
  /**
   * `true` = 这一步是**翻开一张暗子**（只在翻棋模式出现），此时 `from === to`。
   *
   * 翻棋里"一步"有两类：翻开暗子、移动已翻开的己方子。前者在棋盘上就是点那一张，
   * 所以 `from === to` —— 建议框两端重合，正好表示"点这张"。UI 据此决定 toast
   * 怎么写（翻子只要点一下，走子要点两下）。
   */
  reveal: boolean;
  /**
   * 这一发实际走了哪个代理。
   *
   * 中转在"直连不通、自动借了本机代理"时会回 `x-aiaid-proxy-used`（见 `server/aidrelay.ts`）。
   * 有值且与设置里填的不一致 ⇒ UI 必须**明说**（"已自动改用本机代理 X"）：
   * 悄悄替玩家换了路线，他会以为是自己填的那个代理在生效，下次排障就被带偏。
   */
  viaProxy?: string;
}

/** 一条候选着法：普通走子，或翻棋里的"翻开暗子"（`reveal=true`、`from === to`）。 */
export interface AidCandidate {
  from: number;
  to: number;
  capture: boolean;
  rail: boolean;
  reveal: boolean;
  /**
   * 走完会回到**已经出现过的局面**（观战防"两台 AI 来回磨"用）。
   *
   * 它只是**提示**，不是禁用：候选照旧合法、照旧列在表里，
   * 只是被排到队尾并在 prompt 里挂一句提醒 —— 剔除掉反而可能让模型
   * 在"每条路都回到旧局面"时无从可选。
   */
  avoid?: boolean;
  /**
   * 命中的那条"旧局面"**历史上出现过几次**（仅 `avoid === true` 时有意义）。
   *
   * 让 prompt 能说"会回到已经出现过 N 次的局面"而不只是"刚才出现过" ——
   * 次数越大说明这盘磨得越久，模型越该换方向（扣分也按次数加码）。
   */
  avoidTimes?: number;
  /**
   * 发起这步的那枚子**最近被挪了几次**（含本次，`> 1` 才值得提）。
   *
   * 与 `avoidTimes` 是**两条独立判据**：一个是"整盘回到旧局面"，一个是
   * "这枚子老在挪"。实战里最常见的磨法是后者（一枚子往返 + 别处慢慢漂，
   * 盘面每手都是新的 ⇒ `avoidTimes` 永远命中不了）。见 `AvoidMove.shuffle`。
   */
  shuffleTimes?: number;
  /**
   * 引擎算出的「走完这一步后的局面分」（`evalForSide`，可跨候选比较）。
   *
   * 由调用侧（`main.ts` 的观战）用与学习面板**同一把尺子**算好传入 ——
   * 见 `AidScore`。让云端模型在挑候选时能参考"引擎眼里的优劣"，
   * 而不是纯凭感觉。翻子候选没有这一步，缺省即不带。
   */
  engineScore?: number;
}

/**
 * 「走完会回到旧局面」的着法。
 *
 * 结构与 `ai.ts` 的 `AvoidMove` 完全一致，但**刻意不 import 它**：
 * `aiaid` 是"把局面讲给模型听"的一层，不该反过来依赖搜索模块的类型，
 * 否则以后想单测 prompt 就得把整个搜索树拖进来。
 */
export interface AidAvoidMove {
  from: number;
  to: number;
  /**
   * 走完会落到的那个局面**在历史上出现过几次**（≥1）。
   *
   * 只作提示文案用（"第 N 次"）—— 分数里的降权由 `main.ts` 算好、
   * 通过 `scores` 传进来。次数越多说明这盘磨得越久，越该换方向。
   * `0` = 新局面（不构成"回到旧局面"，只可能有 `shuffle`）。
   */
  times?: number;
  /**
   * 发起这步的那枚子**最近被挪了几次**（含本次，`1` = 窗口内没挪过）。
   *
   * 与 `times` 并列的第二条判据，同样只作提示文案用。
   */
  shuffle?: number;
}

/**
 * 一条走子候选的「引擎局面分」（走完这步后的 `evalForSide`）。
 *
 * 结构与 `AidAvoidMove` 一样刻意不 import `ai.ts`：aiaid 是"把局面讲给模型听"的一层，
 * 不该反过来依赖搜索模块。调用侧（`main.ts`）负责用 `aiRootOrder` + `evalForSide`
 * 算好分数，这里只**接收**并**按 from/to 匹配**挂到对应候选上。
 *
 * 为什么不直接收一个索引数组：`aiAidSuggest` 内部会因 `avoid` 把候选**分区重排**，
 * 传位置索引一重排就错位；用 from/to 配对最稳。
 */
export interface AidScore {
  from: number;
  to: number;
  /** 走完这一步后的局面分（越大引擎越看好）。 */
  score: number;
}

/** 配置不全时抛这个，UI 好据此提示"去设置里填一下"。 */
export class AidNotConfigured extends Error {
  constructor(missing: string) {
    super(`AI 援助还没配置：${missing}`);
    this.name = "AidNotConfigured";
  }
}

/** 把用户填的 baseUrl 规整成完整的 chat/completions 地址。 */
export function aidEndpoint(base: string): string {
  const b = (base || "").trim().replace(/\/+$/, "");
  if (!b) return "";
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/completions$/.test(b)) return b;
  // 已经带 /v1 就不再补；否则补一个（多数服务两种写法都认）
  return /\/v\d+$/.test(b) ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
}

/**
 * 把棋盘描述成模型看得懂的文本。
 *
 * 每一格都带上**全局格号**（`0..59`）—— 这是 prompt 里最重要的信息，
 * 因为候选着法就是用格号列的。暗棋里未翻开的**对方**棋子只报"未知"，
 * 不泄露兵种（本地确实知道，但没必要告诉模型，也免得它据此做出
 * 玩家自己都不可能做出的判断）。
 *
 * `hideAllUnknown` = 翻棋专用：翻棋里**双方都看不到任何背面朝上的子**，
 * 连自己那份也不知道（要翻开才知道颜色和兵种）。不打开这个开关的话，
 * 下面那条 `owner !== mover` 会把**自己的暗子**如实报给模型 —— 于是模型
 * 拿着玩家根本没有的信息出主意，提示就不再是"帮我看这一步"了。
 */
export function describeBoard(
  pos: Position,
  mover: Side,
  revealAll: boolean,
  hideAllUnknown = false,
): string {
  const lines: string[] = [];
  lines.push("棋盘 12 行 × 5 列（行 0 是红方底线，行 11 是蓝方底线；行营为空格，共 10 个）。");
  // `?` 的含义在两种模式下**不一样**：明暗棋里只藏对方那份；翻棋里双方都看不见。
  // 沿用旧文案会让模型以为红方阵地那些 `?` 是"对手的"，从而算错敌我。
  lines.push(
    hideAllUnknown
      ? "每格格式：格号/内容。内容 `--` = 空，`?` = 尚未翻开的暗子（翻棋里双方都看不到，翻开才知道颜色与兵种）。"
      : "每格格式：格号/内容。内容 `--` = 空，`?` = 对方未翻开的暗子。",
  );
  for (let r = 0; r < 12; r++) {
    const cells: string[] = [];
    for (let c = 0; c < 5; c++) {
      const i = idx(r, c);
      const t = pos.type[i] as PieceType;
      const owner = pos.owner[i] as Side;
      let s: string;
      if (t === PieceType.Empty) s = isCamp(i) ? "行营" : "--";
      else if (!revealAll && pos.revealed[i] !== 1 && (hideAllUnknown || owner !== mover))
        s = "?";
      else s = `${pieceName(t)}·${sideName(owner)}`;
      if (isBase(i)) s += "(大本营)";
      cells.push(`${String(i).padStart(2, " ")}:${s}`);
    }
    const tag = r < 6 ? "红方阵地" : "蓝方阵地";
    const front = r === 5 || r === 6 ? " ←最前线" : "";
    lines.push(`行${String(r).padStart(2, " ")}(${tag})${front} ${cells.join("  ")}`);
  }
  return lines.join("\n");
}

/**
 * 翻棋里"哪些格子还盖着" —— 也就是可以"翻开"的候选。
 *
 * 单独抽出来是为了让**什么算暗子**只有一处定义：`type != Empty` 且
 * `revealed != 1`。`main.ts` 用它生成候选，测试也用它造盘面。
 */
export function flipRevealCells(pos: Position): number[] {
  const out: number[] = [];
  for (let i = 0; i < CELLS; i++) {
    if (pos.type[i] !== PieceType.Empty && pos.revealed[i] !== 1) out.push(i);
  }
  return out;
}

const SYS_PROMPT = `你是中国军棋（陆战棋）高手，正在替玩家做一步决策。
规则要点：司令(1)>军长(2)>师长(3)>旅长(4)>团长(5)>营长(6)>连长(7)>排长(8)>工兵(9)；
炸弹(10)与任何子相遇双方同归于尽；地雷(11)不能移动、只有工兵能挖；
军旗(12)不能移动、被吃即负；工兵可沿铁路任意转弯滑行，其它子只能沿铁路直行；
10 个「行营」是安全岛（内部棋子不可被吃）。
你的任务：在**给定的候选着法列表**里挑出最好的一条。
每条候选可能带 \`（引擎评分 X）\` —— 这是本地引擎算出的「走完这步后的局面分」，
**分数越高引擎越看好**。优先选分高的；除非你有明确理由（比如它能吃大子、
翻子换关键信息），否则别选明显拖后腿的低分项。
标了 \`⚠ 走这里会回到刚才出现过的局面\` 的候选**已经扣过分**（分数里含 -45 的惩罚）。
除非其余候选全都明显更差，否则**不要选带 ⚠ 的那条** —— 双方都往回走会无限循环，
最后只能靠判和收场，等于白白浪费一盘棋。
必须严格输出 JSON：{"n": <候选项编号>, "why": "<20 字以内的中文理由>"}
不要输出 JSON 以外的任何内容，不要自己发明着法。`;

function userPrompt(
  board: string,
  moves: readonly AidCandidate[],
  pos: Position,
  mover: Side,
): string {
  const list = moves
    .map((m, k) => {
      // 翻子：起点终点同格，写"格16 → 格16"很蠢，单独成句。
      if (m.reveal) return `#${k} 翻开 格${m.to} 的暗子（翻开后才知道兵种）`;
      const ft = pos.type[m.from] as PieceType;
      const tt = pos.type[m.to] as PieceType;
      const toDesc =
        tt === PieceType.Empty
          ? isCamp(m.to)
            ? "进空行营"
            : "走到空格"
          : `吃 ${pieceName(tt)}·${sideName(pos.owner[m.to] as Side)}`;
      const line = `#${k} 格${m.from}(${pieceName(ft)}) → 格${m.to}（${m.rail ? "沿铁路" : "走公路"}，${toDesc}）`;
      // 观战防循环：标出"这一步会走回旧局面 / 这枚子老在挪"，让模型知道这不是新进展。
      // 引擎局面分：把"引擎看好谁"告诉模型，让它别纯凭感觉挑（见 SYS_PROMPT）。
      const scoreTag =
        m.engineScore !== undefined
          ? `　引擎评分 ${m.engineScore}`
          : "";
      // 两条判据分开说，别糊成一句 —— "跑回老盘面"和"这枚子老在挪"是两种不同的毛病，
      // 后者才是实战里最常见的（盘面每手都新、指纹判据全打空）。
      const warn = !m.avoid
        ? ""
        : m.avoidTimes
          ? `　⚠ 走这里会回到已经出现过 ${m.avoidTimes} 次的局面（已扣分）`
          : `　⚠ 这枚子最近 ${m.shuffleTimes ?? 2} 手内已被挪过多次，别再动它（已扣分）`;
      return `${line}${warn}${scoreTag}`;
    })
    .join("\n");
  const hasReveal = moves.some((m) => m.reveal);
  const hasAvoid = moves.some((m) => m.avoid);
  // `sideName(Side.None)` 回来的是「无」，直接用会得到"轮到 **无方** 行动"这种句子 ——
  // 翻棋定色前必须单独说人话，否则模型很可能误判成"某一方"而给出行棋建议。
  const turnLine =
    mover === Side.None
      ? "当前是翻棋**定色阶段**：还没有人翻过子，红蓝未定，本轮**只能从候选里翻开一张暗子**。"
      : `当前轮到 **${sideName(mover)}方** 行动。`;
  return `${turnLine}
${hasReveal && mover !== Side.None ? "\n注意：候选里的「翻开」是把一张背面朝上的暗子翻过来，翻开者取得该颜色。\n" : ""}
${hasAvoid ? "\n注意：标了 ⚠ 的候选**已经扣过分** —— 要么会走回刚才出现过的局面，要么那枚子最近老在被挪（来回横跳）。双方都不肯变着就会无限循环直到判和 —— 除非其余候选全都明显更差，否则优先选别的、**尤其是别再动那枚一直在挪的子**。\n" : ""}
${board}

候选着法（只能从这里选，回答它的编号 n）：
${list}

请选出你认为最好的一步。`;
}

/** 从模型回答里抠出 `{"n":..,"why":".."}`（容忍代码块、前后废话、全角引号）。 */
function parseAnswer(text: string): { n: number; why: string } | null {
  const t = text.replace(/[\uFF02\u201C\u201D]/g, '"').replace(/```[a-z]*/gi, "");
  const m = t.match(/\{[^{}]*\}/);
  if (!m) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  const raw = rec.n ?? rec.index ?? rec.move ?? rec.i;
  const n = typeof raw === "string" ? Number(raw.replace(/[^0-9-]/g, "")) : Number(raw);
  if (!Number.isFinite(n)) return null;
  return { n: Math.trunc(n), why: String(rec.why ?? rec.reason ?? rec.comment ?? "").slice(0, 60) };
}

/**
 * 把 OpenAI 请求体发出去，取回 `choices[0].message.content`。
 *
 * **中转与直连都走这一个函数** —— 超时/取消/错误翻译只有一处实现，界面文案才不会两套。
 *
 * ## 30 秒超时的那个真坑（2026-09-14 玩家实报）
 *
 * 曾经把 `clearTimeout` / `removeEventListener` 放在"fetch 拿到响应头"之后的
 * `finally` 里 —— 于是服务器一回响应头，**超时定时器被清掉、外部取消信号也断开了**，
 * 接下来的 `res.json()` 变成**永久挂起且无法取消**。玩家的体感是：点「AI 援助」→
 * 看到"正在问模型…" → 再也没有下文；再点一次只显示"已取消上一次"，因为底层 promise
 * 再也不 settle，`aidBusy` 永远为真。
 *
 * 所以：**`fetch` 与读 body 必须在同一个 try 里，清理只放在最外层 finally。**
 * 读 body 阶段的失败统一走 `netErr()`，翻译成"已取消 / 超时 / 连不上"。
 *
 * ## 为什么默认走中转（`cfg.relay`）
 *
 * 浏览器直连还有一个更隐蔽的死穴：**它只认 Windows 系统代理**，`cfg.proxy` 写得再对
 * 也传不进去。实测本机 `api.openai.com` 直连挂死 >9s，走 `127.0.0.1:7897` 只需 1.1s ——
 * 症状就是"点了 AI 援助一直转，然后超时"。改由 Node 侧出网（同源 `/__aiaid/relay`）
 * 之后，跨域和代理两个问题一起没了。
 */
async function postChat(
  cfg: AidConfig,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ content: string; ms: number; sawReasoning: boolean; viaProxy?: string }> {
  const url = aidEndpoint(cfg.baseUrl);
  if (!url) throw new AidNotConfigured("接口地址");
  if (!cfg.model?.trim()) throw new AidNotConfigured("模型名");
  if (!cfg.apiKey?.trim()) throw new AidNotConfigured("API Key");

  const timeoutMs =
    cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_AID_TIMEOUT_MS;
  const proxy = (cfg.proxy ?? "").trim();
  // 关思考的附加字段（只对已知的思考型模型名下发，见 `thinkingOffExtras`）。
  const extras = thinkingOffExtras(cfg.model ?? "");
  const hasExtras = Object.keys(extras).length > 0;
  const withExtras = hasExtras ? { ...(body as Record<string, unknown>), ...extras } : body;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = (): void => ac.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  /** 把"取响应 / 读 body"期间的三种失败翻译成人话：取消 / 超时 / 网络错。 */
  const netErr = (e: unknown): Error => {
    if (signal?.aborted) return new Error("已取消");
    if (ac.signal.aborted)
      return new Error(`AI 援助超时（${Math.round(timeoutMs / 1000)} 秒没有回应）`);
    return new Error(`连不上模型接口：${e instanceof Error ? e.message : String(e)}`);
  };

  const t0 = Date.now();

  /** 中转这一发实际打了几次（读它回的 `x-aiaid-attempts`）；0 = 没走中转或老版本中转。 */
  let relayAttempts = 0;

  /** 中转实际走的代理（读 `x-aiaid-proxy-used`）；null = 没走代理 / 没走中转。 */
  let proxyUsed: string | null = null;

  /**
   * 一次完整往返：发出去 → 取响应 → 读 body → 拿到 content。
   *
   * 抽成函数是为了给"链路抖动"留一次重试（见下面 `AID_MAX_ATTEMPTS`）。
   * 里面那层 400 去 `extras` 的重试是**模型兼容性**问题，与网络无关，别混在一起。
   */
  const once = async (): Promise<{
    content: string;
    ms: number;
    sawReasoning: boolean;
    viaProxy?: string;
  }> => {
    let res: Response;
    let bodyOut: unknown = withExtras; // 400 时会退回不带附加字段的原 body
    try {
      if (cfg.relay) {
        // 同源 → 没有跨域预检；目标地址与 Key 通过自定义头传给中转。
        // ⚠️ 中转不在时（例如 `npm run build` 后挂静态服务器）会回 404/HTML，
        //    调用方据此提示"退回直连"，见 main.ts 的 aidRelayOn。
        res = await fetch(AID_RELAY_PATH, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-aiaid-url": url,
            "x-aiaid-key": cfg.apiKey.trim(),
            "x-aiaid-timeout": String(timeoutMs),
            ...(proxy ? { "x-aiaid-proxy": proxy } : {}),
          },
          body: JSON.stringify(bodyOut),
          signal: ac.signal,
        });
      } else {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${cfg.apiKey.trim()}`,
          },
          body: JSON.stringify(bodyOut),
          signal: ac.signal,
        });
      }
    } catch (e) {
      throw netErr(e);
    }

    // 中转如实报了这一发打了几次。>1 说明它已经重试过 ≥2 次 —— 那就别在几百毫秒后
    // 再叠一层（同一个时间尺度上，再打一次不会有什么新信息）。
    // ⚠️ 用**头**而不是去猜错误文案：`neterr.ts` 里记着这个坑（曾按"已重试"三个字判终态，
    //    结果连观战那层 1.5 秒后的重试也被一起挡住）。
    if (cfg.relay) {
      const h = (res as { headers?: { get?: (k: string) => string | null } }).headers;
      const n = Number(h?.get?.("x-aiaid-attempts"));
      if (Number.isFinite(n) && n > relayAttempts) relayAttempts = n;
      // 中转替我们借了本机代理（直连不通时）—— 带回去让 UI 如实告诉玩家。
      const p = h?.get?.("x-aiaid-proxy-used");
      if (p) proxyUsed = p;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 中转自己的失败（连不上上游 / 上游超时 / 代理拒绝转发）回 502 + `{error}`，
      // 必须和"上游的 4xx"区分开，否则玩家会以为 Key 错了。
      //
      // ⚠️ 还得分"这个 502 是谁的"：上游网关自己的 502 会被中转**原样透传**，
      //    那时如果也喊「中转失败」，玩家就去查本地中转，而真凶是模型网关在抖。
      //    中转自己造的错误都带 `x-aiaid-origin: relay`（见 `server/aidrelay.ts` 的 guard）。
      const fromRelay =
        (res as { headers?: { get?: (k: string) => string | null } }).headers?.get?.(
          "x-aiaid-origin",
        ) === "relay";
      if (cfg.relay && res.status === 502 && fromRelay) {
        let msg = text.slice(0, 200);
        try {
          const j = JSON.parse(text) as { error?: string };
          if (j?.error) msg = j.error;
        } catch {
          /* 不是 JSON 就用原文 */
        }
        // ★ 「连不上上游」这一句底下压着五种不同的病（域名错 / 端口不通 / 要代理 /
        //   填的代理没开 / TLS 被拦），报错本身分不出来。这里直接指路到诊断按钮 ——
        //   2026-09-15 玩家实报时，光靠这行字根本不知道该改哪儿。
        const hint = /连不上上游|连接超时/.test(msg)
          ? "。可在「AI 援助设置」点「诊断出网」，它会逐段量并告诉你该改哪一格。"
          : "";
        throw new Error(`中转失败：${msg}${hint}`);
      }
      // 400 + 我们下发了 `thinking` ⇒ 很可能是上游不认这个字段：去掉它重试一次。
      if (res.status === 400 && hasExtras && bodyOut !== body) {
        const ac2 = new AbortController();
        const t2 = setTimeout(() => ac2.abort(), Math.max(1000, timeoutMs - (Date.now() - t0)));
        signal?.addEventListener("abort", () => ac2.abort(), { once: true });
        try {
          res = cfg.relay
            ? await fetch(AID_RELAY_PATH, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-aiaid-url": url,
                  "x-aiaid-key": cfg.apiKey.trim(),
                  "x-aiaid-timeout": String(timeoutMs),
                  ...(proxy ? { "x-aiaid-proxy": proxy } : {}),
                },
                body: JSON.stringify(body),
                signal: ac2.signal,
              })
            : await fetch(url, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: `Bearer ${cfg.apiKey.trim()}`,
                },
                body: JSON.stringify(body),
                signal: ac2.signal,
              });
          bodyOut = body; // 之后不再重试
        } catch (e) {
          throw netErr(e);
        } finally {
          clearTimeout(t2);
        }
        if (!res.ok) {
          const t3 = await res.text().catch(() => "");
          throw new Error(`模型接口返回 ${res.status}：${t3.slice(0, 120)}`);
        }
      } else {
        throw new Error(`模型接口返回 ${res.status}：${text.slice(0, 120)}`);
      }
    }

    type ChatMsg = { content?: string; reasoning_content?: string };
    let data: { choices?: { message?: ChatMsg }[] } | null = null;
    try {
      data = (await res.json()) as { choices?: { message?: ChatMsg }[] };
    } catch (e) {
      // 读 body 阶段被取消/超时打断，会落到这里（这正是上面那个坑的修复点）。
      if (e instanceof SyntaxError)
        throw new Error(`模型接口回的不是 JSON（接口地址可能填错了）：${e.message}`);
      throw netErr(e);
    }
    if (!Array.isArray(data?.choices))
      throw new Error("模型接口回了 2xx 但没有 choices（可能不是 OpenAI 兼容接口）");
    const msg: ChatMsg = data.choices[0]?.message ?? {};
    const content = msg.content ?? "";
    const sawReasoning = Boolean(msg.reasoning_content && msg.reasoning_content.trim());
    // 空正文 + 有思考 ⇒ 思考型模型的预算全花在推理上了（见 THINKING_ONLY_MSG）。
    if (!content.trim() && sawReasoning) throw new Error(THINKING_ONLY_MSG);
    return {
      content,
      ms: Date.now() - t0,
      sawReasoning,
      ...(proxyUsed ? { viaProxy: proxyUsed } : {}),
    };
  };

  // ── 链路抖一下就重来一次（2026-09-15）──────────────────────────
  //
  // 依据 `isTransientNetError`：**只**重试"连接被掐 / 网关 5xx"这类过一会儿
  // 就会好的失败。取消、超时、Key 错、模型答得不对一律直接抛 ——
  // 那些重试只是把同一个错误再演一遍，还多等一轮（详见 `neterr.ts` 的注释）。
  //
  // ⚠️ 重试**共享同一个超时预算**（`timer` 只起一个）：一手棋最多等这么久，
  //    不会因为重试变成两倍。取消同理 —— `ac.signal` 一断，下一发立刻结束。
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        return await once();
      } catch (e) {
        const giveUp =
          signal?.aborted ||
          ac.signal.aborted ||
          relayAttempts > 1 || // 中转已经重试过 ⇒ 别在同一时间尺度上叠加
          attempt >= AID_MAX_ATTEMPTS ||
          !isTransientNetError(e);
        if (giveUp) throw e;
        await sleep(AID_RETRY_GAP_MS * attempt);
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 探测同源中转在不在（`vite` / `vite preview` 有，纯静态托管没有）。
 *
 * 页面启动时探一次：在就默认走中转（跨域与代理问题一起消失），不在就老老实实直连 ——
 * 这样 `npm run build` 出来的产物挂在任意静态服务器上也照样能用。
 */
export async function aidRelayAvailable(timeoutMs = 1500): Promise<boolean> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(AID_PING_PATH, { signal: ac.signal, cache: "no-store" });
    if (!res.ok) return false;
    const j = (await res.json()) as { relay?: string };
    return j?.relay === "junqi-aid";
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * 「测试连接」：拿当前配置打一次最小请求（`ping`），只关心**能不能通**。
 *
 * 为什么值得单独做一个：玩家填错地址/Key/模型名时，现在唯一的反馈是"点 AI 援助 →
 * 等 30~60 秒 → 超时"，根本分不清是哪一环错。这个按钮 1 秒内就能把
 * 「4xx 详情 / 连不上 / 中转失败」摆出来。
 *
 * ## 为什么现在还要回报 `thinking`
 *
 * 2026-09-14 玩家实报"AI 还是用不了"，实测根因就是**模型选型**：`deepseek-flash` 是
 * 思考型模型，同一个盘面 prompt 下要 50 秒以上才吐正文，60 秒硬超时必然偶发失败。
 * 光说"连接成功 1000ms"会把玩家引向错误方向（他会以为是网络/地址问题），
 * 所以只要上游吐过 `reasoning_content`，这里就把 `thinking: true` 带回去，
 * 由设置面板直接提示"换成 deepseek-chat"。
 *
 * 注意 `note` 仍允许为空（模型只回了个短句被 `max_tokens` 截断等）；
 * 但**空正文 + 有思考**会被 `postChat` 直接抛 `THINKING_ONLY_MSG`，那不算连接成功。
 */
export async function aiAidPing(
  cfg: AidConfig,
  signal?: AbortSignal,
): Promise<{ ms: number; model: string; note: string; thinking: boolean; viaProxy?: string }> {
  const r = await postChat(
    cfg,
    {
      model: cfg.model.trim(),
      temperature: 0,
      max_tokens: 4,
      messages: [{ role: "user", content: "ping" }],
    },
    signal,
  );
  return {
    ms: r.ms,
    model: cfg.model.trim(),
    note: r.content.trim().slice(0, 40),
    thinking: r.sawReasoning,
    ...(r.viaProxy ? { viaProxy: r.viaProxy } : {}),
  };
}

/** 一段探测的结果（与 `server/aidrelay.ts` 的 `DiagStage` 一一对应）。 */
export interface AidDiagStage {
  ok: boolean;
  detail: string;
  ms: number;
}

/** 「诊断出网」的完整报告（与 `server/aidrelay.ts` 的 `DiagReport` 一一对应）。 */
export interface AidDiagReport {
  ok: boolean;
  /** 一句话结论：哪一段断了、该改设置里的哪一格。直接念给玩家听即可。 */
  verdict: string;
  target: string;
  host: string;
  port: number;
  dns: AidDiagStage;
  tcp: AidDiagStage;
  http: AidDiagStage;
  /** 设置里填的「上游代理」（没填为 null）。 */
  proxyGiven: string | null;
  /** 填的那个代理本身通不通（没填为 null）。 */
  proxyGivenTcp: AidDiagStage | null;
  /** 本机探到的候选代理端口，哪些活着。 */
  localProxies: { url: string; alive: boolean }[];
}

/**
 * 「诊断出网」：让**中转（Node 侧）**逐段量一遍 DNS / TCP / HTTPS，并给出结论。
 *
 * ★ 为什么非做不可（2026-09-15 玩家第二次实报「一直提示连接不上上游」）：
 *   「连不上上游」这五个字底下压着**至少五种**不同的病，治法全不一样 ——
 *   域名写错 / 端口不通 / 这个地址在当前网络下必须走代理 / **填的代理本身没开** /
 *   其实是通的、只是 Key 或模型名错。玩家从报错里分不出是哪种，只能一遍遍瞎试。
 *
 * 为什么不直接在浏览器里量：浏览器量不出真相 —— 它走不了代理，也读不到 errno
 * （只剩 `Failed to fetch`）。中转在 Node 侧，能拿到 `ECONNREFUSED` / `ETIMEDOUT`
 * 这种带码的证据，还能自己试着穿代理。所以在设置面板点一下，答案就出来了。
 */
export async function aiAidDiag(
  cfg: Pick<AidConfig, "baseUrl" | "proxy">,
  signal?: AbortSignal,
): Promise<AidDiagReport> {
  const url = aidEndpoint(cfg.baseUrl);
  if (!url) throw new AidNotConfigured("接口地址");
  const proxy = (cfg.proxy ?? "").trim();
  const q = new URLSearchParams({ url, ...(proxy ? { proxy } : {}) });
  let res: Response;
  try {
    res = await fetch(`${AID_DIAG_PATH}?${q.toString()}`, { signal, cache: "no-store" });
  } catch (e) {
    throw new Error(`调不动本地中转（${AID_DIAG_PATH}）：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    // 中转不在（纯静态托管）时给一句能自己动手的替代方案，别只报 HTTP 码。
    const detail = (await res.text().catch(() => "")).slice(0, 80);
    throw new Error(
      `诊断需要本地中转（${AID_DIAG_PATH}），现在调不通（HTTP ${res.status}）` +
        `${detail ? `：${detail}` : ""}。页面要用 npm run dev 或 npm run preview 起才带中转。`,
    );
  }
  return (await res.json()) as AidDiagReport;
}

/**
 * 请求一次 AI 援助。
 *
 * @param revealCells 翻棋专用：还盖着的格号（见 `flipRevealCells`）。给了就把它
 *   们**追加**在走子候选之后，作为"翻开一张"的候选。追加而不是插在前面，
 *   是为了让"前 N 条 = 走子"这个顺序稳定 —— 测试与 UI 都靠它。
 * @param scores 可选的「引擎局面分」（见 `AidScore`）：由调用侧用与学习面板同一把
 *   尺子（`aiRootOrder` + `evalForSide`）算好传入，让云端模型挑候选时能参考
 *   "引擎眼里的优劣"而不是纯凭感觉。按 from/to 配对，翻子候选没有。
 * @throws AidNotConfigured 配置不全
 * @throws Error HTTP 失败 / 超时 / 模型没给出可解析的编号 / 没有合法着法
 */
export async function aiAidSuggest(
  cfg: AidConfig,
  pos: Position,
  mover: Side,
  opts: RuleOptions,
  revealAll: boolean,
  signal?: AbortSignal,
  revealCells?: readonly number[],
  avoid?: readonly AidAvoidMove[],
  scores?: readonly AidScore[],
): Promise<AidSuggestion> {
  // 翻棋开局**尚未定色**时 `mover` 是 `Side.None`：这时唯一能做的是翻子，
  // 拿它去跑 `allLegalMoves` 只会把空格当成"无主之子"算出垃圾着法。
  const raw: AidCandidate[] =
    mover === Side.None
      ? []
      : allLegalMoves(pos, mover, opts).map((m) => ({ ...m, reveal: false }));
  for (const c of revealCells ?? []) {
    raw.push({ from: c, to: c, capture: false, rail: false, reveal: true });
  }
  if (!raw.length) throw new Error("当前没有合法着法");

  // 把"会回到旧局面 / 这枚子老在挪"的那几条**标出来并排到队尾**（编号随之改变，
  // 表里是自洽的）。仍留在候选里：全被标满时模型还有得选，只是不再优先挑它们。
  // 顺带把两条判据的计数带上 —— prompt 里说成"第 N 次"才有说服力。
  const moves: AidCandidate[] = avoid?.length
    ? (() => {
        const marks = new Map(
          avoid.map((m) => [m.from * CELLS + m.to, { t: m.times ?? 0, s: m.shuffle ?? 1 }]),
        );
        const tagged = raw.map((m) => {
          const hit = marks.get(m.from * CELLS + m.to);
          if (!hit) return m;
          const out: AidCandidate = { ...m, avoid: true };
          if (hit.t) out.avoidTimes = hit.t;
          if (hit.s > 1) out.shuffleTimes = hit.s;
          return out;
        });
        // `filter` 两趟 = 稳定分区，组内保持 `allLegalMoves` 原来的顺序。
        return [...tagged.filter((m) => !m.avoid), ...tagged.filter((m) => m.avoid)];
      })()
    : raw;

  // 把调用侧算好的「引擎局面分」按 from/to 配到对应走子候选上（翻子没有这一步）。
  // 用 map 而不是每候选都 `find`，候选几十条时避免 O(n²)。
  if (scores?.length) {
    const byKey = new Map(scores.map((s) => [s.from * CELLS + s.to, s.score]));
    for (const m of moves) {
      if (m.reveal) continue;
      const sc = byKey.get(m.from * CELLS + m.to);
      if (sc !== undefined) m.engineScore = sc;
    }
  }

  // 翻棋要额外藏住"自己的暗子"（见 describeBoard 的 hideAllUnknown）。
  const board = describeBoard(pos, mover, revealAll, revealCells !== undefined);
  const body = {
    model: cfg.model.trim(),
    temperature: cfg.temperature ?? 0.3,
    messages: [
      { role: "system", content: SYS_PROMPT },
      { role: "user", content: userPrompt(board, moves, pos, mover) },
    ],
  };

  const { content, sawReasoning, viaProxy } = await postChat(cfg, body, signal);
  const parsed = parseAnswer(content);
  if (!parsed)
    throw new Error(
      `模型没给出可解析的着法：${content.slice(0, 80)}` +
        (sawReasoning ? "（该模型是思考型，建议改用 deepseek-chat）" : ""),
    );
  if (parsed.n < 0 || parsed.n >= moves.length)
    throw new Error(`模型选项越界（n=${parsed.n} / 共 ${moves.length} 条）`);
  const mv = moves[parsed.n];
  return {
    from: mv.from,
    to: mv.to,
    index: parsed.n,
    why: parsed.why,
    total: moves.length,
    reveal: mv.reveal,
    ...(viaProxy ? { viaProxy } : {}),
  };
}

/**
 * 棋盘行列的调试文本（把盘面摊成 `行,列=类型码` 的一行，方便肉眼核对 prompt）。
 *
 * ⚠️ 目前**没有**任何地方调用它 —— 曾经计划做 `?aid=1` 自检路由，后来改成
 * 在 `tests/run.ts` 第 19 节里桩掉 `fetch` 直接测 `aiAidSuggest()`，那个路由
 * 就没建。留着是给调 prompt 时手工在 console 里用，别当成还有自检入口。
 */
export function boardRowsText(pos: Position): string {
  const out: string[] = [];
  for (let i = 0; i < CELLS; i++) {
    if (i % 5 === 0) out.push(`\n行${String(rowOf(i)).padStart(2, " ")} `);
    out.push(`${rowOf(i)},${colOf(i)}=${pos.type[i] as number}`);
  }
  return out.join(" ");
}
