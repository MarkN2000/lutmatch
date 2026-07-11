import { describe, expect, it } from 'vitest';
import {
  computeEffectiveCurves,
  computeHistogram,
  computeResultHistogram,
  CURVE_BINS,
  gammaLuma,
  HIST_BINS,
} from '../src/core/analysis.ts';
import { linearToSrgb, srgbToLinear } from '../src/core/colorspace.ts';
import { extractValidSamples } from '../src/core/stats.ts';
import { makeLinearRgba } from './helpers.ts';

const SAMPLE = { alphaThreshold: 0.5, blackThreshold: 0 };

/** ガンマ値 x を [0,bins) のビン番号へ量子化（analysis 内部と同じ規則）。 */
function binOf(x: number, bins: number): number {
  const b = Math.floor(x * bins);
  return b < 0 ? 0 : b >= bins ? bins - 1 : b;
}

/**
 * 軸分離な格子を生成する（各チャンネル出力が自チャンネル座標のみに依存）。
 * @param f ガンマ座標 → 出力ガンマ値の写像
 */
function makeAxisGrid(
  n: number,
  f: (coord: number) => number,
  Ctor: Float32ArrayConstructor | Float64ArrayConstructor,
): Float32Array | Float64Array {
  const inv = n > 1 ? 1 / (n - 1) : 0;
  const g = new Ctor(n * n * n * 3);
  for (let ib = 0; ib < n; ib++) {
    for (let ig = 0; ig < n; ig++) {
      for (let ir = 0; ir < n; ir++) {
        const idx = (ir + ig * n + ib * n * n) * 3;
        g[idx] = f(ir * inv);
        g[idx + 1] = f(ig * inv);
        g[idx + 2] = f(ib * inv);
      }
    }
  }
  return g;
}

/** グレー（R=G=B）なリニアサンプルを、指定ガンマ値の並びから作る。 */
function graySamples(gammaVals: number[]): Float32Array {
  const s = new Float32Array(gammaVals.length * 3);
  for (let i = 0; i < gammaVals.length; i++) {
    const lin = srgbToLinear(gammaVals[i]);
    s[i * 3] = lin;
    s[i * 3 + 1] = lin;
    s[i * 3 + 2] = lin;
  }
  return s;
}

/** ブロック（長さ bins）内の最大値インデックス。 */
function argmax(arr: Float32Array, off: number, bins: number): number {
  let mi = off;
  for (let i = off; i < off + bins; i++) if (arr[i] > arr[mi]) mi = i;
  return mi - off;
}

/**
 * 指定チャンネルの「入力ガンマの per-bin 平均」を独立に求める参照実装。
 * 軸分離な恒等・アフィン格子では F がこれ（に写像 g を掛けたもの）と一致するはず。
 */
function channelInputMean(samples: Float32Array, ch: number, bins: number): Float64Array {
  const sums = new Float64Array(bins);
  const counts = new Uint32Array(bins);
  const count = Math.floor(samples.length / 3);
  const mean = new Float64Array(bins);
  for (let i = 0; i < count; i++) {
    const x = linearToSrgb(samples[i * 3 + ch]);
    const b = binOf(x, bins);
    sums[b] += x;
    counts[b]++;
  }
  for (let i = 0; i < bins; i++) mean[i] = counts[i] > 0 ? sums[i] / counts[i] : NaN;
  return mean;
}

describe('computeEffectiveCurves（実効カーブ回帰）', () => {
  it('恒等格子 → F(x) ≈ x（充填ビンで入力平均に厳密一致・全チャンネル）', () => {
    const n = 17;
    const base = makeAxisGrid(n, (c) => c, Float64Array) as Float64Array;
    const samples = extractValidSamples(makeLinearRgba(4096, 11), 4, SAMPLE);
    const curves = computeEffectiveCurves(base, n, samples);
    // R/G/B 各ブロックが、その入力ガンマの per-bin 平均に一致すること。
    for (let ch = 0; ch < 3; ch++) {
      const ref = channelInputMean(samples, ch, CURVE_BINS);
      for (let i = 0; i < CURVE_BINS; i++) {
        if (!Number.isNaN(ref[i])) {
          expect(curves[ch * CURVE_BINS + i]).toBeCloseTo(ref[i], 5);
        }
      }
    }
    // マスター（M）も充填域で恒等に近い。
    for (let i = 8; i < CURVE_BINS - 8; i++) {
      const m = curves[3 * CURVE_BINS + i];
      expect(m).toBeCloseTo((i + 0.5) / CURVE_BINS, 1);
    }
  });

  it('アフィン格子 out=0.5·in+0.2（ガンマ空間）→ F がそれに一致', () => {
    const n = 17;
    const f = (c: number): number => 0.5 * c + 0.2;
    const base = makeAxisGrid(n, f, Float64Array) as Float64Array;
    const samples = extractValidSamples(makeLinearRgba(4096, 13), 4, SAMPLE);
    const curves = computeEffectiveCurves(base, n, samples);
    for (let ch = 0; ch < 3; ch++) {
      const ref = channelInputMean(samples, ch, CURVE_BINS);
      for (let i = 0; i < CURVE_BINS; i++) {
        if (!Number.isNaN(ref[i])) {
          expect(curves[ch * CURVE_BINS + i]).toBeCloseTo(f(ref[i]), 5);
        }
      }
    }
  });

  it('空ビン：狭い範囲のサンプルでも NaN なし・両端は最近傍ホールド（恒等格子で単調）', () => {
    const n = 17;
    const base = makeAxisGrid(n, (c) => c, Float64Array) as Float64Array;
    // ガンマ 0.4〜0.6 の狭帯域グレーのみ。
    const vals: number[] = [];
    for (let k = 0; k < 2000; k++) vals.push(0.4 + (k / 2000) * 0.2);
    const samples = graySamples(vals);
    const curves = computeEffectiveCurves(base, n, samples);
    for (let i = 0; i < curves.length; i++) expect(Number.isFinite(curves[i])).toBe(true);
    // 恒等格子＋ホールド/補間 → 各ブロック非減少。
    for (let ch = 0; ch < 4; ch++) {
      for (let i = 1; i < CURVE_BINS; i++) {
        expect(curves[ch * CURVE_BINS + i]).toBeGreaterThanOrEqual(
          curves[ch * CURVE_BINS + i - 1] - 1e-9,
        );
      }
    }
    // 帯域外の先頭ビンは 0 ではなく、最寄り充填値（≈0.4 付近）を保持。
    expect(curves[0]).toBeGreaterThan(0.35);
  });

  it('全ビン空（サンプル0個）→ F(x)=x（ビン中心）', () => {
    const n = 17;
    const base = makeAxisGrid(n, (c) => c, Float64Array) as Float64Array;
    const curves = computeEffectiveCurves(base, n, new Float32Array(0));
    for (let ch = 0; ch < 4; ch++) {
      for (let i = 0; i < CURVE_BINS; i++) {
        expect(curves[ch * CURVE_BINS + i]).toBeCloseTo((i + 0.5) / CURVE_BINS, 6);
      }
    }
  });
});

