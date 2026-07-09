import { describe, expect, it } from 'vitest';
import { generateLut, trilinearSample } from '../src/core/lut.ts';
import { NEUTRAL_ADJUSTMENTS } from '../src/core/types.ts';
import type { GenerateLutOptions, MatchMode, Vec3 } from '../src/core/types.ts';
import { makeLinearRgba } from './helpers.ts';

const SAMPLE = { alphaThreshold: 0.5, blackThreshold: 0 };

function baseOptions(overrides: Partial<GenerateLutOptions>): GenerateLutOptions {
  return {
    mode: 'C',
    size: 17,
    strength: 85,
    smoothing: 20,
    manual: { ...NEUTRAL_ADJUSTMENTS },
    sample: SAMPLE,
    ...overrides,
  };
}

/** 格子点座標（Identity 期待値）との最大絶対誤差を求める。 */
function maxIdentityError(lut: Float32Array, n: number): number {
  const inv = 1 / (n - 1);
  let maxErr = 0;
  let idx = 0;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        maxErr = Math.max(maxErr, Math.abs(lut[idx++] - r * inv));
        maxErr = Math.max(maxErr, Math.abs(lut[idx++] - g * inv));
        maxErr = Math.max(maxErr, Math.abs(lut[idx++] - b * inv));
      }
    }
  }
  return maxErr;
}

describe('同一性テスト（Source=Reference・スムージング0・強度100%）', () => {
  const modes: MatchMode[] = ['A', 'B', 'C'];
  for (const mode of modes) {
    it(`モード ${mode}：LUT が Identity に一致（最大誤差 < 1e-3）`, () => {
      const px = makeLinearRgba(2048, 100);
      const { lut, size } = generateLut(
        px,
        px,
        4,
        baseOptions({ mode, strength: 100, smoothing: 0 }),
      );
      expect(maxIdentityError(lut, size)).toBeLessThan(1e-3);
    });
  }
});

describe('フォールバック警告', () => {
  it('有効画素 < N_MIN_PIXELS でフォールバックフラグが立つ', () => {
    const src = makeLinearRgba(500, 1); // < 1024
    const ref = makeLinearRgba(500, 2);
    const res = generateLut(src, ref, 4, baseOptions({ mode: 'A' }));
    expect(res.fallback).toBe(true);
  });

  it('十分な画素数ならフォールバックしない（フルランク）', () => {
    const src = makeLinearRgba(4096, 1);
    const ref = makeLinearRgba(4096, 2);
    const res = generateLut(src, ref, 4, baseOptions({ mode: 'A' }));
    expect(res.fallback).toBe(false);
  });

  it('ブラック保護で有効画素が減り N_MIN 未満になるとフォールバック', () => {
    // 全画素を暗部に寄せ、高い blackThreshold で大半を除外する。
    const n = 2000;
    const px = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      px[i * 4] = 0.01;
      px[i * 4 + 1] = 0.01;
      px[i * 4 + 2] = 0.01;
      px[i * 4 + 3] = 1;
    }
    const res = generateLut(
      px,
      px,
      4,
      baseOptions({ mode: 'C', sample: { alphaThreshold: 0.5, blackThreshold: 0.1 } }),
    );
    expect(res.fallback).toBe(true);
  });
});

describe('LUT 基本性質', () => {
  it('出力は全て [0,1] にクランプされている', () => {
    const src = makeLinearRgba(4096, 31);
    const ref = makeLinearRgba(4096, 37);
    const { lut } = generateLut(
      src,
      ref,
      4,
      baseOptions({ mode: 'C', manual: { ...NEUTRAL_ADJUSTMENTS, exposure: 2, contrast: 50 } }),
    );
    for (let i = 0; i < lut.length; i++) {
      expect(lut[i]).toBeGreaterThanOrEqual(0);
      expect(lut[i]).toBeLessThanOrEqual(1);
    }
  });

  it('trilinear 補間は格子点で厳密に一致する', () => {
    const src = makeLinearRgba(4096, 41);
    const ref = makeLinearRgba(4096, 43);
    const { lut, size } = generateLut(src, ref, 4, baseOptions({ mode: 'C' }));
    const out: Vec3 = [0, 0, 0];
    const inv = 1 / (size - 1);
    // いくつかの格子点で確認。
    for (const [r, g, b] of [
      [0, 0, 0],
      [size - 1, size - 1, size - 1],
      [3, 7, 11],
    ]) {
      trilinearSample(lut, size, r * inv, g * inv, b * inv, out);
      const idx = (r + g * size + b * size * size) * 3;
      expect(out[0]).toBeCloseTo(lut[idx], 6);
      expect(out[1]).toBeCloseTo(lut[idx + 1], 6);
      expect(out[2]).toBeCloseTo(lut[idx + 2], 6);
    }
  });
});

describe('ゴールデンテスト（回帰検知）', () => {
  it('決定的な合成ペアの LUT 格子点スナップショット', () => {
    const src = makeLinearRgba(4096, 12345);
    const ref = makeLinearRgba(4096, 67890);
    const { lut, size } = generateLut(
      src,
      ref,
      4,
      baseOptions({ mode: 'C', size: 17, strength: 85, smoothing: 20 }),
    );
    // 代表的な格子点をサンプルして丸め、スナップショット比較。
    const round = (v: number): number => Math.round(v * 1e5) / 1e5;
    const samples: Record<string, number[]> = {};
    for (const [r, g, b] of [
      [0, 0, 0],
      [8, 8, 8],
      [16, 16, 16],
      [4, 12, 2],
      [15, 3, 9],
    ]) {
      const idx = (r + g * size + b * size * size) * 3;
      samples[`${r},${g},${b}`] = [round(lut[idx]), round(lut[idx + 1]), round(lut[idx + 2])];
    }
    expect(samples).toMatchSnapshot();
  });
});
