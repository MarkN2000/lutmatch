/**
 * LUT 化と後段処理（§5.5）、および全体オーケストレーション `generateLut`。
 *
 * 処理順序（§5.5）：
 *   1. N³ 格子点に f を適用
 *   2. 外挿域のマハラノビス減衰（格子点をリニア化し Source リニア統計で測定）
 *   3. 3D ガウシアン平滑化（スムージング連動）
 *   4. Identity ミックス（強度・自動マッチのみ）
 *   5. 手動調整（露出 → 色温度/ティント → コントラスト → 彩度）
 *   6. 0–1 クランプ（最終のみ）
 *
 * LUT データは長さ N³×3、**R が最速で回る**（index = (r + g·N + b·N²)·3）、値はガンマ RGB。
 */

import {
  labToLinearRgb,
  linearRgbToLab,
  linearToSrgb,
  rec709Luminance,
  srgbToLinear,
} from './colorspace.ts';
import { mahalanobisSq } from './linalg.ts';
import { buildMatchTransform } from './pipeline.ts';
import { extractValidSamples } from './stats.ts';
import type {
  ChannelCount,
  GenerateLutOptions,
  GenerateLutResult,
  ManualAdjustments,
  Mat3,
  Vec3,
} from './types.ts';

/** マハラノビス減衰の開始距離 d0（既定・§5.5）。 */
export const MAHALANOBIS_D0 = 3.0;
/** マハラノビス減衰が完全に Identity になる距離 d1（d0 からの線形減衰幅）。 */
export const MAHALANOBIS_D1 = 6.0;
/** スムージング 100 時の σ（ドメイン [0,1] に対する割合。σ_cells = σ_norm·(N−1)）。 */
export const SMOOTH_SIGMA_MAX = 0.05;
/** 色温度／ティントの Lab オフセット係数（param/100 × これ）。 */
export const TEMPTINT_SCALE = 30;

// ---- 格子インデックス ----

/** 格子座標 (ir,ig,ib) → データ配列先頭インデックス（R 最速）。 */
function gridIndex(ir: number, ig: number, ib: number, n: number): number {
  return (ir + ig * n + ib * n * n) * 3;
}

// ---- 手動調整（ガンマ RGB 三つ組をその場で書き換える） ----

/** 露出：リニアへ変換し ×2^EV。 */
function applyExposure(rgb: Vec3, ev: number): void {
  if (ev === 0) return;
  const m = 2 ** ev;
  rgb[0] = linearToSrgb(srgbToLinear(rgb[0]) * m);
  rgb[1] = linearToSrgb(srgbToLinear(rgb[1]) * m);
  rgb[2] = linearToSrgb(srgbToLinear(rgb[2]) * m);
}

const labTmp: Vec3 = [0, 0, 0];
const linTmp: Vec3 = [0, 0, 0];

/** 色温度／ティント：Lab（D65）で b*（色温度）／a*（ティント）にオフセットを加える。 */
function applyTempTint(rgb: Vec3, temperature: number, tint: number): void {
  if (temperature === 0 && tint === 0) return;
  const rl = srgbToLinear(rgb[0]);
  const gl = srgbToLinear(rgb[1]);
  const bl = srgbToLinear(rgb[2]);
  linearRgbToLab(rl, gl, bl, labTmp);
  labTmp[1] += (tint / 100) * TEMPTINT_SCALE;
  labTmp[2] += (temperature / 100) * TEMPTINT_SCALE;
  labToLinearRgb(labTmp[0], labTmp[1], labTmp[2], linTmp);
  rgb[0] = linearToSrgb(linTmp[0]);
  rgb[1] = linearToSrgb(linTmp[1]);
  rgb[2] = linearToSrgb(linTmp[2]);
}

/** スムーズステップ（[0,1] 上の S 字カーブ）。 */
function smoothstep01(x: number): number {
  return x * x * (3 - 2 * x);
}

/** スムーズステップの逆関数（[0,1] 上）。 */
function invSmoothstep01(x: number): number {
  return 0.5 - Math.sin(Math.asin(1 - 2 * x) / 3);
}

/** ガンマ空間・ピボット 0.5 の S カーブによるコントラスト。amount∈[-1,1]。 */
function contrastCurve(x: number, amount: number): number {
  const xc = x < 0 ? 0 : x > 1 ? 1 : x;
  let y: number;
  if (amount >= 0) y = xc + amount * (smoothstep01(xc) - xc);
  else y = xc + -amount * (invSmoothstep01(xc) - xc);
  // 範囲外分のオフセットを保持（最終クランプ前・§5.5）。
  return y + (x - xc);
}

/** コントラスト：−50〜+50 を [-1,1] に正規化して S カーブ適用。 */
function applyContrast(rgb: Vec3, contrast: number): void {
  if (contrast === 0) return;
  const a = contrast / 50;
  rgb[0] = contrastCurve(rgb[0], a);
  rgb[1] = contrastCurve(rgb[1], a);
  rgb[2] = contrastCurve(rgb[2], a);
}

