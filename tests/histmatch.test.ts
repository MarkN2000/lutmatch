import { describe, expect, it } from 'vitest';
import { linearToSrgb, srgbToLinear } from '../src/core/colorspace.ts';
import {
  applyCurveGamma,
  buildHistMatch,
  clampCurveSlope,
  HM_BINS,
  HM_RESIDUAL_SMOOTH_SIGMA,
  noiseSuppressionSigma,
  noiseSuppressionSlopeMax,
} from '../src/core/histmatch.ts';
import { makeLinearRgba, mulberry32 } from './helpers.ts';

function toRgb(rgba: Float32Array): Float32Array {
  const n = rgba.length / 4;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = rgba[i * 4];
    out[i * 3 + 1] = rgba[i * 4 + 1];
    out[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return out;
}

describe('HM カーブ', () => {
  it('単調非減少である', () => {
    const src = toRgb(makeLinearRgba(4096, 3));
    const ref = toRgb(makeLinearRgba(4096, 9));
    const curves = buildHistMatch(src, ref, 0);
    for (const curve of curves) {
      for (let i = 1; i <= HM_BINS; i++) {
        expect(curve.y[i]).toBeGreaterThanOrEqual(curve.y[i - 1] - 1e-12);
      }
    }
  });

  it('Source=Reference のときガンマ空間で恒等に近い', () => {
    const src = toRgb(makeLinearRgba(4096, 5));
    const curves = buildHistMatch(src, src, 0);
    for (const curve of curves) {
      for (let i = 0; i <= 100; i++) {
        const x = i / 100;
        expect(Math.abs(applyCurveGamma(curve, x) - x)).toBeLessThan(1e-3);
      }
    }
  });

  it('範囲 [0,1] 外は端点傾きで線形外挿する', () => {
    const src = toRgb(makeLinearRgba(4096, 11));
    const ref = toRgb(makeLinearRgba(4096, 13));
    const curve = buildHistMatch(src, ref, 0)[0];
    // 低端外挿：y(x) = y[0] + loSlope·x
    const xLo = -0.2;
    expect(applyCurveGamma(curve, xLo)).toBeCloseTo(curve.y[0] + curve.loSlope * xLo, 10);
    // 高端外挿：y(x) = y[HM_BINS] + hiSlope·(x−1)
    const xHi = 1.3;
    expect(applyCurveGamma(curve, xHi)).toBeCloseTo(
      curve.y[HM_BINS] + curve.hiSlope * (xHi - 1),
      10,
    );
  });

  it('カーブは全域で単調（外挿域も含む）', () => {
    const src = toRgb(makeLinearRgba(4096, 17));
    const ref = toRgb(makeLinearRgba(4096, 19));
    const curve = buildHistMatch(src, ref, 0)[1];
    let prev = -Infinity;
    for (let i = -20; i <= 120; i++) {
      const v = applyCurveGamma(curve, i / 100);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });

  it('連続空ビンを含む疎な分布でも自己マッチは恒等に近い（平坦域中点）', () => {
    // 値が飛び飛び（step ビンおき）のグラデーション。間に step-1 個の連続空ビンが
    // でき、CDF に長い平坦域が並ぶ。invCdf が平坦域を左詰めすると自己写像で
    // 系統的な負方向シフト（最大 ~1/256≈0.0039）が出るが、中点返しで解消される。
    function makeSparseGradientSrc(count: number, step: number, seed: number): Float32Array {
      const rng = mulberry32(seed);
      const px = new Float32Array(count * 3);
      const numLevels = Math.floor(HM_BINS / step);
      for (let i = 0; i < count; i++) {
        const level = Math.floor(rng() * numLevels) * step;
        const gv = (level + 0.5) / HM_BINS;
        const lin = srgbToLinear(gv);
        px[i * 3] = lin;
        px[i * 3 + 1] = lin;
        px[i * 3 + 2] = lin;
      }
      return px;
    }
    // step=5 → 4 個の連続空ビン（間の空ビンが 2 以上）。両端（ビン 0・255）は占有され
    // 上端に飽和平坦域が出ないため、内側の連続空ビン由来のずれのみを検証できる。
    const src = makeSparseGradientSrc(8192, 5, 707);
    const curves = buildHistMatch(src, src, 0);
    for (const curve of curves) {
      // ソース分布の内側（連続空ビンがちょうど問題になる領域）で恒等ずれを検証する。
      // 最上端は「ビン 255 直下の空ビン平坦域＋平滑化の境界複製」による別種の
      // エッジ効果が出るため、内側 [0.1, 0.9] に限定する（本バグの対象色は分布内側）。
      let maxErr = 0;
      for (let i = 20; i <= 180; i++) {
        const x = i / 200;
        maxErr = Math.max(maxErr, Math.abs(applyCurveGamma(curve, x) - x));
      }
      // 平坦域中点化により左詰めの系統的シフトが消え、残差平滑化と併せて恒等ずれは
      // 許容 1e-3 を大きく下回る（左詰め実装だと ~0.008 のずれが残り、この閾値を超える）。
      expect(maxErr).toBeLessThan(1e-3);
    }
  });
});

describe('HM カーブの残差平滑化（暗部スペックル対策）', () => {
  // 暗部に疎なヒストグラムを持つ Source と、なだらかな Reference を作る。
  // 平滑化なしだと逆 CDF が単一ビンで急峻に跳ね、局所傾き（隣接差×HM_BINS）が
  // 暴れる。残差平滑化はこの傾きスパイクと 2 階差分（ギザつき）を抑える。
  function makeShadowSpikeSrc(count: number, seed: number): Float32Array {
    const rng = mulberry32(seed);
    const px = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // 全ビンを最低限埋めつつ、暗部（ガンマ 0.2〜0.45）に離散的な塊を作る。
      let gv: number;
      const u = rng();
      if (i < 256) gv = (i + 0.5) / 256; // 全域カバー（CDF 単調性確保）。
      else if (u < 0.7) {
        // 暗部の少数の離散レベルに集中（疎で塊状 → スパイクの温床）。
        const levels = [52, 58, 71, 89, 96, 104];
        gv = (levels[Math.floor(rng() * levels.length)] + 0.5) / 256;
      } else gv = (Math.floor(rng() * 256) + 0.5) / 256;
      const lin = srgbToLinear(gv);
      px[i * 3] = lin;
      px[i * 3 + 1] = lin;
      px[i * 3 + 2] = lin;
    }
    return px;
  }

  it('暗部の局所傾き・ギザつき（2階差分）が抑制されている', () => {
    const src = makeShadowSpikeSrc(8192, 202);
    const ref = toRgb(makeLinearRgba(8192, 303));
    const curve = buildHistMatch(src, ref, 0)[0];

    // 暗部ビン範囲（リニア輝度 ~5〜15%）。
    const b0 = Math.max(1, Math.floor(linearToSrgb(0.05) * HM_BINS));
    const b1 = Math.floor(linearToSrgb(0.15) * HM_BINS);

    let maxSlope = 0;
    let maxJag = 0;
    for (let i = b0; i <= b1; i++) {
      const slope = (curve.y[i + 1] - curve.y[i]) * HM_BINS;
      if (slope > maxSlope) maxSlope = slope;
      if (i > b0) {
        const prevSlope = (curve.y[i] - curve.y[i - 1]) * HM_BINS;
        const jag = Math.abs(slope - prevSlope);
        if (jag > maxJag) maxJag = jag;
      }
    }
    // σ=2 の平滑化により、暗部の局所傾きは緩やかに、ギザつきは十分小さくなる。
    // （平滑化なしでは傾きが数十〜100 近くまで跳ねる。ここでは保守的な上限で回帰検知する。）
    expect(maxSlope).toBeLessThan(25);
    expect(maxJag).toBeLessThan(10);
  });

  it('平滑化しても単調非減少とマッチの平均挙動を保つ', () => {
    const src = makeShadowSpikeSrc(8192, 204);
    const ref = toRgb(makeLinearRgba(8192, 305));
    const curve = buildHistMatch(src, ref, 0)[0];
    // 単調性（残差平滑化後も再保証されている）。
    for (let i = 1; i <= HM_BINS; i++) {
      expect(curve.y[i]).toBeGreaterThanOrEqual(curve.y[i - 1] - 1e-12);
    }
    // 端点はほぼ [0,1] を跨ぐ（マッチの大域挙動を保持）。残差平滑化で端点が
    // わずかに範囲外へずれることはある（最終クランプで吸収されるため許容）。
    expect(curve.y[0]).toBeLessThan(0.02);
    expect(curve.y[HM_BINS]).toBeGreaterThan(0.98);
  });
});

describe('HM 適用（リニア入出力）', () => {
  it('恒等カーブはリニア値も往復する（Source=Reference）', () => {
    const src = toRgb(makeLinearRgba(4096, 23));
    const curve = buildHistMatch(src, src, 0)[0];
    for (const g of [0.1, 0.4, 0.7, 0.95]) {
      const lin = srgbToLinear(g);
      const mappedGamma = applyCurveGamma(curve, g);
      expect(Math.abs(mappedGamma - g)).toBeLessThan(1e-3);
      expect(lin).toBeGreaterThan(0);
    }
  });
});

// ============================================================
// ノイズ抑制（§5.3・§11 の 6 項目）
// s は残差平滑化 σ と CLAHE 式傾き上限クランプを同時に駆動する。
// ============================================================

/** 暗部に疎な塊を持つ Source（傾きスパイクの温床）。 */
function makeShadowSpikeSrc(count: number, seed: number): Float32Array {
  const rng = mulberry32(seed);
  const px = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    let gv: number;
    const u = rng();
    if (i < 256) gv = (i + 0.5) / 256; // 全域カバー（CDF 単調性確保）。
    else if (u < 0.7) {
      const levels = [52, 58, 71, 89, 96, 104];
      gv = (levels[Math.floor(rng() * levels.length)] + 0.5) / 256;
    } else gv = (Math.floor(rng() * 256) + 0.5) / 256;
    const lin = srgbToLinear(gv);
    px[i * 3] = lin;
    px[i * 3 + 1] = lin;
    px[i * 3 + 2] = lin;
  }
  return px;
}

