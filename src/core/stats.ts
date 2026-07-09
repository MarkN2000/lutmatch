/**
 * 統計計算（§5.1）。リニア RGB 画素配列から有効画素を抽出し、平均・共分散を求める。
 *
 * 入力ピクセルは **リニア RGB(A)** の `Float32Array`（sRGB→リニア変換は Worker 側で済ませる）。
 */

import { rec709Luminance } from './colorspace.ts';
import { mat3Invert } from './linalg.ts';
import type { ChannelCount, ColorStats, Mat3, SampleOptions, Vec3 } from './types.ts';

/** 統計推定が不安定になる下限の有効画素数（§5.1 / §5.2）。 */
export const N_MIN_PIXELS = 1024;

/** 共分散正則化係数の相対量。ε = trace(Σ)/3 × この値（§5.2）。 */
export const COV_REG_FACTOR = 1e-4;

/**
 * 共分散正則化の絶対下限（リニア RGB 分散の下限・§5.2）。
 *
 * 相対量 `trace/3 × COV_REG_FACTOR` だけでは暗部（低分散）画像で ε がほぼ 0 になり、
 * 収縮が効かず MKL の逆平方根ゲインが爆発する。8bit 量子化ノイズ相当（σ≒0.0032 リニア）
 * の分散を絶対下限として与え、`ε = max(trace/3 × COV_REG_FACTOR, MKL_EPS_ABS)` とする。
 */
export const MKL_EPS_ABS = 1e-5;

/**
 * リニア RGB(A) 画素配列から有効画素の RGB を抽出する（§5.1）。
 *
 * - RGBA の場合、アルファが `alphaThreshold` 未満の画素を除外
 * - Rec.709 リニア輝度が `blackThreshold` 未満の画素を除外（ブラック保護）
 *
 * @param pixels リニア RGB(A) の連続配列
 * @param channels 3=RGB / 4=RGBA
 * @param opts 抽出条件
 * @returns 有効画素の RGB をパックした `Float32Array`（長さ = 有効画素数×3）
 */
export function extractValidSamples(
  pixels: Float32Array,
  channels: ChannelCount,
  opts: SampleOptions,
): Float32Array {
  const stride = channels;
  const pxCount = Math.floor(pixels.length / stride);
  const out = new Float32Array(pxCount * 3);
  let n = 0;
  for (let i = 0; i < pxCount; i++) {
    const base = i * stride;
    if (channels === 4 && pixels[base + 3] < opts.alphaThreshold) continue;
    const r = pixels[base];
    const g = pixels[base + 1];
    const b = pixels[base + 2];
    if (rec709Luminance(r, g, b) < opts.blackThreshold) continue;
    out[n * 3] = r;
    out[n * 3 + 1] = g;
    out[n * 3 + 2] = b;
    n++;
  }
  return out.subarray(0, n * 3);
}

/**
 * パックされた RGB サンプル（長さ 3 の倍数）から平均・共分散を求める。
 * 共分散は母集団分散（n で割る）。サンプルが空なら零統計を返す。
 * @param samples リニア RGB のパック配列
 */
export function computeColorStats(samples: Float32Array): ColorStats {
  const count = Math.floor(samples.length / 3);
  const mean: Vec3 = [0, 0, 0];
  const cov: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  if (count === 0) return { mean, cov, count };

  for (let i = 0; i < count; i++) {
    mean[0] += samples[i * 3];
    mean[1] += samples[i * 3 + 1];
    mean[2] += samples[i * 3 + 2];
  }
  mean[0] /= count;
  mean[1] /= count;
  mean[2] /= count;

  let c00 = 0;
  let c01 = 0;
  let c02 = 0;
  let c11 = 0;
  let c12 = 0;
  let c22 = 0;
  for (let i = 0; i < count; i++) {
    const dr = samples[i * 3] - mean[0];
    const dg = samples[i * 3 + 1] - mean[1];
    const db = samples[i * 3 + 2] - mean[2];
    c00 += dr * dr;
    c01 += dr * dg;
    c02 += dr * db;
    c11 += dg * dg;
    c12 += dg * db;
    c22 += db * db;
  }
  const inv = 1 / count;
  cov[0] = c00 * inv;
  cov[1] = c01 * inv;
  cov[2] = c02 * inv;
  cov[3] = c01 * inv;
  cov[4] = c11 * inv;
  cov[5] = c12 * inv;
  cov[6] = c02 * inv;
  cov[7] = c12 * inv;
  cov[8] = c22 * inv;
  return { mean, cov, count };
}

/**
 * 共分散行列を正則化する：Σ ← Σ + εI。
 * ε = max(trace/3 × COV_REG_FACTOR, MKL_EPS_ABS)（相対量に絶対下限を課す・§5.2）。
 */
export function regularizeCov(cov: Mat3): Mat3 {
  const eps = Math.max(((cov[0] + cov[4] + cov[8]) / 3) * COV_REG_FACTOR, MKL_EPS_ABS);
  const r = cov.slice();
  r[0] += eps;
  r[4] += eps;
  r[8] += eps;
  return r;
}

/**
 * 正則化した共分散の逆行列を返す（マハラノビス距離用）。
 * 数値的に特異な場合は微小単位行列の逆で代替する。
 */
export function regularizedCovInv(cov: Mat3): Mat3 {
  const inv = mat3Invert(regularizeCov(cov));
  if (inv) return inv;
  return [1e6, 0, 0, 0, 1e6, 0, 0, 0, 1e6];
}
