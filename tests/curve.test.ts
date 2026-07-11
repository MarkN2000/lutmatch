import { describe, expect, it } from 'vitest';
import {
  type ControlPoint,
  type CurveEdits,
  evalResidual,
  isEmptyEdits,
  sampleResidualToGrid,
} from '../src/core/curve.ts';

/** 区間 [x0,x1] を dense にサンプルし、値の最小・最大を返す。 */
function sampleRange(
  points: ControlPoint[],
  x0: number,
  x1: number,
  steps = 200,
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    const v = evalResidual(points, x);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

describe('evalResidual：点数による分岐', () => {
  it('点 0 個 → 全域で 0', () => {
    for (const x of [-1, 0, 0.3, 0.7, 1, 2]) {
      expect(evalResidual([], x)).toBe(0);
    }
  });

  it('点 1 個 {x:0.5, dy:0.1} → 全域で定数 0.1', () => {
    const pts: ControlPoint[] = [{ x: 0.5, dy: 0.1 }];
    for (const x of [-0.5, 0, 0.25, 0.5, 0.9, 1.5]) {
      expect(evalResidual(pts, x)).toBeCloseTo(0.1, 12);
    }
  });
});

describe('evalResidual：制御点の通過', () => {
  const cases: ControlPoint[][] = [
    [
      { x: 0, dy: 0 },
      { x: 1, dy: 0.2 },
    ],
    [
      { x: 0, dy: 0.05 },
      { x: 0.5, dy: -0.1 },
      { x: 1, dy: 0.15 },
    ],
    [
      { x: 0, dy: 0 },
      { x: 0.25, dy: 0.3 },
      { x: 0.5, dy: 0.1 },
      { x: 0.75, dy: 0.4 },
      { x: 1, dy: -0.2 },
    ],
  ];
  for (let c = 0; c < cases.length; c++) {
    it(`パターン${c + 1}：各制御点 x_i で dy_i を厳密に通過`, () => {
      const pts = cases[c];
      for (const p of pts) {
        expect(evalResidual(pts, p.x)).toBeCloseTo(p.dy, 10);
      }
    });
  }
});

describe('evalResidual：非オーバーシュート（Fritsch–Carlson）', () => {
  // 非単調な dy 列でも、隣接点間の値は両端 dy の [min,max] を（数値誤差以上に）超えない。
  const curves: ControlPoint[][] = [
    [
      { x: 0, dy: 0 },
      { x: 0.3, dy: 0.4 },
      { x: 0.6, dy: 0.1 },
      { x: 1, dy: 0.5 },
    ],
    [
      { x: 0, dy: 0.2 },
      { x: 0.2, dy: -0.3 },
      { x: 0.5, dy: 0.3 },
      { x: 0.8, dy: -0.2 },
      { x: 1, dy: 0.1 },
    ],
    [
      { x: 0, dy: -0.1 },
      { x: 0.5, dy: -0.1 },
      { x: 0.51, dy: 0.4 },
      { x: 1, dy: 0.4 },
    ],
  ];
  const EPS = 1e-9;
  for (let c = 0; c < curves.length; c++) {
    it(`カーブ${c + 1}：全区間で値が両端 dy の範囲内`, () => {
      const pts = curves[c];
      for (let i = 0; i < pts.length - 1; i++) {
        const lo = Math.min(pts[i].dy, pts[i + 1].dy);
        const hi = Math.max(pts[i].dy, pts[i + 1].dy);
        const { min, max } = sampleRange(pts, pts[i].x, pts[i + 1].x);
        expect(min).toBeGreaterThanOrEqual(lo - EPS);
        expect(max).toBeLessThanOrEqual(hi + EPS);
      }
    });
  }
});

describe('evalResidual：端点外側の定数保持', () => {
  it('最外点の外側は端点 dy にクランプ', () => {
    const pts: ControlPoint[] = [
      { x: 0.2, dy: 0.3 },
      { x: 0.5, dy: -0.1 },
      { x: 0.8, dy: 0.25 },
    ];
    // 低端側。
    expect(evalResidual(pts, -0.5)).toBeCloseTo(0.3, 12);
    expect(evalResidual(pts, 0)).toBeCloseTo(0.3, 12);
    expect(evalResidual(pts, 0.2)).toBeCloseTo(0.3, 12);
    // 高端側。
    expect(evalResidual(pts, 0.8)).toBeCloseTo(0.25, 12);
    expect(evalResidual(pts, 1)).toBeCloseTo(0.25, 12);
    expect(evalResidual(pts, 1.5)).toBeCloseTo(0.25, 12);
  });
});

describe('evalResidual：全 dy=0 は厳密に 0', () => {
  it('複数点すべて dy=0 → 全域で === 0（丸め誤差なし）', () => {
    const pts: ControlPoint[] = [
      { x: 0, dy: 0 },
      { x: 0.2, dy: 0 },
      { x: 0.55, dy: 0 },
      { x: 0.9, dy: 0 },
      { x: 1, dy: 0 },
    ];
    for (let i = 0; i <= 100; i++) {
      const x = -0.2 + (1.4 * i) / 100;
      expect(evalResidual(pts, x)).toBe(0);
    }
  });
});

describe('sampleResidualToGrid', () => {
  it('長さ n・両端が端点値・空入力は全 0', () => {
    const pts: ControlPoint[] = [
      { x: 0, dy: 0.1 },
      { x: 1, dy: -0.2 },
    ];
    const n = 33;
    const grid = sampleResidualToGrid(pts, n);
    expect(grid.length).toBe(n);
    // Float32Array なので float32 精度で端点値に一致。
    expect(grid[0]).toBeCloseTo(0.1, 6);
    expect(grid[n - 1]).toBeCloseTo(-0.2, 6);

    const empty = sampleResidualToGrid([], n);
    expect(empty.length).toBe(n);
    expect(Array.from(empty).every((v) => v === 0)).toBe(true);
  });

  it('evalResidual と同じ値を返す（i/(n-1) の各点で一致）', () => {
    const pts: ControlPoint[] = [
      { x: 0, dy: 0 },
      { x: 0.4, dy: 0.2 },
      { x: 1, dy: -0.1 },
    ];
    const n = 17;
    const grid = sampleResidualToGrid(pts, n);
    // grid は Float32Array なので float64 の evalResidual とは float32 精度で一致。
    for (let i = 0; i < n; i++) {
      expect(grid[i]).toBeCloseTo(evalResidual(pts, i / (n - 1)), 6);
    }
  });

  it('1 点入力は全要素が定数', () => {
    const grid = sampleResidualToGrid([{ x: 0.3, dy: 0.07 }], 8);
    // Float32 精度での定数一致。
    expect(Array.from(grid).every((v) => Math.abs(v - 0.07) < 1e-6)).toBe(true);
  });
});

describe('isEmptyEdits', () => {
  const emptyEdits = (): CurveEdits => ({ master: [], r: [], g: [], b: [] });

  it('undefined → true', () => {
    expect(isEmptyEdits(undefined)).toBe(true);
  });

  it('全チャンネル空配列 → true', () => {
    expect(isEmptyEdits(emptyEdits())).toBe(true);
  });

  it('全 dy=0（点はある）→ true', () => {
    const edits = emptyEdits();
    edits.master = [
      { x: 0, dy: 0 },
      { x: 1, dy: 0 },
    ];
    edits.g = [{ x: 0.5, dy: 0 }];
    expect(isEmptyEdits(edits)).toBe(true);
  });

  it('dy 非 0 が 1 つでもあれば → false', () => {
    const edits = emptyEdits();
    edits.b = [
      { x: 0, dy: 0 },
      { x: 1, dy: 0.01 },
    ];
    expect(isEmptyEdits(edits)).toBe(false);
  });
});

describe('evalResidual：防御的入力（未ソート・重複 x）', () => {
  it('x 未ソートでもソート済みと同一結果', () => {
    const sorted: ControlPoint[] = [
      { x: 0, dy: 0 },
      { x: 0.3, dy: 0.2 },
      { x: 0.7, dy: -0.1 },
      { x: 1, dy: 0.15 },
    ];
    const shuffled: ControlPoint[] = [sorted[2], sorted[0], sorted[3], sorted[1]];
    for (let i = 0; i <= 50; i++) {
      const x = i / 50;
      expect(evalResidual(shuffled, x)).toBeCloseTo(evalResidual(sorted, x), 12);
    }
  });

  it('重複 x は後勝ちで 1 点に統合', () => {
    // x=0.5 が 2 回。後勝ちなら dy=0.3 が採用される。
    const pts: ControlPoint[] = [
      { x: 0, dy: 0 },
      { x: 0.5, dy: -0.9 },
      { x: 0.5, dy: 0.3 },
      { x: 1, dy: 0 },
    ];
    expect(evalResidual(pts, 0.5)).toBeCloseTo(0.3, 10);
    // 統合後は 3 点カーブとして通過することを確認（前の dy=-0.9 は無視）。
    const merged: ControlPoint[] = [
      { x: 0, dy: 0 },
      { x: 0.5, dy: 0.3 },
      { x: 1, dy: 0 },
    ];
    for (let i = 0; i <= 50; i++) {
      const x = i / 50;
      expect(evalResidual(pts, x)).toBeCloseTo(evalResidual(merged, x), 10);
    }
  });
});
