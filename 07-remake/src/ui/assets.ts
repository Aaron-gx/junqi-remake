/**
 * 素材装载器 —— 全部图像/音效均来自原版 APK 解包产物（`public/assets/`）。
 * 这些不是"仿制"的图形，而是原版 `data/720x/` 数据包里的原始位图。
 */

export interface SkinEntry {
  file: string;
  w: number;
  h: number;
  /** 9 宫格切线（源图坐标） */
  cut: [number, number, number, number];
  /** CSS 语义的 slice = [上, 右, 下, 左] */
  slice: [number, number, number, number];
  srcName: string;
}

export interface BoardArt {
  file: string;
  w: number;
  h: number;
  /** 中缝（行 5↔6 的中心距），用于按画布比例挑棋盘 */
  gap?: number;
  src?: string;
}

export interface AssetManifest {
  /** 主棋盘（原版 `datax#156`，720×1160，中缝 248） */
  board: BoardArt;
  /** 宽屏备选棋盘（原版 `datax#250`，720×1071，中缝 208） */
  boardWide?: BoardArt;
  pieceAtlas: {
    file: string;
    w: number;
    h: number;
    cols: number;
    rows: number;
    /** 单枚棋子面尺寸（= 图集单元尺寸，无分隔线） */
    tileW: number;
    tileH: number;
  };
  skin: Record<string, SkinEntry>;
  sound: Record<string, string>;
  ui: Record<string, string>;
  /** 文本资源（抽取时已从原版 GBK 转成 UTF-8） */
  text?: Record<string, { file: string; srcEncoding: string; src: string }>;
}

export interface Assets {
  manifest: AssetManifest;
  img: Record<string, HTMLImageElement>;
  audio: Record<string, HTMLAudioElement>;
  /** 从图集裁出的单枚棋子面，按 `side_row_col` 缓存 */
  tileCache: Map<string, HTMLCanvasElement>;
}

const BASE = "./assets/";

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("载入失败: " + url));
    im.src = url;
  });
}

export async function loadAssets(): Promise<Assets> {
  const manifest: AssetManifest = await (await fetch(BASE + "manifest.json")).json();

  const names = new Set<string>();
  names.add(manifest.board.file);
  if (manifest.boardWide) names.add(manifest.boardWide.file);
  names.add(manifest.pieceAtlas.file);
  for (const s of Object.values(manifest.skin)) names.add(s.file);
  for (const f of Object.values(manifest.ui)) names.add(f);

  const img: Record<string, HTMLImageElement> = {};
  await Promise.all(
    [...names].map(async (n) => {
      img[n] = await loadImage(BASE + n);
    }),
  );

  const audio: Record<string, HTMLAudioElement> = {};
  for (const [k, f] of Object.entries(manifest.sound)) {
    const a = new Audio(BASE + f);
    a.preload = "auto";
    a.volume = 0.7;
    audio[k] = a;
  }

  return { manifest, img, audio, tileCache: new Map() };
}

/** 从图集中裁出 (row, col) 的棋子面。 */
export function pieceTile(
  a: Assets,
  row: number,
  col: number,
): HTMLCanvasElement {
  const key = `${row}_${col}`;
  const hit = a.tileCache.get(key);
  if (hit) return hit;
  const at = a.manifest.pieceAtlas;
  const cw = at.tileW || at.w / at.cols; // 86
  const ch = at.tileH || at.h / at.rows; // 61
  const cv = document.createElement("canvas");
  cv.width = cw;
  cv.height = ch;
  const c = cv.getContext("2d")!;
  c.imageSmoothingEnabled = false;
  c.drawImage(a.img[at.file], col * cw, row * ch, cw, ch, 0, 0, cw, ch);
  a.tileCache.set(key, cv);
  return cv;
}

/**
 * 按画布宽高比挑棋盘 —— 复刻原版 `main.cfg` 的多套 `boardRc` 自适应行为。
 * 细高屏（aspect ≥ 1.55，如 900×1600 → 1.778）用 `#156`（中缝 248）；
 * 较矮屏用 `#250`（中缝 208）。
 */
export function pickBoard(a: Assets, aspect: number): BoardArt {
  const wide = a.manifest.boardWide;
  if (!wide) return a.manifest.board;
  return aspect >= 1.55 ? a.manifest.board : wide;
}

/** 从图集末行取一个纯色「棋子背面」块（翻棋用 col 0 的绿色）。 */
export function backTile(a: Assets, col: number): HTMLCanvasElement {
  const at = a.manifest.pieceAtlas;
  return pieceTile(a, at.rows - 1, col);
}

/** 播放音效（同一音效允许重叠播放）。 */
export function play(a: Assets, name: string): void {
  const src = a.audio[name];
  if (!src) return;
  try {
    const c = src.cloneNode(true) as HTMLAudioElement;
    c.volume = src.volume;
    // 必须吃掉这个 Promise：无头/自动播放受限时 play() 会 reject，
    // 未处理的 rejection 会冒到 window 上被当成页面错误弹出来。
    void c.play().catch(() => {});
  } catch {
    /* 忽略自动播放限制 */
  }
}
