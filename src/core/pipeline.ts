/**
 * モード合成（§5.4）。3 モード（A=MKL / B=HM / C=HM→MKL→HM）の変換関数を構築する。
 *
 * すべての変換はリニア RGB → リニア RGB で、**中間段では 0–1 クランプしない**。
 * 複合モード C は段間データフロー（§5.4）に従い、各段の変換で解析サンプルを押し出し、
 * 次段の統計を変換後サンプルから推定する。
 */

import { applyHistMatch, buildHistMatch } from './histmatch.ts';
import type { HistMatchCurves } from './histmatch.ts';
import { applyLinearTransform, buildMkl } from './mkl.ts';
import type { LinearTransform } from './mkl.ts';
import { computeColorStats, N_MIN_PIXELS, regularizedCovInv } from './stats.ts';
import type { ColorStats, MatchMode, Mat3, Vec3 } from './types.ts';

/** 構築済みマッチ変換。`apply` はリニア RGB → リニア RGB（クランプなし）。 */
export interface MatchTransform {
  /** 変換を 1 画素に適用し `out`（長さ 3・リニア）へ書き込む。 */
  apply: (r: number, g: number, b: number, out: Vec3) => void;
  /** フォールバック（平均シフト / ランク落ち / 極少画素）が発生したか。 */
  fallback: boolean;
  /** Source のリニア平均 μs（マハラノビス減衰用）。 */
  srcMean: Vec3;
  /** Source の正則化逆共分散 Σs⁻¹（マハラノビス減衰用）。 */
  srcCovInv: Mat3;
}

/** パック RGB サンプルを変換で押し出し、新しいパック配列を返す（クランプなし）。 */
function mapSamples(
  samples: Float32Array,
  apply: (r: number, g: number, b: number, out: Vec3) => void,
): Float32Array {
  const out = new Float32Array(samples.length);
  const t: Vec3 = [0, 0, 0];
  for (let i = 0; i < samples.length; i += 3) {
    apply(samples[i], samples[i + 1], samples[i + 2], t);
    out[i] = t[0];
    out[i + 1] = t[1];
    out[i + 2] = t[2];
  }
  return out;
}

/** 平均シフト変換 f(x) = x − μs + μr を生成する。 */
function meanShiftApply(muS: Vec3, muR: Vec3) {
  return (r: number, g: number, b: number, out: Vec3): void => {
    out[0] = r - muS[0] + muR[0];
    out[1] = g - muS[1] + muR[1];
    out[2] = b - muS[2] + muR[2];
  };
}

/** MKL 線形写像の適用クロージャを生成する。 */
function linearApply(tf: LinearTransform) {
  return (r: number, g: number, b: number, out: Vec3): void => {
    applyLinearTransform(tf, r, g, b, out);
  };
}

/** HM の適用クロージャを生成する。 */
function histApply(curves: HistMatchCurves) {
  return (r: number, g: number, b: number, out: Vec3): void => {
    applyHistMatch(curves, r, g, b, out);
  };
}

/**
 * 自動マッチの変換関数を構築する（§5.4）。
 *
 * 有効画素数が `N_MIN_PIXELS` 未満の場合は、モードに関わらず平均シフトのみへ
 * フォールバックする（§5.1）。
 *
 * @param mode 自動マッチのモード
 * @param srcSamples Source のパック RGB サンプル（リニア・有効画素のみ）
 * @param refSamples Reference のパック RGB サンプル（リニア・有効画素のみ）
 * @param noiseSuppression ノイズ抑制 s（0–100・§5.3）。HM を使う B/C にのみ作用（A は無関係）。
 */
export function buildMatchTransform(
  mode: MatchMode,
  srcSamples: Float32Array,
  refSamples: Float32Array,
  noiseSuppression: number,
): MatchTransform {
  const srcStats = computeColorStats(srcSamples);
  const refStats = computeColorStats(refSamples);
  const srcMean = srcStats.mean.slice();
  const srcCovInv = regularizedCovInv(srcStats.cov);
  const n = Math.min(srcStats.count, refStats.count);

  // 極少画素：全モードで平均シフトへフォールバック（§5.1）。
  if (n < N_MIN_PIXELS) {
    return {
      apply: meanShiftApply(srcStats.mean, refStats.mean),
      fallback: true,
      srcMean,
      srcCovInv,
    };
  }

  switch (mode) {
    case 'A': {
      const mkl = buildMkl(srcStats, refStats, n);
      return { apply: linearApply(mkl.transform), fallback: mkl.fallback, srcMean, srcCovInv };
    }
    case 'B': {
      const curves = buildHistMatch(srcSamples, refSamples, noiseSuppression);
      return { apply: histApply(curves), fallback: false, srcMean, srcCovInv };
    }
    case 'C':
    default:
      return buildComposite(
        srcSamples,
        refSamples,
        refStats,
        n,
        srcMean,
        srcCovInv,
        noiseSuppression,
      );
  }
}

/** 複合モード C：HM → MKL → HM（段間データフローに従う・§5.4）。 */
function buildComposite(
  srcSamples: Float32Array,
  refSamples: Float32Array,
  refStats: ColorStats,
  n: number,
  srcMean: Vec3,
  srcCovInv: Mat3,
  noiseSuppression: number,
): MatchTransform {
  // 1 段目 HM：元 Source 分布 → 元 Reference 分布。Source を押し出して S₁ を得る。
  // ノイズ抑制は 1 段目・2 段目双方に同一パラメータを適用する（§5.3）。
  const hm1 = buildHistMatch(srcSamples, refSamples, noiseSuppression);
  const s1 = mapSamples(srcSamples, histApply(hm1));

  // MKL 段：S₁ の平均・共分散を Reference へ合わせる。S₁ を押し出して S₂ を得る。
  const s1Stats = computeColorStats(s1);
  const mkl = buildMkl(s1Stats, refStats, n);
  const s2 = mapSamples(s1, linearApply(mkl.transform));

  // 2 段目 HM：S₂ の分布 → 元 Reference 分布。
  const hm2 = buildHistMatch(s2, refSamples, noiseSuppression);

  const t1: Vec3 = [0, 0, 0];
  const t2: Vec3 = [0, 0, 0];
  const apply = (r: number, g: number, b: number, out: Vec3): void => {
    applyHistMatch(hm1, r, g, b, t1);
    applyLinearTransform(mkl.transform, t1[0], t1[1], t1[2], t2);
    applyHistMatch(hm2, t2[0], t2[1], t2[2], out);
  };

  return { apply, fallback: mkl.fallback, srcMean, srcCovInv };
}
