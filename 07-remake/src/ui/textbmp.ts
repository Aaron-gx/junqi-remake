/**
 * 画布文字位图 —— 复刻原版「按设计尺寸光栅化，再整帧 ×1.25 双线性放大」的管线。
 *
 * 为什么不能直接用 DOM 文本：
 *   Chrome 会按**最终设备尺寸**重新光栅化文本，笔画比原版硬且粗
 *   （实测「纯白/中间灰」比 3.04 → 1.35，即文字明显更"实"）。
 *   `transform: scale()` 不解决问题（Chrome 仍按缩放后的尺寸光栅化），
 *   亚像素 `filter: blur()` 也被量化成 0。
 *   只有**位图**不会被重新光栅化 —— 把文字画进设计尺寸的 canvas，
 *   再交给 `--ds` 放大，浏览器就只会做双线性插值，与原版一致。
 *
 * 用法：拿到 `url` 与设计尺寸 `w/h`，用 `calc(<w>px * var(--ds))` 显示。
 */
export interface TextBitmap {
  url: string;
  /** 设计尺寸（px），显示时须乘 `--ds`。 */
  w: number;
  h: number;
}

const CACHE = new Map<string, TextBitmap>();

export interface TextBitmapOpts {
  text: string;
  /** CSS font-family 名，如 `"ZYKai"`。 */
  font: string;
  /** 设计字号 px。 */
  size: number;
  color: string;
  /** 位图尺寸（设计 px）——通常等于原版 XML 给的 `rect` 宽高。 */
  w: number;
  h: number;
  align?: "left" | "center" | "right";
  /** 左右内边距（设计 px），`align` 为 left/right 时生效。 */
  padX?: number;
  /** 纵向微调（设计 px）。 */
  dy?: number;
  /** 字距（设计 px）。 */
  ls?: number;
  /** 是否叠 `0 1px 1px rgba(0,0,0,.55)` 投影。 */
  shadow?: boolean;
}

/** 渲染一张设计尺寸的文字位图；同参数命中缓存。 */
export function textBitmap(o: TextBitmapOpts): TextBitmap {
  const key = [o.text, o.font, o.size, o.color, o.w, o.h, o.align, o.padX, o.dy, o.ls, o.shadow]
    .join("|");
  const hit = CACHE.get(key);
  if (hit) return hit;

  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(o.w));
  cv.height = Math.max(1, Math.round(o.h));
  const c = cv.getContext("2d");
  if (!c) return { url: "", w: cv.width, h: cv.height };

  const font = `${o.size}px ${o.font}`;
  c.font = font;
  // `letterSpacing` 是较新的 Canvas2D 属性，老环境忽略即可（字距退化为 0）。
  if (o.ls) {
    try {
      (c as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${o.ls}px`;
    } catch {
      /* 旧内核：忽略 */
    }
  }
  if (o.shadow) {
    c.shadowColor = "rgba(0,0,0,0.55)";
    c.shadowBlur = 1;
    c.shadowOffsetY = 1;
  }
  c.fillStyle = o.color;
  c.textBaseline = "alphabetic";
  c.textAlign = o.align ?? "center";

  // 纵向：用字体自身 ascent/descent 把墨迹盒在 `h` 里居中。
  const m = c.measureText("国");
  const asc = m.fontBoundingBoxAscent || o.size * 0.88;
  const desc = m.fontBoundingBoxDescent || o.size * 0.12;
  const base = (o.h - (asc + desc)) / 2 + asc + (o.dy ?? 0);

  let x = o.w / 2;
  const pad = o.padX ?? 0;
  if (o.align === "left") x = pad;
  else if (o.align === "right") x = o.w - pad;

  c.fillText(o.text, x, base);

  const out: TextBitmap = { url: cv.toDataURL("image/png"), w: cv.width, h: cv.height };
  CACHE.set(key, out);
  return out;
}

/** 字体加载完成后清缓存 —— 首次 `measureText` 可能落在 fallback 字体上。 */
export function clearTextBitmapCache(): void {
  CACHE.clear();
}
