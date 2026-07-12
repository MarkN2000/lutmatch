import { describe, expect, it } from 'vitest';
import {
  labToLch,
  linearRgbToLab,
  srgbToLinear,
} from '../src/core/colorspace.ts';
import {
  applyHueCurveGamma,
  chromaWeight,
  HUE_CURVE_CHROMA_EPS,
  HUE_CURVE_MAX_ROTATION_DEG,
  HUE_CURVE_MIN_CHROMA,
  HUE_RESIDUAL_TABLE_N,
} from '../src/core/huecurve.ts';
import {
  computeHistogram,
  computeResultHistogram,
  HIST_BINS,
  HIST_BLOCKS,
} from '../src/core/analysis.ts';
import type { Vec3 } from '../src/core/types.ts';

/** ガンマ RGB → LCh（測定用）。 */
function lchOfGamma(r: number, g: number, b: number): Vec3 {
  const lab: Vec3 = [0, 0, 0];
  const lch: Vec3 = [0, 0, 0];
  linearRgbToLab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), lab);
  labToLch(lab[0], lab[1], lab[2], lch);
  return lch;
}

/** 全周一定 dy の周期テーブル。 */
function flatTable(dy: number): Float32Array {
  return new Float32Array(HUE_RESIDUAL_TABLE_N).fill(dy);
}
const ZERO_TABLE = new Float32Array(HUE_RESIDUAL_TABLE_N);

/** ガンマ値 x を [0,bins) のビン番号へ量子化。 */
function binOf(x: number, bins: number): number {
  const b = Math.floor(x * bins);
  return b < 0 ? 0 : b >= bins ? bins - 1 : b;
}

/** 軸恒等 LUT（Float32・R 最速）。 */
function identityLut(n: number): Float32Array {
  const inv = 1 / (n - 1);
  const g = new Float32Array(n * n * n * 3);
  for (let ib = 0; ib < n; ib++) {
    for (let ig = 0; ig < n; ig++) {
      for (let ir = 0; ir < n; ir++) {
        const idx = (ir + ig * n + ib * n * n) * 3;
        g[idx] = ir * inv;
        g[idx + 1] = ig * inv;
        g[idx + 2] = ib * inv;
      }
    }
  }
  return g;
}

/** 単色（ガンマ RGB）を count 個パックしたリニアサンプル。 */
function colorSamples(r: number, g: number, b: number, count: number): Float32Array {
  const s = new Float32Array(count * 3);
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  for (let i = 0; i < count; i++) {
    s[i * 3] = lr;
    s[i * 3 + 1] = lg;
    s[i * 3 + 2] = lb;
  }
  return s;
}

describe('chromaWeight（低彩度減衰）', () => {
  it('C≤C_ε は 0、C≥C0 は 1、間は単調増加の S 字', () => {
    expect(chromaWeight(0)).toBe(0);
    expect(chromaWeight(HUE_CURVE_CHROMA_EPS)).toBe(0);
    expect(chromaWeight(HUE_CURVE_MIN_CHROMA)).toBe(1);
    expect(chromaWeight(HUE_CURVE_MIN_CHROMA * 2)).toBe(1);
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const c = (HUE_CURVE_MIN_CHROMA * i) / 20;
      const w = chromaWeight(c);
      expect(w).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      prev = w;
    }
  });
});

describe('applyHueCurveGamma：色相回転（Hue vs Hue）', () => {
  it('高彩度色に dy=1 フラット → 色相が +60° 回転・L* と（回転のみ時）C 不変', () => {
    const rgb: Vec3 = [0.82, 0.2, 0.22]; // 高彩度の赤系。
    const before = lchOfGamma(rgb[0], rgb[1], rgb[2]);
    expect(before[1]).toBeGreaterThan(HUE_CURVE_MIN_CHROMA); // w≈1 を担保。

    applyHueCurveGamma(rgb, flatTable(1), ZERO_TABLE);
    const after = lchOfGamma(rgb[0], rgb[1], rgb[2]);

    // 期待色相：+HUE_CURVE_MAX_ROTATION_DEG（turns）。
    const expectedH = (before[2] + HUE_CURVE_MAX_ROTATION_DEG / 360) % 1;
    expect(after[2]).toBeCloseTo(expectedH, 3);
    // L* 不変・回転のみなので C も不変。
    expect(after[0]).toBeCloseTo(before[0], 3);
    expect(after[1]).toBeCloseTo(before[1], 3);
  });

  it('dy=-1 は逆回転（−60°）', () => {
    const rgb: Vec3 = [0.2, 0.7, 0.3]; // 緑系。
    const before = lchOfGamma(rgb[0], rgb[1], rgb[2]);
    applyHueCurveGamma(rgb, flatTable(-1), ZERO_TABLE);
    const after = lchOfGamma(rgb[0], rgb[1], rgb[2]);
    const expectedH = (before[2] - HUE_CURVE_MAX_ROTATION_DEG / 360 + 1) % 1;
    expect(after[2]).toBeCloseTo(expectedH, 3);
  });
});

