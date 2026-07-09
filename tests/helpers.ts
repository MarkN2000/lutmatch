/** テスト用ユーティリティ：決定的 PRNG と合成画素生成。 */

import { srgbToLinear } from '../src/core/colorspace.ts';

/** mulberry32：シード固定の決定的擬似乱数 [0,1)。 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 合成リニア RGBA 画素を生成する。
 * 先頭 256 画素は全ガンマビンを埋める対角グラデーション（CDF を厳密に単調増加にする）、
 * 残りはチャンネル独立のランダム値（共分散をフルランクにする）。
 */
export function makeLinearRgba(count: number, seed: number): Float32Array {
  const rng = mulberry32(seed);
  const px = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    let rg: number;
    let gg: number;
    let bg: number;
    if (i < 256) {
      const v = (i + 0.5) / 256;
      rg = v;
      gg = v;
      bg = v;
    } else {
      rg = (Math.floor(rng() * 256) + 0.5) / 256;
      gg = (Math.floor(rng() * 256) + 0.5) / 256;
      bg = (Math.floor(rng() * 256) + 0.5) / 256;
    }
    px[i * 4] = srgbToLinear(rg);
    px[i * 4 + 1] = srgbToLinear(gg);
    px[i * 4 + 2] = srgbToLinear(bg);
    px[i * 4 + 3] = 1;
  }
  return px;
}

/** パック RGB サンプルにアフィン変換 A·x+b を適用した新配列を返す。 */
export function affineSamples(samples: Float32Array, a: number[], b: number[]): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 3) {
    const x = samples[i];
    const y = samples[i + 1];
    const z = samples[i + 2];
    out[i] = a[0] * x + a[1] * y + a[2] * z + b[0];
    out[i + 1] = a[3] * x + a[4] * y + a[5] * z + b[1];
    out[i + 2] = a[6] * x + a[7] * y + a[8] * z + b[2];
  }
  return out;
}
