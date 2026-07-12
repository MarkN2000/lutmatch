import { describe, expect, it } from 'vitest';
import {
  type ControlPoint,
  evalResidualPeriodic,
  sampleResidualToGridPeriodic,
} from '../src/core/curve.ts';

describe('evalResidualPeriodic：点数による分岐', () => {
  it('点 0 個 → 全域で 0', () => {
    for (const x of [-1, 0, 0.3, 0.7, 1, 2]) {
      expect(evalResidualPeriodic([], x)).toBe(0);
    }
  });

  it('点 1 個 {x:0.4, dy:0.15} → 全周で定数 0.15', () => {
    const pts: ControlPoint[] = [{ x: 0.4, dy: 0.15 }];
    for (const x of [-0.5, 0, 0.25, 0.4, 0.9, 1.5]) {
      expect(evalResidualPeriodic(pts, x)).toBeCloseTo(0.15, 12);
    }
  });

  it('全 dy=0 → 全域で厳密に 0（丸め誤差なし）', () => {
    const pts: ControlPoint[] = [
      { x: 0, dy: 0 },
      { x: 0.25, dy: 0 },
      { x: 0.6, dy: 0 },
      { x: 0.9, dy: 0 },
    ];
    for (let i = 0; i <= 120; i++) {
      const x = -0.2 + (1.4 * i) / 120;
      expect(evalResidualPeriodic(pts, x)).toBe(0);
    }
  });
});

describe('evalResidualPeriodic：制御点通過とラップ', () => {
  const pts: ControlPoint[] = [
    { x: 0, dy: 0.2 },
    { x: 0.3, dy: -0.1 },
    { x: 0.6, dy: 0.3 },
    { x: 0.85, dy: -0.2 },
  ];

  it('各制御点 x_i で dy_i を厳密に通過', () => {
    for (const p of pts) {
      expect(evalResidualPeriodic(pts, p.x)).toBeCloseTo(p.dy, 10);
    }
  });

  it('x は周期でラップ（x と x+1 が一致）', () => {
    for (const x of [0.15, 0.42, 0.77, 0.95]) {
      expect(evalResidualPeriodic(pts, x)).toBeCloseTo(evalResidualPeriodic(pts, x + 1), 12);
      expect(evalResidualPeriodic(pts, x)).toBeCloseTo(evalResidualPeriodic(pts, x - 2), 12);
    }
  });
});

describe('evalResidualPeriodic：継ぎ目（x=0/1）の C1 連続', () => {
  // 継ぎ目に制御点を「置かない」カーブ（x=0 は点だが 0.9〜1.0 区間は wrap 区間）。
  const pts: ControlPoint[] = [
    { x: 0.1, dy: 0.25 },
    { x: 0.45, dy: -0.15 },
    { x: 0.7, dy: 0.35 },
    { x: 0.9, dy: -0.05 },
  ];

  it('値が継ぎ目で連続：eval(1−ε) ≈ eval(0)', () => {
    const eps = 1e-7;
    expect(evalResidualPeriodic(pts, 1 - eps)).toBeCloseTo(evalResidualPeriodic(pts, 0), 6);
    // ラップ区間内 [0.9, 1.1] を通しても飛びがない。
    let prev = evalResidualPeriodic(pts, 0.9);
    for (let i = 1; i <= 40; i++) {
      const x = 0.9 + (0.2 * i) / 40;
      const v = evalResidualPeriodic(pts, x);
      expect(Math.abs(v - prev)).toBeLessThan(0.05); // 小刻みなら段差なし。
      prev = v;
    }
  });

  it('傾きが継ぎ目で連続：左右の数値微分が一致', () => {
    const h = 1e-5;
    // 継ぎ目 x=0 の左（0−h≡1−h）と右（0+h）で中心差分の傾きを比較。
    const slopeLeft =
      (evalResidualPeriodic(pts, -h) - evalResidualPeriodic(pts, -3 * h)) / (2 * h);
    const slopeRight =
      (evalResidualPeriodic(pts, 3 * h) - evalResidualPeriodic(pts, h)) / (2 * h);
    expect(slopeLeft).toBeCloseTo(slopeRight, 2); // C1 連続。
  });

  it('継ぎ目をまたぐ制御点があっても通過・連続', () => {
    // x=0 と x=0.95 の 2 点だけ（wrap 区間 [0.95,1.0] が短い）。
    const p2: ControlPoint[] = [
      { x: 0, dy: 0.1 },
      { x: 0.95, dy: 0.4 },
    ];
    expect(evalResidualPeriodic(p2, 0)).toBeCloseTo(0.1, 10);
    expect(evalResidualPeriodic(p2, 0.95)).toBeCloseTo(0.4, 10);
    const eps = 1e-7;
    expect(evalResidualPeriodic(p2, 1 - eps)).toBeCloseTo(evalResidualPeriodic(p2, 0), 6);
  });
});

describe('sampleResidualToGridPeriodic', () => {
  const pts: ControlPoint[] = [
    { x: 0, dy: 0.2 },
    { x: 0.3, dy: -0.1 },
    { x: 0.65, dy: 0.3 },
  ];

  it('長さ n・x=i/n の各点で evalResidualPeriodic と一致', () => {
    const n = 32;
    const grid = sampleResidualToGridPeriodic(pts, n);
    expect(grid.length).toBe(n);
    for (let i = 0; i < n; i++) {
      expect(grid[i]).toBeCloseTo(evalResidualPeriodic(pts, i / n), 6);
    }
    // grid[0] は x=0（＝x=1 と同一点）。
    expect(grid[0]).toBeCloseTo(0.2, 6);
  });

  it('空入力 → 全 0、1 点入力 → 全要素定数', () => {
    const empty = sampleResidualToGridPeriodic([], 16);
    expect(Array.from(empty).every((v) => v === 0)).toBe(true);
    const one = sampleResidualToGridPeriodic([{ x: 0.5, dy: 0.07 }], 16);
    expect(Array.from(one).every((v) => Math.abs(v - 0.07) < 1e-6)).toBe(true);
  });

  it('全 dy=0 → 全要素厳密に 0', () => {
    const grid = sampleResidualToGridPeriodic(
      [
        { x: 0, dy: 0 },
        { x: 0.4, dy: 0 },
        { x: 0.8, dy: 0 },
      ],
      24,
    );
    expect(Array.from(grid).every((v) => v === 0)).toBe(true);
  });
});
