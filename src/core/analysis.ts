/**
 * カーブエディタの表示用データ（実効カーブ・ヒストグラム）を求める純粋関数層。
 *
 * すべて **ガンマ（sRGB）空間** で集計・表示する（HM のビン割りと同じ思想・§5.3）。
 * 解析サンプル `linearSamples` は **リニア RGB** をパックした配列（`extractValidSamples`）
 * のため、入力座標は `linearToSrgb` でガンマ化してから扱う。
 *
 * - 実効カーブ F：残差適用前・クランプ前の `base` 格子（ガンマ空間）にサンプルを
 *   trilinear 適用し、ビンごとに E[out_c | in_c] を回帰する（記述的カーブ）。
 * - ヒストグラム：Source（リニア→ガンマ化）／結果（最終 LUT 通過後）の度数分布。
 *
 * 実効カーブは **[R | G | B | M] の4ブロック連結**（M はマスター＝ガンマ空間 luma）。
 * ヒストグラムは **[R | G | B | Y' | H] の5ブロック連結**（Y' はガンマ空間 luma 分布、
 * H は色相 h∈[0,1) の彩度重み付き分布・`HIST_BLOCKS`＝5）。
 */

import { labToLch, linearRgbToLab, linearToSrgb, srgbToLinear } from './colorspace.ts';
import { chromaWeight } from './huecurve.ts';
import { trilinearSample } from './lut.ts';
import type { Vec3 } from './types.ts';

/** 実効カーブの解像度（入力ビン数）。 */
export const CURVE_BINS = 64;
/** ヒストグラムの解像度（度数ビン数）。 */
export const HIST_BINS = 256;

/** ヒストグラムのブロック数（[R|G|B|Y'|H] の 5 ブロック連結）。 */
export const HIST_BLOCKS = 5;

/**
 * ガンマ空間 Rec.709 luma（Y' = 0.2126R' + 0.7152G' + 0.0722B'）。
 *
 * `colorspace.rec709Luminance` と係数は同一だが、あちらは **リニア**輝度用の名称。
 * こちらはガンマ値そのものに係数を掛ける「表示・適用・ヒストグラムで共通の定義」
 * を明示するために別名で公開する（マスターカーブ適用と同一・§5.7）。
 */
export function gammaLuma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** ビン中心のガンマ値（恒等フォールバック F(x)=x の x 座標）。 */
function binCenter(i: number, bins: number): number {
  return (i + 0.5) / bins;
}

/** ガンマ値 x を [0, bins) のビン番号へ量子化（範囲外はクランプ）。 */
function binOf(x: number, bins: number): number {
  const b = Math.floor(x * bins);
  return b < 0 ? 0 : b >= bins ? bins - 1 : b;
}

/**
 * 1 ブロック分（長さ bins）の (sum, count) から平均カーブを求め、空ビンを埋める。
 *
 * - 充填ビンは平均値。
 * - 内部の空ビンは前後の充填ビン間を **ビン番号で線形補間**。
 * - 先頭側／末尾側の空ビンは最寄りの充填ビン値を保持（最近傍ホールド）。
 * - 全ビン空なら恒等 F(x)=x（各ビン中心の x をそのまま値に）。
 */