/** ノード列の最大傾き（隣接差 × HM_BINS）。 */
function maxSlope(y: Float64Array): number {
  let m = 0;
  for (let i = 0; i < HM_BINS; i++) m = Math.max(m, (y[i + 1] - y[i]) * HM_BINS);
  return m;
}

/** 恒等残差 y[i]−i/N の標準偏差（s=100 で「恒等＋定数オフセット」に近いほど小さい）。 */
function residualStd(y: Float64Array): number {
  const N = HM_BINS;
  let mean = 0;
  for (let i = 0; i <= N; i++) mean += y[i] - i / N;
  mean /= N + 1;
  let v = 0;
  for (let i = 0; i <= N; i++) {
    const r = y[i] - i / N - mean;
    v += r * r;
  }
  return Math.sqrt(v / (N + 1));
}

/** スパイクを含む単調カーブ（総上昇量 totalRise・端点 [0.03, 0.03+totalRise]）。 */
function spikyCurve(seed: number, totalRise: number): Float64Array {
  const N = HM_BINS;
  const rng = mulberry32(seed);
  const d = new Float64Array(N);
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const v = rng() ** 5; // 重い裾 → 急峻なスパイク。
    d[i] = v;
    sum += v;
  }
  const scale = totalRise / sum;
  const y = new Float64Array(N + 1);
  y[0] = 0.03;
  for (let i = 0; i < N; i++) y[i + 1] = y[i] + d[i] * scale;
  return y;
}

