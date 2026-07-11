import { describe, expect, it } from 'vitest';
import {
  linearRgbToLab,
  linearToSrgb,
  rec709Luminance,
  srgbToLinear,
} from '../src/core/colorspace.ts';
import { mahalanobisSq } from '../src/core/linalg.ts';
import {
  generateLut,
  MAHALANOBIS_D0,
  MAHALANOBIS_D1,
  smoothGrid,
  trilinearSample,
} from '../src/core/lut.ts';
import { buildMatchTransform } from '../src/core/pipeline.ts';
import { computeColorStats, extractValidSamples, regularizedCovInv } from '../src/core/stats.ts';
import { NEUTRAL_ADJUSTMENTS } from '../src/core/types.ts';
import type { GenerateLutOptions, ManualAdjustments, MatchMode, Vec3 } from '../src/core/types.ts';
import { makeLinearRgba, mulberry32 } from './helpers.ts';

const SAMPLE = { alphaThreshold: 0.5, blackThreshold: 0 };

function baseOptions(overrides: Partial<GenerateLutOptions>): GenerateLutOptions {
  return {
    mode: 'C',
    size: 17,
    strength: 85,
    smoothing: 20,
    // テスト既定は 0（クランプなし・σ=2＝素の HM 挙動）。UI 既定 15 はゴールデンテスト側で明示。
    noiseSuppression: 0,
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

describe('同一性テスト×ノイズ抑制（§5.3・§11⑥）', () => {
  // Source=Reference のとき HM カーブは恒等（残差 0）。傾きクランプは cap=S_max·Δx≥Δx
  // ゆえ恒等（傾き Δx）を不変に保ち、σ(s) の残差平滑化も恒等残差 0 を厳密保持するため、
  // 任意の s で LUT ≒ Identity になる（HM を使う B/C で検証）。
  const modes: MatchMode[] = ['B', 'C'];
  for (const mode of modes) {
    for (const noiseSuppression of [0, 15, 50, 100]) {
      it(`モード ${mode}・s=${noiseSuppression}：LUT が Identity に一致`, () => {
        const px = makeLinearRgba(2048, 100);
        const { lut, size } = generateLut(
          px,
          px,
          4,
          baseOptions({ mode, strength: 100, smoothing: 0, noiseSuppression }),
        );
        expect(maxIdentityError(lut, size)).toBeLessThan(1e-3);
      });
    }
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
      // UI 既定構成をモデル化する（strength/smoothing/noiseSuppression とも main.ts の DEFAULTS と揃える）。
      baseOptions({ mode: 'C', size: 17, strength: 85, smoothing: 20, noiseSuppression: 15 }),
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

describe('手動調整の作用空間（§5.5）', () => {
  // strength:0 にすると最終ミックスが rgb = gr + (auto-gr)*0 = gr（格子座標そのもの）となり、
  // 自動マッチ・マハラノビス減衰・平滑化の結果が一切残らない（0倍されるため）。
  // これにより「手動調整だけが Identity 格子に効いた」状態を厳密に作れる。
  const src = makeLinearRgba(4096, 501);
  const ref = makeLinearRgba(4096, 502);

  function manualOnly(manual: Partial<ManualAdjustments>, size = 17) {
    return generateLut(
      src,
      ref,
      4,
      baseOptions({
        size,
        strength: 0,
        smoothing: 0,
        manual: { ...NEUTRAL_ADJUSTMENTS, ...manual },
      }),
    );
  }

  function gridValue(lut: Float32Array, n: number, ir: number, ig: number, ib: number): Vec3 {
    const idx = (ir + ig * n + ib * n * n) * 3;
    return [lut[idx], lut[idx + 1], lut[idx + 2]];
  }

  it('露出 EV=+1 で中間調のリニア値が約2倍になる', () => {
    const size = 17;
    const { lut } = manualOnly({ exposure: 1 }, size);
    const mid = 8; // 8/16 = 0.5（ガンマ空間の中間調）
    const [r, g, b] = gridValue(lut, size, mid, mid, mid);
    const expected = 2 * srgbToLinear(0.5);
    expect(srgbToLinear(r)).toBeCloseTo(expected, 5);
    expect(srgbToLinear(g)).toBeCloseTo(expected, 5);
    expect(srgbToLinear(b)).toBeCloseTo(expected, 5);
  });

  it('色温度 > 0 で Lab の b* が増加する（a* はほぼ不変）', () => {
    const size = 17;
    const mid = 8;
    const { lut } = manualOnly({ temperature: 50 }, size);
    const [r, g, b] = gridValue(lut, size, mid, mid, mid);
    const labOut: Vec3 = [0, 0, 0];
    linearRgbToLab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), labOut);
    const labBase: Vec3 = [0, 0, 0];
    const baseLin = srgbToLinear(0.5);
    linearRgbToLab(baseLin, baseLin, baseLin, labBase);
    expect(labOut[2]).toBeGreaterThan(labBase[2] + 5);
    expect(Math.abs(labOut[1] - labBase[1])).toBeLessThan(1);
  });

  it('ティント > 0 で Lab の a* が増加する（b* はほぼ不変）', () => {
    const size = 17;
    const mid = 8;
    const { lut } = manualOnly({ tint: 50 }, size);
    const [r, g, b] = gridValue(lut, size, mid, mid, mid);
    const labOut: Vec3 = [0, 0, 0];
    linearRgbToLab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), labOut);
    const labBase: Vec3 = [0, 0, 0];
    const baseLin = srgbToLinear(0.5);
    linearRgbToLab(baseLin, baseLin, baseLin, labBase);
    expect(labOut[1]).toBeGreaterThan(labBase[1] + 5);
    expect(Math.abs(labOut[2] - labBase[2])).toBeLessThan(1);
  });

  it('コントラスト：ピボット(ガンマ0.5)は不動点、正のコントラストで0.25は下降・0.75は上昇', () => {
    const size = 17;
    const { lut } = manualOnly({ contrast: 50 }, size);
    const at = (i: number): number => gridValue(lut, size, i, i, i)[0];
    expect(at(8)).toBeCloseTo(0.5, 4); // 8/16 = 0.5（ピボット・不動点）
    expect(at(4)).toBeLessThan(0.25); // 4/16 = 0.25
    expect(at(12)).toBeGreaterThan(0.75); // 12/16 = 0.75
  });

  it('彩度 −100 で完全グレースケール（R=G=B、Rec.709輝度に一致）', () => {
    const size = 17;
    const { lut } = manualOnly({ saturation: -100 }, size);
    // 純色に近い格子点（ガンマ R=1,G=0,B=0）で確認。
    const [r, g, b] = gridValue(lut, size, size - 1, 0, 0);
    expect(Math.abs(r - g)).toBeLessThan(1e-4);
    expect(Math.abs(g - b)).toBeLessThan(1e-4);
    const expectedLin = rec709Luminance(srgbToLinear(1), srgbToLinear(0), srgbToLinear(0));
    expect(r).toBeCloseTo(linearToSrgb(expectedLin), 4);
  });
});

describe('マハラノビス外挿減衰（§5.5）', () => {
  it('Source分布内の格子点はほぼ減衰せず、離れた格子点はf直接適用よりIdentityに近づく', () => {
    // Source: (0.5,0.5,0.5) 付近に集中した狭いクラスタ（各チャンネル独立乱数でフルランク）。
    const count = 4096;
    const rngS = mulberry32(999);
    const src = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const rr = 0.5 + (rngS() - 0.5) * 0.06;
      const gg = 0.5 + (rngS() - 0.5) * 0.06;
      const bb = 0.5 + (rngS() - 0.5) * 0.06;
      src[i * 4] = srgbToLinear(rr);
      src[i * 4 + 1] = srgbToLinear(gg);
      src[i * 4 + 2] = srgbToLinear(bb);
      src[i * 4 + 3] = 1;
    }
    // Reference: 別の狭いクラスタ（Sourceからアフィン的にシフト）。
    const rngR = mulberry32(998);
    const ref = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const rr = 0.7 + (rngR() - 0.5) * 0.06;
      const gg = 0.35 + (rngR() - 0.5) * 0.06;
      const bb = 0.6 + (rngR() - 0.5) * 0.06;
      ref[i * 4] = srgbToLinear(rr);
      ref[i * 4 + 1] = srgbToLinear(gg);
      ref[i * 4 + 2] = srgbToLinear(bb);
      ref[i * 4 + 3] = 1;
    }

    const srcSamples = extractValidSamples(src, 4, SAMPLE);
    const refSamples = extractValidSamples(ref, 4, SAMPLE);
    const match = buildMatchTransform('A', srcSamples, refSamples, 0);
    expect(match.fallback).toBe(false);

    const n = 17;
    const inv = 1 / (n - 1);
    const { lut } = generateLut(
      src,
      ref,
      4,
      baseOptions({ mode: 'A', size: n, strength: 100, smoothing: 0 }),
    );

    const srcStats = computeColorStats(srcSamples);
    const covInv = regularizedCovInv(srcStats.cov);

    function evaluate(ir: number, ig: number, ib: number) {
      const gr = ir * inv;
      const gg = ig * inv;
      const gb = ib * inv;
      const linGrid: Vec3 = [srgbToLinear(gr), srgbToLinear(gg), srgbToLinear(gb)];
      const matched: Vec3 = [0, 0, 0];
      match.apply(linGrid[0], linGrid[1], linGrid[2], matched);
      const rawGamma: Vec3 = [
        linearToSrgb(matched[0]),
        linearToSrgb(matched[1]),
        linearToSrgb(matched[2]),
      ];
      const idx = (ir + ig * n + ib * n * n) * 3;
      const actual: Vec3 = [lut[idx], lut[idx + 1], lut[idx + 2]];
      const identity: Vec3 = [gr, gg, gb];
      const d = Math.sqrt(mahalanobisSq(covInv, linGrid, srcStats.mean));
      return { rawGamma, actual, identity, d };
    }

    // 分布内（グリッド中心 (8,8,8) は (0.5,0.5,0.5) = Sourceクラスタの中心）：ほぼ減衰なし。
    const near = evaluate(8, 8, 8);
    expect(near.d).toBeLessThan(MAHALANOBIS_D0);
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(near.actual[c] - near.rawGamma[c])).toBeLessThan(1e-3);
    }

    // 分布から遠い格子点（コーナー）：f直接適用よりIdentityに近づく（ほぼ完全減衰）。
    const far = evaluate(n - 1, 0, 0);
    expect(far.d).toBeGreaterThan(MAHALANOBIS_D1);
    for (let c = 0; c < 3; c++) {
      const distActual = Math.abs(far.actual[c] - far.identity[c]);
      const distRaw = Math.abs(far.rawGamma[c] - far.identity[c]);
      expect(distActual).toBeLessThan(distRaw);
      expect(distActual).toBeLessThan(1e-3);
    }
  });
});

