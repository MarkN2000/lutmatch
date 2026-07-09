import { describe, expect, it } from 'vitest';
import {
  backingStoreSize,
  clampDevicePixelRatio,
  clampSplit,
  computeFitTransform,
  computeHundredPercentTransform,
  DRAFT_LONG_EDGE,
  lutHalfTexel,
  workingSize,
} from '../src/gl/preview-math.ts';

describe('clampDevicePixelRatio', () => {
  it('上限 2 でクランプする', () => {
    expect(clampDevicePixelRatio(3)).toBe(2);
    expect(clampDevicePixelRatio(2.5)).toBe(2);
  });
  it('2 以下はそのまま', () => {
    expect(clampDevicePixelRatio(1)).toBe(1);
    expect(clampDevicePixelRatio(1.5)).toBe(1.5);
  });
  it('不正値は 1 にフォールバック', () => {
    expect(clampDevicePixelRatio(0)).toBe(1);
    expect(clampDevicePixelRatio(-1)).toBe(1);
    expect(clampDevicePixelRatio(Number.NaN)).toBe(1);
  });
});

describe('lutHalfTexel', () => {
  it('N=33 で入力 0→最初のテクセル中心、1→最後のテクセル中心に写る', () => {
    const n = 33;
    const { scale, offset } = lutHalfTexel(n);
    // c=0 → 0.5/N
    expect(0 * scale + offset).toBeCloseTo(0.5 / n, 12);
    // c=1 → (N-0.5)/N
    expect(1 * scale + offset).toBeCloseTo((n - 0.5) / n, 12);
  });
  it('scale=(N-1)/N, offset=0.5/N', () => {
    expect(lutHalfTexel(17)).toEqual({ scale: 16 / 17, offset: 0.5 / 17 });
  });
});

describe('computeFitTransform', () => {
  it('横長ビューに縦長画像を収める（高さ基準・水平中央）', () => {
    const t = computeFitTransform(100, 200, 400, 200);
    expect(t.scale).toBe(1); // min(400/100, 200/200)=1
    expect(t.offsetX).toBe(150); // (400-100)/2
    expect(t.offsetY).toBe(0);
  });
  it('画像がビューより大きければ縮小する', () => {
    const t = computeFitTransform(1000, 500, 400, 400);
    expect(t.scale).toBeCloseTo(0.4, 12); // min(400/1000,400/500)=0.4
    expect(t.offsetX).toBeCloseTo(0, 12);
    expect(t.offsetY).toBeCloseTo(100, 12); // (400-200)/2
  });
  it('不正サイズは恒等変換', () => {
    expect(computeFitTransform(0, 100, 100, 100)).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
  });
});

describe('computeHundredPercentTransform', () => {
  it('scale=1・画像中央配置', () => {
    const t = computeHundredPercentTransform(100, 100, 400, 300);
    expect(t.scale).toBe(1);
    expect(t.offsetX).toBe(150);
    expect(t.offsetY).toBe(100);
  });
});

describe('workingSize', () => {
  it('長辺 512 に間引く（アスペクト維持）', () => {
    const { w, h } = workingSize(4000, 3000, DRAFT_LONG_EDGE);
    expect(w).toBe(512);
    expect(h).toBe(384);
  });
  it('十分小さければそのまま', () => {
    expect(workingSize(300, 200, 512)).toEqual({ w: 300, h: 200 });
  });
  it('最低 1px を保証', () => {
    const { w, h } = workingSize(10, 100000, 512);
    expect(w).toBeGreaterThanOrEqual(1);
    expect(h).toBe(512);
  });
});

describe('backingStoreSize', () => {
  it('CSS サイズ×クランプ済み dpr', () => {
    expect(backingStoreSize(800, 600, 3)).toEqual({ width: 1600, height: 1200 }); // dpr→2
    expect(backingStoreSize(800, 600, 1)).toEqual({ width: 800, height: 600 });
  });
});

describe('clampSplit', () => {
  it('[0,1] にクランプ', () => {
    expect(clampSplit(-0.2)).toBe(0);
    expect(clampSplit(1.5)).toBe(1);
    expect(clampSplit(0.3)).toBe(0.3);
    expect(clampSplit(Number.NaN)).toBe(0.5);
  });
});
