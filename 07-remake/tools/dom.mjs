/**
 * `node tools/dom.mjs <url> <selector> [waitMs]`
 *
 * 无头浏览器里取一段页面文本（默认 `#probeResult`）并打印。
 *
 * 为什么不用 `chrome --dump-dom`：本机沙箱下 Chrome 子进程写到管道/文件都可能被拒，
 * 而且一旦页面里有"靠墙钟超时"的逻辑（`--virtual-time-budget` 会冻结 `Date.now()`），
 * `--dump-dom` 会**一直不退出**（曾挂 33 分钟）。走 CDP 才可控、可超时、可杀。
 *
 * 依赖：Node ≥ 22（内置 WebSocket / fetch）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const url = process.argv[2];
const selector = process.argv[3] ?? "#probeResult";
const waitMs = Number(process.argv[4] ?? 4000);
if (!url) {
  console.error("用法: node tools/dom.mjs <url> [selector] [waitMs]");
  process.exit(2);
}

const CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const chrome = CANDIDATES.find((p) => existsSync(p)) ?? process.env.CHROME_PATH;
if (!chrome) {
  console.error("找不到 Chrome，请设置 CHROME_PATH");
  process.exit(2);
}

const PORT = 9345;
const child = spawn(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    // 钉死设备像素比：截图要能和模拟器实拍（900×1600）逐像素比，
    // 就不能让宿主显示缩放掺进来。
    "--force-device-scale-factor=1",
    `--remote-debugging-port=${PORT}`,
    "--window-size=1180,900",
    "--no-first-run",
    "--user-data-dir=" + (process.env.TEMP ?? "/tmp") + "/wb-dom-profile",
    url,
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 兜底：无论如何都要收尾，别留僵尸进程。 */
const hardStop = setTimeout(() => {
  console.error("✗ 超时未取到结果，强杀 Chrome");
  child.kill();
  process.exit(1);
}, waitMs + 30000);

async function pickPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error("连不上 Chrome 调试端口");
}

const page = await pickPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
});
const send = (method, params = {}) =>
  new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

await send("Runtime.enable");
// 视口必须钉死：本机显示器缩放会让 `--window-size` 与 CSS 视口脱钩
// （900 宽的窗口曾变成 148 CSS px，几何自检的阈值就全乱了）。
// 用 CDP 覆盖设备度量最稳，与窗口大小无关。
const VW = Number(process.env.DOM_W ?? 900);
const VH = Number(process.env.DOM_H ?? 1600);
await send("Emulation.setDeviceMetricsOverride", {
  width: VW,
  height: VH,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
await sleep(waitMs);

let text = "";
for (let i = 0; i < 20; i++) {
  const r = await send("Runtime.evaluate", {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)});
      return el ? el.textContent : null; })()`,
    returnByValue: true,
  });
  text = r.result?.result?.value ?? "";
  if (text) break;
  await sleep(500);
}

clearTimeout(hardStop);
if (!text) {
  console.error(`✗ 没找到 ${selector}（页面可能没跑自检）`);
  child.kill();
  process.exit(1);
}
console.log(text);
child.kill();
process.exit(0);
