/**
 * MKL（Monge-Kantorovich 線形化）線形カラーマッチ（§5.2）。
 *
 * 閉形式解 T = Σs^(-1/2)·(Σs^(1/2)·Σr·Σs^(1/2))^(1/2)·Σs^(-1/2) により、
 * 線形写像 f(x) = T(x − μs) + μr を得る。
 *
 * 退化対策：共分散正則化 Σ+εI、固有値 sqrt 前 0 クランプ、ランク落ち／極少画素時は
 * 平均シフト（T=I）へフォールバック。
 */

import { mat3Identity, mat3Mul, symInvSqrt, symSqrt } from './linalg.ts';
import { N_MIN_PIXELS, regularizeCov } from './stats.ts';
import { eigenSymmetric3 } from './linalg.ts';
import type { ColorStats, Mat3, Vec3 } from './types.ts';

/** ランク落ち判定のしきい値：min固有値/max固有値 がこれ未満なら退化とみなす。 */
export const MKL_RANK_RATIO = 1e-5;

/** 線形写像 f(x) = T(x − μs) + μr。 */
export interface LinearTransform {
  /** 線形部分 T（3×3）。 */
  T: Mat3;
  /** Source 平均 μs（リニア）。 */
  muS: Vec3;
  /** Reference 平均 μr（リニア）。 */
  muR: Vec3;
}

/** MKL 構築結果。 */
export interface MklResult {
  transform: LinearTransform;
  /** 平均シフトへフォールバックしたか（ランク落ち or 極少画素）。 */
  fallback: boolean;
}

/** 生共分散がランク落ちしているか（グレースケール等）を固有値比で判定。 */
function isRankDeficient(cov: Mat3): boolean {
  const { values } = eigenSymmetric3(cov);
  let max = -Infinity;
  let min = Infinity;
  for (const v of values) {
    if (v > max) max = v;
    if (v < min) min = v;
  }
  if (max <= 0) return true;
  return Math.max(0, min) / max < MKL_RANK_RATIO;
}

/**
 * MKL 線形写像を構築する（§5.2）。
 * @param src Source の色統計（リニア）
 * @param ref Reference の色統計（リニア）
 * @param n 有効画素数（両者の最小値を渡す）
 */
export function buildMkl(src: ColorStats, ref: ColorStats, n: number): MklResult {
  const muS = src.mean.slice();
  const muR = ref.mean.slice();

  // フォールバック条件：極少画素 or ランク落ち → 平均シフト（T=I）。
  if (n < N_MIN_PIXELS || isRankDeficient(src.cov) || isRankDeficient(ref.cov)) {
    return { transform: { T: mat3Identity(), muS, muR }, fallback: true };
  }

  const ss = regularizeCov(src.cov);
  const sr = regularizeCov(ref.cov);
  const ssHalf = symSqrt(ss); // Σs^(1/2)
  const ssInvHalf = symInvSqrt(ss); // Σs^(-1/2)
  const m = mat3Mul(mat3Mul(ssHalf, sr), ssHalf); // Σs^(1/2)·Σr·Σs^(1/2)
  const mHalf = symSqrt(m); // (…)^(1/2)
  const t = mat3Mul(mat3Mul(ssInvHalf, mHalf), ssInvHalf); // Σs^(-1/2)·…·Σs^(-1/2)

  return { transform: { T: t, muS, muR }, fallback: false };
}

/**
 * 線形写像を 1 画素に適用：out = T·(x − μs) + μr。中間段のためクランプしない。
 * @param tf 線形写像
 * @param r,g,b 入力リニア RGB
 * @param out 出力（長さ 3）
 */
export function applyLinearTransform(
  tf: LinearTransform,
  r: number,
  g: number,
  b: number,
  out: Vec3,
): Vec3 {
  const dr = r - tf.muS[0];
  const dg = g - tf.muS[1];
  const db = b - tf.muS[2];
  const t = tf.T;
  out[0] = t[0] * dr + t[1] * dg + t[2] * db + tf.muR[0];
  out[1] = t[3] * dr + t[4] * dg + t[5] * db + tf.muR[1];
  out[2] = t[6] * dr + t[7] * dg + t[8] * db + tf.muR[2];
  return out;
}
