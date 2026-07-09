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

/**
 * HM カーブの残差平滑化の標準偏差 σ（ビン単位・§5.3）。
 *
 * 【背景】暗部（リニア輝度 5〜15% 程度）ではソースのヒストグラムが疎になりやすく、
 * 逆 CDF 由来のリマップカーブが**単一ビンで急峻に跳ねるスパイク**を作る。
 * このスパイクはソースの微小な粒状ノイズ（±数レベル）を、チャンネル間で不整合な
 * 方向の大きな色差へ増幅し、暗部にマゼンタ/緑のスペックルを生む（実機検証で確認）。
 *
 * 【対策】カーブから恒等 y=x を引いた**残差**にごく弱い 1D ガウシアンを掛け、
 * 恒等を足し戻してからスパイクを近傍ビンへ均す。恒等入力（残差=0）は平滑化後も
 * 厳密に恒等のまま → 同一性（Source=Reference → LUT≒Identity）を壊さない。
 * 平滑化後に単調化を再適用して単調非減少を保証する。
 *
 * 【トレードオフ】σ を上げるほどスペックルは減るが Reference 分布への追従
 * （マッチ品質）がわずかに甘くなる。σ=2 は暗部の傾きスパイクを 1/6〜1/10 に
 * 抑えつつ、CDF マッチの平均挙動はほぼ保つ控えめな値。0 で平滑化無効。
 */
export const HM_RESIDUAL_SMOOTH_SIGMA = 2;

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

/**
 * 逆 CDF：確率 p に対応する x（ガンマ空間 [0,1]）を分位点線形補間で求める。
 *
 * CDF の平坦域（度数 0 の連続ビン）では**左端と右端の中点**を返す。左詰めにすると
 * 自己写像（Source=Reference）で階段状の系統的な負方向シフト（最大 ~1/HM_BINS の
 * 恒等ずれ）が出るため、中点にしてバイアスを除去する（§5.3）。急峻な交差では
 * 左右の逆像が一致するので通常の線形補間値になる。
 */
function invCdf(cdf: Float64Array, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  // 左の逆像 xLo：cdf[i] < p <= cdf[i+1] を満たす最小の i で線形補間
  //（p が平坦域の値と一致するとき平坦域の左端に着地）。線形走査、HM_BINS は 256。
  let iLo = 0;
  while (iLo < HM_BINS && cdf[iLo + 1] < p) iLo++;
  const denomLo = cdf[iLo + 1] - cdf[iLo];
  const fracLo = denomLo > 0 ? (p - cdf[iLo]) / denomLo : 0;
  const xLo = (iLo + fracLo) / HM_BINS;
  // 右の逆像 xHi：cdf[j] <= p < cdf[j+1] を満たす最大の j で線形補間
  //（p が平坦域の値と一致するとき平坦域の右端に着地）。
  let iHi = HM_BINS - 1;
  while (iHi > 0 && cdf[iHi] > p) iHi--;
  const denomHi = cdf[iHi + 1] - cdf[iHi];
  const fracHi = denomHi > 0 ? (p - cdf[iHi]) / denomHi : 0;
  const xHi = (iHi + fracHi) / HM_BINS;
  return (xLo + xHi) / 2;
}

/**
 * カーブノード y[] の**残差（y−恒等）**にガウシアンを掛けて暗部の傾きスパイクを均す。
 * 恒等を足し戻したのち単調化を再適用する（§5.3・HM_RESIDUAL_SMOOTH_SIGMA 参照）。
 *
 * - 残差平滑化なので恒等入力（y=x）は厳密に不変 → 同一性テストを壊さない。
 * - 境界は複製（端点残差を延長）。畳み込み後に累積 max で単調非減少を再保証する。
 */
function smoothResidual(y: Float64Array): void {
  const sigma = HM_RESIDUAL_SMOOTH_SIGMA;
  if (sigma <= 0) return;
  const N = HM_BINS;
  const radius = Math.max(1, Math.ceil(sigma * 3));

  // 正規化ガウシアンカーネル。
  const kernel = new Float64Array(radius * 2 + 1);
  const inv2s2 = 1 / (2 * sigma * sigma);
  let ksum = 0;
  for (let t = -radius; t <= radius; t++) {
    const w = Math.exp(-(t * t) * inv2s2);
    kernel[t + radius] = w;
    ksum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;

  // 恒等 x=i/N を引いた残差。
  const res = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) res[i] = y[i] - i / N;

  // 残差を畳み込み（複製境界）→ 恒等を足し戻し → 単調化を再適用。
  let prev = -Infinity;
  for (let i = 0; i <= N; i++) {
    let acc = 0;
    for (let t = -radius; t <= radius; t++) {
      let j = i + t;
      if (j < 0) j = 0;
      else if (j > N) j = N;
      acc += res[j] * kernel[t + radius];
    }
    let v = acc + i / N;
    if (v < prev) v = prev; // 単調非減少を再保証（正カーネルでも厳密には非保証のため）。
    y[i] = v;
    prev = v;
  }
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
  // 暗部の傾きスパイク抑制：残差平滑化（恒等は不変・単調性は再保証）。
  smoothResidual(y);
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
