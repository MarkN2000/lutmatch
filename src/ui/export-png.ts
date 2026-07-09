/**
 * 「適用後画像を PNG 保存」（§4.6）。
 *
 * プレビュー用ビットマップ（長辺 ≤ 2048px）に LUT を CPU 適用して PNG Blob を作る。
 * 描画バックエンド（WebGL/Canvas2D）に依存しないよう、core の `trilinearSample`
 * で確実に同じ結果を得る。
 */

import { trilinearSample } from '../core/index.ts';
import type { Vec3 } from '../core/index.ts';

/**
 * LUT 適用後の PNG Blob を生成する。
 * @param bitmap プレビュー用ビットマップ（長辺 ≤ 2048px）
 * @param lut LUT データ（size³×3・R 最速・ガンマ RGB）
 * @param size 格子解像度
 */
export async function renderResultPng(
  bitmap: ImageBitmap,
  lut: Float32Array,
  size: number,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
  if (!ctx) throw new Error('2D コンテキストを取得できませんでした');
  ctx.drawImage(bitmap, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height, { colorSpace: 'srgb' });
  const data = imageData.data;
  const out: Vec3 = [0, 0, 0];
  const inv255 = 1 / 255;
  for (let i = 0; i < data.length; i += 4) {
    trilinearSample(lut, size, data[i] * inv255, data[i + 1] * inv255, data[i + 2] * inv255, out);
    data[i] = Math.round(out[0] * 255);
    data[i + 1] = Math.round(out[1] * 255);
    data[i + 2] = Math.round(out[2] * 255);
    // アルファはそのまま保持
  }
  ctx.putImageData(imageData, 0, 0);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG エンコードに失敗しました'));
    }, 'image/png');
  });
}
