/**
 * プレビューレンダラーの純粋ロジック（UI・WebGL 非依存）。
 *
 * ここに切り出した関数は副作用を持たず、`tests/preview-math.test.ts` で単体
 * テストできる。WebGL / Canvas 2D の両バックエンドがこれらを共有する。
 */

/** バッキングストア解像度を決める devicePixelRatio の上限（§4.5）。 */
export const MAX_DEVICE_PIXEL_RATIO = 2;

/** Canvas 2D フォールバックのドラフト描画の長辺（§7：100ms 以内）。 */
export const DRAFT_LONG_EDGE = 512;

/** Canvas 2D フォールバックのフル描画の長辺（§4.6：プレビュー解像度）。 */
export const FULL_LONG_EDGE = 2048;

/**
 * devicePixelRatio を [1, max] にクランプする。
 * 高 DPI 端末での過大な描画コスト・メモリ消費を避ける（§4.5）。
 */
export function clampDevicePixelRatio(dpr: number, max: number = MAX_DEVICE_PIXEL_RATIO): number {
  if (!Number.isFinite(dpr) || dpr <= 0) return 1;
  return Math.min(dpr, max);
}

/** 3D LUT テクスチャの半テクセルオフセット係数（格子端の色ズレ防止）。 */
export interface LutTexelParams {
  /** 入力 [0,1] に乗じるスケール `(N-1)/N`。 */
  scale: number;
  /** 加算するオフセット `0.5/N`（最初のテクセル中心へ寄せる）。 */
  offset: number;
}

/**
 * 格子解像度 N から 3D テクスチャサンプリング用の scale/offset を求める。
 *
 * 入力 c∈[0,1] を `c·scale + offset` に写像すると、c=0 が最初のテクセル中心
 * `0.5/N`、c=1 が最後のテクセル中心 `(N-0.5)/N` に一致する。これが LUT を
 * 3D テクスチャで補間する際の定石（格子端の半テクセル分の色ズレを防ぐ）。
 */
export function lutHalfTexel(n: number): LutTexelParams {
  return { scale: (n - 1) / n, offset: 0.5 / n };
}

/**
 * ビュー変換：画像ピクセル → キャンバス CSS ピクセルへの写像。
 * @property scale   CSS ピクセル / 画像ピクセル（1=100% 表示、1 画像 px=1 CSS px）
 * @property offsetX 画像左上のキャンバス内 CSS X 座標
 * @property offsetY 画像左上のキャンバス内 CSS Y 座標
 */
export interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** 恒等（等倍・左上原点）のビュー変換。 */
export const IDENTITY_TRANSFORM: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 };

/**
 * 画像をビュー領域に収める（contain / フィット）ビュー変換を求める。
 * ジェスチャー処理は UI 側の責務で、UI はこの結果を `setViewTransform` に渡す。
 * @param imageW/imageH 画像ピクセルサイズ
 * @param viewW/viewH   ビュー領域の CSS ピクセルサイズ
 */
export function computeFitTransform(
  imageW: number,
  imageH: number,
  viewW: number,
  viewH: number,
): ViewTransform {
  if (imageW <= 0 || imageH <= 0 || viewW <= 0 || viewH <= 0) {
    return { ...IDENTITY_TRANSFORM };
  }
  const scale = Math.min(viewW / imageW, viewH / imageH);
  return {
    scale,
    offsetX: (viewW - imageW * scale) / 2,
    offsetY: (viewH - imageH * scale) / 2,
  };
}

/**
 * 100%（等倍）表示のビュー変換（画像をビュー中央に置く）。
 */
export function computeHundredPercentTransform(
  imageW: number,
  imageH: number,
  viewW: number,
  viewH: number,
): ViewTransform {
  return {
    scale: 1,
    offsetX: (viewW - imageW) / 2,
    offsetY: (viewH - imageH) / 2,
  };
}

/** ピクセルサイズ（幅・高さ）。 */
export interface PixelSize {
  w: number;
  h: number;
}

/**
 * 長辺を `longEdge` に制限した作業解像度を求める（Canvas 2D の段階的レンダリング用）。
 * 画像が既に十分小さければそのまま返す。
 */
export function workingSize(imageW: number, imageH: number, longEdge: number): PixelSize {
  const maxEdge = Math.max(imageW, imageH);
  if (maxEdge <= 0) return { w: 1, h: 1 };
  if (maxEdge <= longEdge) return { w: Math.max(1, imageW), h: Math.max(1, imageH) };
  const s = longEdge / maxEdge;
  return {
    w: Math.max(1, Math.round(imageW * s)),
    h: Math.max(1, Math.round(imageH * s)),
  };
}

/** バッキングストア（描画バッファ）解像度。 */
export interface BackingStoreSize {
  width: number;
  height: number;
}

/**
 * CSS サイズと devicePixelRatio からバッキングストア解像度を求める。
 * dpr は §4.5 に従い上限 2 でクランプする。
 */
export function backingStoreSize(cssW: number, cssH: number, dpr: number): BackingStoreSize {
  const d = clampDevicePixelRatio(dpr);
  return {
    width: Math.max(1, Math.round(cssW * d)),
    height: Math.max(1, Math.round(cssH * d)),
  };
}

/** split 位置（0–1）を [0,1] にクランプする。 */
export function clampSplit(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
