import { defineConfig } from "vite";
import { aidRelayPlugin } from "./server/aidrelay.ts";

/**
 * 复刻工程构建配置。
 *
 * base 设为 "./" 让产物可以放在任意子路径下运行（本地 file:// 直开或部署到子目录均可）。
 * 关闭 sourcemap 压缩以保持源码可读 —— 这是「交付源代码」项目，可读性优先。
 *
 * ⚠️ assetsDir 刻意设为 "bundle"：`public/assets/` 里装的是**原版游戏位图/音效**，
 * 若沿用 Vite 默认的 `assets/` 输出目录，打包产物会与这些原始素材混在同一文件夹里。
 *
 * ⚠️ AI 援助中转（`/__aiaid/*`）**不在这里实现了**，见 `server/aidrelay.ts`：
 * 它要从 `npm test` 里被 import 起来跑真实网络往返（重试 / 隧道 / 断开作废），
 * 塞在配置文件里就没法单独引用了。这里只负责挂上插件。
 */

export default defineConfig({
  base: "./",
  plugins: [aidRelayPlugin()],
  build: {
    target: "es2022",
    outDir: "dist",
    assetsDir: "bundle",
    assetsInlineLimit: 0,
    sourcemap: true,
    minify: false,
  },
  server: {
    port: 5180,
    host: "127.0.0.1",
    open: false,
  },
});
