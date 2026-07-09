import { describe, expect, it } from 'vitest';
import { srgbToLinear } from '../src/core/colorspace.ts';
import { applyCurveGamma, buildHistMatch, HM_BINS } from '../src/core/histmatch.ts';
import { makeLinearRgba } from './helpers.ts';

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

describe('HM カーブ', () => {
  it('単調非減少である', () => {
    const src = toRgb(makeLinearRgba(4096, 3));
    const ref = toRgb(makeLinearRgba(4096, 9));
    const curves = buildHistMatch(src, ref);
    for (const curve of curves) {
      for (let i = 1; i <= HM_BINS; i++) {
        expect(curve.y[i]).toBeGreaterThanOrEqual(curve.y[i - 1] - 1e-12);
      }
    }
  });

  it('Source=Reference のときガンマ空間で恒等に近い', () => {
    const src = toRgb(makeLinearRgba(4096, 5));
    const curves = buildHistMatch(src, src);
    for (const curve of curves) {
      for (let i = 0; i <= 100; i++) {
        const x = i / 100;
        expect(Math.abs(applyCurveGamma(curve, x) - x)).toBeLessThan(1e-3);
      }
    }
  });

  it('範囲 [0,1] 外は端点傾きで線形外挿する', () => {
    const src = toRgb(makeLinearRgba(4096, 11));
    const ref = toRgb(makeLinearRgba(4096, 13));
    const curve = buildHistMatch(src, ref)[0];
    // 低端外挿：y(x) = y[0] + loSlope·x
    const xLo = -0.2;
    expect(applyCurveGamma(curve, xLo)).toBeCloseTo(curve.y[0] + curve.loSlope * xLo, 10);
    // 高端外挿：y(x) = y[HM_BINS] + hiSlope·(x−1)
    const xHi = 1.3;
    expect(applyCurveGamma(curve, xHi)).toBeCloseTo(
      curve.y[HM_BINS] + curve.hiSlope * (xHi - 1),
      10,
    );
  });

  it('カーブは全域で単調（外挿域も含む）', () => {
    const src = toRgb(makeLinearRgba(4096, 17));
    const ref = toRgb(makeLinearRgba(4096, 19));
    const curve = buildHistMatch(src, ref)[1];
    let prev = -Infinity;
    for (let i = -20; i <= 120; i++) {
      const v = applyCurveGamma(curve, i / 100);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });
});

describe('HM 適用（リニア入出力）', () => {
  it('恒等カーブはリニア値も往復する（Source=Reference）', () => {
    const src = toRgb(makeLinearRgba(4096, 23));
    const curve = buildHistMatch(src, src)[0];
    for (const g of [0.1, 0.4, 0.7, 0.95]) {
      const lin = srgbToLinear(g);
      const mappedGamma = applyCurveGamma(curve, g);
      expect(Math.abs(mappedGamma - g)).toBeLessThan(1e-3);
      expect(lin).toBeGreaterThan(0);
    }
  });
});
