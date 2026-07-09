/**
 * ヒストグラムマッチング（HM・§5.3）。
 *
 * R/G/B 各チャンネルについて Source の CDF を Reference の CDF へ写像する
 * 1D 単調リマップ。**CDF 構築・カーブ適用はガンマ（sRGB）空間**で行う
 * （§4.2 の「統計はリニア」原則の意図的な例外）。ビンは 256 個・ガンマ空間で等間隔。
 *
 * - 逆 CDF は分位点の線形補間で求める。
 * - 得られるカーブは単調非減少であることを保証する。
 * - ビン範囲 [0,1] の外側は端点の傾きで線形外挿する（中間クランプなし・§5.4）。
 */

import { linearToSrgb, srgbToLinear } from './colorspace.ts';
import type { Vec3 } from './types.ts';

/** HM のビン数（ガンマ空間・等間隔）。 */
export const HM_BINS = 256;

/** 1 チャンネルのリマップカーブ。ガンマ空間の等間隔ノード y[i]（x=i/HM_BINS）を持つ。 */
export interface ChannelCurve {
  /** ノード出力値（長さ HM_BINS+1、x=i/HM_BINS のガンマ空間値）。 */
  y: Float64Array;
  /** 低端（x≤0）外挿用の傾き。 */
  loSlope: number;
  /** 高端（x≥1）外挿用の傾き。 */
  hiSlope: number;
}

/** R/G/B 3 チャンネル分のカーブ。 */
export type HistMatchCurves = [ChannelCurve, ChannelCurve, ChannelCurve];

/**
 * パック RGB サンプルからチャンネル別のガンマ空間 CDF を構築する。
 * @returns 各チャンネルの CDF（長さ HM_BINS+1、ノード x=i/HM_BINS の累積確率）。
 */
function buildCdfs(samples: Float32Array): [Float64Array, Float64Array, Float64Array] {
  const hist = [
    new Float64Array(HM_BINS),
    new Float64Array(HM_BINS),
    new Float64Array(HM_BINS),
  ];
  const count = Math.floor(samples.length / 3);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 3; c++) {
      const gamma = linearToSrgb(samples[i * 3 + c]);
      let bin = Math.floor(gamma * HM_BINS);
      if (bin < 0) bin = 0;
      else if (bin >= HM_BINS) bin = HM_BINS - 1;
      hist[c][bin] += 1;
    }
  }
  const cdfs: [Float64Array, Float64Array, Float64Array] = [
    new Float64Array(HM_BINS + 1),
    new Float64Array(HM_BINS + 1),
    new Float64Array(HM_BINS + 1),
  ];
  for (let c = 0; c < 3; c++) {
    const total = count > 0 ? count : 1;
    let acc = 0;
    cdfs[c][0] = 0;
    for (let b = 0; b < HM_BINS; b++) {
      acc += hist[c][b];
      cdfs[c][b + 1] = acc / total;
    }
    cdfs[c][HM_BINS] = 1;
  }
  return cdfs;
}

/** CDF を x（ガンマ空間 [0,1]）で評価（ノード間は線形補間）。 */
function evalCdf(cdf: Float64Array, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const pos = x * HM_BINS;
  const i = Math.floor(pos);
  const f = pos - i;
  return cdf[i] + (cdf[i + 1] - cdf[i]) * f;
}

/** 逆 CDF：確率 p に対応する x（ガンマ空間 [0,1]）を分位点線形補間で求める。 */
function invCdf(cdf: Float64Array, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  // cdf[i] <= p < cdf[i+1] を満たす最小の i を探す（線形走査、HM_BINS は 256）。
  let i = 0;
  while (i < HM_BINS && cdf[i + 1] < p) i++;
  const lo = cdf[i];
  const hi = cdf[i + 1];
  const denom = hi - lo;
  const frac = denom > 0 ? (p - lo) / denom : 0;
  return (i + frac) / HM_BINS;
}

/**
 * Source→Reference のチャンネルリマップカーブを構築する（単調非減少を保証）。
 */
function buildChannelCurve(cdfS: Float64Array, cdfR: Float64Array): ChannelCurve {
  const y = new Float64Array(HM_BINS + 1);
  let prev = -Infinity;
  for (let i = 0; i <= HM_BINS; i++) {
    const x = i / HM_BINS;
    const mapped = invCdf(cdfR, evalCdf(cdfS, x));
    // 単調非減少を保証（数値誤差で非単調が生じたら補正）。
    y[i] = mapped < prev ? prev : mapped;
    prev = y[i];
  }
  const loSlope = (y[1] - y[0]) * HM_BINS;
  const hiSlope = (y[HM_BINS] - y[HM_BINS - 1]) * HM_BINS;
  return { y, loSlope, hiSlope };
}

/**
 * HM カーブ（3 チャンネル）を構築する。
 * @param srcSamples Source のパック RGB サンプル（リニア）
 * @param refSamples Reference のパック RGB サンプル（リニア）
 */
export function buildHistMatch(
  srcSamples: Float32Array,
  refSamples: Float32Array,
): HistMatchCurves {
  const cdfS = buildCdfs(srcSamples);
  const cdfR = buildCdfs(refSamples);
  return [
    buildChannelCurve(cdfS[0], cdfR[0]),
    buildChannelCurve(cdfS[1], cdfR[1]),
    buildChannelCurve(cdfS[2], cdfR[2]),
  ];
}

/** カーブをガンマ空間の値 x に適用する。[0,1] 外は端点傾きで線形外挿（§5.4）。 */
export function applyCurveGamma(curve: ChannelCurve, x: number): number {
  const { y, loSlope, hiSlope } = curve;
  if (x <= 0) return y[0] + loSlope * x;
  if (x >= 1) return y[HM_BINS] + hiSlope * (x - 1);
  const pos = x * HM_BINS;
  const i = Math.floor(pos);
  const f = pos - i;
  return y[i] + (y[i + 1] - y[i]) * f;
}

/**
 * HM を 1 画素（リニア RGB）に適用する。ガンマ空間へ写像→カーブ→リニアへ戻す。
 * 中間クランプなし（符号付き変換で範囲外値を保持）。
 * @param curves 3 チャンネルのカーブ
 * @param r,g,b 入力リニア RGB
 * @param out 出力（長さ 3・リニア）
 */
export function applyHistMatch(
  curves: HistMatchCurves,
  r: number,
  g: number,
  b: number,
  out: Vec3,
): Vec3 {
  out[0] = srgbToLinear(applyCurveGamma(curves[0], linearToSrgb(r)));
  out[1] = srgbToLinear(applyCurveGamma(curves[1], linearToSrgb(g)));
  out[2] = srgbToLinear(applyCurveGamma(curves[2], linearToSrgb(b)));
  return out;
}
