import { describe, expect, it } from 'vitest';
import {
  applyLinearTransform,
  buildMkl,
  MKL_ANISO_DIAG,
  MKL_MAX_GAIN,
} from '../src/core/mkl.ts';
import { eigenSymmetric3 } from '../src/core/linalg.ts';
import { computeColorStats } from '../src/core/stats.ts';
import type { ColorStats, Mat3, Vec3 } from '../src/core/types.ts';
import { affineSamples, makeLinearRgba } from './helpers.ts';

/** 平均 0・対角共分散を持つ疑似統計を直接作る（画素生成を経ない）。 */
function statsFromCovDiag(vr: number, vg: number, vb: number): ColorStats {
  return { mean: [0, 0, 0], cov: [vr, 0, 0, 0, vg, 0, 0, 0, vb], count: 100000 };
}

/** 対称 3×3 の固有値（昇順）。 */
function sortedEigen(m: Mat3): number[] {
  return eigenSymmetric3(m).values.slice().sort((a, b) => a - b);
}

/** RGBA から RGB のみ抜き出す（helpers の makeLinearRgba は RGBA を返す）。 */
function toRgb(rgba: Float32Array): Float32Array {
  const n = rgba.length / 4;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = rgba[i * 4];
    out[i * 3 + 1] = rgba[i * 4 + 1];
    out[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return out;
}

describe('MKL 閉形式解', () => {
  it('既知アフィンで作った Reference の統計に変換後統計が一致する', () => {
    const src = toRgb(makeLinearRgba(4096, 42));
    const a = [1.2, 0.1, 0.0, 0.0, 0.9, 0.15, 0.05, 0.0, 1.1];
    const b = [0.03, -0.02, 0.04];
    const ref = affineSamples(src, a, b);

    const srcStats = computeColorStats(src);
    const refStats = computeColorStats(ref);
    const { transform, fallback } = buildMkl(srcStats, refStats, srcStats.count);
    expect(fallback).toBe(false);

    // src を T で押し出して統計を再計算 → ref に一致するはず。
    const mapped = new Float32Array(src.length);
    const out: Vec3 = [0, 0, 0];
    for (let i = 0; i < src.length; i += 3) {
      applyLinearTransform(transform, src[i], src[i + 1], src[i + 2], out);
      mapped[i] = out[0];
      mapped[i + 1] = out[1];
      mapped[i + 2] = out[2];
    }
    const mappedStats = computeColorStats(mapped);

    for (let k = 0; k < 3; k++) {
      expect(Math.abs(mappedStats.mean[k] - refStats.mean[k])).toBeLessThan(1e-4);
    }
    for (let k = 0; k < 9; k++) {
      expect(Math.abs(mappedStats.cov[k] - refStats.cov[k])).toBeLessThan(1e-3);
    }
  });

  it('平均・共分散が等しいとき T ≈ I', () => {
    const src = toRgb(makeLinearRgba(4096, 7));
    const stats = computeColorStats(src);
    const { transform } = buildMkl(stats, stats, stats.count);
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let k = 0; k < 9; k++) {
      expect(Math.abs(transform.T[k] - I[k])).toBeLessThan(1e-4);
    }
  });
});

describe('MKL 退化対策', () => {
  it('有効画素数が N_MIN 未満でフォールバック（平均シフト T=I）が発火する', () => {
    const src = toRgb(makeLinearRgba(4096, 1));
    const ref = toRgb(makeLinearRgba(4096, 2));
    const stats = computeColorStats(src);
    const refStats = computeColorStats(ref);
    const { fallback, transform } = buildMkl(stats, refStats, 500);
    expect(fallback).toBe(true);
    expect(transform.T).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('グレースケール（ランク1共分散）はフォールバックせず、src=ref なら T≈I', () => {
    // r=g=b の対角のみ → 共分散はランク1（異方性最大）。段階的フォールバックにより
    // 平均シフトではなく対角スケール D 側へ寄る（w≈0）。src=ref なので D=I。
    const n = 4096;
    const gray = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = (i % 256) / 255;
      gray[i * 3] = v;
      gray[i * 3 + 1] = v;
      gray[i * 3 + 2] = v;
    }
    const stats = computeColorStats(gray);
    const { fallback, transform } = buildMkl(stats, stats, stats.count);
    expect(fallback).toBe(false);
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let k = 0; k < 9; k++) {
      expect(Math.abs(transform.T[k] - I[k])).toBeLessThan(1e-4);
    }
  });
});