function fillCurveBlock(
  out: Float32Array,
  sums: Float64Array,
  counts: Uint32Array,
  off: number,
  bins: number,
): void {
  let first = -1;
  let last = -1;
  // 充填ビンの平均を書き込みつつ両端の充填位置を記録。
  for (let i = 0; i < bins; i++) {
    if (counts[off + i] > 0) {
      out[off + i] = sums[off + i] / counts[off + i];
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) {
    // 全ビン空：恒等カーブ。
    for (let i = 0; i < bins; i++) out[off + i] = binCenter(i, bins);
    return;
  }
  // 内部の空ビンを線形補間。
  let prev = first;
  for (let i = first + 1; i <= last; i++) {
    if (counts[off + i] > 0) {
      if (i - prev > 1) {
        const v0 = out[off + prev];
        const v1 = out[off + i];
        const span = i - prev;
        for (let j = prev + 1; j < i; j++) {
          out[off + j] = v0 + ((v1 - v0) * (j - prev)) / span;
        }
      }
      prev = i;
    }
  }
  // 両端の空ビンは最近傍ホールド。
  for (let j = 0; j < first; j++) out[off + j] = out[off + first];
  for (let j = last + 1; j < bins; j++) out[off + j] = out[off + last];
}

/**
 * 実効カーブ F を求める（記述的・§5.7）。
 *
 * `base`（ガンマ空間・残差前・クランプ前の格子）にリニアサンプルをガンマ化して
 * trilinear 適用し、ガンマ空間で E[out_c | in_c] をビン回帰する。マスター（M）は
 * E[Y'_out | Y'_in]（ガンマ空間 luma）。
 *
 * @param base base 格子（Float64Array・長さ 3n³・R 最速・ガンマ RGB）
 * @param n 格子解像度
 * @param linearSamples 有効画素のリニア RGB パック配列（長さ 3×画素数）
 * @param bins 入力ビン数（既定 CURVE_BINS）
 * @returns Float32Array(4×bins)。[R|G|B|M] 連結。空ビンは補間、全空は恒等
 */
export function computeEffectiveCurves(
  base: Float64Array,
  n: number,
  linearSamples: Float32Array,
  bins: number = CURVE_BINS,
): Float32Array {
  const out = new Float32Array(4 * bins);
  const sums = new Float64Array(4 * bins);
  const counts = new Uint32Array(4 * bins);
  const count = Math.floor(linearSamples.length / 3);
  const tri: Vec3 = [0, 0, 0];

  for (let i = 0; i < count; i++) {
    // リニアサンプル → ガンマ入力座標。
    const xr = linearToSrgb(linearSamples[i * 3]);
    const xg = linearToSrgb(linearSamples[i * 3 + 1]);
    const xb = linearToSrgb(linearSamples[i * 3 + 2]);
    // base 格子をガンマ座標で trilinear 適用（出力もガンマ空間）。
    trilinearSample(base, n, xr, xg, xb, tri);

    // R/G/B：各チャンネルの入力ビンに自チャンネル出力を積算。
    const br = binOf(xr, bins);
    const bg = bins + binOf(xg, bins);
    const bb = 2 * bins + binOf(xb, bins);
    sums[br] += tri[0];
    counts[br]++;
    sums[bg] += tri[1];
    counts[bg]++;
    sums[bb] += tri[2];
    counts[bb]++;

    // M（マスター）：ガンマ空間 luma の入力ビンに出力 luma を積算。
    const bm = 3 * bins + binOf(gammaLuma(xr, xg, xb), bins);
    sums[bm] += gammaLuma(tri[0], tri[1], tri[2]);
    counts[bm]++;
  }

  for (let block = 0; block < 4; block++) {
    fillCurveBlock(out, sums, counts, block * bins, bins);
  }
  return out;
}

/**
 * ガンマ座標三つ組をヒストグラム（R/G/B/Y' の先頭4ブロック度数）へ積算する内部ヘルパ。
 * H（第5）ブロックは色相・彩度重みが必要なため `accumHueBlock` が別途担う。
 * @param hist 度数バッファ（長さ HIST_BLOCKS×bins）
 */
function accumHist(hist: Float64Array, bins: number, r: number, g: number, b: number): void {
  hist[binOf(r, bins)]++;
  hist[bins + binOf(g, bins)]++;
  hist[2 * bins + binOf(b, bins)]++;
  hist[3 * bins + binOf(gammaLuma(r, g, b), bins)]++;
}

const hueLab: Vec3 = [0, 0, 0];
const hueLch: Vec3 = [0, 0, 0];

/**
 * ガンマ RGB 三つ組を H（第5）ブロックへ積算する。色相 h（周期 [0,1)）を bin 化し、
 * 低彩度減衰の重み w=chromaWeight(C) を度数として加える（グレー画素の無意味な色相を抑制）。
 * @param hist 度数バッファ（長さ HIST_BLOCKS×bins）
 */
function accumHueBlock(hist: Float64Array, bins: number, r: number, g: number, b: number): void {
  linearRgbToLab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), hueLab);
  labToLch(hueLab[0], hueLab[1], hueLab[2], hueLch);
  const w = chromaWeight(hueLch[1]);
  if (w > 0) hist[4 * bins + binOf(hueLch[2], bins)] += w;
}

