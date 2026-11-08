/**
 * 9 宫格皮肤绘制 —— 使用原版 `data/720x/ui/*.cfg` 里记录的切线。
 *
 * cfg 格式：`<图片名>,<x1>,<y1>,<x2>,<y2>`，其中 x1/x2 是纵向切线、
 * y1/y2 是横向切线（源图像素）。由此换算 CSS 语义的 slice = [上,右,下,左]。
 */

export interface Skin {
  img: HTMLImageElement;
  slice: [number, number, number, number];
}

/** 把原版 cfg 切线换算成 [上,右,下,左] slice。 */
export function sliceFromCut(
  cut: readonly [number, number, number, number],
  w: number,
  h: number,
): [number, number, number, number] {
  const [x1, y1, x2, y2] = cut;
  return [y1, w - x2, h - y2, x1];
}

/** 画一个 9 宫格控件（等价 CSS border-image）。 */
export function nineSlice(
  ctx: CanvasRenderingContext2D,
  skin: Skin,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  const im = skin.img;
  const [t, r, b, l] = skin.slice;
  const W = im.width;
  const H = im.height;

  // 中部源区
  const sw = Math.max(0, W - l - r);
  const sh = Math.max(0, H - t - b);

  const put = (sx: number, sy: number, sW: number, sH: number,
               tx: number, ty: number, tW: number, tH: number) => {
    if (sW <= 0 || sH <= 0 || tW <= 0 || tH <= 0) return;
    ctx.drawImage(im, sx, sy, sW, sH, tx, ty, tW, tH);
  };

  const mw = Math.max(0, dw - l - r); // 中部目标宽
  const mh = Math.max(0, dh - t - b);

  put(0, 0, l, t, dx, dy, l, t);                       // 左上
  put(W - r, 0, r, t, dx + dw - r, dy, r, t);           // 右上
  put(0, H - b, l, b, dx, dy + dh - b, l, b);           // 左下
  put(W - r, H - b, r, b, dx + dw - r, dy + dh - b, r, b); // 右下
  put(l, 0, sw, t, dx + l, dy, mw, t);                  // 上边
  put(l, H - b, sw, b, dx + l, dy + dh - b, mw, b);     // 下边
  put(0, t, l, sh, dx, dy + t, l, mh);                  // 左边
  put(W - r, t, r, sh, dx + dw - r, dy + t, r, mh);     // 右边
  put(l, t, sw, sh, dx + l, dy + t, mw, mh);            // 中部
}

/** 画一段可纵向拉伸的条（如列表项、滑块轴）。 */
export function drawStrip(
  ctx: CanvasRenderingContext2D,
  skin: Skin,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  nineSlice(ctx, skin, dx, dy, dw, dh);
}
