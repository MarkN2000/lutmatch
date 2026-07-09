/**
 * MKL（Monge-Kantorovich 線形化）線形カラーマッチ（§5.2）。
 *
 * 閉形式解 T = Σs^(-1/2)·(Σs^(1/2)·Σr·Σs^(1/2))^(1/2)·Σs^(-1/2) により、
 * 線形写像 f(x) = T(x − μs) + μr を得る。
 *
 * 破綻対策（実画像の異方的な色分布でのゲイン爆発への対処・§5.2）：
 *  1. **収縮正則化**：共分散 Σ+εI に絶対下限 `MKL_EPS_ABS` を課す（stats.ts）。
 *  2. **ゲイン上限クランプ**：対称正定値 T を固有分解し、方向別ゲイン（固有値）を
 *     `[1/MKL_MAX_GAIN, MKL_MAX_GAIN]` にクランプして再構成。
 *  3. **段階的フォールバック**：Source 分布の異方性に応じ、フル MKL 行列 T と
 *     チャンネル別対角スケール D=diag(σr_i/σs_i) の間を重み w で滑らかに補間。
 *  極少画素（n < `N_MIN_PIXELS`）時のみ平均シフト（T=I）へフォールバック＋UI 警告。
 */

import { mat3Identity, mat3Mul, symInvSqrt, symMatFunc, symSqrt } from './linalg.ts';
import { N_MIN_PIXELS, regularizeCov } from './stats.ts';
import { eigenSymmetric3 } from './linalg.ts';
import type { ColorStats, Mat3, Vec3 } from './types.ts';

/**
 * 方向別ゲイン（T の固有値）の上限。ゲインは `[1/MKL_MAX_GAIN, MKL_MAX_GAIN]` に
 * クランプされる。異方的な分布で `Σs^(-1/2)` の小固有値方向のゲインが爆発し、
 * 彩度・色相ノイズ（マゼンタのスペックル等）を生む問題を抑える（§5.2 / §13）。
 */
export const MKL_MAX_GAIN = 4.0;

/**
 * 段階的フォールバックの重み w を決める Source 共分散の異方性しきい値（min/max 固有値比）。
 * 比がこれ以上なら w=1（フル MKL を全面採用）。
 */
export const MKL_ANISO_FULL = 1e-2;

/**
 * 同上の下側しきい値。比がこれ以下なら w=0（対角スケール D のみを採用）。
 * `MKL_ANISO_FULL` との間は log 空間で smoothstep 補間する。
 */
export const MKL_ANISO_DIAG = 1e-4;

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

/** 対称正定値行列の min/max 固有値比（異方性の指標）。max≤0 なら 0。 */
function eigenRatio(sym: Mat3): number {
  const { values } = eigenSymmetric3(sym);
  let max = -Infinity;
  let min = Infinity;
  for (const v of values) {
    if (v > max) max = v;
    if (v < min) min = v;
  }
  if (max <= 0) return 0;
  return Math.max(0, min) / max;
}

/** スカラーを [1/MKL_MAX_GAIN, MKL_MAX_GAIN] にクランプ。 */
function clampGain(g: number): number {
  return Math.min(MKL_MAX_GAIN, Math.max(1 / MKL_MAX_GAIN, g));
}

/**
 * 輸送行列 T のゲイン上限クランプ。T は理論上対称正定値だが数値誤差で非対称になりうるため
 * (T+Tᵀ)/2 で対称化してから固有分解し、固有値（方向別ゲイン）をクランプして再構成する。
 */
function clampGainMatrix(t: Mat3): Mat3 {
  const s01 = (t[1] + t[3]) / 2;
  const s02 = (t[2] + t[6]) / 2;
  const s12 = (t[5] + t[7]) / 2;
  const sym: Mat3 = [t[0], s01, s02, s01, t[4], s12, s02, s12, t[8]];
  return symMatFunc(eigenSymmetric3(sym), clampGain);
}

/**
 * チャンネル別対角スケール D = diag(σr_i/σs_i)。分散は正則化済み（絶対下限あり）で受け取り、
 * 各比をゲインクランプする。チャンネルを混ぜないため色相ノイズを増幅しない退避先。
 */
function diagonalTransform(ssReg: Mat3, srReg: Mat3): Mat3 {
  const d0 = clampGain(Math.sqrt(srReg[0] / ssReg[0]));
  const d1 = clampGain(Math.sqrt(srReg[4] / ssReg[4]));
  const d2 = clampGain(Math.sqrt(srReg[8] / ssReg[8]));
  return [d0, 0, 0, 0, d1, 0, 0, 0, d2];
}

/**
 * フル MKL の採用重み w。Source 共分散の異方性比 r に対し、
 * r≥`MKL_ANISO_FULL`→1、r≤`MKL_ANISO_DIAG`→0、間は log 空間 smoothstep。
 * 異方的（小固有値方向のゲインが不安定）なほど対角 D 側へ寄せる。
 */
function fullMklWeight(ssReg: Mat3): number {
  const r = eigenRatio(ssReg);
  if (r >= MKL_ANISO_FULL) return 1;
  if (r <= MKL_ANISO_DIAG) return 0;
  const t =
    (Math.log(r) - Math.log(MKL_ANISO_DIAG)) /
    (Math.log(MKL_ANISO_FULL) - Math.log(MKL_ANISO_DIAG));
  return t * t * (3 - 2 * t);
}

/** 2 行列の凸結合 w·A + (1−w)·B。両者がゲイン範囲内なら結合後も範囲内（Rayleigh 商が保存）。 */
function blendMat3(a: Mat3, b: Mat3, w: number): Mat3 {
  const out = new Array<number>(9);
  for (let i = 0; i < 9; i++) out[i] = w * a[i] + (1 - w) * b[i];
  return out;
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

  // 完全退化（極少画素）：平均シフト（T=I）へフォールバック＋UI 警告。
  if (n < N_MIN_PIXELS) {
    return { transform: { T: mat3Identity(), muS, muR }, fallback: true };
  }

  const ss = regularizeCov(src.cov);
  const sr = regularizeCov(ref.cov);

  // フル MKL 行列 T をゲイン上限クランプして構成。
  const ssHalf = symSqrt(ss); // Σs^(1/2)
  const ssInvHalf = symInvSqrt(ss); // Σs^(-1/2)
  const m = mat3Mul(mat3Mul(ssHalf, sr), ssHalf); // Σs^(1/2)·Σr·Σs^(1/2)
  const mHalf = symSqrt(m); // (…)^(1/2)
  const tFull = clampGainMatrix(mat3Mul(mat3Mul(ssInvHalf, mHalf), ssInvHalf));

  // 段階的フォールバック：異方性に応じてフル MKL と対角スケール D を補間。
  const d = diagonalTransform(ss, sr);
  const w = fullMklWeight(ss);
  const t = blendMat3(tFull, d, w);

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
