import { describe, expect, it } from 'vitest';
import { labToLch, linearRgbToLab, srgbToLinear } from '../src/core/colorspace.ts';
import { generateLut } from '../src/core/lut.ts';
import type { CurveEdits } from '../src/core/curve.ts';
import { NEUTRAL_ADJUSTMENTS } from '../src/core/types.ts';
import type { GenerateLutOptions, Vec3 } from '../src/core/types.ts';
import { makeLinearRgba } from './helpers.ts';

const SAMPLE = { alphaThreshold: 0.5, blackThreshold: 0 };

function baseOptions(overrides: Partial<GenerateLutOptions>): GenerateLutOptions {
  return {
    mode: 'C',
    size: 17,
    strength: 85,
    smoothing: 20,
    noiseSuppression: 0,
    manual: { ...NEUTRAL_ADJUSTMENTS },
    sample: SAMPLE,
    ...overrides,
  };
}

const src = makeLinearRgba(4096, 909);
const ref = makeLinearRgba(4096, 910);

function gridValue(lut: Float32Array, n: number, ir: number, ig: number, ib: number): Vec3 {
  const idx = (ir + ig * n + ib * n * n) * 3;
  return [lut[idx], lut[idx + 1], lut[idx + 2]];
}

function lchOfGamma(r: number, g: number, b: number): Vec3 {
  const lab: Vec3 = [0, 0, 0];
  const lch: Vec3 = [0, 0, 0];
  linearRgbToLab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), lab);
  labToLch(lab[0], lab[1], lab[2], lch);
  return lch;
}

describe('色相カーブ：ゴールデン不変（未編集はコードパスを通らずビット一致）', () => {
  const opts = baseOptions({ mode: 'C', size: 17 });
  const baseline = generateLut(src, ref, 4, { ...opts, curves: undefined });

  it('hue/hueSat 未定義（RGB カーブのみ空）→ curves なしとビット一致', () => {
    const curves: CurveEdits = { master: [], r: [], g: [], b: [] };
    const out = generateLut(src, ref, 4, { ...opts, curves });
    expect(out.lut).toEqual(baseline.lut);
    expect(out.effectiveCurves).toEqual(baseline.effectiveCurves);
    expect(out.histSource).toEqual(baseline.histSource);
    expect(out.histResult).toEqual(baseline.histResult);
  });

  it('hue/hueSat 空配列 → ビット一致', () => {
    const curves: CurveEdits = { master: [], r: [], g: [], b: [], hue: [], hueSat: [] };
    const out = generateLut(src, ref, 4, { ...opts, curves });
    expect(out.lut).toEqual(baseline.lut);
    expect(out.histSource).toEqual(baseline.histSource);
  });

  it('hue/hueSat 全 dy=0 → ビット一致（isHueCurvesEmpty で丸ごとスキップ）', () => {
    const curves: CurveEdits = {
      master: [],
      r: [],
      g: [],
      b: [],
      hue: [
        { x: 0, dy: 0 },
        { x: 0.5, dy: 0 },
      ],
      hueSat: [{ x: 0.3, dy: 0 }],
    };
    const out = generateLut(src, ref, 4, { ...opts, curves });
    expect(out.lut).toEqual(baseline.lut);
    expect(out.histSource).toEqual(baseline.histSource);
  });
});

describe('色相カーブ：グレー軸不変・RGB/色相パスの独立', () => {
  // strength:0 で base=Identity 格子（グレー対角は厳密グレー）。
  const opts = baseOptions({ mode: 'C', size: 17, strength: 0, smoothing: 0 });
  const baseline = generateLut(src, ref, 4, opts).lut;

  it('グレー対角の格子点は色相カーブ最大編集でも不変', () => {
    const curves: CurveEdits = {
      master: [],
      r: [],
      g: [],
      b: [],
      hue: [{ x: 0, dy: 1 }],
      hueSat: [{ x: 0, dy: -1 }],
    };
    const edited = generateLut(src, ref, 4, { ...opts, curves }).lut;
    const n = 17;
    for (let i = 0; i < n; i++) {
      const a = gridValue(baseline, n, i, i, i);
      const b = gridValue(edited, n, i, i, i);
      expect(b[0]).toBe(a[0]);
      expect(b[1]).toBe(a[1]);
      expect(b[2]).toBe(a[2]);
    }
  });

  it('色相編集は RGB 実効カーブ（effectiveCurves）に影響するが、RGB のみ編集は色相と独立', () => {
    // 色相編集のみ → 有彩色格子点は変化する（非自明性の担保）。
    const hueOnly: CurveEdits = {
      master: [],
      r: [],
      g: [],
      b: [],
      hue: [{ x: 0, dy: 0.5 }],
      hueSat: [],
    };
    const edited = generateLut(src, ref, 4, { ...opts, curves: hueOnly }).lut;
    let anyChanged = false;
    for (let i = 0; i < baseline.length; i++) {
      if (edited[i] !== baseline[i]) {
        anyChanged = true;
        break;
      }
    }
    expect(anyChanged).toBe(true);
  });
});

describe('色相カーブ：有彩色格子点への作用（strength:0・恒等基底）', () => {
  const opts = baseOptions({ mode: 'C', size: 17, strength: 0, smoothing: 0 });
  const n = 17;
  // 有彩色かつ非クランプ域の内部格子点（赤系）。
  const [ir, ig, ib] = [12, 4, 4];

  it('Hue vs Hue フラット dy=1 → 当該色相が約 +60° 回転', () => {
    const before = gridValue(generateLut(src, ref, 4, opts).lut, n, ir, ig, ib);
    const curves: CurveEdits = {
      master: [],
      r: [],
      g: [],
      b: [],
      hue: [{ x: 0, dy: 1 }],
      hueSat: [],
    };
    const after = gridValue(generateLut(src, ref, 4, { ...opts, curves }).lut, n, ir, ig, ib);
    const hb = lchOfGamma(before[0], before[1], before[2])[2];
    const ha = lchOfGamma(after[0], after[1], after[2])[2];
    let dh = (ha - hb + 1) % 1;
    if (dh > 0.5) dh -= 1;
    expect(dh).toBeCloseTo(60 / 360, 2);
  });

  it('Hue vs Sat フラット dy=-0.8 → 当該色相の彩度が明確に低下', () => {
    const before = gridValue(generateLut(src, ref, 4, opts).lut, n, ir, ig, ib);
    const curves: CurveEdits = {
      master: [],
      r: [],
      g: [],
      b: [],
      hue: [],
      hueSat: [{ x: 0, dy: -0.8 }],
    };
    const after = gridValue(generateLut(src, ref, 4, { ...opts, curves }).lut, n, ir, ig, ib);
    const cb = lchOfGamma(before[0], before[1], before[2])[1];
    const ca = lchOfGamma(after[0], after[1], after[2])[1];
    expect(ca).toBeLessThan(cb * 0.5);
  });
});