describe('ノイズ抑制：パラメータマッピング（§5.3）', () => {
  it('σ(s)=2·2^(s/25)：s=0 で 2、s=100 で 32', () => {
    expect(noiseSuppressionSigma(0)).toBe(HM_RESIDUAL_SMOOTH_SIGMA); // 厳密に 2
    expect(noiseSuppressionSigma(25)).toBeCloseTo(4, 12);
    expect(noiseSuppressionSigma(100)).toBeCloseTo(32, 10);
  });

  it('S_max(s)=2^(4(1−s/100))：s=0 で 16、s=100 で 1', () => {
    expect(noiseSuppressionSlopeMax(0)).toBe(16);
    expect(noiseSuppressionSlopeMax(50)).toBeCloseTo(4, 12);
    expect(noiseSuppressionSlopeMax(100)).toBe(1);
  });
});

describe('ノイズ抑制①：s=0 はクランプをスキップし現行挙動と一致', () => {
  it('s=0 では傾きクランプが作用しない（16 超の抑制が起きない）', () => {
    // s=0 は σ=2・クランプなしの現行実装と完全一致する（§5.3）。構造上、s≤0 では
    // clampCurveSlope を一切呼ばず σ(0)=HM_RESIDUAL_SMOOTH_SIGMA を使うため、旧
    // buildChannelCurve とバイト単位で同一のコードパスになる。この「完全一致」は
    // 既存のゴールデンスナップショット（noiseSuppression:0 で不変）が旧実装の出力と
    // 一致し続けることでも担保されている。
    const src = makeShadowSpikeSrc(8192, 202);
    const ref = toRgb(makeLinearRgba(8192, 303));
    const y0 = buildHistMatch(src, ref, 0)[0].y;
    // 同一入力・同一 s=0 は決定的に同一（クランプ分岐が入っても副作用がないこと）。
    const y0b = buildHistMatch(src, ref, 0)[0].y;
    for (let i = 0; i <= HM_BINS; i++) expect(y0[i]).toBe(y0b[i]);
    // 正の s（S_max<16）ならクランプで削られる領域が、s=0 では残る＝クランプ不作用。
    const y100 = buildHistMatch(src, ref, 100)[0].y;
    expect(maxSlope(y0)).toBeGreaterThan(noiseSuppressionSlopeMax(100)); // s=0 は 1 を大きく超える
    expect(maxSlope(y0)).toBeGreaterThan(maxSlope(y100)); // s=100 では抑制される
  });
});