describe('MKL ゲイン上限クランプ', () => {
  it('ゲイン差が大きいペアでも T の固有値が [1/MAX, MAX] に収まる', () => {
    // 等方だが分散比が極端（ref/src = 400 → 生ゲイン 20 倍）。異方性は低いので w=1。
    const src = statsFromCovDiag(1e-2, 1e-2, 1e-2);
    const ref = statsFromCovDiag(4.0, 4.0, 4.0);
    const { transform } = buildMkl(src, ref, 100000);
    const eig = sortedEigen(transform.T);
    expect(eig[2]).toBeLessThanOrEqual(MKL_MAX_GAIN + 1e-6);
    expect(eig[0]).toBeGreaterThanOrEqual(1 / MKL_MAX_GAIN - 1e-6);
    // 生ゲインは 20 なので上限で頭打ちになっているはず。
    expect(eig[2]).toBeGreaterThan(MKL_MAX_GAIN - 1e-6);
  });

  it('穏当なゲイン比ではクランプが発動しない（等方 ref/src=4 → ゲイン2）', () => {
    const src = statsFromCovDiag(0.02, 0.02, 0.02);
    const ref = statsFromCovDiag(0.08, 0.08, 0.08);
    const { transform } = buildMkl(src, ref, 100000);
    const eig = sortedEigen(transform.T);
    // すべて 2.0 付近（クランプ非発動）。
    for (const l of eig) expect(Math.abs(l - 2.0)).toBeLessThan(1e-3);
  });
});

describe('MKL 段階的フォールバック（異方性ブレンド）', () => {
  // Source を異方的（G/B 方向の分散が極小）にし、ref は等方。
  const anisoSrc = statsFromCovDiag(0.05, 1e-6, 1e-6);
  const isoRef = statsFromCovDiag(0.05, 0.05, 0.05);

  it('強い異方性では対角スケール D へ寄る（オフ対角がほぼ 0）', () => {
    const { transform } = buildMkl(anisoSrc, isoRef, 100000);
    const T = transform.T;
    // 対角のみ。オフ対角成分は無視できるほど小さい。
    for (const off of [T[1], T[2], T[3], T[5], T[6], T[7]]) {
      expect(Math.abs(off)).toBeLessThan(1e-3);
    }
    // 異方性比は MKL_ANISO_DIAG を大きく下回る → w=0（完全に D）。
    const { values } = eigenSymmetric3(anisoSrc.cov);
    const ratio = Math.min(...values) / Math.max(...values);
    expect(ratio).toBeLessThan(MKL_ANISO_DIAG);
  });

  it('等方に近い分布ではフル MKL で平均・共分散が Reference に一致する', () => {
    // 現実的な等方寄りペア（ブレンドが発動せずマッチ性能を維持）。
    const src = toRgb(makeLinearRgba(20000, 11));
    const a = [1.1, 0.05, 0.0, 0.0, 0.95, 0.08, 0.03, 0.0, 1.05];
    const b = [0.02, -0.01, 0.03];
    const ref = affineSamples(src, a, b);
    const ss = computeColorStats(src);
    const rs = computeColorStats(ref);
    const { transform, fallback } = buildMkl(ss, rs, ss.count);
    expect(fallback).toBe(false);

    const mapped = new Float32Array(src.length);
    const out: Vec3 = [0, 0, 0];
    for (let i = 0; i < src.length; i += 3) {
      applyLinearTransform(transform, src[i], src[i + 1], src[i + 2], out);
      mapped[i] = out[0];
      mapped[i + 1] = out[1];
      mapped[i + 2] = out[2];
    }
    const ms = computeColorStats(mapped);
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(ms.mean[k] - rs.mean[k])).toBeLessThan(1e-4);
    }
    for (let k = 0; k < 9; k++) {
      expect(Math.abs(ms.cov[k] - rs.cov[k])).toBeLessThan(1e-3);
    }
  });
});
