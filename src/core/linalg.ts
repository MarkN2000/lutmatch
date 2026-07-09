/**
 * 3×3 行列・3 ベクトルの線形代数ユーティリティ（純粋関数）。
 *
 * 行列は行優先 `m[row*3 + col]`。対称行列の固有値分解（ヤコビ法）と、
 * それを用いた行列平方根・逆平方根・関数計算を提供する。MKL（§5.2）と
 * マハラノビス距離（§5.5）で共用する。
 */

import type { Mat3, Vec3 } from './types.ts';

/** 単位行列を返す。 */
export function mat3Identity(): Mat3 {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

/** 行列積 A·B（3×3）。 */
export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  const m = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      m[i * 3 + j] =
        a[i * 3 + 0] * b[0 * 3 + j] +
        a[i * 3 + 1] * b[1 * 3 + j] +
        a[i * 3 + 2] * b[2 * 3 + j];
    }
  }
  return m;
}

/** 転置 Aᵀ。 */
export function mat3Transpose(a: Mat3): Mat3 {
  return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
}

/** 行列×ベクトル A·v。`out` に書き込む（未指定なら新規配列）。 */
export function mat3MulVec(a: Mat3, v: Vec3, out?: Vec3): Vec3 {
  const x = v[0];
  const y = v[1];
  const z = v[2];
  const r = out ?? new Array<number>(3);
  r[0] = a[0] * x + a[1] * y + a[2] * z;
  r[1] = a[3] * x + a[4] * y + a[5] * z;
  r[2] = a[6] * x + a[7] * y + a[8] * z;
  return r;
}

/** 一般 3×3 逆行列。特異な場合は null。 */
export function mat3Invert(a: Mat3): Mat3 | null {
  const c00 = a[4] * a[8] - a[5] * a[7];
  const c01 = a[5] * a[6] - a[3] * a[8];
  const c02 = a[3] * a[7] - a[4] * a[6];
  const det = a[0] * c00 + a[1] * c01 + a[2] * c02;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
  const inv = 1 / det;
  return [
    c00 * inv,
    (a[2] * a[7] - a[1] * a[8]) * inv,
    (a[1] * a[5] - a[2] * a[4]) * inv,
    c01 * inv,
    (a[0] * a[8] - a[2] * a[6]) * inv,
    (a[2] * a[3] - a[0] * a[5]) * inv,
    c02 * inv,
    (a[1] * a[6] - a[0] * a[7]) * inv,
    (a[0] * a[4] - a[1] * a[3]) * inv,
  ];
}

/** 対称行列の固有値分解の結果。`values[k]` と `vectors` の第 k 列が対応。 */
export interface EigenResult {
  /** 固有値（3 個・順不同）。 */
  values: number[];
  /** 固有ベクトルを列に持つ直交行列 V（行優先）。A = V·diag(values)·Vᵀ。 */
  vectors: Mat3;
}

/**
 * 対称 3×3 行列の固有値分解（循環ヤコビ法・自前実装）。
 * @param input 対称行列（行優先）。上三角のみで対称性を仮定。
 * @returns 固有値と固有ベクトル（列）。
 */
export function eigenSymmetric3(input: Mat3): EigenResult {
  let a = input.slice();
  let v = mat3Identity();
  for (let iter = 0; iter < 100; iter++) {
    const off = Math.hypot(a[1], a[2], a[5]);
    if (off < 1e-18) break;
    const pairs: Array<[number, number]> = [
      [0, 1],
      [0, 2],
      [1, 2],
    ];
    for (const [p, q] of pairs) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-300) continue;
      const app = a[p * 3 + p];
      const aqq = a[q * 3 + q];
      const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      const j = mat3Identity();
      j[p * 3 + p] = c;
      j[q * 3 + q] = c;
      j[p * 3 + q] = s;
      j[q * 3 + p] = -s;
      // a ← Jᵀ·a·J（相似変換で対称性を保つ）
      a = mat3Mul(mat3Mul(mat3Transpose(j), a), j);
      v = mat3Mul(v, j);
    }
  }
  return { values: [a[0], a[4], a[8]], vectors: v };
}

/**
 * 対称行列に関数 g をスペクトル的に適用：V·diag(g(λ))·Vᵀ。
 * @param eig 固有分解結果
 * @param g 固有値に適用するスカラー関数
 */
export function symMatFunc(eig: EigenResult, g: (lambda: number) => number): Mat3 {
  const d = [g(eig.values[0]), g(eig.values[1]), g(eig.values[2])];
  const v = eig.vectors;
  const m = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += v[i * 3 + k] * d[k] * v[j * 3 + k];
      m[i * 3 + j] = s;
    }
  }
  return m;
}

/** 対称半正定値行列の平方根 A^(1/2)（固有値は 0 でクランプ）。 */
export function symSqrt(a: Mat3): Mat3 {
  return symMatFunc(eigenSymmetric3(a), (l) => Math.sqrt(Math.max(0, l)));
}

/** 対称正定値行列の逆平方根 A^(-1/2)（固有値は微小値でクランプ）。 */
export function symInvSqrt(a: Mat3): Mat3 {
  return symMatFunc(eigenSymmetric3(a), (l) => 1 / Math.sqrt(Math.max(l, 1e-12)));
}

/**
 * マハラノビス距離の二乗 d² = (x−μ)ᵀ Σ⁻¹ (x−μ)。
 * @param covInv 逆共分散行列 Σ⁻¹
 * @param x 対象ベクトル
 * @param mu 平均ベクトル
 */
export function mahalanobisSq(covInv: Mat3, x: Vec3, mu: Vec3): number {
  const dx = x[0] - mu[0];
  const dy = x[1] - mu[1];
  const dz = x[2] - mu[2];
  const px = covInv[0] * dx + covInv[1] * dy + covInv[2] * dz;
  const py = covInv[3] * dx + covInv[4] * dy + covInv[5] * dz;
  const pz = covInv[6] * dx + covInv[7] * dy + covInv[8] * dz;
  return dx * px + dy * py + dz * pz;
}
