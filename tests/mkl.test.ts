import { describe, expect, it } from 'vitest';
import { applyLinearTransform, buildMkl } from '../src/core/mkl.ts';
import { computeColorStats } from '../src/core/stats.ts';
import type { Vec3 } from '../src/core/types.ts';
import { affineSamples, makeLinearRgba } from './helpers.ts';

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
  it('グレースケール（ランク1共分散）でフォールバックが発火する', () => {
    // r=g=b の対角のみ → 共分散はランク1。
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
    expect(fallback).toBe(true);
    // フォールバックは T=I（平均シフト）。
    expect(transform.T).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('有効画素数が N_MIN 未満でフォールバックが発火する', () => {
    const src = toRgb(makeLinearRgba(4096, 1));
    const ref = toRgb(makeLinearRgba(4096, 2));
    const stats = computeColorStats(src);
    const refStats = computeColorStats(ref);
    const { fallback } = buildMkl(stats, refStats, 500);
    expect(fallback).toBe(true);
  });
});
