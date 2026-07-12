/**
 * 色相カーブ（Hue vs Hue / Hue vs Sat）の意味論を担う純粋モジュール（§色相カーブ）。
 *
 * 色空間は Lab（D65）の極座標 LCh。横軸は色相 h∈[0,1)（turns、h = atan2(b*,a*)/2π を [0,1)
 * 正規化）、縦軸は残差 dy∈[-1,+1]。
 * - Hue vs Hue：色相回転 Δh = dy × `HUE_CURVE_MAX_ROTATION_DEG`。
 * - Hue vs Sat：彩度ゲイン C' = C × (1 + dy·w)（0 で下限クランプ）。
 * - L* は両カーブとも不変。
 *
 * **低彩度減衰**：w = smoothstep(0, `HUE_CURVE_MIN_CHROMA`, C)（Lab クロマ単位）。Δh にも
 * 彩度ゲインの dy にも w を乗じるため、グレー軸（C=0）は色相カーブをどう編集しても完全不変。
 *
 * 回転量・彩度ゲインは色相 h の**周期スプライン**（curve.ts `sampleResidualToGridPeriodic`）を
 * 高解像度テーブル化して線形補間で引く。定数・重み関数はここに集約し、パイプライン適用
 * （lut.ts）と色相ヒストグラム集計（analysis.ts）が共有する（DRY）。
 */

import {
  labToLch,
  labToLinearRgb,
  lchToLab,
  linearRgbToLab,
  linearToSrgb,
  srgbToLinear,
} from './colorspace.ts';
import type { Vec3 } from './types.ts';

/** Hue vs Hue の最大色相回転量（度・dy=±1 かつ w=1 で ±これ）。 */
export const HUE_CURVE_MAX_ROTATION_DEG = 60;

/** 低彩度減衰のクロマしきい値 C0（Lab クロマ単位）。C≥これ で w=1、C=0 で w=0。 */
export const HUE_CURVE_MIN_CHROMA = 8.0;

/**
 * グレー軸のデッドゾーン（Lab クロマ単位）。C≤これ は w=0 として完全不変にする。
 *
 * 数値上の理由：sRGB→XYZ 行列の各行和は白色点と厳密一致しない（丸め ~1e-7）ため、完全な
 * グレー（R=G=B）でも Lab で微小クロマ（~1e-5）が生じる。デッドゾーンなしだと (a) 色相ヒスト
 * の最大値正規化がこの微小ノイズをスパイクへ増幅し、(b) LUT 適用でグレー格子点に往復誤差の
 * 微小変化が乗る。C_ε は知覚上・数値上意味を持つ最小クロマより遥かに小さく（C0 の 0.0125%）、
 * 可視域の smoothstep 挙動には影響しない。これにより「C=0（グレー軸）完全不変」を厳密に満たす。
 */
export const HUE_CURVE_CHROMA_EPS = 1e-3;

/** 色相残差テーブルの分解能（周期・線形補間で引く）。60° 回転でも十分密。 */
export const HUE_RESIDUAL_TABLE_N = 1024;

/**
 * 低彩度減衰の重み w = smoothstep(0, C0, C)（C≤C_ε は厳密に 0）。
 * C≤C_ε で 0、C≥C0 で 1、その間は S 字。グレー軸を完全不変にするためのゲート。
 */
export function chromaWeight(chroma: number): number {
  if (chroma <= HUE_CURVE_CHROMA_EPS) return 0;
  if (chroma >= HUE_CURVE_MIN_CHROMA) return 1;
  const t = chroma / HUE_CURVE_MIN_CHROMA;
  return t * t * (3 - 2 * t);
}

/**
 * 周期残差テーブル（x=i/n サンプル・x=1 は x=0 と同一点）を x で周期線形補間して引く。
 * x は自動で [0,1) にラップし、末尾 → 先頭の折り返しも補間する。
 */
function samplePeriodicTable(table: Float32Array, x: number): number {
  const n = table.length;
  const xx = x - Math.floor(x); // → [0,1)
  const fx = xx * n;
  const i0 = Math.floor(fx) % n;
  const i1 = (i0 + 1) % n;
  return table[i0] + (table[i1] - table[i0]) * (fx - Math.floor(fx));
}

// ホットループ用の再利用テンポラリ（Worker は単一スレッドなので共有して安全）。
const _lab: Vec3 = [0, 0, 0];
const _lch: Vec3 = [0, 0, 0];
const _lin: Vec3 = [0, 0, 0];

/**
 * ガンマ RGB 三つ組にその場で色相カーブを適用する（L* 不変・§色相カーブ）。
 *
 * base 値（ガンマ空間・クランプ前・範囲外あり得る）→ リニア → Lab → LCh で自身の色相 h_in を
 * 求め、**同じ h_in** で回転カーブ・彩度ゲインカーブを評価する（適用順序非依存）。
 * w=0（グレー軸）のときは何もしない＝厳密に不変（往復誤差も生じない）。
 *
 * @param rgb        破壊的に書き換えるガンマ RGB 三つ組
 * @param rotationTable Hue vs Hue の周期残差テーブル（dy∈[-1,1]）
 * @param gainTable     Hue vs Sat の周期残差テーブル（dy∈[-1,1]）
 */
export function applyHueCurveGamma(
  rgb: Vec3,
  rotationTable: Float32Array,
  gainTable: Float32Array,
): void {
  linearRgbToLab(srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2]), _lab);
  labToLch(_lab[0], _lab[1], _lab[2], _lch);
  const chroma = _lch[1];
  const w = chromaWeight(chroma);
  if (w === 0) return; // グレー軸は完全不変。

  const hIn = _lch[2];
  const dyRot = samplePeriodicTable(rotationTable, hIn);
  const dyGain = samplePeriodicTable(gainTable, hIn);

  // 色相回転（turns）。w で低彩度減衰。
  const dh = dyRot * (HUE_CURVE_MAX_ROTATION_DEG / 360) * w;
  const hNew = hIn + dh; // lchToLab が周期で受容するのでラップ不要。
  // 彩度ゲイン（0 下限クランプ）。
  const cNew = Math.max(0, chroma * (1 + dyGain * w));

  lchToLab(_lch[0], cNew, hNew, _lab); // L* は _lch[0] のまま。
  labToLinearRgb(_lab[0], _lab[1], _lab[2], _lin);
  rgb[0] = linearToSrgb(_lin[0]);
  rgb[1] = linearToSrgb(_lin[1]);
  rgb[2] = linearToSrgb(_lin[2]);
}