describe('ノイズ抑制②：クランプ＋平滑化後も単調非減少', () => {
  it('複数の s・複数分布で単調非減少を保つ', () => {
    const sources = [makeShadowSpikeSrc(8192, 211), toRgb(makeLinearRgba(8192, 61))];
    const refs = [toRgb(makeLinearRgba(8192, 71)), toRgb(makeLinearRgba(8192, 83))];
    for (let p = 0; p < sources.length; p++) {
      for (const s of [0, 15, 40, 70, 100]) {
        const curves = buildHistMatch(sources[p], refs[p], s);
        for (const curve of curves) {
          for (let i = 1; i <= HM_BINS; i++) {
            expect(curve.y[i]).toBeGreaterThanOrEqual(curve.y[i - 1] - 1e-12);
          }
        }
      }
    }
  });
});

describe('ノイズ抑制③：CLAHE 再分配で端点（総上昇量）が保存される', () => {
  it('clampCurveSlope は端点を厳密に保存し単調非減少を保つ', () => {
    for (const sMax of [1, 2, 4, 8]) {
      const y = spikyCurve(11, 0.9);
      const totalBefore = y[HM_BINS] - y[0];
      const y0 = y[0];
      const clamped = y.slice();
      clampCurveSlope(clamped, sMax);
      // 端点（総上昇量）が厳密に保存される（CLAHE の再分配は総和不変）。
      expect(clamped[0]).toBe(y0);
      expect(clamped[HM_BINS] - clamped[0]).toBeCloseTo(totalBefore, 9);
      // d≥0 を保つため単調非減少。
      for (let i = 1; i <= HM_BINS; i++) {
        expect(clamped[i]).toBeGreaterThanOrEqual(clamped[i - 1] - 1e-15);
      }
    }
  });
});

describe('ノイズ抑制④：処理後カーブの最大傾き ≤ S_max(s)+ε', () => {
  it('クランプ単体：最大傾き ≤ S_max（再分配由来の微小超過のみ許容）', () => {
    // CLAHE は端点保存を優先し最終回を再分配で打ち切るため、cap の微小超過が残り得る
    // （§5.3。後段の残差平滑化がさらに丸める）。ここでは相対 10% の許容で回帰検知する。
    for (const sMax of [1, 2, 4]) {
      const y = spikyCurve(23, 0.85);
      clampCurveSlope(y, sMax);
      expect(maxSlope(y)).toBeLessThanOrEqual(sMax * 1.1);
    }
  });

  it('クランプ＋残差平滑化込み：最大傾き ≤ S_max(s)+ε', () => {
    const src = makeShadowSpikeSrc(8192, 202);
    const ref = toRgb(makeLinearRgba(8192, 303));
    for (const s of [15, 50, 100]) {
      const curve = buildHistMatch(src, ref, s)[0];
      // 平滑化後の境界複製由来の微小違反を許容（ε=0.1）。
      expect(maxSlope(curve.y)).toBeLessThanOrEqual(noiseSuppressionSlopeMax(s) + 0.1);
    }
  });
});

describe('ノイズ抑制⑤：s=100 で恒等＋定数オフセットに近い', () => {
  it('s=100 の恒等残差の分散は s=0 より大幅に小さい', () => {
    const src = makeShadowSpikeSrc(8192, 202);
    const ref = toRgb(makeLinearRgba(8192, 303));
    const std0 = residualStd(buildHistMatch(src, ref, 0)[0].y);
    const std100 = residualStd(buildHistMatch(src, ref, 100)[0].y);
    // s=100（S_max=1・σ=32）で残差はほぼ一定（恒等＋オフセット）に収束する。
    expect(std100).toBeLessThan(std0 * 0.1); // s=0 比で 1/10 未満
    expect(std100).toBeLessThan(0.01); // 絶対値でも十分小さい
  });
});
