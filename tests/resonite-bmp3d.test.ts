import { describe, expect, it } from 'vitest';
import { encodeBmp3d, floatToHalf } from '../src/core/resonite/bmp3d.ts';
import { lzmaDecodeAlone } from './resonite-helpers.ts';

/** バイト列を小文字 16 進文字列へ。 */
function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

describe('floatToHalf（float32 → float16 最近接偶数）', () => {
  it('既知値が正しい', () => {
    expect(floatToHalf(0)).toBe(0x0000);
    expect(floatToHalf(1)).toBe(0x3c00);
    expect(floatToHalf(0.5)).toBe(0x3800);
    expect(floatToHalf(0.25)).toBe(0x3400);
    expect(floatToHalf(2)).toBe(0x4000);
    expect(floatToHalf(-1)).toBe(0xbc00); // 符号ビット保持
  });

  it('最近接偶数で丸める', () => {
    // 1 + 2^-11 は half の刻み(2^-10)のちょうど中間 → 偶数側 0x3C00 に丸まる。
    expect(floatToHalf(1 + Math.pow(2, -11))).toBe(0x3c00);
    // 1 + 3*2^-11 は 0x3C01 と 0x3C02 の中間 → 偶数側 0x3C02。
    expect(floatToHalf(1 + 3 * Math.pow(2, -11))).toBe(0x3c02);
  });

  it('大きすぎる値は Inf', () => {
    expect(floatToHalf(70000)).toBe(0x7c00);
  });
});

describe('encodeBmp3d', () => {
  it('N=33 のヘッダー先頭 37 バイトが golden と一致', () => {
    const n = 33;
    const grid = new Float32Array(n * n * n * 3); // 全 0 で十分（ヘッダーのみ検証）
    const out = encodeBmp3d(grid, n);
    expect(toHex(out.subarray(0, 37))).toBe(
      '05426d70334402000000210000002100000021000000085247424148616c66000473524742',
    );
  });

  it('grid 長が N³×3 でなければ例外', () => {
    expect(() => encodeBmp3d(new Float32Array(10), 5)).toThrow();
  });

  it('組み立てた Bmp3D を再パースして元ボクセルと一致する', () => {
    const n = 9;
    const denom = n - 1;
    const grid = new Float32Array(n * n * n * 3);
    // x=R / y=G / z=B の勾配（x が最速）。
    let idx = 0;
    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          grid[idx++] = x / denom;
          grid[idx++] = (y / denom) * 0.85;
          grid[idx++] = (z / denom) * 0.6;
        }
      }
    }

    const out = encodeBmp3d(grid, n);

    // ヘッダーを再パース（本エンコーダーのヘッダーは固定 37 バイト）。
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const props = out.subarray(37, 42);
    const uSize = Number(dv.getBigUint64(42, true));
    const sLen = Number(dv.getBigUint64(50, true));
    const stream = out.subarray(58);
    expect(uSize).toBe(n * n * n * 8);
    expect(stream.length).toBe(sLen);

    // LZMA 復元して RGBAHalf ボクセルを取り出す。
    const raw = lzmaDecodeAlone(props, uSize, stream);
    expect(raw.length).toBe(uSize);
    const rawView = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

    for (let i = 0; i < n * n * n; i++) {
      const off = i * 8;
      expect(rawView.getUint16(off, true)).toBe(floatToHalf(grid[i * 3]));
      expect(rawView.getUint16(off + 2, true)).toBe(floatToHalf(grid[i * 3 + 1]));
      expect(rawView.getUint16(off + 4, true)).toBe(floatToHalf(grid[i * 3 + 2]));
      expect(rawView.getUint16(off + 6, true)).toBe(0x3c00); // A = 1.0
    }
  });
});
