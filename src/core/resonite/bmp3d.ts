/**
 * Resonite Bmp3D（3D LUT アセット）のエンコード。
 *
 * レイアウト（実機 Resonite でインポート検証済み）：
 *   0x05 "Bmp3D" + int32LE version=2 + int32LE w,h,d(=N) + 0x08 "RGBAHalf"
 *   + byte 0x00 + 0x04 "sRGB" + LZMA props 5 バイト + int64LE 無圧縮サイズ(N³×8)
 *   + int64LE 圧縮ストリーム長 + raw LZMA ストリーム。
 *
 * ボクセルは offset = ((z*N + y)*N + x) * 8、RGBA 各 float16 LE。軸は x=R / y=G /
 * z=B で、格子座標 i/(N-1) が入力値に対応する。alpha は常に 1.0（0x3C00）。
 */

import { lzmaCompress } from './lzma.ts';

/** float16 の 1.0。 */
const HALF_ONE = 0x3c00;

/**
 * float32 → float16（IEEE 754 半精度）。丸めは最近接偶数。
 * 値域は 0..1 を想定するが、subnormal / overflow / 符号も含む一般実装。
 * @param x 変換する数値
 * @returns 16bit の半精度ビット列（0..0xFFFF）
 */
export function floatToHalf(x: number): number {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = x;
  const bits = u32[0];

  const sign = (bits >>> 16) & 0x8000;
  const rawExp = (bits >>> 23) & 0xff;
  const mant = bits & 0x7fffff;

  // Inf / NaN。
  if (rawExp === 0xff) {
    return sign | 0x7c00 | (mant ? 0x200 : 0);
  }

  let exp = rawExp - 127 + 15; // half のバイアス付き指数

  if (exp >= 31) {
    // 半精度で表せない大きさ → Inf。
    return sign | 0x7c00;
  }

  if (exp <= 0) {
    // subnormal あるいは 0。
    if (exp < -10) return sign; // 小さすぎる → 符号付きゼロ
    const m = mant | 0x800000; // 暗黙の 1 を復元（24bit）
    const shift = 14 - exp; // 14..24
    let half = m >>> shift;
    const roundBit = (m >>> (shift - 1)) & 1;
    const sticky = (m & ((1 << (shift - 1)) - 1)) !== 0 ? 1 : 0;
    if (roundBit && (sticky || (half & 1))) half += 1; // 最近接偶数
    return sign | half;
  }

  // 正規化数。最近接偶数丸め（桁上がりは指数へ正しく伝播する）。
  let half = (exp << 10) | (mant >>> 13);
  const roundBit = (mant >>> 12) & 1;
  const sticky = (mant & 0xfff) !== 0 ? 1 : 0;
  if (roundBit && (sticky || (half & 1))) half += 1;
  return sign | half;
}

/**
 * Bmp3D ヘッダー（37 バイト・格子解像度 N まで）を組み立てる。
 * @param n 格子解像度 N
 */
function buildHeader(n: number): Uint8Array {
  const head = new Uint8Array(37);
  const dv = new DataView(head.buffer);
  let o = 0;
  const putStr = (tag: number, s: string): void => {
    head[o++] = tag; // 長さプレフィックス（1 バイト）
    for (let i = 0; i < s.length; i++) head[o++] = s.charCodeAt(i);
  };
  putStr(0x05, 'Bmp3D');
  dv.setInt32(o, 2, true); // version
  o += 4;
  dv.setInt32(o, n, true); // w
  o += 4;
  dv.setInt32(o, n, true); // h
  o += 4;
  dv.setInt32(o, n, true); // d
  o += 4;
  putStr(0x08, 'RGBAHalf');
  head[o++] = 0x00;
  putStr(0x04, 'sRGB');
  return head;
}

/**
 * RGB 格子から Resonite Bmp3D アセットを生成する。
 * @param grid 長さ N³×3 の格子（RGB・0..1・x が最速で回り x=R）
 * @param n 格子解像度 N
 * @returns Bmp3D アセットのバイト列（LZMA 圧縮済み）
 */
export function encodeBmp3d(grid: Float32Array, n: number): Uint8Array {
  const voxelCount = n * n * n;
  const expected = voxelCount * 3;
  if (grid.length !== expected) {
    throw new Error(`grid length ${grid.length} does not match n=${n} (expected ${expected})`);
  }

  // RGBAHalf ボクセル列を作る（格子添字 i がそのままボクセル添字＝x 最速）。
  const raw = new Uint8Array(voxelCount * 8);
  const rawView = new DataView(raw.buffer);
  for (let i = 0; i < voxelCount; i++) {
    const off = i * 8;
    rawView.setUint16(off, floatToHalf(grid[i * 3]), true); // R
    rawView.setUint16(off + 2, floatToHalf(grid[i * 3 + 1]), true); // G
    rawView.setUint16(off + 4, floatToHalf(grid[i * 3 + 2]), true); // B
    rawView.setUint16(off + 6, HALF_ONE, true); // A = 1.0
  }

  const { props, stream } = lzmaCompress(raw);
  const header = buildHeader(n);

  // header(37) + props(5) + 無圧縮サイズ(8) + ストリーム長(8) + stream。
  const out = new Uint8Array(header.length + props.length + 16 + stream.length);
  out.set(header, 0);
  out.set(props, header.length);
  const dv = new DataView(out.buffer);
  const sizeOff = header.length + props.length; // 42
  dv.setBigUint64(sizeOff, BigInt(raw.length), true);
  dv.setBigUint64(sizeOff + 8, BigInt(stream.length), true);
  out.set(stream, sizeOff + 16);
  return out;
}
