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
import { CURVE_BINS, HIST_BINS, HIST_BLOCKS } from '../src/core/analysis.ts';
import type { CurveEdits } from '../src/core/curve.ts';
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
      baseOptions({ mode: 'C', size: 17, strength: 80, smoothing: 20, noiseSuppression: 0 }),
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

describe('残差カーブ統合（§5.7）', () => {
  const src = makeLinearRgba(4096, 811);
  const ref = makeLinearRgba(4096, 812);

  /** 空カーブ（全チャンネル点なし）。isEmptyEdits が true になる。 */
  const emptyEdits: CurveEdits = { master: [], r: [], g: [], b: [] };

  function gridValue(lut: Float32Array, n: number, ir: number, ig: number, ib: number): Vec3 {
    const idx = (ir + ig * n + ib * n * n) * 3;
    return [lut[idx], lut[idx + 1], lut[idx + 2]];
  }

  it('残差 no-op：curves 未指定と空 CurveEdits の LUT がビット一致', () => {
    const opts = baseOptions({ mode: 'C', size: 17 });
    const a = generateLut(src, ref, 4, { ...opts, curves: undefined });
    const b = generateLut(src, ref, 4, { ...opts, curves: emptyEdits });
    expect(a.lut).toEqual(b.lut); // Float32Array 全要素一致。
  });

  it('ループ防止：curves を変えても effectiveCurves は不変（F は base=残差前から算出）', () => {
    const opts = baseOptions({ mode: 'C', size: 17 });
    const none = generateLut(src, ref, 4, { ...opts, curves: undefined });
    const edited = generateLut(src, ref, 4, {
      ...opts,
      curves: { master: [], r: [{ x: 0, dy: -0.2 }, { x: 1, dy: 0.3 }], g: [], b: [] },
    });
    expect(edited.effectiveCurves).toEqual(none.effectiveCurves);
  });

  it('マスター適用：全域 +0.1 で中間調グレーの全チャンネルが curves なし比 +0.1', () => {
    // strength:0・neutral manual なら base は Identity 格子（グレー点で確実に非クランプ域）。
    const opts = baseOptions({ mode: 'C', size: 17, strength: 0, smoothing: 0 });
    const none = generateLut(src, ref, 4, opts);
    const master = generateLut(src, ref, 4, {
      ...opts,
      curves: { master: [{ x: 0, dy: 0.1 }, { x: 1, dy: 0.1 }], r: [], g: [], b: [] },
    });
    const mid = 8; // 8/16 = 0.5 グレー。
    const base = gridValue(none.lut, 17, mid, mid, mid);
    const out = gridValue(master.lut, 17, mid, mid, mid);
    for (let c = 0; c < 3; c++) expect(out[c] - base[c]).toBeCloseTo(0.1, 4);
  });

  it('R 残差の分離：r のみ編集で G/B 出力が不変', () => {
    const opts = baseOptions({ mode: 'C', size: 17 });
    const none = generateLut(src, ref, 4, opts);
    const edited = generateLut(src, ref, 4, {
      ...opts,
      curves: { master: [], r: [{ x: 0, dy: 0.05 }, { x: 1, dy: 0.15 }], g: [], b: [] },
    });
    const n = 17;
    let rChanged = false;
    for (let i = 0; i < none.lut.length; i += 3) {
      // G/B は同一計算列なのでビット一致。
      expect(edited.lut[i + 1]).toBe(none.lut[i + 1]);
      expect(edited.lut[i + 2]).toBe(none.lut[i + 2]);
      if (edited.lut[i] !== none.lut[i]) rChanged = true;
    }
    expect(rChanged).toBe(true);
    expect(n).toBe(17);
  });

  it('マスターの中立性：有彩色格子点でも3チャンネルへ同量加算（差分が一致）', () => {
    // strength:0 で base=Identity。内部の有彩点（各チャンネル非クランプ）で検証。
    const opts = baseOptions({ mode: 'C', size: 17, strength: 0, smoothing: 0 });
    const none = generateLut(src, ref, 4, opts);
    const master = generateLut(src, ref, 4, {
      ...opts,
      curves: { master: [{ x: 0, dy: 0.05 }, { x: 1, dy: 0.15 }], r: [], g: [], b: [] },
    });
    const [ir, ig, ib] = [10, 6, 3]; // 有彩色（R≠G≠B）かつ非クランプ域。
    const base = gridValue(none.lut, 17, ir, ig, ib);
    const out = gridValue(master.lut, 17, ir, ig, ib);
    const dr = out[0] - base[0];
    const dg = out[1] - base[1];
    const db = out[2] - base[2];
    expect(dr).toBeGreaterThan(0);
    expect(dg).toBeCloseTo(dr, 6);
    expect(db).toBeCloseTo(dr, 6);
  });

  it('クランプ：白付近で残差 +0.2 でも出力は 1.0 を超えない', () => {
    const opts = baseOptions({ mode: 'C', size: 17 });
    const { lut } = generateLut(src, ref, 4, {
      ...opts,
      curves: { master: [{ x: 0, dy: 0.2 }, { x: 1, dy: 0.2 }], r: [], g: [], b: [] },
    });
    for (let i = 0; i < lut.length; i++) expect(lut[i]).toBeLessThanOrEqual(1);
    // 白格子点（16,16,16）は残差 +0.2 でも 1.0 にクランプ。
    const white = gridValue(lut, 17, 16, 16, 16);
    for (let c = 0; c < 3; c++) expect(white[c]).toBe(1);
  });

  it('新フィールドが正しい長さで返る', () => {
    const { effectiveCurves, histSource, histResult } = generateLut(
      src,
      ref,
      4,
      baseOptions({ mode: 'C', size: 17 }),
    );
    expect(effectiveCurves).toHaveLength(4 * CURVE_BINS);
    expect(histSource).toHaveLength(HIST_BLOCKS * HIST_BINS);
    expect(histResult).toHaveLength(HIST_BLOCKS * HIST_BINS);
  });
});

