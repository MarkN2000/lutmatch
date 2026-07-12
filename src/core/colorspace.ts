/**
 * 色空間変換（純粋関数）。
 *
 * - sRGB ⇄ リニア：符号付き拡張 `sign(x)·γ(|x|)`（§5.4）。中間段で生じる負値・
 *   範囲外値でも符号を保ったまま変換する。
 * - リニア RGB ⇄ Lab（D65）。
 * - Rec.709 リニア輝度。
 *
 * すべてスカラー／三つ組（`out` へ書き込み）の両 API を提供し、ホットループでの
 * オブジェクト割り当てを避ける。
 */

import type { Vec3 } from './types.ts';

// ---- sRGB ⇄ リニア（符号付き拡張） ----

/** sRGB 値（ガンマ）→ リニア値。負値は符号を保つ（§5.4）。 */
export function srgbToLinear(c: number): number {
  const a = Math.abs(c);
  const l = a <= 0.04045 ? a / 12.92 : Math.pow((a + 0.055) / 1.055, 2.4);
  return c < 0 ? -l : l;
}

/** リニア値 → sRGB 値（ガンマ）。負値は符号を保つ（§5.4）。 */
export function linearToSrgb(c: number): number {
  const a = Math.abs(c);
  const s = a <= 0.0031308 ? a * 12.92 : 1.055 * Math.pow(a, 1 / 2.4) - 0.055;
  return c < 0 ? -s : s;
}

/** RGB 三つ組を sRGB→リニアに変換し `out` へ書き込む。 */
export function srgbToLinearRgb(r: number, g: number, b: number, out: Vec3): Vec3 {
  out[0] = srgbToLinear(r);
  out[1] = srgbToLinear(g);
  out[2] = srgbToLinear(b);
  return out;
}

/** RGB 三つ組をリニア→sRGB に変換し `out` へ書き込む。 */
export function linearToSrgbRgb(r: number, g: number, b: number, out: Vec3): Vec3 {
  out[0] = linearToSrgb(r);
  out[1] = linearToSrgb(g);
  out[2] = linearToSrgb(b);
  return out;
}

// ---- リニア輝度 ----

/** Rec.709 係数によるリニア輝度 Y = 0.2126R + 0.7152G + 0.0722B。 */
export function rec709Luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ---- リニア RGB ⇄ Lab（D65） ----

// sRGB 原色・D65 白色点のリニア RGB→XYZ 行列。
const RGB_TO_XYZ = [
  0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339,
  0.119192, 0.9503041,
];
// その逆行列 XYZ→リニア RGB。
const XYZ_TO_RGB = [
  3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434,
  -0.2040259, 1.0572252,
];

// D65 白色点。
const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;

const DELTA = 6 / 29;
const DELTA3 = DELTA * DELTA * DELTA;

// XYZ→Lab の非線形関数 f。小さい t（0 以下の負値を含む）は CIE 標準の線形分岐
// t/(3Δ²)+4/29 でカバーされ、cbrt 分岐と滑らかに接続する（符号付き立方根ではない）。
function labF(t: number): number {
  if (t > DELTA3) return Math.cbrt(t);
  return t / (3 * DELTA * DELTA) + 4 / 29;
}

// f の逆関数。
function labFinv(ft: number): number {
  if (ft > DELTA) return ft * ft * ft;
  return 3 * DELTA * DELTA * (ft - 4 / 29);
}

/**
 * リニア RGB → Lab（D65）。`out` に [L, a, b] を書き込む。
 * 範囲外・負値でも符号付き変換により連続に扱える（§5.4）。
 */
export function linearRgbToLab(r: number, g: number, b: number, out: Vec3): Vec3 {
  const x = (RGB_TO_XYZ[0] * r + RGB_TO_XYZ[1] * g + RGB_TO_XYZ[2] * b) / XN;
  const y = (RGB_TO_XYZ[3] * r + RGB_TO_XYZ[4] * g + RGB_TO_XYZ[5] * b) / YN;
  const z = (RGB_TO_XYZ[6] * r + RGB_TO_XYZ[7] * g + RGB_TO_XYZ[8] * b) / ZN;
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  out[0] = 116 * fy - 16;
  out[1] = 500 * (fx - fy);
  out[2] = 200 * (fy - fz);
  return out;
}

// ---- Lab ⇄ LCh（極座標・色相は turns [0,1) 正規化） ----

/**
 * Lab → LCh。`out` に [L, C, h] を書き込む。
 * - C = √(a²+b²)（クロマ）
 * - h = atan2(b, a)/2π を [0,1) に正規化した色相（turns）。グレー軸（a=b=0）は h=0。
 * L* はそのまま透過する（色相カーブは L 不変・§色相）。
 */
export function labToLch(l: number, a: number, b: number, out: Vec3): Vec3 {
  out[0] = l;
  out[1] = Math.hypot(a, b);
  let h = Math.atan2(b, a) / (2 * Math.PI); // (−0.5, 0.5]
  if (h < 0) h += 1; // → [0,1)
  out[2] = h;
  return out;
}

/**
 * LCh → Lab。`out` に [L, a, b] を書き込む（h は turns [0,1) 正規化・範囲外も周期で受容）。
 * a = C·cos(2πh)、b = C·sin(2πh)。C<0 でも符号付きで連続に扱える。
 */
export function lchToLab(l: number, c: number, h: number, out: Vec3): Vec3 {
  const ang = h * 2 * Math.PI;
  out[0] = l;
  out[1] = c * Math.cos(ang);
  out[2] = c * Math.sin(ang);
  return out;
}

/** Lab（D65）→ リニア RGB。`out` に [R, G, B] を書き込む。 */
export function labToLinearRgb(l: number, a: number, bb: number, out: Vec3): Vec3 {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - bb / 200;
  const x = labFinv(fx) * XN;
  const y = labFinv(fy) * YN;
  const z = labFinv(fz) * ZN;
  out[0] = XYZ_TO_RGB[0] * x + XYZ_TO_RGB[1] * y + XYZ_TO_RGB[2] * z;
  out[1] = XYZ_TO_RGB[3] * x + XYZ_TO_RGB[4] * y + XYZ_TO_RGB[5] * z;
  out[2] = XYZ_TO_RGB[6] * x + XYZ_TO_RGB[7] * y + XYZ_TO_RGB[8] * z;
  return out;
}