/** 各ブロックを自身の最大度数で [0,1] 正規化して Float32Array へ書き出す。全0はそのまま。 */
function normalizeHist(hist: Float64Array, bins: number): Float32Array {
  const out = new Float32Array(HIST_BLOCKS * bins);
  for (let block = 0; block < HIST_BLOCKS; block++) {
    const off = block * bins;
    let max = 0;
    for (let i = 0; i < bins; i++) if (hist[off + i] > max) max = hist[off + i];
    if (max <= 0) continue; // 画素なしブロックは全0のまま。
    const inv = 1 / max;
    for (let i = 0; i < bins; i++) out[off + i] = hist[off + i] * inv;
  }
  return out;
}

/**
 * リニア RGB サンプルのガンマ空間ヒストグラム（R/G/B/Y' ＋ H）。
 *
 * R/G/B/Y' の 4 ブロックは**素の Source サンプル**（リニア→ガンマ化）から集計する。
 * H（第5）ブロックは意味が異なり、`hueGrid`（＝色相カーブ適用**前**の base 格子）を
 * サンプルへ trilinear 適用した後の色相分布を集計する（色相カーブ編集で動かない＝
 * フィードバックループ防止）。`hueGrid` 省略時は H ブロックを全 0 とする。
 *
 * @param linearSamples 有効画素のリニア RGB パック配列
 * @param hueGrid H ブロック用のガンマ空間格子（省略可・長さ 3n³・R 最速）
 * @param n hueGrid の格子解像度（hueGrid 指定時は必須）
 * @param bins ビン数（既定 HIST_BINS）
 * @returns Float32Array(HIST_BLOCKS×bins)。[R|G|B|Y'|H] 連結・各ブロック最大値正規化
 */
export function computeHistogram(
  linearSamples: Float32Array,
  hueGrid?: Float32Array | Float64Array,
  n?: number,
  bins: number = HIST_BINS,
): Float32Array {
  const hist = new Float64Array(HIST_BLOCKS * bins);
  const count = Math.floor(linearSamples.length / 3);
  const applyHue = hueGrid != null && n != null && n > 0;
  const tri: Vec3 = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    // リニア → ガンマ化してから集計。
    const r = linearToSrgb(linearSamples[i * 3]);
    const g = linearToSrgb(linearSamples[i * 3 + 1]);
    const b = linearToSrgb(linearSamples[i * 3 + 2]);
    accumHist(hist, bins, r, g, b);
    // H ブロック：base 格子（色相カーブ適用前）をサンプルへ適用した色相。
    if (applyHue) {
      trilinearSample(hueGrid, n, r, g, b, tri);
      accumHueBlock(hist, bins, tri[0], tri[1], tri[2]);
    }
  }
  return normalizeHist(hist, bins);
}

/**
 * 結果ヒストグラム：最終 LUT（クランプ済み・ガンマ空間格子）にサンプルを通してから集計。
 *
 * 入力サンプルはリニア → ガンマ座標化 → trilinear 適用。出力はガンマ空間なので
 * そのままビニングする（R/G/B/Y' ＋ H）。H ブロックは最終 LUT 適用後サンプルの色相
 * （彩度重み付き）で、色相カーブ編集に**ライブ追従**する（Source 側 H とは非対称）。
 *
 * @param lut 最終 LUT（Float32Array・長さ 3n³・R 最速・ガンマ RGB）
 * @param n 格子解像度
 * @param linearSamples 有効画素のリニア RGB パック配列
 * @param bins ビン数（既定 HIST_BINS）
 * @returns Float32Array(HIST_BLOCKS×bins)。[R|G|B|Y'|H] 連結・各ブロック最大値正規化
 */
export function computeResultHistogram(
  lut: Float32Array,
  n: number,
  linearSamples: Float32Array,
  bins: number = HIST_BINS,
): Float32Array {
  const hist = new Float64Array(HIST_BLOCKS * bins);
  const count = Math.floor(linearSamples.length / 3);
  const tri: Vec3 = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const xr = linearToSrgb(linearSamples[i * 3]);
    const xg = linearToSrgb(linearSamples[i * 3 + 1]);
    const xb = linearToSrgb(linearSamples[i * 3 + 2]);
    trilinearSample(lut, n, xr, xg, xb, tri);
    accumHist(hist, bins, tri[0], tri[1], tri[2]);
    accumHueBlock(hist, bins, tri[0], tri[1], tri[2]);
  }
  return normalizeHist(hist, bins);
}