describe('恒等基底：Reference なしの手動 LUT 作成（フェーズ1）', () => {
  const src = makeLinearRgba(4096, 4242);
  const ref = makeLinearRgba(4096, 4243);

  // 恒等経路は strength / smoothing / mode / reference を無視するため、これらに非自明な値
  // （strength:80・smoothing:20）を入れても結果が恒等のまま不変であることも兼ねて検証する。
  function idOpts(overrides: Partial<GenerateLutOptions> = {}): GenerateLutOptions {
    return baseOptions({ mode: 'C', size: 17, strength: 80, smoothing: 20, ...overrides });
  }

  it('①手動ニュートラル・カーブなしで LUT が厳密恒等（Float32 精度）・fallback=false', () => {
    const res = generateLut(src, null, 4, idOpts());
    expect(res.fallback).toBe(false);
    const n = res.size;
    const inv = 1 / (n - 1);
    let idx = 0;
    for (let b = 0; b < n; b++) {
      for (let g = 0; g < n; g++) {
        for (let r = 0; r < n; r++) {
          // 主ループの基底 rgb=[gr,gg,gb] を Float32 化した値と厳密一致（丸め以外の差はゼロ）。
          expect(res.lut[idx++]).toBe(Math.fround(r * inv));
          expect(res.lut[idx++]).toBe(Math.fround(g * inv));
          expect(res.lut[idx++]).toBe(Math.fround(b * inv));
        }
      }
    }
  });

  it('②手動調整（露出+1EV）が恒等基底に乗る（strength:0 の実参照経路とビット一致）', () => {
    // strength:0 の Reference あり経路は base=Identity 格子（auto を 0 倍）となり、
    // 「恒等格子に手動だけ適用」した参照そのもの（既存テストで確立済み）。LUT はサンプルに
    // 依存しないため、恒等経路の LUT はこの参照とビット一致するはず。
    const manual = { ...NEUTRAL_ADJUSTMENTS, exposure: 1 };
    const idPath = generateLut(src, null, 4, idOpts({ manual })).lut;
    const refPath = generateLut(
      src,
      ref,
      4,
      baseOptions({ mode: 'C', size: 17, strength: 0, smoothing: 0, manual }),
    ).lut;
    expect(idPath).toEqual(refPath);

    // 併せて中間調グレーが露出+1EV でリニア約2倍という物理的意味も確認。
    const n = 17;
    const mid = 8;
    const di = (mid + mid * n + mid * n * n) * 3;
    expect(srgbToLinear(idPath[di])).toBeCloseTo(2 * srgbToLinear(0.5), 5);
  });

  it('③カーブ残差（master +0.1 全域）が恒等基底に乗る／空カーブは①とビット一致', () => {
    const emptyEdits: CurveEdits = { master: [], r: [], g: [], b: [] };
    const plain = generateLut(src, null, 4, idOpts()).lut;
    const empty = generateLut(src, null, 4, idOpts({ curves: emptyEdits })).lut;
    expect(empty).toEqual(plain); // 空 CurveEdits はケース①とビット一致。

    const curves: CurveEdits = {
      master: [{ x: 0, dy: 0.1 }, { x: 1, dy: 0.1 }],
      r: [],
      g: [],
      b: [],
    };
    const idPath = generateLut(src, null, 4, idOpts({ curves })).lut;
    const refPath = generateLut(
      src,
      ref,
      4,
      baseOptions({ mode: 'C', size: 17, strength: 0, smoothing: 0, curves }),
    ).lut;
    expect(idPath).toEqual(refPath);

    // 中間調グレーが恒等基底 0.5 から +0.1 されている（非クランプ域）。
    const n = 17;
    const mid = 8;
    const di = (mid + mid * n + mid * n * n) * 3;
    expect(idPath[di]).toBeCloseTo(0.6, 4);
  });

  it('④実効カーブ・ヒストグラムが正しい長さで返り、blackThreshold=0 で暗部が充填される', () => {
    // 暗部（リニア輝度<0.1）と中間調を半々に混ぜた合成データ。blackThreshold=0.1 を渡しても
    // 恒等経路は 0 扱いに上書きするため、暗部サンプルがヒストグラムのシャドウ域を充填する。
    const count = 4096;
    const px = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const lin = i < count / 2 ? 0.01 : 0.5; // 暗部（本来は除外対象）と中間調。
      px[i * 4] = lin;
      px[i * 4 + 1] = lin;
      px[i * 4 + 2] = lin;
      px[i * 4 + 3] = 1;
    }
    const sample = { alphaThreshold: 0.5, blackThreshold: 0.1 };
    const res = generateLut(px, null, 4, idOpts({ sample }));
    expect(res.effectiveCurves).toHaveLength(4 * CURVE_BINS);
    expect(res.histSource).toHaveLength(HIST_BLOCKS * HIST_BINS);
    expect(res.histResult).toHaveLength(HIST_BLOCKS * HIST_BINS);

    // R ブロックのシャドウ域（低位ビン）に度数があること＝暗部が除外されていない。
    const shadowSum = (hist: Float32Array): number => {
      let s = 0;
      for (let i = 0; i < 32; i++) s += hist[i]; // R ブロック先頭32ビン。
      return s;
    };
    expect(shadowSum(res.histSource)).toBeGreaterThan(0);

    // 対照：blackThreshold を尊重する Reference あり経路では暗部が除外されシャドウが空。
    const honored = generateLut(px, px, 4, baseOptions({ mode: 'C', size: 17, sample }));
    expect(shadowSum(honored.histSource)).toBe(0);
  });
});