describe('平滑化（§5.5）', () => {
  it('スムージング>0で階段状（不連続）にした隣接格子点差が縮小する', () => {
    const src = makeLinearRgba(4096, 701); // 連続的に広がるSource分布。
    // Reference: ガンマ 0.1 近辺／0.9 近辺の2クラスタ（バイモーダル）。
    // HM の逆CDFがSource分布の中央値付近で急峻にジャンプするカーブを作る。
    const count = 4096;
    const rng = mulberry32(702);
    const ref = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const base = i < count / 2 ? 0.1 : 0.9;
      const v = base + (rng() - 0.5) * 0.02;
      const lin = srgbToLinear(v);
      ref[i * 4] = lin;
      ref[i * 4 + 1] = lin;
      ref[i * 4 + 2] = lin;
      ref[i * 4 + 3] = 1;
    }

    const n = 33;
    const withSmoothing = (smoothing: number): GenerateLutOptions =>
      baseOptions({ mode: 'B', size: n, strength: 100, smoothing, d0: 1e9 });

    const raw = generateLut(src, ref, 4, withSmoothing(0)).lut;
    const smoothed = generateLut(src, ref, 4, withSmoothing(70)).lut;

    function maxAdjacentDiff(lut: Float32Array): number {
      let maxDiff = 0;
      for (let ib = 0; ib < n; ib++) {
        for (let ig = 0; ig < n; ig++) {
          for (let ir = 0; ir < n - 1; ir++) {
            const i0 = (ir + ig * n + ib * n * n) * 3;
            const i1 = (ir + 1 + ig * n + ib * n * n) * 3;
            for (let c = 0; c < 3; c++) {
              maxDiff = Math.max(maxDiff, Math.abs(lut[i1 + c] - lut[i0 + c]));
            }
          }
        }
      }
      return maxDiff;
    }

    const rawMax = maxAdjacentDiff(raw);
    const smoothedMax = maxAdjacentDiff(smoothed);
    // バイモーダルReferenceにより急峻なジャンプが実際に生じていることを確認したうえで、
    // 平滑化がその隣接差を縮小させることを検証する。
    expect(rawMax).toBeGreaterThan(0.2);
    expect(smoothedMax).toBeLessThan(rawMax * 0.9);
  });

  it('一様な格子は平滑化で不変（ガウシアンカーネルの正規化）', () => {
    // 一様（定数）格子を直接構成して平滑化に通す。ゲイン上限クランプにより MKL は
    // もはや定数写像を生成しない（固有値は 1/MKL_MAX_GAIN で下限クランプ）ため、
    // 平滑化の不変性は変換内部から切り離して smoothGrid 単体で検証する。
    const n = 17;
    const uniform = new Float32Array(n * n * n * 3);
    for (let i = 0; i < uniform.length; i += 3) {
      uniform[i] = 0.37;
      uniform[i + 1] = 0.62;
      uniform[i + 2] = 0.51;
    }
    const smoothed = uniform.slice();
    smoothGrid(smoothed, n, 70);

    // カーネル正規化により一様信号は不変。
    let maxDiff = 0;
    for (let i = 0; i < uniform.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(smoothed[i] - uniform[i]));
    }
    expect(maxDiff).toBeLessThan(1e-6);
  });
});
