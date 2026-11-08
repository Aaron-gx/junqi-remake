/**
 * `npm run probe` —— 一条命令跑完几何/交互自检。
 *
 * 做的事：起 vite（若 5180 已有人在跑就直接用）→ 无头 Chrome 打开 `?probe=1`
 * → 从导出的 DOM 里抠出 `<pre id="probeResult">` → 打印并做基本断言。
 *
 * 之所以要有这个：页面上「一模一样」这件事必须能被脚本反复验证，
 * 而不是靠肉眼截图。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = 5180;
const URL = `http://127.0.0.1:${PORT}/?probe=1`;

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  return process.env.CHROME_PATH ?? null;
}

async function reachable(url) {
  try {
    const r = await fetch(url, { method: "GET" });
    return r.ok;
  } catch {
    return false;
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { shell: false });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

const chrome = findChrome();
if (!chrome) {
  console.error("找不到 Chrome，请设置环境变量 CHROME_PATH 指向可执行文件。");
  process.exit(2);
}

let vite = null;
if (!(await reachable(`http://127.0.0.1:${PORT}/`))) {
  console.log(`· 启动 vite :${PORT} …`);
  vite = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["vite", "--port", String(PORT), "--host", "127.0.0.1"],
    { stdio: "ignore", shell: process.platform === "win32" },
  );
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await reachable(`http://127.0.0.1:${PORT}/`)) break;
  }
}

const { out } = await run(chrome, [
  "--headless=new",
  "--disable-gpu",
  "--virtual-time-budget=8000",
  "--window-size=1240,900",
  "--dump-dom",
  URL,
]);

if (vite) vite.kill();

const m = out.match(/<pre id="probeResult">([\s\S]*?)<\/pre>/);
if (!m) {
  console.error("未找到 probeResult —— 页面可能在自检前就报错了。");
  process.exit(1);
}
const text = m[1]
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, "&")
  .trim();

console.log(text);

const fails = [];
if (!/hitTest 60\/60/.test(text)) fails.push("hitTest 不是 60/60 互逆");
if (!/兵站=46 行营=10/.test(text)) fails.push("位图标记识别数量不等于 46 / 10");
const worst = text.match(/最大 ([\d.]+)px/);
if (worst && Number(worst[1]) > 3) fails.push(`几何残差过大：${worst[1]}px`);
// 「人机对战」必须直开翻棋·暗棋（原版 s10_flip.png 实拍），别退回布局全亮。
if (!/vsai .*✓ 与原版一致/.test(text))
  fails.push("「人机对战」默认开局不是翻棋·暗棋（应为 50 盖着 + 10 行营空）");
// 棋盘菜单 8 项同序，且「重新开始」弹「新局」对话框。
if (!/menu .*✓ 与原版同序/.test(text)) fails.push("棋盘菜单项数/顺序与原版不符");
// 「AI 援助」必须挂在**可见**的 ☰ 里（人机对战时第 9 格）；曾经它只在离屏侧栏 = 点不到。
if (!/aidmenu .*✓ AI 援助在可见菜单/.test(text))
  fails.push("人机对战的 ☰ 里没有「AI 援助」入口（或被挪回了不可见的侧栏）");
// **翻棋**（= 主菜单「人机对战」实际进的那个模式）也必须能调出「AI 援助」，
// 并且真的把建议画到盘上（数画布纯蓝像素）。这两条 2026-09-14 都真出过问题：
// ① 第 9 格曾只挂 `mode === "lay"` ⇒ 用户点「人机对战」后菜单里根本找不到；
// ② 翻棋 `draw()` 分支曾漏传 `aidPair` ⇒ 提示条有字而盘上一个框都没有。
if (!/aidflip .*✓ 人机对战\(翻棋\)也能调出 AI 援助/.test(text))
  fails.push("翻棋（人机对战）里调不出 AI 援助，或建议框没画到棋盘上");
// 等待模型回答时，第 9 格必须写「取消 AI 援助」（写「AI 援助」点下去却是取消 = 骗人）。
if (!/aidlabel .*✓ 标签如实反映点下去会怎样/.test(text))
  fails.push("等待中 ☰ 第 9 格仍写「AI 援助」，点下去却变成取消 —— 标签应当如实反映动作");
// ★ 出网方式必须走**同源中转**。2026-09-14 玩家实报「AI援助超时」，根因就在这里：
//   浏览器直连过不了跨域预检，更用不了本机代理（Chrome 只认系统代理）——
//   实测 api.openai.com 直连挂死 >9s，走 127.0.0.1:7897 只需 1.1s。
//   这条哨兵挂在 dev server 上，所以「中转不在」= 真的坏了（vite 配置/中间件被改掉）。
if (!/aidrelay .*✓ 能走中转/.test(text))
  fails.push("AI 援助没认出同源中转 `/__aiaid/relay`，会退回浏览器直连（需要代理的接口必超时）");
// 点一颗棋子「只是选中」不该清 AI 建议、也不该把 toast 顶回旧日志。
if (!/selkeep .*✓ 只是选中不动提示/.test(text))
  fails.push("点棋子选中就把 AI 建议/上一条日志冲掉了（afterTurn 的 silent 判定退化）");
if (!/newgame .*新局对话框 ✓/.test(text)) fails.push("“重新开始”没有弹“新局”对话框");
// ★ AI 观战：**两端**都得由 AI 驱动（旧 `aiTurn()` 只认蓝方 ⇒ 红方那半回合会原地空转）、
//   上帝视角真的把暗子摊开了、人的点击被拒（否则观战变成"开天眼替 AI 走"）、
//   指派成云端却没配 API 时要**优雅暂停并退回引擎**（不能抛异常、也不能空转）。
if (!/watch .*✓ 观战两端都由 AI 驱动/.test(text))
  fails.push("AI 观战未达预期（两端 AI / 上帝视角 / 拒人点击 至少一项不成立）");
if (!/云端未配置时优雅暂停并退回引擎=是/.test(text))
  fails.push("AI 观战：云端未配置时没有优雅暂停/退回引擎");
// ★ 「逐」档 + 学习面板 —— 用户"走得太快、来不及看思路"的两个对策。
//   逐手档必须**当场停住**（排了定时器就成了自动连走，等于没慢下来）；
//   学习面板必须**真算出候选**（行数 ≥3 且标出实际走的那条），否则只是个空壳。
if (!/逐档走一手即停=是/.test(text)) fails.push("「逐」档没有走一手即停（观战还是连走）");
if (!/学习面板：候选行=[1-9]/.test(text)) fails.push("学习面板没算出候选（空壳）");
if (!/学习面板：.*标出实际走的那条=1/.test(text))
  fails.push("学习面板没标出引擎实际落下的那一手");
// ★ 观战缺省必须是**暗棋** —— 用户要的正是"看 AI 在信息不全时怎么权衡"。
//   曾经缺省是明棋（`watchReveal=true`）：双方全亮，AI 和观者看到的一样多，没得学。
if (!/缺省暗棋=是/.test(text))
  fails.push("AI 观战缺省不是暗棋（应为布局 `revealAll=false`，AI 靠推理）");
// ★ 循环判和 = 两台 AI"谁都不过谁、在几个格之间来回磨"的**事后**兜底。
//   必须在第 3 次重复就判和；阈值/计数写错都会让它永远收不住（观战看着像死机）。
if (!/循环判和=是\(第3次重复\)/.test(text))
  fails.push("AI 观战没有在同一局面重复第 3 次时判和（会一直磨下去）");
// ★ 抗循环 = 同一问题的**事前**引导：把"走完会回到旧局面"的着法降权。
//   列表为空 ⇒ 引导形同虚设，只剩判和兜底（干等更久）。
if (!/规避着法=[1-9]/.test(text))
  fails.push("AI 观战没算出「会走回旧局面」的着法（引擎无从降权，防循环失效）");
// ★ 开局对话框的文案长度 —— 值位图固定 300 设计 px，**超出会被静默裁掉两端**
//   （不是溢出也不是换行，看起来就像"文字跑出按钮"）。实测踩过：
//   「暗棋（AI 靠推理）」= 366px。改文案后这条会立刻抓住。
if (!/开局框文案装得下=是/.test(text))
  fails.push("观战开局对话框有文案宽于按钮（值位图 300px，两端会被裁掉）");
// ★「AI 对战里能选翻棋」—— 玩法行必须**同时**写着「布局」和「翻棋」。
//   只显示当前值（旧版只写「布局」）时，用户看不见"翻棋"这三个字，
//   会直接判定"AI 对战做不了翻棋"（实测反馈原话就是"AI 对战增加翻棋"）。
if (!/选翻棋=是/.test(text))
  fails.push("观战开局框里看不见「翻棋」这个玩法（玩法行只写当前值）");
// ★ 切到翻棋后「明暗棋」行必须还在 —— 旧版这行整行消失，等于翻棋没有视角可选。
if (!/选翻棋=是·翻棋下仍可选视角/.test(text))
  fails.push("切到翻棋后「明暗棋」行没了（翻棋选不了全知/对局视角）");

// ★ 通用兜底：**任何**哨兵行里出现 `✗` 一律判失败。
//   为什么需要：具体断言是按"✓ 后面的文案"匹配的，新增哨兵时很容易忘了往上面补一条，
//   于是哨兵明明 ✗ 了、退出码却还是 0、最后还打印"✓ 自检通过"。
//   本项目真踩过：`aidflip` 蓝框断言失败（`蓝框px=0 ✗`）而 probe 仍 exit 0。
//   有了这条，以后加哨兵不用改这里也不会漏判。
for (const line of text.split("\n")) {
  const t = line.trim();
  if (!t.includes("✗")) continue;
  const msg = `哨兵报错：${t}`;
  if (!fails.some((f) => f.includes(t))) fails.push(msg);
}

if (fails.length) {
  console.error("\n✗ 自检未通过：\n  - " + fails.join("\n  - "));
  process.exit(1);
}
console.log("\n✓ 自检通过");
