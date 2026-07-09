import { describe, expect, it } from 'vitest';
import {
  labToLinearRgb,
  linearRgbToLab,
  linearToSrgb,
  rec709Luminance,
  srgbToLinear,
} from '../src/core/colorspace.ts';
import type { Vec3 } from '../src/core/types.ts';

describe('sRGB ⇄ リニア', () => {
  it('往復誤差が十分小さい（[0,1]）', () => {
    for (let i = 0; i <= 100; i++) {
      const c = i / 100;
      const round = linearToSrgb(srgbToLinear(c));
      expect(Math.abs(round - c)).toBeLessThan(1e-6);
    }
  });

  it('符号付き拡張：負値でも符号を保って往復する', () => {
    for (const c of [-0.8, -0.3, -0.02, 0.02, 0.5, 1.4]) {
      const round = linearToSrgb(srgbToLinear(c));
      expect(Math.abs(round - c)).toBeLessThan(1e-6);
      expect(Math.sign(srgbToLinear(c))).toBe(Math.sign(c));
    }
  });

  it('既知値：sRGB 1.0 → リニア 1.0、0 → 0', () => {
    expect(srgbToLinear(1)).toBeCloseTo(1, 6);
    expect(srgbToLinear(0)).toBe(0);
    expect(linearToSrgb(1)).toBeCloseTo(1, 6);
  });
});

describe('リニア RGB ⇄ Lab', () => {
  it('往復誤差が十分小さい', () => {
    const lab: Vec3 = [0, 0, 0];
    const rgb: Vec3 = [0, 0, 0];
    for (const t of [
      [0.1, 0.2, 0.3],
      [0.9, 0.5, 0.05],
      [1, 1, 1],
      [0.001, 0.5, 0.99],
    ]) {
      linearRgbToLab(t[0], t[1], t[2], lab);
      labToLinearRgb(lab[0], lab[1], lab[2], rgb);
      expect(Math.abs(rgb[0] - t[0])).toBeLessThan(1e-5);
      expect(Math.abs(rgb[1] - t[1])).toBeLessThan(1e-5);
      expect(Math.abs(rgb[2] - t[2])).toBeLessThan(1e-5);
    }
  });

  it('負値（範囲外）でも往復できる（符号付き立方根拡張）', () => {
    const lab: Vec3 = [0, 0, 0];
    const rgb: Vec3 = [0, 0, 0];
    const t = [-0.05, 0.4, 1.2];
    linearRgbToLab(t[0], t[1], t[2], lab);
    labToLinearRgb(lab[0], lab[1], lab[2], rgb);
    expect(Math.abs(rgb[0] - t[0])).toBeLessThan(1e-4);
    expect(Math.abs(rgb[1] - t[1])).toBeLessThan(1e-4);
    expect(Math.abs(rgb[2] - t[2])).toBeLessThan(1e-4);
  });

  it('中間グレーの L* は 50 付近（リニア 0.184 ≈ L50）', () => {
    const lab: Vec3 = [0, 0, 0];
    const y = srgbToLinear(0.5);
    linearRgbToLab(y, y, y, lab);
    expect(lab[0]).toBeGreaterThan(45);
    expect(lab[0]).toBeLessThan(60);
    // 中性グレーは a*,b* ≈ 0（行列定数の丸め由来で ~1e-5 の残差）。
    expect(Math.abs(lab[1])).toBeLessThan(1e-4);
    expect(Math.abs(lab[2])).toBeLessThan(1e-4);
  });
});

describe('Rec.709 リニア輝度', () => {
  it('白は 1、グレー中間は係数どおり', () => {
    expect(rec709Luminance(1, 1, 1)).toBeCloseTo(1, 6);
    expect(rec709Luminance(1, 0, 0)).toBeCloseTo(0.2126, 6);
    expect(rec709Luminance(0, 1, 0)).toBeCloseTo(0.7152, 6);
    expect(rec709Luminance(0, 0, 1)).toBeCloseTo(0.0722, 6);
  });
});
