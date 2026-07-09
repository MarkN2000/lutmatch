/**
 * 単一画像ローダー（§4.1）。
 *
 * File/Blob/URL から画像をデコードし、以下を返す：
 * - 解析用 `ImageData`（長辺 ≤ ANALYSIS_LONG_EDGE、sRGB 8bit RGBA、colorSpace='srgb' 明示）
 * - プレビュー用 `ImageBitmap`（長辺 ≤ PREVIEW_LONG_EDGE、開いたまま返す＝呼び出し側が dispose）
 *
 * ## 設計上の要点
 * - iOS Safari の canvas 面積上限（~16.7MP）を避けるため、フル解像度は決して canvas に描かない。
 *   元寸法は「使い捨ての createImageBitmap → width/height 読取 → 即 close」で取得する。
 * - リサイズは resizeWidth / resizeHeight の **どちらか一方だけ** を渡し、アスペクト比はブラウザ任せ。
 * - 元の長辺を超えて拡大しない（`Math.min(longEdge, originalLongEdge)`）。
 * - Display P3 等の広色域画像を確実に sRGB へ寄せるため、2D コンテキストと getImageData の
 *   両方に `colorSpace: 'srgb'` を明示する。
 * - 透明 PNG のアルファはそのまま `ImageData` に保持する（アルファ<50% の統計除外は
 *   core/stats.ts の extractValidSamples が行うので、ここでは何もしない）。
 */

/** 解析画像の目標長辺（px）。チューニング可能なよう定数化（§4.1）。 */
export const ANALYSIS_LONG_EDGE = 512;
/** プレビュー画像の目標長辺（px）。 */
export const PREVIEW_LONG_EDGE = 2048;

/** 画像ロードエラーの種別。 */
export type ImageLoadErrorKind = 'unsupported-format' | 'decode-failed';

/** 画像ロード失敗を表す型付きエラー。 */
export class ImageLoadError extends Error {
  readonly kind: ImageLoadErrorKind;
  constructor(kind: ImageLoadErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ImageLoadError';
    this.kind = kind;
  }
}

/** ロード結果。 */
export interface LoadedImage {
  /** プレビュー用ビットマップ（長辺 ≤ PREVIEW_LONG_EDGE・開いたまま・呼び出し側が dispose）。 */
  previewBitmap: ImageBitmap;
  /** 解析用画素（長辺 ≤ ANALYSIS_LONG_EDGE・sRGB 8bit RGBA・colorSpace='srgb'）。 */
  analysisData: ImageData;
  /** 元（EXIF 補正後）の幅。 */
  width: number;
  /** 元（EXIF 補正後）の高さ。 */
  height: number;
  /** previewBitmap を閉じる（冪等・二重呼び出し安全）。 */
  dispose(): void;
}

// ブラウザが確実にデコードできる MIME（ホワイトリスト）。
const SUPPORTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
// デコード不可を強く示唆する拡張子（RAW / HEIC 等）。
const UNSUPPORTED_EXT = new Set([
  'heic',
  'heif',
  'avif',
  'tiff',
  'tif',
  'bmp',
  'raw',
  'cr2',
  'cr3',
  'nef',
  'arw',
  'dng',
  'orf',
  'rw2',
]);

/**
 * デコード失敗を種別に分類する（ベストエフォート）。
 *
 * ブラウザは「なぜデコードできなかったか」を確実には教えてくれないため、Blob の `.type`
 * （MIME）と、File の場合はファイル名の拡張子からヒューリスティックに判定する：
 * - MIME がサポート集合外、または拡張子が既知の非対応集合に含まれる → 'unsupported-format'
 * - それ以外（対応フォーマットのはずが壊れている等） → 'decode-failed'
 * HEIC 固有のユーザー案内文言は UI 層の責務であり、本モジュールは種別のみ返す。
 */