/** 彩度：Rec.709 リニア輝度とのブレンドで増減（−100〜+100）。 */
function applySaturation(rgb: Vec3, saturation: number): void {
  if (saturation === 0) return;
  const f = 1 + saturation / 100; // 0（グレースケール）〜2
  const rl = srgbToLinear(rgb[0]);
  const gl = srgbToLinear(rgb[1]);
  const bl = srgbToLinear(rgb[2]);
  const y = rec709Luminance(rl, gl, bl);
  rgb[0] = linearToSrgb(y + (rl - y) * f);
  rgb[1] = linearToSrgb(y + (gl - y) * f);
  rgb[2] = linearToSrgb(y + (bl - y) * f);
}

/** 手動調整を順に適用（露出 → 色温度/ティント → コントラスト → 彩度・§5.5）。 */
function applyManual(rgb: Vec3, m: ManualAdjustments): void {
  applyExposure(rgb, m.exposure);
  applyTempTint(rgb, m.temperature, m.tint);
  applyContrast(rgb, m.contrast);
  applySaturation(rgb, m.saturation);
}

// ---- 3D ガウシアン平滑化（分離型・複製境界） ----

/** 1D ガウシアンカーネルを生成（σ はセル単位）。 */
function gaussianKernel(sigma: number): Float64Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(radius * 2 + 1);
  let sum = 0;
  const inv2s2 = 1 / (2 * sigma * sigma);
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) * inv2s2);
    k[i + radius] = w;
    sum += w;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/**
 * 3 チャンネル格子データに分離型 3D ガウシアン平滑化を適用する（複製境界）。
 * σ_cells = (smoothing/100)·SMOOTH_SIGMA_MAX·(N−1)。
 */
function smoothGrid(data: Float32Array, n: number, smoothing: number): void {
  if (smoothing <= 0) return;
  const sigma = (smoothing / 100) * SMOOTH_SIGMA_MAX * (n - 1);
  if (sigma < 1e-3) return;
  const kernel = gaussianKernel(sigma);
  const radius = (kernel.length - 1) / 2;

  const clampIdx = (v: number): number => (v < 0 ? 0 : v >= n ? n - 1 : v);

  // 各軸ごとに畳み込む（axis 0=R, 1=G, 2=B）。
  for (let axis = 0; axis < 3; axis++) {
    const src = data.slice();
    for (let ib = 0; ib < n; ib++) {
      for (let ig = 0; ig < n; ig++) {
        for (let ir = 0; ir < n; ir++) {
          let acc0 = 0;
          let acc1 = 0;
          let acc2 = 0;
          for (let t = -radius; t <= radius; t++) {
            let sr = ir;
            let sg = ig;
            let sb = ib;
            if (axis === 0) sr = clampIdx(ir + t);
            else if (axis === 1) sg = clampIdx(ig + t);
            else sb = clampIdx(ib + t);
            const w = kernel[t + radius];
            const si = gridIndex(sr, sg, sb, n);
            acc0 += src[si] * w;
            acc1 += src[si + 1] * w;
            acc2 += src[si + 2] * w;
          }
          const di = gridIndex(ir, ig, ib, n);
          data[di] = acc0;
          data[di + 1] = acc1;
          data[di + 2] = acc2;
        }
      }
    }
  }
}

// ---- 外挿域のマハラノビス減衰 ----

/** マハラノビス距離に応じた Identity 側への減衰重み（0=マッチ全効、1=完全 Identity）。 */
function attenuationWeight(dSq: number, d0: number): number {
  const d = Math.sqrt(Math.max(0, dSq));
  if (d <= d0) return 0;
  if (d >= MAHALANOBIS_D1) return 1;
  return (d - d0) / (MAHALANOBIS_D1 - d0);
}

// ---- trilinear 補間 ----

/**
 * LUT を trilinear 補間でサンプルする（Canvas 2D フォールバック／テスト用）。
 * @param lut LUT データ（長さ n³×3・R 最速）
 * @param n 格子解像度
 * @param r,g,b 入力（[0,1] 前提・範囲外はクランプ）
 * @param out 出力（長さ 3）
 */
export function trilinearSample(
  lut: Float32Array,
  n: number,
  r: number,
  g: number,
  b: number,
  out: Vec3,
): Vec3 {
  const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
  const fr = clamp01(r) * (n - 1);
  const fg = clamp01(g) * (n - 1);
  const fb = clamp01(b) * (n - 1);
  const r0 = Math.floor(fr);
  const g0 = Math.floor(fg);
  const b0 = Math.floor(fb);
  const r1 = Math.min(r0 + 1, n - 1);
  const g1 = Math.min(g0 + 1, n - 1);
  const b1 = Math.min(b0 + 1, n - 1);
  const dr = fr - r0;
  const dg = fg - g0;
  const db = fb - b0;

  for (let c = 0; c < 3; c++) {
    const c000 = lut[gridIndex(r0, g0, b0, n) + c];
    const c100 = lut[gridIndex(r1, g0, b0, n) + c];
    const c010 = lut[gridIndex(r0, g1, b0, n) + c];
    const c110 = lut[gridIndex(r1, g1, b0, n) + c];
    const c001 = lut[gridIndex(r0, g0, b1, n) + c];
    const c101 = lut[gridIndex(r1, g0, b1, n) + c];
    const c011 = lut[gridIndex(r0, g1, b1, n) + c];
    const c111 = lut[gridIndex(r1, g1, b1, n) + c];
    const c00 = c000 + (c100 - c000) * dr;
    const c10 = c010 + (c110 - c010) * dr;
    const c01 = c001 + (c101 - c001) * dr;
    const c11 = c011 + (c111 - c011) * dr;
    const c0 = c00 + (c10 - c00) * dg;
    const c1 = c01 + (c11 - c01) * dg;
    out[c] = c0 + (c1 - c0) * db;
  }
  return out;
}