describe('computeHistogram（Source ヒストグラム）', () => {
  it('グレーサンプル → R/G/B/Y\' が同形状・最大値1・NaN なし', () => {
    // ガンマ 0.25 と 0.5 に山を作る。
    const vals: number[] = [];
    for (let k = 0; k < 1000; k++) vals.push(0.25);
    for (let k = 0; k < 3000; k++) vals.push(0.5);
    const hist = computeHistogram(graySamples(vals));
    for (let i = 0; i < hist.length; i++) expect(Number.isFinite(hist[i])).toBe(true);
    // グレーは Y' = R = G = B。
    for (let i = 0; i < HIST_BINS; i++) {
      const r = hist[i];
      expect(hist[HIST_BINS + i]).toBeCloseTo(r, 6);
      expect(hist[2 * HIST_BINS + i]).toBeCloseTo(r, 6);
      expect(hist[3 * HIST_BINS + i]).toBeCloseTo(r, 6);
    }
    // 各ブロックの最大は 1（自身の最大で正規化）。ピークは 0.5（度数最大）に。
    for (let ch = 0; ch < 4; ch++) {
      expect(argmax(hist, ch * HIST_BINS, HIST_BINS)).toBe(binOf(0.5, HIST_BINS));
      let max = 0;
      for (let i = 0; i < HIST_BINS; i++) max = Math.max(max, hist[ch * HIST_BINS + i]);
      expect(max).toBeCloseTo(1, 6);
    }
  });

  it('画素なしブロックは全0のまま（空入力）', () => {
    const hist = computeHistogram(new Float32Array(0));
    for (let i = 0; i < hist.length; i++) expect(hist[i]).toBe(0);
  });
});

describe('computeResultHistogram（結果ヒストグラム）', () => {
  const vals: number[] = [];
  for (let k = 0; k < 4000; k++) vals.push(0.5);
  const samples = graySamples(vals);

  it('恒等 LUT → Source ヒストグラムと同形状', () => {
    const n = 17;
    const lut = makeAxisGrid(n, (c) => c, Float32Array) as Float32Array;
    const result = computeResultHistogram(lut, n, samples);
    const source = computeHistogram(samples);
    for (let i = 0; i < result.length; i++) expect(result[i]).toBeCloseTo(source[i], 5);
  });

  it('全体を持ち上げる LUT（+0.2）でピークが右へ移動', () => {
    const n = 17;
    const lift = makeAxisGrid(n, (c) => Math.min(1, c + 0.2), Float32Array) as Float32Array;
    const result = computeResultHistogram(lift, n, samples);
    const source = computeHistogram(samples);
    const srcPeak = argmax(source, 0, HIST_BINS);
    const resPeak = argmax(result, 0, HIST_BINS);
    expect(resPeak).toBeGreaterThan(srcPeak);
    // 0.5 → 0.7 相当のビンへ。
    expect(resPeak).toBe(binOf(0.7, HIST_BINS));
  });
});

describe('gammaLuma', () => {
  it('白=1・黒=0・係数の和=1', () => {
    expect(gammaLuma(1, 1, 1)).toBeCloseTo(1, 12);
    expect(gammaLuma(0, 0, 0)).toBe(0);
    const sum = gammaLuma(1, 0, 0) + gammaLuma(0, 1, 0) + gammaLuma(0, 0, 1);
    expect(sum).toBeCloseTo(1, 12);
  });
});