describe('applyHueCurveGamma：彩度ゲイン（Hue vs Sat）', () => {
  it('高彩度色に dy=-1 フラット → ほぼ無彩色化・L* と色相は保持', () => {
    const rgb: Vec3 = [0.2, 0.45, 0.85]; // 高彩度の青系。
    const before = lchOfGamma(rgb[0], rgb[1], rgb[2]);
    expect(before[1]).toBeGreaterThan(HUE_CURVE_MIN_CHROMA);

    applyHueCurveGamma(rgb, ZERO_TABLE, flatTable(-1));
    const after = lchOfGamma(rgb[0], rgb[1], rgb[2]);

    expect(after[1]).toBeLessThan(0.5); // C' ≈ 0。
    expect(after[0]).toBeCloseTo(before[0], 3); // L* 不変。
  });

  it('dy=+0.5 で彩度が約1.5倍に増加', () => {
    const rgb: Vec3 = [0.35, 0.5, 0.7];
    const before = lchOfGamma(rgb[0], rgb[1], rgb[2]);
    applyHueCurveGamma(rgb, ZERO_TABLE, flatTable(0.5));
    const after = lchOfGamma(rgb[0], rgb[1], rgb[2]);
    // w≈1（高彩度）前提で C' = C×1.5。
    if (before[1] > HUE_CURVE_MIN_CHROMA) {
      expect(after[1]).toBeCloseTo(before[1] * 1.5, 1);
    }
    expect(after[0]).toBeCloseTo(before[0], 3);
  });
});

describe('applyHueCurveGamma：グレー軸は完全不変', () => {
  it('グレー（C<C_ε）はどんな編集でもビット不変（w=0 で早期 return）', () => {
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      const rgb: Vec3 = [v, v, v];
      const orig: Vec3 = [v, v, v];
      // 回転・彩度とも最大編集。
      applyHueCurveGamma(rgb, flatTable(1), flatTable(-1));
      expect(rgb[0]).toBe(orig[0]);
      expect(rgb[1]).toBe(orig[1]);
      expect(rgb[2]).toBe(orig[2]);
    }
  });
});

describe('ヒストグラム H（第5）ブロック', () => {
  const HOFF = 4 * HIST_BINS; // H ブロック先頭。

  it('結果ヒスト：単色サンプルは期待色相ビンに集中', () => {
    const n = 9;
    const lut = identityLut(n);
    const [r, g, b] = [0.85, 0.15, 0.18];
    const samples = colorSamples(r, g, b, 4000);
    const hist = computeResultHistogram(lut, n, samples);
    expect(hist).toHaveLength(HIST_BLOCKS * HIST_BINS);

    const expectedBin = binOf(lchOfGamma(r, g, b)[2], HIST_BINS);
    // H ブロックの argmax が期待ビン（±1・trilinear 誤差許容）。
    let mi = 0;
    let mv = -1;
    for (let i = 0; i < HIST_BINS; i++) {
      if (hist[HOFF + i] > mv) {
        mv = hist[HOFF + i];
        mi = i;
      }
    }
    expect(Math.abs(mi - expectedBin)).toBeLessThanOrEqual(1);
    expect(mv).toBeCloseTo(1, 6); // 自ブロック最大値正規化。
    // 集中：非近傍ビンはほぼ 0。
    let farSum = 0;
    for (let i = 0; i < HIST_BINS; i++) {
      if (Math.abs(i - expectedBin) > 2) farSum += hist[HOFF + i];
    }
    expect(farSum).toBeLessThan(1e-6);
  });

  it('結果ヒスト：グレーのみサンプルは H ブロックがゼロ（彩度重みで抑制）', () => {
    const n = 9;
    const lut = identityLut(n);
    const samples = colorSamples(0.5, 0.5, 0.5, 4000);
    const hist = computeResultHistogram(lut, n, samples);
    let hSum = 0;
    for (let i = 0; i < HIST_BINS; i++) hSum += hist[HOFF + i];
    expect(hSum).toBe(0);
  });

  it('Source ヒスト：hueGrid 適用時のみ H を集計（省略時は全 0）', () => {
    const n = 9;
    const grid = identityLut(n);
    const [r, g, b] = [0.2, 0.75, 0.25];
    const samples = colorSamples(r, g, b, 4000);

    // hueGrid 省略 → H ブロック全 0。
    const noGrid = computeHistogram(samples);
    expect(noGrid).toHaveLength(HIST_BLOCKS * HIST_BINS);
    let s0 = 0;
    for (let i = 0; i < HIST_BINS; i++) s0 += noGrid[HOFF + i];
    expect(s0).toBe(0);

    // hueGrid（恒等）指定 → 期待色相ビンに集中。
    const withGrid = computeHistogram(samples, grid, n);
    const expectedBin = binOf(lchOfGamma(r, g, b)[2], HIST_BINS);
    let mi = 0;
    let mv = -1;
    for (let i = 0; i < HIST_BINS; i++) {
      if (withGrid[HOFF + i] > mv) {
        mv = withGrid[HOFF + i];
        mi = i;
      }
    }
    expect(Math.abs(mi - expectedBin)).toBeLessThanOrEqual(1);
    expect(mv).toBeCloseTo(1, 6);
  });
});