// ---- オーケストレーション ----

/**
 * Source / Reference のリニア画素から最終 LUT を生成する（§5.4〜§5.5 全工程）。
 *
 * @param srcPixels Source のリニア RGB(A) 画素配列
 * @param refPixels Reference のリニア RGB(A) 画素配列
 * @param channels 3=RGB / 4=RGBA
 * @param options モード・サイズ・強度・スムージング・手動調整・抽出条件
 * @returns LUT（Float32Array・R 最速・ガンマ RGB）とフォールバック警告フラグ
 */
export function generateLut(
  srcPixels: Float32Array,
  refPixels: Float32Array,
  channels: ChannelCount,
  options: GenerateLutOptions,
): GenerateLutResult {
  const n = options.size;
  const d0 = options.d0 ?? MAHALANOBIS_D0;

  const srcSamples = extractValidSamples(srcPixels, channels, options.sample);
  const refSamples = extractValidSamples(refPixels, channels, options.sample);
  const match = buildMatchTransform(options.mode, srcSamples, refSamples);

  const auto = new Float32Array(n * n * n * 3);
  const srcMean: Vec3 = match.srcMean;
  const srcCovInv: Mat3 = match.srcCovInv;

  const matched: Vec3 = [0, 0, 0];
  const linGrid: Vec3 = [0, 0, 0];
  const inv = n > 1 ? 1 / (n - 1) : 0;

  // 1+2：格子適用 → マハラノビス減衰。結果はガンマ RGB で auto に格納。
  for (let ib = 0; ib < n; ib++) {
    const gb = ib * inv;
    for (let ig = 0; ig < n; ig++) {
      const gg = ig * inv;
      for (let ir = 0; ir < n; ir++) {
        const gr = ir * inv;
        // 格子点をリニア化。
        linGrid[0] = srgbToLinear(gr);
        linGrid[1] = srgbToLinear(gg);
        linGrid[2] = srgbToLinear(gb);
        // f を適用（リニア→リニア）→ ガンマへ。
        match.apply(linGrid[0], linGrid[1], linGrid[2], matched);
        let or = linearToSrgb(matched[0]);
        let og = linearToSrgb(matched[1]);
        let ob = linearToSrgb(matched[2]);
        // マハラノビス減衰：リニア格子点を Source リニア統計で測る。
        const w = attenuationWeight(mahalanobisSq(srcCovInv, linGrid, srcMean), d0);
        if (w > 0) {
          or += (gr - or) * w;
          og += (gg - og) * w;
          ob += (gb - ob) * w;
        }
        const di = gridIndex(ir, ig, ib, n);
        auto[di] = or;
        auto[di + 1] = og;
        auto[di + 2] = ob;
      }
    }
  }

  // 3：平滑化。
  smoothGrid(auto, n, options.smoothing);

  // 4〜6：Identity ミックス（自動のみ）→ 手動調整 → クランプ。
  const strength = options.strength / 100;
  const lut = new Float32Array(n * n * n * 3);
  const rgb: Vec3 = [0, 0, 0];
  for (let ib = 0; ib < n; ib++) {
    const gb = ib * inv;
    for (let ig = 0; ig < n; ig++) {
      const gg = ig * inv;
      for (let ir = 0; ir < n; ir++) {
        const gr = ir * inv;
        const di = gridIndex(ir, ig, ib, n);
        // 強度ミックス：Identity（格子座標）と自動マッチ結果をブレンド。
        rgb[0] = gr + (auto[di] - gr) * strength;
        rgb[1] = gg + (auto[di + 1] - gg) * strength;
        rgb[2] = gb + (auto[di + 2] - gb) * strength;
        // 手動調整（フル効果）。
        applyManual(rgb, options.manual);
        // 最終クランプ。
        lut[di] = rgb[0] < 0 ? 0 : rgb[0] > 1 ? 1 : rgb[0];
        lut[di + 1] = rgb[1] < 0 ? 0 : rgb[1] > 1 ? 1 : rgb[1];
        lut[di + 2] = rgb[2] < 0 ? 0 : rgb[2] > 1 ? 1 : rgb[2];
      }
    }
  }

  return { lut, size: n, fallback: match.fallback };
}
