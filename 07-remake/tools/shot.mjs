/**
 * `node tools/shot.mjs <url> <out.png> [waitMs] [w] [h]`
 *
 * 无头截图 —— 之所以不用 `chrome --screenshot`：本机沙箱会拒掉 Chrome 子进程
 * 自己写文件（"Failed to write file: 拒绝访问"），所以改走 CDP：
 * Chrome 只把 base64 吐回管道，落盘交给 Node。
 *
 * 依赖：Node ≥ 22（内置全局 WebSocket / fetch）。
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const url = process.argv[2];
const out = process.argv[3];
const waitMs = Number(process.argv[4] ?? 2500);
const W = Number(process.argv[5] ?? 1180);
const H = Number(process.argv[6] ?? 900);
if (!url || !out) {
  console.error("用法: node tools/shot.mjs <url> <out.png> [waitMs] [w] [h]");
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

const PORT = 9333;
const child = spawn(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    // 钉死设备像素比：截图要能和模拟器实拍（900×1600）逐像素比，
    // 就不能让宿主显示缩放掺进来。
    "--force-device-scale-factor=1",
    `--remote-debugging-port=${PORT}`,
    `--window-size=${W},${H}`,
    "--no-first-run",
    "--user-data-dir=" + (process.env.TEMP ?? "/tmp") + "/wb-shot-profile",
    url,
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

await send("Page.enable");
// 视口钉死（同 dom.mjs）：不靠窗口大小，直接覆盖设备度量，
// 这样 900×1600 就真的是 900×1600 CSS px，能和模拟器实拍逐像素比。
await send("Emulation.setDeviceMetricsOverride", {
  width: W,
  height: H,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.reload", { ignoreCache: true });
await sleep(waitMs); // 让页面自检 / 渲染跑完
const shot = await send("Page.captureScreenshot", { format: "png" });
if (!shot.result?.data) {
  console.error("截图失败: " + JSON.stringify(shot).slice(0, 300));
  child.kill();
  process.exit(1);
}
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log(`✓ ${out} (${W}x${H})`);
child.kill();
process.exit(0);
