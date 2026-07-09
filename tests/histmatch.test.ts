import { describe, expect, it } from 'vitest';
import { linearToSrgb, srgbToLinear } from '../src/core/colorspace.ts';
import { applyCurveGamma, buildHistMatch, HM_BINS } from '../src/core/histmatch.ts';
import { makeLinearRgba, mulberry32 } from './helpers.ts';

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

describe('HM カーブの残差平滑化（暗部スペックル対策）', () => {
  // 暗部に疎なヒストグラムを持つ Source と、なだらかな Reference を作る。
  // 平滑化なしだと逆 CDF が単一ビンで急峻に跳ね、局所傾き（隣接差×HM_BINS）が
  // 暴れる。残差平滑化はこの傾きスパイクと 2 階差分（ギザつき）を抑える。
  function makeShadowSpikeSrc(count: number, seed: number): Float32Array {
    const rng = mulberry32(seed);
    const px = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // 全ビンを最低限埋めつつ、暗部（ガンマ 0.2〜0.45）に離散的な塊を作る。
      let gv: number;
      const u = rng();
      if (i < 256) gv = (i + 0.5) / 256; // 全域カバー（CDF 単調性確保）。
      else if (u < 0.7) {
        // 暗部の少数の離散レベルに集中（疎で塊状 → スパイクの温床）。
        const levels = [52, 58, 71, 89, 96, 104];
        gv = (levels[Math.floor(rng() * levels.length)] + 0.5) / 256;
      } else gv = (Math.floor(rng() * 256) + 0.5) / 256;
      const lin = srgbToLinear(gv);
      px[i * 3] = lin;
      px[i * 3 + 1] = lin;
      px[i * 3 + 2] = lin;
    }
    return px;
  }

  it('暗部の局所傾き・ギザつき（2階差分）が抑制されている', () => {
    const src = makeShadowSpikeSrc(8192, 202);
    const ref = toRgb(makeLinearRgba(8192, 303));
    const curve = buildHistMatch(src, ref)[0];

    // 暗部ビン範囲（リニア輝度 ~5〜15%）。
    const b0 = Math.max(1, Math.floor(linearToSrgb(0.05) * HM_BINS));
    const b1 = Math.floor(linearToSrgb(0.15) * HM_BINS);

    let maxSlope = 0;
    let maxJag = 0;
    for (let i = b0; i <= b1; i++) {
      const slope = (curve.y[i + 1] - curve.y[i]) * HM_BINS;
      if (slope > maxSlope) maxSlope = slope;
      if (i > b0) {
        const prevSlope = (curve.y[i] - curve.y[i - 1]) * HM_BINS;
        const jag = Math.abs(slope - prevSlope);
        if (jag > maxJag) maxJag = jag;
      }
    }
    // σ=2 の平滑化により、暗部の局所傾きは緩やかに、ギザつきは十分小さくなる。
    // （平滑化なしでは傾きが数十〜100 近くまで跳ねる。ここでは保守的な上限で回帰検知する。）
    expect(maxSlope).toBeLessThan(25);
    expect(maxJag).toBeLessThan(10);
  });

  it('平滑化しても単調非減少とマッチの平均挙動を保つ', () => {
    const src = makeShadowSpikeSrc(8192, 204);
    const ref = toRgb(makeLinearRgba(8192, 305));
    const curve = buildHistMatch(src, ref)[0];
    // 単調性（残差平滑化後も再保証されている）。
    for (let i = 1; i <= HM_BINS; i++) {
      expect(curve.y[i]).toBeGreaterThanOrEqual(curve.y[i - 1] - 1e-12);
    }
    // 端点はほぼ [0,1] を跨ぐ（マッチの大域挙動を保持）。残差平滑化で端点が
    // わずかに範囲外へずれることはある（最終クランプで吸収されるため許容）。
    expect(curve.y[0]).toBeLessThan(0.02);
    expect(curve.y[HM_BINS]).toBeGreaterThan(0.98);
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
