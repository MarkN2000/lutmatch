import { describe, expect, it } from 'vitest';
import { rec709Luminance } from '../src/core/colorspace.ts';
import {
  computeColorStats,
  extractValidSamples,
  MKL_EPS_ABS,
  regularizeCov,
} from '../src/core/stats.ts';
import type { Mat3, SampleOptions } from '../src/core/types.ts';

/** Float32Array 由来の丸めを許容してパック配列を比較する。 */
function expectSamplesClose(out: Float32Array, expected: number[]): void {
  expect(out.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) expect(out[i]).toBeCloseTo(expected[i], 5);
}

// extractValidSamples の比較演算子（stats.ts）：
//   alpha:  `pixels[base+3] < alphaThreshold` → 除外（＝しきい値ちょうどは含む）
//   black:  `rec709Luminance < blackThreshold` → 除外（＝しきい値ちょうどは含む）
// グレー画素 (v,v,v) の Rec.709 リニア輝度は係数和が 1 のため v に一致するので、
// 輝度＝しきい値の境界を厳密に作れる。

describe('extractValidSamples: alphaThreshold（RGBA）', () => {
  it('アルファがちょうど境界値の画素は含まれ、境界未満のみ除外される', () => {
    const opts: SampleOptions = { alphaThreshold: 0.5, blackThreshold: 0 };
    // 3 画素：alpha == 0.5（含む）／< 0.5（除外）／> 0.5（含む）。RGB は十分明るく黒保護対象外。
    const px = new Float32Array([
      0.8, 0.8, 0.8, 0.5, // == threshold → 含む
      0.8, 0.8, 0.8, 0.4999, // < threshold → 除外
      0.8, 0.8, 0.8, 0.9, // > threshold → 含む
    ]);
    const out = extractValidSamples(px, 4, opts);
    // 含まれた 2 画素 × 3ch の値がそのまま保持されている。
    expectSamplesClose(out, [0.8, 0.8, 0.8, 0.8, 0.8, 0.8]);
  });
});

describe('extractValidSamples: RGB（channels=3）はアルファ除外が働かない', () => {
  it('アルファチャンネルが無いため、低アルファ相当の除外は発生せず全画素通過する', () => {
    // channels=3 では pixels[base+3] を参照しない（stride=3）。
    // もし誤ってアルファ判定が走れば 4番目の要素 0.1 が「低アルファ」とみなされ
    // 先頭画素が落ちるが、実装は 3ch でアルファ判定をスキップするので両画素とも残る。
    const opts: SampleOptions = { alphaThreshold: 0.5, blackThreshold: 0 };
    const px = new Float32Array([
      0.8, 0.8, 0.8, // 画素0
      0.1, 0.6, 0.4, // 画素1（第4要素は次画素R=0.1。アルファとして解釈されてはならない）
    ]);
    const out = extractValidSamples(px, 3, opts);
    // 2 画素とも通過（アルファ除外は発火しない）。
    expectSamplesClose(out, [0.8, 0.8, 0.8, 0.1, 0.6, 0.4]);
  });
});

describe('extractValidSamples: blackThreshold（リニア輝度）', () => {
  it('リニア輝度がちょうど境界値の画素は含まれ、境界未満のみ除外される', () => {
    const opts: SampleOptions = { alphaThreshold: 0.5, blackThreshold: 0.2 };
    // グレー画素の輝度 = 値。輝度 0.2（==・含む）／0.19（<・除外）／0.5（含む）。
    const px = new Float32Array([
      0.2, 0.2, 0.2, 1, // 輝度 0.2 == threshold → 含む
      0.19, 0.19, 0.19, 1, // 輝度 0.19 < threshold → 除外
      0.5, 0.5, 0.5, 1, // 含む
    ]);
    // 前提確認：グレーの輝度は値そのもの。
    expect(rec709Luminance(0.2, 0.2, 0.2)).toBeCloseTo(0.2, 12);
    const out = extractValidSamples(px, 4, opts);
    // 2 画素（輝度==境界 と 明部）が通過。
    expectSamplesClose(out, [0.2, 0.2, 0.2, 0.5, 0.5, 0.5]);
  });

  it('しきい値 0 なら純黒 (0,0,0) を含め全画素通過する', () => {
    const opts: SampleOptions = { alphaThreshold: 0.5, blackThreshold: 0 };
    // 輝度 0 の画素も `0 < 0` は偽なので除外されない。
    const px = new Float32Array([
      0, 0, 0, 1, // 純黒 → 含む（0 < 0 は偽）
      0.001, 0.001, 0.001, 1, // 含む
      0.9, 0.9, 0.9, 1, // 含む
    ]);
    const out = extractValidSamples(px, 4, opts);
    expect(out.length).toBe(9); // 3 画素すべて
  });
});

describe('extractValidSamples: 全画素除外', () => {
  it('全画素が除外されると長さ0の空配列が返り、統計は NaN/例外を出さない', () => {
    const opts: SampleOptions = { alphaThreshold: 0.5, blackThreshold: 0.5 };
    // すべて暗部：輝度 < 0.5 → 全除外。
    const px = new Float32Array([
      0.1, 0.1, 0.1, 1,
      0.0, 0.0, 0.0, 1,
      0.3, 0.3, 0.3, 1,
    ]);
    const out = extractValidSamples(px, 4, opts);
    expect(out.length).toBe(0);

    // 空サンプルでも例外を出さず、零統計（count=0・NaN なし）を返す。
    const stats = computeColorStats(out);
    expect(stats.count).toBe(0);
    for (const m of stats.mean) expect(Number.isNaN(m)).toBe(false);
    for (const c of stats.cov) expect(Number.isNaN(c)).toBe(false);
  });
});

describe('regularizeCov: 絶対下限 MKL_EPS_ABS', () => {
  it('分散ほぼ 0 の入力でも正則化後の対角が絶対下限 MKL_EPS_ABS 以上になる', () => {
    // 相対量 trace/3 × COV_REG_FACTOR は極小（≒1e-13）となり効かない。
    // 絶対下限 MKL_EPS_ABS(1e-5) が支配し、対角へ確実に加算される。
    const cov: Mat3 = [1e-9, 0, 0, 0, 1e-9, 0, 0, 0, 1e-9];
    const r = regularizeCov(cov);
    expect(r[0]).toBeGreaterThanOrEqual(MKL_EPS_ABS);
    expect(r[4]).toBeGreaterThanOrEqual(MKL_EPS_ABS);
    expect(r[8]).toBeGreaterThanOrEqual(MKL_EPS_ABS);
    // 相対量ではなく絶対下限が効いていること（≒ 元の対角 + 1e-5）を確認。
    expect(r[0]).toBeCloseTo(1e-9 + MKL_EPS_ABS, 12);
  });

  it('分散が十分大きい入力では相対量が支配し下限を超える', () => {
    // trace/3 = 0.3 → eps = 0.3 × 1e-4 = 3e-5 > MKL_EPS_ABS(1e-5)。
    const cov: Mat3 = [0.3, 0, 0, 0, 0.3, 0, 0, 0, 0.3];
    const r = regularizeCov(cov);
    expect(r[0]).toBeCloseTo(0.3 + 3e-5, 10);
  });
});