function classifyDecodeFailure(source: Blob, cause: unknown): ImageLoadError {
  const mime = source.type.toLowerCase();
  let ext = '';
  if (typeof File !== 'undefined' && source instanceof File) {
    const dot = source.name.lastIndexOf('.');
    if (dot >= 0) ext = source.name.slice(dot + 1).toLowerCase();
  }
  const knownUnsupported =
    UNSUPPORTED_EXT.has(ext) || (mime.startsWith('image/') && !SUPPORTED_MIME.has(mime));
  if (knownUnsupported) {
    return new ImageLoadError(
      'unsupported-format',
      `未対応の画像フォーマットです（type='${source.type}'${ext ? `, ext='${ext}'` : ''}）`,
      { cause },
    );
  }
  return new ImageLoadError('decode-failed', '画像のデコードに失敗しました', { cause });
}

/** 目標長辺と元寸法から、実際のリサイズ目標長辺を求める（拡大しない）。 */
function targetLongEdge(longEdge: number, originalWidth: number, originalHeight: number): number {
  return Math.min(longEdge, Math.max(originalWidth, originalHeight));
}

/**
 * 2D コンテキストを取得できる canvas（Offscreen 優先・DOM フォールバック）を作る。
 * Worker 等 `document` の無い環境も考慮し、両方の存在をガードする。
 */
function createCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new ImageLoadError(
    'decode-failed',
    'この環境では canvas が利用できません（OffscreenCanvas / document いずれも不在）',
  );
}

/**
 * ビットマップを canvas に描画し sRGB の `ImageData` を取り出す。
 * 2D コンテキストと getImageData の両方に colorSpace='srgb' を明示（広色域対策・§4.1）。
 */
function bitmapToImageData(bitmap: ImageBitmap): ImageData {
  const canvas = createCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) {
    throw new ImageLoadError('decode-failed', '2D コンテキストを取得できませんでした');
  }
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height, { colorSpace: 'srgb' });
}

/** createImageBitmap をエラー分類付きで呼ぶ。 */
async function decodeBitmap(
  source: Blob,
  options: ImageBitmapOptions,
): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(source, options);
  } catch (err) {
    throw classifyDecodeFailure(source, err);
  }
}

/**
 * File / Blob / URL 文字列から画像を読み込む。
 * @param input File・Blob、または fetch する URL 文字列
 */
export async function loadImage(input: File | Blob | string): Promise<LoadedImage> {
  // URL 文字列なら fetch して Blob 化。
  let blob: Blob;
  if (typeof input === 'string') {
    try {
      const res = await fetch(input);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      blob = await res.blob();
    } catch (err) {
      throw new ImageLoadError('decode-failed', `画像の取得に失敗しました: ${input}`, {
        cause: err,
      });
    }
  } else {
    blob = input;
  }

  // 元寸法を取得：使い捨てフルデコード → width/height 読取 → 即 close（canvas には描かない）。
  const probe = await decodeBitmap(blob, { imageOrientation: 'from-image' });
  const originalWidth = probe.width;
  const originalHeight = probe.height;
  probe.close();

  // 解析用：長辺 ANALYSIS_LONG_EDGE にリサイズ（片軸のみ指定）。
  const analysisEdge = targetLongEdge(ANALYSIS_LONG_EDGE, originalWidth, originalHeight);
  const analysisBitmap = await decodeBitmap(blob, {
    imageOrientation: 'from-image',
    ...(originalWidth >= originalHeight
      ? { resizeWidth: analysisEdge }
      : { resizeHeight: analysisEdge }),
  });
  let analysisData: ImageData;
  try {
    analysisData = bitmapToImageData(analysisBitmap);
  } finally {
    analysisBitmap.close(); // 解析ビットマップは公開しない（ImageData のみ返す）。
  }

  // プレビュー用：長辺 PREVIEW_LONG_EDGE にリサイズし、開いたまま返す。
  const previewEdge = targetLongEdge(PREVIEW_LONG_EDGE, originalWidth, originalHeight);
  const previewBitmap = await decodeBitmap(blob, {
    imageOrientation: 'from-image',
    ...(originalWidth >= originalHeight
      ? { resizeWidth: previewEdge }
      : { resizeHeight: previewEdge }),
  });

  let disposed = false;
  return {
    previewBitmap,
    analysisData,
    width: originalWidth,
    height: originalHeight,
    dispose(): void {
      if (disposed) return; // 冪等
      disposed = true;
      previewBitmap.close();
    },
  };
}
